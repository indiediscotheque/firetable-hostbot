// Spread a mod's tag fix to the rest of the database (tagLog entries).
//
// A fix to one upload is a fix to every upload tagged the same way, and a
// fix to the way an artist is written is how they're written everywhere:
//   copies:  every other upload (and Recent row) whose tags name the same
//            track as the old tags ("POOLSIDE - Harvest Moon (Official
//            Video)", "Poolside - harvest moon") gets the new tags, unless
//            the fix moved the upload to another version ("Kites" -> "Kites
//            (Limousines Remix)") or to another song altogether ("Daft Punk -
//            One More Time" -> "Daft Punk - Digital Love"): then the others
//            were right all along.
//   artist:  when the artist was respelled, not replaced ("POOLSIDE" ->
//            "Poolside", "Beyonce" -> "Beyoncé", "Chvrches" -> "CHVRCHES"),
//            the new spelling goes on every upload, track, song and Recent
//            row that names them: as the artist, one of the artists
//            ("POOLSIDE & Friend"), a featured artist or a remixer.
// plan() works out the writes; app.js reads the data, writes and reports.
var tags = require("./tags");

// tags of "Unknown - Intro" or "Unknown Artist" are too vague to fix twice
var WEAK_ARTIST_KEYS = new Set(["", "unknown", "unknownartist", "variousartists", "various", "va", "artist", "na", "none", "untitled", "null", "undefined", "anonymous", "release"]);
var CLOSE = 0.75; // a respelling, not another name ("Harvest Mon" / "Harvest Moon")

function close(a, b) {
  return a === b || tags.similarity(a, b) >= CLOSE || tags.isTransposition(a, b);
}

// Is the new tag set the old one spelled better, naming the same recording?
function sameRecording(oldP, newP) {
  var o = tags.keysOf(oldP);
  var n = tags.keysOf(newP);
  return tags.sameVersion(o.version, n.version) && close(o.artist, n.artist) && close(o.title, n.title);
}

// Replace each name in a list of names ("A & B, C") whose key is artistKey.
function respellNames(list, artistKey, spelling) {
  var out = list;
  tags.splitArtists(list).forEach(function(name) {
    if (name === spelling || tags.artistKeyOf(name) !== artistKey) return;
    var esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp("(^|[\\s,;&+/(\\[])" + esc + "(?=$|[\\s,;&+/)\\]])", "u"), function(m, pre) { return pre + spelling; });
  });
  return out;
}

// The artist field, and the featured artists and remixers in a title.
function respellArtist(artist, artistKey, spelling) {
  if (typeof artist !== "string" || !artist) return artist;
  if (artist !== spelling && tags.artistKeyOf(artist) === artistKey) return spelling;
  return respellNames(artist, artistKey, spelling);
}
var FEATURING = /(\b(?:feat\.?|ft\.?|featuring)\s+)([^()[\]]+?)(?=\s*(?:[()[\]]|$))/gi;
var REMIXER = /([([])([^()[\]]+?)(\s+(?:re-?mix|rmx|edit|re-?edit|rework|bootleg|flip|vip|dub|refix|version|cover|mix)\s*[)\]])/gi;
function respellTitle(title, artistKey, spelling) {
  if (typeof title !== "string" || !title) return title;
  return title
    .replace(FEATURING, function(m, lead, names) { return lead + respellNames(names, artistKey, spelling); })
    .replace(REMIXER, function(m, open, names, tail) {
      var by = names.replace(/['’]s$/i, "");
      var fixed = respellNames(by, artistKey, spelling);
      return fixed === by ? m : open + fixed + names.slice(by.length) + tail;
    });
}

/**
 * The writes that spread one fix.
 * @param {{k: string, a: string, t: string, fa?: string, ft?: string}} e - the tagLog entry
 * @param {{tracks?: Object, songs?: Object, works?: Object, history?: Object}} data
 *   globalTracks, globalSongs, globalWorks and songHistory as they are
 * @param {{isPlaceholder?: Function}} [opts]
 * @returns {{updates: Object, copies: string[], artistFrom: string|null, artistCount: number, renamed: Object}|null}
 *   updates: database paths -> values; copies: the other uploads given the
 *   new tags; artistCount: the songs (uploads and tracks) respelled;
 *   renamed: upload key -> its new tags. null: nothing to spread.
 */
function plan(e, data, opts) {
  opts = opts || {};
  var isPlaceholder = opts.isPlaceholder || function() { return false; };
  if (!e || typeof e.a !== "string" || typeof e.t !== "string" || typeof e.fa !== "string" || typeof e.ft !== "string") return null;
  if (e.a === e.fa && e.t === e.ft) return null;
  data = data || {};
  var oldP = tags.parse(e.fa, e.ft);
  var newP = tags.parse(e.a, e.t);
  var vague = function(p, a, t) { return p.weak || isPlaceholder(a, t); };
  var oldTrack = tags.keysOf(oldP).track;
  var copyAll = !vague(oldP, e.fa, e.ft) && !vague(newP, e.a, e.t) && sameRecording(oldP, newP);

  var artistKey = tags.artistKeyOf(e.a);
  var artistAll = e.fa.trim() !== e.a.trim() && !WEAK_ARTIST_KEYS.has(artistKey) && tags.artistKeyOf(e.fa) === artistKey;

  var updates = {};
  var copies = [];
  var renamed = {};
  var artistCount = 0;
  var keyOf = function(r) { return tags.trackKey(r.artist, r.title || ""); };

  // one record (an upload, a track, a song, a Recent row): its new tags, if any
  var fix = function(r, isCopy) {
    if (!r || typeof r.artist !== "string" || !r.artist) return null;
    var title = typeof r.title === "string" ? r.title : "";
    if (isCopy && copyAll && keyOf(r) === oldTrack) {
      return r.artist === e.a && title === e.t ? null : { artist: e.a, title: e.t, copy: true };
    }
    if (!artistAll) return null;
    var artist = respellArtist(r.artist, artistKey, e.a);
    var t2 = respellTitle(title, artistKey, e.a);
    return artist === r.artist && t2 === title ? null : { artist: artist, title: t2 };
  };
  var each = function(node, path, isCopy, count) {
    Object.keys(node || {}).forEach(function(id) {
      if (path === "globalTracks/" && id === e.k) return; // the fix itself
      var f = fix(node[id], isCopy);
      if (!f) return;
      if (f.artist !== node[id].artist) updates[path + id + "/artist"] = f.artist;
      if (f.title !== (node[id].title || "")) updates[path + id + "/title"] = f.title;
      if (path === "globalTracks/") {
        renamed[id] = { artist: f.artist, title: f.title };
        if (f.copy) copies.push(id);
      }
      if (count && !f.copy) artistCount++;
    });
  };
  each(data.tracks, "globalTracks/", true, true);
  each(data.history, "songHistory/", true, false);
  // the play history's tracks and songs are named once each: their copies are
  // the upload's own track, which the fix renames itself (learnSpelling)
  each(data.songs, "globalSongs/", false, false);
  each(data.works, "globalWorks/", false, false);
  if (!Object.keys(updates).length) return null;
  return { updates: updates, copies: copies, artistFrom: artistAll ? e.fa.trim() : null, artistCount: artistCount, renamed: renamed };
}

// What the mod is told: "Also fixed 2 other copies, and wrote POOLSIDE as Poolside on 41 more songs."
function summary(result, e) {
  if (!result) return "";
  var parts = [];
  var n = result.copies.length;
  if (n) parts.push("fixed " + n + " other " + (n === 1 ? "copy" : "copies") + " of \"" + e.fa + " - " + e.ft + "\"");
  if (result.artistFrom && result.artistCount) {
    parts.push("wrote " + result.artistFrom + " as " + e.a + " on " + result.artistCount + " more " + (result.artistCount === 1 ? "song" : "songs"));
  }
  if (!parts.length) return "";
  return "Tags: also " + parts.join(", and ") + ".";
}

module.exports = { plan: plan, summary: summary, respellArtist: respellArtist, respellTitle: respellTitle, sameRecording: sameRecording };
