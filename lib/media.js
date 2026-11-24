// The media APIs the bot asks about uploads: the YouTube Data API (with
// YOUTUBE_KEY: videos.list at 1 unit, search.list at 100, playlistItems.list
// at 1 a page) and SoundCloud (its web API with SOUNDCLOUD_KEY, or its
// official API with a registered app's SOUNDCLOUD_CLIENT_ID and _SECRET).
"use strict";
var http = require("./http").http;
var checks = require("./checks");
var swaps = require("./swaps");

/**
 * @param {Object<string, string|undefined>} env - process.env (YOUTUBE_KEY, SOUNDCLOUD_*)
 */
function createMedia(env) {
  // One call to the YouTube Data API (videos.list, 1 unit of quota) for what the
  // bot checks: length, title, channel (and the description, which names the
  // artist of a new release YouTube files under "Release - Topic"), artwork, and whether it can play here
  // (privacy, embedding, region blocks, age limits, premieres; lib/checks.js).
  // cb(error, result): result is the API's answer ({items: [...]}); error when
  // it couldn't answer (quota, API key, network), with YouTube's own message.
  var YT_FIELDS = "items(snippet(title,channelTitle,description,publishedAt,thumbnails,liveBroadcastContent),contentDetails(duration,regionRestriction,contentRating),status(embeddable,privacyStatus,uploadStatus))";
  var youtubeVideo = function(id, cb) {
    var url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("id", id);
    url.searchParams.set("fields", YT_FIELDS);
    url.searchParams.set("key", env.YOUTUBE_KEY || "");
    http(url).then(function(res) {
      if (res.status === 200 && res.json && Array.isArray(res.json.items)) return cb(null, res.json);
      var apiError = res.json && res.json.error;
      var err = Object.assign(new Error((apiError && apiError.message) || "YouTube answered HTTP " + res.status), { code: (apiError && apiError.code) || res.status });
      cb(err, null);
    }, function(err) {
      cb(err, null);
    });
  };

  // ─── SoundCloud track lookups ───────────────────────────────────────────────
  // Free, and what the room uses: SoundCloud's own web API (api-v2) with a
  // client id (SOUNDCLOUD_KEY). It needs no registered app, but it isn't
  // SoundCloud's public API, so they can change it or stop that client id at any
  // time; the bot then can't check SoundCloud tracks and passes the decks (see
  // "soundcloud" in the README).
  // Optional: with SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET (a
  // registered SoundCloud app) set, it uses the official API with an OAuth token
  // instead. Unset, nothing changes.
  var scOfficial = !!(env.SOUNDCLOUD_CLIENT_ID && env.SOUNDCLOUD_CLIENT_SECRET);
  var scToken = null; // { value, expires }

  var scAccessToken = function(forceNew) {
    if (!forceNew && scToken && scToken.expires > Date.now()) return Promise.resolve(scToken.value);
    var basic = Buffer.from(env.SOUNDCLOUD_CLIENT_ID + ":" + env.SOUNDCLOUD_CLIENT_SECRET).toString("base64");
    return http("https://secure.soundcloud.com/oauth/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + basic,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json; charset=utf-8"
      },
      body: "grant_type=client_credentials"
    }).then(function(res) {
      if (res.status !== 200 || !res.json || !res.json.access_token) {
        throw new Error("SoundCloud token request answered HTTP " + res.status);
      }
      // reuse it until a minute before it expires (SoundCloud limits new tokens)
      scToken = { value: res.json.access_token, expires: Date.now() + (Math.max(120, Number(res.json.expires_in) || 3600) - 60) * 1000 };
      return scToken.value;
    });
  };

  // cb(error, httpStatus, track): track is SoundCloud's track object when found
  var soundcloudTrack = function(cid, cb) {
    var answered = function(status, track) { cb(null, status, track); };
    var failed = function(err) { cb(err, null, null); };
    if (!scOfficial) {
      http('https://api-v2.soundcloud.com/resolve?url=https%3A//api.soundcloud.com/tracks/' + encodeURIComponent(cid) +
        '&format=json&client_id=' + encodeURIComponent(env.SOUNDCLOUD_KEY || "")).then(function(res) {
        answered(res.status, res.status === 200 ? res.json : null);
      }, failed);
      return;
    }
    var attempt = function(retried) {
      return scAccessToken(retried).then(function(token) {
        return http("https://api.soundcloud.com/tracks/" + encodeURIComponent(cid), {
          headers: { Authorization: "OAuth " + token, Accept: "application/json; charset=utf-8" }
        });
      }).then(function(res) {
        if (res.status === 401 && !retried) return attempt(true); // token expired early
        answered(res.status, res.status === 200 ? res.json : null);
      });
    };
    attempt(false).catch(failed);
  };

  // SoundCloud's track search (swap suggestions for lists kept to SoundCloud):
  // [{cid, title, user, dur (s), url, img, problem (flag code, 0 = plays in full)}]
  var soundcloudSearch = function(query) {
    var shape = function(list) {
      return (list || []).filter(function(tr) { return tr && tr.id && tr.kind !== "playlist"; }).map(function(tr) {
        return { cid: String(tr.id), title: String(tr.title || ""), user: String((tr.user && tr.user.username) || ""),
          dur: Math.round((Number(tr.full_duration || tr.duration) || 0) / 1000), url: String(tr.permalink_url || ""),
          img: String(tr.artwork_url || (tr.user && tr.user.avatar_url) || ""), problem: checks.soundcloudProblem(tr) };
      });
    };
    var failed = function(res) {
      throw Object.assign(new Error("SoundCloud answered HTTP " + res.status), { status: res.status });
    };
    if (!scOfficial) {
      return http("https://api-v2.soundcloud.com/search/tracks?q=" + encodeURIComponent(query) + "&limit=20&client_id=" +
        encodeURIComponent(env.SOUNDCLOUD_KEY || ""), { timeout: 20000, maxBytes: 4 * 1024 * 1024 }).then(function(res) {
        if (res.status !== 200 || !res.json) return failed(res);
        return shape(res.json.collection);
      });
    }
    return scAccessToken(false).then(function(token) {
      return http("https://api.soundcloud.com/tracks?q=" + encodeURIComponent(query) + "&limit=20&linked_partitioning=true", {
        timeout: 20000, maxBytes: 4 * 1024 * 1024, headers: { Authorization: "OAuth " + token, Accept: "application/json; charset=utf-8" } });
    }).then(function(res) {
      if (res.status !== 200 || !res.json) return failed(res);
      return shape(Array.isArray(res.json) ? res.json : res.json.collection);
    });
  };


  // Can these YouTube videos play here, and are they YouTube Music audio
  // tracks? One videos.list call (1 unit) for up to 50. Resolves {id: {problem
  // (flag code, 0 = fine), audio, dur, channel, title}}; ids YouTube doesn't know are left out
  // (gone). Rejects when YouTube can't answer (quota, key, network).
  var youtubeProblems = function(ids) {
    var url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("id", ids.join(","));
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("fields", "items(id,snippet(title,channelTitle,description,liveBroadcastContent),contentDetails(duration,regionRestriction,contentRating),status(embeddable,privacyStatus,uploadStatus))");
    url.searchParams.set("key", env.YOUTUBE_KEY || "");
    return http(url, { timeout: 30000 }).then(function(res) {
      if (res.status !== 200 || !res.json || !Array.isArray(res.json.items)) {
        var apiError = res.json && res.json.error;
        throw new Error((apiError && apiError.message) || "YouTube answered HTTP " + res.status);
      }
      var out = {};
      res.json.items.forEach(function(item) {
        var sn = item.snippet || {};
        out[item.id] = { problem: checks.youtubeProblem(item), dur: isoSeconds(item.contentDetails && item.contentDetails.duration),
          audio: swaps.isArtTrack({ channel: sn.channelTitle, description: sn.description }),
          channel: swaps.topicChannel(sn.channelTitle, sn.description, sn.title), title: String(sn.title || "") };
      });
      return out;
    });
  };

  // The YouTube Data API's search (100 units): videos for a song (with their
  // channel and the start of their description), or playlists. Only for songs
  // whose free search didn't answer (lib/swaps.js keeps it within
  // SWAP_API_UNITS a day).
  var htmlText = function(s) {
    return String(s || "").replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, function(m, e) {
      var named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[e.toLowerCase()];
      if (named) return named;
      var n = e.charAt(1).toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    });
  };
  var youtubeSearch = function(query, type) {
    var url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", type || "video");
    if (!type) url.searchParams.set("videoCategoryId", "10"); // Music
    url.searchParams.set("maxResults", "25");
    url.searchParams.set("q", query);
    url.searchParams.set("fields", "items(id(videoId,playlistId),snippet(title,channelTitle,description))");
    url.searchParams.set("key", env.YOUTUBE_KEY || "");
    return http(url, { timeout: 30000 }).then(function(res) {
      if (res.status !== 200 || !res.json || !Array.isArray(res.json.items)) {
        var apiError = res.json && res.json.error;
        throw new Error((apiError && apiError.message) || "YouTube answered HTTP " + res.status);
      }
      return res.json.items.map(function(it) {
        var sn = it.snippet || {};
        var id = it.id || {};
        if (type === "playlist") return { id: id.playlistId, title: htmlText(sn.title) };
        var description = htmlText(sn.description);
        return { cid: id.videoId, title: htmlText(sn.title), channel: swaps.topicChannel(htmlText(sn.channelTitle), description, htmlText(sn.title)), description: description };
      }).filter(function(v) { return v.cid || v.id; });
    });
  };

  var isoSeconds = function(d) {
    var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(d || ""));
    if (!m) return 0;
    return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
  };

  // What YouTube says about up to 50 videos (1 unit): {id: {problem (flag code,
  // 0 = fine), dur (s), title, channel}}. Ids it doesn't know are left out.
  var youtubeVideos = function(ids) {
    var url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("id", ids.join(","));
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("fields", "items(id,snippet(title,channelTitle,description,liveBroadcastContent),contentDetails(duration,regionRestriction,contentRating),status(embeddable,privacyStatus,uploadStatus))");
    url.searchParams.set("key", env.YOUTUBE_KEY || "");
    return http(url, { timeout: 30000 }).then(function(res) {
      if (res.status !== 200 || !res.json || !Array.isArray(res.json.items)) {
        var apiError = res.json && res.json.error;
        throw new Error((apiError && apiError.message) || "YouTube answered HTTP " + res.status);
      }
      var out = {};
      res.json.items.forEach(function(item) {
        var sn = item.snippet || {};
        out[item.id] = { problem: checks.youtubeProblem(item), dur: isoSeconds(item.contentDetails && item.contentDetails.duration),
          title: String(sn.title || ""), channel: swaps.topicChannel(sn.channelTitle, sn.description, sn.title) };
      });
      return out;
    });
  };

  // Release information for Discover's new releases: each upload's description
  // ("Released on: …" on "Artist - Topic" uploads) and upload date (1 unit per 50).
  var youtubeSnippets = function(ids) {
    var url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", ids.join(","));
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("fields", "items(id,snippet(description,publishedAt))");
    url.searchParams.set("key", env.YOUTUBE_KEY || "");
    return http(url, { timeout: 30000 }).then(function(res) {
      if (res.status !== 200 || !res.json || !Array.isArray(res.json.items)) {
        var apiError = res.json && res.json.error;
        throw new Error((apiError && apiError.message) || "YouTube answered HTTP " + res.status);
      }
      var out = {};
      res.json.items.forEach(function(item) { out[item.id] = item.snippet || {}; });
      return out;
    });
  };

  // The videos of a playlist from the YouTube Data API (1 unit per 50), for
  // when YouTube Music can't answer.
  var youtubePlaylistItems = function(playlistId) {
    var ids = [];
    var page = function(token, n) {
      var url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      url.searchParams.set("part", "contentDetails");
      url.searchParams.set("playlistId", playlistId);
      url.searchParams.set("maxResults", "50");
      url.searchParams.set("fields", "nextPageToken,items(contentDetails(videoId))");
      url.searchParams.set("key", env.YOUTUBE_KEY || "");
      if (token) url.searchParams.set("pageToken", token);
      return http(url, { timeout: 30000 }).then(function(res) {
        if (res.status !== 200 || !res.json || !Array.isArray(res.json.items)) {
          var apiError = res.json && res.json.error;
          throw new Error((apiError && apiError.message) || "YouTube answered HTTP " + res.status);
        }
        res.json.items.forEach(function(it) { if (it.contentDetails && it.contentDetails.videoId) ids.push(it.contentDetails.videoId); });
        return res.json.nextPageToken && n < 200 ? page(res.json.nextPageToken, n + 1) : ids;
      });
    };
    return page("", 1);
  };

  return {
    scOfficial: scOfficial, youtubeVideo: youtubeVideo, soundcloudTrack: soundcloudTrack, soundcloudSearch: soundcloudSearch,
    youtubeProblems: youtubeProblems, youtubeSearch: youtubeSearch, youtubeVideos: youtubeVideos,
    youtubeSnippets: youtubeSnippets, youtubePlaylistItems: youtubePlaylistItems
  };
}

module.exports = { createMedia: createMedia };
