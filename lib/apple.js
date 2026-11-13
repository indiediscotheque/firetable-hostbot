// Apple's catalog (the iTunes Search API: free, no key, about 20 lookups a
// minute). Used as a guide, never as a source of tracks: it says which
// album a song is on, and that album's YouTube Music page or playlist holds
// the audio track (lib/swaps.js).
"use strict";

var http = require("./http").http;

var SEARCH_URL = "https://itunes.apple.com/search";

/** The songs in an iTunes Search answer: [{artist, title, album, dur, explicit}], in its order. */
function parseSongs(json) {
  var rows = json && Array.isArray(json.results) ? json.results : [];
  return rows.filter(function(r) { return r && r.kind === "song" && r.trackName && r.artistName; }).map(function(r) {
    return {
      artist: String(r.artistName),
      title: String(r.trackName),
      album: String(r.collectionName || ""),
      dur: Math.round((Number(r.trackTimeMillis) || 0) / 1000),
      explicit: r.trackExplicitness === "explicit"
    };
  });
}

/**
 * Apple's songs for a search ("Artist Title"), US store.
 * @param {string} query
 * @returns {Promise<Array<{artist, title, album, dur, explicit}>>}
 *   Rejects when Apple doesn't answer (err.status 403/429 when it's limiting)
 */
function searchSongs(query) {
  var url = new URL(SEARCH_URL);
  url.searchParams.set("term", String(query || "").slice(0, 200));
  url.searchParams.set("entity", "song");
  url.searchParams.set("media", "music");
  url.searchParams.set("country", "US");
  url.searchParams.set("limit", "10");
  return http(url, { timeout: 15000, maxBytes: 2 * 1024 * 1024 }).then(function(res) {
    if (res.status !== 200 || !res.json) {
      var err = new Error("Apple answered HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return parseSongs(res.json);
  });
}

module.exports = { searchSongs: searchSongs, parseSongs: parseSongs };
