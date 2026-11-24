// Song tempo (BPM).
// When a song starts, look up its tempo on Deezer (free, no key) and publish
// it as songBpm {started, bpm, src} so the site can bop to the beat (not on
// songToPlay: clients treat any change there as a new song). Tempos are cached per
// track in bpm/<type>_<cid>; anyone DJing or a mod can correct one with
// "!bpm 128" (manual values are never overwritten by a lookup).
"use strict";
var http = require("./http").http;

var BPM_MIN = 40, BPM_MAX = 250;
// Bump when the lookup gets better, so tracks it missed are tried again
var BPM_LOOKUP_VERSION = 2;
var bpmKey = function(type, cid) {
  return String(type) + "_" + String(cid).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
};
var normalizeForMatch = function(str) {
  return String(str || "").toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&amp;/g, "&").replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "") // (Official Video), [Remastered]...
    .replace(/\b(feat|ft|featuring)\.?\s.*$/, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
};
var looselyMatches = function(a, b) {
  a = normalizeForMatch(a); b = normalizeForMatch(b);
  if (!a || !b) return false;
  return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0;
};
var getJSON = function(url) {
  return http(url, { timeout: 10000 }).then(function(res) {
    var body = res.json;
    if (res.status !== 200 || !body || body.error) {
      throw new Error((body && body.error && (body.error.message || body.error.type)) || "HTTP " + res.status);
    }
    return body;
  });
};
// Deezer's fielded search (artist:"x" track:"y") returns nothing these days,
// so search plainly and pick the hits whose artist and title match. Many
// Deezer tracks have no tempo (bpm 0), so try the other matching versions of
// the song (album, single, radio edit...) until one has it.
var deezerBpm = function(artist, title) {
  var q = (normalizeForMatch(artist) + " " + normalizeForMatch(title)).trim();
  return getJSON("https://api.deezer.com/search?limit=15&q=" + encodeURIComponent(q)).then(function(res) {
    var hits = (res.data || []).filter(function(t) {
      return t && t.id && t.artist && looselyMatches(t.artist.name, artist) && looselyMatches(t.title, title);
    }).slice(0, 4);
    var tryHit = function(i) {
      if (i >= hits.length) return null;
      return getJSON("https://api.deezer.com/track/" + hits[i].id).then(function(t) {
        var bpm = Number(t && t.bpm);
        return bpm >= BPM_MIN && bpm <= BPM_MAX ? Math.round(bpm * 10) / 10 : tryHit(i + 1);
      }, function() { return tryHit(i + 1); });
    };
    return tryHit(0);
  });
};
/**
 * Each song's tempo, published as songBpm when it starts.
 * @param {object} deps
 * @param {function(): any} deps.db - firebase.database()
 * @param {function(): any} deps.song - the song on the decks (songToPlay as the bot holds it)
 * @param {function(...*): void} [deps.log]
 */
function createTempo(deps) {
  var log = deps.log || console.log;
  // Put a tempo on the playing song, if it's still the same song
  var setSongBpm = function(started, bpm, src) {
    var song = deps.song();
    if (!song || song.started !== started) return Promise.resolve();
    song.bpm = bpm;
    song.bpmSrc = src;
    return deps.db().ref("songBpm").set({ started: started, bpm: bpm, src: src }).catch(function(e) {
      log("bpm update failed:", e.message);
    });
  };
  var findBpm = function(s) {
    if (!s || !s.cid || !s.started) return;
    var key = bpmKey(s.type, s.cid);
    deps.db().ref("bpm/" + key).once("value").then(function(snap) {
      var cached = snap.val();
      if (cached && cached.bpm) return setSongBpm(s.started, cached.bpm, cached.src || "cache");
      if (cached && cached.none && cached.v >= BPM_LOOKUP_VERSION && Date.now() - cached.at < 30 * 24 * 3600 * 1000) return; // looked up recently, nothing found
      if (!s.artist || !s.title || s.artist === "Unknown") return;
      return deezerBpm(s.artist, s.title).then(function(bpm) {
        var entry = bpm ? { bpm: bpm, src: "deezer", at: Date.now() } : { none: true, v: BPM_LOOKUP_VERSION, at: Date.now() };
        return deps.db().ref("bpm/" + key).set(entry).then(function() {
          if (bpm) return setSongBpm(s.started, bpm, "deezer");
        });
      });
    }).catch(function(e) {
      log("bpm lookup failed:", e && e.message);
    });
  };

  /** Look up each new song's tempo, a moment after it starts. */
  function watch() {
    var bpmLookedUpFor = null;
    deps.db().ref("songToPlay").on("value", function(snap) {
      var s = snap.val();
      if (!s || !s.started || s.started === bpmLookedUpFor) return;
      bpmLookedUpFor = s.started;
      setTimeout(function() { findBpm(s); }, 500); // let the song settle first
    });
  }

  return { setSongBpm: setSongBpm, findBpm: findBpm, watch: watch };
}

module.exports = { BPM_MIN: BPM_MIN, BPM_MAX: BPM_MAX, bpmKey: bpmKey, normalizeForMatch: normalizeForMatch, looselyMatches: looselyMatches, deezerBpm: deezerBpm, createTempo: createTempo };
