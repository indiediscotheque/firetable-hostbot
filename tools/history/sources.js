// Bringing each source into the history database as observations (see
// store.js): the ADAM export, the room's Firebase database (live or from a
// JSON export), and Last.fm (live, or a CSV export of your scrobbles).
"use strict";
var fs = require("fs");
var store = require("./store");
var csv = require("./csv");
var fb = require("./firebase");
var tags = require("../../lib/tags");

// ------------------------------------------------------------------ ADAM

// Header names, simplified: "first DJ name" -> "first_dj_name"
function h(name) { return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); }
function pick(cols, patterns) {
  for (var p of patterns) {
    var hit = cols.find(function(c) { return p instanceof RegExp ? p.test(c) : c === p; });
    if (hit) return hit;
  }
  return null;
}

// ADAM wrote local times with no zone ("2018-09-22 9:06:57"); Sheets may have
// turned them into "9/22/2018 9:06:57". Read as if UTC; reconcile works out
// the real offset by lining them up with Last.fm.
function parseNaive(s) {
  s = String(s || "").trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?/i);
  if (m) {
    var hour = +(m[4] || 0);
    if (m[7] && /pm/i.test(m[7]) && hour < 12) hour += 12;
    if (m[7] && /am/i.test(m[7]) && hour === 12) hour = 0;
    return Date.UTC(+m[3], m[1] - 1, +m[2], hour, +(m[5] || 0), +(m[6] || 0));
  }
  if (/^\d{9,13}$/.test(s)) return Number(s) < 1e11 ? Number(s) * 1000 : Number(s);
  var t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Import one sheet of the ADAM export (CSV/TSV). Works out what the sheet is
 * from its columns: tracks (TRAX), plays, raw tags, artists or DJs; or pass
 * kind to say.
 */
async function importAdam(db, file, kind, log) {
  var w = store.obsWriter(db);
  var djName = db.prepare("INSERT INTO dj_names (source, id, name) VALUES ('adam', ?, ?) ON CONFLICT DO UPDATE SET name = excluded.name");
  var cols = null;
  var map = null;
  var skipped = 0;
  db.exec("BEGIN");
  var result = await csv.readCsv(file, function(raw, n) {
    if (!cols) {
      cols = {};
      Object.keys(raw).forEach(function(k) { cols[h(k)] = k; });
      map = adamColumns(Object.keys(cols), kind);
      log("  " + file + ": " + map.kind + " sheet (" + Object.keys(cols).join(", ") + ")");
      if (map.kind === "unknown") throw new Error("can't tell what " + file + " holds; pass --kind tracks|plays|raws|artists|djs");
    }
    var get = function(c) { return c ? String(raw[cols[c]] == null ? "" : raw[cols[c]]).trim() : ""; };
    if (map.kind === "tracks") {
      var id = get(map.id) || "row" + n;
      var artist = get(map.artist);
      var title = get(map.title);
      if (!artist && !title) { skipped++; return; }
      var extra = { adam: id };
      if (get(map.artistId)) extra.adam_artist = get(map.artistId);
      if (get(map.playcount)) extra.playcount = Number(get(map.playcount)) || undefined;
      w.add({ source: "adam", ref: "trax:" + id, artist: artist, title: title, role: "tag", weight: 2, extra: extra });
      [["first", map.firstDate, map.firstDj, map.firstDjId], ["last", map.lastDate, map.lastDj, map.lastDjId]].forEach(function(f) {
        var at = parseNaive(get(f[1]));
        if (at == null) return;
        var dj = get(f[2]) || get(f[3]);
        if (get(f[3]) && get(f[2])) djName.run(get(f[3]), get(f[2]));
        w.add({ source: "adam", ref: "trax:" + id + ":" + f[0], artist: artist, title: title, role: f[0], at: at, naive: true, dj: dj, extra: { adam: id } });
      });
    } else if (map.kind === "plays") {
      var at2 = parseNaive(get(map.date));
      if (at2 == null) { skipped++; return; }
      var tr = get(map.trackId);
      var song = splitRaw(get(map.raw));
      w.add({
        source: "adam", ref: "play:" + (get(map.id) || n), artist: get(map.artist) || song[0], title: get(map.title) || song[1],
        type: sourceType(get(map.source)), cid: cidOf(get(map.link)), role: "play", at: at2, naive: true,
        dj: get(map.dj) || get(map.djId), extra: tr ? { adam: tr } : null
      });
    } else if (map.kind === "raws") {
      var parts = splitRaw(get(map.raw));
      if (!parts[0]) { skipped++; return; }
      w.add({ source: "adam", ref: "raw:" + (get(map.id) || n), artist: parts[0], title: parts[1], role: "tag", weight: 0.5,
        type: sourceType(get(map.source)), cid: cidOf(get(map.link)), extra: get(map.trackId) ? { adam: get(map.trackId) } : null });
    } else if (map.kind === "djs") {
      if (get(map.id) && get(map.name)) djName.run(get(map.id), get(map.name));
    } else if (map.kind === "artists") {
      // artist names by id: used to label ADAM plays that only have ids
      if (get(map.id) && get(map.name)) {
        db.prepare("INSERT INTO dj_names (source, id, name) VALUES ('adam-artist', ?, ?) ON CONFLICT DO UPDATE SET name = excluded.name").run(get(map.id), get(map.name));
      }
    }
    if (n % 50000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); log("    " + n + " rows"); }
  }).catch(function(e) { db.exec("ROLLBACK"); throw e; });
  db.exec("COMMIT");
  return { rows: result.rows, written: w.count(), skipped: skipped, kind: map && map.kind };
}

function adamColumns(c, kind) {
  var m = {
    id: pick(c, ["id", "track_id", "play_id"]),
    artist: pick(c, ["artist_name", "artist", "artistname"]),
    artistId: pick(c, ["artist_id"]),
    title: pick(c, ["track_name", "title", "name", "track", "song"]),
    playcount: pick(c, ["playcount", "play_count", "plays"]),
    firstDate: pick(c, ["first_play_date", /^first.*date/]),
    firstDj: pick(c, ["first_dj_name", /^first.*dj.*name/]),
    firstDjId: pick(c, ["first_play_dj", /^first.*dj$/]),
    lastDate: pick(c, ["last_play_date", /^last.*date/]),
    lastDj: pick(c, ["last_dj_name", /^last.*dj.*name/]),
    lastDjId: pick(c, ["last_play_dj", /^last.*dj$/]),
    date: pick(c, ["date", "played_at", "play_date", "time", "timestamp", "created_at", "created", "when"]),
    dj: pick(c, ["dj_name", "dj", "username", "user"]),
    djId: pick(c, ["dj_id", "user_id"]),
    trackId: pick(c, ["track_id", "trackid"]),
    raw: pick(c, ["song_name", "raw", "raw_name", "string"]),
    link: pick(c, ["link", "cid", "url", "video_id"]),
    source: pick(c, ["source", "type", "platform"]),
    name: pick(c, ["name", "username", "dj_name", "artist_name"])
  };
  if (kind) m.kind = kind;
  else if (m.firstDate || m.lastDate || (m.artist && m.title && !m.date)) m.kind = "tracks";
  else if (m.date && (m.trackId || m.raw || m.title)) m.kind = "plays";
  else if (m.raw) m.kind = "raws";
  else if (m.id && m.name && c.length <= 4) m.kind = /dj|user/.test(c.join(",")) ? "djs" : "artists";
  else m.kind = "unknown";
  if (m.kind === "plays" && m.id === m.trackId) m.id = null;
  return m;
}

function splitRaw(s) {
  var p = tags.parse(s, null);
  return p.title ? [s.slice(0, s.indexOf(" - ")) || p.artist, s.slice(s.indexOf(" - ") + 3)] : [s, ""];
}
function sourceType(s) {
  s = String(s || "").toLowerCase();
  if (s === "1" || s.indexOf("youtube") !== -1 || s === "yt") return 1;
  if (s === "2" || s.indexOf("soundcloud") !== -1 || s === "sc") return 2;
  return null;
}
// a YouTube/SoundCloud id from a link (or the id itself)
function cidOf(link) {
  link = String(link || "").trim();
  if (!link) return null;
  var yt = link.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  if (yt) return yt[1];
  var sc = link.match(/api\.soundcloud\.com\/tracks\/(\d+)|soundcloud:tracks:(\d+)/);
  if (sc) return sc[1] || sc[2];
  return /^[A-Za-z0-9_-]{6,64}$/.test(link) ? link : null;
}

// --------------------------------------------------------------- Firebase

// What each part of the room's database tells us. `node` is that path's
// whole value (from an export file or a live read).
var FIREBASE_PATHS = {
  globalTracks: function(node, w) {
    each(node, function(key, v) {
      if (!v || typeof v !== "object") return;
      var type = /^[12]/.test(key) ? Number(key[0]) : null;
      var cid = type ? key.slice(1) : null;
      // the room's current tags for this upload: chosen by the bot or fixed by a mod
      w.add({ source: "fb:globalTracks", ref: key, artist: v.artist, title: v.title, type: type, cid: cid, role: "tag", weight: 4, extra: v.song ? { song: v.song } : null });
      if (v.first_play_date) w.add({ source: "fb:globalTracks", ref: key + ":first", artist: v.artist, title: v.title, type: type, cid: cid, role: "first", at: Number(v.first_play_date), dj: v.first_play_dj });
      if (v.last_play_date && v.last_play_date !== v.first_play_date) w.add({ source: "fb:globalTracks", ref: key + ":last", artist: v.artist, title: v.title, type: type, cid: cid, role: "last", at: Number(v.last_play_date), dj: v.last_play_dj });
    });
  },
  songHistory: function(node, w) { plays(node, w, "fb:songHistory"); },
  newMusic: function(node, w) { plays(node, w, "fb:newMusic"); },
  playLog: function(node, w) {
    each(node, function(key, v) {
      if (!v || !v.k) return;
      w.add({ source: "fb:playLog", ref: key, artist: v.a, title: v.t, type: Number(String(v.k)[0]) || null, cid: String(v.k).slice(1), role: "play", at: Number(v.w), dj: v.dj, weight: 1, extra: v.s ? { song: v.s } : null });
    });
  },
  tagLog: function(node, w) {
    each(node, function(key, v) {
      if (!v || !v.k) return;
      var type = Number(String(v.k)[0]) || null;
      var cid = String(v.k).slice(1);
      // a person fixed these tags on purpose: they count most
      w.add({ source: "fb:tagLog", ref: key, artist: v.a, title: v.t, type: type, cid: cid, role: "tag", at: Number(v.at) || null, dj: v.by, weight: 6 });
      if (v.fa || v.ft) w.add({ source: "fb:tagLog", ref: key + ":from", artist: v.fa, title: v.ft, type: type, cid: cid, role: "tag", weight: 0.25 });
    });
  },
  playlists: function(node, w) {
    each(node, function(uid, lists) {
      each(lists, function(plid, pl) {
        each(pl && pl.list, function(k, t) { listEntry(w, "fb:playlists", uid + "/" + plid + "/" + k, uid, t); });
      });
    });
  },
  queues: function(node, w) {
    each(node, function(uid, q) {
      each(q, function(k, t) { listEntry(w, "fb:queues", uid + "/" + k, uid, t); });
    });
  },
  // Paths with no code behind them (an ADAM import that may or may not have
  // happened). Anything that looks like a tag is read; the shapes are logged.
  globalTrackRaws: function(node, w, log) { generic(node, w, "fb:globalTrackRaws", log); },
  globalArtists: function(node, w, log) { generic(node, w, "fb:globalArtists", log); },
  globalDjs: function(node, w, log) { generic(node, w, "fb:globalDjs", log); }
};

function each(obj, fn) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) obj.forEach(function(v, i) { if (v != null) fn(String(i), v); });
  else Object.keys(obj).forEach(function(k) { fn(k, obj[k]); });
}
function plays(node, w, source) {
  each(node, function(key, v) {
    if (!v || !v.cid || !v.when) return;
    w.add({ source: source, ref: key, artist: v.artist, title: v.title, type: v.type, cid: v.cid, role: "play", at: Number(v.when), dj: v.dj || v.djid });
  });
}
function listEntry(w, source, ref, uid, t) {
  if (!t || !t.cid || !t.name) return;
  var sep = String(t.name).indexOf(" - ");
  w.add({ source: source, ref: ref, artist: sep > 0 ? t.name.slice(0, sep) : t.name, title: sep > 0 ? t.name.slice(sep + 3) : "", type: t.type, cid: t.cid, role: "tag", weight: 0.5, dj: uid });
}
function generic(node, w, source, log) {
  var shapes = {};
  var n = 0;
  each(node, function(key, v) {
    var shape = v && typeof v === "object" ? Object.keys(v).sort().join(",") : typeof v;
    shapes[shape] = (shapes[shape] || 0) + 1;
    if (!v || typeof v !== "object") return;
    var artist = v.artist || v.artist_name || v.artistName;
    var title = v.title || v.track_name || v.trackName || v.track || (artist ? v.name : null);
    var raw = v.song_name || v.raw;
    if (!artist && raw) { var p = splitRaw(raw); artist = p[0]; title = p[1]; }
    if (!artist || !title) return;
    n++;
    w.add({ source: source, ref: key, artist: artist, title: title, role: "tag", weight: 1.5,
      type: /^[12]/.test(key) && key.length > 6 ? Number(key[0]) : null, cid: /^[12]/.test(key) && key.length > 6 ? key.slice(1) : null,
      extra: { id: key } });
    var f = v.first_play_date || v.first_play;
    if (f) w.add({ source: source, ref: key + ":first", artist: artist, title: title, role: "first", at: Number(f) || Date.parse(f), dj: v.first_play_dj });
  });
  log && log("  " + source + ": " + Object.keys(node || {}).length + " entries, " + n + " used as tags; shapes: " +
    Object.entries(shapes).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5).map(function(e) { return "{" + e[0] + "}×" + e[1]; }).join("  "));
}

// Mods' answers to the tag questions in chat (!same / !different)
var reviewAnswers = function(db, node) {
  var ins = db.prepare("INSERT INTO decisions (a, b, decision, note, decided_at) VALUES (?,?,?,?,?) ON CONFLICT(a, b) DO UPDATE SET decision = excluded.decision, note = excluded.note, decided_at = excluded.decided_at");
  var n = 0;
  each(node, function(id, q) {
    if (!q || !q.a_key || !q.b_key || (q.decision !== "merge" && q.decision !== "separate")) return;
    var a = q.a_key < q.b_key ? q.a_key : q.b_key;
    var b = q.a_key < q.b_key ? q.b_key : q.a_key;
    ins.run(a, b, q.decision, "chat: " + (q.by || "a mod") + " | " + q.a + " | " + q.b, Number(q.at) || Date.now());
    n++;
  });
  return n;
};

function usersToNames(db, node) {
  var ins = db.prepare("INSERT INTO dj_names (source, id, name) VALUES ('fb', ?, ?) ON CONFLICT DO UPDATE SET name = excluded.name");
  each(node, function(uid, u) { if (u && u.username) ins.run(uid, String(u.username)); });
}

// A Firebase console export (Realtime Database -> ⋮ -> Export JSON), whole or
// any of the paths above.
function importFirebaseFile(db, file, log) {
  var root = JSON.parse(fs.readFileSync(file, "utf8"));
  var counts = {};
  store.tx(db, function() {
    var w = store.obsWriter(db);
    Object.keys(FIREBASE_PATHS).forEach(function(p) {
      if (root[p] == null) return;
      var before = w.count();
      FIREBASE_PATHS[p](root[p], w, log);
      counts[p] = w.count() - before;
    });
    if (root.users) usersToNames(db, root.users);
    if (root.tagReview) counts.reviewAnswers = reviewAnswers(db, root.tagReview);
  });
  return counts;
}

// The same, read live as the bot. Playlists and queues are read DJ by DJ.
async function fetchFirebase(db, env, opts, log) {
  var c = fb.client(env);
  var counts = {};
  var only = opts.only ? opts.only.split(",") : null;
  var want = function(p) { return !only || only.indexOf(p) !== -1; };

  log("signing in as the bot...");
  var users = await c.get("users", {});
  store.tx(db, function() { usersToNames(db, users); });
  log("  " + Object.keys(users || {}).length + " users");

  for (var p of ["globalTracks", "songHistory", "newMusic", "playLog", "tagLog", "globalTrackRaws", "globalArtists", "globalDjs"]) {
    if (!want(p)) continue;
    try {
      var node = {};
      if (p === "globalTracks" || p === "playLog") {
        await c.getPaged(p, 20000, function(page) { Object.assign(node, page); log("  " + p + ": " + Object.keys(node).length + "..."); });
      } else {
        node = await c.get(p);
      }
      counts[p] = writeNode(db, p, node, log);
      log("  " + p + ": " + counts[p] + " observations");
    } catch (e) {
      log("  " + p + ": skipped (" + e.message + ")");
    }
  }
  try {
    var answers = await c.get("tagReview");
    counts.reviewAnswers = store.tx(db, function() { return reviewAnswers(db, answers); });
    if (counts.reviewAnswers) log("  " + counts.reviewAnswers + " tag answers from mods");
  } catch (e) {
    log("  tagReview: skipped (" + e.message + ")");
  }
  for (var lp of ["playlists", "queues"]) {
    if (!want(lp)) continue;
    var uids = Object.keys(users || {});
    var total = 0;
    var denied = 0;
    for (var i = 0; i < uids.length; i += 8) {
      var batch = uids.slice(i, i + 8);
      var got = await Promise.all(batch.map(function(uid) {
        return c.get(lp + "/" + uid).catch(function(e) { if (e.denied) denied++; return null; });
      }));
      var node2 = {};
      batch.forEach(function(uid, j) { if (got[j]) node2[uid] = got[j]; });
      total += writeNode(db, lp, node2, null);
      if (i % 400 === 0) log("  " + lp + ": " + Math.min(i + 8, uids.length) + "/" + uids.length + " DJs");
    }
    counts[lp] = total;
    log("  " + lp + ": " + total + " observations" + (denied ? " (" + denied + " DJs not readable)" : ""));
  }
  return counts;
}

function writeNode(db, p, node, log) {
  return store.tx(db, function() {
    var w = store.obsWriter(db);
    FIREBASE_PATHS[p](node, w, log);
    return w.count();
  });
}

// ---------------------------------------------------------------- Last.fm

var LASTFM_API = "https://ws.audioscrobbler.com/2.0/";

async function lastfmCall(params, apiKey) {
  var url = new URL(LASTFM_API);
  Object.keys(params).forEach(function(k) { if (params[k] != null) url.searchParams.set(k, params[k]); });
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  for (var attempt = 0; ; attempt++) {
    try {
      var res = await fetch(url, { headers: { "User-Agent": "firetable-history/1.0" }, signal: AbortSignal.timeout(30000) });
      var j = await res.json().catch(function() { return null; });
      if (j && j.error) {
        // 29 rate limit, 8/16 temporary, 11 offline: wait and try again
        if ([8, 11, 16, 29].indexOf(j.error) !== -1 && attempt < 8) { await fb.sleep(2000 * Math.pow(2, Math.min(attempt, 5))); continue; }
        var err = new Error("Last.fm error " + j.error + ": " + j.message);
        err.code = j.error;
        throw err;
      }
      if (!res.ok || !j) throw new Error("Last.fm answered " + res.status);
      return j;
    } catch (e) {
      if (e.code || attempt >= 8) throw e;
      await fb.sleep(2000 * Math.pow(2, Math.min(attempt, 5)));
    }
  }
}

/**
 * Download every scrobble of a Last.fm user, 200 at a time. Safe to stop: it
 * carries on from the same page next time, and later runs only fetch what's
 * new. About 5,000 pages per million scrobbles (~25 minutes).
 */
async function fetchLastfm(db, apiKey, user, log) {
  if (!apiKey || !user) throw new Error("needs LASTFM_APIKEY and a Last.fm user (LASTFM_USERNAME or --user)");
  var key = "lastfm:" + user.toLowerCase();
  var st = store.getState(db, key) || {};
  if (!st.running) st = { running: true, to: Math.floor(Date.now() / 1000), from: st.done_to ? st.done_to + 1 : null, page: 1, done_to: st.done_to || null };
  var source = "lastfm:" + user.toLowerCase();
  var started = Date.now();
  var startPage = st.page;
  for (;;) {
    var j = await lastfmCall({ method: "user.getrecenttracks", user: user, limit: 200, page: st.page, to: st.to, from: st.from }, apiKey);
    var rt = j.recenttracks || {};
    var list = [].concat(rt.track || []);
    var attr = rt["@attr"] || {};
    var pages = Number(attr.totalPages) || 0;
    store.tx(db, function() {
      var w = store.obsWriter(db);
      list.forEach(function(t) {
        if (!t.date || (t["@attr"] && t["@attr"].nowplaying)) return;
        var artist = t.artist && (t.artist["#text"] || t.artist.name);
        var uts = Number(t.date.uts);
        var extra = {};
        if (t.artist && t.artist.mbid) extra.amb = t.artist.mbid;
        if (t.mbid) extra.tmb = t.mbid;
        if (t.album && t.album["#text"]) extra.album = t.album["#text"];
        w.add({ source: source, ref: uts + "|" + artist + "|" + t.name, artist: artist, title: t.name, role: "play", at: uts * 1000, weight: 1, extra: extra });
      });
      st.page++;
      st.pages = pages;
      store.setState(db, key, st);
    });
    if (st.page % 25 === 0 || st.page > pages) {
      var rate = (st.page - startPage) / ((Date.now() - started) / 1000);
      var left = Math.max(0, pages - st.page + 1);
      log("  " + user + ": page " + Math.min(st.page - 1, pages) + "/" + pages + (left && rate ? " (about " + Math.ceil(left / rate / 60) + " min left)" : ""));
    }
    if (st.page > pages || !list.length) break;
    await fb.sleep(250); // Last.fm asks for no more than 5 calls a second
  }
  store.setState(db, key, { done_to: st.to });
  return db.prepare("SELECT count(*) n FROM obs WHERE source = ?").get(source).n;
}

/**
 * A CSV of scrobbles from an export site (e.g. lastfm.ghan.nl/export,
 * benjaminbenben.com/lastfm-to-csv): artist, track/title, and a date or uts.
 */
async function importLastfmCsv(db, file, user, log) {
  var source = "lastfm:" + String(user || "csv").toLowerCase();
  var cols = null;
  var skipped = 0;
  db.exec("BEGIN");
  var w = store.obsWriter(db);
  var res = await csv.readCsv(file, function(raw, n) {
    if (!cols) {
      cols = {};
      Object.keys(raw).forEach(function(k) { cols[h(k)] = k; });
      var c = Object.keys(cols);
      cols.$artist = pick(c, ["artist", "artist_name", "artist_text"]) || Object.keys(raw)[0];
      cols.$title = pick(c, ["track", "title", "name", "track_name", "song"]) || Object.keys(raw)[2];
      cols.$date = pick(c, ["uts", "date_uts", "timestamp", "date", "time", "played_at", "scrobble_time"]) || Object.keys(raw)[3];
      cols.$album = pick(c, ["album", "album_name", "album_text"]);
      cols.$amb = pick(c, ["artist_mbid"]);
      cols.$tmb = pick(c, ["track_mbid", "mbid"]);
    }
    var g = function(k) { return cols[k] ? String(raw[cols[cols[k]]] != null ? raw[cols[cols[k]]] : raw[cols[k]] || "").trim() : ""; };
    var artist = g("$artist");
    var title = g("$title");
    var d = g("$date");
    var at = /^\d{9,13}$/.test(d) ? (Number(d) < 1e11 ? Number(d) * 1000 : Number(d)) : Date.parse(/[zZ]|[+-]\d\d:?\d\d$|UTC|GMT/.test(d) ? d : d + " UTC");
    if (!artist || !title || !Number.isFinite(at)) { skipped++; return; }
    var extra = {};
    if (g("$album")) extra.album = g("$album");
    if (g("$amb")) extra.amb = g("$amb");
    if (g("$tmb")) extra.tmb = g("$tmb");
    w.add({ source: source, ref: Math.floor(at / 1000) + "|" + artist + "|" + title, artist: artist, title: title, role: "play", at: at, extra: extra });
    if (n % 50000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); log("    " + n + " rows"); }
  }).catch(function(e) { db.exec("ROLLBACK"); throw e; });
  db.exec("COMMIT");
  return { rows: res.rows, written: w.count(), skipped: skipped };
}

/**
 * Ask Last.fm how it spells the room's artists ("beyonce" -> "Beyoncé",
 * "FOALS" -> "Foals"), most-played first. Answers are kept, so this can be
 * stopped and re-run; reconcile uses them to join artist spellings.
 */
async function enrichArtists(db, apiKey, limit, log) {
  if (!apiKey) throw new Error("needs LASTFM_APIKEY");
  var seen = new Set(db.prepare("SELECT query FROM lookups WHERE kind = 'artist'").all().map(function(r) { return r.query; }));
  var names = db.prepare(`SELECT artist, count(*) n FROM obs WHERE artist IS NOT NULL GROUP BY artist ORDER BY n DESC`).all();
  var byKey = new Map();
  names.forEach(function(r) {
    tags.splitArtists(tags.parse(r.artist, "x").artist).forEach(function(a) {
      var k = tags.artistKeyOf(a);
      var cur = byKey.get(k);
      if (!cur) byKey.set(k, { name: a, n: r.n });
      else cur.n += r.n;
    });
  });
  var todo = Array.from(byKey.values()).filter(function(x) { return !seen.has(x.name); }).sort(function(a, b) { return b.n - a.n; }).slice(0, limit);
  var ins = db.prepare("INSERT OR REPLACE INTO lookups (kind, query, result, fetched_at) VALUES ('artist', ?, ?, ?)");
  log("asking Last.fm about " + todo.length + " artists...");
  for (var i = 0; i < todo.length; i++) {
    var result = null;
    try {
      var j = await lastfmCall({ method: "artist.getcorrection", artist: todo[i].name }, apiKey);
      var corr = j.corrections && j.corrections.correction;
      corr = Array.isArray(corr) ? corr[0] : corr;
      if (corr && corr.artist && corr.artist.name) result = { name: corr.artist.name, mbid: corr.artist.mbid || null };
    } catch (e) {
      if (e.code !== 6) log("  " + todo[i].name + ": " + e.message);
    }
    ins.run(todo[i].name, result ? JSON.stringify(result) : null, Date.now());
    if ((i + 1) % 200 === 0) log("  " + (i + 1) + "/" + todo.length);
    await fb.sleep(220);
  }
  return todo.length;
}

module.exports = {
  importAdam: importAdam,
  importFirebaseFile: importFirebaseFile,
  fetchFirebase: fetchFirebase,
  fetchLastfm: fetchLastfm,
  importLastfmCsv: importLastfmCsv,
  enrichArtists: enrichArtists,
  parseNaive: parseNaive,
  cidOf: cidOf,
  FIREBASE_PATHS: FIREBASE_PATHS
};
