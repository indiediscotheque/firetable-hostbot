// Reports from the last reconcile: a summary you can read, CSVs you can
// open in a spreadsheet, and review.csv for the calls only a person can make.
"use strict";
var fs = require("fs");
var path = require("path");
var csv = require("./csv");
var store = require("./store");
var tags = require("../../lib/tags");
var genresLib = require("./genres");

function iso(ms) { return ms == null ? "" : new Date(ms).toISOString().replace("T", " ").slice(0, 16); }

function report(db, dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  var files = {};
  var st = store.getState(db, "reconcile");
  if (!st) throw new Error("run reconcile first");

  files["tracks.csv"] = csv.writeCsv(path.join(dir, "tracks.csv"),
    ["id", "artist", "title", "version", "plays", "scrobbles", "djs", "first_play", "first_play_dj", "first_known_dj", "first_known_dj_at", "last_play", "last_play_dj", "uploads", "spellings", "confidence", "song_id"],
    db.prepare("SELECT * FROM tracks ORDER BY plays DESC").iterate().map(function(t) {
      return [t.id, t.artist, t.title, t.version, t.plays, t.scrobbles, t.djs, iso(t.first_play_at), t.first_play_dj, t.first_dj, iso(t.first_dj_at), iso(t.last_play_at), t.last_play_dj, t.uploads, t.spellings, t.confidence, t.song_id];
    }));

  files["songs.csv"] = csv.writeCsv(path.join(dir, "songs.csv"),
    ["id", "artist", "title", "versions", "plays", "first_play", "first_play_dj", "last_play", "last_play_dj"],
    db.prepare("SELECT * FROM songs ORDER BY plays DESC").iterate().map(function(s) {
      return [s.id, s.artist, s.title, s.versions, s.plays, iso(s.first_play_at), s.first_play_dj, iso(s.last_play_at), s.last_play_dj];
    }));

  // every spelling ever seen and the track it belongs to: the tag-fix map
  files["spellings.csv"] = csv.writeCsv(path.join(dir, "spellings.csv"),
    ["spelling", "track_artist", "track_title", "track_id", "seen", "plays", "scrobbles", "sources", "vague", "spreadsheet_damage"],
    db.prepare(`SELECT v.*, t.artist ta, t.title tt FROM variants v LEFT JOIN tracks t ON t.id = v.track_id ORDER BY t.plays DESC, v.seen DESC`).iterate().map(function(v) {
      return [v.artist + " - " + v.title, v.ta, v.tt, v.track_id, v.seen, v.plays, v.scrobbles, v.sources, v.weak ? "yes" : "", v.suspect || ""];
    }));

  // how Last.fm's count was split: scrobbles per spelling of each track
  files["lastfm_split.csv"] = csv.writeCsv(path.join(dir, "lastfm_split.csv"),
    ["track_id", "track", "scrobbles_total", "spelling", "scrobbles_under_this_spelling"],
    db.prepare(`SELECT t.id, t.artist || ' - ' || t.title track, t.scrobbles, v.artist || ' - ' || v.title spelling, v.scrobbles vs
      FROM tracks t JOIN variants v ON v.track_id = t.id
      WHERE v.scrobbles > 0 AND t.id IN (SELECT track_id FROM variants WHERE scrobbles > 0 GROUP BY track_id HAVING count(*) > 1)
      ORDER BY t.scrobbles DESC, v.scrobbles DESC`).iterate().map(function(r) { return [r.id, r.track, r.scrobbles, r.spelling, r.vs]; }));

  // uploads whose room tags differ from the track's best spelling (what publish --retag changes)
  files["tag_fixes.csv"] = csv.writeCsv(path.join(dir, "tag_fixes.csv"),
    ["upload", "current", "suggested", "track_id", "plays"],
    db.prepare(`SELECT u.type, u.cid, u.artist ua, u.title ut, t.artist, t.title, t.id, t.plays FROM uploads u JOIN tracks t ON t.id = u.track_id
      WHERE u.artist IS NOT NULL AND (u.artist <> t.artist OR u.title <> t.title) AND t.confidence >= 0.9 ORDER BY t.plays DESC`).iterate().map(function(r) {
      return [uploadUrl(r.type, r.cid), r.ua + " - " + r.ut, r.artist + " - " + r.title, r.id, r.plays];
    }));

  // what --tidy junk / --tidy rsn would show for each track
  var titleCased = 0;
  files["tidy_preview.csv"] = csv.writeCsv(path.join(dir, "tidy_preview.csv"),
    ["track_id", "plays", "now", "tidy_junk", "tidy_rsn", "left_alone", "title_case"],
    (function* () {
      for (var t of db.prepare("SELECT id, artist, title, plays, tidy_junk, tidy_rsn, protected FROM tracks WHERE confidence > 0 ORDER BY plays DESC").iterate()) {
        var j = t.tidy_junk ? JSON.parse(t.tidy_junk) : null;
        var r = t.tidy_rsn ? JSON.parse(t.tidy_rsn) : null;
        var now = t.artist + " - " + t.title;
        var js = j ? j.a + " - " + j.t : now;
        var rs = r ? r.a + " - " + r.t : now;
        if (js === now && rs === now) continue;
        // what AP title case changed in the rsn version (English titles only)
        var plainRsn = tags.tidy(t.artist, t.title, "rsn", { titleCase: false }).title;
        var tc = r && r.t !== plainRsn ? plainRsn + " → " + r.t : "";
        if (tc && !t.protected) titleCased++;
        yield [t.id, t.plays, now, js === now ? "" : js, rs === now ? "" : rs, t.protected ? "yes (a mod's fix or tag-exceptions.csv)" : "", tc];
      }
    })());

  // Rohn Standard Notation suggestions: never applied, just for a look
  var tagsLib = require("../../lib/tags");
  files["rsn_suggestions.csv"] = csv.writeCsv(path.join(dir, "rsn_suggestions.csv"),
    ["track_id", "current", "rsn", "plays"],
    (function* () {
      for (var t of db.prepare("SELECT id, artist, title, plays FROM tracks WHERE confidence > 0 ORDER BY plays DESC").iterate()) {
        var rsn = tagsLib.format(tagsLib.parse(t.artist, t.title));
        if (rsn !== t.artist + " - " + t.title) yield [t.id, t.artist + " - " + t.title, rsn, t.plays];
      }
    })());

  // artist names the logs would put accents on, and what YouTube Music says
  var artistAccents = store.getState(db, "artist_accents") || [];
  files["artist_accents.csv"] = csv.writeCsv(path.join(dir, "artist_accents.csv"),
    ["artist", "logs_suggest", "youtube_music", "outcome", "shown_as"],
    artistAccents.map(function(a) { return [a.name, a.logs_suggest, a.youtube_music, a.outcome, a.shown_as]; }));

  // genres (tools/history/genres.js): each played track's, and every raw tag
  var genreRows = db.prepare("SELECT name FROM sqlite_master WHERE name = 'track_genres'").get() ?
    db.prepare("SELECT t.id, t.plays, t.artist, t.title, g.genres, g.why FROM track_genres g JOIN tracks t ON t.id = g.track_id ORDER BY t.plays DESC").all() : [];
  var genreCount = new Map();
  if (genreRows.length) {
    files["genres.csv"] = csv.writeCsv(path.join(dir, "genres.csv"), ["track_id", "plays", "track", "genres", "from"],
      genreRows.map(function(g) {
        var gs = JSON.parse(g.genres);
        gs.forEach(function(x) { genreCount.set(x, (genreCount.get(x) || 0) + g.plays); });
        return [g.id, g.plays, g.artist + " - " + g.title, gs.join(" | "), g.why];
      }));
    var gmap = genresLib.readGenreMap(dir);
    files["genre_tags.csv"] = csv.writeCsv(path.join(dir, "genre_tags.csv"), ["tag", "weight", "top_artists", "genre"],
      genresLib.tagWeights(db).map(function(t) { return [t.tag, t.weight, t.artists, gmap.has(t.tag) ? (gmap.get(t.tag) || "(ignored)") : ""]; }));
  }

  files["djs.csv"] = csv.writeCsv(path.join(dir, "djs.csv"),
    ["dj", "spellings_of_name", "plays", "first_plays", "tracks", "first_seen", "last_seen"],
    db.prepare("SELECT * FROM djs ORDER BY plays DESC").iterate().map(function(d) {
      return [d.name, d.aliases, d.plays, d.first_plays, d.tracks, iso(d.first_seen), iso(d.last_seen)];
    }));

  files["merges.csv"] = csv.writeCsv(path.join(dir, "merges.csv"), ["track_id", "a", "b", "reason", "score"],
    db.prepare("SELECT * FROM merges ORDER BY reason, score").iterate().map(function(m) { return [m.track_id, m.a, m.b, m.reason, m.score]; }));

  files["spreadsheet_damage.csv"] = csv.writeCsv(path.join(dir, "spreadsheet_damage.csv"), ["spelling", "damage", "track_id", "now_matched_to"],
    db.prepare(`SELECT v.artist, v.title, v.suspect, v.track_id, t.artist ta, t.title tt FROM variants v LEFT JOIN tracks t ON t.id = v.track_id WHERE v.suspect IS NOT NULL`).iterate().map(function(v) {
      return [v.artist + " - " + v.title, v.suspect, v.track_id, v.ta + " - " + v.tt];
    }));

  files["dead_uploads.csv"] = csv.writeCsv(path.join(dir, "dead_uploads.csv"), ["upload", "track", "plays", "replace_with"], require("./verify").deadUploads(db));

  files["review.csv"] = exportReview(db, path.join(dir, "review.csv"));

  // ------------------------------------------------------------- summary
  var q = function(sql) { return db.prepare(sql).get(); };
  var lines = [];
  var add = function(s) { lines.push(s == null ? "" : s); };
  add("# Play history: reconciled " + iso(st.at));
  add();
  var totals = q(`SELECT (SELECT count(*) FROM tracks) tracks, (SELECT count(*) FROM songs) songs, (SELECT count(*) FROM variants) spellings,
    (SELECT count(*) FROM uploads) uploads, (SELECT count(*) FROM plays) plays, (SELECT count(*) FROM djs) djs,
    (SELECT count(*) FROM review) review, (SELECT count(*) FROM plays WHERE dj IS NOT NULL) plays_with_dj,
    (SELECT sum(scrobbles) FROM tracks) scrobbled, (SELECT min(at) FROM plays) first, (SELECT max(at) FROM plays) last`);
  add("| | |");
  add("|---|---|");
  add("| plays | " + n(totals.plays) + " (" + pct(totals.plays_with_dj, totals.plays) + " with a known DJ, " + pct(totals.scrobbled, totals.plays) + " on Last.fm) |");
  add("| from / to | " + iso(totals.first) + " → " + iso(totals.last) + " |");
  add("| tracks (one recording, every upload and spelling) | " + n(totals.tracks) + " |");
  add("| songs (every version together) | " + n(totals.songs) + " |");
  add("| spellings joined | " + n(totals.spellings) + " |");
  add("| uploads | " + n(totals.uploads) + " |");
  add("| DJs | " + n(totals.djs) + " |");
  // st.tz: {kind: {sample, best}}; older runs saved one {sample, best}
  var tz = st.tz && st.tz.best ? { 1: st.tz } : st.tz || {};
  var zones = st.zones || { 1: st.zone };
  var clock = function(z, t) {
    return (z === 0 || z == null ? "UTC" : z) + (t ? " (" + t.best.map(function(b) { return b[0] + ": " + b[1]; }).join(", ") + " of " + t.sample + " line up)" : "");
  };
  if (tz[1] || !tz[2]) add("| ADAM clock (its exports) | " + clock(zones[1], tz[1]) + " |");
  if (tz[2]) add("| ADAM clock (moved into globalTracks) | " + clock(zones[2], tz[2]) + " |");
  add("| accents restored | " + n(st.accentFixes) + " (restore_accents.csv) |");
  if (genreRows.length) {
    var withG = genreRows.filter(function(g) { return g.genres !== "[]"; });
    var playsAll = genreRows.reduce(function(a, g) { return a + g.plays; }, 0);
    var playsG = withG.reduce(function(a, g) { return a + g.plays; }, 0);
    add("| genres | " + n(withG.length) + " of " + n(genreRows.length) + " played tracks (" + Math.round(100 * playsG / Math.max(1, playsAll)) + "% of plays); most played: " +
      Array.from(genreCount.entries()).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 6).map(function(e) { return e[0]; }).join(", ") + " (genres.csv, genre_tags.csv) |");
  }
  add("| RSN title case | " + n(titleCased) + " English titles (tidy_preview.csv, title_case) |");
  var by = function(re) { return artistAccents.filter(function(a) { return re.test(a.outcome); }).length; };
  if (artistAccents.length) add("| artist names (artist_accents.csv) | " + n(by(/^accents from YouTube/)) + " accented as YouTube Music writes them; " + n(by(/YouTube Music writes it/)) + " left plain as YouTube Music writes them; " + n(by(/until YouTube Music is checked|not found/)) + " left as they are until YouTube Music confirms |");
  add("| waiting for you | " + n(totals.review) + " (review.csv) |");
  add();
  add("## sources");
  add("| source | rows | plays | from | to |");
  add("|---|---|---|---|---|");
  db.prepare(`SELECT source, count(*) n, sum(role = 'play') p, min(at) f, max(at) l FROM obs GROUP BY source ORDER BY n DESC`).all().forEach(function(r) {
    add("| " + r.source + " | " + n(r.n) + " | " + n(r.p) + " | " + iso(r.f).slice(0, 10) + " | " + iso(r.l).slice(0, 10) + " |");
  });
  add();
  add("## how spellings were joined");
  add("| reason | joins |");
  add("|---|---|");
  db.prepare("SELECT reason, count(*) n FROM merges GROUP BY reason ORDER BY n DESC").all().forEach(function(r) { add("| " + r.reason + " | " + n(r.n) + " |"); });
  add();
  add("## most played tracks");
  add("| plays | Last.fm had it as | track | first played |");
  add("|---|---|---|---|");
  db.prepare(`SELECT t.*, (SELECT max(scrobbles) FROM variants v WHERE v.track_id = t.id) best_split FROM tracks t ORDER BY plays DESC LIMIT 40`).all().forEach(function(t) {
    add("| " + t.plays + " | " + (t.best_split || 0) + " | " + md(t.artist + " - " + t.title) + " | " + iso(t.first_play_at).slice(0, 10) + (t.first_play_dj ? " by " + md(t.first_play_dj) : "") + " |");
  });
  add();
  add("## most first plays (the DJs who brought the most songs to the room)");
  add("| DJ | first plays | plays | active |");
  add("|---|---|---|---|");
  db.prepare("SELECT * FROM djs ORDER BY first_plays DESC LIMIT 25").all().forEach(function(d) {
    add("| " + md(d.name) + " | " + n(d.first_plays) + " | " + n(d.plays) + " | " + iso(d.first_seen).slice(0, 4) + "–" + iso(d.last_seen).slice(0, 4) + " |");
  });
  add();
  add("## files");
  Object.keys(files).forEach(function(f) { add("- `" + f + "`: " + n(files[f]) + " rows"); });
  fs.writeFileSync(path.join(dir, "summary.md"), lines.join("\n") + "\n");
  log("wrote " + dir + "/summary.md and " + Object.keys(files).length + " CSVs");
  return files;
}

// review.csv: one row per call to make. Fill the "decision" column with
// merge or separate (or y / n), leave it blank to skip, then `review apply`.
function exportReview(db, file) {
  return csv.writeCsv(file, ["decision", "kind", "score", "a", "b", "evidence", "a_key", "b_key"],
    db.prepare("SELECT * FROM review ORDER BY kind, score DESC").iterate().map(function(r) {
      return ["", r.kind, r.score, r.a_label, r.b_label, r.evidence, r.a, r.b];
    }));
}

async function applyReview(db, file, log) {
  var ins = db.prepare("INSERT INTO decisions (a, b, decision, note, decided_at) VALUES (?,?,?,?,?) ON CONFLICT(a, b) DO UPDATE SET decision = excluded.decision, note = excluded.note, decided_at = excluded.decided_at");
  var counts = { merge: 0, separate: 0, skipped: 0 };
  db.exec("BEGIN");
  await csv.readCsv(file, function(r) {
    var d = String(r.decision || "").trim().toLowerCase();
    var decision = /^(m|merge|y|yes|same|1|true)$/.test(d) ? "merge" : /^(s|sep|separate|n|no|different|0|false)$/.test(d) ? "separate" : null;
    if (!decision || !r.a_key || !r.b_key) { counts.skipped++; return; }
    var a = r.a_key < r.b_key ? r.a_key : r.b_key;
    var b = r.a_key < r.b_key ? r.b_key : r.a_key;
    ins.run(a, b, decision, (r.a || "") + " | " + (r.b || ""), Date.now());
    counts[decision]++;
  });
  db.exec("COMMIT");
  log("saved " + counts.merge + " merges and " + counts.separate + " separations (" + counts.skipped + " rows left blank). Run reconcile again to use them.");
  return counts;
}

function uploadUrl(type, cid) {
  return type == 1 ? "https://youtu.be/" + cid : type == 2 ? "https://api.soundcloud.com/tracks/" + cid : type + ":" + cid;
}
function n(x) { return x == null ? "0" : Number(x).toLocaleString("en-US"); }
function pct(a, b) { return b ? Math.round((a || 0) / b * 100) + "%" : "0%"; }
function md(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|"); }

module.exports = { report: report, exportReview: exportReview, applyReview: applyReview };
