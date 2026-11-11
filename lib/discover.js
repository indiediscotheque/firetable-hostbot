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
//   discover/chat                  the last chat messages, for visitors
//   discover/themes/...            theme nights (index, and each night)
//   discover/fires                 each DJ's fires earned and most-fired songs
//   discoverCache/release/<cid>    each library track's release date
//   discoverCache/colors/<cid>     its artwork colours (false: none)
//
// Charts count plays from playLog (only the bot can read it). A play counts
// when the song ran out or played for 30 seconds or more. Charts count plays
// only: fires never change a chart. People who turned off "Show my name on
// public pages" (users/<uid>/publicName = false) appear as nobody here.
"use strict";

var DAY = 86400000;
var CHART_ROWS = 40;
var NEW_DAYS = 90;
var NEW_MAX = 200;
var CHAT_MAX = 20;
var CHAT_TEXT_MAX = 300;
var MIN_PLAY_SECONDS = 30;

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
 * A chart from playLog entries: one row per song (the history's song id, or
 * the upload when the history doesn't know it), most plays first, then the
 * most recently played. Each row names the DJ who played it most.
 * @param {Array<object>} plays - playLog entries {k, s, a, t, dj, djid, w, p, sk}
 * @param {{hidden?: function(string): boolean, rows?: number}} [opts]
 */
function buildChart(plays, opts) {
  opts = opts || {};
  var hidden = opts.hidden || function() { return false; };
  var songs = new Map();
  var djs = new Set();
  var total = 0;
  plays.forEach(function(e) {
    if (!counts(e)) return;
    total++;
    if (e.djid) djs.add(e.djid);
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
    if (e.djid) {
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
 * @param {{hidden?: Function}} [opts]
 * @returns {Array<{id, theme, from, to, n, djs, rows}>}
 */
function themeNights(plays, opts) {
  opts = opts || {};
  var hidden = opts.hidden || function() { return false; };
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
      if (show && e.dj) cur.djs.set(e.djid, e.dj);
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
 * @param {{hidden?: Function}} [opts]
 * @returns {{since: number|null, djs: Object<string, {name, fires, plays, songs}>, index: Array}}
 */
function djFires(plays, opts) {
  opts = opts || {};
  var hidden = opts.hidden || function() { return false; };
  var since = null;
  var djs = new Map();
  plays.forEach(function(e) {
    var f = Number(e && e.f) || 0;
    if (f <= 0 || !counts(e)) return;
    if (since == null || e.w < since) since = e.w;
    if (!e.djid || hidden(e.djid)) return;
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

// ----------------------------------------------------------------- chat

/**
 * The chat as visitors see it: the latest messages, without bot commands,
 * hidden feed entries or empty ones. Someone who turned off their public name
 * shows as nobody (no name, no robot).
 * @param {Array<{key, chatID, hidden}>} entries - the chat feed, oldest first
 * @param {Map<string, object>|Object} chats - chatID -> chatData
 * @param {function(string): boolean} hidden - uid -> name hidden?
 * @param {function(string): string} [nameOf] - uid -> current name
 */
function chatPeek(entries, chats, hidden, nameOf) {
  var get = function(id) { return chats instanceof Map ? chats.get(id) : chats[id]; };
  var out = [];
  entries.forEach(function(e) {
    if (!e || e.hidden || !e.chatID) return;
    var c = get(e.chatID);
    if (!c || typeof c.txt !== "string" || !c.txt.trim()) return;
    if (c.botCmd || /^!/.test(c.txt.trim())) return;
    var hide = hidden(c.id);
    var txt = c.txt.length > CHAT_TEXT_MAX ? c.txt.slice(0, CHAT_TEXT_MAX - 1) + "…" : c.txt;
    out.push({
      id: e.chatID,
      uid: hide ? null : c.id || null,
      n: hide ? null : (nameOf && nameOf(c.id)) || c.name || null,
      txt: txt,
      w: typeof c.time === "number" ? c.time : null
    });
  });
  return out.slice(-CHAT_MAX);
}

// -------------------------------------------------------------- service

/**
 * The bot's Discover publisher.
 * @param {object} deps
 * @param {object} deps.db - firebase.database()
 * @param {function(): number} deps.now - the database clock
 * @param {function(string): boolean} deps.hidden - uid -> opted out of public pages?
 * @param {function(string): string|false} deps.uidOf - DJ name -> uid
 * @param {function(string): string} deps.nameOf - uid -> current name
 * @param {function(string): Promise<{tracks}>} deps.playlist - YouTube Music playlist
 * @param {function(string[]): Promise<Object>} deps.snippets - YouTube ids -> {description, publishedAt}
 * @param {function(string): Promise<{color, txt}|null>} [deps.colors] - artwork url -> colours
 * @param {Array<{year, id}>} deps.sources - the year playlists
 * @param {function(): Array} deps.feed - the chat feed entries, oldest first
 * @param {function(string): Promise<object>} deps.chatData - chatID -> message
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
  var write = function(path, value) {
    return db.ref(path).set(value).catch(function(err) {
      warnOnce("w:" + path.split("/")[1], "discover: couldn't save " + path + " (deploy firebase-rules.json): " + (err && err.message));
      throw err;
    });
  };

  // playLog entries in [from, to)
  var playsBetween = function(from, to) {
    return db.ref("playLog").orderByChild("w").startAt(from).endAt(to - 1).once("value").then(function(snap) {
      var out = [];
      snap.forEach(function(c) { out.push(c.val()); });
      return out;
    });
  };

  var chartOf = function(period, id) {
    return db.ref("discover/charts/" + period + "/" + id).once("value").then(function(s) { return s.val(); });
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
      week ? db.ref("discoverCache/seen/" + prevId).once("value").then(function(s) { return s.val(); }, function() { return null; }) : Promise.resolve(null)
    ]).then(function(got) {
      var built = buildChart(got[0], { hidden: deps.hidden });
      var prev = got[1] ? { rows: got[1].rows, seen: got[2] } : null;
      return withGenres(week ? withMovement(built.rows, prev) : built.rows).then(function(rows) { return { rows: rows, built: built, prev: prev }; });
    }).then(function(got) {
      var built = got.built, prev = got.prev, rows = got.rows;
      var chart = { at: deps.now(), from: range.from, to: range.to, plays: built.plays, djs: built.djs, rows: rows, final: !!opts.final };
      var updates = {};
      updates["discover/charts/" + period + "/" + id] = chart;
      updates["discover/chartIds/" + period + "/" + id] = true;
      if (week) {
        // songs ever on the weekly chart (for "re-entry"), kept two weeks back
        updates["discoverCache/seen/" + id] = seenKeys(prev, rows);
        var old = previousId("week", previousId("week", prevId));
        if (old) updates["discoverCache/seen/" + old] = null;
      }
      return db.ref().update(updates).then(function() { return chart; }, function(err) {
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
        // a playable upload of the song
        return db.ref("globalTracks").orderByChild("song").equalTo(s.id).limitToLast(1).once("value").then(function(up) {
          var key = null;
          up.forEach(function(c) { key = c.key; });
          return key;
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
        return write("discover/charts/all/all", { at: deps.now(), rows: rows, role: "first" });
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
      var nights = themeNights(plays, { hidden: deps.hidden }).filter(function(n) { return n.from - since > THEME_GAP; });
      if (!nights.length) return;
      var updates = {};
      nights.forEach(function(n) {
        updates["discover/themes/night/" + n.id] = { theme: n.theme, from: n.from, to: n.to, n: n.n, djs: n.djs, rows: n.rows };
        updates["discover/themes/index/" + n.id] = { theme: n.theme, from: n.from, to: n.to, n: n.n, djs: n.djs };
      });
      return db.ref().update(updates).catch(function(err) {
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
      var got = djFires(plays, { hidden: deps.hidden });
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
      var missing = tracks.map(function(t) { return t.cid; }).filter(function(cid, i, a) { return cid && !releases[cid] && a.indexOf(cid) === i; });
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

  // ---------------------------------------------------------------- chat
  var chatCache = new Map();
  var hourTimes = [];
  var chatTimer = null;
  var lastChat = "";
  var refreshChat = function() {
    var entries = deps.feed().slice(-(CHAT_MAX + 10));
    var wanted = entries.map(function(e) { return e.chatID; }).filter(Boolean);
    // forget messages that left the feed
    chatCache.forEach(function(v, id) { if (wanted.indexOf(id) === -1) chatCache.delete(id); });
    return Promise.all(wanted.filter(function(id) { return !chatCache.has(id); }).map(function(id) {
      return deps.chatData(id).then(function(c) { if (c) chatCache.set(id, c); }, function() {});
    })).then(function() {
      var now = deps.now();
      hourTimes = hourTimes.filter(function(t) { return now - t < 3600000; });
      var msgs = chatPeek(entries, chatCache, deps.hidden, deps.nameOf);
      var value = { msgs: msgs, hour: hourTimes.length };
      var json = JSON.stringify(value);
      if (json === lastChat) return null;
      lastChat = json;
      value.at = now;
      return write("discover/chat", value).catch(function() { lastChat = ""; });
    });
  };

  return {
    // a chart period now, e.g. after a play (the week) or daily (the rest)
    refreshPeriod: refreshPeriod,
    refreshAllTime: refreshAllTime,
    refreshNew: refreshNew,
    refreshChat: refreshChat,
    refreshThemes: refreshThemes,
    refreshFires: refreshFires,
    // the chat changed: update the peek shortly (several changes, one write)
    chatChanged: function() {
      if (chatTimer) return;
      chatTimer = setTimeout(function() {
        chatTimer = null;
        refreshChat().catch(function(err) { log("discover: chat peek error: " + (err && err.message)); });
      }, 5000);
    },
    // someone said something (not a command), for "N messages this hour"
    noteChat: function(time) { hourTimes.push(typeof time === "number" ? time : deps.now()); }
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
  withMovement: withMovement,
  seenKeys: seenKeys,
  releaseDate: releaseDate,
  newReleases: newReleases,
  chatPeek: chatPeek,
  themeNights: themeNights,
  djFires: djFires,
  createDiscover: createDiscover,
  NEW_DAYS: NEW_DAYS
};
