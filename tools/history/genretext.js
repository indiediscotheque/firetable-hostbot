// The genre files the library reads, each from tools/history/ with a copy in
// history-data/ (opts.dir) winning or adding: the sound map's axis
// (genre-axis.csv), a line about each genre (genre-about.csv) and a few
// sentences about each (genre-stories.md). Used by library.js.
"use strict";
var fs = require("fs");
var path = require("path");

/** The sound map's across axis, from genre-axis.csv (0 band-made .. 1 machine-made). */
function readAxis(dir) {
  var out = {};
  [path.join(__dirname, "genre-axis.csv"), dir ? path.join(dir, "genre-axis.csv") : null].forEach(function(f) {
    if (!f || !fs.existsSync(f)) return;
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach(function(line) {
      if (!line.trim() || /^#/.test(line) || /^genre,/.test(line)) return;
      var i = line.lastIndexOf(",");
      var v = Number(line.slice(i + 1));
      if (i > 0 && isFinite(v)) out[line.slice(0, i).trim()] = Math.max(0, Math.min(1, v));
    });
  });
  return out;
}

/**
 * A few sentences about each genre, from genre-stories.md (a copy in
 * history-data/ wins): "## Genre name", then its paragraphs, a blank line
 * between them. Up to three paragraphs of 700 characters each.
 * @returns {Object<string, string[]>} genre name -> paragraphs
 */
function readStories(dir) {
  var f = [dir ? path.join(dir, "genre-stories.md") : null, path.join(__dirname, "genre-stories.md")].filter(function(x) { return x && fs.existsSync(x); })[0];
  /** @type {Object<string, string[]>} */
  var out = {};
  if (!f) return out;
  var name = null;
  fs.readFileSync(f, "utf8").split(/\r?\n\s*\r?\n/).forEach(function(block) {
    block = block.trim();
    var h = /^##\s+(.+)$/.exec(block.split(/\r?\n/)[0]);
    if (h) { name = h[1].trim(); out[name] = []; block = block.split(/\r?\n/).slice(1).join(" ").trim(); }
    if (!name || !block || /^#/.test(block)) return;
    if (out[name].length < 3) out[name].push(block.replace(/\s+/g, " ").slice(0, 700));
  });
  Object.keys(out).forEach(function(k) { if (!out[k].length) delete out[k]; });
  return out;
}

/** One line about each genre, from genre-about.csv (a copy in history-data/ wins). */
function readAbout(dir) {
  var out = {};
  [path.join(__dirname, "genre-about.csv"), dir ? path.join(dir, "genre-about.csv") : null].forEach(function(f) {
    if (!f || !fs.existsSync(f)) return;
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach(function(line) {
      if (!line.trim() || /^#/.test(line) || /^genre,/.test(line)) return;
      var m = /^([^,]+),\s*"?(.*?)"?\s*$/.exec(line);
      if (m && m[2]) out[m[1].trim()] = m[2].replace(/""/g, '"').slice(0, 200);
    });
  });
  return out;
}

module.exports = { readAxis: readAxis, readAbout: readAbout, readStories: readStories };
