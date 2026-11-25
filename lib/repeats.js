// No song twice in a few hours.
//
// A track the room played in the last REPEAT_HOURS (4 by default, 0 turns
// this off) is passed over when its DJ's turn comes: the bot plays the first
// track in their list that's neither flagged nor played lately, and leaves the
// skipped one where it is, so it gets its turn again once the hours are up.
// The same upload counts (type + id), and so does another upload of the same
// song: the same "Artist - Title" once upload junk, "feat." credits,
// punctuation, accents and case are set aside (nameKey). When every track in a
// list was played lately, the first one plays anyway: the decks never go quiet
// over it.
//
// What was played lately is kept in playedRecently/<type><cid> =
// { w: when it started, u: until when it's passed over, n: its nameKey,
//   dj: who played it }. The site reads it to warn on playlist rows
// (firetable-user js/recent-plays.js, which has the same nameKey), and the bot
// reads it back after a restart.
"use strict";

var HOUR = 60 * 60 * 1000;
var TRACK_PAGE = 20;
var SKIPPED_MAX = 10; // skipped tracks reported for one turn
var HISTORY_SEED = 150; // Recent plays read once at startup (about 8 hours)

// Bracketed upload junk: (Official Video), [Lyrics], (HD), (2011 Remaster)…
var NOISE = /[([][^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|remaster(?:ed)?|explicit|clip)\b[^)\]]*[)\]]/gi;
// "feat. Someone", up to the next bracket or the end
var FEAT = /\s(?:feat\.?|ft\.?|featuring)\s[^()[\]]*/gi;

/**
 * The key two uploads of the same song share: "artist title", folded. A name
 * without an "Artist - Title" separator has none (""), so a lone "Intro"
 * never matches another.
 * @param {string} name - "Artist - Title"
 * @returns {string}
 */
function nameKey(name) {
  var s = String(name == null ? "" : name);
  if (!/\S\s[-–—]\s\S/.test(s)) return "";
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(NOISE, " ").replace(FEAT, " ").toLowerCase()
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** "1 hr 5 min", "40 min", "1 min" */
function span(ms) {
  var min = Math.max(1, Math.round(ms / 60000));
  var h = Math.floor(min / 60), m = min % 60;
  return (h ? h + " hr" + (m ? " " : "") : "") + (m ? m + " min" : "");
}

// The memory, shared by the functions below: { deps, windowMs, byUpload:
// "<type><cid>" -> { w, u, n, dj }, byName: nameKey -> the latest of those,
// told: "<djid> <type><cid>" -> until when they've been told it was skipped }

var on = function(m) { return m.windowMs > 0; };
var ref = function(m) { return m.deps.db().ref("playedRecently"); };
var idOf = function(t) { return t && t.cid != null && t.cid !== 0 && t.cid !== "0" ? String(t.type) + t.cid : ""; };

function remember(m, id, e) {
  if (!id || !e || !(e.u > m.deps.now())) return;
  var old = m.byUpload[id];
  if (old && old.w >= e.w) return;
  m.byUpload[id] = e;
  if (e.n && (!m.byName[e.n] || m.byName[e.n].w <= e.w)) m.byName[e.n] = e;
}

// Forget what's past its hours; their ids, to remove from the database.
function prune(m) {
  var now = m.deps.now(), gone = [];
  Object.keys(m.byUpload).forEach(function(id) {
    if (m.byUpload[id].u <= now) { gone.push(id); delete m.byUpload[id]; }
  });
  Object.keys(m.byName).forEach(function(n) { if (m.byName[n].u <= now) delete m.byName[n]; });
  Object.keys(m.told).forEach(function(k) { if (m.told[k] <= now) delete m.told[k]; });
  return gone;
}

function entryFor(m, s, w) {
  var name = s.name || ((s.artist || "") + " - " + (s.title || ""));
  var e = { w: w, u: w + m.windowMs, n: nameKey(name) || null, dj: s.djname || s.dj || null };
  return JSON.parse(JSON.stringify(e)); // no undefined fields for Firebase
}

// What the database should hold after a load: changed entries, and nulls for
// the ones that are gone.
function loadUpdates(m, stored) {
  var updates = {};
  Object.keys(m.byUpload).forEach(function(id) { if (!stored[id] || stored[id].w !== m.byUpload[id].w) updates[id] = m.byUpload[id]; });
  Object.keys(stored).forEach(function(id) { if (!m.byUpload[id]) updates[id] = null; });
  prune(m).forEach(function(id) { updates[id] = null; });
  return updates;
}

/**
 * Read what was played lately: playedRecently, the latest Recent plays (for
 * plays from before this was running) and the song on the decks. Never
 * fails: without it nothing is skipped.
 */
function load(m, current) {
  if (!on(m)) return ref(m).remove().catch(function() {}); // off: no warnings left on the site
  return Promise.all([
    ref(m).once("value"),
    m.deps.db().ref("songHistory").limitToLast(HISTORY_SEED).once("value")
  ]).then(function(snaps) {
    var stored = snaps[0].val() || {};
    Object.keys(stored).forEach(function(id) { remember(m, id, stored[id]); });
    snaps[1].forEach(function(child) {
      var h = child.val();
      if (h && h.when) remember(m, idOf(h), entryFor(m, h, h.when));
    });
    if (current && current.started) remember(m, idOf(current), entryFor(m, current, current.started));
    var updates = loadUpdates(m, stored);
    if (Object.keys(updates).length) return ref(m).update(updates);
  }).then(function() {
    console.log("repeats: " + Object.keys(m.byUpload).length + " songs played in the last " + m.windowMs / HOUR + " hours are skipped until their time's up");
  }, function(err) {
    console.log("repeats: couldn't read what was played lately (nothing is skipped until it's known):", err && err.message);
  });
}

// A song started: remember it, and drop what's past its hours.
function played(m, s) {
  var id = idOf(s);
  if (!on(m) || !id) return Promise.resolve();
  var e = entryFor(m, s, s.started || m.deps.now());
  remember(m, id, e);
  var updates = {};
  prune(m).forEach(function(gone) { updates[gone] = null; });
  updates[id] = e;
  return ref(m).update(updates).catch(function(err) {
    console.log("repeats: couldn't save the play:", err && err.message);
  });
}

// When this track (or another upload of its song) was played, if that's
// recent enough to pass it over; otherwise null.
function lately(m, track) {
  if (!on(m) || !track) return null;
  var now = m.deps.now();
  var e = m.byUpload[idOf(track)];
  if (e && e.u > now) return e;
  var n = nameKey(track.name);
  e = n && m.byName[n];
  return e && e.u > now ? e : null;
}

// Look through a page of the list: the first unflagged track (played anyway
// when everything was played lately) and the first one not played lately.
function scan(m, snap, st) {
  snap.forEach(function(child) {
    var track = child.val();
    if (st.found || !track || track.flagged) return;
    if (!st.first) st.first = { key: child.key, track: track };
    var e = lately(m, track);
    if (!e) { st.found = { key: child.key, track: track }; return; }
    if (!st.seen[child.key] && st.skipped.length < SKIPPED_MAX) st.skipped.push({ key: child.key, track: track, played: e });
    st.seen[child.key] = true;
  });
}

function answer(st) {
  if (st.found) return Object.assign(st.found, { skipped: st.skipped });
  if (st.first) return Object.assign(st.first, { skipped: [], allRecent: true });
  return null;
}

// The list in growing pages, in play order.
function byPage(m, listRef, st, after, size) {
  var query = listRef.orderByKey();
  if (after) query = query.startAfter(after);
  return query.limitToFirst(size).once("value").then(function(snap) {
    scan(m, snap, st);
    var last = null;
    snap.forEach(function(child) { last = child.key; });
    if (st.found || snap.numChildren() < size) return answer(st);
    return byPage(m, listRef, st, last, Math.min(size * 4, 2000));
  });
}

/**
 * The track a DJ's list plays next: the first that's neither flagged nor
 * played lately. One indexed query on flagged/date: unflagged tracks sort
 * first there, in key order, so it costs the same however many flagged
 * tracks sit at the top of the list (DJs keep thousands there). Very old
 * flags without a date look unflagged to the index, so the answer is
 * checked here; when the page holds nothing to play, the list is read in
 * growing pages instead.
 */
function firstPlayable(m, listRef) {
  var st = { found: null, first: null, skipped: [], seen: {} };
  return listRef.orderByChild("flagged/date").endAt(null).limitToFirst(TRACK_PAGE).once("value").then(function(snap) {
    scan(m, snap, st);
    if (st.found || snap.numChildren() < TRACK_PAGE) return answer(st);
    return byPage(m, listRef, st, null, TRACK_PAGE);
  });
}

var quoted = function(t) { return "\"" + String((t && t.name) || "this track").slice(0, 80) + "\""; };

// The skipped songs a DJ hasn't been told about yet (each once, until it can
// play again).
function untold(m, djid, skipped) {
  var now = m.deps.now();
  return skipped.filter(function(s) {
    var k = djid + " " + idOf(s.track);
    if (m.told[k] > now) return false;
    m.told[k] = s.played.u;
    return true;
  });
}

/**
 * What to tell a DJ whose turn skipped songs, or null: once per song until it
 * can play again, so a song left at the top doesn't bring a notice every turn.
 */
function notice(m, djid, pick) {
  if (!pick) return null;
  var now = m.deps.now();
  var hours = m.windowMs / HOUR;
  if (pick.allRecent) {
    var all = djid + " *";
    if (m.told[all] > now) return null;
    m.told[all] = now + HOUR;
    return "Every song in your playlist has played in the last " + hours + " hours, so " + quoted(pick.track) + " plays again. Add a few more to keep things fresh!";
  }
  var fresh = untold(m, djid, pick.skipped);
  if (!fresh.length) return null;
  var s = fresh[0];
  var what = fresh.length === 1 ? "Skipped " + quoted(s.track) + ": the room heard it " + span(now - s.played.w) + " ago" +
    (s.played.dj ? " (" + s.played.dj + ")" : "") + ". It can play again in " + span(s.played.u - now) + "."
    : "Skipped " + fresh.length + " songs the room heard in the last " + hours + " hours (" + quoted(s.track) + " and more).";
  return what + " Playing " + quoted(pick.track) + " instead.";
}

/**
 * @param {{ db: () => any, now: () => number, hours: number }} deps - db:
 *   firebase.database(); now: the server's time; hours: how long a play
 *   counts (0: off)
 */
function createRepeats(deps) {
  var m = { deps: deps, windowMs: Math.max(0, Number(deps.hours) || 0) * HOUR, byUpload: {}, byName: {}, told: {} };
  return {
    /** @param {Object|null} current - songToPlay @returns {Promise<void>} */
    load: function(current) { return load(m, current); },
    /** @param {Object} s - songToPlay (type, cid, artist, title, started, djname) */
    played: function(s) { return played(m, s); },
    /** @param {Object} track - a list entry (type, cid, name) @returns {{w: number, u: number, n?: string, dj?: string}|null} */
    lately: function(track) { return lately(m, track); },
    /**
     * @param {any} listRef
     * @returns {Promise<{key: string, track: Object, skipped: Array<{key: string, track: Object, played: Object}>, allRecent?: boolean}|null>}
     */
    firstPlayable: function(listRef) { return firstPlayable(m, listRef); },
    /** @param {string} djid @param {Object} pick - firstPlayable's answer @returns {string|null} */
    notice: function(djid, pick) { return notice(m, djid, pick); },
    hours: function() { return m.windowMs / HOUR; }
  };
}

module.exports = { createRepeats: createRepeats, nameKey: nameKey, span: span };
