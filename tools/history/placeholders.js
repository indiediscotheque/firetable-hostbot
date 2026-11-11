// Placeholder tags: not songs. Before the bot could tell a broken upload, the
// room retagged uploads it wanted skipped as "Unavailable - Unavailable" or
// "Advert - Advert;". Each was a different song, so their plays piled up under
// two "songs" that topped every list.
//
// The history doesn't count a placeholder as a song. For each upload that
// carries one, it looks for the upload's real name in everything else the
// room logged for it, and either names it (its plays move to that song) or
// leaves it out (its plays go). placeholder_uploads.csv lists every upload,
// what was decided and why.
//
// Where a name comes from, strongest first:
//   placeholder-fixes.csv   a person's answer for one upload (always wins)
//   room logs               the name it had before the retag (tagLog), DJs'
//                           playlists, Recent, the play log, ADAM
//   YouTube Music / SoundCloud   the song data of a Topic channel upload, or
//                           SoundCloud's own artist and title
//   Last.fm                 at least 2 scrobbles sent the moment it played
// A plain YouTube or SoundCloud video title, or one scrobble, is only a
// suggestion (it's often a promo reel or the next song): the upload is left
// out unless placeholder-fixes.csv confirms it.
//
// placeholder-tags.csv lists the placeholders, placeholder-fixes.csv the
// answers (both in tools/history/, or history-data/, which wins).
"use strict";
var fs = require("fs");
var path = require("path");
var tags = require("../../lib/tags");

var SCROBBLE_GAP = 90 * 1000; // a scrobble this close to a play is that play
var MIN_SCROBBLES = 2;

function files(dir, name) {
  var here = path.join(__dirname, name);
  var there = dir ? path.join(dir, name) : null;
  return there && path.resolve(here) !== path.resolve(there) ? [here, there] : [here];
}

/** CSV rows (quotes and commas inside quotes work), skipping # comments and the header. */
function readRows(file) {
  if (!fs.existsSync(file)) return [];
  var out = [];
  fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).forEach(function(line, i) {
    if (!line.trim() || /^\s*#/.test(line)) return;
    var cells = [];
    var cell = "";
    var quoted = false;
    for (var k = 0; k < line.length; k++) {
      var ch = line[k];
      if (quoted) {
        if (ch === '"' && line[k + 1] === '"') { cell += '"'; k++; } else if (ch === '"') quoted = false; else cell += ch;
      } else if (ch === '"' && !cell) quoted = true;
      else if (ch === ",") { cells.push(cell.trim()); cell = ""; } else cell += ch;
    }
    cells.push(cell.trim());
    if (i === 0 && /^(artist|upload)$/i.test(cells[0])) return;
    out.push(cells);
  });
  return out;
}

/** "1abc" from an upload id, a YouTube link or a SoundCloud API link. */
function uploadOf(s) {
  s = String(s || "").trim();
  var m;
  if ((m = /(?:youtu\.be\/|[?&]v=)([\w-]{6,})/.exec(s))) return "1" + m[1];
  if ((m = /soundcloud\.com\/tracks\/(\d+)/.exec(s))) return "2" + m[1];
  if (/^[12][\w-]+$/.test(s)) return s;
  return null;
}

function keyOf(artist, title) { return tags.squash(artist || "") + "|" + tags.squash(title || ""); }

/**
 * The placeholders and the answers.
 * @param {string} [dir] history-data
 * @returns {{is: Function, list: Array<[string, string]>, fixes: Map<string, {artist?: string, title?: string, remove?: boolean}>}}
 */
function load(dir) {
  var keys = new Set();
  var list = [];
  files(dir, "placeholder-tags.csv").forEach(function(f) {
    readRows(f).forEach(function(c) {
      if (!c[0] && !c[1]) return;
      var k = keyOf(c[0], c[1]);
      if (!keys.has(k)) { keys.add(k); list.push([c[0], c[1] || ""]); }
    });
  });
  var fixes = new Map();
  files(dir, "placeholder-fixes.csv").forEach(function(f) {
    readRows(f).forEach(function(c) {
      var up = uploadOf(c[0]);
      if (!up) return;
      if (/^remove$/i.test(c[1] || "") || (!c[1] && !c[2])) fixes.set(up, { remove: true });
      else if (c[1] && c[2]) fixes.set(up, { artist: c[1], title: c[2] });
    });
  });
  return {
    is: function(artist, title) { return (artist || title) ? keys.has(keyOf(artist, title)) : false; },
    list: list,
    fixes: fixes
  };
}

function kindOf(source) {
  if (source === "yt:topic" || source === "sc:meta") return "platform";
  if (source === "yt" || source === "sc") return "title";
  if (source.slice(0, 7) === "lastfm:") return "lastfm";
  return "room";
}
var NAMES = { "fb:tagLog": "the name before the retag", "fb:playlists": "DJs' playlists", "fb:queues": "DJs' queues", "fb:songHistory": "Recent",
  "fb:playLog": "the play log", "fb:newMusic": "Fresh", "fb:globalTracks": "the room's tags", adam: "ADAM", "yt:topic": "YouTube Music", "sc:meta": "SoundCloud" };
function describe(sources) {
  var out = [];
  sources.forEach(function(n, s) {
    var name = NAMES[s] || (s.slice(0, 7) === "lastfm:" ? "Last.fm at play time" : s === "yt" ? "YouTube's title" : s === "sc" ? "SoundCloud's title" : s);
    out.push(name + (n > 1 ? " ×" + n : ""));
  });
  return out.join(", ");
}

/**
 * What to do with each upload that carries a placeholder.
 * @param {DatabaseSync} db - the history (obs)
 * @param {ReturnType<typeof load>} ph
 * @returns {Map<string, {tag, action: "renamed"|"removed", artist, title, evidence, suggestion, logs, plays, first, last, djs: Set}>}
 */
function plan(db, ph) {
  var out = new Map();
  if (!ph.list.length) return out;
  var times = []; // [at, up] of each placeholder play, for the scrobbles
  for (var r of db.prepare("SELECT artist, title, type, cid, role, at, naive_tz, dj FROM obs WHERE cid IS NOT NULL AND cid != ''").iterate()) {
    if (!ph.is(r.artist, r.title)) continue;
    var up = r.type + "" + r.cid;
    var p = out.get(up);
    if (!p) out.set(up, p = { tag: r.artist + " - " + r.title, action: "removed", artist: null, title: null, evidence: "", suggestion: "", logs: 0, plays: 0, first: null, last: null, djs: new Set(), votes: new Map() });
    p.logs++;
    if (r.role === "play") {
      p.plays++;
      if (r.at) {
        if (p.first == null || r.at < p.first) p.first = r.at;
        if (p.last == null || r.at > p.last) p.last = r.at;
        if (!r.naive_tz) times.push([r.at, up]);
      }
      if (r.dj) p.djs.add(r.dj);
    }
  }
  if (!out.size) return out;

  var vote = function(up, artist, title, source, w) {
    if (ph.is(artist, title) || (!artist && !title)) return;
    var p = out.get(up);
    var k = tags.clean(artist) + "\u0001" + tags.clean(title);
    var v = p.votes.get(k);
    // a vague one (a video title with no " - ") can only ever be a suggestion
    if (!v) p.votes.set(k, v = { artist: tags.clean(artist), title: tags.clean(title), weak: tags.parse(artist, title).weak, room: 0, platform: 0, lastfm: 0, title_only: 0, sources: new Map() });
    var kind = kindOf(source);
    v[kind === "title" ? "title_only" : kind] += kind === "lastfm" ? 1 : w || 1;
    v.sources.set(source, (v.sources.get(source) || 0) + 1);
  };
  for (var o of db.prepare("SELECT source, artist, title, type, cid, weight FROM obs WHERE cid IS NOT NULL AND cid != ''").iterate()) {
    var u = o.type + "" + o.cid;
    if (out.has(u)) vote(u, o.artist, o.title, o.source, o.weight);
  }
  // scrobbles sent the moment a placeholder upload played: its name then
  if (times.length) {
    times.sort(function(a, b) { return a[0] - b[0]; });
    var at = times.map(function(t) { return t[0]; });
    for (var s of db.prepare("SELECT source, artist, title, at FROM obs WHERE source LIKE 'lastfm:%' AND role = 'play' AND at IS NOT NULL").iterate()) {
      var lo = 0, hi = at.length - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (at[mid] < s.at) lo = mid + 1; else hi = mid; }
      [lo - 1, lo].forEach(function(i) {
        if (i >= 0 && i < at.length && Math.abs(at[i] - s.at) <= SCROBBLE_GAP) vote(times[i][1], s.artist, s.title, s.source, 1);
      });
    }
  }

  out.forEach(function(p, up) {
    var fix = ph.fixes.get(up);
    var best = null;     // the best name to give it
    var hint = null;     // the best anything, vague ones too, as a suggestion
    var score = function(v) { return v.room * 10 + v.platform * 5 + v.lastfm * 3 + v.title_only * 0.5 + tags.quality(v.artist, v.title || "") * 0.01; };
    p.votes.forEach(function(v) {
      if (!v.weak && (!best || score(v) > score(best))) best = v;
      if (!hint || score(v) > score(hint)) hint = v;
    });
    var label = function(v) { return v.title ? v.artist + " - " + v.title : v.artist; };
    if (fix) {
      p.action = fix.remove ? "removed" : "renamed";
      p.artist = fix.remove ? null : fix.artist;
      p.title = fix.remove ? null : fix.title;
      p.evidence = "placeholder-fixes.csv";
      p.suggestion = hint && fix.remove ? label(hint) : "";
    } else if (best && (best.room > 0 || best.platform > 0 || best.lastfm >= MIN_SCROBBLES)) {
      p.action = "renamed";
      p.artist = best.artist;
      p.title = best.title;
      p.evidence = describe(best.sources);
    } else {
      p.action = "removed";
      var h = best || hint;
      p.evidence = h ? "only " + describe(h.sources) + " (not enough to go on)" : "no other name anywhere";
      p.suggestion = h ? label(h) : "";
    }
    delete p.votes;
  });
  return out;
}

module.exports = { load: load, plan: plan, uploadOf: uploadOf, keyOf: keyOf };
