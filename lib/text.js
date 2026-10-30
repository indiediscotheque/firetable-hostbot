// Small text helpers for app.js, kept here so they can be unit-tested
// (test/unit.test.mjs) without starting the bot.
"use strict";
var crypto = require("crypto");

// "Artist - Title" split on the FIRST " - " only, so "Artist - Song - Live"
// keeps "Song - Live" as its title. No separator: [the whole name, undefined].
function splitTags(name) {
  name = String(name == null ? "" : name);
  var sep = name.indexOf(" - ");
  return sep === -1 ? [name, undefined] : [name.slice(0, sep), name.slice(sep + 3)];
}

// The database rules refuse chat messages over 240 characters, so longer ones
// (a long theme, a !fixtags echo) are shortened instead of lost.
var CHAT_MAX_LENGTH = 240;
function fitChat(txt) {
  txt = String(txt == null ? "" : txt);
  if (txt.length <= CHAT_MAX_LENGTH) return txt;
  var cut = txt.slice(0, CHAT_MAX_LENGTH - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // don't split an emoji
  return cut + "…";
}

// Last.fm signs the UTF-8 bytes of each value, so non-English artists and
// titles ("Björk", "Sigur Rós") need a real UTF-8 MD5.
function md5(str) {
  return crypto.createHash("md5").update(String(str), "utf8").digest("hex");
}

module.exports = { splitTags: splitTags, fitChat: fitChat, md5: md5, CHAT_MAX_LENGTH: CHAT_MAX_LENGTH };
