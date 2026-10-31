// Swap suggestions for tracks that can't play: for each flagged track in
// anyone's playlists, find the same recording on YouTube Music (its audio
// tracks only, never music videos or "Official Audio" uploads), check it can
// play here, and save it with the track as `swap`. The site shows a swap
// button on the track (and "Swap all" for the list); nothing changes in a
// playlist until its owner says so.
//
// Cost: YouTube Music searches use no API quota (lib/ytmusic.js). The checks
// that a match can play here are one YouTube Data API call (1 unit) per 50
// matches, with the same rules the bot uses before every song (lib/checks.js).
"use strict";

var tags = require("./tags");

// Flag codes worth a swap: gone / private / blocked / not embeddable / age
// restricted (1–7), broken (8) and low audio quality (9). Off-theme (10) isn't.
var SWAP_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
var DAY = 24 * 60 * 60 * 1000;
var CACHE_DAYS = 30; // re-search a song after this long (found or not)
var RECHECK_DAYS = 7; // re-check a saved suggestion still plays after this long
var DISMISS_DAYS = 90; // "not this one" holds this long

// ------------------------------------------------------------- matching

/** The search for a track name: "Artist Title feat. X (Y Remix)". */
function queryFor(name) {
  var p = tags.parse(name);
  if (p.weak || !p.title || !p.artists.length) return null;
  return tags.format(p).replace(" - ", " ");
}

/** The cache id for a track name: one per recording, all spellings together. */
function cacheId(name) {
  return tags.hash(tags.trackKey(name));
}

function keySet(list) {
  return list.map(tags.artistKeyOf).filter(Boolean);
}

/**
 * The YouTube Music songs that are the same recording as `name`, best first.
 * Same title, same version (a remix never stands in for the original, live
 * never for studio) and the same artists (featured artists may sit in either
 * field). Length within 15% (or 20 seconds) when both are known.
 * @param {string} name - "Artist - Title"
 * @param {Array} songs - from ytmusic.searchSongs
 * @param {{dur?: number}} [opts] - the original's length in seconds
 * @returns {Array} matching songs, best first
 */
function rankMatches(name, songs, opts) {
  opts = opts || {};
  var p = tags.parse(name);
  if (p.weak || !p.title) return [];
  var k = tags.keysOf(p);
  var titleKeys = [k.title].concat(p.altTitles.map(tags.titleKeyOf));
  var origMain = keySet(p.artists);
  var origAll = origMain.concat(keySet(p.featured));
  var wantClean = /\bclean\b/i.test(name);
  var out = [];
  songs.forEach(function(s, rank) {
    var sp = tags.parse(s.artist || "", s.title || "");
    var sk = tags.keysOf(sp);
    if (titleKeys.indexOf(sk.title) === -1 || sk.version !== k.version) return;
    var candMain = keySet(sp.artists);
    var candAll = candMain.concat(keySet(sp.featured));
    if (!origMain.length || !candMain.length) return;
    var origInCand = origMain.every(function(a) { return candAll.indexOf(a) !== -1; });
    var candInOrig = candMain.every(function(a) { return origAll.indexOf(a) !== -1; });
    if (!origInCand && !candInOrig) return;
    var score = 10 - rank * 0.25;
    if (sk.artist === k.artist) score += 3;
    else if (origInCand && candInOrig) score += 2;
    if (opts.dur && s.dur) {
      var diff = Math.abs(opts.dur - s.dur);
      if (diff > Math.max(20, opts.dur * 0.15)) return;
      score += diff <= 3 ? 2 : diff <= 10 ? 1 : 0;
    }
    // the album version, unless the tag asks for the clean one
    if (s.explicit !== wantClean) score += wantClean ? 3 : 0.5;
    out.push({ song: s, score: score });
  });
  out.sort(function(a, b) { return b.score - a.score; });
  return out.map(function(x) { return x.song; });
}

/** A song as saved with a track (`swap`) or in the cache: only what the site shows. */
function pickOf(s) {
  var out = { cid: String(s.cid), artist: String(s.artist || "").slice(0, 500), title: String(s.title || "").slice(0, 500) };
  if (s.album) out.album = String(s.album).slice(0, 500);
  if (s.dur) out.dur = Number(s.dur) || 0;
  if (s.explicit) out.explicit = true;
  return out;
}

/** The original's length in seconds, if the track has one saved. */
function trackSeconds(t) {
  var v = Number(t && (t.duration || t.length || t.dur || t.seconds)) || 0;
  if (!v && t && (t.msecs || t.ms)) v = Number(t.msecs || t.ms) / 1000;
  if (v > 36000) v = v / 1000; // saved in ms
  return Math.round(v);
}

// ---------------------------------------------------------------- runner
//
// What a night costs, and how it's kept down:
//   - people: only those seen since their last scan (swapScans/<uid>), plus
//     anyone never scanned. Lists of people who haven't been around don't
//     change (new flags come from playing a track or opening a list).
//   - database reads: only the flagged tracks of each list (an indexed query
//     on flagged/date), never whole playlists. Without the index (rules not
//     published) the run stops instead of downloading every list.
//   - YouTube Music: one search per song, shared by every copy and spelling,
//     remembered for 30 days (swapCache), paced, capped per night.
//   - YouTube Data API: matches confirmed within 7 days aren't re-checked;
//     the best match is checked first and the next one only if it fails;
//     50 per call (1 unit). A night is typically 0–5 units of 10,000.

/**
 * @param {Object} deps
 *   db: firebase.database()
 *   shallowKeys(path) -> Promise<string[]>
 *   flagged(ref) -> Promise<[{key, track}]>       (optional; rejects with err.noIndex when the index is missing)
 *   search(query) -> Promise<{songs, any}>        (ytmusic.searchSongs)
 *   verify(cids) -> Promise<{cid: problemCode}>   (videos.list, ≤50 ids; rejects when YouTube can't answer)
 *   notify(uid, txt, opts)
 *   users() -> the room's users map; botid() -> the bot's uid
 *   log(...), now() -> ms
 *   maxSearches, delayMs: per run
 */
function createSwapper(deps) {
  var log = deps.log || function() {};
  var now = deps.now || Date.now;
  var wait = deps.wait || function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var memCache = {};
  var memScans = {};
  var writable = { swapCache: true, swapScans: true };
  var state = { running: false, last: null, startedAt: 0 };

  var refused = function(path, err) {
    if (/permission/i.test((err && (err.code || err.message)) || "") && writable[path]) {
      writable[path] = false;
      log("swaps: the database rules don't have " + path + " yet (publish firebase-rules.json); keeping it in memory until restart.");
    }
  };
  var readCache = function(id) {
    if (memCache[id]) return Promise.resolve(memCache[id]);
    return deps.db.ref("swapCache/" + id).once("value").then(function(s) { return s.val(); }, function() { return null; });
  };
  var writeCache = function(id, val) {
    memCache[id] = val;
    if (!writable.swapCache) return Promise.resolve();
    return deps.db.ref("swapCache/" + id).set(val).catch(function(err) { refused("swapCache", err); });
  };
  var readScans = function() {
    return deps.db.ref("swapScans").once("value").then(function(s) {
      return Object.assign({}, s.val() || {}, memScans);
    }, function() { return Object.assign({}, memScans); });
  };
  var writeScans = function(updates) {
    Object.assign(memScans, updates);
    if (!writable.swapScans || !Object.keys(updates).length) return Promise.resolve();
    return deps.db.ref("swapScans").update(updates).catch(function(err) { refused("swapScans", err); });
  };

  // When someone was last around: now if they're in the room, else when
  // they last went idle or came back.
  var lastSeen = function(u, t) {
    if (!u) return 0;
    if (u.status) return t;
    return Number(u.idle && u.idle.since) || 0;
  };

  // Every list to look through: [{uid, ref}], for the people who need it,
  // most recently seen first (they get the searches first when a run hits its
  // limit). The rules let the bot read each person's lists, not all of
  // queues/ or playlists/ at once.
  var listsToScan = function(t, full, stats) {
    var db = deps.db;
    var users = (deps.users && deps.users()) || {};
    return readScans().then(function(scans) {
      var uids = Object.keys(users).filter(function(uid) {
        // seen since (an hour before) the last scan, or never scanned
        return full || !scans[uid] || lastSeen(users[uid], t) > Number(scans[uid]) - 60 * 60 * 1000;
      }).sort(function(a, b) { return lastSeen(users[b], t) - lastSeen(users[a], t); });
      stats.skippedPeople = Object.keys(users).length - uids.length;
      var lists = [];
      return uids.reduce(function(p, uid) {
        return p.then(function() {
          lists.push({ uid: uid, ref: db.ref("queues/" + uid) });
          return deps.shallowKeys("playlists/" + uid).then(function(ids) {
            ids.forEach(function(id) { lists.push({ uid: uid, ref: db.ref("playlists/" + uid + "/" + id + "/list") }); });
          }, function() {});
        });
      }, Promise.resolve()).then(function() { return { lists: lists, uids: uids }; });
    });
  };

  // The flagged tracks of one list: [{key, track}]
  var flaggedIn = function(ref, keys) {
    if (keys) {
      return Promise.all(keys.map(function(k) {
        return ref.child(k).once("value").then(function(s) { return { key: k, track: s.val() }; });
      }));
    }
    if (deps.flagged) return deps.flagged(ref);
    return ref.orderByChild("flagged/date").startAt(1).once("value").then(function(snap) {
      var out = [];
      snap.forEach(function(c) { out.push({ key: c.key, track: c.val() }); });
      return out;
    });
  };

  // Save (or clear) a suggestion on one track, only if it's still the same
  // flagged track (a list can be reordered or edited meanwhile).
  var saveSwap = function(ref, key, cid, swap) {
    var added = false;
    return ref.child(key).transaction(function(cur) {
      added = false;
      if (cur === null) return null; // not loaded yet (Firebase asks again with the real value), or gone
      if (String(cur.cid) !== String(cid) || !cur.flagged) return; // changed meanwhile: leave it
      if (swap === null) {
        if (!cur.swap || cur.swap.dismissed) return;
        delete cur.swap;
        return cur;
      }
      if (cur.swap && cur.swap.cid === swap.cid && !cur.swap.dismissed) {
        cur.swap.date = swap.date; // re-checked
        return cur;
      }
      if (cur.swap && cur.swap.dismissed === swap.cid) return;
      added = true;
      cur.swap = swap;
      return cur;
    }, null, false).then(function(r) { return r.committed && added; }, function(err) {
      log("swaps: couldn't save a suggestion:", err.message);
      return false;
    });
  };

  /**
   * Look through lists for flagged tracks and suggest swaps.
   * @param {{lists?: Array<{uid, ref, keys?}>, full?: boolean, quiet?: boolean, reason?: string}} [opts]
   *   lists: only these (keys: only these tracks); default: everyone who needs it
   *   full: everyone, whether or not they've been around since their last scan
   *   quiet: no notices to people
   */
  var run = function(opts) {
    opts = opts || {};
    if (state.running) return Promise.resolve(null);
    state.running = true;
    state.startedAt = now();
    var t = now();
    var stats = { lists: 0, flagged: 0, songs: 0, searched: 0, cached: 0, found: 0, suggested: 0, rechecked: 0, removed: 0,
      people: 0, units: 0, skippedPeople: 0, stopped: "" };
    var jobs = {}; // cache id -> {id, name, query, dur, tracks, picks}
    var rechecks = []; // {uid, ref, key, cid, swapCid}
    var perUser = {};
    var incomplete = {}; // uid -> true when something of theirs waits for another night
    var scanned = [];

    var gather = opts.lists ? Promise.resolve({ lists: opts.lists, uids: [] }) : listsToScan(t, opts.full, stats);
    return gather.then(function(found) {
      scanned = found.uids;
      stats.lists = found.lists.length;
      // one list at a time: keeps the bot's memory and the database calm
      return found.lists.reduce(function(p, l) {
        return p.then(function() {
          if (stats.stopped) return;
          return flaggedIn(l.ref, l.keys).then(function(items) {
            items.forEach(function(it) {
              var tr = it.track;
              if (!tr || !tr.flagged || SWAP_CODES.indexOf(Number(tr.flagged.code)) === -1 || !tr.cid || !tr.name) return;
              stats.flagged++;
              var sw = tr.swap;
              if (sw && sw.dismissed && t - (Number(sw.date) || 0) < DISMISS_DAYS * DAY) return;
              if (sw && sw.cid && !sw.dismissed) {
                if (t - (Number(sw.date) || 0) > RECHECK_DAYS * DAY) rechecks.push({ uid: l.uid, ref: l.ref, key: it.key, cid: tr.cid, swapCid: sw.cid });
                return;
              }
              var query = queryFor(tr.name);
              if (!query) return;
              var id = cacheId(tr.name);
              var job = jobs[id] || (jobs[id] = { id: id, name: tr.name, query: query, dur: 0, tracks: [] });
              if (!job.dur) job.dur = trackSeconds(tr);
              job.tracks.push({ uid: l.uid, ref: l.ref, key: it.key, cid: tr.cid, type: tr.type, dismissed: sw && sw.dismissed });
            });
          }, function(err) {
            if (err && err.noIndex) {
              stats.stopped = "the database has no index on flagged/date yet (publish firebase-rules.json); not reading whole playlists without it";
              return;
            }
            incomplete[l.uid] = true;
            log("swaps: couldn't read a list:", err && err.message);
          });
        });
      }, Promise.resolve());
    }).then(function() {
      var ids = Object.keys(jobs);
      stats.songs = ids.length;
      var misses = 0; // searches in a row with no songs of any kind
      var errors = 0;
      // remembered answers first, then searches (paced) for the rest
      return ids.reduce(function(p, id) {
        return p.then(function() {
          var job = jobs[id];
          return readCache(id).then(function(c) {
            if (c && t - (Number(c.date) || 0) < CACHE_DAYS * DAY) {
              stats.cached++;
              job.picks = c.picks || [];
              job.cache = c;
              return;
            }
            if (stats.stopped) return;
            if (stats.searched >= (deps.maxSearches || 300)) { stats.stopped = "search limit for this run (the rest wait for the next one)"; return; }
            return (stats.searched ? wait(deps.delayMs == null ? 2500 : deps.delayMs) : Promise.resolve()).then(function() {
              stats.searched++;
              return deps.search(job.query);
            }).then(function(res) {
              errors = 0;
              misses = res.any ? 0 : misses + 1;
              if (misses >= 5) stats.stopped = "YouTube Music returned nothing for 5 searches in a row";
              if (!res.songs.length && !res.any) return; // nothing at all: don't remember that as "no match"
              job.picks = rankMatches(job.name, res.songs, { dur: job.dur }).slice(0, 3).map(pickOf);
              job.cache = { q: job.query.slice(0, 500), date: t, picks: job.picks };
              return writeCache(id, job.cache);
            }, function(err) {
              errors++;
              log("swaps: YouTube Music search failed:", err.message);
              if (errors >= 3 || err.status === 429) stats.stopped = "YouTube Music isn't answering (" + err.message + ")";
            });
          });
        });
      }, Promise.resolve());
    }).then(function() {
      // Can the matches play here? Known answers from the last 7 days count;
      // the rest are checked best match first, the next only if that fails.
      var problems = {};
      var fresh = function(pk) { return pk.ok && t - pk.ok < RECHECK_DAYS * DAY; };
      Object.keys(jobs).forEach(function(id) {
        (jobs[id].picks || []).forEach(function(pk) {
          if (fresh(pk)) problems[pk.cid] = 0;
          else if (pk.bad && t - pk.bad < RECHECK_DAYS * DAY) problems[pk.cid] = 2;
        });
      });
      var check = function(cids) {
        var todo = cids.filter(function(c, i) { return !(c in problems) && cids.indexOf(c) === i; });
        var batches = [];
        for (var i = 0; i < todo.length; i += 50) batches.push(todo.slice(i, i + 50));
        return batches.reduce(function(p, batch) {
          return p.then(function() {
            if (stats.verifyFailed) return;
            stats.units++;
            return deps.verify(batch).then(function(res) {
              batch.forEach(function(cid) { problems[cid] = res[cid] == null ? 2 : res[cid]; });
            }, function(err) {
              stats.verifyFailed = true;
              log("swaps: couldn't check matches on YouTube (they wait for the next run):", err.message);
            });
          });
        }, Promise.resolve());
      };
      // the n-th choice of every song still without a playable one
      var round = function(n) {
        var cids = [];
        Object.keys(jobs).forEach(function(id) {
          var picks = jobs[id].picks || [];
          var settled = picks.slice(0, n).some(function(pk) { return problems[pk.cid] === 0; });
          if (!settled && picks[n]) cids.push(picks[n].cid);
        });
        return cids;
      };
      var rounds = Promise.resolve();
      [0, 1, 2].forEach(function(n) {
        rounds = rounds.then(function() {
          // the older suggestions due a re-check ride along with the first round
          return check(n ? round(n) : round(0).concat(rechecks.map(function(r) { return r.swapCid; })));
        });
      });
      return rounds.then(function() {
        // remember what was learned, so the next nights don't ask again
        var saves = [];
        Object.keys(jobs).forEach(function(id) {
          var job = jobs[id];
          if (!job.cache || !job.picks || !job.picks.length) return;
          var changed = false;
          job.picks.forEach(function(pk) {
            if (problems[pk.cid] === 0 && !fresh(pk)) { pk.ok = t; delete pk.bad; changed = true; }
            else if (problems[pk.cid] > 0 && pk.bad !== t && !(pk.bad && t - pk.bad < RECHECK_DAYS * DAY)) { pk.bad = t; delete pk.ok; changed = true; }
          });
          if (changed) saves.push(writeCache(id, job.cache));
        });
        return Promise.all(saves);
      }).then(function() { return problems; });
    }).then(function(problems) {
      var writes = [];
      Object.keys(jobs).forEach(function(id) {
        var job = jobs[id];
        job.tracks.forEach(function(tk) {
          if (!job.picks) { incomplete[tk.uid] = true; return; } // not searched yet
          var usable = job.picks.filter(function(pk) {
            return !(tk.type == 1 && pk.cid === String(tk.cid)) && pk.cid !== tk.dismissed;
          });
          var pick = usable.filter(function(pk) { return problems[pk.cid] === 0; })[0];
          if (!pick) {
            // a match YouTube couldn't check yet: try again next night
            if (usable.some(function(pk) { return !(pk.cid in problems); })) incomplete[tk.uid] = true;
            return;
          }
          stats.found++;
          var saved = { date: t };
          Object.keys(pick).forEach(function(k) { if (k !== "ok" && k !== "bad") saved[k] = pick[k]; });
          writes.push(saveSwap(tk.ref, tk.key, tk.cid, saved).then(function(added) {
            if (!added) return;
            stats.suggested++;
            perUser[tk.uid] = (perUser[tk.uid] || 0) + 1;
          }));
        });
      });
      rechecks.forEach(function(r) {
        if (!(r.swapCid in problems)) { incomplete[r.uid] = true; return; } // couldn't check: leave it
        stats.rechecked++;
        var ok = problems[r.swapCid] === 0;
        writes.push(saveSwap(r.ref, r.key, r.cid, ok ? { cid: r.swapCid, date: t } : null).then(function(changed) {
          if (!ok) stats.removed++;
          return changed;
        }));
      });
      return Promise.all(writes);
    }).then(function() {
      // everyone whose lists are fully dealt with waits until they're next seen
      var done = {};
      if (!stats.stopped || /search limit/.test(stats.stopped)) {
        scanned.forEach(function(uid) { if (!incomplete[uid]) done[uid] = t; });
      }
      return writeScans(done);
    }).then(function() {
      var bot = deps.botid && deps.botid();
      var people = Object.keys(perUser);
      stats.people = people.length;
      if (!opts.quiet) {
        people.forEach(function(uid) {
          if (uid === bot) return;
          var n = perUser[uid];
          deps.notify(uid, (n === 1 ? "A broken track in your playlists has" : n + " broken tracks in your playlists have") +
            " a working copy on YouTube Music. Look for ⇄ on " + (n === 1 ? "it" : "them") + " to swap it in, or use Swap all.", { kind: "swap", ttl: 20 * 60 * 60 });
        });
      }
      stats.ms = now() - state.startedAt;
      stats.reason = opts.reason || "";
      stats.at = now();
      if (!opts.lists) state.last = stats;
      log("swaps: " + summary(stats));
      return stats;
    }).then(function(s) {
      state.running = false;
      return s;
    }, function(err) {
      state.running = false;
      log("swaps: run failed:", err && err.message);
      return null;
    });
  };

  return {
    run: run,
    /** One track the bot just flagged: look it up now (one search). */
    track: function(uid, ref, key) {
      if (state.running) return Promise.resolve(null);
      return run({ lists: [{ uid: uid, ref: ref, keys: [key] }], quiet: true, reason: "flagged" });
    },
    state: state
  };
}

function summary(s) {
  if (!s) return "no swap search has run yet.";
  var out = s.flagged + " flagged " + (s.flagged === 1 ? "track" : "tracks") + " in " + s.lists + (s.lists === 1 ? " list" : " lists") +
    ", " + s.songs + (s.songs === 1 ? " song" : " songs") + " (" + s.searched + " searched, " + s.cached + " remembered)" +
    ", " + s.suggested + " new " + (s.suggested === 1 ? "swap" : "swaps") + " for " + s.people + (s.people === 1 ? " person" : " people");
  if (s.removed) out += ", " + s.removed + " old " + (s.removed === 1 ? "swap" : "swaps") + " no longer play";
  out += "; " + (s.units || 0) + " YouTube API " + (s.units === 1 ? "unit" : "units");
  if (s.skippedPeople) out += "; " + s.skippedPeople + (s.skippedPeople === 1 ? " person" : " people") + " not seen since their last scan skipped";
  if (s.stopped) out += "; stopped early: " + s.stopped;
  if (s.verifyFailed) out += "; YouTube couldn't check the matches, so they wait for the next run";
  return out + ".";
}

module.exports = {
  createSwapper: createSwapper,
  rankMatches: rankMatches,
  queryFor: queryFor,
  cacheId: cacheId,
  trackSeconds: trackSeconds,
  pickOf: pickOf,
  summary: summary,
  SWAP_CODES: SWAP_CODES
};
