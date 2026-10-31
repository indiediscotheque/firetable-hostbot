// Song tags: read any "artist - title" the room has ever seen, put it in Rohn
// Standard Notation, and give it matching keys, so every copy, spelling and
// upload of a song can be counted as one. Used by the bot (live) and by the
// history toolkit (tools/history), so both always agree on what "the same
// song" means.
//
//   parse(artist, title) -> { artists, featured, title, versions, display, ... }
//   format(parsed)       -> "Artist - Title feat. X (Y Remix)"
//   trackKey(...)        -> same recording (edits/remasters/radio edits count
//                           as the original; remixes, live, acoustic don't)
//   songKey(...)         -> same song, any version
"use strict";
var crypto = require("crypto");

// ---------------------------------------------------------------- cleaning

var ZERO_WIDTH = /[​-‍⁠﻿­]/g;
var DASHES = /[‐-―−﹘﹣－]/g;
var SINGLE_QUOTES = /[‘’‚‛′´`]/g;
var DOUBLE_QUOTES = /[“”„‟″«»]/g;
var EMOJI = /\p{Extended_Pictographic}️?/gu;
var ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", "#39": "'", "#039": "'" };

// Same text, tidied: one kind of dash, quote and space, no HTML entities,
// emoji or invisible characters. Keeps the casing.
function clean(s) {
  return String(s == null ? "" : s)
    .normalize("NFKC")
    .replace(/&(amp|quot|apos|lt|gt|nbsp|#0?39);/gi, function(m, e) { return ENTITIES[e.toLowerCase()] || m; })
    .replace(ZERO_WIDTH, "")
    .replace(EMOJI, " ")
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Letters and digits only, lower case, no accents: "Beyoncé" == "BEYONCE".
// Scripts without case (Japanese, Korean...) are kept as they are.
function fold(s) {
  return clean(s).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/ø/g, "o").replace(/đ/g, "d").replace(/ł/g, "l");
}
function squash(s) {
  return fold(s).replace(/&/g, "and").replace(/\$/g, "s").replace(/[^\p{L}\p{N}]+/gu, "");
}

// ------------------------------------------------------------ vocabulary

var FEAT = "(?:feat\\.?|ft\\.?|featuring|feat\\b)";
var FEAT_ANYWHERE = new RegExp("\\s+" + FEAT + "\\s+(.+)$", "i");
var FEAT_LEADING = new RegExp("^(?:" + FEAT + "|with|w/)\\s+(.+)$", "i");

// Words that only describe the upload, never the music.
var JUNK_WORDS = new Set(("official officiel oficial offizielles ufficiale video videoclip clip music musik musica " +
  "audio lyric lyrics letra letras paroles hd hq 4k 8k uhd 1080p 720p 480p 60fps visualizer visualiser visual " +
  "mv m v premiere exclusive free download dl out now available new full song track with w and the " +
  "explicit clean uncensored censored high quality sound color coded colour bonus deluxe single ep lp album " +
  "copyright no ncs subtitulado sub subs subtitles english español espanol cc on in a by stream streaming " +
  "animated lyricvideo hifi hi fi remastered").split(" "));

// "Original Mix", "Radio Edit", "Album Version", "2011 Remaster": the same
// recording as the plain title.
var SAME_RECORDING_WORDS = new Set(("original radio extended club album single short long full main clean explicit " +
  "dirty uncensored censored 7 12 7in 12in inch vocal mono stereo remaster remastered digital edit version mix " +
  "cut lp ep official the a").split(" "));

var VERSION_TAIL = /^(.*?)\s*\b(remix|rmx|re-?mix|mix|edit|re-?edit|rework|re-?work|bootleg|boot|flip|vip|dub|version|cover|refix|redux|remake|reinterpretation|interpretation|re-?imagined|reimagining|mashup|blend)\s*$/i;

// The words that tell a version apart. Order matters: "Live Acoustic" is live.
var KIND_TESTS = [
  ["live", /\blive\b|\bunplugged\b|\bin concert\b|\bsession\b/i],
  ["acoustic", /\bacoustic\b|\bstripped\b|\bpiano version\b/i],
  ["instrumental", /\binstrumental\b|\bkaraoke\b/i],
  ["acapella", /\ba ?capp?ella\b/i],
  ["demo", /\bdemo\b/i],
  ["altered", /\bslowed\b|\bsped up\b|\bnightcore\b|\breverb\b|\bchopped\b|\b8d\b/i]
];

// Titles and artists too vague to match two different uploads on.
var WEAK_ARTISTS = new Set(["", "unknown", "unknownartist", "variousartists", "various", "va", "artist", "na", "none", "untitled", "null", "undefined", "anonymous"]);
var WEAK_TITLE = /^(?:|untitled|unknown|intro|outro|interlude|skit|mix|live|demo|test|song|newsong|remix|djmix|mixtape|track|track\d+|untitled\d+|\d{1,2}|audio|video|instrumental|null|undefined|theme|bonustrack|hiddentrack|ep|lp|full ?album|fullalbum)$/;

// ------------------------------------------------------------- parsing

function splitArtists(s) {
  s = clean(s).replace(/^(.+?),\s*the$/i, "The $1"); // "Beatles, The" is one artist
  if (!s) return [];
  var parts = s.split(/\s*(?:,|;|\s&\s|\s\+\s|\s+and\s+|\s+x\s+|\s+vs\.?\s+|\s+versus\s+|\s+with\s+|\s+\/\s+|\s+×\s+|、)\s*/i);
  return parts.map(function(p) { return p.trim(); }).filter(Boolean);
}

// "The X" and "X" are different artists; "X, The" is "The X" written backwards.
function artistKeyOf(name) {
  var f = fold(name).trim();
  var back = f.match(/^(.+?),\s*the$/);
  if (back) f = "the " + back[1];
  var k = squash(f);
  return k || fold(name).replace(/\s+/g, "");
}

// What one bracketed or " - " segment of a title is.
function classify(seg) {
  var s = clean(seg).replace(/^[\s\-:|]+|[\s\-:|]+$/g, "");
  if (!s) return { type: "junk" };
  var m = s.match(FEAT_LEADING);
  if (m) return { type: "feat", names: splitArtists(m[1]) };
  var lower = s.toLowerCase();
  if (/\brelease\b|^out now\b|^prod\.?\b|^produced by\b|premiere|copyright|\bost\b|soundtrack|motion picture|^from (?:the )?["'(]|\bfrom (?:the )?(?:film|movie|series|show|game)\b/.test(lower)) return { type: "junk" };
  if (/\b(?:19|20)\d{2}\b.*\bremaster|\bremaster/.test(lower)) return { type: "version", kind: "", text: s };
  for (var i = 0; i < KIND_TESTS.length; i++) {
    if (KIND_TESTS[i][1].test(s)) return { type: "version", kind: KIND_TESTS[i][0], text: s };
  }
  var v = s.match(VERSION_TAIL);
  if (v) {
    var word = v[2].toLowerCase().replace(/-/g, "");
    var by = v[1].replace(/['"]s$|'s$/i, "").trim();
    var byWords = fold(by).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    var generic = byWords.every(function(w) { return SAME_RECORDING_WORDS.has(w) || /^(?:19|20)\d{2}$/.test(w); });
    if (word === "cover") return { type: "version", kind: "cover", by: by, text: s };
    if (word === "dub" && generic) return { type: "version", kind: "dub", text: s };
    if (generic) return { type: "version", kind: "", text: s };
    if (word === "version" || word === "mix" || word === "edit") {
      // "Kygo Edit", "Spanish Version": someone's version of it
      return { type: "version", kind: "remix", by: by, text: s };
    }
    return { type: "version", kind: "remix", by: by, text: s };
  }
  var words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length && words.every(function(w) { return JUNK_WORDS.has(w) || /^(?:19|20)\d{2}$/.test(w); })) return { type: "junk" };
  return null;
}

var BRACKETS = /[([{【「]([^()[\]{}【】「」]*)[)\]}】」]/g;

/**
 * Read a tag. Either pass artist and title separately, or one "Artist - Title"
 * string as the artist with no title.
 * @returns {{artists: string[], featured: string[], title: string,
 *   versions: Array<{kind: string, by?: string, text: string}>, artist: string,
 *   weak: boolean, suspect: string|null, altTitles: string[]}}
 */
function parse(artist, title) {
  artist = clean(artist);
  title = title == null ? null : clean(title);
  if (title == null || title === "") {
    var sep = artist.indexOf(" - ");
    if (sep > 0) {
      title = artist.slice(sep + 3);
      artist = artist.slice(0, sep);
    } else {
      title = title || "";
    }
  } else if (/^unknown$/i.test(artist) && title.indexOf(" - ") > 0) {
    artist = title.slice(0, title.indexOf(" - "));
    title = title.slice(title.indexOf(" - ") + 3);
  }

  // YouTube channel names: "Artist - Topic", "ArtistVEVO", "Artist Official"
  artist = artist.replace(/\s+-\s+topic$/i, "").replace(/(?:\s*-\s*|\s+)?(?:vevo|official(?: channel)?)$/i, "").trim();

  var featured = [];
  var versions = [];

  // featured artists in the artist field: "A feat. B", "A (ft. B)"
  artist = artist.replace(BRACKETS, function(all, inner) {
    var c = classify(inner);
    if (c && c.type === "feat") { featured.push.apply(featured, c.names); return " "; }
    return all;
  }).replace(/\s+/g, " ").trim();
  var af = artist.match(FEAT_ANYWHERE);
  if (af) {
    featured.push.apply(featured, splitArtists(af[1]));
    artist = artist.slice(0, af.index).trim();
  }

  // everything after " | " or " // " is the uploader talking
  title = title.split(/\s+(?:\||\/\/|‖)\s+/)[0];
  title = title.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ").replace(/\s+prod\.?(?:\s+by)?\s+.+$/i, "");

  // bracketed parts: feat., versions, junk; anything else is part of the title
  var guard = 0;
  var changed = true;
  while (changed && guard++ < 10) {
    changed = false;
    title = title.replace(BRACKETS, function(all, inner) {
      var c = classify(inner);
      if (!c) return "\u0000" + inner + "\u0001";
      changed = true;
      if (c.type === "feat") featured.push.apply(featured, c.names);
      else if (c.type === "version") versions.push(c);
      return " ";
    });
  }
  title = title.replace(/\u0000/g, "(").replace(/\u0001/g, ")");

  // trailing " - Radio Edit", " - Live at KEXP", " - X Remix"
  for (var n = 0; n < 4; n++) {
    var dash = title.lastIndexOf(" - ");
    if (dash <= 0) break;
    var c2 = classify(title.slice(dash + 3));
    if (!c2) break;
    if (c2.type === "feat") featured.push.apply(featured, c2.names);
    else if (c2.type === "version") versions.push(c2);
    title = title.slice(0, dash);
  }

  // bare upload junk at the end: "... Official Video HD"
  for (var j = 0; j < 4; j++) {
    var stripped = title.replace(/\s+(?:\(?\s*)?(?:hd|hq|4k|8k|1080p|720p|official(?:\s+(?:music|lyric|hd))?\s+(?:video|audio|visuali[sz]er)|(?:with\s+)?lyrics|lyric\s+video)\s*$/i, "");
    if (stripped === title || !stripped.trim()) break;
    title = stripped;
  }

  // "Title feat. X" without brackets
  var tf = title.match(FEAT_ANYWHERE);
  if (tf) {
    featured.push.apply(featured, splitArtists(tf[1]));
    title = title.slice(0, tf.index);
  }
  title = title.replace(/\s+/g, " ").replace(/^[\s\-:|~]+|[\s\-:|~]+$/g, "").replace(/\(\s*\)/g, "").trim();

  var artists = splitArtists(artist);
  var artistKeys = artists.map(artistKeyOf);
  featured = dedupe(featured.filter(function(f) { return artistKeys.indexOf(artistKeyOf(f)) === -1; }), artistKeyOf);

  var tk = titleKeyOf(title);
  var weak = WEAK_ARTISTS.has(artistKeys.join("")) || WEAK_TITLE.test(tk) || tk.length < 2 && !/\p{Lo}/u.test(tk);
  var suspect = spreadsheetSuspect(title);
  return {
    artist: artist,
    artists: artists,
    featured: featured,
    title: title,
    versions: versions,
    weak: weak,
    suspect: suspect,
    altTitles: suspect ? spreadsheetAlternatives(title) : []
  };
}

function dedupe(list, keyFn) {
  var seen = new Set();
  return list.filter(function(x) {
    var k = keyFn(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------- spreadsheet damage

// Google Sheets turns titles like "2:00", "1:18" or "3/4" into times, numbers
// and dates. The ADAM export went through Sheets, so flag these.
function spreadsheetSuspect(title) {
  if (/^\d{1,2}:\d{2}(?::\d{2})?\s?[AP]M$/i.test(title)) return "time";
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(title)) return "time";
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(title) || /^\d{4}-\d{2}-\d{2}$/.test(title)) return "date";
  if (/^\d+\.\d+$/.test(title) || /^\d+(?:\.\d+)?E[+-]?\d+$/i.test(title)) return "number";
  if (title === "0") return "number";
  return null;
}
// What the title might have been before Sheets got to it.
function spreadsheetAlternatives(title) {
  var out = [];
  var t = title.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AP]M)?$/i);
  if (t) {
    var h = String(Number(t[1]));
    var ap = (t[4] || "").toLowerCase();
    out.push(h + ":" + t[2]);
    if (t[2] === "00") {
      out.push(h + ap, h + " " + ap, h);
      if (ap === "pm") out.push(String(Number(h) + 12) + ":00");
    }
    if (ap) out.push(h + ":" + t[2] + ap);
    if (t[3] && t[3] === "00") out.push(h + ":" + t[2]); // "1:18:00" was "1:18"
    if (t[3]) out.push(t[2] + ":" + t[3]); // "0:01:18" was "1:18"
  }
  var d = title.match(/^(\d{1,2})\/(\d{1,2})\/\d{2,4}$/);
  if (d) out.push(d[1] + "/" + d[2], d[1] + "-" + d[2]);
  if (/^\d+\.\d+$/.test(title)) out.push(title.replace(".", ":"));
  return dedupe(out, titleKeyOf).filter(function(a) { return titleKeyOf(a) !== titleKeyOf(title); });
}

// ------------------------------------------------------------- keys

function titleKeyOf(title) {
  return squash(clean(title).replace(/\bpt\.?\s*(?=\d|[ivx]+\b)/gi, "part ").replace(/\bno\.\s*(?=\d)/gi, "number "));
}

function versionKeyOf(versions) {
  var keys = versions.filter(function(v) { return v.kind; }).map(function(v) {
    if (v.kind === "remix" || v.kind === "cover") {
      return v.kind + ":" + splitArtists(v.by || "").map(artistKeyOf).sort().join("+");
    }
    return v.kind;
  });
  return dedupe(keys, String).sort().join(",");
}

// Same artists (in any order, "&" or "and") and the same title, ignoring
// featured artists and upload junk. "The X" and "X" are different artists.
function keysOf(p, artistMap) {
  var map = artistMap || null;
  var aks = p.artists.map(function(a) {
    var k = artistKeyOf(a);
    return map && map.get(k) || k;
  });
  var artistSet = dedupe(aks, String).sort().join("+");
  var tk = titleKeyOf(p.title);
  var vk = versionKeyOf(p.versions);
  return {
    artist: artistSet,
    title: tk,
    version: vk,
    song: artistSet + "|" + tk,
    track: artistSet + "|" + tk + "|" + vk
  };
}

function trackKey(artist, title) {
  return keysOf(parse(artist, title)).track;
}
function songKey(artist, title) {
  return keysOf(parse(artist, title)).song;
}

// A short id for a key that the database accepts as a path.
function hash(key) {
  return crypto.createHash("sha1").update(String(key), "utf8").digest("base64url").slice(0, 16);
}

// ---------------------------------------------------------- formatting

// Rohn Standard Notation, the room's guideline (with exceptions people choose
// on purpose, so this is only ever a suggestion; tags are never rewritten to it):
//   Artist - Song Title
//   Artist - Song Title (Remixartist Remix)
//   Artist - Song Title feat. Subartist
//   Artist - Song Title feat. Subartist (Remixartist Remix)
// Upload junk and same-recording notes ("Radio Edit", "2011 Remaster") are
// left out; versions that sound different (remix, live, acoustic) stay.
function format(p) {
  var artist = p.artist || p.artists.join(", ") || "Unknown";
  var out = artist + " - " + (p.title || "Untitled");
  if (p.featured.length) out += " feat. " + joinNames(p.featured);
  p.versions.forEach(function(v) {
    if (v.kind) out += " (" + versionText(v) + ")";
  });
  return out;
}
function versionText(v) {
  return clean(v.text).replace(/^[([]+|[)\]]+$/g, "");
}
function joinNames(names) {
  if (names.length < 2) return names.join("");
  return names.slice(0, -1).join(", ") + " & " + names[names.length - 1];
}
function formatParts(p) {
  var full = format(p);
  var sep = full.indexOf(" - ");
  return { artist: full.slice(0, sep), title: full.slice(sep + 3) };
}

// rich is plain with its accents (or other non-English letters) back:
// "Björk" for "Bjork", "Bjrk" or "Bj?rk"
function accentsRestored(plain, rich) {
  plain = clean(plain);
  rich = clean(rich);
  var count = function(x) { return (x.match(/[^\x00-\x7F]/g) || []).length; };
  if (!rich || count(rich) <= count(plain)) return false;
  if (fold(rich) === fold(plain)) return true;
  var sk = squash(rich.replace(/[^\x00-\x7F]|\?/g, ""));
  return sk.length >= 3 && sk === squash(plain.replace(/\?/g, ""));
}

// ------------------------------------------------------------- tidying
// Two opt-in levels (publish --tidy), for tags no person has fixed:
//   junk: take out what only describes the upload (Official Video, HD,
//         Visualizer, [Label Release], "| uploader text", "- Topic", VEVO,
//         hashtags). Everything else stays exactly as typed.
//   rsn:  also lay the tag out in Rohn Standard Notation: "feat." after the
//         title, versions in parentheses. Nothing is dropped: "Radio Edit"
//         or "2011 Remaster" stay as notes.
function tidy(artist, title, level) {
  var a = clean(artist);
  var t = title == null ? "" : clean(title);
  if (!t && a.indexOf(" - ") > 0) { t = a.slice(a.indexOf(" - ") + 3); a = a.slice(0, a.indexOf(" - ")); }
  if (/^unknown$/i.test(a) && t.indexOf(" - ") > 0) { a = t.slice(0, t.indexOf(" - ")); t = t.slice(t.indexOf(" - ") + 3); }
  a = a.replace(/\s+-\s+topic$/i, "").replace(/(?:\s*-\s*|\s+)?(?:vevo|official(?: channel)?)$/i, "").trim() || a;
  var t0 = t;
  // "| uploader text", "// more": only when what follows describes the upload
  var parts = t.split(/\s+(?:\||\/\/|‖|¦)\s+/);
  while (parts.length > 1 && uploadJunk(parts[parts.length - 1])) parts.pop();
  t = parts.join(" | ").replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ");
  t = t.replace(BRACKETS, function(all, inner) { return uploadJunk(inner) ? " " : all; });
  for (var n = 0; n < 4; n++) {
    var dash = t.lastIndexOf(" - ");
    if (dash <= 0 || !uploadJunk(t.slice(dash + 3))) break;
    t = t.slice(0, dash);
  }
  for (var j = 0; j < 4; j++) {
    var stripped = t.replace(/\s+(?:hd|hq|4k|8k|1080p|720p|official(?:\s+(?:music|lyric|hd))?\s+(?:video|audio|visuali[sz]er)|(?:with\s+)?lyrics|lyric\s+video)\s*$/i, "");
    if (stripped === t || !stripped.trim()) break;
    t = stripped;
  }
  t = t.replace(/\s+/g, " ").replace(/\(\s*\)|\[\s*\]/g, "").replace(/^[\s\-:|~]+|[\s\-:|~]+$/g, "").trim() || t0;
  if (level !== "rsn") return { artist: a, title: t };
  return rsnLayout(a, t);
}

// Words that only describe the upload, never the song: "(Official Music
// Video)", "[HD]", "Free Download", "OUT NOW ON BEATPORT", "Monstercat
// Release", "EDM.com Premiere". Years, "prod." credits, "Bonus Track",
// soundtrack and version notes are about the song and stay.
var UPLOAD_STRONG = new Set(["video", "audio", "visualizer", "visualiser", "lyrics", "lyric", "hd", "hq", "4k", "8k", "1080p", "720p", "download", "videoclip", "clip"]);
var UPLOAD_WEAK = new Set(["official", "officiel", "oficial", "music", "full", "high", "quality", "free", "new", "the", "with"]);
function uploadJunk(seg) {
  var lower = clean(seg).toLowerCase().replace(/^[\s\-:|~]+|[\s\-:|~!.]+$/g, "");
  if (!lower) return true;
  if (/^out now\b/.test(lower) || /\b(?:premiere|release|free download|free dl|records|recordings)$/.test(lower) || /^official$/.test(lower)) return true;
  var words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every(function(w) { return UPLOAD_STRONG.has(w) || UPLOAD_WEAK.has(w); }) &&
    words.some(function(w) { return UPLOAD_STRONG.has(w); });
}

// Rohn Standard Notation, as a layout only: the featured artists go after the
// title ("feat." and the names exactly as typed), and versions go in
// parentheses ("[X Remix]", "- X Remix" -> "(X Remix)"). Nothing is taken out.
var FEAT_WORD = "(?:feat\\.?|ft\\.|featuring)";
function rsnLayout(a, t) {
  var feats = [];
  // in the artist: "Artist feat. Name", "Artist ft Name", "Artist (feat. Name)"
  var fa = a.match(new RegExp("^(.*?\\S)\\s*[(\\[]?\\s*\\b(?:feat\\.?|ft\\.?|featuring)\\s+(.+?)\\s*[)\\]]?$", "i"));
  if (fa) { a = fa[1].trim(); feats.push(fa[2].trim()); }
  // in the title, in brackets: "(feat. Name)", "[ft. Name]"
  t = t.replace(new RegExp("\\s*[(\\[]\\s*" + FEAT_WORD.replace("ft\\.", "ft\\.?") + "\\s+([^)\\]]+?)\\s*[)\\]]", "i"), function(all, names) { feats.push(names.trim()); return ""; });
  // or after the title: "Song feat. Name (X Remix)" ("37,000 ft" is feet, so "ft" needs its dot)
  t = t.replace(new RegExp("(\\D)\\s+" + FEAT_WORD + "\\s+(.+?)(?=\\s*[(\\[]|$)", "i"), function(all, before, names) { feats.push(names.trim()); return before; });
  // "Song - X Remix" -> "Song (X Remix)"
  for (var n = 0; n < 3; n++) {
    var dash = t.lastIndexOf(" - ");
    if (dash <= 0) break;
    var c = classify(t.slice(dash + 3));
    if (!c || c.type !== "version") break;
    t = t.slice(0, dash) + " (" + t.slice(dash + 3).trim() + ")";
  }
  // "[X Remix]" -> "(X Remix)"
  t = t.replace(/\[([^\]]+)\]/g, function(all, inner) {
    var c = classify(inner);
    return c && c.type === "version" ? "(" + inner.trim() + ")" : all;
  });
  t = t.replace(/\s+/g, " ").trim();
  var names = [];
  feats.forEach(function(f) { if (!names.some(function(x) { return fold(x) === fold(f); })) names.push(f); });
  if (names.length) {
    // before the first version or note in parentheses ("(X Remix)", "(1983)",
    // "(Prod. X)"), else at the end
    var at = -1;
    var re = /\s*\(([^)]+)\)/g;
    var m;
    while ((m = re.exec(t))) { if (m.index > 0 && classify(m[1])) { at = m.index; break; } }
    var credit = " feat. " + names.join(" & ");
    t = at === -1 ? t + credit : t.slice(0, at) + credit + t.slice(at);
  }
  return { artist: a, title: t.replace(/\s+/g, " ").trim() };
}

// How much a tag looks like it was written by a person who cared.
function quality(rawArtist, rawTitle) {
  var p = parse(rawArtist, rawTitle);
  var score = 0;
  if (p.weak) score -= 5;
  if (p.suspect) score -= 4;
  var both = String(rawArtist || "") + " " + String(rawTitle || "");
  var letters = both.replace(/[^\p{L}]/gu, "");
  if (letters.length > 3 && letters === letters.toUpperCase() && /\p{Lu}/u.test(letters)) score -= 1;
  if (letters.length > 3 && letters === letters.toLowerCase() && /\p{Ll}/u.test(letters)) score -= 1.5;
  // RSN is the guideline, not the law: following it is only a tie-breaker,
  // and a tag a person chose (a mod's fix) outweighs it (see the callers)
  if (clean(rawArtist) + " - " + clean(rawTitle) === format(p)) score += 0.5;
  if (/official|video|lyrics?|\bhd\b|\bhq\b|vevo|- topic|\||\bprod\b|download|premiere|release\]/i.test(both)) score -= 2;
  if (/[!?]{3,}|\.{4,}|_{2,}/.test(both)) score -= 0.5;
  if (/^unknown$/i.test(clean(rawArtist))) score -= 3;
  return score;
}

// ----------------------------------------------------------- similarity

// 0..1, 1 = same. Titles that differ only by a typo score ~0.9+.
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  var la = a.length;
  var lb = b.length;
  if (Math.abs(la - lb) > Math.max(la, lb) * 0.4) return 0;
  var prev = new Array(lb + 1);
  var cur = new Array(lb + 1);
  var prev2 = new Array(lb + 1);
  for (var j = 0; j <= lb; j++) prev[j] = j;
  for (var i = 1; i <= la; i++) {
    cur[0] = i;
    for (j = 1; j <= lb; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    var t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  return 1 - prev[lb] / Math.max(la, lb);
}

// Two neighbouring letters swapped ("Rian" for "Rain"): a typo, never a
// different song. A changed letter ("Ruin") could be either.
function isTransposition(a, b) {
  if (a.length !== b.length || a.length < 4) return false;
  var i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

// Numbers in a title are never typos: "Part 1" and "Part 2" are different songs.
function sameNumbers(a, b) {
  return (a.match(/\d+/g) || []).join(",") === (b.match(/\d+/g) || []).join(",");
}

module.exports = {
  clean: clean,
  fold: fold,
  squash: squash,
  parse: parse,
  format: format,
  formatParts: formatParts,
  tidy: tidy,
  classify: classify,
  accentsRestored: accentsRestored,
  keysOf: keysOf,
  trackKey: trackKey,
  songKey: songKey,
  artistKeyOf: artistKeyOf,
  titleKeyOf: titleKeyOf,
  splitArtists: splitArtists,
  hash: hash,
  quality: quality,
  similarity: similarity,
  sameNumbers: sameNumbers,
  isTransposition: isTransposition,
  spreadsheetSuspect: spreadsheetSuspect
};
