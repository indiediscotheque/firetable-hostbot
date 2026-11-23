// Discover: the public data the site's Discover side needs and can't read for
// itself. Everything visitors read is written here, under discover/ (readable
// by anyone, written only by the bot); the bot's own working data sits under
// discoverCache/ (bot only).
//
//   discover/charts/<period>/<id>  room charts: week (2026-W45), month
//                                  (2026-11), year (2026) and all (all time)
//   discover/chartIds/<period>/<id> = true   the charts that exist, newest last
//   discover/new                   new releases: library songs released in
//                                  the last 90 days, played here or not
//   discover/themes/...            theme nights (index, and each night)
//   discover/fires                 each DJ's fires earned and most-fired songs
//   discoverCache/release/<cid>    each library track's release date
//   discoverCache/colors/<cid>     its artwork colours (false: none)
//
// Every row names a song the room's way: the tags the room has for its upload
// (globalTracks: a mod's fix, or what its plays saved) replace the ones it was
// built from (a play's, or YouTube Music's for a new release), and a mod's fix
// goes on what's already published at once (retag).
//
// Charts count plays from playLog (only the bot can read it). A play counts
// when the song ran out or played for 30 seconds or more. Charts count plays
// only: fires never change a chart. People who turned off "Show my name on
// public pages" (users/<uid>/publicName = false) appear as nobody here.
//
// What it costs: the database bills every byte it sends. The recent play log
// is kept in memory (playLogWindow: one listener, downloaded once at start,
// then only new plays), so the chart after each song reads nothing. Longer
// spans (the year, theme nights, fires) are read once a day, in one read the
// daily jobs share. Nothing is rewritten unless it changed: every browser
// with Discover open is sent each write.
"use strict";
var tags = require("./tags");

var DAY = 86400000;
var CHART_ROWS = 40;
var NEW_DAYS = 90;
var NEW_MAX = 200;
var MIN_PLAY_SECONDS = 30;
var ALL_TIME = "discover/charts/all/all"; // named the history's way, not by upload

// ------------------------------------------------------------- periods
// In the bot's time zone (TZ): a chart week runs Monday 00:00 to Monday 00:00.

function pad(n) { return (n < 10 ? "0" : "") + n; }

function mondayOf(ms) {
  var d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** The ISO week a moment falls in, e.g. "2026-W45". */
function weekId(ms) {
  var thu = mondayOf(ms);
  thu.setDate(thu.getDate() + 3); // the week belongs to the year of its Thursday
  var year = thu.getFullYear();
  var jan4 = mondayOf(new Date(year, 0, 4).getTime());
  var week = 1 + Math.round((mondayOf(ms).getTime() - jan4.getTime()) / (7 * DAY));
  return year + "-W" + pad(week);
}
function monthId(ms) { var d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
function yearId(ms) { return String(new Date(ms).getFullYear()); }

/** {from, to} in ms for a period id ("2026-W45", "2026-11", "2026"). */
function rangeOf(period, id) {
  var m;
  if (period === "week" && (m = /^(\d{4})-W(\d\d)$/.exec(id))) {
    var from = mondayOf(new Date(Number(m[1]), 0, 4).getTime());
    from.setDate(from.getDate() + (Number(m[2]) - 1) * 7);
    var to = new Date(from.getTime());
    to.setDate(to.getDate() + 7);
    return { from: from.getTime(), to: to.getTime() };
  }
  if (period === "month" && (m = /^(\d{4})-(\d\d)$/.exec(id))) {
    return { from: new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime(), to: new Date(Number(m[1]), Number(m[2]), 1).getTime() };
  }
  if (period === "year" && (m = /^(\d{4})$/.exec(id))) {
    return { from: new Date(Number(m[1]), 0, 1).getTime(), to: new Date(Number(m[1]) + 1, 0, 1).getTime() };
  }
  return null;
}
var idOf = { week: weekId, month: monthId, year: yearId };

/** The period before this one (for movement and finishing last week). */
function previousId(period, id) {
  var r = rangeOf(period, id);
  return r ? idOf[period](r.from - 1) : null;
}

// --------------------------------------------------------------- charts

/** Does this playLog entry count as a play? */
function counts(e) {
  if (!e || !e.k || typeof e.w !== "number") return false;
  return !e.sk || (typeof e.p === "number" && e.p >= MIN_PLAY_SECONDS);
}

/**
 * The upload to play for a track (globalSongs/<id>): the latest played of
 * those the room tags as the track's own version, else the latest played.
 * @param {{artist?, title?}} song
 * @param {Object<string, {artist?, title?, last_play_date?}>} uploads - globalTracks entries by key
 * @returns {string|null} the upload's key ("1<cid>")
 */
function pickUpload(song, uploads) {
  var version = song && song.title ? tags.keysOf(tags.parse(song.artist || "", song.title)).version : null;
  var best = null;
  var bestFits = false;
  var bestAt = -1;
  Object.keys(uploads || {}).forEach(function(k) {
    var u = uploads[k] || {};
    var fits = version == null || !u.title || tags.sameVersion(version, tags.keysOf(tags.parse(u.artist || "", u.title)).version);
    var at = Number(u.last_play_date) || 0;
    if (best === null || (fits && !bestFits) || (fits === bestFits && at > bestAt)) { best = k; bestFits = fits; bestAt = at; }
  });
  return best;
}

/**
 * A chart from playLog entries: one row per song (the history's song id, or
 * the upload when the history doesn't know it), most plays first, then the
 * most recently played. Each row names the DJ who played it most.
 * @param {Array<object>} plays - playLog entries {k, s, a, t, dj, djid, w, p, sk}
 * The room's own bots (opts.house) aren't DJs: their plays count for the songs,
 * but never in the DJ count or as the DJ who played a song most.
 * @param {{hidden?: function(string): boolean, house?: function(string): boolean, rows?: number}} [opts]
 */
function buildChart(plays, opts) {
  opts = opts || {};
  var hidden = opts.hidden || function() { return false; };
  var house = opts.house || function() { return false; };
  var songs = new Map();
  var djs = new Set();
  var total = 0;
  plays.forEach(function(e) {
    if (!counts(e)) return;
    total++;
    var dj = e.djid && !house(e.djid);
    if (dj) djs.add(e.djid);
    var key = e.s || "u" + e.k;
    var row = songs.get(key);
    if (!row) songs.set(key, row = { key: key, plays: 0, fires: 0, last: 0, by: new Map() });
    row.plays++;
    row.fires += Number(e.f) || 0; // shown beside the plays, never part of the ranking
    if (e.w >= row.last) {
      row.last = e.w;
      row.k = e.k;
      row.a = e.a || "";
      row.t = e.t || "";
    }
    if (dj) {
      var b = row.by.get(e.djid) || { n: 0, name: e.dj || null, first: e.w };
      b.n++;
      if (e.dj) b.name = e.dj;
      b.first = Math.min(b.first, e.w);
      row.by.set(e.djid, b);
    }
  });
  var rows = Array.from(songs.values()).sort(function(x, y) {
    return y.plays - x.plays || y.last - x.last || (x.key < y.key ? -1 : 1);
  }).slice(0, opts.rows || CHART_ROWS).map(function(r) {
    var top = null;
    r.by.forEach(function(b, djid) {
      if (!top || b.n > top.n || (b.n === top.n && b.first < top.first)) top = { djid: djid, name: b.name, n: b.n, first: b.first };
    });
    var show = top && !hidden(top.djid);
    return {
      key: r.key,
      type: Number(String(r.k).charAt(0)) || 1,
      cid: String(r.k).slice(1),
      a: r.a,
      t: r.t,
      plays: r.plays,
      fires: r.fires || null,
      dj: show ? top.name : null,
      djid: show ? top.djid : null
    };
  });
  return { plays: total, djs: djs.size, rows: rows };
}

// ---------------------------------------------------------- theme nights
// A theme night: plays under one room theme, no more than 2 hours apart. The
// bot saves the theme with each play (playLog th) since November 2026, so the
// archive starts there and grows.
var THEME_GAP = 2 * 3600 * 1000;
var THEME_MIN_SONGS = 3;

/**
 * @param {Array} plays - playLog entries
 * @param {{hidden?: Function, house?: Function}} [opts]
 * @returns {Array<{id, theme, from, to, n, djs, rows}>}
 */
function themeNights(plays, opts) {
  opts = opts || {};
  var hidden = opts.hidden || function() { return false; };
  var house = opts.house || function() { return false; };
  var nights = [];
  var cur = null;
  plays.filter(function(e) { return e && e.th && e.k && e.w && counts(e); })
    .sort(function(a, b) { return a.w - b.w; })
    .forEach(function(e) {
      if (!cur || cur.theme !== e.th || e.w - cur.to > THEME_GAP) {
        cur = { id: "n" + Number(e.w).toString(36), theme: String(e.th).slice(0, 80), from: e.w, to: e.w, rows: [], djs: new Map() };
        nights.push(cur);
      }
      cur.to = e.w;
      var show = e.djid && !hidden(e.djid);
      cur.rows.push({
        type: Number(String(e.k).charAt(0)) || 1, cid: String(e.k).slice(1), a: e.a || "", t: e.t || "",
        dj: show ? e.dj || null : null, djid: show ? e.djid : null, w: e.w, f: Number(e.f) || null
      });
      if (show && e.dj && !house(e.djid)) cur.djs.set(e.djid, e.dj);
    });
  return nights.filter(function(n) { return n.rows.length >= THEME_MIN_SONGS; }).map(function(n) {
    return { id: n.id, theme: n.theme, from: n.from, to: n.to, n: n.rows.length, djs: Array.from(n.djs.values()).slice(0, 8), rows: n.rows };
  });
}

// ---------------------------------------------------------- fires earned
// Each DJ's fires (the room's !hot on their plays), from the play log, which
// keeps them since November 2026. Only DJs who show their name are listed.
var FIRE_SONGS = 10;
var FIRES_START = Date.UTC(2026, 10, 1); // the play log has no fires before this

/**
 * @param {Array} plays - playLog entries
 * @param {{hidden?: Function, house?: Function}} [opts]
 * @returns {{since: number|null, djs: Object<string, {name, fires, plays, songs}>, index: Array}}
 */
function djFires(plays, opts) {
  opts = opts || {};
  var hidden = opts.hidden || function() { return false; };
  var house = opts.house || function() { return false; };
  var since = null;
  var djs = new Map();
  plays.forEach(function(e) {
    var f = Number(e && e.f) || 0;
    if (f <= 0 || !counts(e)) return;
    if (since == null || e.w < since) since = e.w;
    if (!e.djid || hidden(e.djid) || house(e.djid)) return;
    var d = djs.get(e.djid);
    if (!d) djs.set(e.djid, d = { name: e.dj || null, last: 0, fires: 0, plays: 0, songs: new Map() });
    d.fires += f;
    d.plays++;
    if (e.w >= d.last) { d.last = e.w; if (e.dj) d.name = e.dj; }
    var key = e.s || "u" + e.k;
    var song = d.songs.get(key);
    if (!song) d.songs.set(key, song = { key: key, k: e.k, a: e.a || "", t: e.t || "", fires: 0, plays: 0, w: 0, top: 0 });
    song.fires += f;
    song.plays++;
    song.top = Math.max(song.top, f);
    if (e.w >= song.w) { song.w = e.w; song.k = e.k; song.a = e.a || song.a; song.t = e.t || song.t; }
  });
  var out = {};
  var index = [];
  djs.forEach(function(d, djid) {
    var songs = Array.from(d.songs.values()).sort(function(x, y) {
      return y.fires - x.fires || y.w - x.w || (x.key < y.key ? -1 : 1);
    }).slice(0, FIRE_SONGS).map(function(r) {
      return { key: r.key, type: Number(String(r.k).charAt(0)) || 1, cid: String(r.k).slice(1), a: r.a, t: r.t, fires: r.fires, plays: r.plays, top: r.top, w: r.w };
    });
    out[djid] = { name: d.name, fires: d.fires, plays: d.plays, songs: songs };
    index.push({ djid: djid, dj: d.name, fires: d.fires, plays: d.plays });
  });
  index.sort(function(x, y) { return y.fires - x.fires || y.plays - x.plays || (x.djid < y.djid ? -1 : 1); });
  return { since: since, djs: out, index: index };
}

/**
 * Movement against the chart before: "new" (first time on the chart), "re"
 * (back after a gap), or places up (+) / down (-) / 0. wks counts the weeks
 * in a row a song has been on the chart, this one included.
 */
function withMovement(rows, prev) {
  var before = new Map();
  ((prev && prev.rows) || []).forEach(function(r, i) { before.set(r.key, { rank: i + 1, wks: r.wks || 1, seen: true }); });
  var everSeen = (prev && prev.seen) || {};
  return rows.map(function(r, i) {
    var p = before.get(r.key);
    var out = Object.assign({}, r);
    if (p) {
      out.mv = p.rank - (i + 1);
      out.wks = p.wks + 1;
    } else {
      out.mv = everSeen[r.key] ? "re" : "new";
      out.wks = 1;
    }
    return out;
  });
}

/** The keys a weekly chart has ever had, carried forward week to week (capped). */
function seenKeys(prev, rows) {
  var seen = Object.assign({}, (prev && prev.seen) || {});
  rows.forEach(function(r) { seen[r.key] = 1; });
  var keys = Object.keys(seen);
  if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach(function(k) { delete seen[k]; });
  return seen;
}

// ------------------------------------------------------------- releases

/**
 * A YouTube upload's release date. "Artist - Topic" uploads say "Released on:
 * 2026-09-12" in their description; otherwise the upload date is used.
 * @param {{description?: string, publishedAt?: string}} snippet
 * @returns {{d: string, src: string}|null} d as YYYY-MM-DD
 */
function releaseDate(snippet) {
  if (!snippet) return null;
  var m = /Released on:\s*(\d{4}-\d{2}-\d{2})/i.exec(String(snippet.description || ""));
  if (m) return { d: m[1], src: "yt" };
  m = /^(\d{4}-\d{2}-\d{2})/.exec(String(snippet.publishedAt || ""));
  if (m) return { d: m[1], src: "upload" };
  return null;
}

// the day a moment falls on, in the bot's time zone, as YYYY-MM-DD
function dayOf(ms) {
  var d = new Date(ms);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function dayMs(d) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}

/**
 * The library's new releases: released in the last 90 days (not in the
 * future), newest first. A track with no release date falls back to the day
 * it joined the year playlist, when known.
 * @param {Array<{cid, title, artist, album, dur, added?}>} tracks
 * @param {Object<string, {d, src}>} releases - by cid
 */
function newReleases(tracks, releases, now, days) {
  var since = now - (days || NEW_DAYS) * DAY;
  var seen = {};
  var out = [];
  tracks.forEach(function(t) {
    if (!t || !t.cid || seen[t.cid]) return;
    seen[t.cid] = true;
    var r = releases[t.cid];
    var d = r && r.d;
    var src = r && r.src;
    if (!d && t.added) { d = dayOf(t.added); src = "added"; }
    var at = dayMs(d);
    if (!(at >= since && at <= now)) return;
    out.push({ cid: t.cid, a: t.artist || "", t: t.title || "", al: t.album || "", dur: t.dur || 0, rel: d, relSrc: src, at: at });
  });
  out.sort(function(x, y) { return y.at - x.at || (x.cid < y.cid ? -1 : 1); });
  return out.slice(0, NEW_MAX).map(function(t) { delete t.at; return t; });
}

// ------------------------------------------------------ the play log window

var WINDOW_DAYS = 70; // this week and last, this month and last, recent theme nights
var ARCHIVE_DAYS = 400; // the daily jobs' widest span (theme nights)
var ARCHIVE_KEEP_MS = 15 * 60 * 1000; // an older span read once serves the day's jobs this long

/**
 * The last `days` of playLog, kept in memory by one listener: downloaded once
 * at start, then only each new play. Entries older than the window are let
 * go as time passes.
 * @param {object} db - firebase.database()
 * @param {object} [opts]
 * @param {number} [opts.days] - how far back it keeps (default 70)
 * @param {function(): number} [opts.now]
 * @param {function(string)} [opts.log]
 * @returns {{between: function(number, number): Promise<Array|null>, ready: Promise<boolean>, size: function(): number}}
 *   between(from, to): the plays in [from, to), oldest first, or null when the
 *   window doesn't reach back to `from` (or couldn't be read): read those instead
 */
function playLogWindow(db, opts) {
  opts = opts || {};
  var now = opts.now || Date.now;
  var keep = (opts.days || WINDOW_DAYS) * DAY;
  var covered = now() - keep; // the oldest play it still holds
  var byKey = new Map();
  var sorted = null;
  var query = db.ref("playLog").orderByChild("w").startAt(covered);
  var put = function(snap) {
    var v = snap.val();
    if (v && typeof v.w === "number") byKey.set(snap.key, v); else byKey.delete(snap.key);
    sorted = null;
  };
  var failed = false;
  query.on("child_added", put, function(err) {
    failed = true;
    if (opts.log) opts.log("discover: couldn't keep the play log in memory (" + (err && err.message) + "); reading it as needed");
  });
  query.on("child_changed", put);
  query.on("child_removed", function(snap) { if (byKey.delete(snap.key)) sorted = null; });
  // the same query, so this is answered from what the listener downloaded
  var ready = query.once("value").then(function() { return true; }, function() { return false; });
  var prune = function() {
    var cutoff = now() - keep;
    if (cutoff - covered < DAY) return;
    byKey.forEach(function(v, k) { if (v.w < cutoff) byKey.delete(k); });
    covered = cutoff;
    sorted = null;
  };
  var list = function() {
    if (!sorted) {
      sorted = [];
      byKey.forEach(function(v, k) { sorted.push({ k: k, v: v }); });
      sorted.sort(function(a, b) { return a.v.w - b.v.w || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0); });
      sorted = sorted.map(function(x) { return x.v; });
    }
    return sorted;
  };
  return {
    ready: ready,
    between: function(from, to) {
      return ready.then(function(ok) {
        if (!ok || failed) return null;
        prune();
        if (from < covered) return null;
        return list().filter(function(e) { return e.w >= from && e.w < to; });
      });
    },
    size: function() { return byKey.size; }
  };
}

/**
 * The room's tags for an upload (a globalTracks entry) as a row writes them,
 * by the rule the room uses: none without a title, or with an "Unknown" artist.
 * @param {{artist?, title?}|null} up
 * @returns {{a: string, t: string}|null}
 */
function roomTags(up) {
  if (!up || typeof up.artist !== "string" || typeof up.title !== "string") return null;
  var a = up.artist.trim(), t = up.title.trim();
  if (!a || !t || a === "Unknown") return null;
  return { a: a, t: t };
}

/** A row's upload key ("1<cid>"), or null when it names none. */
function rowKey(row) {
  if (!row || row.cid == null || row.cid === "") return null;
  var k = (Number(row.type) || 1) + "" + row.cid;
  return /^[12][A-Za-z0-9_-]{1,64}$/.test(k) ? k : null;
}

/**
 * Each song row in a published value (an object with a cid and its tags, a
 * and t), with its path inside the value ("/rows/3").
 * @param {*} value
 * @param {function(object, string)} fn
 */
function eachRow(value, fn, path) {
  path = path || "";
  if (!value || typeof value !== "object") return;
  if (rowKey(value) && (typeof value.a === "string" || typeof value.t === "string")) return fn(value, path);
  Object.keys(value).forEach(function(k) { eachRow(value[k], fn, path + "/" + k); });
}

/** A value's content for "did it change?": everything but its `at` (when it was made). */
function contentOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value === undefined ? null : value);
  var copy = Object.assign({}, value);
  delete copy.at;
  return JSON.stringify(copy);
}

// -------------------------------------------------------------- service

/**
 * The bot's Discover publisher.
 * @param {object} deps
 * @param {object} deps.db - firebase.database()
 * @param {function(): number} deps.now - the database clock
 * @param {function(string): boolean} deps.hidden - uid -> opted out of public pages?
 * @param {function(string): boolean} [deps.house] - uid -> one of the room's own bots (not a DJ)?
 * @param {function(string): string|false} deps.uidOf - DJ name -> uid
 * @param {function(string): string} deps.nameOf - uid -> current name
 * @param {function(string): Promise<{tracks}>} deps.playlist - YouTube Music playlist
 * @param {function(string[]): Promise<Object>} deps.snippets - YouTube ids -> {description, publishedAt}
 * @param {function(string): Promise<{color, txt}|null>} [deps.colors] - artwork url -> colours
 * @param {Array<{year, id}>} deps.sources - the year playlists
 * @param {object} [deps.playLog] - a playLogWindow: recent plays from memory, and
 *   older spans read once for all the day's jobs. Without it every span is read.
 * @param {function} [deps.log]
 */
function createDiscover(deps) {
  var db = deps.db;
  var log = deps.log || function() {};
  var said = {};
  var warnOnce = function(key, msg) {
    if (said[key]) return;
    said[key] = true;
    log(msg);
  };
  // what each path last held (its content without `at`), so an unchanged
  // value isn't sent again to every browser following it
  var written = new Map();
  var unchanged = function(path, value) { return written.get(path) === contentOf(value); };
  var wrote = function(updates) {
    Object.keys(updates).forEach(function(path) { written.set(path, contentOf(updates[path])); });
  };
  var forget = function(updates) { Object.keys(updates).forEach(function(path) { written.delete(path); }); };
  var write = function(path, value) {
    return (path === ALL_TIME ? Promise.resolve(value) : tagged(value)).then(function() {
      if (unchanged(path, value)) return false;
      var updates = {};
      updates[path] = value;
      wrote(updates);
      return db.ref(path).set(value).then(function() { return true; }, function(err) {
        forget(updates);
        warnOnce("w:" + path.split("/")[1], "discover: couldn't save " + path + " (deploy firebase-rules.json): " + (err && err.message));
        throw err;
      });
    });
  };

  // ---------------------------------------------------- the room's tags
  // each upload's tags as the room has them, read once a day (a fix is put
  // in by retag the moment it's made)
  var tagCache = new Map(); // "<type><cid>" -> {tags: {a, t}|null, at}
  var tagsFor = function(keys) {
    var now = deps.now();
    var seen = new Set();
    var want = keys.filter(function(k) {
      var hit = tagCache.get(k);
      if (seen.has(k) || (hit && now - hit.at < DAY)) return false;
      seen.add(k);
      return true;
    });
    return Promise.all(want.map(function(k) {
      return db.ref("globalTracks/" + k).once("value").then(function(s) {
        tagCache.set(k, { tags: roomTags(s.val()), at: now });
      }, function() { /* unreadable: the row keeps its tags */ });
    }));
  };
  // put the room's tags on every row in a value about to be published
  var tagged = function(value) {
    var rows = [];
    eachRow(value, function(row) { rows.push(row); });
    if (!rows.length) return Promise.resolve(value);
    return tagsFor(rows.map(rowKey)).then(function() {
      rows.forEach(function(row) {
        var hit = tagCache.get(rowKey(row));
        if (hit && hit.tags) { row.a = hit.tags.a; row.t = hit.tags.t; }
      });
      return value;
    });
  };
  /**
   * Uploads' tags were fixed: put the new tags on every row already
   * published that names one (each changed field only), and on what's
   * built from now on.
   * @param {Object<string, {artist, title}>} changes - by upload key ("1<cid>")
   * @returns {Promise<number>} the rows changed
   */
  var retag = function(changes) {
    var now = deps.now();
    var cids = [];
    Object.keys(changes || {}).forEach(function(k) {
      if (!/^[12][A-Za-z0-9_-]{1,64}$/.test(k)) return;
      tagCache.set(k, { tags: roomTags(changes[k]), at: now });
      cids.push(JSON.stringify(k.slice(1)));
    });
    if (!cids.length) return Promise.resolve(0);
    var updates = {};
    var contents = {};
    var n = 0;
    written.forEach(function(content, path) {
      // (the all-time chart names each track the history's way: globalSongs)
      if (path.indexOf("discover/") !== 0 || path === ALL_TIME || !cids.some(function(c) { return content.indexOf(c) !== -1; })) return;
      var value = JSON.parse(content);
      var changed = false;
      eachRow(value, function(row, at) {
        var hit = changes[rowKey(row)] && tagCache.get(rowKey(row));
        if (!hit || !hit.tags || (row.a === hit.tags.a && row.t === hit.tags.t)) return;
        if (row.a !== hit.tags.a) updates[path + at + "/a"] = row.a = hit.tags.a;
        if (row.t !== hit.tags.t) updates[path + at + "/t"] = row.t = hit.tags.t;
        changed = true;
        n++;
      });
      if (changed) contents[path] = JSON.stringify(value);
    });
    if (!Object.keys(updates).length) return Promise.resolve(0);
    Object.keys(contents).forEach(function(path) { written.set(path, contents[path]); });
    return db.ref().update(updates).then(function() { return n; }, function(err) {
      Object.keys(contents).forEach(function(path) { written.delete(path); }); // rebuilt whole next time
      throw err;
    });
  };

  var readPlays = function(from, to) {
    return db.ref("playLog").orderByChild("w").startAt(from).endAt(to - 1).once("value").then(function(snap) {
      var out = [];
      snap.forEach(function(c) { out.push(c.val()); });
      return out;
    });
  };
  // a span older than the window: the widest the day's jobs need, read once
  // and shared by them (the year's chart, theme nights and fires all at once)
  var archive = null; // {from, at, plays: Promise<Array>}
  var olderPlays = function(from) {
    var t = deps.now();
    if (archive && archive.from <= from && t - archive.at < ARCHIVE_KEEP_MS) return archive.plays;
    var start = Math.min(from, t - ARCHIVE_DAYS * DAY);
    var mine = { from: start, at: t, plays: null };
    mine.plays = readPlays(start, t + 1).catch(function(err) {
      if (archive === mine) archive = null;
      throw err;
    });
    archive = mine;
    // let it go once the day's jobs are done with it
    var timer = setTimeout(function() { if (archive === mine) archive = null; }, ARCHIVE_KEEP_MS);
    if (timer && timer.unref) timer.unref();
    return mine.plays;
  };

  // playLog entries in [from, to), oldest first
  var playsBetween = function(from, to) {
    if (!deps.playLog) return readPlays(from, to);
    return deps.playLog.between(from, to).then(function(got) {
      if (got) return got;
      return olderPlays(from).then(function(all) {
        return all.filter(function(e) { return e && e.w >= from && e.w < to; });
      });
    });
  };

  // A finished chart never changes, and the chart after each song needs last
  // week's (is it finished? where was each song?): kept once read or written.
  var finished = new Map(); // path -> chart (final ones only)
  var seenOf = new Map(); // week id -> its discoverCache/seen
  var chartOf = function(period, id) {
    var path = "discover/charts/" + period + "/" + id;
    if (finished.has(path)) return Promise.resolve(finished.get(path));
    return db.ref(path).once("value").then(function(s) {
      var c = s.val();
      if (c && c.final) finished.set(path, c);
      return c;
    });
  };
  var seenFor = function(id) {
    if (seenOf.has(id)) return Promise.resolve(seenOf.get(id));
    return db.ref("discoverCache/seen/" + id).once("value").then(function(s) {
      var v = s.val();
      seenOf.set(id, v);
      return v;
    }, function() { return null; });
  };

  // each song's main genre, from the play history (globalSongs/<id>/genres),
  // remembered for a day; songs the history doesn't know yet have none
  var genreCache = new Map();
  var withGenres = function(rows) {
    var now = deps.now();
    return Promise.all(rows.map(function(r) {
      if (!r.key || r.key.charAt(0) === "u") return Promise.resolve(r);
      var hit = genreCache.get(r.key);
      if (hit && now - hit.at < DAY) return Promise.resolve(hit.g ? Object.assign({}, r, { g: hit.g }) : r);
      return db.ref("globalSongs/" + r.key + "/genres/0").once("value").then(function(s) {
        var g = typeof s.val() === "string" ? s.val() : null;
        genreCache.set(r.key, { g: g, at: now });
        return g ? Object.assign({}, r, { g: g }) : r;
      }, function() { return r; });
    }));
  };

  // build and save one period's chart
  var saveChart = function(period, id, opts) {
    opts = opts || {};
    var range = rangeOf(period, id);
    var prevId = previousId(period, id);
    var week = period === "week";
    return Promise.all([
      playsBetween(range.from, range.to),
      week ? chartOf(period, prevId) : Promise.resolve(null),
      week ? seenFor(prevId) : Promise.resolve(null)
    ]).then(function(got) {
      var built = buildChart(got[0], { hidden: deps.hidden, house: deps.house });
      var prev = got[1] ? { rows: got[1].rows, seen: got[2] } : null;
      return withGenres(week ? withMovement(built.rows, prev) : built.rows).then(tagged).then(function(rows) { return { rows: rows, built: built, prev: prev }; });
    }).then(function(got) {
      var built = got.built, prev = got.prev, rows = got.rows;
      var chart = { at: deps.now(), from: range.from, to: range.to, plays: built.plays, djs: built.djs, rows: rows, final: !!opts.final };
      var chartPath = "discover/charts/" + period + "/" + id;
      if (unchanged(chartPath, chart)) return chart; // and so is everything below, which follows from it
      var updates = {};
      updates["discover/charts/" + period + "/" + id] = chart;
      updates["discover/chartIds/" + period + "/" + id] = true;
      if (week) {
        // songs ever on the weekly chart (for "re-entry"), kept two weeks back
        updates["discoverCache/seen/" + id] = seenKeys(prev, rows);
        var old = previousId("week", previousId("week", prevId));
        if (old) updates["discoverCache/seen/" + old] = null;
      }
      wrote(updates);
      return db.ref().update(updates).then(function() {
        if (chart.final) finished.set(chartPath, chart);
        if (week) {
          seenOf.set(id, updates["discoverCache/seen/" + id]);
          if (old) seenOf.delete(old);
        }
        return chart;
      }, function(err) {
        forget(updates);
        warnOnce("charts", "discover: couldn't save the charts (deploy firebase-rules.json): " + (err && err.message));
        throw err;
      });
    });
  };

  // this period's chart, finishing the last one first if it never was
  var refreshPeriod = function(period) {
    var id = idOf[period](deps.now());
    var prevId = previousId(period, id);
    return chartOf(period, prevId).then(function(prev) {
      var finish = !prev || !prev.final ? saveChart(period, prevId, { final: true }) : Promise.resolve();
      return finish.then(function() { return saveChart(period, id); });
    });
  };

  // all time: the history's song counts (globalSongs), most played first
  var refreshAllTime = function() {
    return db.ref("globalSongs").orderByChild("plays").limitToLast(CHART_ROWS).once("value").then(function(snap) {
      var songs = [];
      snap.forEach(function(c) { var v = c.val() || {}; songs.push({ id: c.key, v: v }); });
      songs.sort(function(x, y) { return (y.v.plays || 0) - (x.v.plays || 0); });
      return Promise.all(songs.map(function(s) {
        // a playable upload of the song: the latest played of those the room
        // tags as this version (the chart names the song, so "Kites" must not
        // play an upload tagged "Kites (Limousines Remix)")
        return db.ref("globalTracks").orderByChild("song").equalTo(s.id).once("value").then(function(up) {
          return pickUpload(s.v, up.val());
        }, function() { return null; });
      })).then(function(uploads) {
        var rows = [];
        songs.forEach(function(s, i) {
          if (!uploads[i]) return;
          var djid = s.v.first_play_dj ? deps.uidOf(s.v.first_play_dj) : false;
          var show = djid && !deps.hidden(djid);
          rows.push({
            key: s.id, type: Number(uploads[i].charAt(0)) || 1, cid: uploads[i].slice(1), a: s.v.artist || "", t: s.v.title || "",
            plays: s.v.plays || 0, first: s.v.first_play_date || null, dj: show ? s.v.first_play_dj : null, djid: show ? djid : null,
            g: Array.isArray(s.v.genres) && typeof s.v.genres[0] === "string" ? s.v.genres[0] : null
          });
        });
        return write(ALL_TIME, { at: deps.now(), rows: rows, role: "first" });
      });
    }).catch(function(err) {
      warnOnce("all", "discover: no all-time chart yet (" + (err && err.message) + "); it needs the play history published and firebase-rules.json deployed");
    });
  };

  // ---------------------------------------------------------- theme nights
  // the last `hours` of plays as theme nights, each with its songs in order;
  // a night that began before the window may be cut short, so it's left to
  // the daily run, which reads the whole archive
  var refreshThemes = function(hours) {
    var now = deps.now();
    var since = now - hours * 3600 * 1000;
    return playsBetween(since, now + 1).then(function(plays) {
      var nights = themeNights(plays, { hidden: deps.hidden, house: deps.house }).filter(function(n) { return n.from - since > THEME_GAP; });
      return tagged(nights);
    }).then(function(nights) {
      if (!nights || !nights.length) return;
      var updates = {};
      nights.forEach(function(n) {
        var night = { theme: n.theme, from: n.from, to: n.to, n: n.n, djs: n.djs, rows: n.rows };
        var entry = { theme: n.theme, from: n.from, to: n.to, n: n.n, djs: n.djs };
        if (!unchanged("discover/themes/night/" + n.id, night)) updates["discover/themes/night/" + n.id] = night;
        if (!unchanged("discover/themes/index/" + n.id, entry)) updates["discover/themes/index/" + n.id] = entry;
      });
      if (!Object.keys(updates).length) return;
      wrote(updates);
      return db.ref().update(updates).catch(function(err) {
        forget(updates);
        warnOnce("themes", "discover: couldn't save theme nights (deploy firebase-rules.json): " + (err && err.message));
        throw err;
      });
    });
  };

  // ---------------------------------------------------------- fires earned
  // every DJ's fires, from the log since it began keeping them
  var refreshFires = function() {
    var now = deps.now();
    return playsBetween(FIRES_START, now + 1).then(function(plays) {
      var got = djFires(plays, { hidden: deps.hidden, house: deps.house });
      return write("discover/fires", { at: now, since: got.since, djs: got.djs, index: got.index });
    });
  };

  // ---------------------------------------------------------- new music
  var cacheRead = function(path) {
    return db.ref("discoverCache/" + path).once("value").then(function(s) { return s.val() || {}; }, function(err) {
      warnOnce("cache", "discover: couldn't read discoverCache (deploy firebase-rules.json): " + (err && err.message));
      return {};
    });
  };

  var refreshNew = function() {
    var now = deps.now();
    var month = new Date(now).getMonth();
    var thisYear = new Date(now).getFullYear();
    // the current year's playlist, and last year's for the first months
    var sources = (deps.sources || []).filter(function(s) {
      return s.year === thisYear || (month < 3 && s.year === thisYear - 1);
    });
    if (!sources.length) { warnOnce("nosrc", "discover: no year playlist for " + thisYear + " (YTMUSIC_SOURCES)"); return Promise.resolve(); }
    var tracks = [];
    return sources.reduce(function(p, s) {
      return p.then(function() {
        return deps.playlist(s.id).then(function(res) { tracks = tracks.concat((res && res.tracks) || []); }, function(err) {
          log("discover: couldn't read the " + s.year + " playlist: " + (err && err.message));
        });
      });
    }, Promise.resolve()).then(function() {
      // nothing read: fail, so the bot tries again later the same day
      if (!tracks.length) throw new Error("couldn't read this year's playlist");
      return cacheRead("release");
    }).then(function(releases) {
      if (!releases) return null;
      var seen = new Set();
      var missing = tracks.map(function(t) { return t.cid; }).filter(function(cid) {
        if (!cid || releases[cid] || seen.has(cid)) return false;
        seen.add(cid);
        return true;
      });
      var batches = [];
      for (var i = 0; i < missing.length; i += 50) batches.push(missing.slice(i, i + 50));
      var found = {};
      return batches.reduce(function(p, ids) {
        return p.then(function() {
          return deps.snippets(ids).then(function(snips) {
            ids.forEach(function(id) {
              var r = releaseDate(snips && snips[id]);
              // unknown to YouTube (gone): remember that, don't ask again
              found[id] = r || { d: null, src: "none" };
            });
          });
        });
      }, Promise.resolve()).catch(function(err) {
        log("discover: couldn't look up release dates (" + (err && err.message) + "); the rest wait for the next run");
      }).then(function() {
        var updates = {};
        Object.keys(found).forEach(function(cid) { updates["discoverCache/release/" + cid] = found[cid]; releases[cid] = found[cid]; });
        var saved = Object.keys(updates).length ? db.ref().update(updates).catch(function() {}) : Promise.resolve();
        return saved.then(function() { return newReleases(tracks, releases, now); });
      });
    }).then(function(list) {
      if (!list) return null;
      return enrich(list).then(function(enriched) {
        return write("discover/new", { at: now, days: NEW_DAYS, tracks: enriched });
      }).then(function() {
        log("discover: " + list.length + " new releases");
      });
    });
  };

  // room plays and first play for each new release, and its artwork colours
  var enrich = function(list) {
    return cacheRead("colors").then(function(colorCache) {
      var newColors = {};
      var colorBudget = 50;
      return Promise.all(list.map(function(t) {
        var history = db.ref("globalTracks/1" + t.cid).once("value").then(function(s) {
          var up = s.val();
          if (!up) return null;
          var song = up.song ? db.ref("globalSongs/" + up.song).once("value").then(function(x) { return x.val(); }) : Promise.resolve(null);
          return song.then(function(sg) {
            var first = (sg && sg.first_play_date) || up.first_play_date || null;
            var firstDj = (sg && sg.first_play_dj) || up.first_play_dj || null;
            return { plays: (sg && sg.plays) || (first ? 1 : 0), first: first, dj: firstDj, song: up.song || null };
          });
        }).catch(function() { return null; });
        var color = colorCache[t.cid];
        if (color === undefined && deps.colors && colorBudget > 0) {
          colorBudget--;
          color = deps.colors("https://i.ytimg.com/vi/" + t.cid + "/mqdefault.jpg").then(function(c) { newColors[t.cid] = c || false; return c; }, function() { return null; });
        }
        return Promise.all([history, Promise.resolve(color)]).then(function(got) {
          var h = got[0];
          var out = Object.assign({}, t);
          if (h && h.first) {
            var djid = h.dj ? deps.uidOf(h.dj) : false;
            var show = djid && !deps.hidden(djid);
            out.plays = h.plays;
            out.first = h.first;
            out.dj = show ? h.dj : null;
            out.djid = show ? djid : null;
            if (h.song) out.song = h.song;
          } else {
            out.plays = 0;
          }
          if (got[1] && got[1].color) out.c = got[1].color;
          return out;
        });
      })).then(function(rows) {
        var updates = {};
        Object.keys(newColors).forEach(function(cid) { updates["discoverCache/colors/" + cid] = newColors[cid]; });
        return (Object.keys(updates).length ? db.ref().update(updates).catch(function() {}) : Promise.resolve()).then(function() { return rows; });
      });
    });
  };

  // The chat peek (discover/chat) is retired: nothing reads it (the chat is
  // for members only), it put members' messages where anyone could read them,
  // and building it downloaded each message a second time. Clear what's left.
  var retire = function() {
    return db.ref("discover/chat").set(null).catch(function() {});
  };

  return {
    // a chart period now, e.g. after a play (the week) or daily (the rest)
    refreshPeriod: refreshPeriod,
    refreshAllTime: refreshAllTime,
    refreshNew: refreshNew,
    // a mod fixed uploads' tags: published rows follow
    retag: retag,
    refreshThemes: refreshThemes,
    refreshFires: refreshFires,
    // clear what's left of retired data (the old chat peek)
    retire: retire
  };
}

module.exports = {
  weekId: weekId,
  monthId: monthId,
  yearId: yearId,
  rangeOf: rangeOf,
  previousId: previousId,
  counts: counts,
  buildChart: buildChart,
  pickUpload: pickUpload,
  withMovement: withMovement,
  seenKeys: seenKeys,
  releaseDate: releaseDate,
  newReleases: newReleases,
  roomTags: roomTags,
  eachRow: eachRow,
  themeNights: themeNights,
  djFires: djFires,
  createDiscover: createDiscover,
  playLogWindow: playLogWindow,
  contentOf: contentOf,
  NEW_DAYS: NEW_DAYS
};
