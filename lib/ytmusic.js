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

function post(body) {
  return http(SEARCH_URL, {
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
 * @returns {Promise<{songs: Array, any: number}>} songs: audio tracks only;
 *   any: how many results of any kind came back
 */
function searchSongs(query) {
  return post({ query: query, params: SONGS_FILTER }).then(function(json) {
    var all = parseSearch(json);
    var songs = songsOnly(all);
    if (songs.length) return { songs: songs, any: all.length };
    return post({ query: query }).then(function(json2) {
      var all2 = parseSearch(json2);
      return { songs: songsOnly(all2), any: all.length + all2.length };
    });
  });
}

module.exports = {
  searchSongs: searchSongs,
  parseSearch: parseSearch,
  songsOnly: songsOnly,
  seconds: seconds,
  ATV: ATV
};
