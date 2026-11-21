// The live stage's public summary (stage/), for firetable-user's embed/stage
// (shown on QueUp's screen), which reads the room over the database's REST
// streaming API with no sign-in.
//
//   stage/online        how many people are in the room (not the bot)
//   stage/deck          the people at the table, in order: [{id, n, av, bm}]
//                       (their name, their avatar style when they chose one,
//                       and their own Bouletmaton when they switched it on)
//   stage/style         everyone's avatar style when a supermod picked one
//                       (roomSettings/avatarStyle), so the stage draws the
//                       room's avatars
//   stage/colors        the playing song's colours ({color, txt})
//   stage/theme         the room's theme
//   stage/bpm           the song's tempo (songBpm: {started, bpm, src})
//   stage/tag           the room's facts on the song ({cid, adamData}, from tagUpdate)
//   stage/fires         the song's 🔥 count (songFires: {started, count})
//
// Why: the database bills every byte it sends. Without this the stage
// followed all of users/ (every member there has ever been, every change to
// any of them) and read four nodes every minute, in every browser showing it.
// This is one small node, written only when what it shows changes.
"use strict";

var avatars = require("./avatars");

var NAME_MAX = 40;
var STYLE_MAX = 80;
var THEME_MAX = 80;
var DECK_MAX = 12;

var str = function(v, max) { return typeof v === "string" && v ? v.slice(0, max) : null; };
var num = function(v) { return typeof v === "number" && isFinite(v) ? v : null; };

/**
 * The stage summary from the room's state.
 * @param {object} s
 * @param {Object<string, object>} s.users - users/ (uid -> profile)
 * @param {string} [s.botid] - the bot's own uid (not counted as in the room)
 * @param {Array|Object} [s.table] - table/: the seats [{id, name}]
 * @param {object} [s.colors] - colors/
 * @param {string} [s.theme] - theme/
 * @param {object} [s.bpm] - songBpm/
 * @param {object} [s.tag] - tagUpdate/
 * @param {object} [s.fires] - songFires/
 * @param {string} [s.style] - roomSettings/avatarStyle
 * @returns {object}
 */
function stageOf(s) {
  var users = s.users || {};
  var online = 0;
  Object.keys(users).forEach(function(uid) {
    var u = users[uid];
    if (u && u.status === true && !u.hostbot && uid !== s.botid) online++;
  });
  var seats = Array.isArray(s.table) ? s.table : Object.keys(s.table || {}).map(function(k) { return s.table[k]; });
  var deck = seats.filter(function(d) { return d && d.id && typeof d.id === "string"; }).slice(0, DECK_MAX).map(function(d) {
    var u = users[d.id] || {};
    var seat = { id: d.id, n: str(u.username, NAME_MAX) || str(d.name, NAME_MAX) || "DJ" };
    var av = str(u.avatarStyle, STYLE_MAX);
    if (av) seat.av = av;
    var bm = avatars.activeBoulet(u);
    if (bm) seat.bm = bm;
    return seat;
  });
  var c = s.colors && typeof s.colors === "object" ? s.colors : null;
  var colors = c && str(c.color, 40) ? { color: str(c.color, 40), txt: str(c.txt, 40) || "#fff" } : null;
  var b = s.bpm && typeof s.bpm === "object" ? s.bpm : null;
  var bpm = b && num(b.started) !== null && num(b.bpm) !== null ? { started: b.started, bpm: b.bpm } : null;
  var t = s.tag && typeof s.tag === "object" ? s.tag : null;
  var tag = t && t.cid != null && t.adamData && typeof t.adamData === "object" ? { cid: String(t.cid), adamData: t.adamData } : null;
  var f = s.fires && typeof s.fires === "object" ? s.fires : null;
  var fires = f && num(f.started) !== null && num(f.count) !== null ? { started: f.started, count: Math.max(0, f.count) } : null;
  return {
    online: online,
    deck: deck,
    colors: colors,
    theme: str(s.theme, THEME_MAX),
    bpm: bpm,
    tag: tag,
    fires: fires,
    style: avatars.normalizeAvatarStyle(s.style)
  };
}

/**
 * The summary without what older database rules refuse (stage/style and each
 * seat's bm), written until the rules that allow them are published.
 */
function legacyOf(v) {
  var out = Object.assign({}, v, {
    deck: v.deck.map(function(d) { var seat = Object.assign({}, d); delete seat.bm; return seat; })
  });
  delete out.style;
  return out;
}

/**
 * Keeps stage/ in step with the room: follows table, colors, theme, songBpm,
 * tagUpdate and songFires (all small, and mostly the bot's own writes, which
 * cost no download), and is told when a member changes (`changed`). Writes at
 * most once per `delay` ms, and only when the summary is different.
 * @param {object} deps
 * @param {object} deps.db - firebase.database()
 * @param {function(): Object} deps.users - the members as the bot holds them
 * @param {function(): string} [deps.botid]
 * @param {number} [deps.delay] - ms to gather changes before writing (default 500)
 * @param {function(string)} [deps.log]
 */
function createStage(deps) {
  var log = deps.log || function() {};
  var delay = deps.delay == null ? 500 : deps.delay;
  var state = { table: null, colors: null, theme: null, bpm: null, tag: null, fires: null, style: null };
  var legacy = false; // the rules refused stage/style or a seat's bm: leave them out
  var last = null;
  var timer = null;
  var started = false;
  var refusedSaid = false;

  var value = function() {
    return stageOf({
      users: deps.users() || {}, botid: deps.botid ? deps.botid() : null, table: state.table, colors: state.colors,
      theme: state.theme, bpm: state.bpm, tag: state.tag, fires: state.fires, style: state.style
    });
  };
  var publish = function() {
    timer = null;
    var v = value();
    var json = JSON.stringify(v);
    if (json === last) return Promise.resolve(false);
    last = json;
    var write = function(data) { return deps.db.ref("stage").set(data); };
    var refused = function(err) {
      last = null; // try again with the next change
      if (!refusedSaid) {
        refusedSaid = true;
        log("stage: couldn't save the stage summary (deploy firebase-rules.json): " + (err && err.message));
      }
      return false;
    };
    if (legacy) return write(legacyOf(v)).then(function() { return true; }, refused);
    return write(v).then(function() { return true; }, function(err) {
      // Older rules refuse the avatar fields: write the rest, as before
      return write(legacyOf(v)).then(function() {
        legacy = true;
        log("stage: saved without the room's avatar style and Bouletmatons (deploy firebase-rules.json for them)");
        return true;
      }, function() { return refused(err); });
    });
  };
  var changed = function() {
    if (!started || timer) return;
    timer = setTimeout(publish, delay);
    if (timer && timer.unref) timer.unref();
  };

  return {
    /** Start following the room. */
    start: function() {
      if (started) return;
      started = true;
      [["table", "table"], ["colors", "colors"], ["theme", "theme"], ["songBpm", "bpm"], ["tagUpdate", "tag"], ["songFires", "fires"], ["roomSettings/avatarStyle", "style"]].forEach(function(p) {
        deps.db.ref(p[0]).on("value", function(snap) {
          state[p[1]] = snap.val();
          changed();
        }, function(err) { log("stage: couldn't follow " + p[0] + ": " + (err && err.message)); });
      });
      changed();
    },
    /** A member changed (joined, left, renamed, a new avatar). */
    changed: changed,
    /** Write now if it changed (tests). */
    flush: function() {
      if (timer) clearTimeout(timer);
      return publish();
    },
    value: value
  };
}

module.exports = { stageOf: stageOf, legacyOf: legacyOf, createStage: createStage };
