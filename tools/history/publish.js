// Publish the reconciled history to the room's database, where the bot uses
// it for every song it plays: true first plays, our own play counts, and every
// known spelling and upload of a song pointing at the same track.
//
//   globalSongs/<track>      artist, title, version, work, plays, first/last play
//   globalWorks/<song>       every version of a song together: plays, first play
//   globalSongKeys/<key>     any known spelling's key -> track (lib/tags.js)
//   globalWorkKeys/<key>     song key -> song
//   globalTracks/<upload>/song   which track each upload is
//   globalSongsMeta          ready: true switches the bot over (--off undoes it);
//                            genres/<genre> {name, tracks, plays} and
//                            byGenre/<genre>/<track> = plays, for browsing
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

  // genres (tools/history/genres.js), when they've been worked out
  var genresOf = new Map();
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'track_genres'").get()) {
    db.prepare("SELECT track_id, genres FROM track_genres").all().forEach(function(r) { genresOf.set(r.track_id, JSON.parse(r.genres)); });
  }
  var genreIndex = new Map(); // slug -> {name, tracks: {id: plays}, plays, n}
  var songGenres = new Map(); // song id -> Map(genre -> weight)
  var genreSlug = function(g) { return String(g).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); };

  db.prepare("SELECT id FROM songs").all().forEach(function(s) {
    workIdMap.set(s.id, stableId(workKeysOf.get(s.id), existingWorkKeys, s.id));
  });

  // --tidy junk|rsn: the tags each track is shown with (never for tags a
  // person chose, or ones in tag-exceptions.csv)
  var shown = new Map();
  var level = opts.tidy === "junk" || opts.tidy === "rsn" ? opts.tidy : null;
  if (opts.tidy && !level) throw new Error("--tidy is junk or rsn");
  for (var t of db.prepare("SELECT * FROM tracks WHERE confidence > 0").iterate()) {
    if (t.confidence < minConf) { counts.skippedUnsure++; continue; }
    var keys = JSON.parse(t.keys || "[]");
    var id = stableId(keys, existingSongKeys, t.id);
    trackIdMap.set(t.id, id);
    var work = workIdMap.get(t.song_id) || t.song_id;
    var show = { a: t.artist, t: t.title };
    if (level && !t.protected && t["tidy_" + level]) {
      var td = JSON.parse(t["tidy_" + level]);
      if (td.a && td.t && (td.a !== t.artist || td.t !== t.title)) { show = td; counts.tidied = (counts.tidied || 0) + 1; }
    }
    shown.set(t.id, show);
    var base = "globalSongs/" + id + "/";
    set(updates, base + "artist", show.a);
    set(updates, base + "title", show.t);
    set(updates, base + "version", t.version || null);
    set(updates, base + "work", work);
    set(updates, base + "plays", t.plays || 0);
    set(updates, base + "first_play_date", t.first_play_at);
    set(updates, base + "first_play_dj", t.first_play_dj);
    set(updates, base + "last_play_date", t.last_play_at);
    set(updates, base + "last_play_dj", t.last_play_dj);
    set(updates, base + "uploads", t.uploads || 0);
    var gs = genresOf.get(t.id) || [];
    set(updates, base + "genres", gs.length ? gs : null);
    gs.forEach(function(g, i) {
      var sl = genreSlug(g);
      if (!genreIndex.has(sl)) genreIndex.set(sl, { name: g, tracks: {}, plays: 0, n: 0 });
      var gi = genreIndex.get(sl);
      gi.tracks[id] = t.plays || 0;
      gi.plays += t.plays || 0;
      gi.n++;
      // a song's genres: its versions' genres, by plays
      if (!songGenres.has(t.song_id)) songGenres.set(t.song_id, new Map());
      var sg = songGenres.get(t.song_id);
      sg.set(g, (sg.get(g) || 0) + (t.plays || 0) * (3 - i));
    });
    if (gs.length) counts.withGenres = (counts.withGenres || 0) + 1;
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
    var sgm = songGenres.get(s.id);
    set(updates, base + "genres", sgm ? Array.from(sgm.entries()).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3).map(function(e) { return e[0]; }) : null);
    workKeysOf.get(s.id).forEach(function(k) { updates["globalWorkKeys/" + tags.hash(k)] = wid; });
    counts.songs++;
  });

  // the genre index; a genre gone since the last publish leaves it
  genreIndex.forEach(function(gi, sl) {
    updates["globalSongsMeta/genres/" + sl] = { name: gi.name, tracks: gi.n, plays: gi.plays };
    updates["globalSongsMeta/byGenre/" + sl] = gi.tracks;
  });
  counts.genres = genreIndex.size;
  if (opts.write) {
    Object.keys((await c.get("globalSongsMeta/genres", { shallow: "true" })) || {}).forEach(function(sl) {
      if (genreIndex.has(sl)) return;
      updates["globalSongsMeta/genres/" + sl] = null;
      updates["globalSongsMeta/byGenre/" + sl] = null;
    });
  }

  var preview = [];
  var tagBackup = {}; // upload -> its tags before and after, to undo with undo-tags
  for (var u of db.prepare(`SELECT u.*, t.artist ta, t.title tt, t.confidence FROM uploads u JOIN tracks t ON t.id = u.track_id`).iterate()) {
    var tid = trackIdMap.get(u.track_id);
    if (!tid) continue;
    var up = "globalTracks/" + u.type + u.cid + "/";
    updates[up + "song"] = tid;
    counts.links++;
    if (u.artist == null) continue; // never played: no room tags to change
    var sh = shown.get(u.track_id);
    var tidied = sh.a !== u.ta || sh.t !== u.tt;
    var current = u.artist + " - " + u.title;
    var wanted = sh.a + " - " + sh.t;
    if (current === wanted) continue;
    var accentOnly = tags.fold(current) === tags.fold(wanted) || skeletonOf(wanted) === tags.squash(current);
    if (opts.retag || tidied || (opts.restoreAccents && accentOnly)) {
      // the rules take an upload's artist and title as text of 500 characters
      // at most: a story pasted in as a title stays as it is
      if (!fits(sh.a) || !fits(sh.t)) { counts.tooLong = (counts.tooLong || 0) + 1; continue; }
      updates[up + "artist"] = sh.a;
      updates[up + "title"] = sh.t;
      tagBackup[u.type + "" + u.cid] = { a: u.artist, t: u.title || "", na: sh.a, nt: sh.t };
      var kind = accentOnly ? "accents" : tidied && !opts.retag ? "tidiedUploads" : "retags";
      counts[kind] = (counts[kind] || 0) + 1;
      preview.push({ upload: u.type + u.cid, from: current, to: wanted, why: accentOnly ? "accents" : tidied ? "tidy " + level : "best spelling" });
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

  // every upload tag this run changes, as it was: kept in the room's database
  // first, so `undo-tags` can put them back (historyArchive is the bot's own)
  var runId = String(Date.now());
  var backupKeys = Object.keys(tagBackup);
  var backupUpdates = {};
  backupKeys.forEach(function(k) { backupUpdates["historyArchive/tagBackups/" + runId + "/" + k] = tagBackup[k]; });
  await writeAll(c, backupUpdates, log);
  await c.update({ ["historyArchive/tagBackupRuns/" + runId]: { at: { ".sv": "timestamp" }, uploads: backupKeys.length } });
  log("  " + backupKeys.length + " upload tags backed up (undo with: undo-tags)");

  // ready goes last, so the bot only switches over once everything is there
  var ready = { "globalSongsMeta/ready": true, "globalSongsMeta/published_at": { ".sv": "timestamp" }, "globalSongsMeta/tracks": counts.tracks, "globalSongsMeta/songs": counts.songs, "globalSongsMeta/plays": counts.plays };
  paths = paths.filter(function(p) { return !(p in ready); });
  var rest = {};
  paths.forEach(function(p) { rest[p] = updates[p]; });
  var skipped = await writeAll(c, rest, log, true);
  await c.update(ready);
  if (skipped.length) log("  " + skipped.length + " values the database refused were left out: " + skipped.slice(0, 10).join(", ") + (skipped.length > 10 ? ", ..." : ""));
  log("published. The bot now shows true first plays and the room's own play counts (undo with: publish --off)");
  return counts;
}

// Put back the upload tags a publish changed (the latest, or --run <id>).
// An upload someone has retagged since keeps its new tags.
async function undoTags(env, opts, log) {
  var c = fb.client(env);
  var runs = (await c.get("historyArchive/tagBackupRuns")) || {};
  var ids = Object.keys(runs).sort();
  // one run (--run), or every one not undone yet, newest first: a publish
  // that stopped half way and its re-run are undone together
  var todo = opts.run ? [String(opts.run)] : ids.filter(function(id) { return !runs[id].undone; }).reverse();
  if (opts.run && !runs[opts.run]) throw new Error(ids.length ? "no backup " + opts.run + "; there are: " + ids.join(", ") : "no tag backups yet: nothing to undo");
  if (!todo.length) throw new Error(ids.length ? "every publish is undone already" : "no tag backups yet: nothing to undo");
  var now = {};
  await c.getPaged("globalTracks", 20000, function(page) { Object.assign(now, page); });
  var total = { restored: 0, kept: 0 };
  for (var r = 0; r < todo.length; r++) {
    var id = todo[r];
    var backup = (await c.get("historyArchive/tagBackups/" + id)) || {};
    var updates = {};
    var restored = 0;
    var kept = 0;
    Object.keys(backup).forEach(function(up) {
      var b = backup[up];
      var cur = now[up] || {};
      if ((cur.artist || "") !== (b.na || "") || (cur.title || "") !== (b.nt || "")) { kept++; return; }
      updates["globalTracks/" + up + "/artist"] = b.a;
      updates["globalTracks/" + up + "/title"] = b.t;
      // what the next (older) run compares with
      now[up] = Object.assign({}, cur, { artist: b.a, title: b.t });
      restored++;
    });
    log(restored + " upload tags " + (opts.write ? "put back" : "would be put back") + " from the publish of " + new Date(Number(id)).toISOString() +
      "; " + kept + " changed since (left as they are)");
    total.restored += restored;
    total.kept += kept;
    if (opts.write) {
      await writeAll(c, updates, log);
      await c.update({ ["historyArchive/tagBackupRuns/" + id + "/undone"]: { ".sv": "timestamp" } });
    }
  }
  if (!opts.write) log("nothing sent (add --write)");
  return total;
}

// Writes many values in batches. The database takes a batch whole or not at
// all, so a refused batch is split until the refused values are found; those
// are left out (and returned) and the rest is written.
async function writeAll(c, updates, log, progress) {
  var paths = Object.keys(updates);
  var skipped = [];
  async function send(list) {
    var chunk = {};
    list.forEach(function(p) { chunk[p] = updates[p]; });
    try {
      await c.update(chunk);
    } catch (e) {
      if (!e.denied && !e.refused) throw e;
      if (list.length === 1) { skipped.push(list[0]); return; }
      var half = Math.ceil(list.length / 2);
      await send(list.slice(0, half));
      await send(list.slice(half));
    }
  }
  var size = 2500;
  for (var i = 0; i < paths.length; i += size) {
    await send(paths.slice(i, i + size));
    if (progress && (i / size) % 20 === 0) log("  " + Math.min(i + size, paths.length).toLocaleString("en-US") + " / " + paths.length.toLocaleString("en-US"));
  }
  return skipped;
}
function fits(v) { return typeof v === "string" && v.length <= 500; }

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

module.exports = { publish: publish, undoTags: undoTags };
