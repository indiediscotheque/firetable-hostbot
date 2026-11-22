// Import a list of songs (the site's redesign step 1.20): someone pastes
// "Artist - Title" lines or uploads a CSV; the site asks the bot to find each
// song, shows what it found, and adds the ones they keep to a playlist.
//
//   importJobs/<uid>/<job> = {items: [{a, t, d?}], format, at, status: "new"}
//       written by the site (a: artist, t: title, d: length in seconds;
//       format: the playlist's, "ytm" YouTube Music, "video" YouTube videos,
//       "sc" SoundCloud). The bot sets status "working", then "done" (or
//       "failed" with a note), n (songs answered so far) and
//       results/<i> = {s, picks: [{type, cid, artist, title, dur?, kind?, src, img?, url?}]}
//       s: what the first pick is: "room" (an upload the room has played),
//       "song" (a YouTube Music audio track), "video", "sc" (SoundCloud),
//       "none" (nothing found) or "later" (not looked up yet: the day's
//       searches ran out). picks: best first, at most four.
//
// Where songs come from, free first:
//   1. the room's own uploads of the song (globalSongKeys, any spelling the
//      play history knows), checked they still play here (videos.list: 1
//      unit per 50). SoundCloud lists take the room's SoundCloud uploads.
//   2. the swap search's lookup (lib/swaps.js): the year playlists, YouTube
//      Music, people's playlists and YouTube's search, no quota; YouTube Music
//      lists get audio tracks first, video lists the artist's own videos.
//   3. SoundCloud lists: SoundCloud's search.
// One job at a time, in the order they came; the site deletes a job when
// it's done with it, and the bot clears any left after a day.
"use strict";

var tags = require("./tags");
var swaps = require("./swaps");

var MAX_ITEMS = 500;
var CHUNK = 10; // songs answered per write, so the site fills in as it goes
var MAX_PICKS = 4;
var DAY = 24 * 60 * 60 * 1000;
var JOB_ID = /^[A-Za-z0-9_-]{1,40}$/;
var YT_ID = /^[A-Za-z0-9_-]{11}$/;
var SC_ID = /^[0-9]{1,20}$/;

/** The items a job asked for, cleaned: [{a, t, d, name}] (at most MAX_ITEMS). */
function itemsOf(job) {
  var raw = job && job.items;
  var list = Array.isArray(raw) ? raw : raw && typeof raw === "object"
    ? Object.keys(raw).sort(function(x, y) { return Number(x) - Number(y); }).map(function(k) { return raw[k]; }) : [];
  return list.slice(0, MAX_ITEMS).map(function(it) {
    var a = String((it && it.a) || "").trim().slice(0, 300);
    var t = String((it && it.t) || "").trim().slice(0, 300);
    var d = Number(it && it.d);
    return { a: a, t: t, d: d > 0 && d <= 86400 ? Math.round(d) : 0, name: a ? a + " - " + t : t };
  });
}

/** A pick as saved in results: only what the site shows and adds. */
function savedPick(p) {
  var out = { type: p.type, cid: String(p.cid), artist: String(p.artist || "").slice(0, 300), title: String(p.title || "").slice(0, 300), src: p.src };
  if (p.dur) out.dur = Math.round(Number(p.dur)) || 0;
  if (p.kind) out.kind = p.kind;
  if (p.plays) out.plays = Number(p.plays) || 0;
  if (p.channel) out.channel = String(p.channel).slice(0, 200);
  if (/^https:\/\//.test(p.img || "")) out.img = String(p.img).slice(0, 2048);
  if (/^https:\/\/soundcloud\.com\//.test(p.url || "")) out.url = String(p.url).slice(0, 2048);
  return out;
}

/** What a result's first pick is ("room", "song", "video", "sc"), or "none". */
function statusOf(picks) {
  var p = picks[0];
  if (!p) return "none";
  if (p.src === "room") return "room";
  if (p.type === 2) return "sc";
  return p.kind === "a" ? "song" : "video";
}

/**
 * @param {Object} deps
 *   db: firebase.database()
 *   lookup(items, opts) -> Promise<{picks, looked}>   (swapper.lookup)
 *   verify(cids) -> Promise<{cid: {problem, audio, dur, channel}}>   (videos.list; a missing id is gone)
 *   scSearch(query) -> Promise<[{cid, title, user, dur, url, img, problem}]>   (optional)
 *   log(...), now() -> ms
 */
function createImports(deps) {
  var log = deps.log || function() {};
  var now = deps.now || Date.now;
  var db = deps.db;
  var queue = [];
  var queued = {};
  var busy = null;
  var started = false;

  // ---- 1. the room's own uploads of a song, latest played first
  var roomUploads = function(item) {
    var p = tags.parse(item.a, item.t);
    if (p.weak || !p.title || !p.artists.length) return Promise.resolve(null);
    var hash = tags.hash(tags.keysOf(p).track);
    return db.ref("globalSongKeys/" + hash).once("value").then(function(s) {
      var id = s.val();
      if (!id || typeof id !== "string") return null;
      return Promise.all([
        db.ref("globalSongs/" + id).once("value").then(function(x) { return x.val() || {}; }),
        db.ref("globalTracks").orderByChild("song").equalTo(id).limitToFirst(25).once("value")
      ]).then(function(got) {
        var song = got[0];
        var ups = [];
        got[1].forEach(function(c) {
          var v = c.val() || {};
          var type = c.key.charAt(0) === "2" ? 2 : c.key.charAt(0) === "1" ? 1 : 0;
          var cid = c.key.slice(1);
          if (type === 1 && !YT_ID.test(cid)) return;
          if (type === 2 && !SC_ID.test(cid)) return;
          if (!type) return;
          ups.push({ type: type, cid: cid, at: Number(v.last_play_date) || 0 });
        });
        ups.sort(function(x, y) { return y.at - x.at; });
        return { id: id, artist: String(song.artist || item.a), title: String(song.title || item.t), plays: Number(song.plays) || 0, uploads: ups };
      });
    }, function() { return null; });
  };

  // which YouTube uploads still play here, and whether each is an audio track
  var playable = function(cids) {
    var out = {};
    if (!cids.length || !deps.verify) return Promise.resolve(out);
    var batches = [];
    for (var i = 0; i < cids.length; i += 50) batches.push(cids.slice(i, i + 50));
    return batches.reduce(function(p, b) {
      return p.then(function() {
        return deps.verify(b).then(function(found) {
          b.forEach(function(cid) {
            var v = found && found[cid];
            if (v && typeof v === "object" && !v.problem) out[cid] = v;
          });
        }, function(err) { log("imports: couldn't check uploads (" + (err && err.message) + ")"); });
      });
    }, Promise.resolve()).then(function() { return out; });
  };

  var scFor = function(item) {
    if (!deps.scSearch) return Promise.resolve([]);
    var q = swaps.queryFor(item.name);
    if (!q) return Promise.resolve([]);
    return deps.scSearch(q).then(function(rows) {
      return swaps.scMatches({ name: item.name, dur: item.d }, rows).map(function(r) {
        return { type: 2, cid: r.cid, artist: r.artist, title: r.title, dur: r.dur, url: r.url, img: r.img, kind: "sc", src: "sc" };
      });
    }, function() { return []; });
  };

  /** Answer some songs: [{s, picks}] in their order. */
  var answer = function(items, format) {
    var rooms;
    return Promise.all(items.map(roomUploads)).then(function(r) {
      rooms = r;
      if (format === "sc") return {};
      var cids = [];
      rooms.forEach(function(room) {
        if (!room) return;
        room.uploads.filter(function(u) { return u.type === 1; }).slice(0, 2).forEach(function(u) { cids.push(u.cid); });
      });
      return playable(cids);
    }).then(function(ok) {
      var picks = items.map(function() { return []; });
      var need = []; // items the free search looks up
      items.forEach(function(item, i) {
        var room = rooms[i];
        var mine = [];
        if (room) {
          room.uploads.forEach(function(u) {
            if (format === "sc" ? u.type !== 2 : u.type !== 1) return;
            if (u.type === 1 && !ok[u.cid]) return;
            var info = ok[u.cid] || {};
            mine.push({ type: u.type, cid: u.cid, artist: room.artist, title: room.title, dur: info.dur || item.d,
              kind: u.type === 2 ? "sc" : info.audio ? "a" : "v", plays: room.plays, src: "room" });
          });
        }
        // a list kept to videos never takes an audio track
        mine = mine.filter(function(m) { return format !== "video" || m.kind !== "a"; }).slice(0, 1);
        // the room's upload is the answer when it's the kind the list takes
        var fits = mine[0] && (format === "sc" || (format === "video" ? mine[0].kind === "v" : mine[0].kind === "a"));
        picks[i] = mine;
        if (!fits) need.push({ i: i, uploads: room ? room.uploads.filter(function(u) { return u.type === 1; }).slice(0, 3) : [] });
      });
      if (!need.length) return picks;
      if (format === "sc") {
        return need.reduce(function(p, n) {
          return p.then(function() { return scFor(items[n.i]).then(function(found) { picks[n.i] = picks[n.i].concat(found); }); });
        }, Promise.resolve()).then(function() { return picks; });
      }
      var asks = need.map(function(n) {
        var it = { name: items[n.i].name, audio: format !== "video" };
        if (items[n.i].d) it.dur = items[n.i].d;
        if (n.uploads.length) it.uploads = n.uploads.map(function(u) { return { type: 1, cid: u.cid }; });
        return it;
      });
      return Promise.resolve(deps.lookup(asks, { maxSearches: asks.length * 3 })).then(function(res) {
        need.forEach(function(n, j) {
          var found = ((res && res.picks && res.picks[j]) || []).map(function(pk) {
            return { type: 1, cid: pk.cid, artist: pk.artist, title: pk.title, dur: pk.dur, kind: pk.audio ? "a" : "v", channel: pk.channel, src: pk.src || "ytm" };
          }).filter(function(pk) { return format === "video" ? pk.kind === "v" : true; });
          // the kind the list takes first; the room's own upload stays a choice
          picks[n.i] = found.concat(picks[n.i]);
          if (!picks[n.i].length && res && res.looked && res.looked[j] === false) picks[n.i].later = true;
        });
        return picks;
      }, function(err) {
        log("imports: the lookup failed (" + (err && err.message) + ")");
        need.forEach(function(n) { if (!picks[n.i].length) picks[n.i].later = true; });
        return picks;
      });
    }).then(function(picks) {
      return picks.map(function(list) {
        var seen = {};
        var clean = list.filter(function(p) {
          var k = p.type + ":" + p.cid;
          if (seen[k]) return false;
          seen[k] = true;
          return true;
        }).slice(0, MAX_PICKS).map(savedPick);
        return { s: clean.length ? statusOf(clean) : list.later ? "later" : "none", picks: clean };
      });
    });
  };

  var jobPath = function(uid, id) { return "importJobs/" + uid + "/" + id; };

  var runJob = function(uid, id) {
    var path = jobPath(uid, id);
    var ref = db.ref(path);
    return ref.once("value").then(function(snap) {
      var job = snap.val();
      if (!job || job.status !== "new") return null;
      var items = itemsOf(job);
      var format = /^(ytm|video|sc)$/.test(job.format) ? job.format : "ytm";
      var stats = { songs: items.length, found: 0, room: 0, later: 0 };
      var started = now();
      return ref.update({ status: "working", n: 0 }).then(function() {
        var chunks = [];
        for (var i = 0; i < items.length; i += CHUNK) chunks.push(i);
        var gone = false;
        return chunks.reduce(function(p, from) {
          return p.then(function() {
            if (gone) return;
            return answer(items.slice(from, from + CHUNK), format).then(function(results) {
              var upd = {};
              results.forEach(function(r, j) {
                upd["results/" + (from + j)] = r;
                if (r.picks.length) stats.found++;
                if (r.s === "room") stats.room++;
                if (r.s === "later") stats.later++;
              });
              upd.n = from + results.length;
              // the site deleted the job (cancelled): stop there
              return db.ref(path + "/status").once("value").then(function(s) {
                if (s.val() !== "working") { gone = true; return; }
                return ref.update(upd);
              });
            });
          });
        }, Promise.resolve()).then(function() {
          if (gone) { log("imports: " + uid + "'s import was cancelled"); return null; }
          log("imports: " + stats.found + " of " + stats.songs + " songs found for " + uid + " (" + stats.room + " played here" +
            (stats.later ? ", " + stats.later + " for later" : "") + ") in " + Math.round((now() - started) / 1000) + "s");
          return ref.update({ status: "done" }).then(function() { return stats; });
        });
      });
    }).catch(function(err) {
      log("imports: " + uid + "'s import failed: " + (err && err.message));
      return db.ref(path + "/status").once("value").then(function(s) {
        if (s.val() === null) return null;
        return ref.update({ status: "failed", note: "The bot couldn't look these up. Try again later." }).catch(function() {});
      }).then(function() { return null; });
    });
  };

  var next = function() {
    if (busy || !queue.length) return busy;
    var j = queue.shift();
    busy = runJob(j.uid, j.id).then(function(res) {
      delete queued[j.uid + "/" + j.id];
      busy = null;
      next();
      return res;
    });
    return busy;
  };

  var sawUser = function(snap) {
    var uid = snap.key;
    var jobs = snap.val() || {};
    Object.keys(jobs).forEach(function(id) {
      var job = jobs[id];
      if (!JOB_ID.test(id) || !job || job.status !== "new" || queued[uid + "/" + id]) return;
      queued[uid + "/" + id] = true;
      queue.push({ uid: uid, id: id });
    });
    next();
  };

  // jobs a site left behind (closed mid-way) go after a day
  var prune = function() {
    var cutoff = now() - DAY;
    return db.ref("importJobs").once("value").then(function(snap) {
      var upd = {};
      snap.forEach(function(u) {
        u.forEach(function(j) {
          var at = Number(j.val() && j.val().at) || 0;
          if (at < cutoff) upd[u.key + "/" + j.key] = null;
        });
      });
      var n = Object.keys(upd).length;
      if (!n) return 0;
      return db.ref("importJobs").update(upd).then(function() { log("imports: cleared " + n + " old import(s)"); return n; });
    }, function() { return 0; });
  };

  return {
    /** Follow importJobs/ (and clear old ones now and every few hours). */
    start: function() {
      if (started) return;
      started = true;
      var ref = db.ref("importJobs");
      ref.on("child_added", sawUser, function(err) {
        log("imports: can't read importJobs/ (deploy firebase-rules.json): " + (err && err.message));
      });
      ref.on("child_changed", sawUser);
      prune();
      var t = setInterval(prune, 6 * 60 * 60 * 1000);
      if (t && t.unref) t.unref();
    },
    /** The job running now (tests): a promise, or null. */
    idle: function() { return busy || Promise.resolve(null); },
    answer: answer,
    runJob: runJob,
    prune: prune
  };
}

module.exports = { createImports: createImports, itemsOf: itemsOf, statusOf: statusOf, MAX_ITEMS: MAX_ITEMS };
