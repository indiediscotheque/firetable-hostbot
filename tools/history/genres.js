// Genres for every track, from the sources that know them, in the room's own
// list of genres:
//   Last.fm   the artist's and the track's top tags (the widest reach)
//   Discogs   the styles of the releases a track is on (the best names for
//             electronic music; needs DISCOGS_TOKEN)
//   SoundCloud  the genre an uploader chose, for uploads the room played
// genre-map.csv (tools/history/, and history-data/ which wins) turns raw tags
// into the room's genres: "tag,genre" per line, an empty genre to ignore a tag.
// genre-overrides.csv sets genres by hand: "Artist,Genre|Genre" or
// "Artist - Title,Genre". Answers are kept (lookups), so each artist and
// track is asked about once; each run asks about the most played first.
"use strict";
var fs = require("fs");
var path = require("path");
var tags = require("../../lib/tags");
var store = require("./store");
var fb = require("./firebase");

var DAY = 86400000;

function norm(t) { return String(t || "").toLowerCase().replace(/[-_/]+/g, " ").replace(/&/g, "and").replace(/\s+/g, " ").trim(); }
function slug(g) { return norm(g).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

// the room's played tracks, most played first, with their artists and remixers
function playedTracks(db) {
  return db.prepare("SELECT id, artist, title, plays FROM tracks WHERE plays > 0 ORDER BY plays DESC").all().map(function(t) {
    var p = tags.parse(t.artist, t.title);
    var remixers = p.versions.filter(function(v) { return v.kind === "remix" && v.by; }).map(function(v) { return v.by; });
    return { id: t.id, artist: t.artist, title: t.title, base: p.title || t.title, plays: t.plays, artists: p.artists, remixers: remixers };
  });
}
function artistsByPlays(tracks) {
  var m = new Map();
  tracks.forEach(function(t) {
    t.artists.concat(t.remixers).forEach(function(a) {
      var k = tags.artistKeyOf(a);
      if (!k) return;
      var cur = m.get(k);
      if (!cur) m.set(k, cur = { key: k, name: a, plays: 0 });
      cur.plays += t.plays;
    });
  });
  return Array.from(m.values()).sort(function(a, b) { return b.plays - a.plays; });
}
function known(db, kind) {
  return new Set(db.prepare("SELECT query FROM lookups WHERE kind = ?").all(kind).map(function(r) { return r.query; }));
}
var save = function(db, kind, query, result) {
  db.prepare("INSERT OR REPLACE INTO lookups (kind, query, result, fetched_at) VALUES (?, ?, ?, ?)").run(kind, query, result == null ? null : JSON.stringify(result), Date.now());
};
var topTags = function(j, key) {
  var list = j && j[key] && j[key].tag;
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  return list.slice(0, 15).map(function(t) { return [String(t.name), Number(t.count) || 0]; }).filter(function(t) { return t[1] > 0; });
};

// Last.fm: artists' top tags, then tracks' (most played first)
async function fetchLastfmTags(db, apiKey, opts, log) {
  if (!apiKey) { log("genres: Last.fm skipped (no LASTFM_APIKEY)"); return 0; }
  var lastfmCall = require("./sources").lastfmCall;
  var tracks = playedTracks(db);
  var artistsDone = known(db, "lfm-artist");
  var artists = artistsByPlays(tracks).filter(function(a) { return !artistsDone.has(a.key); }).slice(0, opts.artists != null ? Number(opts.artists) : 5000);
  var tracksDone = known(db, "lfm-track");
  var todoTracks = tracks.filter(function(t) { return !tracksDone.has(t.id); }).slice(0, opts.tracks != null ? Number(opts.tracks) : 3000);
  if (!artists.length && !todoTracks.length) return 0;
  var minutes = opts.minutes != null ? Number(opts.minutes) : 30;
  log("genres: asking Last.fm for the tags of " + artists.length + " artists and " + todoTracks.length + " tracks (" + minutes + " minutes at most)...");
  var jobs = artists.map(function(a) {
    return async function() {
      var r = null;
      try { r = { name: a.name, tags: topTags(await lastfmCall({ method: "artist.gettoptags", artist: a.name, autocorrect: 1 }, apiKey), "toptags") }; } catch (e) { if (e.code !== 6) log("  " + a.name + ": " + e.message); }
      save(db, "lfm-artist", a.key, r);
    };
  }).concat(todoTracks.map(function(t) {
    return async function() {
      var r = null;
      try { r = { tags: topTags(await lastfmCall({ method: "track.gettoptags", artist: t.artists[0] || t.artist, track: t.base, autocorrect: 1 }, apiKey), "toptags") }; } catch (e) { if (e.code !== 6) log("  " + t.artist + " - " + t.title + ": " + e.message); }
      save(db, "lfm-track", t.id, r);
    };
  }));
  // four at a time (Last.fm allows about five requests a second), within the time
  var n = 0;
  var until = Date.now() + minutes * 60000;
  for (var i = 0; i < jobs.length && Date.now() < until; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map(function(job) { return job(); }));
    n += Math.min(4, jobs.length - i);
    if (n % 1000 < 4) log("  " + n + "...");
    await fb.sleep(400);
  }
  if (n < jobs.length) log("  " + n + " done; the rest on the next runs");
  return n;
}

// Discogs: the styles of releases with the track on them (60 requests a minute)
async function fetchDiscogs(db, token, opts, log) {
  if (!token) { log("genres: Discogs skipped (no DISCOGS_TOKEN)"); return 0; }
  var done = known(db, "discogs");
  var todo = playedTracks(db).filter(function(t) { return !done.has(t.id); }).slice(0, opts.discogs != null ? Number(opts.discogs) : 1200);
  if (!todo.length) return 0;
  log("genres: asking Discogs about " + todo.length + " tracks (a minute per 60)...");
  var n = 0;
  for (var i = 0; i < todo.length; i++) {
    var t = todo[i];
    var url = new URL("https://api.discogs.com/database/search");
    url.searchParams.set("type", "release");
    url.searchParams.set("artist", t.artists[0] || t.artist);
    url.searchParams.set("track", t.base);
    url.searchParams.set("per_page", "5");
    var res;
    try {
      res = await fetch(url, { headers: { "Authorization": "Discogs token=" + token, "User-Agent": "firetable-history/1.0" }, signal: AbortSignal.timeout(30000) });
    } catch (e) { log("  Discogs: " + e.message + "; carry on next run"); break; }
    if (res.status === 429) { await fb.sleep(60000); i--; continue; }
    if (res.status === 401 || res.status === 403) { log("  Discogs refused the token (" + res.status + ")"); break; }
    var j = res.ok ? await res.json().catch(function() { return null; }) : null;
    var styles = new Map();
    var genres = new Map();
    var results = (j && j.results) || [];
    results.forEach(function(r) {
      (r.style || []).forEach(function(s) { styles.set(s, (styles.get(s) || 0) + 1); });
      (r.genre || []).forEach(function(g) { genres.set(g, (genres.get(g) || 0) + 1); });
    });
    save(db, "discogs", t.id, { n: results.length, styles: Array.from(styles), genres: Array.from(genres) });
    if (++n % 200 === 0) log("  " + n + "...");
    var left = Number(res.headers.get("x-discogs-ratelimit-remaining"));
    await fb.sleep(left > 5 ? 1000 : 6000);
  }
  return n;
}

// "tag,genre" lines; later files win; an empty genre ignores the tag
function readGenreMap(dir) {
  var map = new Map();
  [path.join(__dirname, "genre-map.csv"), path.join(dir, "genre-map.csv")].forEach(function(f) {
    if (!fs.existsSync(f)) return;
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach(function(line, i) {
      if (!line.trim() || /^#/.test(line) || (i === 0 && /^tag\s*,/i.test(line))) return;
      var at = line.lastIndexOf(",");
      if (at === -1) return;
      map.set(norm(line.slice(0, at).replace(/^"|"$/g, "")), line.slice(at + 1).trim().replace(/^"|"$/g, ""));
    });
  });
  return map;
}
function readOverrides(dir) {
  var out = { artists: new Map(), tracks: new Map() };
  [path.join(__dirname, "genre-overrides.csv"), path.join(dir, "genre-overrides.csv")].forEach(function(f) {
    if (!fs.existsSync(f)) return;
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach(function(line) {
      if (!line.trim() || /^#/.test(line)) return;
      var at = line.lastIndexOf(",");
      if (at === -1) return;
      var who = line.slice(0, at).trim().replace(/^"|"$/g, "");
      var gs = line.slice(at + 1).split("|").map(function(g) { return g.trim(); }).filter(Boolean);
      if (!gs.length) return;
      if (who.indexOf(" - ") > 0) out.tracks.set(tags.keysOf(tags.parse(who, null)).track, gs);
      else out.artists.set(tags.artistKeyOf(who), gs);
    });
  });
  return out;
}

/**
 * Each played track's genres (up to 3, strongest first), from everything
 * fetched, in the room's genres. Writes the track_genres table and returns
 * {tracks, withGenres, unmapped: Map(tag -> weight)}.
 */
function assignGenres(db, dir, log) {
  var map = readGenreMap(dir);
  var over = readOverrides(dir);
  var lookup = function(kind) {
    var m = new Map();
    db.prepare("SELECT query, result FROM lookups WHERE kind = ? AND result IS NOT NULL").all(kind).forEach(function(r) { m.set(r.query, JSON.parse(r.result)); });
    return m;
  };
  var lfmArtist = lookup("lfm-artist");
  var lfmTrack = lookup("lfm-track");
  var discogs = lookup("discogs");
  // SoundCloud's genre field, by track, for uploads the room played
  var scByTrack = new Map();
  db.prepare("SELECT u.track_id, l.result FROM uploads u JOIN lookups l ON l.kind = 'sc' AND l.query = u.cid WHERE u.type = 2 AND l.result LIKE '%\"genre\"%'").all().forEach(function(r) {
    var g = JSON.parse(r.result).genre;
    if (!g) return;
    if (!scByTrack.has(r.track_id)) scByTrack.set(r.track_id, new Set());
    scByTrack.get(r.track_id).add(g);
  });
  var unmapped = new Map();
  var add = function(score, why, tag, w, src) {
    if (!(w > 0)) return;
    var g = map.get(norm(tag));
    if (g === undefined) { unmapped.set(norm(tag), (unmapped.get(norm(tag)) || 0) + w); return; }
    if (!g) return;
    // "~Genre": a fallback, only for a track nothing more specific fits
    if (g.charAt(0) === "~") { score = score.fallback; g = g.slice(1); }
    score.set(g, (score.get(g) || 0) + w);
    if (!why.has(g)) why.set(g, new Set());
    why.get(g).add(src);
  };
  var rows = [];
  var withGenres = 0;
  playedTracks(db).forEach(function(t) {
    var score = new Map();
    score.fallback = new Map();
    var why = new Map();
    (lfmTrack.get(t.id) || { tags: [] }).tags.forEach(function(x) { add(score, why, x[0], 3 * x[1] / 100, "lastfm track"); });
    // a remix sounds like its remixer more than its artist
    var remix = t.remixers.length > 0;
    t.artists.forEach(function(a) {
      var at = lfmArtist.get(tags.artistKeyOf(a));
      if (at) at.tags.forEach(function(x) { add(score, why, x[0], (remix ? 0.5 : 1) * x[1] / 100 / t.artists.length, "lastfm artist"); });
    });
    t.remixers.forEach(function(a) {
      var at = lfmArtist.get(tags.artistKeyOf(a));
      if (at) at.tags.forEach(function(x) { add(score, why, x[0], 1.5 * x[1] / 100 / t.remixers.length, "lastfm remixer"); });
    });
    var d = discogs.get(t.id);
    if (d && d.n) {
      d.styles.forEach(function(x) { add(score, why, x[0], 2 * x[1] / d.n, "discogs"); });
      d.genres.forEach(function(x) { add(score, why, x[0], 0.5 * x[1] / d.n, "discogs"); });
    }
    (scByTrack.get(t.id) || new Set()).forEach(function(g) { add(score, why, g, 1, "soundcloud"); });
    // the strongest genres: within 40% of the track's best one (Last.fm
    // weighs an artist's tags against their top tag, so a band mostly tagged
    // "electronic" still has "electro" and "synthpop" a long way behind)
    var list = Array.from(score.entries()).filter(function(e) { return e[1] >= 0.08; }).sort(function(a, b) { return b[1] - a[1]; });
    if (!list.length) list = Array.from(score.fallback.entries()).filter(function(e) { return e[1] >= 0.08; }).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 1);
    var top = list.length ? list[0][1] : 0;
    var genres = list.filter(function(e) { return e[1] >= top * 0.4; }).slice(0, 3).map(function(e) { return e[0]; });
    var by = "";
    var o = over.tracks.get(tags.keysOf(tags.parse(t.artist, t.title)).track) || over.artists.get(tags.artistKeyOf(t.artists[0] || t.artist));
    if (o) { genres = o; by = "genre-overrides.csv"; }
    if (genres.length) withGenres++;
    rows.push([t.id, JSON.stringify(genres), by || genres.map(function(g) { return g + ": " + Array.from(why.get(g) || []).join("+"); }).join("; ")]);
  });
  store.tx(db, function() {
    db.exec("CREATE TABLE IF NOT EXISTS track_genres (track_id TEXT PRIMARY KEY, genres TEXT, why TEXT)");
    db.exec("DELETE FROM track_genres");
    var ins = db.prepare("INSERT INTO track_genres (track_id, genres, why) VALUES (?, ?, ?)");
    rows.forEach(function(r) { ins.run(r[0], r[1], r[2]); });
  });
  log && log("genres: " + withGenres + " of " + rows.length + " played tracks have genres");
  return { tracks: rows.length, withGenres: withGenres, unmapped: unmapped };
}

// Every raw tag and how much it weighs across the room's plays, for drafting
// and growing genre-map.csv (history-data/genre_tags.csv)
function tagWeights(db) {
  var tracks = playedTracks(db);
  var lfmArtist = new Map();
  db.prepare("SELECT query, result FROM lookups WHERE kind = 'lfm-artist' AND result IS NOT NULL").all().forEach(function(r) { lfmArtist.set(r.query, JSON.parse(r.result)); });
  var w = new Map();
  var artistsOf = new Map();
  tracks.forEach(function(t) {
    t.artists.forEach(function(a) {
      var at = lfmArtist.get(tags.artistKeyOf(a));
      if (!at) return;
      at.tags.forEach(function(x) {
        var k = norm(x[0]);
        w.set(k, (w.get(k) || 0) + t.plays * x[1] / 100);
        if (!artistsOf.has(k)) artistsOf.set(k, new Map());
        artistsOf.get(k).set(at.name, (artistsOf.get(k).get(at.name) || 0) + t.plays);
      });
    });
  });
  return Array.from(w.entries()).sort(function(a, b) { return b[1] - a[1]; }).map(function(e) {
    var top = Array.from(artistsOf.get(e[0]).entries()).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5).map(function(x) { return x[0]; });
    return { tag: e[0], weight: Math.round(e[1]), artists: top.join(" | ") };
  });
}

module.exports = { fetchLastfmTags: fetchLastfmTags, fetchDiscogs: fetchDiscogs, assignGenres: assignGenres, tagWeights: tagWeights, readGenreMap: readGenreMap, norm: norm, slug: slug, DAY: DAY };
