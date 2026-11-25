// Catching the bus: stepping down from the decks when you're done.
//   - after your next song (or the one you're playing): the seat's removeAfter,
//     which nextSong() in app.js acts on and the site shows as 🚏
//   - after a number of songs (!leaveafter 3): busSongs counts the songs left,
//     the one playing now included; when it's down to the last one it becomes
//     removeAfter, so everything that knows removeAfter keeps working
//   - at a time (!leavein 45m): busAt, a server time. When it comes, someone
//     playing finishes their song; anyone else steps off the decks or the line
// A new bus replaces the old one, and !dontremoveme (or !stay) cancels them all.
// Mods can do any of it for someone of lower rank (#121). The fields live on
// the seats in table/ and waitlist/, so they survive a bot restart.
"use strict";

var MAX_SONGS = 50;
var MAX_MINUTES = 12 * 60;
var TICK_MS = 15000;
var OFF_WORDS = /^(?:0|off|no|none|never|cancel|stop|stay)$/i;

/**
 * Minutes from "45", "45m", "45 min", "1h", "1h30", "1h 30m", "1:30", "1.5h", "2 hours".
 * @param {string} text
 * @returns {number} minutes, NaN if it isn't a duration
 */
function parseMinutes(text) {
  var s = String(text || "").trim().toLowerCase();
  var clock = s.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  var m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:m(?:in(?:ute)?s?)?)?)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return NaN;
  return Math.round(Number(m[1] || 0) * 60 + Number(m[2] || 0));
}

/**
 * A count of songs from "3", "3 songs", "three"... (digits only, and "a"/"one").
 * @param {string} text
 * @returns {number} NaN if it isn't one
 */
function parseSongs(text) {
  var s = String(text || "").trim().toLowerCase();
  if (/^(?:a|one)(?:\s+songs?)?$/.test(s)) return 1;
  var m = s.match(/^(\d+)(?:\s*(?:songs?|plays?|tracks?))?$/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Split "3 bea", "bea 3", "1h 30m bea" or "bea" into an amount and a name.
 * The amount may be at either end, up to three words long.
 * @param {string} args
 * @param {function(string): number} parse
 * @returns {{off: boolean, amount: number, name: string}} amount NaN when none was given
 */
function splitArgs(args, parse) {
  var words = String(args || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { off: false, amount: NaN, name: "" };
  if (OFF_WORDS.test(words[0])) return { off: true, amount: 0, name: words.slice(1).join(" ") };
  if (OFF_WORDS.test(words[words.length - 1]) && words.length > 1) return { off: true, amount: 0, name: words.slice(0, -1).join(" ") };
  for (var k = Math.min(3, words.length); k >= 1; k--) {
    var head = parse(words.slice(0, k).join(" "));
    if (!isNaN(head)) return { off: head === 0, amount: head, name: words.slice(k).join(" ") };
    var tail = parse(words.slice(words.length - k).join(" "));
    if (!isNaN(tail)) return { off: tail === 0, amount: tail, name: words.slice(0, words.length - k).join(" ") };
  }
  return { off: false, amount: NaN, name: words.join(" ") };
}

/** "1 minute", "3 songs" */
function plural(n, word) {
  return n + " " + word + (n == 1 ? "" : "s");
}

/** "25 minutes", "1 hour 5 minutes" */
function duration(mins) {
  mins = Math.max(1, Math.round(mins));
  var h = Math.floor(mins / 60), m = mins % 60;
  return h ? plural(h, "hour") + (m ? " " + plural(m, "minute") : "") : plural(m, "minute");
}

// ─── Seats ──────────────────────────────────────────────────────────────────

/** Where someone is: their seat, which list, and whether they're playing now. */
function find(room, id) {
  var lists = [[room.table, "deck"], [room.queue, "waitlist"]];
  for (var l = 0; l < lists.length; l++) {
    var seats = lists[l][0] || [];
    for (var i = 0; i < seats.length; i++) {
      if (seats[i] && seats[i].id == id) {
        var playing = lists[l][1] == "deck" && !!room.theDJ && room.theDJ.id == id;
        return { seat: seats[i], where: lists[l][1], playing: playing };
      }
    }
  }
  return null;
}

/** Change someone's seat, and the playing DJ's copy of it when that's a separate object. */
function change(room, id, fn) {
  var at = find(room, id);
  if (!at) return null;
  fn(at.seat);
  if (at.playing && room.theDJ !== at.seat) fn(room.theDJ);
  return at;
}

function clearSeat(seat) {
  seat.removeAfter = false;
  delete seat.busSongs;
  delete seat.busAt;
}

function save(room, at) {
  if (at.where == "waitlist") room.updateWaitlist(); else room.updateTable();
}

/** When someone's bus leaves, in words: "after this song", "after 3 more songs", "in 20 minutes". */
function when(room, seat, playing, their) {
  if (!seat) return "";
  if (seat.busAt) return "in " + duration((seat.busAt - room.serverNow()) / 60000);
  var left = seat.busSongs > 1 ? seat.busSongs : seat.removeAfter ? 1 : 0;
  if (!left) return "";
  if (playing) return left == 1 ? "after this song" : "after this song and " + (left - 1) + " more";
  return left == 1 ? "after " + their + " next song" : "after " + their + " next " + left + " songs";
}

// ─── Who it's for ─────────────────────────────────────────────────────────

/** A member's rank for bus commands: supermods outrank mods outrank everyone else (the bot too). */
function rank(u) {
  if (!u) return 0;
  if (u.supermod) return 2;
  if (u.mod) return 1;
  return 0;
}

/**
 * Who a bus command is for: the sender, or (mods) someone of lower rank.
 * @returns {{id?: string, name?: string, self?: boolean, error?: string}}
 */
function targetFor(room, senderId, senderName, args) {
  var name = (args || "").trim().replace(/^@/, "");
  if (!name) return { id: senderId, name: senderName, self: true };
  var users = room.users || {};
  var sender = users[senderId] || {};
  if (!sender.mod && !sender.supermod) return { error: "Only mods can do that for someone else, " + senderName + "." };
  var id = room.uidLookup(name);
  if (!id) return { error: "who is that" };
  if (id == senderId) return { id: senderId, name: senderName, self: true };
  if (rank(users[id]) >= rank(sender)) return { error: "You can't do that for " + name + "." };
  return { id: id, name: (users[id] && users[id].username) || name, self: false };
}

/**
 * Tell the person (and the mod who asked) about their bus.
 * @param {{id: string, name: string, self: boolean}} target
 * @param {string} selfLine - said in chat when it's your own
 * @param {string} theirLine - to the person, privately, when a mod did it
 * @param {string} modLine - to the mod
 */
function announce(room, target, byId, selfLine, theirLine, modLine) {
  if (target.self) return room.talk(selfLine);
  room.notify(target.id, theirLine, { kind: "bus", name: target.name });
  if (byId && byId !== target.id) room.notify(byId, modLine, { kind: "bus" });
}

/** The seat a bus command acts on, or null (and why, said) if they aren't DJing. */
function seatOf(room, target, on) {
  var at = find(room, target.id);
  if (!at) {
    room.talk(target.self ? target.name + ", you aren't even DJing..." : target.name + " isn't DJing.");
    return null;
  }
  // a mod sending the bot home (or keeping it) overrides the autopilot
  if (target.id == room.botid) room.autoDJ.override(on ? "down" : "up");
  return at;
}

// ─── Setting it ───────────────────────────────────────────────────────────

/**
 * After the next song (on), or not at all (off): !removeafter, !dontremoveme.
 * @param {{id: string, name: string, self: boolean}} target
 * @param {boolean} on
 * @param {string} [byId] - who asked
 */
function set(room, target, on, byId) {
  var at = seatOf(room, target, on);
  if (!at) return;
  var had = !!(at.seat.busSongs > 1 || at.seat.busAt);
  change(room, target.id, function(s) { clearSeat(s); s.removeAfter = on; });
  var playing = at.playing, who = target.self ? target.name + ", " : "";
  var whenYou = playing ? "at the end of this song" : "after your next song";
  if (on) {
    announce(room, target, byId, who + "I'll remove you " + whenYou + ".", "A mod has set it so you'll step down " + whenYou + ".",
      target.name + " will step down " + (playing ? "at the end of this song." : "after their next song."));
  } else if (had) {
    announce(room, target, byId, who + "you're off the bus. Stay as long as you like!", "You're staying on after all.", target.name + " is staying on.");
  } else {
    announce(room, target, byId, who + (playing ? "I will NOT remove you after this song." : "I will NOT remove you after your next song."),
      "You're staying on after all.", target.name + " is staying on.");
  }
  save(room, at);
}

/**
 * Step down after n songs (the one playing now counts): !leaveafter n.
 * @param {{id: string, name: string, self: boolean}} target
 * @param {number} n
 * @param {string} [byId]
 */
function setSongs(room, target, n, byId) {
  if (n <= 1) return set(room, target, true, byId);
  var at = seatOf(room, target, true);
  if (!at) return;
  change(room, target.id, function(s) { clearSeat(s); s.busSongs = n; });
  var yours = when(room, at.seat, at.playing, "your"), theirs = when(room, at.seat, at.playing, "their");
  announce(room, target, byId, ":bus: " + target.name + ", I'll remove you " + yours + ".",
    "A mod has set it so you'll step down " + yours + ".", target.name + " will step down " + theirs + ".");
  save(room, at);
}

/**
 * Step down in so many minutes (finishing the song playing then): !leavein 45m.
 * @param {{id: string, name: string, self: boolean}} target
 * @param {number} minutes
 * @param {string} [byId]
 */
function setTime(room, target, minutes, byId) {
  var at = seatOf(room, target, true);
  if (!at) return;
  var leaveAt = room.serverNow() + minutes * 60000;
  change(room, target.id, function(s) { clearSeat(s); s.busAt = leaveAt; });
  var span = duration(minutes);
  announce(room, target, byId, ":bus: " + target.name + ", your bus leaves in " + span + ". If you're playing then, you'll finish your song.",
    "A mod has set it so you'll step down in " + span + ".", target.name + " will step down in " + span + ".");
  save(room, at);
}

// ─── The song flow ──────────────────────────────────────────────────────────

/**
 * A DJ's song ended and they're staying (nextSong() in app.js, after it took
 * off whoever was leaving): one song fewer on their countdown.
 * @param {Object} dj - the seat of the DJ who just played
 */
function played(room, dj) {
  if (!dj || !(dj.busSongs > 1)) return;
  var countDown = function(s) {
    if (!(s.busSongs > 1)) return;
    s.busSongs--;
    if (s.busSongs > 1) return;
    delete s.busSongs;
    s.removeAfter = true; // the last one: nextSong() takes them off after it
  };
  if (!change(room, dj.id, countDown)) countDown(dj);
}

/** Buses that leave at a time: when it comes, step off (or finish the song playing). */
function tick(room) {
  if (!room.started) return;
  var now = room.serverNow();
  (room.table || []).concat(room.queue || []).filter(function(s) {
    return s && s.busAt && s.busAt <= now;
  }).forEach(function(s) {
    var at = find(room, s.id);
    if (!at) return;
    var name = (room.users[s.id] && room.users[s.id].username) || s.name || s.id;
    if (at.playing) {
      change(room, s.id, function(x) { delete x.busAt; x.removeAfter = true; });
      room.updateTable();
      room.talk(":bus: " + name + "'s bus is here: stepping down after this song.");
      return;
    }
    delete s.busAt;
    room.removeMe(s.id);
    room.talk(":bus: " + name + "'s bus is here" + (at.where == "waitlist" ? ", so they're off the waitlist." : ". Thanks for playing!"));
  });
}

// Checked now (a bus that came while the bot was down leaves at once), then every TICK_MS
var timer = null; // one room a process
function start(room) {
  if (timer) return;
  var check = function() {
    try { tick(room); } catch (e) { console.log("bus check failed:", e); }
  };
  timer = setInterval(check, TICK_MS);
  check();
}

// ─── Who's leaving ───────────────────────────────────────────────────────

/** Everyone on a bus, in deck order then the line: "Ann (after this song), Bea (in 20 minutes)". */
function list(room) {
  var riders = [];
  (room.table || []).concat(room.queue || []).forEach(function(s) {
    if (!s) return;
    var at = find(room, s.id);
    var w = when(room, s, !!(at && at.playing), "their");
    if (!w) return;
    var name = (room.users[s.id] && room.users[s.id].username) || s.name || s.id;
    riders.push(name + " (" + w + ")");
  });
  return riders.length ? ":bus: Catching the bus: " + riders.join(", ") + "." : "No one's catching the bus.";
}

/** Your own bus, in words, for !bus me. */
function status(room, id, name) {
  var at = find(room, id);
  if (!at) return name + ", you aren't DJing.";
  var w = when(room, at.seat, at.playing, "your");
  return w ? ":bus: " + name + ", you're stepping down " + w + "." : name + ", you aren't catching the bus.";
}

/**
 * @param {Object} room - app.js's room (lib/commands.js): table, queue, theDJ,
 *   users, botid, started, talk, notify, addCheck, uidLookup, removeMe,
 *   updateTable, updateWaitlist, autoDJ, serverNow
 */
function createBus(room) {
  var bound = function(fn) { return function() { return fn.apply(null, [room].concat(Array.prototype.slice.call(arguments))); }; };
  return {
    rank: rank, targetFor: bound(targetFor), set: bound(set), setSongs: bound(setSongs), setTime: bound(setTime),
    played: bound(played), tick: bound(tick), start: bound(start), list: bound(list), status: bound(status)
  };
}

module.exports = {
  createBus: createBus, parseMinutes: parseMinutes, parseSongs: parseSongs, splitArgs: splitArgs,
  MAX_SONGS: MAX_SONGS, MAX_MINUTES: MAX_MINUTES
};
