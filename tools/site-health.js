#!/usr/bin/env node
// Site health: what visitors' browsers reported in the last days (the site's
// js/telemetry.js, kept two weeks: app.js pruneReports).
//   - errors in the site's own scripts, grouped, with where they are in the
//     source (from the deployed source maps, when the file is still the
//     version that failed)
//   - how fast visits felt: the 75th percentile of each Web Vital, on phones
//     and on computers, rated as Google rates them
// Prints Markdown (and writes it to the GitHub job summary). Exits 1 when the
// site needs a look: an error in a script that's still live, or a vital
// rated poor over enough visits. Run by .github/workflows/site-health.yml;
// by hand: node tools/site-health.js [--days 7]  (needs the bot's .env and
// SITE_URL for the source maps).
"use strict";
var crypto = require("crypto");
var fs = require("fs");

var VITALS = {
  lcp: { label: "Largest paint", unit: "ms", good: 2500, poor: 4000 },
  inp: { label: "Response to input", unit: "ms", good: 200, poor: 500 },
  cls: { label: "Layout shift", unit: "", good: 0.1, poor: 0.25 },
  fcp: { label: "First paint", unit: "ms", good: 1800, poor: 3000 },
  ttfb: { label: "Server response", unit: "ms", good: 800, poor: 1800 }
};
var MIN_VISITS = 20; // fewer visits than this: too few to call a vital poor

// ─── Source maps ────────────────────────────────────────────────────────────
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(str) {
  var out = [], value = 0, shift = 0;
  for (var i = 0; i < str.length; i++) {
    var d = B64.indexOf(str[i]);
    if (d < 0) throw new Error("bad source map character " + str[i]);
    value += (d & 31) << shift;
    if (d & 32) { shift += 5; continue; }
    out.push(value & 1 ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }
  return out;
}

/**
 * Where a position in generated code comes from.
 * @param {{sources: string[], names?: string[], mappings: string}} map
 * @param {number} line - 1-based
 * @param {number} col - 1-based (as browsers report it)
 * @returns {{source: string, line: number, col: number, name: string|null}|null}
 */
function originalPosition(map, line, col) {
  var lines = String(map.mappings || "").split(";");
  var src = 0, oLine = 0, oCol = 0, nameIdx = 0, best = null;
  for (var l = 0; l < lines.length && l < line; l++) {
    var gCol = 0;
    var segs = lines[l] ? lines[l].split(",") : [];
    for (var s = 0; s < segs.length; s++) {
      var f = vlq(segs[s]);
      gCol += f[0];
      if (f.length > 1) { src += f[1]; oLine += f[2]; oCol += f[3]; }
      if (f.length > 4) nameIdx += f[4];
      if (l === line - 1 && f.length > 1 && gCol <= col - 1) {
        best = { source: map.sources[src], line: oLine + 1, col: oCol + 1, name: f.length > 4 && map.names ? map.names[nameIdx] : null };
      }
    }
  }
  return best;
}

/** "js/chat.js?v=abc" → { path: "js/chat.js", v: "abc" } */
function splitFile(f) {
  var m = /^([^?#]*)(?:\?(?:.*&)?v=([0-9a-f]{10}))?/.exec(String(f || ""));
  return { path: m ? m[1] : "", v: m && m[2] ? m[2] : null };
}

/**
 * The live copy of a script and its source map, when it's still the version
 * a report came from. null otherwise (a newer deploy replaced it).
 */
async function liveMap(site, path, v, cache) {
  var key = path + "?" + v;
  if (key in cache) return cache[key];
  cache[key] = null;
  try {
    var res = await fetch(new URL(path, site), { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    var code = await res.text();
    if (crypto.createHash("sha256").update(code).digest("hex").slice(0, 10) !== v) return null;
    var ref = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code);
    if (!ref) return null;
    var mres = await fetch(new URL(ref[1], new URL(path, site)), { signal: AbortSignal.timeout(30000) });
    if (!mres.ok) return null;
    cache[key] = await mres.json();
  } catch (e) {
    cache[key] = null;
  }
  return cache[key];
}

// ─── Summaries ──────────────────────────────────────────────────────────────
function p75(values) {
  if (!values.length) return null;
  var s = values.slice().sort(function(a, b) { return a - b; });
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.75) - 1)];
}

function rate(name, value) {
  var v = VITALS[name];
  if (value == null) return "";
  return value <= v.good ? "good" : value <= v.poor ? "needs work" : "poor";
}

function fmt(name, value) {
  if (value == null) return "–";
  return name === "cls" ? value.toFixed(2) : Math.round(value) + " ms";
}

/**
 * Errors grouped by what and where, most reported first.
 * @param {Object} reports - clientErrors
 */
function groupErrors(reports) {
  var groups = {};
  Object.keys(reports || {}).forEach(function(id) {
    var r = reports[id] || {};
    var file = splitFile(r.f);
    var key = [r.m, file.path, r.l, r.c].join("|");
    var g = groups[key] || (groups[key] = { m: r.m || "", path: file.path, v: file.v, l: r.l || 0, c: r.c || 0, st: r.st || "", count: 0, last: 0, browsers: {}, pages: {} });
    g.count++;
    if ((r.at || 0) > g.last) { g.last = r.at || 0; g.v = file.v; g.st = r.st || g.st; }
    if (r.b) g.browsers[r.b] = (g.browsers[r.b] || 0) + 1;
    if (r.p) g.pages[r.p] = (g.pages[r.p] || 0) + 1;
  });
  return Object.values(groups).sort(function(a, b) { return b.count - a.count || b.last - a.last; });
}

/**
 * The 75th percentile of each vital, for phones, computers and all visits.
 * @param {Object} reports - clientVitals
 */
function vitalsBy(reports) {
  var rows = { phones: [], computers: [], all: [] };
  Object.values(reports || {}).forEach(function(r) {
    if (!r) return;
    rows.all.push(r);
    rows[r.mob ? "phones" : "computers"].push(r);
  });
  var out = {};
  Object.keys(rows).forEach(function(k) {
    var o = { visits: rows[k].length };
    Object.keys(VITALS).forEach(function(n) {
      o[n] = p75(rows[k].map(function(r) { return r[n]; }).filter(function(x) { return typeof x === "number"; }));
    });
    out[k] = o;
  });
  return out;
}

function esc(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim(); }
function top(counts, n) {
  return Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; }).slice(0, n)
    .map(function(k) { return k + " (" + counts[k] + ")"; }).join(", ");
}

/**
 * The report and whether the site needs a look.
 * @param {{errors: Object, vitals: Object, days: number, live: function(group): Promise<{where: string, live: boolean}>}} d
 */
async function report(d) {
  var lines = [];
  var problems = [];
  var groups = groupErrors(d.errors);
  var vit = vitalsBy(d.vitals);
  lines.push("# Site health: the last " + d.days + " days", "");
  lines.push("## Errors in the site's scripts", "");
  if (!groups.length) lines.push("None reported.", "");
  else {
    lines.push("| times | error | where | still live | browsers | pages |", "|---:|---|---|---|---|---|");
    for (var i = 0; i < groups.length && i < 40; i++) {
      var g = groups[i];
      var at = await d.live(g);
      if (at.live) problems.push(g.count + "× " + g.m);
      lines.push("| " + g.count + " | " + esc(g.m).slice(0, 160) + " | " + esc(at.where) + " | " + (at.live ? "**yes**" : "no, since replaced") + " | " +
        esc(top(g.browsers, 3)) + " | " + esc(top(g.pages, 3)) + " |");
    }
    if (groups.length > 40) lines.push("", "…and " + (groups.length - 40) + " more.");
    lines.push("");
  }
  lines.push("## How fast visits felt (75th percentile)", "");
  lines.push("| | visits | " + Object.keys(VITALS).map(function(n) { return VITALS[n].label; }).join(" | ") + " |",
    "|---|---:|" + Object.keys(VITALS).map(function() { return "---"; }).join("|") + "|");
  ["phones", "computers", "all"].forEach(function(k) {
    var o = vit[k];
    lines.push("| " + k + " | " + o.visits + " | " + Object.keys(VITALS).map(function(n) {
      var r = rate(n, o[n]);
      if (r === "poor" && o.visits >= MIN_VISITS && k !== "all" && (n === "lcp" || n === "inp" || n === "cls")) problems.push(VITALS[n].label + " on " + k + ": " + fmt(n, o[n]));
      return fmt(n, o[n]) + (r ? " (" + r + ")" : "");
    }).join(" | ") + " |");
  });
  lines.push("", "Good / poor: largest paint 2.5 s / 4 s, response to input 200 / 500 ms, layout shift 0.1 / 0.25 (Google's Core Web Vitals). " +
    "A vital counts as a problem when it's poor over " + MIN_VISITS + " or more visits.");
  if (problems.length) lines.push("", "**Needs a look:** " + problems.map(esc).join("; "));
  return { markdown: lines.join("\n") + "\n", problems: problems };
}

// ─── Run ────────────────────────────────────────────────────────────────────
async function main() {
  var args = process.argv.slice(2);
  var days = Number(args[args.indexOf("--days") + 1]) || 7;
  try { process.loadEnvFile(); } catch (e) { /* no .env: the environment's own */ }
  var db = require("./history/firebase").client(process.env);
  var since = Date.now() - days * 24 * 60 * 60 * 1000;
  var read = function(path) { return db.get(path, { orderBy: '"at"', startAt: String(since) }).then(function(v) { return v || {}; }); };
  var data = await Promise.all([read("clientErrors"), read("clientVitals")]);
  var site = process.env.SITE_URL ? String(process.env.SITE_URL).replace(/\/*$/, "/") : null;
  var maps = {};
  var out = await report({
    errors: data[0], vitals: data[1], days: days,
    live: async function(g) {
      var where = g.path + ":" + g.l + ":" + g.c;
      if (!site || !g.v || !/^(js|embed)\//.test(g.path)) return { where: where, live: !g.v };
      var map = await liveMap(site, g.path, g.v, maps);
      if (!map) {
        // a different copy is live now: was this one replaced, or is the site's copy unreadable?
        return { where: where, live: false };
      }
      var o = originalPosition(map, g.l, g.c);
      return { where: o ? o.source.replace(/^(\.\.\/)+/, "") + ":" + o.line + (o.name ? " (" + o.name + ")" : "") : where, live: true };
    }
  });
  process.stdout.write(out.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.markdown);
  if (out.problems.length) {
    console.log("::error::The site needs a look: " + out.problems.join("; "));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(function(err) {
    console.log("::error::Site health couldn't run: " + err.message);
    process.exitCode = 1;
  });
}

module.exports = { main: main, originalPosition: originalPosition, splitFile: splitFile, groupErrors: groupErrors, vitalsBy: vitalsBy, p75: p75, report: report, vlq: vlq };
