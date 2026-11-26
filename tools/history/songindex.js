// Every song the room has played, for the site's search: Discover finds a song
// by any word of its artist or title, from the whole history, not only the
// lists a page shows. Written with the library (library.js) as
//
//   discover/lib/songs/<n>   up to CHUNK rows each, most played first:
//                            [artist, title, type, cid, plays]
//   discover/lib/meta        songs (how many) and songsHash (changes only when
//                            a row does)
//
// No visitor reads it from the database. The site's deploy (firetable-user
// tools/plain-pages.mjs) reads it once, and only when songsHash is new, then
// serves it from the web host split by word, so a search downloads one small
// file and costs the database nothing.
"use strict";
var crypto = require("crypto");

var CHUNK = 5000;

/**
 * The rows, each song once: never the same upload twice, nor the same artist
 * and title twice (the most played wins).
 * @param {Map<string, {artist, title, plays}>} tracks - track id -> track
 * @param {function(string): ({type: number, cid: string}|null|undefined)} uploadOf - a playable upload for a track id
 * @returns {Array<Array>} [artist, title, type, cid, plays], most played first
 */
function songRows(tracks, uploadOf) {
  var ids = Array.from(tracks.keys()).sort(function(a, b) { return (tracks.get(b).plays || 0) - (tracks.get(a).plays || 0) || (a < b ? -1 : 1); });
  var seen = new Set();
  var out = [];
  ids.forEach(function(id) {
    var t = tracks.get(id);
    var up = uploadOf(id);
    var a = String(t.artist || "").trim(), title = String(t.title || "").trim();
    if (!up || !up.cid || !title) return;
    var byUpload = up.type + "_" + up.cid;
    var byName = a.toLowerCase() + "|" + title.toLowerCase();
    if (seen.has(byUpload) || seen.has(byName)) return;
    seen.add(byUpload);
    seen.add(byName);
    out.push([a.slice(0, 300), title.slice(0, 300), Number(up.type) || 1, String(up.cid), t.plays || 0]);
  });
  return out;
}

/**
 * The database writes for the index: its chunks, and what meta gets.
 * @param {Array<Array>} rows - from songRows
 * @returns {{updates: Object<string, Array>, meta: {songs: number, songsHash: string}}}
 */
function songUpdates(rows) {
  /** @type {Object<string, Array>} */
  var updates = {};
  for (var i = 0; i * CHUNK < rows.length; i++) updates["discover/lib/songs/" + i] = rows.slice(i * CHUNK, (i + 1) * CHUNK);
  var hash = crypto.createHash("sha1").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
  return { updates: updates, meta: { songs: rows.length, songsHash: hash } };
}

module.exports = { songRows: songRows, songUpdates: songUpdates, CHUNK: CHUNK };
