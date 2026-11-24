// The room's global tag system (gts), and how a mod's tag fix spreads.
//
// globalTracks/<type><cid> keeps each upload's tags. Once the play history has
// been published (tools/history: globalSongsMeta/ready), every upload is also
// linked to its track in globalSongs, which every copy, spelling and upload of
// a recording shares: the room's own play count, the true first play (back to
// ADAM and Last.fm), and every version of the song in globalWorks. Until then
// the bot works as before (per-upload first plays, Last.fm counts).
// Each call works on the song (and the DJ list) it was started for: the
// lookups below answer later, when another song may be playing, and their
// answers must not land on that one.
"use strict";
var tags = require("./tags");
var retag = require("./retag");
var swaps = require("./swaps");
var placeholderTags = require("../tools/history/placeholders").load(); // tags that aren't songs

/**
 * @param {object} deps
 * @param {function(): any} deps.db - firebase.database()
 * @param {function(): any} deps.song - the song on the decks
 * @param {function(): string} deps.botid
 * @param {function(): number} deps.serverNow
 * @param {function(): any} deps.currentListRef - the playing DJ's list
 * @param {{playcount: function(string, string): Promise<number|boolean>}} deps.lastfm
 * @param {function(string, function(Object): any): any} deps.discoverDo - run a Discover job
 * @param {function(string, string, Object=): any} deps.notify - a private notice to a member
 * @param {function(string): void} deps.talk - say something in the room
 * @param {function(...*): void} [deps.log]
 * @returns {{gts: Object, spreadTags: Object, start: function(): void}}
 */
function createGts(deps) {
  var log = deps.log || console.log;
  var songIndex = { ready: false };

  var gts = {
    np: function(s, listRef) {
      if (!s || !s.cid) return;
      var upKey = s.type + "" + s.cid;
      var globalpeek = deps.db().ref("globalTracks/" + upKey);
      globalpeek.once("value")
        .then(function(snapshot) {
          var thing = snapshot.val();
          var now = Date.now();
          var dj = s.djname || null;
          var upload;
          // played before: it has a play date (an upload a mod tagged in
          // Discover before anyone played it has its tags and nothing else)
          var played = !!(thing && thing.artist && (thing.first_play_date || thing.last_play_date));
          var preTagged = !played && !!(thing && thing.artist);
          if (played) {
            // played before: use its saved tags, then update the last play
            // (just those fields: a mod's tag fix at the same moment stays)
            var lastPlay = { last_play_date: now, last_play_dj: dj };
            // first played as "Release" (YouTube's stand-in channel for a new
            // release): the artist its description names, now it's known
            if (swaps.isStandIn(thing.artist) && s.artist && s.artist !== "Unknown" && !swaps.isStandIn(s.artist)) {
              lastPlay.artist = s.artist;
              thing = Object.assign({}, thing, { artist: s.artist });
            }
            upload = globalpeek.update(lastPlay).then(function() { return thing; });
          } else {
            // first play of this upload (or one the history linked but never
            // played): under the tags a mod gave it in Discover, if they did
            var firstPlay = {
              artist: preTagged ? thing.artist : s.artist, title: preTagged ? String(thing.title || "") : s.title, type: s.type,
              first_play_date: now, first_play_dj: dj, last_play_date: now, last_play_dj: dj
            };
            thing = Object.assign({}, thing || {}, firstPlay);
            upload = globalpeek.update(firstPlay).then(function() { return thing; });
          }
          return upload.then(function(up) {
            // a first play has no earlier play to show
            if (!songIndex.ready) return gts.reportNp(s, listRef, played ? up : { artist: up.artist, title: up.title, type: up.type });
            return gts.countPlay(s, upKey, up).then(function(track) {
              var fixed = {};
              if (preTagged) {
                // a mod's own tags: they stand
              } else if (!played && gts.knownSpelling(track)) {
                // an upload new to the room, of a track the history already
                // has: it's written the track's way (a mod's fix, or the
                // history's best spelling), not the way this upload came in
                if (track.artist !== up.artist) fixed.artist = track.artist;
                if (track.title !== up.title) fixed.title = track.title;
              } else {
                // the history writes this track with accents the upload's tags
                // lost (the old Last.fm bug): use them, and keep them
                if (track.artist && tags.accentsRestored(up.artist, track.artist)) fixed.artist = track.artist;
                if (track.title && tags.accentsRestored(up.title, track.title)) fixed.title = track.title;
              }
              if (fixed.artist || fixed.title) {
                up = Object.assign({}, up, fixed);
                globalpeek.update(fixed).catch(function(err) { log("track spelling error:", err && err.message); });
                var respelled = {};
                respelled[upKey] = { artist: up.artist, title: up.title };
                deps.discoverDo("retag", function(d) { return d.retag(respelled); });
              }
              gts.reportNp(s, listRef, up, track);
            }, function(err) {
              log("song index error:", err && err.message);
              gts.reportNp(s, listRef, up);
            });
          });
        })
        .catch(function(err) {
          log("global tags error:", err && err.message);
        });
    },
    // Does the history have its own spelling of this track (countPlay's result)?
    // A track this play made has only the upload's own tags.
    knownSpelling: function(track) {
      return !!(track && track.known && track.artist && track.title && track.artist !== "Unknown" &&
        !placeholderTags.is(track.artist, track.title));
    },
    // The track this upload is (linking it the first time, by its tags), with
    // this play counted. Resolves with {id, plays, first..., prev..., work,
    // known: the track was in the history before this play}.
    countPlay: function(s, upKey, up) {
      var db = deps.db();
      var dj = s.djname || null;
      var artist = up.title && up.artist && up.artist !== "Unknown" ? up.artist : s.artist;
      var title = up.title && up.artist && up.artist !== "Unknown" ? up.title : s.title;
      return gts.linkTrack(upKey, up, artist, title).then(function(link) {
        var prev = null;
        var existed = false;
        var counted = db.ref("globalSongs/" + link.id).transaction(function(cur) {
          existed = !!(cur && cur.artist);
          cur = cur || { artist: artist, title: title, work: link.work, plays: 0 };
          prev = { plays: cur.plays || 0, date: cur.last_play_date || null, dj: cur.last_play_dj || null };
          cur.plays = (cur.plays || 0) + 1;
          if (!cur.first_play_date) {
            cur.first_play_date = Date.now();
            cur.first_play_dj = dj;
          }
          cur.last_play_date = Date.now();
          cur.last_play_dj = dj;
          if (!cur.work && link.work) cur.work = link.work;
          return cur;
        });
        return counted.then(function(res) {
          var t = res.snapshot.val() || {};
          var workId = t.work || link.work;
          s.songId = link.id;
          var track = {
            id: link.id, plays: prev ? prev.plays : (t.plays || 1) - 1, artist: t.artist, title: t.title, known: existed,
            first_play_date: t.first_play_date, first_play_dj: t.first_play_dj,
            prev_play_date: prev && prev.date, prev_play_dj: prev && prev.dj
          };
          if (!workId) return track;
          return db.ref("globalWorks/" + workId).transaction(function(w) {
            w = w || { artist: artist, title: title, plays: 0, versions: 1 };
            w.plays = (w.plays || 0) + 1;
            if (!w.first_play_date) {
              w.first_play_date = t.first_play_date;
              w.first_play_dj = t.first_play_dj || null;
            }
            return w;
          }).then(function(wr) {
            var w = wr.snapshot.val() || {};
            if ((w.versions || 1) > 1) track.work_plays = (w.plays || 1) - 1;
            return track;
          }, function() { return track; });
        });
      });
    },
    linkTrack: function(upKey, up, artist, title) {
      var db = deps.db();
      if (up && up.song) {
        return db.ref("globalSongs/" + up.song + "/work").once("value").then(function(w) { return { id: up.song, work: w.val() }; });
      }
      var p = tags.parse(artist, title);
      var keys = tags.keysOf(p);
      // too vague to match ("Unknown - Intro"), or a placeholder that isn't a
      // song ("Unavailable - Unavailable", tools/history/placeholder-tags.csv):
      // this upload is its own track, so they never pile up into one
      var vague = p.weak || placeholderTags.is(artist, title);
      var keyHash = vague ? null : tags.hash(keys.track);
      var workHash = vague ? null : tags.hash(keys.song);
      var found = keyHash ? db.ref("globalSongKeys/" + keyHash).once("value").then(function(snap) { return snap.val(); }) : Promise.resolve(null);
      return found.then(function(id) {
        if (id) {
          return db.ref("globalSongs/" + id + "/work").once("value").then(function(w) { return { id: id, work: w.val(), known: true }; });
        }
        id = "t" + tags.hash(vague ? "upload:" + upKey : keys.track);
        var work = workHash ? db.ref("globalWorkKeys/" + workHash).once("value").then(function(snap) { return snap.val() || "s" + workHash; }) : Promise.resolve("s" + tags.hash("track:" + id));
        return work.then(function(workId) {
          var updates = {};
          if (keyHash) updates["globalSongKeys/" + keyHash] = id;
          if (workHash) updates["globalWorkKeys/" + workHash] = workId;
          return db.ref().update(updates).then(function() { return { id: id, work: workId }; });
        });
      }).then(function(link) {
        return db.ref("globalTracks/" + upKey + "/song").set(link.id).then(function() { return link; });
      });
    },
    fixTags: function(s, listRef, fixedartist, fixedtitle, by) {
      if (!s || !s.cid) return;
      var upKey = s.type + "" + s.cid;
      var globalpeek = deps.db().ref("globalTracks/" + upKey);
      globalpeek.once("value")
        .then(function(snapshot) {
          var thing = snapshot.val();
          // every fix is kept: the history toolkit trusts these most, and
          // spreadTags passes it on to the other copies and the artist's songs
          var logRef = deps.db().ref("tagLog").push();
          spreadTags.own[logRef.key] = true;
          logRef.set({
            k: upKey, a: fixedartist, t: fixedtitle, by: by || null, at: Date.now(),
            fa: (thing && thing.artist) || s.artist || null, ft: (thing && thing.title) || s.title || null
          }).catch(function(err) { log("tag log error:", err && err.message); });
          if (thing && thing.artist) {
            thing.artist = fixedartist;
            thing.title = fixedtitle;
            return globalpeek.update({ artist: fixedartist, title: fixedtitle }).then(function() {
              gts.reportNp(s, listRef, thing, gts.lastTrack(s));
              return Promise.resolve(gts.learnSpelling(thing.song || s.songId, fixedartist, fixedtitle, upKey)).then(function(link) {
                if (link && link.id) s.songId = link.id; // this play goes in the log under its own track
              });
            });
          }
          var fresh = {
            artist: fixedartist,
            title: fixedtitle,
            last_play_date: Date.now(),
            first_play_date: Date.now(),
            last_play_dj: s.djname || null,
            first_play_dj: s.djname || null,
            type: s.type
          };
          return globalpeek.update(fresh).then(function() {
            gts.reportNp(s, listRef, fresh, gts.lastTrack(s));
            return gts.learnSpelling(s.songId, fixedartist, fixedtitle, upKey);
          });
        })
        .catch(function(err) {
          log("fix tags error:", err && err.message);
        });
    },
    // A mod's fix is how the track is written from now on, and the fixed
    // spelling finds this track next time it turns up on another upload. A fix
    // that names another version ("Kites" -> "Kites (Limousines Remix)") says
    // this upload was filed under the wrong track: it moves to that version's
    // track, and the other uploads keep theirs.
    /**
     * A mod's spelling for a track goes on its song (or links the upload to its own track).
     * @returns {Promise<{id: string, work?: string}|void>} the track it's linked to now, when that changed
     */
    learnSpelling: function(trackId, artist, title, upKey) {
      if (!songIndex.ready || !trackId) return;
      var db = deps.db();
      var p = tags.parse(artist, title);
      /** @returns {Promise<any>} */
      var rename = function() {
        var updates = {};
        updates["globalSongs/" + trackId + "/artist"] = artist;
        updates["globalSongs/" + trackId + "/title"] = title;
        if (!p.weak && !placeholderTags.is(artist, title)) updates["globalSongKeys/" + tags.hash(tags.keysOf(p).track)] = trackId;
        return db.ref().update(updates);
      };
      if (!upKey || p.weak) return rename();
      return db.ref("globalSongs/" + trackId).once("value").then(function(snap) {
        var t = snap.val();
        if (!t || tags.sameVersion(tags.keysOf(tags.parse(t.artist || "", t.title || "")).version, tags.keysOf(p).version)) return rename();
        // the track is this upload alone: it was this version all along
        return db.ref("globalTracks").orderByChild("song").equalTo(trackId).limitToFirst(2).once("value").then(function(ups) {
          var others = 0;
          ups.forEach(function(c) { if (c.key !== upKey) others++; });
          if (!others) return rename();
          return gts.linkTrack(upKey, null, artist, title).then(function(link) {
            // a track new to the history is written the way the mod wrote it
            return db.ref("globalSongs/" + link.id).transaction(function(cur) {
              return cur || { artist: artist, title: title, work: link.work || null, plays: 0 };
            }).then(function() { return link; });
          });
        });
      }).catch(function(err) { log("learn spelling error:", err && err.message); });
    },
    lastTrack: function(s) {
      return s && s.track || null;
    },
    // Put the saved tags (adm) on song s, tell the room, and rename the track in
    // the DJ's list (listRef) to match. track: the play history for it (counts
    // and the true first play), when the history has been published.
    reportNp: function(s, listRef, adm, track) {
      if (!adm) return;
      // no title, or an "Unknown" artist: keep what the bot worked out
      if (adm.title && adm.artist && adm.artist !== "Unknown") {
        s.artist = adm.artist;
        s.title = adm.title;
      }
      if (track) s.track = track;

      var tagFixData = {
        adamData: {
          artist: s.artist,
          track_name: s.title
        },
        cid: s.cid
      };
      // with the history: the track's first play and the play before this one
      // (nothing for its very first play); without: this upload's
      var first = track ? (track.plays > 0 ? track : {}) : adm;
      var lastDate = track ? track.prev_play_date : adm.last_play_date;
      var lastDj = track ? track.prev_play_dj : adm.last_play_dj;
      if (lastDate) {
        tagFixData.adamData.last_play = new Date(lastDate).toISOString();
        if (lastDj) tagFixData.adamData.last_play_dj = lastDj;
      }
      if (first.first_play_date) {
        tagFixData.adamData.first_play = new Date(first.first_play_date).toISOString();
        if (first.first_play_dj) tagFixData.adamData.first_play_dj = first.first_play_dj;
      }
      if (track && track.work_plays > (track.plays || 0)) tagFixData.adamData.all_versions_playcount = track.work_plays;

      // the room's own count when the history is published, else Last.fm's
      var counted = track ? Promise.resolve(track.plays) : deps.lastfm.playcount(adm.artist, adm.title);
      counted.then(function(playcount) {
        if (playcount) {
          tagFixData.adamData.playcount = playcount;
          s.playcount = playcount;
        }
        // the room only hears about the song still playing
        if (s !== deps.song()) return;
        return deps.db().ref("tagUpdate").set(tagFixData);
      }).catch(function(err) {
        log("tag update error:", err && err.message);
      });

      // update the DJ's list with the corrected tags
      if (listRef) listRef.orderByChild('cid').equalTo(s.cid).once("value")
        .then(function(snapshot) {
          var data = snapshot.val();
          var fixedName = s.artist + " - " + s.title;
          for (var key in data) {
            // unchanged names aren't rewritten: the DJ's site would download it again
            if (data[key] && data[key].type == s.type && data[key].name !== fixedName) {
              listRef.child(key + "/name").set(fixedName);
            }
          }
        })
        .catch(function(err) {
          log("playlist tag update error:", err && err.message);
        });
    }
  };

  // A mod's tag fix (tagLog: the site's tag editor, or !fixtags) goes on every
  // copy of those tags and, when an artist was respelled ("POOLSIDE" ->
  // "Poolside"), on all their songs (lib/retag.js). The library is read once
  // and kept a few minutes, so a mod tidying up a run of songs reads it once,
  // then let go. A fix that can't spread (another song or version: most of
  // them) doesn't read it at all.
  var spreadTags = {
    own: {}, // tagLog keys !fixtags wrote: it has linked those itself
    cache: null,
    cacheAt: 0,
    CACHE_MS: 5 * 60 * 1000,
    dropTimer: null,
    /** @type {Promise<any>} */
    queue: Promise.resolve(),
    started: false,
    start: function() {
      if (spreadTags.started) return;
      spreadTags.started = true;
      deps.db().ref("tagLog").orderByChild("at").startAt(deps.serverNow()).on("child_added", function(snap) {
        var e = snap.val();
        var key = snap.key;
        // one at a time, in order: each works on the library as the last left it
        spreadTags.queue = spreadTags.queue.then(function() { return spreadTags.run(key, e); }).catch(function(err) {
          log("tag spread error:", err && err.message);
        });
      }, function(err) {
        log("couldn't follow tagLog (deploy firebase-rules.json):", err && err.message);
      });
    },
    // the library as last read, while it's fresh
    cached: function() {
      return spreadTags.cache && Date.now() - spreadTags.cacheAt < spreadTags.CACHE_MS ? spreadTags.cache : null;
    },
    library: function() {
      if (spreadTags.cached()) return Promise.resolve(spreadTags.cache);
      var db = deps.db();
      var read = function(path) { return db.ref(path).once("value").then(function(snap) { return snap.val() || {}; }); };
      return Promise.all([read("globalTracks"), read("globalSongs"), read("globalWorks")]).then(function(v) {
        spreadTags.cache = { tracks: v[0], songs: v[1], works: v[2] };
        spreadTags.cacheAt = Date.now();
        // let go of it once it's stale, so the whole library isn't held for good
        clearTimeout(spreadTags.dropTimer);
        spreadTags.dropTimer = setTimeout(function() {
          spreadTags.cache = null;
          spreadTags.dropTimer = null;
        }, spreadTags.CACHE_MS);
        if (spreadTags.dropTimer.unref) spreadTags.dropTimer.unref();
        return spreadTags.cache;
      });
    },
    run: function(key, e) {
      if (!e || typeof e.k !== "string") return;
      var db = deps.db();
      var mine = spreadTags.own[key];
      delete spreadTags.own[key];
      var fromSite = !mine && e.by && e.by !== deps.botid();
      if (!retag.spreads(e, { isPlaceholder: placeholderTags.is })) {
        // nothing else to fix: just this upload's track and Discover's rows
        var lib = spreadTags.cached();
        var up = lib ? lib.tracks[e.k] || (lib.tracks[e.k] = {}) : null;
        if (up) {
          up.artist = e.a;
          up.title = e.t;
        }
        // its track, from the library if it's held, else just that one field
        var songOf = !fromSite ? Promise.resolve(null) : up ? Promise.resolve(up.song) :
          db.ref("globalTracks/" + e.k + "/song").once("value").then(function(snap) { return snap.val(); });
        return songOf.then(function(songId) {
          var linked = songId ? Promise.resolve(gts.learnSpelling(songId, e.a, e.t, e.k)) : Promise.resolve();
          var changes = {};
          changes[e.k] = { artist: e.a, title: e.t };
          deps.discoverDo("retag", function(d) { return d.retag(changes); });
          return linked;
        });
      }
      return Promise.all([spreadTags.library(), db.ref("songHistory").once("value")]).then(function(v) {
        var lib = v[0];
        var up = lib.tracks[e.k] || (lib.tracks[e.k] = {});
        // the fixed upload as it is now (the cache may be from before the fix)
        up.artist = e.a;
        up.title = e.t;
        var result = retag.plan(e, { tracks: lib.tracks, songs: lib.songs, works: lib.works, history: v[1].val() || {} }, { isPlaceholder: placeholderTags.is });
        // the site's fix renames the upload's track in the play history, as !fixtags does
        var linked = fromSite && up.song ? Promise.resolve(gts.learnSpelling(up.song, e.a, e.t, e.k)) : Promise.resolve();
        // Discover's published rows (charts, new releases, theme nights) follow
        var changes = {};
        changes[e.k] = { artist: e.a, title: e.t };
        if (result) Object.assign(changes, result.renamed);
        deps.discoverDo("retag", function(d) { return d.retag(changes); });
        if (!result) return linked;
        var paths = Object.keys(result.updates);
        var batches = [];
        for (var i = 0; i < paths.length; i += 500) {
          var part = {};
          paths.slice(i, i + 500).forEach(function(p) { part[p] = result.updates[p]; });
          batches.push(part);
        }
        return linked.then(function() {
          return batches.reduce(function(chain, part) {
            return chain.then(function() { return db.ref().update(part); });
          }, Promise.resolve());
        }).then(function() {
          // keep the cached library as it now is
          paths.forEach(function(p) {
            var bits = p.split("/");
            var node = { globalTracks: lib.tracks, globalSongs: lib.songs, globalWorks: lib.works }[bits[0]];
            if (node && node[bits[1]]) node[bits[1]][bits[2]] = result.updates[p];
          });
          log("tags: " + e.fa + " - " + e.ft + " -> " + e.a + " - " + e.t + ": " + paths.length + " writes (" + result.copies.length + " copies, " + result.artistCount + " by the artist)");
          // the song on the decks was one of them: the room sees its new tags
          var playing = deps.song() && deps.song().cid ? deps.song().type + "" + deps.song().cid : null;
          if (playing && playing !== e.k && result.renamed[playing]) {
            var r = result.renamed[playing];
            gts.reportNp(deps.song(), deps.currentListRef(), Object.assign({}, lib.tracks[playing], r), gts.lastTrack(deps.song()));
          }
          var txt = retag.summary(result, e);
          if (txt && fromSite) deps.notify(e.by, txt, { kind: "track" });
          else if (txt) deps.talk(txt);
        });
      });
    }
  };

  // Whether the play history has been published (globalSongsMeta/ready): from
  // the start, so the first song is linked to its track too
  deps.db().ref("globalSongsMeta/ready").on("value", function(snap) {
    songIndex.ready = snap.val() === true;
  }, function(err) {
    log("couldn't read globalSongsMeta (deploy firebase-rules.json):", err && err.message);
  });

  /** Follow the tag log (mods' fixes), once the room is listening. */
  function start() {
    spreadTags.start();
  }

  return { gts: gts, spreadTags: spreadTags, start: start };
}

module.exports = { createGts: createGts };
