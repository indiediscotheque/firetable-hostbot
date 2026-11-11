// Discover's library pages, from the reconciled history: genres, DJs, artists,
// years and the Rising and On this day shelves. The site reads them, so they
// are public (discover/ in firebase-rules.json); only the bot's account
// writes them. Written by `publish --write` (and `library --write` alone):
//
//   discover/lib/meta              when, and how many of each
//   discover/lib/genres            every genre: name, songs, plays, usual BPM,
//                                  first year, DJs, map position, covers, next door
//   discover/lib/genre/<slug>      favorites, new here, deep cuts, by year, who plays it
//   discover/lib/djs               DJs with 25+ plays: name, plays, firsts, top genres
//   discover/lib/dj/<key>          taste, most played, brought here first, similar
//                                  DJs, when they play, recent sets, cards
//   discover/lib/artistIndex       artist slug -> [name, plays] (the 5,000 most played)
//   discover/lib/artist/<slug>     their songs here, who plays them, first play
//   discover/lib/years             each year playlist: songs, room plays, top genre
//   discover/lib/year/<year>       most played from that year, and finds not played yet
//   discover/lib/rising            plays up most, the last 4 weeks against the 4 before
//   discover/lib/onThisDay/<MM-DD> songs first played here on this day in past years
//
// People who turned off "Show my name on public pages" (users/<uid>/
// publicName = false) have no DJ page and show as nobody on songs.
"use strict";
var fs = require("fs");
var path = require("path");
var tags = require("../../lib/tags");
var genres = require("./genres");

var DAY = 86400000;
var ROWS = { fav: 100, newHere: 50, deep: 50, dj: 30, artist: 25, year: 40, yearMore: 24, rising: 20, onThisDay: 8 };
var DJ_MIN_PLAYS = 25;
var ARTIST_MIN_PLAYS = 5;
var ARTIST_MAX = 5000;
var SET_GAP = 2 * 3600 * 1000;
var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A short, readable, URL-safe key: "Nu-Disco" -> "nu-disco", "Röyksopp" -> "royksopp". */
function slugOf(s) {
  var out = tags.fold(String(s || "")).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, 60) || "x" + tags.hash(String(s)).slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "0");
}

/** The sound map's across axis, from genre-axis.csv (0 band-made .. 1 machine-made). */
function readAxis(dir) {
  var out = {};
  [path.join(__dirname, "genre-axis.csv"), dir ? path.join(dir, "genre-axis.csv") : null].forEach(function(f) {
    if (!f || !fs.existsSync(f)) return;
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach(function(line) {
      if (!line.trim() || /^#/.test(line) || /^genre,/.test(line)) return;
      var i = line.lastIndexOf(",");
      var v = Number(line.slice(i + 1));
      if (i > 0 && isFinite(v)) out[line.slice(0, i).trim()] = Math.max(0, Math.min(1, v));
    });
  });
  return out;
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
    var u = users[uid] || {};
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
  var whoOf = function(name) {
    if (!name || hiddenDj(name)) return {};
    return { dj: name, djid: uidOfDj.get(name) || null };
  };

  // ---------------------------------------------------------------- tracks
  var tracks = new Map();
  db.prepare("SELECT id, artist, title, plays, first_play_at, first_play_dj, last_play_at FROM tracks WHERE plays > 0").all().forEach(function(t) {
    tracks.set(t.id, t);
  });
  // a playable upload for each: the one played last, else any
  var uploadOf = new Map();
  db.prepare("SELECT track_id, type, cid, max(at) at FROM plays WHERE cid IS NOT NULL AND cid != '' GROUP BY track_id").all().forEach(function(u) {
    uploadOf.set(u.track_id, { type: Number(u.type) || 1, cid: String(u.cid) });
  });
  var uploadsByTrack = new Map();
  db.prepare("SELECT track_id, type, cid FROM uploads").all().forEach(function(u) {
    if (!u.cid) return;
    if (!uploadOf.has(u.track_id)) uploadOf.set(u.track_id, { type: Number(u.type) || 1, cid: String(u.cid) });
    if (!uploadsByTrack.has(u.track_id)) uploadsByTrack.set(u.track_id, []);
    uploadsByTrack.get(u.track_id).push(u);
  });
  var row = function(id, extra) {
    var t = tracks.get(id);
    var up = uploadOf.get(id);
    if (!t || !up) return null;
    return Object.assign({ type: up.type, cid: up.cid, a: t.artist || "", t: t.title || "", plays: t.plays || 0, first: t.first_play_at || null }, whoOf(t.first_play_dj), extra || {});
  };
  var rows = function(ids, max, extraOf) {
    var out = [];
    for (var i = 0; i < ids.length && out.length < max; i++) {
      var r = row(ids[i], extraOf ? extraOf(ids[i]) : null);
      if (r) out.push(r);
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
    if (hiddenDj(dj)) return;
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
    genreIndex[sl] = {
      name: name, songs: gi.tracks.length, plays: gi.plays, bpm: median(gi.bpms), first: isFinite(gi.first) ? new Date(gi.first).getFullYear() : null,
      djs: gi.djs.size, x: axis[name] == null ? 0.5 : axis[name], covers: covers, next: next
    };
    var years = {};
    gi.tracks.forEach(function(id) { var f = tracks.get(id).first_play_at; if (f) { var y = new Date(f).getFullYear(); years[y] = (years[y] || 0) + 1; } });
    updates["discover/lib/genre/" + sl] = {
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
  var eligible = djRows.filter(function(d) { return (d.plays || 0) >= DJ_MIN_PLAYS && !hiddenDj(d.name) && djTrack.has(d.name); });
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
    if (hiddenDj(dj)) return;
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
    artistIndex[sl] = [name, a.plays];
    updates["discover/lib/artist/" + sl] = Object.assign({
      name: name, plays: a.plays, songs: a.tracks.length, first: isFinite(a.first) ? a.first : null,
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
  Object.keys(opts.years || {}).forEach(function(year) {
    var list = opts.years[year] || [];
    var played = [];
    var unplayed = [];
    var plays = 0;
    var genreCount = new Map();
    var seen = new Set();
    list.forEach(function(it) {
      if (!it || !it.cid || seen.has(it.cid)) return;
      seen.add(it.cid);
      var id = trackOfUpload.get("1_" + it.cid);
      var t = id && tracks.get(id);
      if (t) {
        played.push(id);
        plays += t.plays || 0;
        (genreOf.get(id) || []).slice(0, 1).forEach(function(g) { genreCount.set(g, (genreCount.get(g) || 0) + (t.plays || 0)); });
      } else {
        unplayed.push({ type: 1, cid: it.cid, a: it.artist || "", t: it.title || "", plays: 0 });
      }
    });
    var top = Array.from(genreCount.entries()).sort(function(a, b) { return b[1] - a[1]; })[0];
    yearIndex[year] = { songs: seen.size, plays: plays, played: played.length, genre: top ? top[0] : null };
    // finds not played here yet: spread across the list, the same each week
    var step = Math.max(1, Math.floor(unplayed.length / ROWS.yearMore));
    var more = [];
    for (var i = 0; i < unplayed.length && more.length < ROWS.yearMore; i += step) more.push(unplayed[i]);
    updates["discover/lib/year/" + year] = { top: rows(played.sort(byPlays), ROWS.year), more: more };
  });
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

  updates["discover/lib/meta"] = { at: now, genres: counts.genres, djs: counts.djs, artists: counts.artists, years: counts.years };
  return { updates: updates, counts: counts };
}

/**
 * Build and (with write) save the library. Reads the room's users, tempos and
 * cards, and the year playlists from YouTube Music (no key or quota).
 */
async function publishLibrary(db, env, opts, log) {
  opts = opts || {};
  var c = opts.client || (opts.write ? require("./firebase").client(env) : null);
  var users = {};
  var bpm = {};
  var cards = {};
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
  log("library: " + built.counts.genres + " genres, " + built.counts.djs + " DJs, " + built.counts.artists + " artists, " + built.counts.years + " years");
  if (!opts.write) {
    if (opts.dir) fs.writeFileSync(path.join(opts.dir, "library-preview.json"), JSON.stringify({ counts: built.counts, sample: Object.keys(updates).slice(0, 50) }, null, 1));
    log("library: nothing sent (add --write)");
    return built.counts;
  }
  // pages that are gone since the last run leave too
  for (var coll of ["genre", "dj", "artist", "year", "onThisDay"]) {
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

module.exports = { buildLibrary: buildLibrary, publishLibrary: publishLibrary, slugOf: slugOf, usualTime: usualTime, readAxis: readAxis };
