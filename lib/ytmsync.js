// The bot's "YOUTUBE MUSIC" playlist, kept in step with the official Indie
// Discotheque year playlists on YouTube Music. Each sync:
//   1. checks every YouTube track in the list can still play here (the same
//      rules the bot uses before every song, lib/checks.js)
//   2. replaces each broken track, in its place, with the same recording from
//      YouTube Music (audio tracks only; never a DJ-mixed compilation track).
//      With no match it stays in the list (flagged), for a later sync to try
//   3. adds every song from the year playlists that isn't in the list yet
//      (playable ones only, and no DJ-mixed compilation tracks)
//   4. swaps YouTube videos (music videos, "Official Audio" and fan uploads:
//      anything not from an "Artist - Topic" channel) for the same song's
//      YouTube Music audio track, in the list and coming in. With no audio
//      track yet the video stays, for a later sync to try again
//   5. removes duplicates: the same song (title, artists and version) within a
//      few seconds of the same length, or the same upload twice. The copy kept
//      is a YouTube Music track if there is one, the earliest that can play
//   6. shuffles the list
// Tracks someone flagged for a reason of their own (off-theme, low quality)
// are never changed or unflagged. Nothing outside this one playlist is changed.
// All the changes are saved together in one transaction, so a track the bot
// moves or flags meanwhile is never lost or duplicated.
//
// Cost: YouTube Music (the playlists and the searches) uses no API quota
// (lib/ytmusic.js). The YouTube Data API is used to check tracks can play:
// 1 unit per 50 tracks (about 600 units a sync for 30,000 tracks, of 10,000 a day).
"use strict";

var crypto = require("crypto");
var tags = require("./tags");
var swaps = require("./swaps");

// The official Indie Discotheque year playlists on YouTube Music.
var SOURCES = [
  { year: 2026, id: "PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN" },
  { year: 2025, id: "PLTW5JZnPjE_onNAnNNGWFyek1iTfsdSrS" },
  { year: 2024, id: "PLTW5JZnPjE_pezZ1Xi92GmMvNM_mMLlvJ" },
  { year: 2023, id: "PLTW5JZnPjE_pZX15o6e9G3wMsj1UDZYph" },
  { year: 2022, id: "PLTW5JZnPjE_q9FM-Si3tUjgbxlax6jDM2" },
  { year: 2021, id: "PLTW5JZnPjE_r-QVi3wDsHGEkh6I3ikYSy" },
  { year: 2020, id: "PLTW5JZnPjE_rrHhKVblwnwiDBkYbyebMs" },
  { year: 2019, id: "PLTW5JZnPjE_qwqk7hktIKv3HxegQQVToo" },
  { year: 2018, id: "PLTW5JZnPjE_qNnWzbbQ2aNzeTc1vMfHuf" },
  { year: 2017, id: "PLTW5JZnPjE_qxf5lkzEmWk4q-p9l46p1e" },
  { year: 2016, id: "PLTW5JZnPjE_poQsHO3KPZs-qqUvHnVLya" },
  { year: 2015, id: "PLTW5JZnPjE_reHcKk9pdZhtqttu8qpKkG" },
  { year: 2014, id: "PLTW5JZnPjE_oA8O2JO8_yCmMaWvHiZ2PR" },
  { year: 2013, id: "PLTW5JZnPjE_oPQ0TGWl9TSgHnLkS8Gi9-" },
  { year: 2012, id: "PLTW5JZnPjE_pbx8O4i2Cg9UOVrgEoudmn" },
  { year: 2011, id: "PLTW5JZnPjE_rzpy5UkQcPVVkcdB45MrGS" },
  { year: 2010, id: "PLTW5JZnPjE_qIyF0WNNtM2NC70fjVkmgR" },
  { year: 2009, id: "PLTW5JZnPjE_r9HE9rtK0Tg8jP3wktJReR" },
  { year: 2008, id: "PLTW5JZnPjE_qoUOeK3M8mRS0ZjuybaUZ1" },
  { year: 2007, id: "PLTW5JZnPjE_pR8Dys5c5y8NKF0kjzzWC2" },
  { year: 2006, id: "PLTW5JZnPjE_qzLC6mywnediWuL7xZzMi3" },
  { year: 2005, id: "PLTW5JZnPjE_o6Lgpq24CyBdEV5X3PZP1A" },
  { year: 2004, id: "PLTW5JZnPjE_oAgN4dQ0YbbmEEL8Oj778C" },
  { year: 2003, id: "PLTW5JZnPjE_rUFoC8edSyf_jST50IVkQH" },
  { year: 2002, id: "PLTW5JZnPjE_qOMRqslkyQGoZvndMSpLwp" },
  { year: 2001, id: "PLTW5JZnPjE_qbCiyqLjMteOHlslmHWDe8" }
];

// Flag codes that mean the file can't play (gone, private, blocked, not
// embeddable, age restricted, broken): those tracks get replaced. Any other
// flag (low quality 9, off-theme 10) is someone's call and is left alone.
var BROKEN_CODES = [1, 2, 3, 4, 5, 6, 7, 8];
var DAY = 24 * 60 * 60 * 1000;
var CACHE_DAYS = 30; // a song's YouTube Music search is reused this long (shared with swap suggestions)
var MEDIA_FIELDS = /^(?:flagged|swap|swappedFrom|img|url|duration|length|dur|time|seconds|msecs|ms|type|cid)$/;
var YT_ID = /^[A-Za-z0-9_-]{11}$/;

// ------------------------------------------------------------- helpers

/** A playlist id from a link ("…?list=PL…&si=…") or the id itself. */
function playlistIdOf(s) {
  s = String(s || "").trim();
  var m = /[?&]list=([A-Za-z0-9_-]+)/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,64}$/.test(s) ? s : "";
}

/**
 * The year playlists from YTMUSIC_SOURCES ("2027=link, 2026=link" or just
 * links/ids, comma or space separated), or the official ones when unset.
 */
function parseSources(text) {
  if (!text || !String(text).trim()) return SOURCES.slice();
  var out = [];
  String(text).split(/[\s,]+/).forEach(function(part) {
    if (!part) return;
    var m = /^(\d{4})[=:](.+)$/.exec(part);
    var id = playlistIdOf(m ? m[2] : part);
    if (id && !out.some(function(s) { return s.id === id; })) out.push({ year: m ? Number(m[1]) : 0, id: id });
  });
  return out;
}

// A track from a DJ-mixed compilation: "(Mixed)" / "[Mixed]" / "(… / Mixed)"
// in the title, or an album "Mixed by …", "(Mixed)", "Continuous Mix", "DJ
// Mix", "Mix Cut". Remixes ("Remixed"), unmixed DJ editions ("Unmixed DJ
// Format") and songs called "Mixed Emotions" aren't.
var MIXED_TITLE = /[([][^)\]]*\bmixed\s*[)\]]|\bmixed by\b|\b(?:continuous|non[- ]?stop|dj)[- ]?mix\b|\bmix[- ]cut\b/i;
var MIXED_ALBUM = /[([]\s*mixed\s*[)\]]|\b(?:compiled and )?mixed by\b|\bmix(?:\s+\d+)?\s+by\b|\b(?:continuous|non[- ]?stop|dj)[- ]?mix(?:ed)?\b|\bmix[- ]cut\b/i;
function isMixed(t) {
  if (!t) return false;
  return MIXED_TITLE.test(String(t.title || t.name || "")) || MIXED_ALBUM.test(String(t.album || ""));
}

// When a Firebase push key was made (ms), or 0 for any other key.
var PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
function pushTime(key) {
  if (typeof key !== "string" || key.length !== 20) return 0;
  var ms = 0;
  for (var i = 0; i < 8; i++) {
    var v = PUSH_CHARS.indexOf(key.charAt(i));
    if (v < 0) return 0;
    ms = ms * 64 + v;
  }
  return ms > Date.UTC(2012, 0, 1) && ms < Date.now() + DAY ? ms : 0;
}

/** "Artist - Title" for a YouTube Music row or a video (" - Topic" channels give the artist). */
function nameOf(artist, title) {
  artist = String(artist || "").replace(/\s+-\s+Topic$/, "").trim();
  title = String(title || "").trim();
  if (!title) return "";
  return artist && !/^various artists$/i.test(artist) ? artist + " - " + title : title;
}

/** A YouTube Music audio track ("Art Track"): uploaded by an "Artist - Topic" channel. */
function isTopic(channel) {
  return / - Topic$/.test(String(channel || ""));
}

/** An artist name from a video's channel: "DaftPunkVEVO" -> "DaftPunk", "Band Official" -> "Band". */
function channelArtist(channel) {
  return String(channel || "").replace(/\s+-\s+Topic$/, "").replace(/\s*VEVO$/i, "")
    .replace(/\s+(?:official|music|records|tv)$/i, "").trim();
}

// How far a music video's length may be from its audio track's (intros,
// outros and skits): 45 seconds or 30%, whichever is more.
function videoSlack(dur) {
  return Math.max(45, (Number(dur) || 0) * 0.3);
}

/** What makes a song the same song: its title, version and artists. Null when the name can't tell. */
function identity(name) {
  var p = tags.parse(String(name || ""));
  if (p.weak || !p.title || !p.artists.length) return null;
  var k = tags.keysOf(p);
  var main = p.artists.map(tags.artistKeyOf).filter(Boolean);
  if (!main.length || !k.title) return null;
  var vtext = p.versions.map(function(v) { return tags.squash(v.text || ""); }).sort().join(",");
  return { song: k.title + "|" + k.version, vtext: vtext, main: main, all: main.concat(p.featured.map(tags.artistKeyOf).filter(Boolean)) };
}

/**
 * The same song? Same title and version, an artist in common (featured
 * artists may sit in either field) and lengths within `tol` seconds. With
 * `loose`, an unknown length doesn't rule it out, but then the version must
 * be spelled the same ("Club Version" never stands in for the original).
 */
function sameSong(a, b, tol, loose) {
  if (!a.ident || !b.ident || a.ident.song !== b.ident.song) return false;
  var shared = a.ident.main.some(function(x) { return b.ident.all.indexOf(x) !== -1; }) ||
    b.ident.main.some(function(x) { return a.ident.all.indexOf(x) !== -1; });
  if (!shared) return false;
  if (!a.dur || !b.dur) return !!loose && a.ident.vtext === b.ident.vtext;
  return Math.abs(a.dur - b.dur) <= tol;
}

function shuffle(a, random) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = random ? Math.floor(random() * (i + 1)) : crypto.randomInt(i + 1);
    var x = a[i];
    a[i] = a[j];
    a[j] = x;
  }
  return a;
}

/**
 * Duplicates among `entries` ({id, type, cid, ident, dur, added, order,
 * available, deliberate}): every copy after the first of the same upload, and
 * every copy of the same song within `tol` seconds. Kept: a copy someone
 * flagged (so the flag stays), else the earliest YouTube Music track (`audio`)
 * that can play, else the earliest copy that can play, else the earliest.
 * Returns the ids to drop.
 */
function duplicates(entries, tol) {
  var parent = entries.map(function(e, i) { return i; });
  var root = function(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  var join = function(a, b) { a = root(a); b = root(b); if (a !== b) parent[b] = a; };
  var byUpload = {};
  var bySong = {};
  entries.forEach(function(e, i) {
    var u = String(e.type) + ":" + String(e.cid);
    if (u in byUpload) join(byUpload[u], i); else byUpload[u] = i;
    if (e.ident) (bySong[e.ident.song] = bySong[e.ident.song] || []).push(i);
  });
  Object.keys(bySong).forEach(function(k) {
    var g = bySong[k];
    for (var x = 0; x < g.length; x++) {
      for (var y = x + 1; y < g.length; y++) {
        if (sameSong(entries[g[x]], entries[g[y]], tol)) join(g[x], g[y]);
      }
    }
  });
  var groups = {};
  entries.forEach(function(e, i) { (groups[root(i)] = groups[root(i)] || []).push(e); });
  var drop = [];
  Object.keys(groups).forEach(function(r) {
    var g = groups[r];
    if (g.length < 2) return;
    g.sort(function(a, b) { return (a.added - b.added) || (a.order - b.order); });
    var keep = g.filter(function(e) { return e.deliberate; })[0] ||
      g.filter(function(e) { return e.available && e.audio; })[0] ||
      g.filter(function(e) { return e.available; })[0] || g[0];
    g.forEach(function(e) { if (e !== keep) drop.push(e.id); });
  });
  return drop;
}

// ---------------------------------------------------------------- runner

/**
 * @param {Object} deps
 *   db: firebase.database(); botid() -> the bot's uid
 *   shallowKeys(path) -> Promise<string[]>
 *   videos(ids) -> Promise<{id: {problem, dur, title, channel}}>   (≤50 ids, 1 unit; rejects when YouTube can't answer)
 *   playlist(id) -> Promise<{title, tracks: [{cid, title, artist, album, dur}]}>   (ytmusic.playlistTracks)
 *   playlistItems(id) -> Promise<string[]>   (optional: the Data API's list of a playlist, when YouTube Music can't answer)
 *   search(query) -> Promise<{songs, any}>   (ytmusic.searchSongs)
 *   log, now, wait, random
 *   listName ("YOUTUBE MUSIC"), sources ([{year, id}]), dupeSeconds (3),
 *   maxSearches (per sync), delayMs (between searches), shuffle (true)
 */
function createSync(deps) {
  var db = deps.db;
  var log = deps.log || function() {};
  var now = deps.now || Date.now;
  var wait = deps.wait || function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var listName = String(deps.listName || "YOUTUBE MUSIC").trim();
  var sources = (deps.sources || SOURCES).slice().sort(function(a, b) { return (a.year || 9999) - (b.year || 9999); });
  var tol = deps.dupeSeconds == null ? 3 : Number(deps.dupeSeconds);
  var state = { running: false, last: null, startedAt: 0, listId: null, step: "" };
  var cacheWritable = true;
  var stateWritable = true;

  var norm = function(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); };

  // The bot's playlist with that name (made if it doesn't exist).
  var findList = function() {
    var uid = deps.botid();
    if (!uid) return Promise.reject(new Error("not signed in yet"));
    var named = function(id) {
      return db.ref("playlists/" + uid + "/" + id + "/name").once("value").then(function(s) { return norm(s.val()) === norm(listName); });
    };
    var known = state.listId ? named(state.listId).then(function(ok) { return ok ? state.listId : null; }) : Promise.resolve(null);
    return known.then(function(id) {
      if (id) return { id: id };
      return deps.shallowKeys("playlists/" + uid).then(function(ids) {
        return ids.reduce(function(p, lid) {
          return p.then(function(found) { return found || named(lid).then(function(ok) { return ok ? lid : null; }); });
        }, Promise.resolve(null));
      }).then(function(found) {
        if (found) return { id: found };
        var ref = db.ref("playlists/" + uid).push();
        log("youtube music: the bot has no playlist called \"" + listName + "\", so it's made now");
        return ref.set({ name: listName }).then(function() { return { id: ref.key, created: true }; });
      });
    }).then(function(l) {
      state.listId = l.id;
      l.ref = db.ref("playlists/" + uid + "/" + l.id + "/list");
      return l;
    });
  };

  // YouTube's answer for many videos, 50 a call. Rejects when it can't answer.
  var videosAll = function(ids, stats) {
    var out = {};
    var todo = ids.filter(function(id, i) { return YT_ID.test(id) && ids.indexOf(id) === i; });
    var batches = [];
    for (var i = 0; i < todo.length; i += 50) batches.push(todo.slice(i, i + 50));
    return batches.reduce(function(p, b) {
      return p.then(function() {
        stats.units++;
        return deps.videos(b).then(function(res) { Object.assign(out, res); });
      });
    }, Promise.resolve()).then(function() { return out; });
  };

  // A song's YouTube Music matches (the swap suggestions' search, shared with
  // them through swapCache): the same recording, best first, no DJ mixes.
  var readCache = function(id) {
    return db.ref("swapCache/" + id).once("value").then(function(s) { return s.val(); }, function() { return null; });
  };
  var writeCache = function(id, val) {
    if (!cacheWritable) return Promise.resolve();
    return db.ref("swapCache/" + id).set(val).catch(function(err) {
      cacheWritable = false;
      log("youtube music: couldn't save searches in swapCache (" + err.message + "); publish firebase-rules.json");
    });
  };
  // Videos (job.loose) are ranked without their length, which often includes
  // an intro, and cached apart from the swap suggestions' strict matches.
  var matchesFor = function(job, t, stats, ctl) {
    var id = (job.loose ? "v" : "") + swaps.cacheId(job.name);
    return readCache(id).then(function(c) {
      if (c && t - (Number(c.date) || 0) < CACHE_DAYS * DAY && Array.isArray(c.picks) && swaps.usableCache(c, t)) {
        stats.remembered++;
        return c.picks;
      }
      if (ctl.stopped || stats.searched >= (deps.maxSearches || 200)) { ctl.waiting++; return null; }
      if (!ctl.gate) ctl.gate = swaps.catalogGate(deps.search, deps.canary);
      return (stats.searched ? wait(deps.delayMs == null ? 2500 : deps.delayMs) : Promise.resolve()).then(function() {
        stats.searched++;
        return deps.search(job.query);
      }).then(function(res) {
        ctl.errors = 0;
        if (!res.songs.length && !res.any) return null; // nothing at all: don't remember that as "no match"
        // no songs before the catalog has shown it answers: nothing is saved (see swaps.catalogGate)
        return ctl.gate.check(res).then(function(trusted) {
          if (ctl.gate.down && !ctl.stopped) ctl.stopped = ctl.gate.down;
          if (!trusted) return null;
          var picks = swaps.rankMatches(job.name, res.songs, job.loose ? {} : { dur: job.dur })
            .filter(function(s) { return !isMixed(s); }).slice(0, job.loose ? 5 : 3).map(swaps.pickOf);
          return writeCache(id, { q: job.query.slice(0, 500), date: t, picks: picks, v: swaps.CACHE_VERSION }).then(function() { return picks; });
        });
      }, function(err) {
        ctl.errors++;
        log("youtube music: search failed:", err.message);
        if (ctl.errors >= 3 || err.status === 429) ctl.stopped = "YouTube Music isn't answering searches (" + err.message + ")";
        return null;
      });
    });
  };

  // The tracks of one source playlist: from YouTube Music, or (when it can't
  // answer) the Data API's list of the playlist's videos.
  var readSource = function(src) {
    return deps.playlist(src.id).then(function(r) {
      if (!r.tracks.length && deps.playlistItems) throw new Error("no tracks");
      return r.tracks;
    }).catch(function(err) {
      if (!deps.playlistItems) throw err;
      log("youtube music: couldn't read playlist " + src.id + " from YouTube Music (" + err.message + "); asking the YouTube API");
      return deps.playlistItems(src.id).then(function(ids) {
        return ids.map(function(cid) { return { cid: cid, title: "", artist: "", album: "", dur: 0 }; });
      });
    });
  };

  // The replacement for one broken track: its saved swap suggestion or the
  // best match YouTube Music has, checked to play here. Null when there's none.
  var pickFor = function(entry, picks, problems) {
    var sw = entry.track.swap;
    var choices = [];
    if (sw && sw.cid && !sw.dismissed && !isMixed(sw)) choices.push(sw);
    (picks || []).forEach(function(pk) { if (!sw || pk.cid !== sw.dismissed) choices.push(pk); });
    return choices.filter(function(pk) {
      return YT_ID.test(pk.cid) && !(entry.type == 1 && pk.cid === String(entry.cid)) && problems[pk.cid] === 0;
    })[0] || null;
  };

  // The track, now that it plays `pick`: same place, same tags; where it
  // came from is kept in swappedFrom (the site's Undo uses that).
  var replaced = function(entry, pick, t, rename) {
    var cur = entry.track;
    var next = {};
    Object.keys(cur).forEach(function(k) { if (!MEDIA_FIELDS.test(k)) next[k] = cur[k]; });
    next.type = 1;
    next.cid = pick.cid;
    next.url = "https://www.youtube.com/watch?v=" + pick.cid;
    if (pick.dur) next.duration = Number(pick.dur);
    if (!entry.ident || rename) next.name = (nameOf(pick.artist, pick.title) || cur.name).slice(0, 1000);
    next.swappedFrom = { type: cur.type, cid: cur.cid, date: t };
    next.added = entry.added || t;
    return next;
  };

  /**
   * One sync. Resolves with what it did (see summary()), or null when one is
   * already running.
   * @param {{reason?: string, shuffle?: boolean}} [opts]
   */
  var run = function(opts) {
    opts = opts || {};
    if (state.running) return Promise.resolve(null);
    state.running = true;
    state.startedAt = now();
    var t = now();
    var stats = { reason: opts.reason || "", tracks: 0, checked: 0, broken: 0, flagged: 0, replaced: 0, noMatch: 0, upgraded: 0, videosLeft: 0,
      sources: 0, sourceErrors: 0, sourceTracks: 0, added: 0, mixed: 0, unplayable: 0, already: 0,
      duplicates: 0, named: 0, searched: 0, remembered: 0, units: 0, shuffled: 0, total: 0, stopped: "", created: false };
    var ctl = { stopped: "", errors: 0, waiting: 0 };
    var list;
    var entries = [];
    var info = {};
    var imports = [];
    var ops = {};
    var step = function(s) { state.step = s; };

    step("finding the playlist");
    return findList().then(function(l) {
      list = l;
      stats.created = !!l.created;
      step("reading the playlist");
      return l.ref.once("value");
    }).then(function(snap) {
      snap.forEach(function(c) {
        var tr = c.val();
        if (!tr || typeof tr !== "object") return;
        entries.push({ id: c.key, key: c.key, track: tr, type: tr.type, cid: tr.cid, origCid: String(tr.cid), order: entries.length,
          added: Number(tr.added) || pushTime(c.key) || 0 });
      });
      stats.tracks = entries.length;
      step("checking " + entries.length + " tracks on YouTube");
      var ids = entries.filter(function(e) { return e.type == 1; }).map(function(e) { return String(e.cid); });
      return videosAll(ids, stats);
    }).then(function(res) {
      info = res;
      entries.forEach(function(e) {
        var tr = e.track;
        var code = tr.flagged ? Number(tr.flagged.code) || 0 : 0;
        e.deliberate = !!tr.flagged && BROKEN_CODES.indexOf(code) === -1;
        var meta = e.type == 1 ? info[String(e.cid)] : null;
        if (e.type == 1) {
          stats.checked++;
          e.problem = meta ? meta.problem : 2;
        } else {
          e.problem = 0;
        }
        e.dur = (meta && meta.dur) || swaps.trackSeconds(tr);
        e.name = String(tr.name || "");
        // a track saved by its title alone ("Lose Control"): the artist from
        // its " - Topic" channel, as the room already shows it when it plays
        if (meta && meta.problem === 0 && !/ - /.test(e.name) && / - Topic$/.test(meta.channel || "") && !/^Various Artists - Topic$/.test(meta.channel)) {
          var fuller = nameOf(meta.channel, e.name);
          if (fuller !== e.name) { e.name = fuller; e.rename = true; }
        }
        e.ident = identity(e.name);
        e.broken = !e.deliberate && (BROKEN_CODES.indexOf(code) !== -1 || e.problem > 0);
        e.available = !tr.flagged && !e.broken;
        e.meta = meta;
        e.audio = !!meta && isTopic(meta.channel);
        e.video = e.available && e.type == 1 && !!meta && !e.audio;
        if (e.broken) stats.broken++;
      });

      // ---- the year playlists
      step("reading the year playlists");
      var have = {};
      entries.forEach(function(e) { if (e.type == 1) have[String(e.cid)] = true; });
      var rows = [];
      return sources.reduce(function(p, src) {
        return p.then(function() {
          return readSource(src).then(function(tracks) {
            stats.sources++;
            stats.sourceTracks += tracks.length;
            tracks.forEach(function(r) {
              if (!YT_ID.test(r.cid)) return;
              if (have[r.cid]) { stats.already++; return; }
              have[r.cid] = true;
              if (isMixed(r)) { stats.mixed++; return; }
              rows.push(r);
            });
          }, function(err) {
            stats.sourceErrors++;
            log("youtube music: couldn't read the " + (src.year || "") + " playlist " + src.id + ":", err.message);
          });
        });
      }, Promise.resolve()).then(function() {
        step("checking " + rows.length + " new tracks on YouTube");
        return videosAll(rows.map(function(r) { return r.cid; }), stats);
      }).then(function(res) {
        rows.forEach(function(r, i) {
          var meta = res[r.cid];
          if (!meta || meta.problem) { stats.unplayable++; return; }
          var name = r.artist && r.title ? nameOf(r.artist, r.title) : nameOf(meta.channel, meta.title);
          if (!name) { stats.unplayable++; return; }
          if (isMixed({ title: r.title || meta.title, album: r.album })) { stats.mixed++; return; }
          var dur = meta.dur || r.dur || 0;
          var track = { type: 1, cid: r.cid, name: name.slice(0, 1000), url: "https://www.youtube.com/watch?v=" + r.cid, added: t };
          if (dur) track.duration = dur;
          imports.push({ id: "+" + r.cid, type: 1, cid: r.cid, track: track, name: name, ident: identity(name), dur: dur,
            added: t, order: entries.length + i, available: true, deliberate: false, isNew: true,
            meta: meta, audio: isTopic(meta.channel), video: !isTopic(meta.channel) });
        });
      });
    }).then(function() {
      // ---- broken tracks: a working copy already in the list (or coming
      // in) stands in for them; the rest are searched for on YouTube Music
      step("finding YouTube Music tracks for broken tracks and videos");
      var working = entries.filter(function(e) { return e.available; }).concat(imports);
      var jobs = [];
      entries.forEach(function(e) {
        if (!e.broken) return;
        var copy = working.filter(function(w) { return sameSong(e, w, tol, true); })[0];
        if (copy) { e.coveredBy = copy; return; }
        var query = swaps.queryFor(e.name);
        if (!query && !(e.track.swap && e.track.swap.cid)) { e.noQuery = true; return; }
        jobs.push({ entry: e, name: e.name, query: query, dur: e.dur });
      });
      // ---- videos (in the list, then coming in): the same song's YouTube
      // Music audio track, if the list has it already or YouTube Music does
      var audioCopies = working.filter(function(w) { return w.audio; });
      entries.concat(imports).forEach(function(e) {
        if (!e.video) return;
        var copy = audioCopies.filter(function(w) { return w !== e && sameSong(e, w, videoSlack(e.dur), true); })[0];
        if (copy) { e.coveredBy = copy; return; }
        // its name, or the video's own title ("Artist - Song (Official Video)"),
        // or the channel's name and the title
        var vt = String((e.meta && e.meta.title) || "");
        var name = e.ident ? e.name : identity(vt) ? vt : nameOf(channelArtist(e.meta && e.meta.channel), vt || e.name);
        var query = swaps.queryFor(name);
        if (!query && !(e.track.swap && e.track.swap.cid)) return;
        jobs.push({ entry: e, name: name, query: query, dur: e.dur, loose: true });
      });
      return jobs.reduce(function(p, job) {
        return p.then(function() {
          if (!job.query) return;
          return matchesFor(job, t, stats, ctl).then(function(picks) {
            if (picks && job.loose && job.dur) {
              // within a video's slack of its length, the closest first
              picks = picks.filter(function(pk) { return !pk.dur || Math.abs(pk.dur - job.dur) <= videoSlack(job.dur); });
              picks = picks.filter(function(pk) { return Math.abs((pk.dur || 0) - job.dur) <= 5; })
                .concat(picks.filter(function(pk) { return Math.abs((pk.dur || 0) - job.dur) > 5; }));
            }
            job.picks = picks;
          });
        });
      }, Promise.resolve()).then(function() {
        var cids = [];
        jobs.forEach(function(job) {
          var sw = job.entry.track.swap;
          if (sw && sw.cid && !sw.dismissed) cids.push(sw.cid);
          (job.picks || []).forEach(function(pk) { cids.push(pk.cid); });
        });
        return videosAll(cids, stats).then(function(res) {
          var problems = {};
          cids.forEach(function(c) { problems[c] = res[c] ? res[c].problem : 2; });
          var taken = {};
          entries.forEach(function(e) { if (e.type == 1) taken[String(e.cid)] = e; });
          imports.forEach(function(e) { taken[e.cid] = e; });
          jobs.forEach(function(job) {
            var e = job.entry;
            var pick = pickFor(e, job.picks, problems);
            if (!pick) return;
            var there = taken[pick.cid];
            if (there && there !== e && (there.replacement || !there.broken)) { e.coveredBy = there; return; } // already in the list: this copy goes
            if (e.isNew) {
              // coming in as a video: the audio track comes in instead
              e.replacement = { type: 1, cid: pick.cid, name: (nameOf(pick.artist, pick.title) || e.name).slice(0, 1000),
                url: "https://www.youtube.com/watch?v=" + pick.cid, added: t };
              if (pick.dur) e.replacement.duration = Number(pick.dur);
            } else {
              e.replacement = replaced(e, pick, t, job.loose);
            }
            taken[pick.cid] = e;
          });
        });
      });
    }).then(function() {
      // ---- what happens to each track
      entries.concat(imports).forEach(function(e) {
        if (!e.replacement) return;
        if (e.video) stats.upgraded++; else stats.replaced++;
        e.track = e.replacement;
        e.type = 1;
        e.cid = e.track.cid;
        e.dur = Number(e.track.duration) || e.dur;
        e.ident = identity(e.track.name) || e.ident;
        e.broken = false;
        e.available = true;
        e.audio = true;
        e.video = false;
        e.upgraded = true;
      });
      // duplicates go, and so do broken tracks and videos a working
      // YouTube Music copy stands in for
      var drop = {};
      duplicates(entries.concat(imports), tol).forEach(function(id) { drop[id] = true; });
      entries.concat(imports).forEach(function(e) {
        if ((e.broken || e.video) && e.coveredBy) drop[e.id] = true;
      });
      entries.concat(imports).forEach(function(e) { if (e.video && !drop[e.id]) stats.videosLeft++; });
      entries.forEach(function(e) {
        if (drop[e.id]) {
          if (e.video) stats.upgraded++; else stats.duplicates++;
          ops[e.key] = { cid: e.origCid, remove: true };
        } else if (e.replacement) {
          ops[e.key] = { cid: e.origCid, track: e.track };
        } else if (e.broken) {
          // can't play and nothing to replace it with yet: kept for a later
          // sync to try again, flagged so the bot skips it
          stats.noMatch++;
          if (!e.track.flagged) {
            stats.flagged++;
            ops[e.key] = { cid: e.origCid, track: Object.assign({}, e.track, { flagged: { date: t, code: e.problem || 2 } }) };
          }
        } else if (e.rename) {
          stats.named++;
          ops[e.key] = { cid: e.origCid, track: Object.assign({}, e.track, { name: e.name.slice(0, 1000) }) };
        }
      });
      var adds = imports.filter(function(e) { return !drop[e.id]; });
      adds.forEach(function(e) { if (e.replacement) e.track = e.replacement; });
      stats.added = adds.length;

      // ---- one transaction: the changes, the new tracks, and the shuffle
      step("saving (" + adds.length + " new tracks)");
      var newKeys = adds.map(function() { return list.ref.push().key; });
      var doShuffle = opts.shuffle == null ? deps.shuffle !== false : !!opts.shuffle;
      var expectEmpty = entries.length === 0;
      var counts = null;
      // lengths YouTube gave just now, saved with tracks that have none, so
      // a track that later breaks can still be matched by its length
      var durs = {};
      Object.keys(info).forEach(function(cid) { if (info[cid].problem === 0 && info[cid].dur) durs[cid] = info[cid].dur; });
      return list.ref.transaction(function(cur) {
        if (cur === null && !expectEmpty) return null; // not loaded yet: Firebase asks again with the list
        cur = cur || {};
        var out = {};
        var present = {};
        var c = { replaced: 0, removed: 0, added: 0 };
        Object.keys(cur).forEach(function(k) {
          var tr = cur[k];
          if (!tr || typeof tr !== "object") return;
          var op = ops[k];
          // only if the slot still holds the track this sync looked at
          if (op && String(tr.cid) === op.cid) {
            if (op.remove) { c.removed++; return; }
            tr = op.track;
            c.replaced++;
          }
          // when it joined the list, so "the earliest copy" survives shuffles
          if (tr.added == null) tr = Object.assign({}, tr, { added: pushTime(k) || t });
          if (tr.type == 1 && !tr.flagged && !tr.duration && durs[String(tr.cid)]) tr = Object.assign({}, tr, { duration: durs[String(tr.cid)] });
          out[k] = tr;
          present[String(tr.type) + ":" + String(tr.cid)] = true;
        });
        adds.forEach(function(a, i) {
          var u = "1:" + a.cid;
          if (present[u]) return;
          present[u] = true;
          out[newKeys[i]] = a.track;
          c.added++;
        });
        counts = c;
        if (!doShuffle) return out;
        var slots = Object.keys(out);
        var moved = shuffle(slots.map(function(k) { return out[k]; }), deps.random);
        var res = {};
        slots.forEach(function(k, i) { res[k] = moved[i]; });
        return res;
      }, null, false).then(function(r) {
        if (!r.committed) throw new Error("the playlist couldn't be saved");
        var after = r.snapshot.val() || {};
        stats.total = Object.keys(after).length;
        if (doShuffle) stats.shuffled = stats.total;
        if (counts) stats.added = counts.added;
      });
    }).then(function() {
      if (ctl.stopped) stats.stopped = ctl.stopped;
      else if (ctl.waiting) stats.stopped = ctl.waiting + (ctl.waiting === 1 ? " track waits" : " tracks wait") + " for the next sync (search limit)";
      return finish(stats);
    }, function(err) {
      stats.stopped = (err && err.message) || String(err);
      stats.failed = true;
      log("youtube music: sync stopped, nothing changed:", stats.stopped);
      return finish(stats);
    });
  };

  var finish = function(stats) {
    stats.ms = now() - state.startedAt;
    stats.at = now();
    state.last = stats;
    state.running = false;
    state.step = "";
    log("youtube music: " + summary(stats));
    var saved = stateWritable ? db.ref("ytmSync").set({ at: stats.at, ok: !stats.failed, summary: summary(stats).slice(0, 1000) }).catch(function(err) {
      stateWritable = false;
      log("youtube music: couldn't save ytmSync (" + err.message + "); publish firebase-rules.json");
    }) : Promise.resolve();
    return saved.then(function() { return stats; });
  };

  /**
   * One track the bot just flagged while playing from this playlist: put the
   * same recording from YouTube Music in its place now, if there is one.
   */
  var track = function(ref, key) {
    if (state.running) return Promise.resolve(false);
    var t = now();
    var stats = { searched: 0, remembered: 0, units: 0 };
    var ctl = { stopped: "", errors: 0, waiting: 0 };
    return ref.child(key).once("value").then(function(s) {
      var tr = s.val();
      if (!tr || !tr.flagged || BROKEN_CODES.indexOf(Number(tr.flagged.code)) === -1) return false;
      var e = { key: key, track: tr, type: tr.type, cid: tr.cid, name: String(tr.name || ""), dur: swaps.trackSeconds(tr),
        added: Number(tr.added) || pushTime(key) || t };
      e.ident = identity(e.name);
      var job = { name: e.name, query: swaps.queryFor(e.name), dur: e.dur };
      return (job.query ? matchesFor(job, t, stats, ctl) : Promise.resolve(null)).then(function(picks) {
        var cids = (picks || []).map(function(p) { return p.cid; });
        if (tr.swap && tr.swap.cid && !tr.swap.dismissed) cids.unshift(tr.swap.cid);
        if (!cids.length) return false;
        return videosAll(cids, stats).then(function(res) {
          var problems = {};
          cids.forEach(function(c) { problems[c] = res[c] ? res[c].problem : 2; });
          var pick = pickFor(e, picks, problems);
          if (!pick) return false;
          var next = replaced(e, pick, t);
          return ref.child(key).transaction(function(cur) {
            if (cur === null) return null;
            if (String(cur.cid) !== String(tr.cid) || !cur.flagged) return; // changed meanwhile
            return next;
          }, null, false).then(function(r) {
            if (r.committed && r.snapshot.val()) log("youtube music: replaced " + tr.name + " with " + pick.cid);
            return r.committed;
          });
        });
      });
    }).catch(function(err) {
      log("youtube music: couldn't replace a flagged track:", err && err.message);
      return false;
    });
  };

  /** When the last sync ran (ms), from the database: 0 if never. */
  var lastRunAt = function() {
    return db.ref("ytmSync/at").once("value").then(function(s) { return Number(s.val()) || 0; }, function() { return 0; });
  };

  /** Is this list ref the synced playlist? */
  var isList = function(ref) {
    var uid = deps.botid && deps.botid();
    return !!(ref && uid && state.listId && ref.toString() === db.ref("playlists/" + uid + "/" + state.listId + "/list").toString());
  };

  return { run: run, track: track, state: state, lastRunAt: lastRunAt, isList: isList, findList: findList };
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many || one + "s");
}

/** What a sync did, in a sentence or two. */
function summary(s) {
  if (!s) return "no sync has run yet.";
  if (s.failed) return "stopped before changing anything: " + s.stopped + ".";
  var out = plural(s.tracks, "track") + " checked" + (s.created ? " (new playlist)" : "") +
    "; " + plural(s.replaced, "broken track") + " replaced" +
    (s.noMatch ? ", " + s.noMatch + " with no match yet (kept" + (s.flagged ? ", " + s.flagged + " newly flagged" : "") + ")" : "") +
    "; " + plural(s.added, "new song") + " from " + plural(s.sources, "year playlist") +
    (s.mixed ? " (" + s.mixed + " DJ-mixed skipped)" : "") +
    (s.upgraded || s.videosLeft ? "; " + plural(s.upgraded || 0, "video") + " swapped for YouTube Music tracks" +
      (s.videosLeft ? " (" + s.videosLeft + " with none yet)" : "") : "") +
    "; " + plural(s.duplicates, "duplicate") + " removed" +
    (s.named ? "; " + plural(s.named, "artist") + " filled in" : "") +
    (s.shuffled ? "; shuffled " + s.shuffled : "; " + s.total + " tracks now") +
    "; " + plural(s.units || 0, "YouTube API unit");
  if (s.sourceErrors) out += "; " + plural(s.sourceErrors, "playlist") + " couldn't be read";
  if (s.stopped) out += "; " + s.stopped;
  return out + ".";
}

module.exports = {
  createSync: createSync,
  summary: summary,
  isMixed: isMixed,
  isTopic: isTopic,
  channelArtist: channelArtist,
  identity: identity,
  sameSong: sameSong,
  duplicates: duplicates,
  parseSources: parseSources,
  playlistIdOf: playlistIdOf,
  pushTime: pushTime,
  nameOf: nameOf,
  SOURCES: SOURCES,
  BROKEN_CODES: BROKEN_CODES
};
