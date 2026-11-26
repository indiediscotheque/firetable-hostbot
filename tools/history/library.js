// Discover's library pages, from the reconciled history: genres, DJs, artists,
// years and the Rising and On this day shelves. The site reads them, so they
// are public (discover/ in firebase-rules.json); only the bot's account
// writes them. Written by `publish --write` (and `library --write` alone):
//
//   discover/lib/meta              when, and how many of each
//   discover/lib/genres            every genre: name, songs, plays, usual BPM,
//                                  first year, DJs, map position, covers, next door
//   discover/lib/genre/<slug>      favorites, new here, deep cuts, by year, who plays it,
//                                  and a few sentences about it (story)
//   discover/lib/genreYear/<slug>_<year>  a genre's most played songs released that
//                                  year (the year playlists say which year); the
//                                  genre's entry in genres lists the years (ys)
//   discover/lib/djs               DJs with 25+ plays: name, plays, firsts, top genres
//   discover/lib/dj/<key>          taste, most played, brought here first, similar
//                                  DJs, when they play, recent sets, cards
//   discover/lib/artistIndex       artist slug -> [name, plays] (the 5,000 most played)
//   discover/lib/artist/<slug>     their songs here, who plays them, first play,
//                                  their genres (g) and the artists who sound
//                                  like them (sim: played by the same DJs, in
//                                  the same genres, or on a song together)
//   discover/lib/years             each year playlist: songs, room plays, top genre, covers
//   discover/lib/year/<year>       most played from that year, and finds not played yet
//   discover/lib/rising            plays up most, the last 4 weeks against the 4 before
//   discover/lib/onThisDay/<MM-DD> songs first played here on this day in past years
//   discover/lib/songs/<n>         every song played here, for the site's search (songindex.js)
//
// People who turned off "Show my name on public pages" (users/<uid>/
// publicName = false) have no DJ page and show as nobody on songs.
"use strict";
var fs = require("fs");
var path = require("path");
var tags = require("../../lib/tags");
var genres = require("./genres");
var store = require("./store");
var songindex = require("./songindex");
// the genre files' readers: genre-axis.csv, genre-about.csv, genre-stories.md
var genretext = require("./genretext");
var readAxis = genretext.readAxis, readAbout = genretext.readAbout, readStories = genretext.readStories;

var DAY = 86400000;
var ROWS = { fav: 100, newHere: 50, deep: 50, dj: 30, artist: 25, year: 40, genreYear: 40, yearMore: 24, rising: 20, onThisDay: 8 };
var DJ_MIN_PLAYS = 25;
var GENRE_YEAR_MIN = 8;    // a genre's year gets a page with this many of its songs played here
var ARTIST_MIN_PLAYS = 5;
var ARTIST_MAX = 5000;
var ARTIST_GENRES = 3;    // an artist's sound: up to this many genres
var ARTIST_SIMILAR = 8;   // "Sounds like": up to this many artists
var SIMILAR_MIN = 0.55;   // and only ones this alike (0 to 1)
var SET_GAP = 2 * 3600 * 1000;
var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A short, readable, URL-safe key: "Nu-Disco" -> "nu-disco", "Röyksopp" -> "royksopp". */
function slugOf(s) {
  var out = tags.fold(String(s || "")).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, 60) || "x" + tags.hash(String(s)).slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "0");
}

function median(list) {
  if (!list.length) return null;
  var s = list.slice().sort(function(a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

function dayKey(ms) {
  var d = new Date(ms);
  return (d.getMonth() < 9 ? "0" : "") + (d.getMonth() + 1) + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate();
}

/** "Friday nights", "Sunday afternoons"... when most of someone's plays are. */
function usualTime(times) {
  if (times.length < 20) return null;
  var days = [0, 0, 0, 0, 0, 0, 0];
  var parts = { mornings: 0, afternoons: 0, evenings: 0, nights: 0 };
  times.forEach(function(t) {
    var d = new Date(t);
    var h = d.getHours();
    // the small hours belong to the night before
    var wd = h < 5 ? (d.getDay() + 6) % 7 : d.getDay();
    days[wd]++;
    parts[h < 5 || h >= 21 ? "nights" : h < 12 ? "mornings" : h < 17 ? "afternoons" : "evenings"]++;
  });
  var best = days.indexOf(Math.max.apply(null, days));
  var part = Object.keys(parts).sort(function(a, b) { return parts[b] - parts[a]; })[0];
  if (days[best] / times.length < 0.3) return "all week, mostly " + part;
  return WEEKDAYS[best] + " " + part;
}

/**
 * Everything Discover's library pages show, as database paths.
 * @param {object} db - the history's SQLite database
 * @param {object} opts
 * @param {Object<string, {username, publicName}>} [opts.users] - the room's users (users/)
 * @param {Object<string, {bpm}|number>} [opts.bpm] - tempos by "type_cid" (bpm/)
 * @param {Object<string, {owner}>} [opts.cards] - trading cards (cards/)
 * @param {Object<string, Array<{cid, artist, title}>>} [opts.years] - year playlists by year
 * @param {number} [opts.genreYearMin] - songs a genre needs from one year for that year's page (GENRE_YEAR_MIN)
 * @param {number} [opts.now]
 * @param {string} [opts.dir] - history-data (for a genre-axis.csv of your own)
 * @returns {{updates: Object, counts: Object}}
 */
function buildLibrary(db, opts) {
  opts = opts || {};
  var now = opts.now || Date.now();
  var users = opts.users || {};
  var updates = {};
  var counts = {};

  // ---------------------------------------------------------------- people
  var uidByName = new Map();
  var hiddenUid = new Set();
  Object.keys(users).forEach(function(uid) {
    var u = users[uid] || { username: null, publicName: null };
    if (typeof u.username === "string" && u.username) uidByName.set(u.username.toLowerCase(), uid);
    if (u.publicName === false) hiddenUid.add(uid);
  });
  // DJ names as the history shows them, and every alias, point at an account
  var djRows = db.prepare("SELECT name, aliases, plays, first_plays, tracks, first_seen, last_seen FROM djs").all();
  var uidOfDj = new Map();
  djRows.forEach(function(d) {
    var uid = uidByName.get(String(d.name).toLowerCase());
    if (!uid) String(d.aliases || "").split(" | ").some(function(a) { uid = uidByName.get(String(a).toLowerCase()); return !!uid; });
    if (uid) uidOfDj.set(d.name, uid);
  });
  var hiddenDj = function(name) { var uid = name && uidOfDj.get(name); return !!(uid && hiddenUid.has(uid)); };
  // the room's own bots (house-djs.csv): their plays count for songs, but they
  // get no DJ page and aren't in "who plays it" or similar DJs
  var houseDj = new Set(store.getState(db, "house_djs") || []);
  var notDj = function(name) { return hiddenDj(name) || houseDj.has(name); };
  var whoOf = function(name) {
    if (!name || hiddenDj(name)) return {};
    return { dj: name, djid: uidOfDj.get(name) || null };
  };

  // ---------------------------------------------------------------- tracks
  var tracks = new Map();
  db.prepare("SELECT id, artist, title, plays, first_play_at, first_play_dj, last_play_at FROM tracks WHERE plays > 0").all().forEach(function(t) {
    tracks.set(t.id, t);
  });
  // a playable upload for each: the one played last, else any; never one the
  // room tags as another version (Discover shows the track's name over it,
  // so "Kites" must not play "Kites (Limousines Remix)")
  var versionOf = new Map();
  var trackVersion = function(id) {
    if (!versionOf.has(id)) {
      var t = tracks.get(id);
      versionOf.set(id, t ? tags.keysOf(tags.parse(t.artist || "", t.title || "")).version : null);
    }
    return versionOf.get(id);
  };
  var tagged = new Map(); // "type_cid" -> the room's tags for the upload now
  var uploadsByTrack = new Map();
  db.prepare("SELECT track_id, type, cid, artist, title FROM uploads").all().forEach(function(u) {
    if (!u.cid) return;
    tagged.set(u.type + "_" + u.cid, u);
    if (!uploadsByTrack.has(u.track_id)) uploadsByTrack.set(u.track_id, []);
    uploadsByTrack.get(u.track_id).push(u);
  });
  var fits = function(trackId, type, cid) {
    var u = tagged.get(type + "_" + cid);
    if (!u || !u.title) return true;
    var v = trackVersion(trackId);
    return v == null || tags.sameVersion(v, tags.keysOf(tags.parse(u.artist || "", u.title)).version);
  };
  var uploadOf = new Map();
  db.prepare("SELECT track_id, type, cid, max(at) at FROM plays WHERE cid IS NOT NULL AND cid != '' GROUP BY track_id, type, cid ORDER BY at DESC").all().forEach(function(u) {
    if (uploadOf.has(u.track_id) || !tracks.has(u.track_id) || !fits(u.track_id, u.type, u.cid)) return;
    uploadOf.set(u.track_id, { type: Number(u.type) || 1, cid: String(u.cid) });
  });
  uploadsByTrack.forEach(function(list, id) {
    if (uploadOf.has(id) || !tracks.has(id)) return;
    var u = list.find(function(x) { return fits(id, x.type, x.cid); });
    if (u) uploadOf.set(id, { type: Number(u.type) || 1, cid: String(u.cid) });
  });
  var row = function(id, extra) {
    var t = tracks.get(id);
    var up = uploadOf.get(id);
    if (!t || !up) return null;
    return Object.assign({ type: up.type, cid: up.cid, a: t.artist || "", t: t.title || "", plays: t.plays || 0, first: t.first_play_at || null }, whoOf(t.first_play_dj), extra || {});
  };
  // Every list a page shows is built here, and holds each song once: never
  // the same upload twice, nor the same artist and title twice (two track
  // records of one song can share a name and an upload). The repeats skipped
  // are counted for the run's log.
  counts.repeats = 0;
  var rows = function(ids, max, extraOf) {
    var out = [];
    var seen = new Set();
    for (var i = 0; i < ids.length && out.length < max; i++) {
      var r = row(ids[i], extraOf ? extraOf(ids[i]) : null);
      if (!r) continue;
      var byUpload = r.type + "_" + r.cid;
      var byName = String(r.a).toLowerCase().trim() + "|" + String(r.t).toLowerCase().trim();
      if (seen.has(byUpload) || seen.has(byName)) { counts.repeats++; continue; }
      seen.add(byUpload);
      seen.add(byName);
      out.push(r);
    }
    return out;
  };
  var byPlays = function(a, b) { return (tracks.get(b).plays || 0) - (tracks.get(a).plays || 0) || (tracks.get(b).last_play_at || 0) - (tracks.get(a).last_play_at || 0); };

  // a tempo for each track, from any of its uploads
  var bpmOf = new Map();
  var bpmData = opts.bpm || {};
  uploadsByTrack.forEach(function(list, id) {
    for (var i = 0; i < list.length; i++) {
      var v = bpmData[list[i].type + "_" + list[i].cid];
      var n = v && typeof v === "object" ? Number(v.bpm) : Number(v);
      if (n >= 40 && n <= 250) { bpmOf.set(id, n); return; }
    }
  });

  // --------------------------------------------------------------- genres
  var genreOf = new Map(); // track -> [genre names], strongest first
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'track_genres'").get()) {
    db.prepare("SELECT track_id, genres FROM track_genres").all().forEach(function(g) {
      var list = JSON.parse(g.genres || "[]").map(function(x) { return String(x).replace(/^~/, ""); }).filter(Boolean);
      if (list.length && tracks.has(g.track_id)) genreOf.set(g.track_id, list);
    });
  }
  // per DJ, per track plays (the DJ pages and "who plays it")
  var djTrack = new Map(); // dj -> Map(track -> n)
  var djTimes = new Map(); // dj -> [play times]
  db.prepare("SELECT dj, track_id, at FROM plays WHERE dj IS NOT NULL AND dj != ''").all().forEach(function(p) {
    if (!tracks.has(p.track_id)) return;
    if (!djTrack.has(p.dj)) { djTrack.set(p.dj, new Map()); djTimes.set(p.dj, []); }
    var m = djTrack.get(p.dj);
    m.set(p.track_id, (m.get(p.track_id) || 0) + 1);
    if (p.at) djTimes.get(p.dj).push(p.at);
  });

  var axis = readAxis(opts.dir);
  var about = readAbout(opts.dir);
  var stories = readStories(opts.dir);
  // each track's plays by decade, for the sound map's decade filter
  var trackDecades = new Map(); // track -> {2010: n, ...}
  db.prepare("SELECT track_id, at FROM plays WHERE at IS NOT NULL").all().forEach(function(p) {
    var dec = Math.floor(new Date(p.at).getFullYear() / 10) * 10;
    var m = trackDecades.get(p.track_id);
    if (!m) trackDecades.set(p.track_id, m = {});
    m[dec] = (m[dec] || 0) + 1;
  });
  var genreIdx = new Map(); // name -> {tracks: [], plays, bpms, first, co: Map}
  genreOf.forEach(function(list, id) {
    list.forEach(function(g) {
      if (!genreIdx.has(g)) genreIdx.set(g, { name: g, tracks: [], plays: 0, bpms: [], first: Infinity, co: new Map(), djs: new Map() });
      var gi = genreIdx.get(g);
      var t = tracks.get(id);
      gi.tracks.push(id);
      gi.plays += t.plays || 0;
      if (bpmOf.has(id)) gi.bpms.push(bpmOf.get(id));
      if (t.first_play_at) gi.first = Math.min(gi.first, t.first_play_at);
      list.forEach(function(o) { if (o !== g) gi.co.set(o, (gi.co.get(o) || 0) + (t.plays || 1)); });
    });
  });
  djTrack.forEach(function(m, dj) {
    if (notDj(dj)) return;
    m.forEach(function(n, id) {
      (genreOf.get(id) || []).forEach(function(g) { var gi = genreIdx.get(g); gi.djs.set(dj, (gi.djs.get(dj) || 0) + n); });
    });
  });
  var genreIndex = {};
  genreIdx.forEach(function(gi, name) {
    var sl = genres.slug(name);
    var ids = gi.tracks.slice().sort(byPlays);
    var covers = rows(ids, 4).map(function(r) { return r.type + "_" + r.cid; });
    var next = Array.from(gi.co.entries()).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 4).map(function(e) { return genres.slug(e[0]); });
    var dec = {};
    gi.tracks.forEach(function(id) { var m = trackDecades.get(id) || {}; Object.keys(m).forEach(function(d) { dec[d] = (dec[d] || 0) + m[d]; }); });
    genreIndex[sl] = {
      name: name, songs: gi.tracks.length, plays: gi.plays, bpm: median(gi.bpms), first: isFinite(gi.first) ? new Date(gi.first).getFullYear() : null,
      djs: gi.djs.size, x: axis[name] == null ? 0.5 : axis[name], covers: covers, next: next, dec: dec, about: about[name] || null
    };
    var years = {};
    gi.tracks.forEach(function(id) { var f = tracks.get(id).first_play_at; if (f) { var y = new Date(f).getFullYear(); years[y] = (years[y] || 0) + 1; } });
    updates["discover/lib/genre/" + sl] = {
      story: stories[name] || null,
      fav: rows(ids, ROWS.fav),
      newHere: rows(gi.tracks.slice().sort(function(a, b) { return (tracks.get(b).first_play_at || 0) - (tracks.get(a).first_play_at || 0); }), ROWS.newHere),
      deep: rows(gi.tracks.filter(function(id) { return (tracks.get(id).plays || 0) <= 2; }).sort(function(a, b) { return (tracks.get(b).last_play_at || 0) - (tracks.get(a).last_play_at || 0); }), ROWS.deep),
      years: years,
      who: Array.from(gi.djs.entries()).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10).map(function(e) {
        return Object.assign({ plays: e[1] }, whoOf(e[0]), { key: slugOf(e[0]) });
      })
    };
  });
  updates["discover/lib/genres"] = genreIndex;
  counts.genres = Object.keys(genreIndex).length;

  // ------------------------------------------------------------------ DJs
  var djIndex = {};
  var djVec = new Map(); // dj -> {map: Map(track -> n), norm}
  var cardsOf = {};
  Object.keys(opts.cards || {}).forEach(function(k) { var o = (opts.cards[k] || {}).owner; if (o) cardsOf[o] = (cardsOf[o] || 0) + 1; });
  var eligible = djRows.filter(function(d) { return (d.plays || 0) >= DJ_MIN_PLAYS && !notDj(d.name) && djTrack.has(d.name); });
  eligible.forEach(function(d) {
    var m = djTrack.get(d.name);
    var top = Array.from(m.entries()).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 400);
    var norm = Math.sqrt(top.reduce(function(s, e) { return s + e[1] * e[1]; }, 0));
    djVec.set(d.name, { map: new Map(top), norm: norm });
  });
  var keyOfDj = new Map();
  var usedKeys = {};
  eligible.forEach(function(d) {
    var k = slugOf(d.name);
    if (usedKeys[k]) k += "-" + tags.hash(d.name).slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, "0");
    usedKeys[k] = true;
    keyOfDj.set(d.name, k);
  });
  eligible.forEach(function(d) {
    var key = keyOfDj.get(d.name);
    var m = djTrack.get(d.name);
    var uid = uidOfDj.get(d.name) || null;
    // taste: their plays by each song's strongest genre
    var taste = new Map();
    var tasted = 0;
    m.forEach(function(n, id) {
      var g = (genreOf.get(id) || [])[0];
      if (!g) return;
      taste.set(g, (taste.get(g) || 0) + n);
      tasted += n;
    });
    var tasteList = Array.from(taste.entries()).sort(function(a, b) { return b[1] - a[1]; });
    /** @type {Array<{g: string, slug?: string, pct: number}>} */
    var tasteOut = tasteList.slice(0, 5).map(function(e) { return { g: e[0], slug: genres.slug(e[0]), pct: Math.round((e[1] / tasted) * 100) }; });
    var shown = tasteOut.reduce(function(s, x) { return s + x.pct; }, 0);
    if (tasted && shown < 100 && tasteList.length > 5) tasteOut.push({ g: "Other", pct: 100 - shown });
    // similar: overlap of the songs they play most
    var mine = djVec.get(d.name);
    var similar = [];
    djVec.forEach(function(other, name) {
      if (name === d.name || !mine.norm || !other.norm) return;
      var dot = 0;
      var small = mine.map.size < other.map.size ? mine.map : other.map;
      var big = small === mine.map ? other.map : mine.map;
      small.forEach(function(n, id) { var o = big.get(id); if (o) dot += n * o; });
      if (dot) similar.push({ name: name, s: dot / (mine.norm * other.norm) });
    });
    similar.sort(function(a, b) { return b.s - a.s; });
    // sets: plays with no more than 2 hours between them
    var times = (djTimes.get(d.name) || []).slice().sort(function(a, b) { return a - b; });
    var sets = [];
    times.forEach(function(t) {
      var last = sets[sets.length - 1];
      if (last && t - last.end <= SET_GAP) { last.end = t; last.n++; } else sets.push({ at: t, end: t, n: 1 });
    });
    var firstIds = Array.from(tracks.keys()).filter(function(id) { return tracks.get(id).first_play_dj === d.name; }).sort(byPlays);
    var most = Array.from(m.entries()).sort(function(a, b) { return b[1] - a[1]; }).map(function(e) { return e[0]; });
    djIndex[key] = {
      name: d.name, djid: uid, plays: d.plays || 0, firsts: d.first_plays || 0, since: d.first_seen || null,
      g: tasteOut.filter(function(x) { return x.slug; }).slice(0, 2).map(function(x) { return x.g; })
    };
    updates["discover/lib/dj/" + key] = {
      name: d.name, djid: uid, plays: d.plays || 0, firsts: d.first_plays || 0, songs: d.tracks || 0, since: d.first_seen || null, last: d.last_seen || null,
      cards: uid ? cardsOf[uid] || 0 : 0,
      when: usualTime(times),
      taste: tasteOut,
      most: rows(most, ROWS.dj, function(id) { return { by: m.get(id) }; }),
      firstHere: rows(firstIds, ROWS.dj),
      similar: similar.slice(0, 5).map(function(x) { return { key: keyOfDj.get(x.name), name: x.name, djid: uidOfDj.get(x.name) || null, pct: Math.round(x.s * 100) }; }),
      sets: sets.slice(-8).reverse().map(function(s) { return { at: s.at, n: s.n }; })
    };
  });
  updates["discover/lib/djs"] = djIndex;
  counts.djs = Object.keys(djIndex).length;

  // -------------------------------------------------------------- artists
  var artists = new Map(); // artist key -> {names: Map(name -> plays), tracks: [], plays, first, firstDj, djs: Map}
  tracks.forEach(function(t, id) {
    var names = tags.splitArtists ? tags.splitArtists(t.artist || "") : [t.artist];
    (names && names.length ? names : [t.artist]).forEach(function(name) {
      var k = tags.artistKeyOf(name);
      if (!k) return;
      if (!artists.has(k)) artists.set(k, { names: new Map(), tracks: [], plays: 0, first: Infinity, firstDj: null, djs: new Map() });
      var a = artists.get(k);
      a.names.set(name, (a.names.get(name) || 0) + (t.plays || 0));
      a.tracks.push(id);
      a.plays += t.plays || 0;
      if (t.first_play_at && t.first_play_at < a.first) { a.first = t.first_play_at; a.firstDj = t.first_play_dj; }
    });
  });
  var artistList = Array.from(artists.values()).filter(function(a) { return a.plays >= ARTIST_MIN_PLAYS; })
    .sort(function(a, b) { return b.plays - a.plays; }).slice(0, ARTIST_MAX);
  var artistIndex = {};
  var artistSlugs = {};
  var trackSet = new Set();
  artistList.forEach(function(a) { a.tracks.forEach(function(id) { trackSet.add(id); }); });
  // who plays each artist most
  djTrack.forEach(function(m, dj) {
    if (notDj(dj)) return;
    m.forEach(function(n, id) {
      if (!trackSet.has(id)) return;
      var t = tracks.get(id);
      (tags.splitArtists ? tags.splitArtists(t.artist || "") : [t.artist]).forEach(function(name) {
        var a = artists.get(tags.artistKeyOf(name));
        if (a) a.djs.set(dj, (a.djs.get(dj) || 0) + n);
      });
    });
  });
  artistList.forEach(function(a) {
    var name = Array.from(a.names.entries()).sort(function(x, y) { return y[1] - x[1]; })[0][0];
    var sl = slugOf(name);
    if (artistSlugs[sl]) sl += "-" + tags.hash(name).slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, "0");
    artistSlugs[sl] = true;
    a.name = name;
    a.slug = sl;
  });
  similarArtists(artistList, tracks, genreOf);
  artistList.forEach(function(a) {
    var name = a.name, sl = a.slug;
    artistIndex[sl] = [name, a.plays];
    updates["discover/lib/artist/" + sl] = Object.assign({
      name: name, plays: a.plays, songs: a.tracks.length, first: isFinite(a.first) ? a.first : null,
      g: a.genres, sim: a.similar.map(function(o) { return { k: o.slug, n: o.name }; }),
      rows: rows(a.tracks.slice().sort(byPlays), ROWS.artist),
      djs: Array.from(a.djs.entries()).sort(function(x, y) { return y[1] - x[1]; }).slice(0, 5).map(function(e) {
        return Object.assign({ plays: e[1], key: keyOfDj.get(e[0]) || null }, whoOf(e[0]));
      })
    }, a.firstDj && !hiddenDj(a.firstDj) ? { firstDj: a.firstDj, firstDjid: uidOfDj.get(a.firstDj) || null } : {});
  });
  updates["discover/lib/artistIndex"] = artistIndex;
  counts.artists = artistList.length;

  // ---------------------------------------------------------------- years
  var trackOfUpload = new Map();
  db.prepare("SELECT type, cid, track_id FROM uploads").all().forEach(function(u) { trackOfUpload.set(u.type + "_" + u.cid, u.track_id); });
  var yearIndex = {};
  var genreYearMin = opts.genreYearMin || GENRE_YEAR_MIN;
  Object.keys(opts.years || {}).forEach(function(year) {
    var list = opts.years[year] || [];
    var played = [];
    var unplayed = [];
    var plays = 0;
    var genreCount = new Map();
    var seen = new Set();
    var seenTrack = new Set();
    var byGenre = new Map(); // genre -> this year's songs played here
    list.forEach(function(it) {
      if (!it || !it.cid || seen.has(it.cid)) return;
      seen.add(it.cid);
      var id = trackOfUpload.get("1_" + it.cid);
      var t = id && tracks.get(id);
      if (t) {
        // the playlist can hold one song under several uploads (an official
        // video, a lyric video, a re-upload): one song, counted and listed once
        if (seenTrack.has(id)) return;
        seenTrack.add(id);
        played.push(id);
        plays += t.plays || 0;
        (genreOf.get(id) || []).slice(0, 1).forEach(function(g) { genreCount.set(g, (genreCount.get(g) || 0) + (t.plays || 0)); });
        (genreOf.get(id) || []).forEach(function(g) { if (!byGenre.has(g)) byGenre.set(g, []); byGenre.get(g).push(id); });
      } else {
        unplayed.push({ type: 1, cid: it.cid, a: it.artist || "", t: it.title || "", plays: 0 });
      }
    });
    var top = Array.from(genreCount.entries()).sort(function(a, b) { return b[1] - a[1]; })[0];
    // the four most played, as covers for the Years list ("type_cid", as genres' covers)
    var covers = rows(played.slice().sort(byPlays), 4).map(function(r) { return r.type + "_" + r.cid; });
    yearIndex[year] = { songs: played.length + unplayed.length, plays: plays, played: played.length, genre: top ? top[0] : null, covers: covers };
    // finds not played here yet: spread across the list, the same each week
    var step = Math.max(1, Math.floor(unplayed.length / ROWS.yearMore));
    var more = [];
    for (var i = 0; i < unplayed.length && more.length < ROWS.yearMore; i += step) more.push(unplayed[i]);
    updates["discover/lib/year/" + year] = { top: rows(played.sort(byPlays), ROWS.year), more: more };
    // a genre's songs from this year: "the best nu-disco of 2014", when there are enough of them
    if (/^\d{4}$/.test(year)) {
      byGenre.forEach(function(ids, g) {
        var sl = genres.slug(g);
        if (ids.length < genreYearMin || !genreIndex[sl]) return;
        var top = rows(ids.slice().sort(byPlays), ROWS.genreYear);
        if (top.length < genreYearMin) return;
        updates["discover/lib/genreYear/" + sl + "_" + year] = {
          songs: ids.length, plays: ids.reduce(function(sum, id) { return sum + (tracks.get(id).plays || 0); }, 0), top: top
        };
        (genreIndex[sl].ys = genreIndex[sl].ys || []).push(Number(year));
      });
    }
  });
  Object.keys(genreIndex).forEach(function(sl) { if (genreIndex[sl].ys) genreIndex[sl].ys.sort(); });
  if (Object.keys(yearIndex).length) updates["discover/lib/years"] = yearIndex;
  counts.years = Object.keys(yearIndex).length;

  // --------------------------------------------------------------- rising
  var recent = new Map();
  var before = new Map();
  db.prepare("SELECT track_id, at FROM plays WHERE at >= ?").all(now - 56 * DAY).forEach(function(p) {
    var m = p.at >= now - 28 * DAY ? recent : before;
    m.set(p.track_id, (m.get(p.track_id) || 0) + 1);
  });
  var rising = Array.from(recent.entries()).filter(function(e) { return e[1] >= 3 && tracks.has(e[0]); })
    .map(function(e) { return { id: e[0], up: e[1] - (before.get(e[0]) || 0), now: e[1] }; })
    .filter(function(x) { return x.up > 0; })
    .sort(function(a, b) { return b.up - a.up || b.now - a.now; });
  updates["discover/lib/rising"] = { at: now, rows: rows(rising.map(function(x) { return x.id; }), ROWS.rising, function(id) {
    var x = rising.find(function(r) { return r.id === id; });
    return { recent: x.now, up: x.up };
  }) };

  // ---------------------------------------------------------- on this day
  var thisYear = new Date(now).getFullYear();
  var byDay = new Map();
  tracks.forEach(function(t, id) {
    if (!t.first_play_at || new Date(t.first_play_at).getFullYear() >= thisYear) return;
    var k = dayKey(t.first_play_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(id);
  });
  byDay.forEach(function(ids, k) {
    updates["discover/lib/onThisDay/" + k] = rows(ids.sort(byPlays), ROWS.onThisDay);
  });

  // every song, for the site's search (songindex.js)
  var songs = songindex.songUpdates(songindex.songRows(tracks, function(id) { return uploadOf.get(id); }));
  Object.assign(updates, songs.updates);
  counts.songs = songs.meta.songs;

  updates["discover/lib/meta"] = Object.assign({ at: now, genres: counts.genres, djs: counts.djs, artists: counts.artists, years: counts.years }, songs.meta);
  return { updates: updates, counts: counts };
}

/**
 * Each artist's sound and who sounds like them, from the room's own plays.
 * Sets on every artist: genres (names, most played first: a genre needs a
 * fifth of the artist's plays, the first one always counts) and similar (the
 * most alike artists, most alike first).
 *
 * Two artists are alike when the same DJs play them (each DJ weighted down
 * the more artists they play, so one DJ who plays everything links nobody)
 * and their plays fall in the same genres; making a song together counts too.
 * @param {Object[]} list - artists: {name, slug, plays, tracks: [track id], djs: Map(dj -> plays)}
 * @param {Map} tracks - track id -> {plays, ...}
 * @param {Map} genreOf - track id -> [genre names], strongest first
 */
function similarArtists(list, tracks, genreOf) {
  var genreIx = new Map(), djIx = new Map(), djArtists = [];
  var ix = function(map, key) { if (!map.has(key)) map.set(key, map.size); return map.get(key); };
  list.forEach(function(a) {
    // genres: every play of a song counts for its first genre, half for its second
    var g = new Map();
    a.tracks.forEach(function(id) {
      var plays = (tracks.get(id) || {}).plays || 0;
      (genreOf.get(id) || []).slice(0, 2).forEach(function(name, i) { g.set(name, (g.get(name) || 0) + plays * (i ? 0.5 : 1)); });
    });
    var top = Array.from(g.entries()).sort(function(x, y) { return y[1] - x[1]; });
    var all = top.reduce(function(sum, e) { return sum + e[1]; }, 0);
    a.genres = top.filter(function(e, i) { return e[1] > 0 && (i === 0 || e[1] >= all * 0.2); }).slice(0, ARTIST_GENRES).map(function(e) { return e[0]; });
    a.gv = top.map(function(e) { return [ix(genreIx, e[0]), e[1]]; });
    a.djs.forEach(function(n, dj) { var d = ix(djIx, dj); djArtists[d] = (djArtists[d] || 0) + 1; });
  });
  var G = genreIx.size;
  list.forEach(function(a, i) {
    // genres as a full row of numbers, DJs as a short sorted list: both of length 1
    var gv = new Float64Array(G), norm = 0;
    a.gv.forEach(function(e) { gv[e[0]] = e[1]; norm += e[1] * e[1]; });
    norm = Math.sqrt(norm);
    if (norm) for (var k = 0; k < G; k++) gv[k] /= norm;
    a.gv = gv;
    a.hasGenres = norm > 0;
    var dv = [];
    a.djs.forEach(function(n, dj) { var d = djIx.get(dj); dv.push([d, Math.log(1 + n) * Math.log(1 + list.length / djArtists[d])]); });
    dv.sort(function(x, y) { return x[0] - y[0]; });
    var dn = Math.sqrt(dv.reduce(function(sum, e) { return sum + e[1] * e[1]; }, 0));
    a.dk = Int32Array.from(dv.map(function(e) { return e[0]; }));
    a.dw = Float64Array.from(dv.map(function(e) { return dn ? e[1] / dn : 0; }));
    a.i = i;
    a.best = [];
  });
  // artists on a song together
  var together = new Set(); // "i_j", i < j
  var byTrack = new Map();
  list.forEach(function(a) { a.tracks.forEach(function(id) { if (!byTrack.has(id)) byTrack.set(id, []); byTrack.get(id).push(a.i); }); });
  byTrack.forEach(function(on) {
    for (var x = 0; x < on.length; x++) for (var y = x + 1; y < on.length; y++) together.add(Math.min(on[x], on[y]) + "_" + Math.max(on[x], on[y]));
  });
  var keep = function(a, other, score) {
    if (a.best.length >= ARTIST_SIMILAR && score <= a.best[a.best.length - 1][0]) return;
    a.best.push([score, other]);
    a.best.sort(function(x, y) { return y[0] - x[0] || y[1].plays - x[1].plays; });
    if (a.best.length > ARTIST_SIMILAR) a.best.pop();
  };
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    for (var j = i + 1; j < list.length; j++) {
      var b = list[j];
      var gs = 0;
      for (var k = 0; k < G; k++) gs += a.gv[k] * b.gv[k];
      var ds = 0, x = 0, y = 0;
      while (x < a.dk.length && y < b.dk.length) {
        if (a.dk[x] === b.dk[y]) ds += a.dw[x++] * b.dw[y++];
        else if (a.dk[x] < b.dk[y]) x++;
        else y++;
      }
      // an artist only one or two DJs play says little through them: lean on the genres
      var few = Math.min(a.dk.length, b.dk.length) < 3;
      var score = a.hasGenres && b.hasGenres ? (few ? 0.75 * gs + 0.25 * ds : 0.5 * gs + 0.5 * ds) : (few ? 0 : 0.8 * ds);
      if (together.size && together.has(i + "_" + j)) score = Math.min(1, score + 0.25);
      if (score < SIMILAR_MIN) continue;
      keep(a, b, score);
      keep(b, a, score);
    }
  }
  list.forEach(function(a) {
    a.similar = a.best.map(function(e) { return e[1]; });
    delete a.gv; delete a.dk; delete a.dw; delete a.best; delete a.hasGenres; delete a.i;
  });
}

/**
 * Build and (with write) save the library. Reads the room's users, tempos and
 * cards, and the year playlists from YouTube Music (no key or quota).
 */
/**
 * How new members found the room: the Discover page each one first landed
 * on (users/<uid>/foundVia, saved by the site when they join, including the
 * pages people reach from a search engine), counted by the month they joined.
 * Totals only: no names leave the run.
 * @param {Object} users - users/
 * @param {Object} [genres] - discover/lib/genres, for genre names
 * @returns {{months: Array<{month, joined, viaDiscover, pages: Array<[string, number]>}>}}
 */
function foundViaReport(users, genres) {
  genres = genres || {};
  var label = function(route) {
    var p = String(route || "").replace(/^#/, "").split("/");
    if (p[0] !== "discover") return "Somewhere else";
    var sub = p[2] ? decodeURIComponent(p.slice(2).join("/")) : "";
    switch (p[1] || "home") {
      case "home": return "Discover home";
      case "new": return "New releases";
      case "charts": return "Charts";
      case "recent": return "Recent plays";
      case "genres": return sub ? "Genre: " + ((genres[sub] && genres[sub].name) || sub) : "Genres";
      case "djs": return sub ? "DJ page" : "DJs";
      case "artist": return "Artist: " + sub;
      case "years": return sub ? "Year: " + sub : "Years";
      case "themes": return sub ? "A theme night" : "Theme nights";
      case "search": return "Search";
      default: return "Discover: " + p[1];
    }
  };
  var months = new Map();
  Object.keys(users || {}).forEach(function(uid) {
    var u = users[uid] || {};
    if (!u.joined || u.hostbot) return;
    var d = new Date(u.joined);
    var m = d.getFullYear() + "-" + (d.getMonth() < 9 ? "0" : "") + (d.getMonth() + 1);
    if (!months.has(m)) months.set(m, { month: m, joined: 0, viaDiscover: 0, pages: new Map() });
    var row = months.get(m);
    row.joined++;
    if (typeof u.foundVia !== "string" || !u.foundVia) return;
    row.viaDiscover++;
    // DJ pages are counted together, so a person's name never shows here
    var l = label(u.foundVia);
    row.pages.set(l, (row.pages.get(l) || 0) + 1);
  });
  return {
    months: Array.from(months.values()).sort(function(a, b) { return a.month < b.month ? 1 : -1; }).map(function(r) {
      return { month: r.month, joined: r.joined, viaDiscover: r.viaDiscover, pages: Array.from(r.pages.entries()).sort(function(a, b) { return b[1] - a[1]; }) };
    })
  };
}

/** found_via.csv, and a table in summary.md (before its details, so a public repository shows it too). */
function writeFoundVia(dir, report) {
  if (!dir) return;
  var csv = require("./csv");
  var rows = [];
  report.months.forEach(function(m) { m.pages.forEach(function(p) { rows.push([m.month, p[0], p[1]]); }); });
  csv.writeCsv(path.join(dir, "found_via.csv"), ["month", "first_page", "members"], rows);
  var file = path.join(dir, "summary.md");
  if (!fs.existsSync(file)) return;
  var recent = report.months.filter(function(m) { return m.viaDiscover; }).slice(0, 3);
  if (!recent.length) return;
  var lines = ["## how new members found the room", "The Discover page each new member first landed on, by the month they joined (found_via.csv).", "",
    "| month | joined | through Discover | top pages |", "|---|---|---|---|"];
  recent.forEach(function(m) {
    lines.push("| " + m.month + " | " + m.joined + " | " + m.viaDiscover + " | " + m.pages.slice(0, 5).map(function(p) { return p[0].replace(/\|/g, "/") + " (" + p[1] + ")"; }).join(", ") + " |");
  });
  var text = fs.readFileSync(file, "utf8").replace(/## how new members found the room[\s\S]*?(?=\n## |$)/, "").replace(/\n{3,}/g, "\n\n");
  var at = text.indexOf("## sources");
  text = at === -1 ? text + "\n" + lines.join("\n") + "\n" : text.slice(0, at) + lines.join("\n") + "\n\n" + text.slice(at);
  fs.writeFileSync(file, text);
}

async function publishLibrary(db, env, opts, log) {
  opts = opts || {};
  var c = opts.client || (opts.write ? require("./firebase").client(env) : null);
  var users = /** @type {Object<string, {username, publicName}>} */ ({});
  var bpm = /** @type {Object<string, {bpm}|number>} */ ({});
  var cards = /** @type {Object<string, {owner}>} */ ({});
  if (c) {
    log("library: reading users, tempos and cards...");
    users = (await c.get("users")) || {};
    bpm = (await c.get("bpm")) || {};
    cards = (await c.get("cards")) || {};
  }
  var years = opts.years;
  if (!years && opts.fetchYears !== false) {
    years = {};
    var ytmusic = require("../../lib/ytmusic");
    var ytmsync = require("../../lib/ytmsync");
    var sources = ytmsync.parseSources(env.YTMUSIC_SOURCES);
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.year) continue;
      try {
        var got = await ytmusic.playlistTracks(s.id);
        years[s.year] = got.tracks.map(function(t) { return { cid: t.cid, artist: t.artist, title: t.title }; });
        log("library: " + s.year + " playlist, " + got.tracks.length + " songs");
      } catch (e) {
        log("library: couldn't read the " + s.year + " playlist (" + e.message + "); its year page waits for the next run");
      }
    }
  }
  var built = buildLibrary(db, { users: users, bpm: bpm, cards: cards, years: years, dir: opts.dir, now: opts.now });
  var updates = built.updates;
  var found = foundViaReport(users, updates["discover/lib/genres"]);
  writeFoundVia(opts.dir, found);
  if (found.months.length && found.months[0].viaDiscover) {
    log("library: " + found.months[0].month + ": " + found.months[0].joined + " joined, " + found.months[0].viaDiscover + " through Discover (found_via.csv)");
  }
  log("library: " + built.counts.genres + " genres, " + built.counts.djs + " DJs, " + built.counts.artists + " artists, " + built.counts.years + " years, " + built.counts.songs + " songs to search" +
    (built.counts.repeats ? "; " + built.counts.repeats + " repeated songs left out of lists" : ""));
  if (!opts.write) {
    if (opts.dir) fs.writeFileSync(path.join(opts.dir, "library-preview.json"), JSON.stringify({ counts: built.counts, sample: Object.keys(updates).slice(0, 50) }, null, 1));
    log("library: nothing sent (add --write)");
    return built.counts;
  }
  // pages that are gone since the last run leave too
  for (var coll of ["genre", "genreYear", "dj", "artist", "year", "onThisDay", "songs"]) {
    var have = await c.keys("discover/lib/" + coll);
    have.forEach(function(k) {
      var p = "discover/lib/" + coll + "/" + k;
      if (!(p in updates)) updates[p] = null;
    });
  }
  var skipped = await require("./publish").writeAll(c, updates, log, true);
  if (skipped.length) log("library: " + skipped.length + " values refused (the first: " + skipped[0] + ")");
  log("library: saved");
  return built.counts;
}

module.exports = { buildLibrary: buildLibrary, publishLibrary: publishLibrary, foundViaReport: foundViaReport, writeFoundVia: writeFoundVia, slugOf: slugOf, usualTime: usualTime, readAxis: readAxis, similarArtists: similarArtists, readStories: readStories };
