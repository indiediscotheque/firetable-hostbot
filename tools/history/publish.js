// Publish the reconciled history to the room's database, where the bot uses
// it for every song it plays: true first plays, our own play counts, and every
// known spelling and upload of a song pointing at the same track.
//
//   globalSongs/<track>      artist, title, version, work, plays, first/last play
//   globalWorks/<song>       every version of a song together: plays, first play
//   globalSongKeys/<key>     any known spelling's key -> track (lib/tags.js)
//   globalWorkKeys/<key>     song key -> song
//   globalTracks/<upload>/song   which track each upload is
//   globalSongsMeta          ready: true switches the bot over (--off undoes it)
//
// Without --write nothing is sent: it says what it would do and saves the
// list to publish-preview.json.
"use strict";
var fs = require("fs");
var path = require("path");
var fb = require("./firebase");
var tags = require("../../lib/tags");

async function publish(db, env, opts, log) {
  var minConf = opts.minConfidence == null ? 0.9 : Number(opts.minConfidence);
  var c = opts.write || opts.off ? fb.client(env) : null;

  if (opts.off) {
    await c.update({ "globalSongsMeta/ready": false });
    log("the bot is back on Last.fm counts and per-upload first plays (globalSongsMeta/ready = false)");
    return { off: true };
  }

  // keep the ids the room already has, so links never break between runs
  var existingSongKeys = {};
  var existingWorkKeys = {};
  if (opts.write) {
    log("reading the ids already in the room's database...");
    existingSongKeys = (await c.get("globalSongKeys")) || {};
    existingWorkKeys = (await c.get("globalWorkKeys")) || {};
  } else if (opts.existing) {
    var ex = JSON.parse(fs.readFileSync(opts.existing, "utf8"));
    existingSongKeys = ex.globalSongKeys || {};
    existingWorkKeys = ex.globalWorkKeys || {};
  }

  var updates = {};
  var counts = { tracks: 0, songs: 0, keys: 0, links: 0, retags: 0, accents: 0, skippedUnsure: 0 };
  var trackIdMap = new Map();
  var workIdMap = new Map();
  var workKeysOf = new Map();
  db.prepare("SELECT id, keys FROM songs").all().forEach(function(s) { workKeysOf.set(s.id, JSON.parse(s.keys || "[]")); });

  function stableId(keys, existing, fallback) {
    var votes = new Map();
    keys.forEach(function(k) { var id = existing[tags.hash(k)]; if (id) votes.set(id, (votes.get(id) || 0) + 1); });
    var best = fallback;
    var n = 0;
    votes.forEach(function(v, id) { if (v > n) { n = v; best = id; } });
    return best;
  }

  db.prepare("SELECT id FROM songs").all().forEach(function(s) {
    workIdMap.set(s.id, stableId(workKeysOf.get(s.id), existingWorkKeys, s.id));
  });

  for (var t of db.prepare("SELECT * FROM tracks WHERE confidence > 0").iterate()) {
    if (t.confidence < minConf) { counts.skippedUnsure++; continue; }
    var keys = JSON.parse(t.keys || "[]");
    var id = stableId(keys, existingSongKeys, t.id);
    trackIdMap.set(t.id, id);
    var work = workIdMap.get(t.song_id) || t.song_id;
    var base = "globalSongs/" + id + "/";
    set(updates, base + "artist", t.artist);
    set(updates, base + "title", t.title);
    set(updates, base + "version", t.version || null);
    set(updates, base + "work", work);
    set(updates, base + "plays", t.plays || 0);
    set(updates, base + "first_play_date", t.first_play_at);
    set(updates, base + "first_play_dj", t.first_play_dj);
    set(updates, base + "last_play_date", t.last_play_at);
    set(updates, base + "last_play_dj", t.last_play_dj);
    set(updates, base + "uploads", t.uploads || 0);
    counts.tracks++;
    keys.forEach(function(k) { updates["globalSongKeys/" + tags.hash(k)] = id; counts.keys++; });
  }

  db.prepare("SELECT * FROM songs").all().forEach(function(s) {
    var wid = workIdMap.get(s.id);
    var base = "globalWorks/" + wid + "/";
    set(updates, base + "artist", s.artist);
    set(updates, base + "title", s.title);
    set(updates, base + "plays", s.plays || 0);
    set(updates, base + "versions", s.versions || 1);
    set(updates, base + "first_play_date", s.first_play_at);
    set(updates, base + "first_play_dj", s.first_play_dj);
    workKeysOf.get(s.id).forEach(function(k) { updates["globalWorkKeys/" + tags.hash(k)] = wid; });
    counts.songs++;
  });

  var preview = [];
  for (var u of db.prepare(`SELECT u.*, t.artist ta, t.title tt, t.confidence FROM uploads u JOIN tracks t ON t.id = u.track_id`).iterate()) {
    var tid = trackIdMap.get(u.track_id);
    if (!tid) continue;
    var up = "globalTracks/" + u.type + u.cid + "/";
    updates[up + "song"] = tid;
    counts.links++;
    if (u.artist == null) continue; // never played: no room tags to change
    var current = u.artist + " - " + u.title;
    var wanted = u.ta + " - " + u.tt;
    if (current === wanted) continue;
    var accentOnly = tags.fold(current) === tags.fold(wanted) || skeletonOf(wanted) === tags.squash(current);
    if (opts.retag || (opts.restoreAccents && accentOnly)) {
      updates[up + "artist"] = u.ta;
      updates[up + "title"] = u.tt;
      counts[accentOnly ? "accents" : "retags"]++;
      preview.push({ upload: u.type + u.cid, from: current, to: wanted, accentsOnly: accentOnly });
    }
  }
  // questions for the mods (!review in chat), most useful first; answered ones
  // came back in with fetch-firebase and aren't asked again
  var existingReview = opts.write ? ((await c.get("tagReview")) || {}) : {};
  var nextN = 0;
  Object.keys(existingReview).forEach(function(k) { nextN = Math.max(nextN, Number(existingReview[k] && existingReview[k].n) || 0); });
  var order = { "room-tag-vs-upload": 0, "upload-tagged-two-ways": 1, "same-isrc-different-tags": 2, "similar-title": 3, "similar-artist": 4 };
  var questions = db.prepare("SELECT * FROM review").all()
    .sort(function(a, b) { return (order[a.kind] == null ? 9 : order[a.kind]) - (order[b.kind] == null ? 9 : order[b.kind]) || b.score - a.score; })
    .slice(0, Number(opts.reviewLimit) || 300);
  var keep = new Set();
  questions.forEach(function(q) {
    var id = tags.hash(q.a < q.b ? q.a + "|" + q.b : q.b + "|" + q.a);
    keep.add(id);
    var old = existingReview[id];
    if (old && old.decision) return;
    var base = "tagReview/" + id + "/";
    updates[base + "n"] = old && old.n ? old.n : ++nextN;
    updates[base + "a"] = q.a_label;
    updates[base + "b"] = q.b_label;
    updates[base + "a_key"] = q.a;
    updates[base + "b_key"] = q.b;
    updates[base + "why"] = q.evidence ? String(q.evidence).slice(0, 200) : q.kind.replace(/-/g, " ");
    counts.questions = (counts.questions || 0) + 1;
  });
  Object.keys(existingReview).forEach(function(id) { if (!keep.has(id)) updates["tagReview/" + id] = null; });

  // every review answer, kept with the room's data so a rebuild anywhere has them
  if (opts.write) Object.assign(updates, require("./archive").decisionUpdates(db));

  var totals = db.prepare("SELECT count(*) tracks, coalesce(sum(plays), 0) plays FROM tracks WHERE confidence > 0").get();
  counts.plays = totals.plays;
  updates["globalSongsMeta/ready"] = true;
  updates["globalSongsMeta/published_at"] = opts.write ? { ".sv": "timestamp" } : Date.now();
  updates["globalSongsMeta/tracks"] = counts.tracks;
  updates["globalSongsMeta/songs"] = counts.songs;
  updates["globalSongsMeta/plays"] = counts.plays;

  // safety checks: a run that lost data (a source that failed to download, a
  // matching change gone wrong) must never replace a better history
  var previous = opts.write ? ((await c.get("globalSongsMeta")) || {}) : (opts.previous || {});
  var problems = checks(counts, previous, db);
  counts.checks = problems.length ? problems : "passed";
  var paths = Object.keys(updates);
  log("would write " + paths.length.toLocaleString("en-US") + " values: " + JSON.stringify(counts));
  problems.forEach(function(p) { log("  check failed: " + p); });
  if (!opts.write) {
    var file = path.join(opts.dir, "publish-preview.json");
    fs.writeFileSync(file, JSON.stringify({ counts: counts, tagChanges: preview, sample: paths.slice(0, 200).map(function(p) { return [p, updates[p]]; }) }, null, 1));
    log("nothing sent (add --write to publish). Preview: " + file);
    return counts;
  }
  if (problems.length && !opts.force) {
    var err = new Error("not published: " + problems.join("; ") + ". Look at the reports; publish --write --force sends it anyway.");
    err.checks = problems;
    throw err;
  }

  // ready goes last, so the bot only switches over once everything is there
  var ready = { "globalSongsMeta/ready": true, "globalSongsMeta/published_at": { ".sv": "timestamp" }, "globalSongsMeta/tracks": counts.tracks, "globalSongsMeta/songs": counts.songs, "globalSongsMeta/plays": counts.plays };
  paths = paths.filter(function(p) { return p.indexOf("globalSongsMeta/") !== 0; });
  var size = 2500;
  for (var i = 0; i < paths.length; i += size) {
    var chunk = {};
    paths.slice(i, i + size).forEach(function(p) { chunk[p] = updates[p]; });
    await c.update(chunk);
    if ((i / size) % 20 === 0) log("  " + Math.min(i + size, paths.length).toLocaleString("en-US") + " / " + paths.length.toLocaleString("en-US"));
  }
  await c.update(ready);
  log("published. The bot now shows true first plays and the room's own play counts (undo with: publish --off)");
  return counts;
}

function checks(counts, previous, db) {
  var problems = [];
  if (!counts.tracks || !counts.plays) problems.push("the history is empty");
  if (previous.tracks && counts.tracks < previous.tracks * 0.9) {
    problems.push("tracks fell from " + previous.tracks + " to " + counts.tracks + " (more than 10%)");
  }
  if (previous.plays && counts.plays < previous.plays * 0.95) {
    problems.push("plays fell from " + previous.plays + " to " + counts.plays + " (a source probably didn't download)");
  }
  var uploads = db.prepare("SELECT count(*) n FROM uploads WHERE artist IS NOT NULL").get().n;
  if (counts.retags > Math.max(50, uploads * 0.1)) problems.push(counts.retags + " tag changes is more than 10% of the room's uploads");
  var crowded = db.prepare("SELECT count(*) n FROM review WHERE kind = 'too-many-artists-in-one-track'").get().n;
  if (crowded > Math.max(10, counts.tracks * 0.002)) problems.push(crowded + " tracks joined too many different artists (a matching problem)");
  return problems;
}

function set(updates, p, v) { updates[p] = v == null || v === "" ? null : v; }
function skeletonOf(s) { return tags.squash(String(s).replace(/[^\x00-\x7F]|\?/g, "")); }

module.exports = { publish: publish };
