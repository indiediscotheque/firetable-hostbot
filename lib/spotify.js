// Spotify playlists for the site's import (redesign step 1.21): the bot reads
// a public playlist's songs (title, artists, length) with Spotify's Web API,
// and lib/imports.js finds each one here the way it does a pasted list.
//
// Client credentials only (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env,
// from the app's settings at developer.spotify.com): no one signs in to
// Spotify, so only public playlists can be read. Since November 2024 Spotify
// doesn't give new apps its own editorial and made-for-you playlists (Discover
// Weekly, Daily Mix, "This Is"); they answer "not found" like a private one,
// and the site says so.
"use strict";

var TOKEN_URL = "https://accounts.spotify.com/api/token";
var API = "https://api.spotify.com/v1";
var ID = /^[A-Za-z0-9]{22}$/;
var MAX_TRACKS = 500;
var PAGE = 100;

/**
 * A Spotify playlist's id from a link, a spotify: URI or the id itself, or null.
 * Takes open.spotify.com/playlist/ID (with or without /intl-xx/ and ?si=…),
 * spotify:playlist:ID and spotify:user:NAME:playlist:ID.
 * @param {string} text
 * @returns {string|null}
 */
function playlistId(text) {
  text = String(text || "").trim();
  var m = text.match(/^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:user\/[^/]+\/)?playlist\/([A-Za-z0-9]{22})(?:[/?#]|$)/i) ||
    text.match(/^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]{22})$/i);
  if (m) return m[1];
  return ID.test(text) ? text : null;
}

/** A Spotify track item as a song to look up: {a, t, d}, or null (local files, episodes, removed songs). */
function songOf(item) {
  var t = item && item.track;
  if (!t || t.is_local || (t.type && t.type !== "track") || !t.name) return null;
  var artists = (t.artists || []).map(function(a) { return a && a.name; }).filter(Boolean);
  var song = { a: artists.join(", ").slice(0, 300), t: String(t.name).slice(0, 300) };
  var d = Math.round((Number(t.duration_ms) || 0) / 1000);
  if (d > 0 && d <= 86400) song.d = d;
  return song;
}

/**
 * @param {Object} deps
 *   clientId, clientSecret: the app's (no Spotify without both)
 *   http(url, opts) -> Promise<{status, headers, json}>   (lib/http.js)
 *   now() -> ms, wait(ms) -> Promise   (tests)
 */
function createSpotify(deps) {
  var now = deps.now || Date.now;
  var wait = deps.wait || function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var token = null; // {value, until}

  var configured = function() { return !!(deps.clientId && deps.clientSecret); };

  var getToken = function(fresh) {
    if (!fresh && token && now() < token.until) return Promise.resolve(token.value);
    var basic = Buffer.from(deps.clientId + ":" + deps.clientSecret).toString("base64");
    return deps.http(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      timeout: 15000
    }).then(function(res) {
      var j = res.json || {};
      if (res.status !== 200 || !j.access_token) {
        var err = new Error("Spotify refused the app's keys (" + (j.error_description || j.error || "HTTP " + res.status) + ")");
        err.code = "keys";
        throw err;
      }
      token = { value: j.access_token, until: now() + Math.max(60, (Number(j.expires_in) || 3600) - 60) * 1000 };
      return token.value;
    });
  };

  // a Web API GET: a fresh token once on 401, Spotify's Retry-After on 429 (twice at most)
  var get = function(url, tries) {
    tries = tries || 0;
    return getToken(false).then(function(value) {
      return deps.http(url, { headers: { Authorization: "Bearer " + value }, timeout: 20000 });
    }).then(function(res) {
      if (res.status === 401 && tries === 0) {
        token = null;
        return get(url, 1);
      }
      if (res.status === 429 && tries < 3) {
        var after = Number(res.headers && res.headers.get && res.headers.get("retry-after")) || 2;
        return wait(Math.min(after, 30) * 1000).then(function() { return get(url, tries + 1); });
      }
      return res;
    });
  };

  return {
    configured: configured,
    /** Can the bot read Spotify now? (a token comes back for the keys) */
    check: function() {
      if (!configured()) return Promise.resolve(false);
      return getToken(true).then(function() { return true; }, function() { return false; });
    },
    /**
     * A public playlist's name, owner and songs (at most 500).
     * @param {string} id
     * @returns {Promise<{name: string, by: string, total: number, tracks: Array<{a, t, d?}>, skipped: number}>}
     *   Rejects with err.code "keys" (the app's keys don't work), "gone" (no
     *   such playlist, a private one, or one of Spotify's own) or "spotify"
     *   (Spotify didn't answer).
     */
    playlist: function(id) {
      if (!configured()) return Promise.reject(Object.assign(new Error("Spotify isn't set up on the bot"), { code: "keys" }));
      if (!ID.test(String(id))) return Promise.reject(Object.assign(new Error("That isn't a Spotify playlist"), { code: "gone" }));
      var out = { name: "", by: "", total: 0, tracks: [], skipped: 0 };
      var fail = function(res) {
        var code = res.status === 404 || res.status === 403 || res.status === 400 ? "gone" : "spotify";
        var msg = code === "gone" ? "Spotify won't show that playlist (it's private, or one of Spotify's own)" : "Spotify didn't answer (HTTP " + res.status + ")";
        throw Object.assign(new Error(msg), { code: code });
      };
      return get(API + "/playlists/" + id + "?fields=name,owner(display_name),tracks(total)").then(function(res) {
        if (res.status !== 200 || !res.json) fail(res);
        out.name = String(res.json.name || "Spotify playlist").slice(0, 100);
        out.by = String((res.json.owner && res.json.owner.display_name) || "").slice(0, 100);
        out.total = Number(res.json.tracks && res.json.tracks.total) || 0;
        var page = function(offset) {
          var url = API + "/playlists/" + id + "/tracks?limit=" + PAGE + "&offset=" + offset +
            "&fields=next,items(track(name,type,is_local,duration_ms,artists(name)))";
          return get(url).then(function(r) {
            if (r.status !== 200 || !r.json) fail(r);
            (r.json.items || []).forEach(function(item) {
              var s = songOf(item);
              if (s && out.tracks.length < MAX_TRACKS) out.tracks.push(s); else if (!s) out.skipped++;
            });
            if (r.json.next && out.tracks.length < MAX_TRACKS && offset + PAGE < 10000) return page(offset + PAGE);
            return out;
          });
        };
        return page(0);
      }).catch(function(err) {
        if (err && err.code) throw err;
        throw Object.assign(new Error("Spotify didn't answer (" + (err && err.message) + ")"), { code: "spotify" });
      });
    }
  };
}

module.exports = { createSpotify: createSpotify, playlistId: playlistId, songOf: songOf, MAX_TRACKS: MAX_TRACKS };
