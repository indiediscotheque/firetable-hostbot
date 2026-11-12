// YouTube Music search, with no API key and no YouTube Data API quota: the
// same search music.youtube.com itself uses (its "InnerTube" web API).
// Only songs are kept: YouTube Music's audio tracks ("Art Tracks" from the
// labels' "Artist - Topic" channels, MUSIC_VIDEO_TYPE_ATV). Music videos,
// "Official Audio" uploads (OMV) and fan uploads (UGC) are left out.
//
// It isn't a public API, so YouTube can change it without notice; when it
// stops answering the way this expects, searches find nothing and nothing in
// anyone's playlists changes.
"use strict";

var http = require("./http").http;

var SEARCH_URL = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
var BROWSE_URL = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false";
var CLIENT_VERSION = process.env.YTMUSIC_CLIENT_VERSION || "1.20261027.10.00";
var USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
// The "Songs" filter (what the Songs chip on music.youtube.com sends)
var SONGS_FILTER = "EgWKAQIIAWoKEAQQBRAVEBAQEQ==";
var ATV = "MUSIC_VIDEO_TYPE_ATV";

var visitorData = null; // YouTube's visitor id from the last answer, sent back like the site does

function clientContext() {
  var client = { clientName: "WEB_REMIX", clientVersion: CLIENT_VERSION, hl: "en", gl: "US" };
  if (visitorData) client.visitorData = visitorData;
  return { client: client };
}

// ---------------------------------------------------------------- parsing

function runsOf(text) {
  return (text && Array.isArray(text.runs)) ? text.runs : [];
}

// First value of `key` anywhere inside `obj` (depth first).
function find(obj, key, depth) {
  if (!obj || typeof obj !== "object" || (depth || 0) > 12) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var v = find(obj[keys[i]], key, (depth || 0) + 1);
    if (v !== undefined) return v;
  }
  return undefined;
}

function pageType(run) {
  var be = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
  var cfg = be && be.browseEndpointContextSupportedConfigs && be.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig;
  return (cfg && cfg.pageType) || "";
}

function seconds(text) {
  var m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

var LABELS = /^(?:song|video|single|ep|album|episode|podcast|profile|artist|playlist)$/i;
var COUNTS = /\b(?:plays?|views?|listeners?|monthly audience)\b/i;

// "Artist & Artist • Album • 3:45" (songs filter) or "Song • Artist • Album
// • 3:45" (everything else): the artists, the album and the length.
function readSubtitle(runs) {
  var segs = [[]];
  runs.forEach(function(r) {
    if (/^\s*•\s*$/.test(r.text || "")) segs.push([]);
    else segs[segs.length - 1].push(r);
  });
  var out = { artist: "", album: "", dur: 0 };
  var plain = [];
  segs.forEach(function(seg) {
    var text = seg.map(function(r) { return r.text || ""; }).join("").trim();
    if (!text) return;
    var types = seg.map(pageType);
    if (types.indexOf("MUSIC_PAGE_TYPE_ARTIST") !== -1 || types.indexOf("MUSIC_PAGE_TYPE_USER_CHANNEL") !== -1) {
      if (!out.artist) out.artist = text;
    } else if (types.indexOf("MUSIC_PAGE_TYPE_ALBUM") !== -1) {
      if (!out.album) out.album = text;
    } else if (seconds(text)) {
      out.dur = seconds(text);
    } else if (!LABELS.test(text) && !COUNTS.test(text)) {
      plain.push(text);
    }
  });
  // artists without a link ("Various Artists"), then an album without one
  if (!out.artist && plain.length) out.artist = plain.shift();
  if (!out.album && plain.length) out.album = plain.shift();
  return out;
}

function explicitOf(item) {
  var badges = item.badges || item.subtitleBadges || [];
  return badges.some(function(b) {
    var icon = b && b.musicInlineBadgeRenderer && b.musicInlineBadgeRenderer.icon;
    return icon && icon.iconType === "MUSIC_EXPLICIT_BADGE";
  });
}

// A row in a results list (musicResponsiveListItemRenderer).
function fromListItem(item) {
  var cols = (item.flexColumns || []).map(function(c) {
    return runsOf(c && c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text);
  });
  var titleRuns = cols[0] || [];
  var title = titleRuns.map(function(r) { return r.text || ""; }).join("").trim();
  var videoId = (item.playlistItemData && item.playlistItemData.videoId) ||
    find(titleRuns, "videoId") || find(item.overlay, "videoId");
  var sub = readSubtitle([].concat.apply([], cols.slice(1).map(function(c, i) {
    return i ? [{ text: " • " }].concat(c) : c; // later columns (plays, album) are separate segments
  })));
  var fixed = (item.fixedColumns || []).map(function(c) {
    var t = c && c.musicResponsiveListItemFixedColumnRenderer && c.musicResponsiveListItemFixedColumnRenderer.text;
    return runsOf(t).map(function(r) { return r.text; }).join("");
  });
  if (!sub.dur) fixed.forEach(function(t) { if (seconds(t)) sub.dur = seconds(t); });
  return {
    cid: videoId || "",
    title: title,
    artist: sub.artist,
    album: sub.album,
    dur: sub.dur,
    explicit: explicitOf(item),
    kind: find(item, "musicVideoType") || ""
  };
}

// The "Top result" card.
function fromCard(card) {
  var titleRuns = runsOf(card.title);
  var sub = readSubtitle(runsOf(card.subtitle));
  return {
    cid: find(titleRuns, "videoId") || find(card.onTap, "videoId") || "",
    title: titleRuns.map(function(r) { return r.text || ""; }).join("").trim(),
    artist: sub.artist,
    album: sub.album,
    dur: sub.dur,
    explicit: explicitOf(card),
    kind: find(titleRuns, "musicVideoType") || find(card.onTap, "musicVideoType") || ""
  };
}

/**
 * Every result in a search answer, in YouTube Music's order, with what kind
 * of upload each one is. Use songsOnly() to keep the audio tracks.
 * @returns {Array<{cid, title, artist, album, dur, explicit, kind}>}
 */
function parseSearch(json) {
  var out = [];
  var seen = {};
  (function walk(o, depth) {
    if (!o || typeof o !== "object" || depth > 30) return;
    if (Array.isArray(o)) { o.forEach(function(x) { walk(x, depth + 1); }); return; }
    if (o.musicCardShelfRenderer) {
      var c = fromCard(o.musicCardShelfRenderer);
      if (c.cid && !seen[c.cid]) { seen[c.cid] = 1; out.push(c); }
      walk(o.musicCardShelfRenderer.contents, depth + 1);
      return;
    }
    if (o.musicResponsiveListItemRenderer) {
      var r = fromListItem(o.musicResponsiveListItemRenderer);
      if (r.cid && !seen[r.cid]) { seen[r.cid] = 1; out.push(r); }
      return;
    }
    Object.keys(o).forEach(function(k) { walk(o[k], depth + 1); });
  })(json && json.contents, 0);
  return out;
}

/** Only YouTube Music's audio tracks (no music videos, no "Official Audio" uploads). */
function songsOnly(results) {
  return results.filter(function(r) { return r.kind === ATV && /^[A-Za-z0-9_-]{11}$/.test(r.cid) && r.title; });
}

// ----------------------------------------------------------------- search

function post(body, url) {
  return http(url || SEARCH_URL, {
    method: "POST",
    timeout: 20000,
    maxBytes: 4 * 1024 * 1024,
    headers: {
      "Content-Type": "application/json",
      Origin: "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
      "User-Agent": USER_AGENT,
      "X-YouTube-Client-Name": "67",
      "X-YouTube-Client-Version": CLIENT_VERSION
    },
    body: JSON.stringify(Object.assign({ context: clientContext() }, body))
  }).then(function(res) {
    if (res.status !== 200 || !res.json) {
      var err = new Error("YouTube Music answered HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    var vd = res.json.responseContext && res.json.responseContext.visitorData;
    if (vd) visitorData = vd;
    return res.json;
  });
}

/**
 * Search YouTube Music for songs. Uses the Songs filter; where that comes back
 * empty (some regions and servers only get videos from it), the full search
 * is read for the songs it lists instead.
 * @returns {Promise<{songs: Array, any: number, catalog: number}>} songs: audio
 *   tracks only; any: how many results of any kind came back; catalog: how
 *   many the Songs filter itself answered with (0 = "No results": from some
 *   servers the song catalog answers nothing at all, and that's no proof a
 *   song isn't there; lib/swaps.js catalogGate tells the two apart)
 */
function searchSongs(query) {
  return post({ query: query, params: SONGS_FILTER }).then(function(json) {
    var all = parseSearch(json);
    var songs = songsOnly(all);
    if (songs.length) return { songs: songs, any: all.length, catalog: all.length };
    return post({ query: query }).then(function(json2) {
      var all2 = parseSearch(json2);
      return { songs: songsOnly(all2), any: all.length + all2.length, catalog: all.length };
    });
  });
}

/**
 * What YouTube Music answers this server for a search, for the !ytmtest
 * command: the Songs filter's results, and the full search's by kind.
 * @returns {Promise<{catalog: number, catalogSongs: number,
 *   kinds: {songs: number, videos: number, uploads: number, other: number},
 *   songs: Array}>} songs: every audio track from both answers, catalog first
 */
function diagnose(query) {
  var count = function(all) {
    var k = { songs: 0, videos: 0, uploads: 0, other: 0 };
    all.forEach(function(r) {
      if (r.kind === ATV) k.songs++;
      else if (r.kind === "MUSIC_VIDEO_TYPE_OMV") k.videos++;
      else if (r.kind === "MUSIC_VIDEO_TYPE_UGC") k.uploads++;
      else k.other++;
    });
    return k;
  };
  return post({ query: query, params: SONGS_FILTER }).then(function(json) {
    var all = parseSearch(json);
    return post({ query: query }).then(function(json2) {
      var all2 = parseSearch(json2);
      var seen = {};
      var songs = songsOnly(all.concat(all2)).filter(function(s) { return seen[s.cid] ? false : (seen[s.cid] = true); });
      return { catalog: all.length, catalogSongs: songsOnly(all).length, kinds: count(all2), songs: songs };
    });
  });
}

// ---------------------------------------------------------- playlists

/** The rows of one page of a playlist (the first page or a continuation). */
function parsePlaylistPage(json) {
  if (!json) return [];
  return parseSearch({ contents: json.contents || json.onResponseReceivedActions || json.continuationContents });
}

/** The token for the next page of a playlist, or "" on the last page. */
function nextPageToken(json) {
  var token = "";
  (function walk(o, depth) {
    if (token || !o || typeof o !== "object" || depth > 40) return;
    if (Array.isArray(o)) { o.forEach(function(x) { walk(x, depth + 1); }); return; }
    if (o.continuationCommand && o.continuationCommand.token) { token = o.continuationCommand.token; return; }
    if (o.nextContinuationData && o.nextContinuationData.continuation) { token = o.nextContinuationData.continuation; return; }
    Object.keys(o).forEach(function(k) { walk(o[k], depth + 1); });
  })(json, 0);
  return token;
}

/**
 * Every track of a public YouTube Music playlist, in its order, with the
 * artists, album and length YouTube Music shows (no API key or quota). Pages
 * of 100 are read one after another, `delayMs` apart.
 * @param {string} playlistId - e.g. "PLTW5JZnPjE_..."
 * @returns {Promise<{title: string, tracks: Array<{cid, title, artist, album, dur, kind}>}>}
 *   kind: the upload's musicVideoType (ATV: an audio track) when it shows
 */
function playlistTracks(playlistId, opts) {
  opts = opts || {};
  var maxPages = opts.maxPages || 300;
  var delayMs = opts.delayMs == null ? 300 : opts.delayMs;
  var tracks = [];
  var seen = {};
  var title = "";
  var page = function(json, n) {
    if (!title) {
      var head = find(json && json.header, "title") || find(json && json.contents, "musicResponsiveHeaderRenderer");
      var runs = runsOf(head && (head.title || head));
      title = runs.map(function(r) { return r.text || ""; }).join("").trim();
    }
    parsePlaylistPage(json).forEach(function(r) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(r.cid) || seen[r.cid]) return;
      seen[r.cid] = 1;
      tracks.push({ cid: r.cid, title: r.title, artist: r.artist, album: r.album, dur: r.dur, kind: r.kind });
    });
    var token = nextPageToken(json);
    if (!token || n >= maxPages) return { title: title, tracks: tracks };
    return new Promise(function(r) { setTimeout(r, delayMs); }).then(function() {
      return post({ continuation: token }, BROWSE_URL);
    }).then(function(next) { return page(next, n + 1); });
  };
  return post({ browseId: "VL" + playlistId }, BROWSE_URL).then(function(json) {
    if (json.error || (!json.contents && !json.header)) {
      var err = new Error("YouTube Music has no playlist " + playlistId);
      err.status = 404;
      throw err;
    }
    return page(json, 1);
  });
}

// ------------------------------------------------------- YouTube search

var WEB_SEARCH_URL = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
var WEB_CLIENT_VERSION = process.env.YOUTUBE_WEB_CLIENT_VERSION || "2.20261110.00.00";
var VIDEOS_FILTER = "EgIQAQ=="; // the "Videos" filter
var PLAYLISTS_FILTER = "EgIQAw=="; // the "Playlists" filter

function textOf(t) {
  if (!t) return "";
  if (typeof t.simpleText === "string") return t.simpleText;
  return runsOf(t).map(function(r) { return r.text || ""; }).join("");
}

/** The videos in a YouTube (www.youtube.com) search answer, in its order. */
function parseWebSearch(json) {
  var out = [];
  var seen = {};
  (function walk(o, depth) {
    if (!o || typeof o !== "object" || depth > 40) return;
    if (Array.isArray(o)) { o.forEach(function(x) { walk(x, depth + 1); }); return; }
    if (o.videoRenderer) {
      var v = o.videoRenderer;
      if (/^[A-Za-z0-9_-]{11}$/.test(v.videoId || "") && !seen[v.videoId]) {
        seen[v.videoId] = 1;
        var snippets = (v.detailedMetadataSnippets || []).map(function(d) { return textOf(d.snippetText); });
        out.push({ cid: v.videoId, title: textOf(v.title).trim(), channel: textOf(v.ownerText || v.longBylineText).trim(),
          dur: seconds(textOf(v.lengthText)), description: snippets.join(" ").trim() });
      }
      return;
    }
    Object.keys(o).forEach(function(k) { walk(o[k], depth + 1); });
  })(json && json.contents, 0);
  return out;
}

/**
 * Search YouTube itself (what www.youtube.com's search box sends), with no
 * API key and no quota: videos only, with their channel, length and the bit
 * of description YouTube shows. For songs YouTube Music's search misses.
 * @returns {Promise<Array<{cid, title, channel, dur, description}>>}
 */
function webSearch(query) {
  return webPost(query, VIDEOS_FILTER).then(parseWebSearch);
}

function webPost(query, params) {
  return http(WEB_SEARCH_URL, {
    method: "POST",
    timeout: 20000,
    maxBytes: 4 * 1024 * 1024,
    headers: {
      "Content-Type": "application/json",
      Origin: "https://www.youtube.com",
      Referer: "https://www.youtube.com/",
      "User-Agent": USER_AGENT,
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": WEB_CLIENT_VERSION
    },
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: WEB_CLIENT_VERSION, hl: "en", gl: "US" } },
      query: query, params: params })
  }).then(function(res) {
    if (res.status !== 200 || !res.json) {
      var err = new Error("YouTube answered HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json;
  });
}

/** The playlists in a YouTube playlist search answer: [{id, title}], in its order. */
function parseWebPlaylists(json) {
  var out = [];
  var seen = {};
  var add = function(id, title) {
    if (!/^(?:PL|OLAK5uy_)[A-Za-z0-9_-]{10,}$/.test(id || "") || seen[id]) return;
    seen[id] = 1;
    out.push({ id: id, title: String(title || "").trim() });
  };
  (function walk(o, depth) {
    if (!o || typeof o !== "object" || depth > 40) return;
    if (Array.isArray(o)) { o.forEach(function(x) { walk(x, depth + 1); }); return; }
    if (o.lockupViewModel) {
      var l = o.lockupViewModel;
      var m = l.metadata && l.metadata.lockupMetadataViewModel;
      if (l.contentType === "LOCKUP_CONTENT_TYPE_PLAYLIST") add(l.contentId, m && m.title && m.title.content);
      return;
    }
    if (o.playlistRenderer) { add(o.playlistRenderer.playlistId, textOf(o.playlistRenderer.title)); return; }
    Object.keys(o).forEach(function(k) { walk(o[k], depth + 1); });
  })(json && json.contents, 0);
  return out;
}

/**
 * Search YouTube for playlists (no API key or quota). People's playlists of a
 * song or its album often hold YouTube Music's audio track, which YouTube's
 * own searches never list; read them with playlistTracks.
 * @returns {Promise<Array<{id, title}>>}
 */
function webPlaylists(query) {
  return webPost(query, PLAYLISTS_FILTER).then(parseWebPlaylists);
}

module.exports = {
  searchSongs: searchSongs,
  webSearch: webSearch,
  webPlaylists: webPlaylists,
  parseWebPlaylists: parseWebPlaylists,
  parseWebSearch: parseWebSearch,
  diagnose: diagnose,
  playlistTracks: playlistTracks,
  parsePlaylistPage: parsePlaylistPage,
  nextPageToken: nextPageToken,
  parseSearch: parseSearch,
  songsOnly: songsOnly,
  seconds: seconds,
  ATV: ATV
};
