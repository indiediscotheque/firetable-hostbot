// Each DJ's grab stats, summed by the bot (grabCount/<uid>), so the site
// doesn't download every grab a DJ has ever had at every sign-in.
//
//   grabs/<dj>/<track>/<listener> = when     written by the listener's site, once
//   grabCount/<dj> = {n, t, last, lastAt}    n grabs over t tracks; the latest
//                                            grab's track and time (for the
//                                            site's "someone added your track"
//                                            toast). Only that DJ can read it.
//
// The bot follows grabs/ with one listener: everything once at start, then
// each new grab. A summary is written only when it changes.
"use strict";

/**
 * A DJ's summary from their grabs/<dj> value.
 * @param {Object} tracks - {trackKey: {listenerUid: time}}
 * @returns {{n: number, t: number, last: string|null, lastAt: number}|null} null: no grabs
 */
function summaryOf(tracks) {
  var n = 0, t = 0, last = null, lastAt = 0;
  Object.keys(tracks || {}).forEach(function(track) {
    var who = tracks[track];
    if (!who || typeof who !== "object") return;
    var here = 0;
    Object.keys(who).forEach(function(uid) {
      var at = Number(who[uid]) || 0;
      here++;
      if (at > lastAt || (at === lastAt && last !== null && track > last)) { lastAt = at; last = track; }
    });
    if (here) { n += here; t++; }
  });
  return n ? { n: n, t: t, last: last, lastAt: lastAt } : null;
}

/**
 * Keeps grabCount/ in step with grabs/.
 * @param {object} deps
 * @param {object} deps.db - firebase.database()
 * @param {number} [deps.delay] - ms to gather changes before writing (default 1000)
 * @param {function(string): void} [deps.log]
 */
function createGrabCounts(deps) {
  var log = deps.log || function() {};
  var delay = deps.delay == null ? 1000 : deps.delay;
  var written = {}; // dj -> JSON of the summary last written (or "null")
  var pending = {}; // dj -> their grabs/<dj> value, waiting to be summed
  var timer = null;
  var started = false;
  var refusedSaid = false;

  var flush = function() {
    timer = null;
    var updates = {};
    Object.keys(pending).forEach(function(dj) {
      var s = summaryOf(pending[dj]);
      var json = JSON.stringify(s);
      if (written[dj] === json) return;
      written[dj] = json;
      updates[dj] = s;
    });
    pending = {};
    var djs = Object.keys(updates);
    if (!djs.length) return Promise.resolve(0);
    return deps.db.ref("grabCount").update(updates).then(function() { return djs.length; }, function(err) {
      djs.forEach(function(dj) { delete written[dj]; });
      if (!refusedSaid) {
        refusedSaid = true;
        log("grabs: couldn't save the grab counts (deploy firebase-rules.json): " + (err && err.message));
      }
      return 0;
    });
  };
  var changed = function(dj, val) {
    pending[dj] = val;
    if (timer) return;
    timer = setTimeout(flush, delay);
    if (timer && timer.unref) timer.unref();
  };

  return {
    /** Start following grabs/ (the summaries the bot has are written once it's read). */
    start: function() {
      if (started) return;
      started = true;
      var ref = deps.db.ref("grabs");
      var on = function(snap) { changed(snap.key, snap.val()); };
      ref.on("child_added", on, function(err) {
        log("grabs: can't read grabs/ (deploy firebase-rules.json): " + (err && err.message) + "; the site counts them itself");
      });
      ref.on("child_changed", on);
      ref.on("child_removed", function(snap) { changed(snap.key, null); });
    },
    /** Write now (tests). */
    flush: function() {
      if (timer) clearTimeout(timer);
      return flush();
    }
  };
}

module.exports = { summaryOf: summaryOf, createGrabCounts: createGrabCounts };
