// The room's Discord play log (#last-played), exported with DiscordChatExporter
// as JSON. The room's bot posted every play there from January 2018: an embed
// with the song's title, "by <artist>", its YouTube or SoundCloud link and
// "<dj> is DJing". The text messages before that ("... started playing ...")
// were tests and are skipped, as is everything people wrote there.
//
// The export is big (2.4 GB), so it's read one message at a time and kept as
// a small CSV of its plays (discord-plays.csv: id, at, dj, artist, title,
// link), which is what's imported and kept in the room's database.
//
// The history uses these plays only where it has no other record of every
// play and its DJ: after ADAM's last play and before the bot's own play log
// began (reconcile.js). Like ADAM, they count for plays, dates and DJs, never
// for how a song is written.
"use strict";
var fs = require("fs");
var path = require("path");
var stream = require("stream");
var store = require("./store");
var csv = require("./csv");

/**
 * Calls fn(message) for each object in the export's "messages" array, without
 * reading the whole file into memory. fn returning false stops it.
 * @returns {Promise<number>} messages read
 */
async function eachMessage(file, fn, chunk) {
  var input = fs.createReadStream(file, { highWaterMark: chunk || 1 << 22 });
  var state = 0; // 0: looking for "messages", 1: for its "[", 2: inside it
  var tail = "";
  var depth = 0, inStr = false, esc = false, parts = [], n = 0;
  try {
    for await (var buf of input) {
      var i = 0;
      if (state < 2) {
        var s = tail + buf.toString("latin1");
        var k = state === 0 ? s.indexOf('"messages"') : -1;
        if (state === 0 && k === -1) { tail = s.slice(-12); continue; }
        var b = s.indexOf("[", state === 0 ? k + 10 : 0);
        if (b === -1) { state = 1; tail = ""; continue; }
        i = b + 1 - tail.length;
        state = 2;
        tail = "";
      }
      var start = depth > 0 ? i : -1;
      for (; i < buf.length; i++) {
        var c = buf[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === 92) esc = true;
          else if (c === 34) inStr = false;
          continue;
        }
        if (c === 34) { if (depth > 0) inStr = true; continue; }
        if (c === 123) {
          if (depth === 0) start = i;
          depth++;
        } else if (c === 125) {
          depth--;
          if (depth === 0) {
            parts.push(buf.subarray(start, i + 1));
            var msg = JSON.parse(Buffer.concat(parts).toString("utf8"));
            parts = [];
            start = -1;
            n++;
            if (fn(msg) === false) return n;
          }
        } else if (c === 93 && depth === 0) return n;
      }
      if (depth > 0 && start >= 0) parts.push(Buffer.from(buf.subarray(start)));
    }
  } finally {
    input.destroy();
  }
  return n;
}

/**
 * A play from one message, or null: the bot's "now playing" embed with a DJ.
 * @returns {{id: string, at: number, dj: string, artist: string, title: string, link: string}|null}
 */
function playOf(m) {
  if (!m || !m.author || !m.author.isBot || !Array.isArray(m.embeds) || !m.embeds.length) return null;
  if (/started playing/.test(m.content || "")) return null; // the January 2018 tests
  var e = m.embeds[0] || {};
  var dj = /^(.+?) is DJing$/.exec(String((e.footer && e.footer.text) || "").trim());
  if (!dj) return null;
  var artist = String(e.description || "").replace(/^by\s+/i, "").trim();
  var title = String(e.title || "").trim();
  if (!artist && !title) return null;
  var at = Date.parse(m.timestamp);
  if (!Number.isFinite(at)) return null;
  return { id: String(m.id), at: at, dj: dj[1].trim(), artist: artist, title: title, link: String(e.url || "").trim() };
}

/** "1<id>" for a YouTube link; SoundCloud links are pages, not track ids. */
function uploadOfLink(link) {
  var yt = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(link || "");
  return yt ? { type: 1, cid: yt[1] } : /soundcloud\.com\//.test(link || "") ? { type: 2, cid: null } : { type: null, cid: null };
}

// The room's own logs have every play and DJ up to ADAM's last play (November
// 10, 2022): the plays CSV keeps the ones from November 2022 on (--all: every one)
var KEEP_FROM = Date.UTC(2022, 10, 1);

/**
 * The export's plays as a small CSV.
 * @param {{since?: number|null, log?: Function}} [opts] - since: only plays from then (default November 2022; null: all)
 * @returns {Promise<{messages: number, plays: number, kept: number, from: number|null, to: number|null, djs: number}>}
 */
async function toCsv(jsonFile, csvFile, opts) {
  opts = opts || {};
  var log = opts.log;
  var since = opts.since === undefined ? KEEP_FROM : opts.since;
  var rows = [];
  var all = 0;
  var djs = new Set();
  var from = null, to = null;
  var messages = await eachMessage(jsonFile, function(m) {
    var p = playOf(m);
    if (!p) return;
    all++;
    if (since != null && p.at < since) return;
    rows.push([p.id, new Date(p.at).toISOString(), p.dj, p.artist, p.title, p.link]);
    djs.add(p.dj.toLowerCase());
    if (from == null || p.at < from) from = p.at;
    if (to == null || p.at > to) to = p.at;
    if (log && rows.length % 200000 === 0) log("    " + rows.length + " plays...");
  });
  csv.writeCsv(csvFile, ["id", "at", "dj", "artist", "title", "link"], rows);
  return { messages: messages, plays: all, kept: rows.length, from: from, to: to, djs: djs.size };
}

/** The plays CSV into the history (source "discord"). */
async function importCsv(db, csvFile, log) {
  var w = store.obsWriter(db);
  var n = 0;
  db.exec("BEGIN");
  try {
    await csv.readCsv(csvFile, function(r) {
      var at = Date.parse(r.at);
      if (!Number.isFinite(at) || (!r.artist && !r.title)) return;
      var up = uploadOfLink(r.link);
      var extra = up.type === 2 && r.link ? { sc: r.link } : null;
      w.add({ source: "discord", ref: r.id, artist: r.artist, title: r.title, type: up.type, cid: up.cid, role: "play", at: at, dj: r.dj, weight: 1, extra: extra });
      if (++n % 100000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); if (log) log("    " + n + " plays"); }
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

/**
 * A link to the export (a Google Drive file shared as "anyone with the
 * link") or a local path: the local file, downloaded as it streams in.
 */
async function fetchExport(input, dir) {
  if (!/^https?:\/\//i.test(input)) return { file: input, downloaded: false };
  var drive = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]+)/.exec(input) || /[?&]id=([\w-]+)/.exec(input);
  var url = drive ? "https://drive.usercontent.google.com/download?id=" + drive[1] + "&export=download&confirm=t" : input;
  var res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(3600000) });
  if (!res.ok) throw new Error("couldn't download " + input + " (HTTP " + res.status + ")");
  if (/text\/html/.test(res.headers.get("content-type") || "")) throw new Error("got a web page instead of the export: share the file as \"anyone with the link\" and try again");
  var file = path.join(dir, "discord-export.json");
  await stream.promises.pipeline(stream.Readable.fromWeb(res.body), fs.createWriteStream(file));
  return { file: file, downloaded: true };
}

module.exports = { KEEP_FROM: KEEP_FROM, eachMessage: eachMessage, playOf: playOf, uploadOfLink: uploadOfLink, toCsv: toCsv, importCsv: importCsv, fetchExport: fetchExport };
