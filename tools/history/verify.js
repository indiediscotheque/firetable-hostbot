// Check every upload the room has ever played or saved against YouTube and
// SoundCloud: is it still there, and what do they say it is? Their answers are
// kept (lookups), so each upload is asked about once (dead ones again after
// --recheck-days), and become observations reconcile can use:
//   yt:topic  "Artist - Topic" channels: YouTube's own music catalog (trusted)
//   sc:meta   SoundCloud's artist / release title / ISRC fields (trusted)
//   yt, sc    the upload's plain title (often junk; only a weak hint)
// YouTube: 50 videos per call, 1 unit of quota each (100,000 uploads = 2,000
// of the 10,000 daily units). SoundCloud: 50 tracks per call.
"use strict";
var store = require("./store");
var fb = require("./firebase");

var DAY = 86400000;

async function verifyUploads(db, env, opts, log) {
  var recheck = (Number(opts.recheckDays) || 90) * DAY;
  var limit = Number(opts.limit) || Infinity;
  var known = new Map();
  db.prepare("SELECT kind, query, result, fetched_at FROM lookups WHERE kind IN ('yt', 'sc')").all().forEach(function(r) {
    known.set(r.kind + ":" + r.query, { result: r.result ? JSON.parse(r.result) : null, at: r.fetched_at });
  });
  var uploads = db.prepare("SELECT DISTINCT type, cid FROM obs WHERE type IN (1, 2) AND cid IS NOT NULL").all();
  var todo = { yt: [], sc: [] };
  uploads.forEach(function(u) {
    var kind = u.type === 1 ? "yt" : "sc";
    var k = known.get(kind + ":" + u.cid);
    if (k && !(k.result && k.result.dead && Date.now() - k.at > recheck)) return;
    if (kind === "yt" && !/^[A-Za-z0-9_-]{11}$/.test(u.cid)) return;
    if (kind === "sc" && !/^\d+$/.test(u.cid)) return;
    todo[kind].push(u.cid);
  });
  var save = db.prepare("INSERT OR REPLACE INTO lookups (kind, query, result, fetched_at) VALUES (?, ?, ?, ?)");
  var counts = { yt: 0, sc: 0, dead: 0, quotaUsed: 0 };

  if (todo.yt.length && !env.YOUTUBE_KEY) log("YouTube: skipped (no YOUTUBE_KEY)");
  else if (todo.yt.length) {
    log("YouTube: checking " + Math.min(todo.yt.length, limit) + " uploads...");
    var maxQuota = Number(opts.maxQuota) || 3000;
    for (var i = 0; i < todo.yt.length && i < limit; i += 50) {
      if (counts.quotaUsed >= maxQuota) {
        log("  stopped at " + maxQuota + " YouTube quota units (the bot needs the rest); the next run carries on");
        break;
      }
      var ids = todo.yt.slice(i, Math.min(i + 50, limit));
      var url = new URL("https://www.googleapis.com/youtube/v3/videos");
      url.searchParams.set("part", "snippet,contentDetails,status");
      url.searchParams.set("id", ids.join(","));
      url.searchParams.set("fields", "items(id,snippet(title,channelTitle,publishedAt),contentDetails(duration),status(privacyStatus,uploadStatus,embeddable))");
      url.searchParams.set("key", env.YOUTUBE_KEY);
      var res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      var j = await res.json().catch(function() { return null; });
      counts.quotaUsed++;
      if (!res.ok || !j || !Array.isArray(j.items)) {
        var msg = j && j.error && j.error.message || "HTTP " + res.status;
        log("  YouTube stopped: " + msg + (/quota/i.test(msg) ? " (the quota resets at midnight Pacific; run again then to carry on)" : ""));
        break;
      }
      var found = new Map(j.items.map(function(it) { return [it.id, it]; }));
      store.tx(db, function() {
        ids.forEach(function(id) {
          var it = found.get(id);
          var st = it && it.status || {};
          var dead = !it || st.privacyStatus === "private" || ["deleted", "rejected", "failed"].indexOf(st.uploadStatus) !== -1;
          var r = dead ? { dead: true } : {
            title: it.snippet.title, channel: it.snippet.channelTitle, published: it.snippet.publishedAt,
            dur: isoSeconds(it.contentDetails && it.contentDetails.duration), embeddable: st.embeddable !== false
          };
          if (dead) counts.dead++;
          save.run("yt", id, JSON.stringify(r), Date.now());
          counts.yt++;
        });
      });
      if ((i / 50) % 40 === 0) log("  " + Math.min(i + 50, todo.yt.length) + "/" + todo.yt.length);
    }
  }

  if (todo.sc.length && !env.SOUNDCLOUD_KEY) log("SoundCloud: skipped (no SOUNDCLOUD_KEY)");
  else if (todo.sc.length) {
    log("SoundCloud: checking " + Math.min(todo.sc.length, limit) + " uploads...");
    for (var s = 0; s < todo.sc.length && s < limit; s += 50) {
      var scIds = todo.sc.slice(s, Math.min(s + 50, limit));
      var scUrl = "https://api-v2.soundcloud.com/tracks?ids=" + scIds.join(",") + "&client_id=" + encodeURIComponent(env.SOUNDCLOUD_KEY);
      var list = null;
      for (var attempt = 0; attempt < 4 && !list; attempt++) {
        try {
          var r2 = await fetch(scUrl, { signal: AbortSignal.timeout(30000) });
          if (r2.status === 429) { await fb.sleep(10000 * (attempt + 1)); continue; }
          if (!r2.ok) throw new Error("HTTP " + r2.status);
          list = await r2.json();
        } catch (e) {
          if (attempt === 3) log("  SoundCloud: " + e.message + "; carry on later");
          await fb.sleep(2000 * (attempt + 1));
        }
      }
      if (!Array.isArray(list)) break;
      var scFound = new Map(list.map(function(t) { return [String(t.id), t]; }));
      store.tx(db, function() {
        scIds.forEach(function(id) {
          var t = scFound.get(id);
          var dead = !t || t.policy === "BLOCK" || t.sharing === "private";
          var pm = t && t.publisher_metadata || {};
          var r = dead ? { dead: true } : {
            title: t.title, user: t.user && t.user.username, artist: pm.artist || null, release: pm.release_title || null,
            isrc: pm.isrc || null, dur: t.duration ? Math.round(t.duration / 1000) : null, preview: t.policy === "SNIP"
          };
          if (dead) counts.dead++;
          save.run("sc", id, JSON.stringify(r), Date.now());
          counts.sc++;
        });
      });
      await fb.sleep(300);
    }
  }

  var written = toObservations(db);
  log("checked " + counts.yt + " YouTube and " + counts.sc + " SoundCloud uploads (" + counts.dead + " gone or private; " + counts.quotaUsed + " YouTube quota units); " + written + " upload tags now in the history");
  return counts;
}

// How YouTube Music writes the artists whose accents the logs disagree on,
// for the ones no upload the room played came from their Topic channel. One
// search per artist (100 quota units): their most played song; the artist is
// the Topic (or official) channel among the results whose name has the same
// letters. Answers are kept, so each artist is looked up once; the most
// played artists go first, within the run's quota.
async function checkArtists(db, env, opts, log) {
  var tags = require("../../lib/tags");
  var wanted = store.getState(db, "ytm_wanted") || [];
  var done = new Set(db.prepare("SELECT query FROM lookups WHERE kind = 'ytm'").all().map(function(r) { return r.query; }));
  var todo = wanted.filter(function(w) { return !done.has(w.key); });
  if (!todo.length) return { checked: 0, quotaUsed: 0 };
  if (!env.YOUTUBE_KEY) { log("YouTube Music: " + todo.length + " artists to check, skipped (no YOUTUBE_KEY)"); return { checked: 0, quotaUsed: 0 }; }
  var budget = Math.max(0, (Number(opts.maxQuota) || 3000) - (Number(opts.quotaUsed) || 0));
  var n = Math.min(todo.length, Math.floor(budget / 100));
  log("YouTube Music: checking " + n + " of " + todo.length + " artists" + (n < todo.length ? " (the rest on the next runs, within the quota)" : "") + "...");
  var save = db.prepare("INSERT OR REPLACE INTO lookups (kind, query, result, fetched_at) VALUES ('ytm', ?, ?, ?)");
  var counts = { checked: 0, quotaUsed: 0, found: 0 };
  for (var i = 0; i < n; i++) {
    var w = todo[i];
    var q = w.name + (w.song ? " " + w.song : "");
    var url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "10");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "items(snippet(channelTitle,title))");
    url.searchParams.set("key", env.YOUTUBE_KEY);
    var res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    var j = await res.json().catch(function() { return null; });
    counts.quotaUsed += 100;
    if (!res.ok || !j || !Array.isArray(j.items)) {
      var msg = j && j.error && j.error.message || "HTTP " + res.status;
      log("  YouTube Music check stopped: " + msg);
      break;
    }
    // the artist's Topic channel (YouTube Music) if it's there, else their own
    // channel ("Artist", "ArtistVEVO", "Artist Official") with the same letters
    var same = tags.squash(w.name);
    var topics = [];
    var own = [];
    j.items.forEach(function(it) {
      var ch = String(it.snippet && it.snippet.channelTitle || "");
      var name = ch.replace(/\s-\sTopic$/, "").replace(/\s*(VEVO|Official)$/i, "").trim();
      if (tags.squash(name) !== same) return;
      var list = /\s-\sTopic$/.test(ch) ? topics : own;
      if (list.indexOf(name) === -1) list.push(name);
    });
    var names = topics.length ? topics : own;
    save.run(w.key, JSON.stringify({ names: names, q: q }), Date.now());
    counts.checked++;
    if (names.length) counts.found++;
  }
  log("  " + counts.checked + " artists checked, " + counts.found + " found on YouTube (" + counts.quotaUsed + " quota units)");
  return counts;
}

// The platforms' answers as observations (rebuilt each time from lookups).
function toObservations(db) {
  return store.tx(db, function() {
    db.exec("DELETE FROM obs WHERE source IN ('yt', 'yt:topic', 'sc', 'sc:meta')");
    var w = store.obsWriter(db);
    db.prepare("SELECT kind, query, result FROM lookups WHERE kind IN ('yt', 'sc') AND result IS NOT NULL").all().forEach(function(row) {
      var r = JSON.parse(row.result);
      if (r.dead) return;
      var type = row.kind === "yt" ? 1 : 2;
      var extra = { dur: r.dur || null };
      if (row.kind === "yt") {
        var topic = /\s-\sTopic$/.test(r.channel || "");
        if (topic) {
          w.add({ source: "yt:topic", ref: row.query, artist: r.channel.replace(/\s-\sTopic$/, ""), title: r.title, type: type, cid: row.query, role: "tag", weight: 2, extra: extra });
        } else {
          var p = String(r.title || "").indexOf(" - ") > 0;
          w.add({ source: "yt", ref: row.query, artist: p ? r.title : r.channel, title: p ? null : r.title, type: type, cid: row.query, role: "tag", weight: 0.3, extra: extra });
        }
      } else {
        if (r.isrc) extra.isrc = r.isrc;
        if (r.artist && (r.release || r.title)) {
          w.add({ source: "sc:meta", ref: row.query, artist: r.artist, title: r.release || r.title, type: type, cid: row.query, role: "tag", weight: 2, extra: extra });
        } else {
          var q = String(r.title || "").indexOf(" - ") > 0;
          w.add({ source: "sc", ref: row.query, artist: q ? r.title : r.user, title: q ? null : r.title, type: type, cid: row.query, role: "tag", weight: 0.3, extra: extra });
        }
      }
    });
    return w.count();
  });
}

function isoSeconds(d) {
  var m = String(d || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0) || null;
}

// Uploads that are gone, with a working upload of the same track to swap in.
function deadUploads(db) {
  var dead = new Map();
  db.prepare("SELECT kind, query FROM lookups WHERE kind IN ('yt','sc') AND result LIKE '%\"dead\":true%'").all().forEach(function(r) {
    dead.set((r.kind === "yt" ? 1 : 2) + r.query, true);
  });
  if (!dead.size) return [];
  var byTrack = new Map();
  db.prepare("SELECT u.type, u.cid, u.track_id, t.artist, t.title, t.plays FROM uploads u JOIN tracks t ON t.id = u.track_id").all().forEach(function(u) {
    var l = byTrack.get(u.track_id);
    if (!l) byTrack.set(u.track_id, l = []);
    l.push(u);
  });
  var out = [];
  byTrack.forEach(function(list) {
    var alive = list.filter(function(u) { return !dead.has(u.type + u.cid); });
    list.forEach(function(u) {
      if (!dead.has(u.type + u.cid)) return;
      out.push({
        upload: url(u.type, u.cid), track: u.artist + " - " + u.title, plays: u.plays,
        replace_with: alive.map(function(a) { return url(a.type, a.cid); }).join(" ")
      });
    });
  });
  return out.sort(function(a, b) { return b.plays - a.plays; });
}
function url(type, cid) { return type == 1 ? "https://youtu.be/" + cid : "https://api.soundcloud.com/tracks/" + cid; }

module.exports = { verifyUploads: verifyUploads, checkArtists: checkArtists, toObservations: toObservations, deadUploads: deadUploads };
