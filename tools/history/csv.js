// CSV in and out (RFC 4180: quotes, commas and line breaks inside fields).
// Reads files of any size line by line; tabs work too (.tsv).
"use strict";
var fs = require("fs");
var readline = require("readline");

// Calls onRow(objectKeyedByHeader, rowNumber) for every row.
async function readCsv(file, onRow) {
  var delimiter = /\.tsv$/i.test(file) ? "\t" : ",";
  var rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  var header = null;
  var fields = [];
  var field = "";
  var quoted = false;
  var rowNo = 0;
  for await (var line of rl) {
    if (rowNo === 0 && !header && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += ch;
      } else if (ch === '"' && field === "") quoted = true;
      else if (ch === delimiter) { fields.push(field); field = ""; }
      else field += ch;
    }
    if (quoted) { field += "\n"; continue; } // a line break inside a quoted field
    fields.push(field);
    if (!header) {
      if (delimiter === "," && fields.length === 1 && line.indexOf("\t") !== -1) {
        delimiter = "\t";
        fields = line.split("\t");
      }
      header = fields.map(function(h) { return h.trim(); });
    } else if (fields.length > 1 || fields[0] !== "") {
      var row = {};
      for (var j = 0; j < header.length; j++) row[header[j]] = fields[j] == null ? "" : fields[j];
      rowNo++;
      await onRow(row, rowNo);
    }
    fields = [];
    field = "";
  }
  return { header: header || [], rows: rowNo };
}

function cell(v) {
  if (v == null) return "";
  if (typeof v === "number" && !Number.isFinite(v)) return "";
  var s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Write rows (arrays or objects) with a header line. Returns the row count.
function writeCsv(file, columns, rows) {
  var fd = fs.openSync(file, "w");
  var buf = [columns.map(cell).join(",")];
  var n = 0;
  for (var r of rows) {
    var arr = Array.isArray(r) ? r : columns.map(function(c) { return r[c]; });
    buf.push(arr.map(cell).join(","));
    n++;
    if (buf.length >= 5000) { fs.writeSync(fd, buf.join("\n") + "\n"); buf = []; }
  }
  if (buf.length) fs.writeSync(fd, buf.join("\n") + "\n");
  fs.closeSync(fd);
  return n;
}

module.exports = { readCsv: readCsv, writeCsv: writeCsv };
