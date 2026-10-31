#!/usr/bin/env node
// The room's play history toolkit. Run from the bot's folder:
//   npm run history -- <command> [options]
// See tools/history/README.md.
"use strict";
var fs = require("fs");
var path = require("path");
var store = require("./store");
var sources = require("./sources");
var reconcile = require("./reconcile");
var report = require("./report");
var publish = require("./publish");
var verify = require("./verify");
var genres = require("./genres");
var archive = require("./archive");
var tags = require("../../lib/tags");

var ROOT = path.join(__dirname, "..", "..");
var HELP = `play history: join ADAM, Last.fm and the room's database into one history

  npm run history -- <command> [options]

getting the data in
  import-adam <file.csv|link> [more]  optional: an ADAM CSV export, one per sheet (TRAX, plays, ...); a Google
        Sheets link to a tab works if it's shared as "anyone with the link"
        [--kind tracks|plays|raws|artists|djs]   if it can't tell from the columns
        [--archive]   keep a copy in the room's database, so any rebuild (e.g. the GitHub Action) has it
  fetch-firebase [--only globalTracks,songHistory,...]   read the room's database as the bot, ADAM's
        moved history included (globalTracks, globalTrackRaws, globalArtists, globalDjs)
  undo-tags [--run <id>] [--write]    put back the upload tags the latest publish (or that run) changed;
        uploads retagged since are left alone. With publish --off, the room is back as it was
  genres [--artists 5000] [--tracks 3000] [--discogs 1200]   each played track's genres: Last.fm tags of
        its artists and itself, Discogs styles (DISCOGS_TOKEN), SoundCloud's genre; most played first,
        each asked once. genre-map.csv turns tags into the room's genres (refresh does this too)
  check-artists [--max-quota 3000]    look up on YouTube Music the artists whose accents the logs
        disagree on (100 quota units each, most played first; refresh does this too). reconcile after
  probe [path ...]                    how each path is laid out (fields and kinds of values, no data)
  import-firebase <export.json>       or a Firebase console export instead
  fetch-lastfm [--user a,b]           every scrobble (default LASTFM_USERNAME); later runs fetch only new ones
  import-lastfm <file.csv> [--user name]   or a CSV export of scrobbles
  enrich [--limit 3000]               ask Last.fm how it spells the most-played artists
  verify-uploads [--limit N] [--recheck-days 90] [--max-quota 3000]
        ask YouTube/SoundCloud what each upload is, and if it still exists (YouTube quota is
        shared with the bot: at most --max-quota units per run, so the room never runs short)

making sense of it
  reconcile [--window 10] [--adam-tz auto|America/Chicago|-6] [--accent-min 2]
        --accent-min: how many logs must write a name or word with its accents
        before it's restored (a trusted source counts on its own)
  report                              summary.md and CSVs in the data folder
  review apply <review.csv>           save your merge/separate answers, then reconcile again
  lookup "Artist - Title"             what the history knows about one song
  status                              what's been imported

using it
  publish [--write] [--restore-accents] [--retag] [--tidy junk|rsn] [--min-confidence 0.9] [--review-limit 300]
        --tidy junk: take out upload junk (Official Video, HD, Visualizer, | text, - Topic...)
        --tidy rsn:  also lay tags out in Rohn Standard Notation (feat., versions in parentheses)
        both write each artist one way everywhere, and skip tags a mod fixed or tag-exceptions.csv lists
        refuses when the history got worse (fewer tracks or plays than last time, mass retags,
        tracks joining many artists); --force sends it anyway
  publish --off                       switch the bot back to the old counts
  refresh [--publish]                 fetch-firebase + fetch-lastfm + verify-uploads + reconcile + report (+ publish --write)

options
  --dir <folder>   where the database and reports live (default: history-data/ in the bot's folder)
`;

function parseArgs(argv) {
  var out = { _: [] };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a.slice(0, 2) === "--") {
      var eq = a.indexOf("=");
      var k = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-([a-z])/g, function(m, c) { return c.toUpperCase(); });
      if (eq !== -1) out[k] = a.slice(eq + 1);
      else if (argv[i + 1] != null && argv[i + 1].slice(0, 2) !== "--") out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function loadEnv() {
  var env = Object.assign({}, process.env);
  var file = path.join(ROOT, ".env");
  if (fs.existsSync(file) && typeof process.loadEnvFile === "function") {
    var before = Object.assign({}, process.env);
    process.loadEnvFile(file);
    Object.keys(process.env).forEach(function(k) { if (!(k in before)) env[k] = process.env[k]; });
  }
  return env;
}

function log(s) { console.log(s); }

async function main() {
  var args = parseArgs(process.argv.slice(2));
  var cmd = args._.shift();
  if (!cmd || cmd === "help" || args.help) { console.log(HELP); return; }
  var dir = path.resolve(args.dir || path.join(ROOT, "history-data"));
  var env = loadEnv();
  var db = store.open(dir);
  var t0 = Date.now();

  switch (cmd) {
    case "import-adam": {
      if (!args._.length) throw new Error("which file? import-adam <file.csv or link>");
      for (var f of args._) {
        var input = await archive.fetchInput(f, dir);
        var r = await sources.importAdam(db, input.file, args.kind, log);
        log(input.name + ": " + r.rows + " rows read, " + r.written + " observations" + (r.skipped ? ", " + r.skipped + " empty rows skipped" : ""));
        if (args.archive) {
          var saved = await archive.saveFile(require("./firebase").client(env), input.name, input.file, r.kind);
          // this copy is already imported: don't restore it again
          store.setState(db, saved.stateKey, true);
          log("  kept a copy in the room's database (historyArchive), so the history can be rebuilt anywhere");
        }
        if (input.file !== f) require("fs").unlinkSync(input.file);
      }
      break;
    }
    case "import-firebase": {
      if (!args._[0]) throw new Error("which file? import-firebase <export.json>");
      log(JSON.stringify(sources.importFirebaseFile(db, args._[0], log)));
      break;
    }
    case "probe":
      await sources.probeFirebase(env, args._.length ? args._ : ["globalTracks", "globalTrackRaws", "globalArtists", "globalDjs", "songHistory", "playLog", "tagLog"], log);
      break;
    case "fetch-firebase":
      log(JSON.stringify(await sources.fetchFirebase(db, env, { only: args.only, dir: dir }, log)));
      break;
    case "fetch-lastfm": {
      var users = String(args.user || env.LASTFM_USERNAME || "").split(",").filter(Boolean);
      if (!users.length) throw new Error("which Last.fm user? set LASTFM_USERNAME or pass --user");
      for (var u of users) log(u + ": " + (await sources.fetchLastfm(db, env.LASTFM_APIKEY, u, log)) + " scrobbles in the history");
      break;
    }
    case "import-lastfm": {
      if (!args._[0]) throw new Error("which file? import-lastfm <file.csv>");
      var res = await sources.importLastfmCsv(db, args._[0], args.user || env.LASTFM_USERNAME, log);
      log(res.rows + " rows, " + res.written + " scrobbles" + (res.skipped ? ", " + res.skipped + " unreadable rows skipped" : ""));
      break;
    }
    case "verify-uploads":
      await verify.verifyUploads(db, env, { limit: args.limit, recheckDays: args.recheckDays, maxQuota: args.maxQuota }, log);
      break;
    case "undo-tags":
      await publish.undoTags(env, { run: args.run, write: !!args.write }, log);
      break;
    case "genres":
      await genres.fetchLastfmTags(db, env.LASTFM_APIKEY, { artists: args.artists, tracks: args.tracks }, log);
      await genres.fetchDiscogs(db, env.DISCOGS_TOKEN, { discogs: args.discogs }, log);
      genres.assignGenres(db, dir, log);
      break;
    case "check-artists":
      await verify.checkArtists(db, env, { maxQuota: args.maxQuota }, log);
      break;
    case "enrich":
      await sources.enrichArtists(db, env.LASTFM_APIKEY, Number(args.limit) || 3000, log);
      break;
    case "reconcile":
      reconcile.reconcile(db, { dir: dir, window: Number(args.window) || 10, adamTz: args.adamTz || "auto", accentMin: args.accentMin, log: log });
      break;
    case "report":
      report.report(db, dir, log);
      break;
    case "review": {
      var sub = args._.shift();
      if (sub === "apply") {
        if (!args._[0]) throw new Error("which file? review apply <review.csv>");
        await report.applyReview(db, args._[0], log);
      } else {
        var n = report.exportReview(db, path.join(dir, "review.csv"));
        log(n + " to look at in " + path.join(dir, "review.csv"));
      }
      break;
    }
    case "publish":
      await publish.publish(db, env, {
        dir: dir, write: !!args.write, off: !!args.off, retag: !!args.retag, restoreAccents: !!args.restoreAccents,
        minConfidence: args.minConfidence, existing: args.existing, reviewLimit: args.reviewLimit, force: !!args.force, tidy: args.tidy
      }, log);
      break;
    case "refresh": {
      log("== room database");
      await sources.fetchFirebase(db, env, { dir: dir }, log);
      if (env.LASTFM_APIKEY && env.LASTFM_USERNAME) {
        log("== Last.fm");
        await sources.fetchLastfm(db, env.LASTFM_APIKEY, env.LASTFM_USERNAME, log);
      }
      log("== uploads");
      var checked = await verify.verifyUploads(db, env, { maxQuota: args.maxQuota }, log);
      log("== reconcile");
      var rec = { dir: dir, window: Number(args.window) || 10, adamTz: args.adamTz || "auto", accentMin: args.accentMin, log: log };
      reconcile.reconcile(db, rec);
      // artists whose accents the logs disagree on, looked up on YouTube Music
      // with the quota left; when any were, reconcile again with the answers
      var artists = await verify.checkArtists(db, env, { maxQuota: args.maxQuota, quotaUsed: checked && checked.quotaUsed }, log);
      if (artists.checked) { log("== reconcile (with YouTube Music's answers)"); reconcile.reconcile(db, rec); }
      log("== genres");
      await genres.fetchLastfmTags(db, env.LASTFM_APIKEY, {}, log);
      await genres.fetchDiscogs(db, env.DISCOGS_TOKEN, {}, log);
      genres.assignGenres(db, dir, log);
      report.report(db, dir, log);
      if (args.publish) {
        log("== publish");
        await publish.publish(db, env, { dir: dir, write: true, restoreAccents: !!args.restoreAccents, retag: !!args.retag, minConfidence: args.minConfidence, reviewLimit: args.reviewLimit, force: !!args.force, tidy: args.tidy }, log);
      }
      break;
    }
    case "lookup": {
      var q = args._.join(" ");
      var p = tags.parse(q, null);
      var k = tags.keysOf(p);
      log("reads as: " + tags.format(p) + "\n  key: " + k.track + (p.weak ? "  (too vague to match on)" : ""));
      var v = db.prepare("SELECT track_id FROM variants WHERE track_key = ? LIMIT 1").get(k.track) ||
        db.prepare("SELECT id track_id FROM tracks WHERE keys LIKE ? LIMIT 1").get('%"' + k.track.replace(/[%_]/g, "") + '"%') ||
        db.prepare("SELECT track_id FROM variants WHERE song_key = ? LIMIT 1").get(k.song);
      if (!v) { log("  not in the history (run reconcile?)"); break; }
      var t = db.prepare("SELECT * FROM tracks WHERE id = ?").get(v.track_id);
      var iso = function(ms) { return ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?"; };
      log("track " + t.id + ": " + t.artist + " - " + t.title);
      log("  " + t.plays + " plays (" + t.scrobbles + " on Last.fm), " + t.djs + " DJs, " + t.uploads + " uploads, " + t.spellings + " spellings");
      log("  first: " + iso(t.first_play_at) + " by " + (t.first_play_dj || "unknown") + (t.first_dj && t.first_dj !== t.first_play_dj ? " (first known DJ: " + t.first_dj + ", " + iso(t.first_dj_at) + ")" : ""));
      log("  last:  " + iso(t.last_play_at) + " by " + (t.last_play_dj || "unknown"));
      var gRow = db.prepare("SELECT name FROM sqlite_master WHERE name = 'track_genres'").get() && db.prepare("SELECT genres, why FROM track_genres WHERE track_id = ?").get(t.id);
      if (gRow && JSON.parse(gRow.genres).length) log("  genres: " + JSON.parse(gRow.genres).join(", ") + "  (" + gRow.why + ")");
      db.prepare("SELECT artist, title, seen, scrobbles, sources FROM variants WHERE track_id = ? ORDER BY seen DESC LIMIT 25").all(t.id).forEach(function(r) {
        log("    " + String(r.seen).padStart(6) + "×  " + r.artist + " - " + r.title + "  [" + r.sources + "]");
      });
      var s = db.prepare("SELECT * FROM songs WHERE id = ?").get(t.song_id);
      if (s && s.versions > 1) {
        log("  all " + s.versions + " versions: " + s.plays + " plays");
        db.prepare("SELECT artist, title, plays FROM tracks WHERE song_id = ? ORDER BY plays DESC").all(s.id).forEach(function(r) { log("    " + String(r.plays).padStart(6) + "  " + r.artist + " - " + r.title); });
      }
      break;
    }
    case "status": {
      var rows = db.prepare("SELECT source, count(*) n, sum(role='play') plays, min(at) f, max(at) l FROM obs GROUP BY source ORDER BY source").all();
      if (!rows.length) log("nothing imported yet in " + dir);
      rows.forEach(function(r) {
        log(r.source.padEnd(22) + String(r.n).padStart(10) + " rows" + String(r.plays || 0).padStart(10) + " plays   " +
          (r.f ? new Date(r.f).toISOString().slice(0, 10) + " → " + new Date(r.l).toISOString().slice(0, 10) : ""));
      });
      var st = store.getState(db, "reconcile");
      if (st) log("last reconcile: " + new Date(st.at).toISOString() + " (" + st.seconds + "s)");
      var d = db.prepare("SELECT count(*) n FROM decisions").get().n;
      if (d) log(d + " review answers saved");
      break;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
  if (Date.now() - t0 > 5000) log("done in " + Math.round((Date.now() - t0) / 1000) + "s");
  db.close();
}

main().catch(function(e) {
  console.error("error: " + (e && e.message || e));
  process.exitCode = 1;
});
