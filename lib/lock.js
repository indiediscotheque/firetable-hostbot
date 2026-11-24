// One copy of the bot at a time, and its heartbeat.
//
// Two copies of the bot (say, one started on a laptop with the live .env)
// would each run every command and fight over the decks. The running copy
// holds botLock, refreshed every minute and removed when it disconnects; a
// second copy waits and takes over if the first stops, or if its lock goes
// stale (3 minutes without a refresh). Before firebase-rules.json allows
// botLock, the bot says so and runs without the guard.
//
// botSeen: the server's time, written every minute while this copy runs the
// room. Anyone can read it (a number, nothing else), so an outside check can
// tell the room's bot is up: .github/workflows/uptime.yml fails, and GitHub
// emails, when it's more than 10 minutes old. A hung bot or one that lost
// its connection stops writing it, the same as one that crashed.
"use strict";
var crypto = require("crypto");
var os = require("os");

var LOCK_REFRESH_MS = 60 * 1000;
var LOCK_STALE_MS = 3 * 60 * 1000;
var HEARTBEAT_MS = 60 * 1000;
var TIMESTAMP = { ".sv": "timestamp" }; // the database's own time (firebase.database.ServerValue.TIMESTAMP)

/**
 * @param {object} deps
 * @param {function(): any} deps.db - firebase.database()
 * @param {function(): number} deps.serverNow - the database's time
 * @param {function(): void} [deps.tookOver] - this copy took over from another (what it saw meanwhile was the other's to handle)
 * @param {function(...*): void} [deps.log]
 * @param {function(number): void} [deps.exit] - process.exit
 * @returns {{botLock: Object, heartbeat: {beat: function(): void, start: function(): void}}}
 */
function createLock(deps) {
  var log = deps.log || console.log;
  var INSTANCE_ID = crypto.randomUUID();
  var botLock = {
    held: false,
    waitingSaid: false,
    ref: function() { return deps.db().ref("botLock"); },
    // Resolves once this copy holds the lock (or the rules don't allow it yet).
    acquire: function() {
      return new Promise(function(resolve) {
        var tryNow = function() {
          botLock.ref().transaction(function(cur) {
            if (!cur || cur.id === INSTANCE_ID || !(deps.serverNow() - (cur.seen || 0) < LOCK_STALE_MS)) {
              return {
                id: INSTANCE_ID,
                host: os.hostname(),
                pid: process.pid,
                since: TIMESTAMP,
                seen: TIMESTAMP
              };
            }
            return; // someone else holds it
          }).then(function(result) {
            if (result.committed) {
              botLock.held = true;
              // messages that came in while another copy ran were its to handle
              if (botLock.waitingSaid && deps.tookOver) deps.tookOver();
              botLock.ref().onDisconnect().remove();
              botLock.watch();
              log("holding the bot lock (only this copy runs the room)");
              return resolve();
            }
            var cur = result.snapshot.val() || {};
            if (!botLock.waitingSaid) {
              botLock.waitingSaid = true;
              log("another copy of the bot is running (on " + cur.host + ", pid " + cur.pid + "); this one waits and takes over if it stops.");
            }
            setTimeout(tryNow, 30 * 1000);
          }).catch(function(err) {
            if (/permission/i.test(err.code || err.message)) {
              log("bot lock: the database rules don't allow botLock yet (publish firebase-rules.json); running without the one-copy guard.");
              return resolve();
            }
            log("bot lock: " + err.message + "; trying again");
            setTimeout(tryNow, 30 * 1000);
          });
        };
        tryNow();
      });
    },
    // While holding it: refresh it, take it back after a reconnect (a
    // disconnect removes it), and stop if another copy took it meanwhile.
    watch: function() {
      setInterval(function() {
        botLock.ref().child("seen").set(TIMESTAMP).catch(function() {});
      }, LOCK_REFRESH_MS);
      deps.db().ref(".info/connected").on("value", function(snap) {
        if (snap.val() !== true) return;
        botLock.ref().transaction(function(cur) {
          if (cur && cur.id !== INSTANCE_ID) return; // taken: handled below
          return Object.assign({}, cur || {}, { id: INSTANCE_ID, host: os.hostname(), pid: process.pid, seen: TIMESTAMP });
        }).then(function(result) {
          if (result.committed) return botLock.ref().onDisconnect().remove();
          botLock.lost(result.snapshot.val());
        }).catch(function(err) {
          log("bot lock refresh failed:", err.message);
        });
      });
    },
    lost: function(cur) {
      log("another copy of the bot took over (on " + (cur && cur.host) + "); stopping this one.");
      (deps.exit || process.exit)(0);
    }
  };

  var heartbeat = {
    timer: null,
    beat: function() {
      deps.db().ref("botSeen").set(TIMESTAMP).catch(function(err) {
        if (!heartbeat.warned) log("heartbeat: " + err.message + (/permission/i.test(err.code || err.message) ? " (publish firebase-rules.json)" : ""));
        heartbeat.warned = true;
      });
    },
    start: function() {
      if (heartbeat.timer) return;
      heartbeat.beat();
      heartbeat.timer = setInterval(heartbeat.beat, HEARTBEAT_MS);
    }
  };

  return { botLock: botLock, heartbeat: heartbeat };
}

module.exports = { createLock: createLock, LOCK_STALE_MS: LOCK_STALE_MS };
