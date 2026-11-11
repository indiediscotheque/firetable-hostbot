// Genre playlists on YouTube Music: one public playlist per genre on the
// room's YouTube account ("Indie Discotheque · Nu-Disco"), holding the
// genre's room favorites from Discover's library (discover/lib/genre/<slug>,
// written each week by the Play history job). Each description links back to
// the genre's page on the site.
//
// It edits playlists through the YouTube Data API, signed in as the account
// that owns them (tools/youtube-auth.js gives the refresh token). Writes cost
// 50 quota units each, so each run spends at most a daily budget: the first
// fill takes some days, then a run only lists each playlist (1 unit per 50
// songs) and changes what moved in that week's favorites.
//
//   discover/ytm/<slug>                 the playlist's id (public: the site
//                                       links to it from the genre page)
//   discoverCache/ytPlaylists/<slug>    {id, desc} what the bot made
//   discoverCache/ytPlaylistsBad/<cid>  a video YouTube refused, and when
//   discoverCache/ytPlaylistsRun        the last run's summary
"use strict";

var API = "https://www.googleapis.com/youtube/v3/";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var COST = { list: 1, write: 50 };
var BAD_DAYS = 30;
var DAY = 86400000;

/** The genre's YouTube songs to put in its playlist, best first, no repeats. */
function wantedSongs(fav, max) {
  var seen = new Set();
  var out = [];
  // Firebase can hand a list back as an object keyed "0", "1", …
  var rows = Array.isArray(fav) ? fav : Object.keys(fav || {}).sort(function(a, b) { return a - b; }).map(function(k) { return fav[k]; });
  rows.forEach(function(r) {
    if (!r || (r.type && Number(r.type) !== 1) || !/^[\w-]{11}$/.test(String(r.cid || "")) || seen.has(r.cid)) return;
    seen.add(r.cid);
    if (out.length < max) out.push(r.cid);
  });
  return out;
}

/**
 * What to change: playlist items to delete (not wanted, or a second copy)
 * and videos to add (wanted, not there yet), in the order wanted.
 * @param {Array<{itemId: string, videoId: string}>} items - the playlist now
 * @param {Array<string>} want - video ids
 */
function plan(items, want) {
  var wanted = new Set(want);
  var have = new Set();
  var remove = [];
  items.forEach(function(it) {
    if (!wanted.has(it.videoId) || have.has(it.videoId)) remove.push(it.itemId);
    else have.add(it.videoId);
  });
  return { remove: remove, add: want.filter(function(v) { return !have.has(v); }) };
}

function titleOf(genre, room) { return (room + " · " + genre).slice(0, 150); }

function descriptionOf(genre, slug, opts) {
  var site = opts.site ? opts.site.replace(/\/?$/, "/") : "";
  var lines = [genre + " favorites from " + opts.room + ": the songs its DJs have played most, updated every week."];
  if (opts.about) lines.push(opts.about);
  if (site) lines.push("Hear them live and find more: " + site + "music/genres/" + slug + "/");
  return lines.join("\n\n").slice(0, 5000);
}

/** A stop that ends the run for today (quota spent, sign-in refused). */
function Stop(message) { var e = new Error(message); e.stop = true; return e; }

/**
 * @param {Object} deps
 * @param {Object} deps.db - firebase database
 * @param {Function} deps.http - lib/http.js
 * @param {{clientId: string, clientSecret: string, refreshToken: string}} deps.auth
 * @param {string} [deps.site] - the site's address (SITE_URL)
 * @param {string} [deps.room] - "Indie Discotheque"
 * @param {number} [deps.units] - quota units a run may spend (default 4000)
 * @param {number} [deps.songs] - songs per playlist (default 50)
 * @param {number} [deps.minSongs] - genres with fewer YouTube songs get none (default 20)
 * @param {Function} [deps.now]
 * @param {Function} [deps.log]
 */
function createGenrePlaylists(deps) {
  var db = deps.db;
  var http = deps.http;
  var log = deps.log || function() {};
  var now = deps.now || Date.now;
  var room = deps.room || "Indie Discotheque";
  var budget = deps.units || 4000;
  var maxSongs = deps.songs || 50;
  var minSongs = deps.minSongs || 20;

  var run = function() {
    var spent = 0;
    var token = null;
    var sum = { created: 0, added: 0, removed: 0, skipped: 0, done: 0, waiting: 0, units: 0, stopped: null };

    var signIn = function() {
      var body = new URLSearchParams({
        client_id: deps.auth.clientId, client_secret: deps.auth.clientSecret,
        refresh_token: deps.auth.refreshToken, grant_type: "refresh_token"
      });
      return http(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }).then(function(res) {
        if (res.status !== 200 || !res.json || !res.json.access_token) {
          var why = (res.json && (res.json.error_description || res.json.error)) || "HTTP " + res.status;
          throw Stop("YouTube sign-in refused (" + why + "): run tools/youtube-auth.js again and update YOUTUBE_REFRESH_TOKEN");
        }
        token = res.json.access_token;
      });
    };

    // one Data API call, counted against the budget
    var call = function(method, path, params, body, cost) {
      if (spent + cost > budget) return Promise.reject(Stop("today's budget of " + budget + " units is spent"));
      spent += cost;
      var url = new URL(API + path);
      Object.keys(params || {}).forEach(function(k) { if (params[k] != null) url.searchParams.set(k, params[k]); });
      return http(url, {
        method: method, timeout: 30000,
        headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined
      }).then(function(res) {
        if (res.status >= 200 && res.status < 300) return res.json || {};
        var err = (res.json && res.json.error) || {};
        var reason = (err.errors && err.errors[0] && err.errors[0].reason) || "";
        if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) throw Stop("YouTube's daily quota is used up");
        if (res.status === 401) throw Stop("YouTube sign-in expired mid-run");
        var e = new Error(err.message || "YouTube answered HTTP " + res.status);
        e.status = res.status;
        e.reason = reason;
        throw e;
      });
    };

    var listItems = function(id) {
      var items = [];
      var page = function(pageToken) {
        return call("GET", "playlistItems", { part: "snippet", playlistId: id, maxResults: 50, pageToken: pageToken, fields: "nextPageToken,items(id,snippet/resourceId/videoId)" }, null, COST.list).then(function(json) {
          (json.items || []).forEach(function(it) { items.push({ itemId: it.id, videoId: it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId }); });
          return json.nextPageToken ? page(json.nextPageToken) : items;
        });
      };
      return page(null);
    };

    var makePlaylist = function(slug, genre, desc) {
      return call("POST", "playlists", { part: "snippet,status" }, {
        snippet: { title: titleOf(genre, room), description: desc, defaultLanguage: "en" },
        status: { privacyStatus: "public" }
      }, COST.write).then(function(json) {
        sum.created++;
        var updates = {};
        updates["discoverCache/ytPlaylists/" + slug] = { id: json.id, desc: desc, at: now() };
        updates["discover/ytm/" + slug] = json.id;
        return db.ref().update(updates).then(function() { return json.id; });
      });
    };

    var syncGenre = function(g, state, bad) {
      return db.ref("discover/lib/genre/" + g.slug + "/fav").once("value").then(function(s) {
        var want = wantedSongs(s.val(), maxSongs + 20).filter(function(cid) {
          var b = bad[cid];
          return !(b && now() - b < BAD_DAYS * DAY);
        }).slice(0, maxSongs);
        if (want.length < minSongs && !state) { sum.skipped++; return null; }
        var desc = descriptionOf(g.name, g.slug, { site: deps.site, room: room, about: g.about });
        var id = state && state.id;
        var ready = id ? Promise.resolve(id) : makePlaylist(g.slug, g.name, desc);
        return ready.then(function(pid) {
          id = pid;
          // the genre's line or the site's address changed: say so on YouTube
          if (state && state.desc !== desc) {
            return call("PUT", "playlists", { part: "snippet" }, { id: id, snippet: { title: titleOf(g.name, room), description: desc, defaultLanguage: "en" } }, COST.write)
              .then(function() { return db.ref("discoverCache/ytPlaylists/" + g.slug + "/desc").set(desc); });
          }
        }).then(function() {
          return listItems(id);
        }).then(function(items) {
          var todo = plan(items, want);
          // take songs out first, so the list never grows past its size
          var steps = todo.remove.map(function(itemId) {
            return function() { return call("DELETE", "playlistItems", { id: itemId }, null, COST.write).then(function() { sum.removed++; }); };
          }).concat(todo.add.map(function(videoId) {
            return function() {
              return call("POST", "playlistItems", { part: "snippet" }, { snippet: { playlistId: id, resourceId: { kind: "youtube#video", videoId: videoId } } }, COST.write)
                .then(function() { sum.added++; }, function(err) {
                  if (err.stop) throw err;
                  // gone, private or not allowed in playlists: leave it out for a while
                  log("youtube music playlists: " + g.name + ": couldn't add " + videoId + " (" + err.message + ")");
                  return db.ref("discoverCache/ytPlaylistsBad/" + videoId).set(now());
                });
            };
          }));
          return steps.reduce(function(p, step) { return p.then(step); }, Promise.resolve()).then(function() { sum.done++; });
        }, function(err) {
          if (err.stop) throw err;
          if (err.status === 404) {
            // deleted on YouTube: forget it, and make it again next run
            log("youtube music playlists: the " + g.name + " playlist is gone from YouTube; it will be made again");
            var updates = {};
            updates["discoverCache/ytPlaylists/" + g.slug] = null;
            updates["discover/ytm/" + g.slug] = null;
            return db.ref().update(updates);
          }
          throw err;
        });
      });
    };

    return Promise.all([
      db.ref("discover/lib/genres").once("value"),
      db.ref("discoverCache/ytPlaylists").once("value"),
      db.ref("discoverCache/ytPlaylistsBad").once("value")
    ]).then(function(got) {
      var genres = got[0].val() || {};
      var states = got[1].val() || {};
      var bad = got[2].val() || {};
      var list = Object.keys(genres).map(function(slug) { return Object.assign({ slug: slug }, genres[slug]); })
        .filter(function(g) { return g.name; })
        .sort(function(a, b) { return (b.plays || 0) - (a.plays || 0) || (a.slug < b.slug ? -1 : 1); });
      if (!list.length) { sum.stopped = "no genres yet (the Play history job publishes them)"; return; }
      return signIn().then(function() {
        // biggest genres first, one at a time, so playlists fill up whole
        return list.reduce(function(p, g, i) {
          return p.then(function() {
            if (sum.stopped) return;
            return syncGenre(g, states[g.slug], bad).catch(function(err) {
              if (err.stop) { sum.stopped = err.message; sum.waiting += list.length - i; return; }
              log("youtube music playlists: " + g.name + ": " + err.message);
            });
          });
        }, Promise.resolve());
      }, function(err) { sum.stopped = err.message; });
    }).then(function() {
      sum.units = spent;
      return db.ref("discoverCache/ytPlaylistsRun").set(Object.assign({ at: now() }, sum)).catch(function() {}).then(function() {
        log("youtube music playlists: " + sum.done + " in step, " + sum.created + " made, " + sum.added + " songs added, " + sum.removed + " taken out, " +
          spent + " units" + (sum.stopped ? "; stopped: " + sum.stopped + (sum.waiting ? " (" + sum.waiting + " genres wait for the next run)" : "") : ""));
        return sum;
      });
    });
  };

  return { run: run };
}

module.exports = { createGenrePlaylists: createGenrePlaylists, wantedSongs: wantedSongs, plan: plan, descriptionOf: descriptionOf };
