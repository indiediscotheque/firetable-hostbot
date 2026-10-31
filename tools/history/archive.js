// What the history can't rebuild from the room's database or Last.fm is kept
// in the room's database itself (only the bot can read it), so the history
// can be rebuilt from scratch anywhere, e.g. in a GitHub Action whose cache
// was cleared:
//   historyArchive/files/<name>     an imported file (the ADAM CSVs), gzipped
//                                   in pieces under historyArchive/chunks/<name>
//   historyDecisions/<id>           every merge/separate answer (chat or review.csv)
"use strict";
var fs = require("fs");
var os = require("os");
var path = require("path");
var zlib = require("zlib");
var store = require("./store");
var tags = require("../../lib/tags");

var CHUNK = 4 * 1024 * 1024; // the database keeps strings up to 10 MB

// A local file, or a link to one. Google Sheets links become that tab's CSV
// (the sheet must be shared as "anyone with the link").
async function fetchInput(input, dir) {
  if (!/^https?:\/\//i.test(input)) return { file: input, name: path.basename(input) };
  var url = input;
  var sheet = input.match(/docs\.google\.com\/spreadsheets\/d\/([^/]+)/);
  if (sheet) {
    var gid = (input.match(/[#&?]gid=(\d+)/) || [])[1];
    url = "https://docs.google.com/spreadsheets/d/" + sheet[1] + "/export?format=csv" + (gid ? "&gid=" + gid : "");
  }
  var drive = input.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (drive) url = "https://drive.google.com/uc?export=download&id=" + drive[1];
  var res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300000) });
  var type = res.headers.get("content-type") || "";
  if (!res.ok) throw new Error("couldn't download " + input + " (HTTP " + res.status + ")");
  if (/text\/html/.test(type)) throw new Error("got a web page instead of a CSV: share the sheet or file as \"anyone with the link\" and try again");
  var buf = Buffer.from(await res.arrayBuffer());
  var name = (sheet ? "sheet-" + sheet[1].slice(0, 8) + (gid ? "-" + gid : "") : path.basename(new URL(url).pathname) || "download") ;
  if (!/\.(csv|tsv)$/i.test(name)) name += ".csv";
  var file = path.join(dir || os.tmpdir(), "download-" + name);
  fs.writeFileSync(file, buf);
  return { file: file, name: name };
}

function safeName(name) {
  return String(name).replace(/[.#$[\]/]/g, "_").slice(0, 120);
}

// Save a file in the room's database (gzipped, in pieces).
async function saveFile(client, name, file, kind) {
  var gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 }).toString("base64");
  var key = safeName(name);
  var updates = {};
  var n = Math.ceil(gz.length / CHUNK) || 1;
  updates["historyArchive/chunks/" + key] = null;
  await client.update(updates);
  for (var i = 0; i < n; i++) {
    var piece = {};
    piece["historyArchive/chunks/" + key + "/" + i] = gz.slice(i * CHUNK, (i + 1) * CHUNK);
    await client.update(piece);
  }
  var meta = {};
  meta["historyArchive/files/" + key] = { name: name, kind: kind || null, chunks: n, bytes: fs.statSync(file).size, at: { ".sv": "timestamp" } };
  await client.update(meta);
  var at = await client.get("historyArchive/files/" + key + "/at");
  return { key: key, chunks: n, stateKey: "archive:" + key + ":" + at };
}

// Every archived file this history hasn't imported yet: calls
// importFn(localFile, kind) for each, and remembers it was done.
async function restoreFiles(db, client, dir, importFn, log) {
  var files = (await client.get("historyArchive/files")) || {};
  var done = 0;
  for (var key of Object.keys(files)) {
    var meta = files[key];
    var stateKey = "archive:" + key + ":" + meta.at;
    if (store.getState(db, stateKey)) continue;
    var parts = [];
    for (var i = 0; i < meta.chunks; i++) parts.push((await client.get("historyArchive/chunks/" + key + "/" + i)) || "");
    var file = path.join(dir, "archived-" + key);
    fs.writeFileSync(file, zlib.gunzipSync(Buffer.from(parts.join(""), "base64")));
    log("  restoring " + meta.name + " from the room's database");
    await importFn(file, meta.kind || undefined);
    store.setState(db, stateKey, true);
    fs.unlinkSync(file);
    done++;
  }
  return done;
}

// Answers to review questions, kept in the room's database too.
function decisionUpdates(db) {
  var updates = {};
  db.prepare("SELECT a, b, decision, note, decided_at FROM decisions").all().forEach(function(d) {
    updates["historyDecisions/" + tags.hash(d.a + "\u0002" + d.b)] = { a: d.a, b: d.b, decision: d.decision, note: d.note ? String(d.note).slice(0, 300) : null, at: d.decided_at || null };
  });
  return updates;
}
function loadDecisions(db, node) {
  var ins = db.prepare("INSERT INTO decisions (a, b, decision, note, decided_at) VALUES (?,?,?,?,?) ON CONFLICT(a, b) DO NOTHING");
  var n = 0;
  Object.keys(node || {}).forEach(function(k) {
    var d = node[k];
    if (!d || !d.a || !d.b || (d.decision !== "merge" && d.decision !== "separate")) return;
    n += Number(ins.run(d.a, d.b, d.decision, d.note || null, d.at || null).changes);
  });
  return n;
}

module.exports = { fetchInput: fetchInput, saveFile: saveFile, restoreFiles: restoreFiles, decisionUpdates: decisionUpdates, loadDecisions: loadDecisions };
