// Last.fm: the room's plays scrobbled to its account (track.updateNowPlaying
// when a song goes on the decks, track.scrobble when it ends having played
// long enough: lib/checks.js scrobbles), and how often that account has
// played a track (for !plays). .env LASTFM_APIKEY, LASTFM_SECRET (the key's
// shared secret: no scrobbling without it), LASTFM_SESSIONKEY, LASTFM_USERNAME.
"use strict";
var http = require("./http").http;
var checks = require("./checks");
var text = require("./text");

var LASTFM_API = "https://ws.audioscrobbler.com/2.0/";

/**
 * @param {Object<string, string|undefined>} env - process.env
 */
function createLastfm(env) {
  var lastfm = {
    sk: env.LASTFM_SESSIONKEY,
    // Scrobbling needs the API key and its shared secret (.env LASTFM_SECRET)
    key: env.LASTFM_SECRET ? env.LASTFM_APIKEY : null,
    secret: env.LASTFM_SECRET,
    playing: null, // {song, start (unix seconds)} for the song on the decks

    // A song went on the decks: tell last.fm it's playing now.
    started: function(s) {
      lastfm.playing = { song: s, start: Math.floor(Date.now() / 1000) };
      if (!lastfm.key) return;
      lastfm.call({
        method: "track.updateNowPlaying",
        artist: s.artist,
        track: s.title,
        duration: s.duration
      });
    },
    // The song ended or was skipped: scrobble it if it played long enough by
    // last.fm's rule (lib/checks.js scrobbles).
    ended: function(ranToEnd) {
      var p = lastfm.playing;
      lastfm.playing = null;
      if (!p || !lastfm.key) return;
      var played = Math.floor(Date.now() / 1000) - p.start;
      if (!checks.scrobbles(p.song.duration, played, ranToEnd)) return;
      lastfm.call({
        method: "track.scrobble",
        artist: p.song.artist, // tags fixed while it played are on this object
        track: p.song.title,
        timestamp: p.start,
        duration: p.song.duration
      });
    },
    // A signed write call (POST). Last.fm's refusals are logged, never thrown.
    call: function(params) {
      params.api_key = lastfm.key;
      params.sk = lastfm.sk;
      Object.keys(params).forEach(function(k) {
        if (params[k] === undefined || params[k] === null) delete params[k];
      });
      params.api_sig = lastfm.getApiSignature(params);
      params.format = "json"; // never signed
      return http(LASTFM_API, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString()
      }).then(function(res) {
        if (res.status !== 200 || (res.json && res.json.error)) {
          console.log("last.fm " + params.method + " refused: " + ((res.json && res.json.message) || "HTTP " + res.status));
        }
      }, function(err) {
        console.log("last.fm " + params.method + " failed:", err.message);
      });
    },
    // How often the room's last.fm account has played a track (false if unknown).
    playcount: function(artist, title) {
      if (!env.LASTFM_APIKEY || !env.LASTFM_USERNAME) return Promise.resolve(false);
      var url = new URL(LASTFM_API);
      url.searchParams.set("method", "track.getInfo");
      url.searchParams.set("track", title);
      url.searchParams.set("artist", artist);
      url.searchParams.set("username", env.LASTFM_USERNAME);
      url.searchParams.set("api_key", env.LASTFM_APIKEY);
      url.searchParams.set("format", "json");
      return http(url).then(function(res) {
        var n = res.status === 200 && res.json && res.json.track && parseInt(res.json.track.userplaycount, 10);
        return n > 0 ? n : false;
      }, function() {
        return false;
      });
    },
    // Last.fm's api_sig: the params sorted by name, name+value joined, then the
    // secret, MD5'd (UTF-8)
    getApiSignature: function(params) {
      var raw = Object.keys(params).sort().map(function(k) { return k + params[k]; }).join("");
      return text.md5(raw + lastfm.secret);
    }
  };
  return lastfm;
}

module.exports = { createLastfm: createLastfm, LASTFM_API: LASTFM_API };
