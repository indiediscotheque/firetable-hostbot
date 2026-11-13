// Swap suggestions for tracks that can't play: for each flagged track in
// anyone's playlists, find the same recording, check it can play here, and
// save it with the track as `swap`. The site shows a swap button on the track
// (and "Swap all" for the list); nothing changes in a playlist until its
// owner says so.
//
// What counts as the same recording depends on what the list is kept to
// (playlistPrefs/<uid>/format): YouTube Music and unset lists get YouTube
// Music audio tracks only ("Art Tracks"), never music videos or "Official
// Audio" uploads; lists kept to YouTube videos get videos only, never audio
// tracks; SoundCloud lists get nothing.
//
// Where matches come from, free first (each song stops at the first that
// has one):
//   1. room:    other uploads of the same song the room has played
//               (globalTracks, linked by the play history)
//   2. library: the official Indie Discotheque year playlists on YouTube
//               Music (about 27,000 tracks, read with no quota)
//   3. ytm:     YouTube Music search (no quota; lib/ytmusic.js)
//   4. lists:   people's playlists of the song on YouTube (no quota): a
//               playlist search, then the first page of the top three.
//               YouTube's own searches never list YouTube Music's audio
//               tracks, but these playlists often hold them (audio lists)
//   5. web:     YouTube search (no quota): the artist's own videos (video
//               lists), or an audio track if one shows (audio lists)
//   +  twin:    YouTube Music's Song / Video toggle: a music video's own
//               audio track (the track's video if it still plays, the
//               room's other uploads of the song, the artist's official
//               video from YouTube's search). No search
//   +  artist:  the artist's YouTube Music page: its top songs, and the
//      album:   single named after the song or the album Apple's catalog
//               (iTunes Search, free) says it's on: that album's page, or
//               its YouTube Music playlist ("OLAK5uy_…") from a playlist
//               search. For songs every search above missed (capped)
//   6. api:     the YouTube Data API's search (100 units each), nightly
//               only, for songs whose free search (4 for audio lists, 5 for
//               video lists) didn't answer at all: it finds what the free
//               one does, so it's a stand-in for when YouTube stops
//               answering it. The songs in the most lists first, within
//               SWAP_API_UNITS a day (1,000 by default: 10 searches)
// The checks that a match can play here (and is the right kind: an audio
// track or a video) are one YouTube Data API call (1 unit) per 50 matches,
// with the same rules the bot uses before every song (lib/checks.js).
"use strict";

var tags = require("./tags");

// Flag codes worth a swap: gone / private / blocked / not embeddable / age
// restricted (1–7), broken (8) and low audio quality (9). Off-theme (10) isn't.
var SWAP_CODES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
var DAY = 24 * 60 * 60 * 1000;
var CACHE_DAYS = 30; // re-search a song after this long (found or not)
var RECHECK_DAYS = 7; // re-check a saved suggestion still plays after this long
var DISMISS_DAYS = 90; // "not this one" holds this long

// Saved search answers carry `v: CACHE_VERSION`. A "no match" without it
// was saved before catalogGate, when a search the song catalog didn't answer
// at all was still saved as "no match" for 30 days (so thousands of broken
// tracks were never looked at again): those are searched again.
//   v3: the free sources (room, library, YouTube search) joined the search;
//   "no match" answers saved by YouTube Music search alone are searched again.
//   v4: the Song / Video toggle, artist and album pages and Apple's catalog
//   joined; "no match" answers saved before them are searched again.
var CACHE_VERSION = 4;
var API_DAYS = 30; // a song the paid search missed isn't paid for again for this long
var API_SEARCH_UNITS = 100;
var ATV = "MUSIC_VIDEO_TYPE_ATV";
var YT_ID = /^[A-Za-z0-9_-]{11}$/;
// what a suggestion saved with a track carries (the database rules allow these)
var SAVED_FIELDS = ["cid", "artist", "title", "album", "dur", "explicit"];

// A song YouTube Music has for sure. When searches come back with no songs at
// all, this one is searched once: no songs for it either means the catalog
// isn't answering this server, not that the songs aren't there.
var CANARY = process.env.YTMUSIC_CANARY || "Daft Punk One More Time";

// Playlist formats (playlistPrefs/<uid>/format/<listID>, set on the site):
// "ytm" YouTube Music, "video" YouTube videos, "sc" SoundCloud. Unset counts
// as YouTube Music. Videos are only ever suggested in lists kept to videos
// (and audio tracks never are); SoundCloud lists get no swaps (and aren't
// searched for).
var FORMATS = ["ytm", "video", "sc"];
var NO_SWAP_FORMATS = ["sc"];

/** A playlist's format: "ytm", "video" or "sc"; anything else is "ytm". */
function formatOf(formats, listId) {
  var f = formats && formats[String(listId)];
  return FORMATS.indexOf(f) === -1 ? "ytm" : f;
}

/** Do swap suggestions belong in a list with this format? */
function swapsFor(format) {
  return NO_SWAP_FORMATS.indexOf(format) === -1;
}

/** Does a list with this format take audio tracks (true) or videos (false)? */
function wantsAudio(format) {
  return format !== "video";
}

/**
 * A YouTube Music audio track ("Art Track")? Uploaded by an "Artist - Topic"
 * channel (many now sit in the artist's own channel instead), or described
 * the way YouTube describes them: "Provided to YouTube by …" and
 * "Auto-generated by YouTube."
 * @param {{channel?: string, description?: string}} v
 */
function isArtTrack(v) {
  if (!v) return false;
  var d = String(v.description || "");
  return / - Topic$/.test(String(v.channel || "")) || /^\s*Provided to YouTube by /.test(d) || /Auto-generated by YouTube\.?\s*$/.test(d);
}

/** "DaftPunkVEVO" -> "DaftPunk", "Band - Topic" -> "Band", "Band Official" -> "Band". */
function channelArtist(channel) {
  return String(channel || "").replace(/\s+-\s+Topic$/, "").replace(/\s*VEVO$/i, "")
    .replace(/\s+(?:official|music|records|tv)$/i, "").trim();
}

/**
 * A video as a song: "Artist - Title (Official Video)" from its title, or
 * the channel's artist and the title.
 * @param {{title: string, channel?: string}} v
 * @returns {{artist: string, title: string}}
 */
function videoSong(v) {
  var title = String(v.title || "");
  var sep = title.indexOf(" - ");
  if (sep > 0) return { artist: title.slice(0, sep), title: title.slice(sep + 3) };
  return { artist: channelArtist(v.channel), title: title };
}

/** Is this video from the artist (their channel or their VEVO), not a fan upload? */
function officialFor(name, channel) {
  var c = String(channel || "");
  if (/VEVO$/i.test(c)) return true;
  var ck = tags.artistKeyOf(channelArtist(c));
  if (!ck) return false;
  var p = tags.parse(name);
  return p.artists.concat(p.featured).some(function(a) { return tags.artistKeyOf(a) === ck; });
}

var OMV = "MUSIC_VIDEO_TYPE_OMV";
// Not the music video, though the artist put it up
var NOT_THE_VIDEO = /\b(?:lyrics?|lyric video|visuali[sz]er|official audio|audio only|audio\)|full album|album stream|reaction|karaoke|cover|teaser|trailer|snippet|behind the scenes|making of|interview)\b/i;
var THE_VIDEO = /\b(?:official (?:music )?video|music video|official mv|official hd video|official 4k video)\b/i;

/**
 * How good a video is for a list kept to videos: 3 the artist's official
 * music video, 2 another video from the artist (their channel, their VEVO,
 * or the music video YouTube Music pairs with the song), 1 the artist's but
 * not the video (lyric video, visualizer, "Official Audio"), 0 not the
 * artist's (fan uploads), -1 an audio track. Lists kept to videos take 2
 * and up, best first.
 * @param {string} name - the song, "Artist - Title"
 * @param {{channel?: string, title?: string, official?: boolean, audio?: boolean, description?: string}} v
 */
function videoRank(name, v) {
  if (!v || v.audio === true || isArtTrack(v)) return -1;
  if (!(v.official || /VEVO$/i.test(String(v.channel || "")) || officialFor(name, v.channel))) return 0;
  var t = String(v.title || "");
  if (NOT_THE_VIDEO.test(t)) return 1;
  return THE_VIDEO.test(t) ? 3 : 2;
}

/**
 * Is a saved search answer (swapCache) still good to use?
 * @param {Object} c - {date, picks}
 * @param {number} t - now (ms)
 */
function usableCache(c, t) {
  if (!c || !(t - (Number(c.date) || 0) < CACHE_DAYS * DAY)) return false;
  var none = !Array.isArray(c.picks) || !c.picks.length;
  return !(none && c.v !== CACHE_VERSION);
}

/**
 * Tells "no such song" from "the song catalog isn't answering": some servers
 * get "No results" from YouTube Music's Songs search for everything. A search
 * with songs proves the catalog answers. Before that's proven, an answer with
 * no songs isn't trusted (nothing is saved for it); after a few, the canary
 * song is searched once: no songs for it either means the catalog is down for
 * this server, and `down` says so (the caller stops searching).
 * @param {function(string): Promise<{songs: Array, catalog?: number}>} search
 * @param {string} [canary]
 * @returns {{check: function(Object): Promise<boolean>, down: string, up: boolean}}
 *   check(res) resolves true when an answer can be trusted (and saved)
 */
function catalogGate(search, canary) {
  var g = { up: false, down: "", dry: 0, tried: false };
  g.check = function(res) {
    if (res && res.songs && res.songs.length) { g.up = true; return Promise.resolve(true); }
    // an answer without `catalog` comes from a search that can't tell (trust it)
    if (g.up || !res || res.catalog === undefined) return Promise.resolve(true);
    if (g.down || g.tried) return Promise.resolve(false);
    g.dry++;
    if (g.dry < 3) return Promise.resolve(false);
    g.tried = true;
    var q = canary || CANARY;
    return search(q).then(function(c) {
      if (c && c.songs && c.songs.length) { g.up = true; return true; }
      g.down = "YouTube Music's song catalog isn't answering this server (no songs even for \"" + q + "\"); what it couldn't answer isn't saved as \"no match\"";
      return false;
    }, function(err) {
      g.down = "YouTube Music isn't answering (" + (err && err.message) + ")";
      return false;
    });
  };
  return g;
}

// ------------------------------------------------------------- matching

/** The search for a track name: "Artist Title feat. X (Y Remix)". */
function queryFor(name) {
  var p = tags.parse(name);
  if (p.weak || !p.title || !p.artists.length) return null;
  return tags.format(p).replace(" - ", " ");
}

/** The cache id for a track name: one per recording, all spellings together. */
function cacheId(name) {
  return tags.hash(tags.trackKey(name));
}

function keySet(list) {
  return list.map(tags.artistKeyOf).filter(Boolean);
}

/**
 * The YouTube Music songs that are the same recording as `name`, best first.
 * Same title, same version (a remix never stands in for the original, live
 * never for studio) and the same artists (featured artists may sit in either
 * field). Length within 15% (or 20 seconds) when both are known, or `slack`
 * seconds.
 * @param {string} name - "Artist - Title"
 * @param {Array} songs - from ytmusic.searchSongs
 * @param {{dur?: number, slack?: number}} [opts] - the original's length in seconds
 * @returns {Array} matching songs, best first
 */
function rankMatches(name, songs, opts) {
  opts = opts || {};
  var p = tags.parse(name);
  if (p.weak || !p.title) return [];
  var k = tags.keysOf(p);
  var titleKeys = [k.title].concat(p.altTitles.map(tags.titleKeyOf));
  var origMain = keySet(p.artists);
  var origAll = origMain.concat(keySet(p.featured));
  var wantClean = /\bclean\b/i.test(name);
  var out = [];
  songs.forEach(function(s, rank) {
    var sp = tags.parse(s.artist || "", s.title || "");
    var sk = tags.keysOf(sp);
    if (titleKeys.indexOf(sk.title) === -1 || sk.version !== k.version) return;
    var candMain = keySet(sp.artists);
    var candAll = candMain.concat(keySet(sp.featured));
    if (!origMain.length || !candMain.length) return;
    var origInCand = origMain.every(function(a) { return candAll.indexOf(a) !== -1; });
    var candInOrig = candMain.every(function(a) { return origAll.indexOf(a) !== -1; });
    if (!origInCand && !candInOrig) return;
    var score = 10 - rank * 0.25;
    if (sk.artist === k.artist) score += 3;
    else if (origInCand && candInOrig) score += 2;
    if (opts.dur && s.dur) {
      var diff = Math.abs(opts.dur - s.dur);
      if (diff > (opts.slack != null ? opts.slack : Math.max(20, opts.dur * 0.15))) return;
      score += diff <= 3 ? 2 : diff <= 10 ? 1 : 0;
    }
    // the album version, unless the tag asks for the clean one
    if (s.explicit !== wantClean) score += wantClean ? 3 : 0.5;
    out.push({ song: s, score: score });
  });
  out.sort(function(a, b) { return b.score - a.score; });
  return out.map(function(x) { return x.song; });
}

/** A song as saved with a track (`swap`) or in the cache: only what the site shows. */
function pickOf(s) {
  var out = { cid: String(s.cid), artist: String(s.artist || "").slice(0, 500), title: String(s.title || "").slice(0, 500) };
  if (s.album) out.album = String(s.album).slice(0, 500);
  if (s.dur) out.dur = Number(s.dur) || 0;
  if (s.explicit) out.explicit = true;
  // a video's channel and own title, and whether YouTube Music calls it the
  // song's official video: what lists kept to videos rank by (videoRank)
  if (s.channel) out.channel = String(s.channel).slice(0, 200);
  if (s.vtitle) out.vtitle = String(s.vtitle).slice(0, 500);
  if (s.official || s.kind === OMV) out.official = true;
  // what kind of upload it is, when the source says: an audio track or a video
  if (typeof s.audio === "boolean") out.audio = s.audio;
  else if (s.kind === ATV) out.audio = true;
  else if (s.kind === "MUSIC_VIDEO_TYPE_OMV" || s.kind === "MUSIC_VIDEO_TYPE_UGC") out.audio = false;
  return out;
}

/** The original's length in seconds, if the track has one saved. */
function trackSeconds(t) {
  var v = Number(t && (t.duration || t.length || t.dur || t.seconds)) || 0;
  if (!v && t && (t.msecs || t.ms)) v = Number(t.msecs || t.ms) / 1000;
  if (v > 36000) v = v / 1000; // saved in ms
  return Math.round(v);
}

// ---------------------------------------------------------------- runner
//
// What a night costs, and how it's kept down:
//   - people: only those seen since their last scan (swapScans/<uid>), plus
//     anyone never scanned. Lists of people who haven't been around don't
//     change (new flags come from playing a track or opening a list).
//   - database reads: only the flagged tracks of each list (an indexed query
//     on flagged/date), never whole playlists. Without the index (rules not
//     published) the run stops instead of downloading every list.
//   - looking songs up: one lookup per song (and kind), shared by every copy
//     and spelling, remembered for 30 days (swapCache). The room's history
//     and the year playlists first (no search); YouTube Music and YouTube
//     searches only for what they miss, paced, each capped per night.
//   - YouTube Data API checks: matches confirmed within 7 days aren't
//     re-checked; the best match is checked first and the next one only if
//     it fails; 50 per call (1 unit). Typically a few units a night.
//   - YouTube Data API search (100 units): nightly only, only songs no free
//     source has, the most-listed first, at most SWAP_API_UNITS a day; a song
//     it misses isn't paid for again for 30 days.

/**
 * @param {Object} deps
 *   db: firebase.database()
 *   shallowKeys(path) -> Promise<string[]>
 *   flagged(ref) -> Promise<[{key, track}]>       (optional; rejects with err.noIndex when the index is missing)
 *   search(query) -> Promise<{songs, any, catalog}>   (ytmusic.searchSongs)
 *   verify(cids) -> Promise<{cid: {problem, audio, dur} | problemCode}>
 *                                                 (videos.list, ≤50 ids; rejects when YouTube can't answer;
 *                                                  audio: an Art Track, see isArtTrack)
 *   siblings(uploads) -> Promise<[{cid, artist, title, dur?}]>   (optional: other uploads of
 *                                                 the same song the room has played; uploads: [{type, cid}])
 *   library() -> Promise<[{cid, artist, title, dur, kind}]>   (optional: the year playlists)
 *   webSearch(query) -> Promise<[{cid, title, channel, dur, description?}]>   (optional: YouTube search, no quota)
 *   playlistSearch(query) -> Promise<[{id, title}]>   (optional: YouTube's playlist search, no quota)
 *   playlist(id) -> Promise<{tracks: [{cid, artist, title, dur, kind}]}>   (with playlistSearch: a playlist's first page)
 *   counterpart(cid) -> Promise<{cid, artist, title, dur, kind}|null>   (optional: a video's audio track, ytmusic.counterpart)
 *   artists(name) -> Promise<[{id, name}]>   (optional: ytmusic.searchArtists)
 *   artistPage(id) -> Promise<{name, songs, releases: [{id, title, kind}]}>   (optional: ytmusic.artistPage)
 *   album(id) -> Promise<{title, artist, playlistId, tracks}>   (optional: ytmusic.albumTracks)
 *   apple(query) -> Promise<[{artist, title, album, dur}]>   (optional: Apple's catalog, apple.searchSongs)
 *   maxDeep: songs per run that get the artist / album / Apple lookup (default 300)
 *   apiSearch(query) -> Promise<[{cid, title, channel, description}]>   (optional: search.list for videos, 100 units)
 *   apiPlaylistSearch(query) -> Promise<[{id, title}]>   (optional: search.list for playlists, 100 units)
 *   apiUnits: the most units apiSearch may use a day (runs with opts.paid only)
 *   notify(uid, txt, opts)
 *   users() -> the room's users map; botid() -> the bot's uid
 *   log(...), now() -> ms
 *   maxSearches, delayMs: per run
 *   canary: the song searched to tell a quiet catalog from a missing song (optional)
 */
function createSwapper(deps) {
  var log = deps.log || function() {};
  var now = deps.now || Date.now;
  var wait = deps.wait || function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var memCache = {};
  var memScans = {};
  var writable = { swapCache: true, swapScans: true };
  var state = { running: false, last: null, startedAt: 0 };
  var apiSpent = { day: "", units: 0 }; // the paid search's units today

  var refused = function(path, err) {
    if (/permission/i.test((err && (err.code || err.message)) || "") && writable[path]) {
      writable[path] = false;
      log("swaps: the database rules don't have " + path + " yet (publish firebase-rules.json); keeping it in memory until restart.");
    }
  };
  var readCache = function(id) {
    if (memCache[id]) return Promise.resolve(memCache[id]);
    return deps.db.ref("swapCache/" + id).once("value").then(function(s) { return s.val(); }, function() { return null; });
  };
  var writeCache = function(id, val) {
    memCache[id] = val;
    if (!writable.swapCache) return Promise.resolve();
    return deps.db.ref("swapCache/" + id).set(val).catch(function(err) { refused("swapCache", err); });
  };
  // Each person's playlist formats ({listID: "ytm"|"video"|"sc"}). Unreadable
  // (rules not published yet) counts as none set: everything is YouTube Music.
  var formatsWarned = false;
  var readFormats = function(uid) {
    return deps.db.ref("playlistPrefs/" + uid + "/format").once("value").then(function(s) {
      var v = s.val();
      return v && typeof v === "object" ? v : {};
    }, function(err) {
      if (!formatsWarned) {
        formatsWarned = true;
        log("swaps: can't read playlist formats (" + (err && err.message) + "); publish firebase-rules.json. Treating every playlist as YouTube Music.");
      }
      return {};
    });
  };
  var readScans = function() {
    return deps.db.ref("swapScans").once("value").then(function(s) {
      return Object.assign({}, s.val() || {}, memScans);
    }, function() { return Object.assign({}, memScans); });
  };
  var writeScans = function(updates) {
    Object.assign(memScans, updates);
    if (!writable.swapScans || !Object.keys(updates).length) return Promise.resolve();
    return deps.db.ref("swapScans").update(updates).catch(function(err) { refused("swapScans", err); });
  };

  // When someone was last around: now if they're in the room, else when
  // they last went idle or came back.
  var lastSeen = function(u, t) {
    if (!u) return 0;
    if (u.status) return t;
    return Number(u.idle && u.idle.since) || 0;
  };

  // Every list to look through: [{uid, ref}], for the people who need it,
  // most recently seen first (they get the searches first when a run hits its
  // limit). The rules let the bot read each person's lists, not all of
  // queues/ or playlists/ at once.
  var listsToScan = function(t, full, stats) {
    var db = deps.db;
    var users = (deps.users && deps.users()) || {};
    return readScans().then(function(scans) {
      var uids = Object.keys(users).filter(function(uid) {
        // seen since (an hour before) the last scan, or never scanned
        return full || !scans[uid] || lastSeen(users[uid], t) > Number(scans[uid]) - 60 * 60 * 1000;
      }).sort(function(a, b) { return lastSeen(users[b], t) - lastSeen(users[a], t); });
      stats.skippedPeople = Object.keys(users).length - uids.length;
      var lists = [];
      // a playlist kept to SoundCloud gets no swaps: not read, not searched for
      var add = function(uid, formats, listId, ref) {
        var format = formatOf(formats, listId);
        if (!swapsFor(format)) { stats.skippedLists++; return; }
        lists.push({ uid: uid, ref: ref, listId: listId, format: format });
      };
      return uids.reduce(function(p, uid) {
        return p.then(function() { return readFormats(uid); }).then(function(formats) {
          add(uid, formats, "0", db.ref("queues/" + uid));
          return deps.shallowKeys("playlists/" + uid).then(function(ids) {
            ids.forEach(function(id) { add(uid, formats, id, db.ref("playlists/" + uid + "/" + id + "/list")); });
          }, function() {});
        });
      }, Promise.resolve()).then(function() { return { lists: lists, uids: uids }; });
    });
  };

  // The flagged tracks of one list: [{key, track}]
  var flaggedIn = function(ref, keys) {
    if (keys) {
      return Promise.all(keys.map(function(k) {
        return ref.child(k).once("value").then(function(s) { return { key: k, track: s.val() }; });
      }));
    }
    if (deps.flagged) return deps.flagged(ref);
    return ref.orderByChild("flagged/date").startAt(1).once("value").then(function(snap) {
      var out = [];
      snap.forEach(function(c) { out.push({ key: c.key, track: c.val() }); });
      return out;
    });
  };

  // Save (or clear) a suggestion on one track, only if it's still the same
  // flagged track (a list can be reordered or edited meanwhile).
  var saveSwap = function(ref, key, cid, swap) {
    var added = false;
    return ref.child(key).transaction(function(cur) {
      added = false;
      if (cur === null) return null; // not loaded yet (Firebase asks again with the real value), or gone
      if (String(cur.cid) !== String(cid) || !cur.flagged) return; // changed meanwhile: leave it
      if (swap === null) {
        if (!cur.swap || cur.swap.dismissed) return;
        delete cur.swap;
        return cur;
      }
      if (cur.swap && cur.swap.cid === swap.cid && !cur.swap.dismissed) {
        cur.swap.date = swap.date; // re-checked
        return cur;
      }
      if (cur.swap && cur.swap.dismissed === swap.cid) return;
      added = true;
      cur.swap = swap;
      return cur;
    }, null, false).then(function(r) { return r.committed && added; }, function(err) {
      log("swaps: couldn't save a suggestion:", err.message);
      return false;
    });
  };

  // ------------------------------------------------------------ sources

  // The year playlists, by title, for looking songs up without a search.
  // Built when first needed and kept for 6 hours (deps.library is cached too).
  var lib = { at: 0, index: null };
  var libraryIndex = function(t) {
    if (!deps.library) return Promise.resolve(null);
    if (lib.index && t - lib.at < 6 * 60 * 60 * 1000) return lib.index;
    lib.at = t;
    lib.index = Promise.resolve().then(function() { return deps.library(); }).then(function(rows) {
      var idx = {};
      var n = 0;
      (rows || []).forEach(function(r) {
        if (!r || !YT_ID.test(String(r.cid)) || !r.title) return;
        var k = tags.keysOf(tags.parse(r.artist || "", r.title)).title;
        if (!k) return;
        (idx[k] = idx[k] || []).push(r);
        n++;
      });
      return n ? idx : null;
    }).catch(function(err) {
      log("swaps: couldn't read the year playlists (" + (err && err.message) + "); looking songs up without them");
      lib.at = 0;
      return null;
    });
    return lib.index;
  };

  // How far a match's length may be from the original's: 15% or 20 seconds
  // for audio tracks; a video's intro and outro allow 30% or 45 seconds.
  var slackFor = function(job) {
    if (job.slack != null) return job.slack;
    return job.audio ? Math.max(20, job.dur * 0.15) : Math.max(45, job.dur * 0.3);
  };
  // `rows` ({cid, artist, title, dur, kind or audio}) that are the same
  // recording as the job's song, of the kind its list takes (a kind not known
  // yet is learned when the match is checked), tagged with where they came from
  var matchesIn = function(job, rows, src) {
    return rankMatches(job.name, rows || [], { dur: job.dur, slack: job.dur ? slackFor(job) : null }).map(function(s) {
      var pk = pickOf(s);
      pk.src = src;
      return pk;
    }).filter(function(pk) {
      if (!YT_ID.test(pk.cid) || job.cids.indexOf(pk.cid) !== -1) return false;
      return pk.audio !== !job.audio; // not known to be the wrong kind
    });
  };
  var addPicks = function(job, picks) {
    job.picks = job.picks || [];
    picks.forEach(function(pk) {
      if (job.picks.length < 6 && !job.picks.some(function(x) { return x.cid === pk.cid; })) job.picks.push(pk);
    });
  };
  // a YouTube video (web or API search) as a row: the song from its title
  var videoRow = function(v) {
    var song = videoSong(v);
    var row = { cid: v.cid, artist: song.artist, title: song.title, dur: v.dur || 0, channel: v.channel, vtitle: v.title };
    if (isArtTrack(v)) row.audio = true;
    return row;
  };
  // what a search found that fits the job: audio tracks need to look like
  // one already (a video costs a check to rule out); videos need to be the
  // artist's own (no fan uploads or lyric videos), never an audio track
  var videoMatches = function(job, videos, src) {
    var rows = (videos || []).filter(function(v) { return v && YT_ID.test(String(v.cid)); }).map(videoRow).filter(function(r) {
      return job.audio ? r.audio === true : videoRank(job.name, r) >= 2;
    });
    return matchesIn(job, rows, src);
  };

  // the matches in the first page of each of these playlists (no quota)
  var readLists = function(job, playlists, src) {
    return (playlists || []).slice(0, 3).reduce(function(p, pl) {
      return p.then(function() {
        return deps.playlist(pl.id).then(function(r) { addPicks(job, matchesIn(job, r && r.tracks, src)); }, function() {});
      });
    }, Promise.resolve());
  };

  /**
   * Look through lists for flagged tracks and suggest swaps.
   * @param {{lists?: Array<{uid, ref, listId?, keys?}>, full?: boolean, quiet?: boolean, paid?: boolean, reason?: string,
   *   items?: Array, maxSearches?: number, progress?: function(number, number)}} [opts]
   *   lists: only these (keys: only these tracks); default: everyone who needs it
   *   full: everyone, whether or not they've been around since their last scan
   *   quiet: no notices to people
   *   paid: the YouTube Data API's search may be used (within the day's units)
   *     for songs every free source missed
   *   items: look these songs up and say what was found, instead of reading
   *     lists and saving suggestions (see lookup below)
   *   maxSearches: this run's cap per search (deps.maxSearches otherwise)
   *   progress(done, total): called as songs are searched for
   */
  var run = function(opts) {
    opts = opts || {};
    var lookupOnly = Array.isArray(opts.items);
    if (!lookupOnly) {
      if (state.running) return Promise.resolve(null);
      state.running = true;
      state.startedAt = now();
    }
    var startedAt = now();
    var t = now();
    var lookupResult = null;
    var stats = { lists: 0, flagged: 0, songs: 0, searched: 0, listSearched: 0, webSearched: 0, apiSearched: 0, apiUnits: 0, cached: 0, found: 0,
      suggested: 0, rechecked: 0, removed: 0, people: 0, units: 0, skippedPeople: 0, skippedLists: 0, waiting: 0, stopped: "",
      ytmOff: "", listsOff: "", webOff: "", deep: 0, twinAsked: 0, appleSearched: 0, artistPages: 0, albumPages: 0,
      from: { room: 0, library: 0, twin: 0, ytm: 0, lists: 0, web: 0, artist: 0, album: 0, api: 0 } };
    // ---- the Song / Video toggle, artist and album pages, Apple's catalog
    var twinsOf = function(job, cids) {
      if (!deps.counterpart || stats.twinOff) return Promise.resolve(false);
      var before = (job.picks || []).length;
      var seen = {};
      var twinCap = opts.maxSearches || deps.maxSearches || 600;
      return each(cids.filter(function(c) { return !seen[c] && (seen[c] = true); }).slice(0, 3), function(cid) {
        if (stats.twinOff || (job.picks || []).length > before) return;
        if (stats.twinAsked >= twinCap) { job.capped = true; return; }
        return (stats.twinAsked++ ? wait(deps.twinDelayMs == null ? 1000 : deps.twinDelayMs) : Promise.resolve()).then(function() {
          return deps.counterpart(cid);
        }).then(function(row) {
          errs.twin = 0;
          job.looked = true;
          if (row) addPicks(job, matchesIn(job, [Object.assign({ kind: row.kind || (job.audio ? ATV : OMV), official: !job.audio }, row)], "twin"));
        }, function(err) {
          if (++errs.twin >= 3 || err.status === 429) stats.twinOff = "YouTube Music's Song / Video toggle isn't answering (" + err.message + ")";
        });
      }).then(function() { return (job.picks || []).length > before; });
    };
    var errs = { twin: 0, artist: 0, apple: 0 };
    var artistMemo = {};
    var albumMemo = {};
    var artistFor = function(name, pace) {
      var key = tags.artistKeyOf(name);
      if (!key || !deps.artists || !deps.artistPage || stats.artistOff) return Promise.resolve(null);
      if (artistMemo[key]) return artistMemo[key];
      artistMemo[key] = pace().then(function() { return deps.artists(name); }).then(function(found) {
        errs.artist = 0;
        var a = (found || []).filter(function(x) { return tags.artistKeyOf(x.name) === key; })[0];
        if (!a) return null;
        stats.artistPages++;
        return deps.artistPage(a.id).then(function(page) {
          if (page && !page.name) page.name = a.name;
          return page;
        });
      }).catch(function(err) {
        if (++errs.artist >= 3 || err.status === 429) stats.artistOff = "YouTube Music's artist pages aren't answering (" + err.message + ")";
        delete artistMemo[key];
        return null;
      });
      return artistMemo[key];
    };
    var albumOf = function(id) {
      if (!deps.album) return Promise.resolve(null);
      if (!albumMemo[id]) {
        stats.albumPages++;
        albumMemo[id] = deps.album(id).catch(function() { delete albumMemo[id]; return null; });
      }
      return albumMemo[id];
    };
    var applePace = { n: 0 };
    var appleAlbums = function(job) {
      if (!deps.apple || stats.appleOff) return Promise.resolve([]);
      return (applePace.n++ ? wait(deps.appleDelayMs == null ? 3200 : deps.appleDelayMs) : Promise.resolve()).then(function() {
        stats.appleSearched++;
        return deps.apple(job.query);
      }).then(function(rows) {
        errs.apple = 0;
        var albums = [];
        rankMatches(job.name, rows || [], { dur: job.dur, slack: job.dur ? slackFor(job) : null }).forEach(function(r) {
          if (r.album && albums.indexOf(r.album) === -1) albums.push(r.album);
        });
        return albums.slice(0, 2);
      }, function(err) {
        if (++errs.apple >= 3 || err.status === 403 || err.status === 429) stats.appleOff = "Apple's catalog isn't answering (" + err.message + ")";
        return [];
      });
    };
    var sameTitle = function(a, b) {
      var ka = tags.keysOf(tags.parse("x", a)).title;
      return !!ka && ka === tags.keysOf(tags.parse("x", b)).title;
    };
    // one song every search missed: each step only when the ones before found nothing
    var deepLook = function(job, pace) {
      var has = function() { return (job.picks || []).length > 0; };
      var p = tags.parse(job.name);
      var artist = p.artists[0] || "";
      var albums = [];
      return twinsOf(job, job.webVideos || []).then(function() {
        if (has()) return;
        return appleAlbums(job).then(function(a) { albums = a; if (a.length) job.looked = true; });
      }).then(function() {
        if (has() || !artist) return;
        return artistFor(artist, pace).then(function(page) {
          if (!page) return;
          job.looked = true;
          addPicks(job, matchesIn(job, (page.songs || []).map(function(r) { return Object.assign({ kind: ATV }, r); }), "artist"));
          if (has()) return;
          // the single named after the song, then the albums Apple named
          var picks = (page.releases || []).filter(function(r) {
            return r.kind === "single" && sameTitle(r.title, p.title);
          }).concat((page.releases || []).filter(function(r) {
            return albums.some(function(a) { return sameTitle(r.title, a); });
          })).slice(0, 3);
          return each(picks, function(rel) {
            if (has()) return;
            return albumOf(rel.id).then(function(al) { if (al) addPicks(job, matchesIn(job, al.tracks, "album")); });
          });
        });
      }).then(function() {
        // the albums' YouTube Music playlists ("OLAK5uy_…"), from YouTube's playlist search
        if (has() || !albums.length || !deps.playlistSearch || !deps.playlist || stats.listsOff) return;
        return each(albums, function(album) {
          if (has()) return;
          return pace().then(function() {
            stats.listSearched++;
            return deps.playlistSearch(artist + " " + album);
          }).then(function(pls) {
            var official = (pls || []).filter(function(pl) { return /^OLAK5uy_/.test(pl.id); });
            return readLists(job, official.length ? official.slice(0, 2) : (pls || []).slice(0, 1), "album");
          }, function() {});
        });
      });
    };
    var gate = catalogGate(deps.search, deps.canary);
    var jobs = {}; // cache id -> {id, name, query, dur, audio, cids, uploads, tracks, picks, cache, looked}
    var rechecks = []; // {uid, ref, key, cid, swapCid, audio}
    var perUser = {};
    var incomplete = {}; // uid -> true when something of theirs waits for another night
    var scanned = [];
    var problems = {}; // cid -> {problem, audio, dur}: what YouTube says about it
    var searches = 0; // outside searches this run (paced)
    var pace = function() {
      return (searches++ ? wait(deps.delayMs == null ? 2500 : deps.delayMs) : Promise.resolve());
    };
    var each = function(list, fn) {
      return list.reduce(function(p, x) { return p.then(function() { return fn(x); }); }, Promise.resolve());
    };

    // ---- what YouTube says about matches, 50 a call (1 unit)
    var kindOk = function(job, audio) { return audio === job.audio; };
    var playable = function(job, pk) {
      var info = problems[pk.cid];
      if (!info || info.problem !== 0) return false;
      if (!kindOk(job, info.audio != null ? info.audio : pk.audio)) return false;
      // lists kept to videos: the artist's own video, never a fan upload,
      // lyric video or "Official Audio"
      if (!job.audio && rankOf(job, pk) < 2) return false;
      var d = info.dur || pk.dur;
      return !(job.dur && d && Math.abs(job.dur - d) > slackFor(job));
    };
    var rankOf = function(job, pk) {
      var info = problems[pk.cid] || {};
      return videoRank(job.name, { channel: info.channel || pk.channel, title: info.title || pk.vtitle || pk.title,
        description: info.description, official: pk.official, audio: info.audio != null ? info.audio : pk.audio });
    };
    // the matches that play, best first: for videos, the official music video first
    var bestFirst = function(job, picks) {
      var good = (picks || []).filter(function(pk) { return playable(job, pk); });
      if (job.audio) return good;
      return good.map(function(pk, i) { return { pk: pk, i: i, r: rankOf(job, pk) }; })
        .sort(function(a, b) { return (b.r - a.r) || (a.i - b.i); }).map(function(x) { return x.pk; });
    };
    // a song is settled with a match that plays (for videos: the official music video)
    var settled = function(job) {
      return (job.picks || []).some(function(pk) { return playable(job, pk) && (job.audio || rankOf(job, pk) >= 3); });
    };
    var verify = function(cids) {
      var todo = cids.filter(function(c, i) { return !(c in problems) && cids.indexOf(c) === i; });
      var batches = [];
      for (var i = 0; i < todo.length; i += 50) batches.push(todo.slice(i, i + 50));
      return each(batches, function(batch) {
        if (stats.verifyFailed) return;
        stats.units++;
        return deps.verify(batch).then(function(res) {
          batch.forEach(function(cid) {
            var r = res[cid];
            if (r == null) problems[cid] = { problem: 2 };
            else if (typeof r === "number") problems[cid] = { problem: r };
            else problems[cid] = { problem: Number(r.problem) || 0, audio: typeof r.audio === "boolean" ? r.audio : undefined, dur: Number(r.dur) || 0,
              channel: r.channel ? String(r.channel) : "", title: r.title ? String(r.title) : "" };
          });
        }, function(err) {
          stats.verifyFailed = true;
          log("swaps: couldn't check matches on YouTube (they wait for the next run):", err.message);
        });
      });
    };
    // the best unchecked match of every unsettled song, then the next, until
    // each song has one that plays or runs out (plus `extra` ids in round one)
    var check = function(list, extra) {
      var round = function(n, first) {
        var cids = first ? (extra || []).slice() : [];
        list.forEach(function(job) {
          if (settled(job)) return;
          // audio: the best unchecked match; videos: all of them, to rank them
          var unchecked = (job.picks || []).filter(function(pk) { return !(pk.cid in problems); });
          (job.audio ? unchecked.slice(0, 1) : unchecked).forEach(function(pk) { cids.push(pk.cid); });
        });
        if (!cids.length || n > 6 || stats.verifyFailed) return Promise.resolve();
        return verify(cids).then(function() { return round(n + 1, false); });
      };
      return round(0, true);
    };
    // remember what was learned, so the next nights don't ask again
    var remember = function(list) {
      return Promise.all(list.map(function(job) {
        if (!job.cache) return null;
        var changed = job.dirty;
        job.dirty = false;
        (job.picks || []).forEach(function(pk) {
          var info = problems[pk.cid];
          if (!info) return;
          if (info.audio != null && pk.audio !== info.audio) { pk.audio = info.audio; changed = true; }
          if (info.dur && !pk.dur) { pk.dur = info.dur; changed = true; }
          if (info.channel && pk.channel !== info.channel.slice(0, 200)) { pk.channel = info.channel.slice(0, 200); changed = true; }
          if (info.title && !pk.audio && pk.vtitle !== info.title.slice(0, 500)) { pk.vtitle = info.title.slice(0, 500); changed = true; }
          if (info.problem === 0 && !(pk.ok && t - pk.ok < RECHECK_DAYS * DAY)) { pk.ok = t; delete pk.bad; changed = true; }
          else if (info.problem > 0 && !(pk.bad && t - pk.bad < RECHECK_DAYS * DAY)) { pk.bad = t; delete pk.ok; changed = true; }
        });
        if (!changed) return null;
        job.cache.picks = job.picks || [];
        return writeCache(job.id, job.cache);
      }));
    };

    var gather = lookupOnly || opts.lists ? Promise.resolve({ lists: lookupOnly ? [] : opts.lists, uids: [] }) : listsToScan(t, opts.full, stats);
    return gather.then(function(found) {
      scanned = found.uids;
      stats.lists = found.lists.length;
      // one list at a time: keeps the bot's memory and the database calm
      return each(found.lists, function(l) {
        if (stats.stopped) return;
        var audio = wantsAudio(l.format || "ytm");
        return flaggedIn(l.ref, l.keys).then(function(items) {
          items.forEach(function(it) {
            var tr = it.track;
            if (!tr || !tr.flagged || SWAP_CODES.indexOf(Number(tr.flagged.code)) === -1 || !tr.cid || !tr.name) return;
            stats.flagged++;
            var sw = tr.swap;
            if (sw && sw.dismissed && t - (Number(sw.date) || 0) < DISMISS_DAYS * DAY) return;
            if (sw && sw.cid && !sw.dismissed) {
              if (t - (Number(sw.date) || 0) > RECHECK_DAYS * DAY) rechecks.push({ uid: l.uid, ref: l.ref, key: it.key, cid: tr.cid, swapCid: sw.cid, audio: audio });
              return;
            }
            var query = queryFor(tr.name);
            if (!query) return;
            // audio tracks and videos are different answers: saved apart
            var id = (audio ? "" : "w") + cacheId(tr.name);
            var job = jobs[id] || (jobs[id] = { id: id, name: tr.name, query: query, dur: 0, audio: audio, cids: [], uploads: [], tracks: [] });
            if (!job.dur) job.dur = trackSeconds(tr);
            if (tr.type == 1 && job.cids.indexOf(String(tr.cid)) === -1) job.cids.push(String(tr.cid));
            if (job.uploads.length < 3) job.uploads.push({ type: tr.type, cid: String(tr.cid) });
            job.tracks.push({ uid: l.uid, ref: l.ref, key: it.key, cid: tr.cid, type: tr.type, dismissed: sw && sw.dismissed });
          });
        }, function(err) {
          if (err && err.noIndex) {
            stats.stopped = "the database has no index on flagged/date yet (publish firebase-rules.json); not reading whole playlists without it";
            return;
          }
          incomplete[l.uid] = true;
          log("swaps: couldn't read a list:", err && err.message);
        });
      });
    }).then(function() {
      // songs to look up for someone else (the YOUTUBE MUSIC sync): one job
      // per recording and kind; a job with its own length slack apart
      (opts.items || []).forEach(function(it, i) {
        var query = it && it.name ? queryFor(it.name) : null;
        if (!query) return;
        var audio = it.audio !== false;
        var id = (audio ? "" : "w") + cacheId(it.name);
        var key = id + (it.slack != null ? "~" + Math.round(it.slack) : "");
        var job = jobs[key] || (jobs[key] = { id: id, name: it.name, query: query, dur: 0, audio: audio, cids: [], uploads: [], tracks: [], items: [] });
        if (it.slack != null) job.slack = Number(it.slack);
        if (!job.dur) job.dur = Number(it.dur) || 0;
        (it.uploads || []).forEach(function(u) {
          if (!u || !u.cid) return;
          if (u.type == 1 && job.cids.indexOf(String(u.cid)) === -1) job.cids.push(String(u.cid));
          if (job.uploads.length < 3) job.uploads.push({ type: u.type, cid: String(u.cid) });
          // a video that still plays: its audio track is a toggle away
          if (u.live && u.type == 1 && YT_ID.test(String(u.cid))) (job.live = job.live || []).push(String(u.cid));
        });
        job.items.push(i);
      });
      var list = Object.keys(jobs).map(function(id) { return jobs[id]; });
      stats.songs = list.length;
      var fresh = [];
      // ---- 0. remembered answers (30 days)
      return each(list, function(job) {
        return readCache(job.id).then(function(c) {
          if (!usableCache(c, t)) { fresh.push(job); return; }
          stats.cached++;
          job.looked = true;
          job.cache = c;
          job.picks = Array.isArray(c.picks) ? c.picks : [];
          job.picks.forEach(function(pk) {
            // before v3 every saved match was a YouTube Music audio track
            if (pk.audio == null && !(c.v >= 3) && job.audio) pk.audio = true;
            if (pk.ok && t - pk.ok < RECHECK_DAYS * DAY) problems[pk.cid] = { problem: 0, audio: pk.audio };
            else if (pk.bad && t - pk.bad < RECHECK_DAYS * DAY) problems[pk.cid] = { problem: 2 };
          });
        });
      }).then(function() {
        // ---- 1. free, no search: other uploads the room has played, then
        // the year playlists
        return libraryIndex(t).then(function(idx) {
          return each(fresh, function(job) {
            var room = deps.siblings ? deps.siblings(job.uploads).catch(function() { return []; }) : Promise.resolve([]);
            return room.then(function(rows) {
              addPicks(job, matchesIn(job, rows, "room"));
              // the other side of the Song / Video toggle: the room's videos of
              // the song for audio lists, its audio tracks for video lists
              var otherSide = function(r) {
                var isAudio = r.audio === true || r.kind === ATV;
                return r && YT_ID.test(String(r.cid)) && (job.audio ? !isAudio : isAudio) &&
                  rankMatches(job.name, [r], { dur: job.dur, slack: job.dur ? Math.max(45, job.dur * 0.3) : null }).length > 0;
              };
              job.twins = (job.live || []).concat((rows || []).filter(otherSide).map(function(r) { return String(r.cid); }));
              if (!idx) return;
              var p = tags.parse(job.name);
              var keys = [tags.keysOf(p).title].concat(p.altTitles.map(tags.titleKeyOf));
              var rowsL = [];
              keys.forEach(function(k) { if (idx[k]) rowsL = rowsL.concat(idx[k]); });
              addPicks(job, matchesIn(job, rowsL, "library"));
              // the year playlists' audio tracks: their official videos, a toggle away
              if (!job.audio) job.twins = job.twins.concat(rowsL.filter(otherSide).map(function(r) { return String(r.cid); }));
            });
          });
        });
      }).then(function() {
        // ---- 1b. the Song / Video toggle of the song's videos that play
        return each(fresh, function(job) {
          if (!(job.twins || []).length) return;
          // audio lists: when nothing's found yet; video lists: until the
          // official video is (YouTube Music pairs the song with it)
          if (job.audio ? (job.picks || []).length : (job.picks || []).some(function(pk) { return pk.official && videoRank(job.name, pk) >= 2; })) return;
          return twinsOf(job, job.twins);
        });
      }).then(function() {
        // remembered matches and the free ones found so far
        return check(list);
      }).then(function() {
        // ---- 2. free searches for the songs still without one: YouTube
        // Music's audio tracks (for audio lists), then YouTube itself
        var cap = opts.maxSearches || deps.maxSearches || 600;
        var todoN = fresh.length;
        var doneN = 0;
        var ytmMisses = 0, ytmErrors = 0, webErrors = 0, listErrors = 0;
        var ytm = function(job) {
          if (!job.audio || stats.ytmOff || !deps.search) return Promise.resolve(false);
          if (stats.searched >= cap) { job.capped = true; return Promise.resolve(false); }
          return pace().then(function() {
            stats.searched++;
            return deps.search(job.query);
          }).then(function(res) {
            ytmErrors = 0;
            ytmMisses = res.any ? 0 : ytmMisses + 1;
            if (ytmMisses >= 5) stats.ytmOff = "YouTube Music returned nothing for 5 searches in a row";
            if (!res.songs.length && !res.any) return false; // nothing at all: not a "no match"
            // no songs while the catalog hasn't shown it answers: not a real
            // "no match" (see catalogGate)
            return gate.check(res).then(function(trusted) {
              if (gate.down) stats.ytmOff = gate.down;
              if (!trusted) { stats.unsure = (stats.unsure || 0) + 1; return false; }
              addPicks(job, matchesIn(job, res.songs.map(function(s) { return Object.assign({ kind: ATV }, s); }), "ytm"));
              return true;
            });
          }, function(err) {
            ytmErrors++;
            log("swaps: YouTube Music search failed:", err.message);
            if (ytmErrors >= 3 || err.status === 429) stats.ytmOff = "YouTube Music isn't answering (" + err.message + ")";
            return false;
          });
        };
        var lists = function(job) {
          if (!job.audio || stats.listsOff || !deps.playlistSearch || !deps.playlist) return Promise.resolve(false);
          if (stats.listSearched >= cap) { job.capped = true; return Promise.resolve(false); }
          return pace().then(function() {
            stats.listSearched++;
            return deps.playlistSearch(job.query);
          }).then(function(playlists) {
            listErrors = 0;
            if (!playlists || !playlists.length) return false; // nothing at all: not a "no match"
            job.freeAnswered = true;
            return readLists(job, playlists, "lists").then(function() { return true; });
          }, function(err) {
            listErrors++;
            log("swaps: YouTube playlist search failed:", err.message);
            if (listErrors >= 3 || err.status === 429) stats.listsOff = "YouTube's playlist search isn't answering (" + err.message + ")";
            return false;
          });
        };
        var web = function(job) {
          if (stats.webOff || !deps.webSearch) return Promise.resolve(false);
          if (stats.webSearched >= cap) { job.capped = true; return Promise.resolve(false); }
          return pace().then(function() {
            stats.webSearched++;
            return deps.webSearch(job.query);
          }).then(function(videos) {
            webErrors = 0;
            if (!videos || !videos.length) return false; // nothing at all: not a "no match"
            if (!job.audio) job.freeAnswered = true;
            addPicks(job, videoMatches(job, videos, "web"));
            // the artist's own videos: their audio tracks via the toggle, later
            if (job.audio) {
              job.webVideos = videos.filter(function(v) { return v && YT_ID.test(String(v.cid)); }).map(videoRow).filter(function(r) {
                return r.audio !== true && officialFor(job.name, r.channel) && rankMatches(job.name, [r]).length;
              }).slice(0, 2).map(function(r) { return r.cid; });
            }
            return true;
          }, function(err) {
            webErrors++;
            log("swaps: YouTube search failed:", err.message);
            if (webErrors >= 3 || err.status === 429) stats.webOff = "YouTube search isn't answering (" + err.message + ")";
            return false;
          });
        };
        var searched = [];
        return each(fresh, function(job) {
          if (opts.progress && (++doneN % 25 === 0 || doneN === todoN)) opts.progress(doneN, todoN);
          if (settled(job)) { job.looked = true; return; }
          if (stats.stopped) return;
          // each free search only when the ones before found nothing new
          var steps = [ytm, lists, web];
          return steps.reduce(function(p, fn) {
            return p.then(function(stop) {
              if (stop) return true;
              var before = (job.picks || []).length;
              return fn(job).then(function(answered) {
                if (answered) job.looked = true;
                return (job.picks || []).length > before;
              });
            });
          }, Promise.resolve(false)).then(function() { searched.push(job); });
          // what the searches found, and the old suggestions due a re-check, together
        }).then(function() { return check(searched, rechecks.map(function(r) { return r.swapCid; })); }).then(function() {
          // ---- 2b. audio tracks every search missed: the toggle of the
          // artist's videos, the artist's page, and the album Apple's
          // catalog says the song is on
          var misses = searched.filter(function(job) { return job.audio && !settled(job); });
          var deepCap = opts.maxDeep || deps.maxDeep || 300;
          var deep = [];
          return each(misses, function(job) {
            if (stats.stopped) return;
            if (stats.deep >= deepCap) { job.capped = true; return; }
            stats.deep++;
            deep.push(job);
            return deepLook(job, pace);
          }).then(function() { return check(deep); });
        });
      }).then(function() {
        // a song looked up with an answer (a match, or a real "no match") is
        // remembered for 30 days; one no source could answer for waits
        fresh.forEach(function(job) {
          if (!job.looked && !settled(job)) { if (!job.capped) stats.unanswered = (stats.unanswered || 0) + 1; return; }
          job.looked = true;
          job.cache = { q: job.query.slice(0, 500), date: t, picks: job.picks || [], v: CACHE_VERSION };
          if (job.freeAnswered) job.cache.free = t;
          job.dirty = true;
        });
        // ---- 3. paid: the YouTube Data API's search (100 units), for songs
        // still without a match whose free search didn't answer (it would
        // find the same), those in the most lists first
        if (!opts.paid || !(deps.apiSearch || deps.apiPlaylistSearch)) return;
        var day = new Date(t).toDateString();
        if (apiSpent.day !== day) { apiSpent.day = day; apiSpent.units = 0; }
        var budget = Number(deps.apiUnits) || 0;
        var todo = list.filter(function(job) {
          if (settled(job) || job.capped || job.freeAnswered) return false;
          if (!(job.audio ? deps.apiPlaylistSearch : deps.apiSearch)) return false;
          var c = job.cache;
          if (c && c.free && t - c.free < API_DAYS * DAY) return false;
          return !(c && c.api && t - c.api < API_DAYS * DAY);
        }).sort(function(a, b) { return (b.tracks.length + (b.items || []).length) - (a.tracks.length + (a.items || []).length); });
        var paid = [];
        return each(todo, function(job) {
          if (stats.apiOff) return;
          if (apiSpent.units + API_SEARCH_UNITS > budget) { stats.apiWaiting = (stats.apiWaiting || 0) + 1; return; }
          apiSpent.units += API_SEARCH_UNITS;
          stats.apiUnits += API_SEARCH_UNITS;
          stats.apiSearched++;
          return pace().then(function() {
            // audio tracks: people's playlists of the song (read with no
            // quota); videos: the artist's own
            if (job.audio) return deps.apiPlaylistSearch(job.query).then(function(pls) { return readLists(job, pls, "api"); });
            return deps.apiSearch(job.query).then(function(videos) { addPicks(job, videoMatches(job, videos, "api")); });
          }).then(function() {
            job.looked = true;
            job.cache = job.cache || { q: job.query.slice(0, 500), date: t, picks: [], v: CACHE_VERSION };
            job.cache.api = t;
            job.dirty = true;
            paid.push(job);
          }, function(err) {
            stats.apiOff = "the YouTube API's search didn't answer (" + err.message + ")";
            log("swaps: " + stats.apiOff);
          });
        }).then(function() { return check(paid); });
      }).then(function() { return remember(list); });
    }).then(function() {
      if (lookupOnly) {
        // what was found for each song: the matches that play here, best first
        var out = { picks: opts.items.map(function() { return []; }), looked: opts.items.map(function() { return false; }), stats: stats };
        Object.keys(jobs).forEach(function(key) {
          var job = jobs[key];
          var good = bestFirst(job, job.picks);
          if (good[0]) stats.from[good[0].src || "ytm"]++;
          job.items.forEach(function(i) {
            out.looked[i] = !!job.looked || good.length > 0;
            out.picks[i] = good.map(function(pk) {
              var info = problems[pk.cid] || {};
              return Object.assign({}, pk, { audio: info.audio != null ? info.audio : pk.audio, dur: pk.dur || info.dur || 0 });
            });
            if (!out.looked[i]) stats.waiting++;
          });
        });
        stats.found = out.picks.filter(function(p) { return p.length; }).length;
        stats.ms = now() - startedAt;
        lookupResult = out;
        return;
      }
      var writes = [];
      Object.keys(jobs).forEach(function(id) {
        var job = jobs[id];
        var ranked = bestFirst(job, job.picks);
        var pick = ranked[0] || null;
        if (pick) stats.from[pick.src || "ytm"]++;
        job.tracks.forEach(function(tk) {
          if (!job.looked) { incomplete[tk.uid] = true; stats.waiting++; return; } // not looked up yet
          var mine = ranked.filter(function(pk) {
            return !(tk.type == 1 && pk.cid === String(tk.cid)) && pk.cid !== tk.dismissed;
          })[0];
          if (!mine) {
            // a match YouTube couldn't check yet: try again next night
            if ((job.picks || []).some(function(pk) { return !(pk.cid in problems); })) incomplete[tk.uid] = true;
            return;
          }
          stats.found++;
          var saved = { date: t };
          Object.keys(mine).forEach(function(k) { if (SAVED_FIELDS.indexOf(k) !== -1) saved[k] = mine[k]; });
          writes.push(saveSwap(tk.ref, tk.key, tk.cid, saved).then(function(added) {
            if (!added) return;
            stats.suggested++;
            perUser[tk.uid] = perUser[tk.uid] || { audio: 0, video: 0 };
            perUser[tk.uid][job.audio ? "audio" : "video"]++;
          }));
        });
      });
      rechecks.forEach(function(r) {
        var info = problems[r.swapCid];
        if (!info) { incomplete[r.uid] = true; return; } // couldn't check: leave it
        stats.rechecked++;
        // still plays, and (when YouTube says) still the kind the list takes
        var ok = info.problem === 0 && (info.audio == null || info.audio === r.audio);
        writes.push(saveSwap(r.ref, r.key, r.cid, ok ? { cid: r.swapCid, date: t } : null).then(function(changed) {
          if (!ok) stats.removed++;
          return changed;
        }));
      });
      return Promise.all(writes);
    }).then(function() {
      if (lookupOnly) return;
      // everyone whose lists are fully dealt with waits until they're next seen
      var done = {};
      if (!stats.stopped) scanned.forEach(function(uid) { if (!incomplete[uid]) done[uid] = t; });
      return writeScans(done);
    }).then(function() {
      if (lookupOnly) return lookupResult;
      var bot = deps.botid && deps.botid();
      var people = Object.keys(perUser);
      stats.people = people.length;
      if (!opts.quiet) {
        people.forEach(function(uid) {
          if (uid === bot) return;
          var c = perUser[uid];
          var n = c.audio + c.video;
          var where = !c.video ? "on YouTube Music" : !c.audio ? "on YouTube" : "on YouTube or YouTube Music";
          deps.notify(uid, (n === 1 ? "A broken track in your playlists has" : n + " broken tracks in your playlists have") +
            " a working copy " + where + ". Look for ⇄ on " + (n === 1 ? "it" : "them") + " to swap it in, or use Swap all.", { kind: "swap", ttl: 20 * 60 * 60 });
        });
      }
      stats.ms = now() - state.startedAt;
      stats.reason = opts.reason || "";
      stats.at = now();
      if (!opts.lists) state.last = stats;
      log("swaps: " + summary(stats));
      return stats;
    }).then(function(s) {
      if (!lookupOnly) state.running = false;
      return s;
    }, function(err) {
      if (!lookupOnly) state.running = false;
      log("swaps: " + (lookupOnly ? "lookup" : "run") + " failed:", err && err.message);
      return null;
    });
  };

  return {
    run: run,
    /**
     * Look songs up for someone else (the YOUTUBE MUSIC sync) with every
     * source the swap search has, sharing its saved answers and the day's
     * paid search budget. Runs alongside a swap run. Nothing is saved with
     * any track.
     * @param {Array<{name: string, dur?: number, uploads?: Array<{type, cid}>, audio?: boolean, slack?: number}>} items
     *   audio: false for videos (default: YouTube Music audio tracks);
     *   slack: how far (s) a match's length may be from `dur`
     * @param {{paid?: boolean, maxSearches?: number, maxDeep?: number, progress?: function(number, number)}} [opts]
     * @returns {Promise<{picks: Array<Array>, looked: boolean[], stats: Object}|null>}
     *   picks[i]: item i's matches that play here, best first (an item it
     *   couldn't look up yet, for search limits, has looked[i] false)
     */
    lookup: function(items, opts) {
      opts = opts || {};
      return run({ items: items || [], paid: !!opts.paid, maxSearches: opts.maxSearches, maxDeep: opts.maxDeep, progress: opts.progress, quiet: true, reason: "lookup" });
    },
    /**
     * One track the bot just flagged: look it up now (free sources only),
     * unless its playlist is kept to SoundCloud.
     * @param {string} uid
     * @param {Object} ref - the list
     * @param {string} key - the track
     * @param {string} [listId] - "0" for queues/<uid>, else the playlist id
     */
    track: function(uid, ref, key, listId) {
      if (state.running) return Promise.resolve(null);
      return (listId == null ? Promise.resolve({}) : readFormats(uid)).then(function(formats) {
        var format = listId == null ? "ytm" : formatOf(formats, listId);
        if (!swapsFor(format)) return null;
        return run({ lists: [{ uid: uid, ref: ref, keys: [key], listId: listId, format: format }], quiet: true, reason: "flagged" });
      });
    },
    state: state
  };
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many);
}

function summary(s) {
  if (!s) return "no swap search has run yet.";
  var from = s.from || {};
  var names = { room: "room history", library: "year playlists", twin: "Song / Video toggle", ytm: "YouTube Music", lists: "YouTube playlists", web: "YouTube",
    artist: "artist pages", album: "album pages", api: "paid search" };
  var where = Object.keys(names).filter(function(k) { return from[k]; }).map(function(k) { return from[k] + " " + names[k]; });
  var looked = [s.cached + " remembered", s.searched + " YouTube Music " + (s.searched === 1 ? "search" : "searches")];
  if (s.listSearched) looked.push(s.listSearched + " playlist " + (s.listSearched === 1 ? "search" : "searches"));
  if (s.webSearched) looked.push(s.webSearched + " YouTube " + (s.webSearched === 1 ? "search" : "searches"));
  if (s.twinAsked) looked.push(s.twinAsked + " Song / Video " + (s.twinAsked === 1 ? "toggle" : "toggles"));
  if (s.appleSearched) looked.push(s.appleSearched + " Apple " + (s.appleSearched === 1 ? "lookup" : "lookups"));
  if (s.artistPages || s.albumPages) looked.push((s.artistPages || 0) + " artist and " + (s.albumPages || 0) + " album pages");
  if (s.apiSearched) looked.push(s.apiSearched + " paid");
  var out = plural(s.flagged, "flagged track", "flagged tracks") + " in " + plural(s.lists, "list", "lists") +
    ", " + plural(s.songs, "song", "songs") + " (" + looked.join(", ") + ")" +
    ", " + s.suggested + " new " + (s.suggested === 1 ? "swap" : "swaps") + " for " + plural(s.people, "person", "people");
  if (where.length) out += " (matches from " + where.join(", ") + ")";
  if (s.removed) out += ", " + s.removed + " old " + (s.removed === 1 ? "swap" : "swaps") + " no longer play";
  var units = (s.units || 0) + (s.apiUnits || 0);
  out += "; " + plural(units, "YouTube API unit", "YouTube API units") + (s.apiUnits ? " (" + s.apiUnits + " on search)" : "");
  if (s.skippedPeople) out += "; " + plural(s.skippedPeople, "person", "people") + " not seen since their last scan skipped";
  if (s.skippedLists) out += "; " + plural(s.skippedLists, "SoundCloud playlist", "SoundCloud playlists") + " skipped";
  if (s.waiting) out += "; " + plural(s.waiting, "track waits", "tracks wait") + " for the next run (search limits)";
  if (s.apiWaiting) out += "; " + plural(s.apiWaiting, "song waits", "songs wait") + " for tomorrow's paid searches";
  if (s.ytmOff) out += "; YouTube Music: " + s.ytmOff;
  else if (s.unsure) out += "; " + plural(s.unsure, "search", "searches") + " came back without songs before the catalog answered, so " + (s.unsure === 1 ? "it waits" : "they wait") + " for next time";
  if (s.listsOff) out += "; " + s.listsOff;
  if (s.twinOff) out += "; " + s.twinOff;
  if (s.artistOff) out += "; " + s.artistOff;
  if (s.appleOff) out += "; " + s.appleOff;
  if (s.webOff) out += "; " + s.webOff;
  if (s.apiOff) out += "; " + s.apiOff;
  if (s.stopped) out += "; stopped early: " + s.stopped;
  if (s.verifyFailed) out += "; YouTube couldn't check the matches, so they wait for the next run";
  return out + ".";
}

module.exports = {
  createSwapper: createSwapper,
  rankMatches: rankMatches,
  queryFor: queryFor,
  cacheId: cacheId,
  trackSeconds: trackSeconds,
  pickOf: pickOf,
  summary: summary,
  usableCache: usableCache,
  catalogGate: catalogGate,
  formatOf: formatOf,
  swapsFor: swapsFor,
  wantsAudio: wantsAudio,
  isArtTrack: isArtTrack,
  videoSong: videoSong,
  officialFor: officialFor,
  videoRank: videoRank,
  channelArtist: channelArtist,
  CACHE_VERSION: CACHE_VERSION,
  SWAP_CODES: SWAP_CODES
};
