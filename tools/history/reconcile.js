// Reconcile: turn every observation from every source into one history.
//
//  1. Every distinct "artist - title" ever seen becomes a spelling.
//  2. Spellings are joined into tracks (one recording, any upload/spelling):
//       - same upload (YouTube/SoundCloud id) = same track, unless the tags
//         disagree completely (then it goes to review)
//       - same artist(s) + title + version after cleanup (lib/tags.js)
//       - artist aliases: ADAM artist ids, Last.fm corrections and ids,
//         accents stripped for the old Last.fm bug, your artist-aliases.csv
//       - "A feat. B" = "A & B" = "A" when the title matches
//       - titles Google Sheets turned into times/numbers
//       - small typos (auto when very close, review when unsure)
//       - your answers in review.csv always win
//  3. Tracks are grouped into songs (all versions: remixes, live, ...).
//  4. Every play, first-play and last-play stamp is put on its track; stamps
//     from different sources within a few minutes are one play. ADAM's clock
//     is lined up with Last.fm's automatically.
//  5. Counts, true first plays, DJs, and the best spelling for each track
//     (a person's fix first, accents restored where any source had them).
"use strict";
var fs = require("fs");
var path = require("path");
var tags = require("../../lib/tags");
var store = require("./store");
var csv = require("./csv");

var MIN = 60000;

// ------------------------------------------------------------ union-find

function UnionFind(n) {
  this.p = new Int32Array(n);
  this.r = new Uint8Array(n);
  for (var i = 0; i < n; i++) this.p[i] = i;
}
UnionFind.prototype.find = function(x) {
  var p = this.p;
  while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
  return x;
};
UnionFind.prototype.union = function(a, b) {
  a = this.find(a); b = this.find(b);
  if (a === b) return false;
  if (this.r[a] < this.r[b]) { var t = a; a = b; b = t; }
  this.p[b] = a;
  if (this.r[a] === this.r[b]) this.r[a]++;
  return true;
};

// Union-find over strings (artist keys)
function KeyUnion() { this.parent = new Map(); }
KeyUnion.prototype.find = function(k) {
  var p = this.parent.get(k);
  if (p === undefined) return k;
  var root = this.find(p);
  if (root !== p) this.parent.set(k, root);
  return root;
};
KeyUnion.prototype.union = function(a, b) {
  a = this.find(a); b = this.find(b);
  if (a === b) return false;
  if (a < b) this.parent.set(b, a); else this.parent.set(a, b);
  return true;
};

// --------------------------------------------------------------- helpers

var NON_ASCII_LETTER = /[^\x00-\x7F]/;
function nonAsciiCount(s) { return (String(s).match(/[^\x00-\x7F]/g) || []).length; }
// What a name looks like after the old bug: non-English letters dropped or "?"
function skeleton(s) { return tags.squash(String(s).replace(/[^\x00-\x7F]|\?/g, "")); }
function usableSkeleton(raw, sk) {
  var letters = tags.squash(raw).length;
  return sk.length >= 3 && sk.length >= letters * 0.6;
}

// Times with no zone (ADAM) -> UTC, in a named zone or a fixed offset (hours)
function zoneOffsetMs(ms, zone) {
  if (typeof zone === "number") return zone * 3600000;
  var name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date(ms))
    .find(function(p) { return p.type === "timeZoneName"; }).value;
  var m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600000 + Number(m[3]) * 60000) : 0;
}
function naiveToUtc(ms, zone) {
  if (zone === 0) return ms;
  var guess = ms - zoneOffsetMs(ms, zone);
  return ms - zoneOffsetMs(guess, zone);
}
// The other way round: a UTC time that was read as local time in `zone`
// (ADAM's dates as moved into globalTracks, read as US Central time)
function shiftedToUtc(ms, zone) {
  return zone === 0 ? ms : ms + zoneOffsetMs(ms, zone);
}
// naive_tz: 0 exact, 1 local time with no zone, 2 UTC read as local time
function toUtc(ms, kind, zones) {
  return kind === 2 ? shiftedToUtc(ms, zones[2]) : kind ? naiveToUtc(ms, zones[1]) : ms;
}
var ZONES = ["UTC", "America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin"];
for (var off = -12; off <= 14; off++) if (off) ZONES.push(off);

var SOURCE_DJ_RANK = ["fb:playLog", "fb:songHistory", "fb:newMusic", "adam", "fb:globalTracks"];
function djRank(src) {
  var i = SOURCE_DJ_RANK.indexOf(src);
  return i === -1 ? 99 : i;
}
function isLastfm(src) { return src.slice(0, 7) === "lastfm:"; }

// A list file kept in the repo (tools/history/, so the GitHub Action has it
// too) and, after it, the one in the data folder, which wins where they differ
function listFiles(dir, name) {
  var here = path.join(__dirname, name);
  var there = path.join(dir, name);
  return path.resolve(here) === path.resolve(there) ? [here] : [here, there];
}

function readAliasCsv(file) {
  var pairs = [];
  if (!fs.existsSync(file)) return pairs;
  var lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach(function(line, i) {
    if (!line.trim() || /^#/.test(line)) return;
    var cells = line.split(",").map(function(c) { return c.trim().replace(/^"|"$/g, ""); });
    if (i === 0 && /alias|name/i.test(cells[0]) && /canon|real|is/i.test(cells[1] || "")) return;
    if (cells[0] && cells[1]) pairs.push([cells[0], cells[1]]);
  });
  return pairs;
}

// ------------------------------------------------------------- reconcile

/**
 * @param {DatabaseSync} db
 * @param {{dir: string, window?: number, adamTz?: string|number, log: Function}} opts
 */
function reconcile(db, opts) {
  var log = opts.log || function() {};
  var windowMs = (opts.window || 10) * MIN;
  var started = Date.now();

  // --------------------------------------------------------------- load
  log("reading observations...");
  var spellings = [];          // distinct (artist, title)
  var spellingIndex = new Map();
  var obsList = [];            // compact: [spelling, role, at, naive, srcIdx, dj, type+cid|null, weight]
  var sourceNames = [];
  var sourceIdx = new Map();
  var adamTags = new Map();    // adam track id -> [artist, title]
  var adamArtist = new Map();  // adam artist id -> Set(artist display)
  var mbidArtists = new Map(); // Last.fm artist mbid -> Set(artist display)
  var uploadCurrent = new Map(); // "1abc" -> {artist, title} saved in globalTracks
  var isrcUploads = new Map();   // ISRC (SoundCloud) -> Set(upload)

  var ytmNames = new Map(); // artist key -> Map(name on YouTube Music -> uploads)
  function noteYtm(name, n) {
    var k = tags.artistKeyOf(name);
    if (!ytmNames.has(k)) ytmNames.set(k, new Map());
    ytmNames.get(k).set(name, (ytmNames.get(k).get(name) || 0) + n);
  }
  // and the ones found by searching (check-artists)
  db.prepare("SELECT query, result FROM lookups WHERE kind = 'ytm' AND result IS NOT NULL").all().forEach(function(r) {
    (JSON.parse(r.result).names || []).forEach(function(n) { noteYtm(n, 1); });
  });
  var ytmChecked = new Set(db.prepare("SELECT query FROM lookups WHERE kind = 'ytm'").all().map(function(r) { return r.query; }));

  var rows = db.prepare("SELECT source, artist, title, type, cid, role, at, naive_tz, dj, weight, extra FROM obs ORDER BY id").iterate();
  var pendingAdamPlays = [];
  for (var row of rows) {
    var extra = row.extra ? JSON.parse(row.extra) : null;
    if (row.source === "adam" && extra && extra.adam && row.role === "tag" && row.artist) {
      adamTags.set(String(extra.adam), [row.artist, row.title]);
      if (extra.adam_artist) {
        if (!adamArtist.has(extra.adam_artist)) adamArtist.set(extra.adam_artist, new Set());
        adamArtist.get(extra.adam_artist).add(row.artist);
      }
    }
    // YouTube Music's own artist names: the Topic channels of uploads the room played
    if (row.source === "yt:topic" && row.artist) noteYtm(row.artist, 1);
    if (extra && extra.amb && row.artist) {
      if (!mbidArtists.has(extra.amb)) mbidArtists.set(extra.amb, new Set());
      mbidArtists.get(extra.amb).add(row.artist);
    }
    var up = row.type && row.cid ? row.type + "" + row.cid : null;
    if (row.source === "fb:globalTracks" && row.role === "tag" && up) {
      uploadCurrent.set(up, { artist: row.artist || "", title: row.title || "" });
    }
    if (extra && extra.isrc && up) {
      if (!isrcUploads.has(extra.isrc)) isrcUploads.set(extra.isrc, new Set());
      isrcUploads.get(extra.isrc).add(up);
    }
    if (!row.artist && !row.title) {
      if (extra && extra.adam) pendingAdamPlays.push([row, up]);
      continue;
    }
    addObs(row, up);
  }
  pendingAdamPlays.forEach(function(p) {
    var t = adamTags.get(String(JSON.parse(p[0].extra).adam));
    if (!t) return;
    p[0].artist = t[0]; p[0].title = t[1];
    addObs(p[0], p[1]);
  });

  function addObs(r, up) {
    var key = (r.artist || "") + "\u0001" + (r.title || "");
    var si = spellingIndex.get(key);
    if (si === undefined) {
      si = spellings.length;
      spellingIndex.set(key, si);
      spellings.push({ artist: tags.clean(r.artist), title: tags.clean(r.title), seen: 0, weight: 0, maxWeight: 0, plays: 0, scrobbles: 0, sources: new Set(), last: 0 });
    }
    var sp = spellings[si];
    sp.seen++;
    sp.weight += r.weight;
    if (r.weight > sp.maxWeight) sp.maxWeight = r.weight;
    sp.sources.add(r.source);
    if (r.at && r.at > sp.last) sp.last = r.at;
    if (r.role === "play") { sp.plays++; if (isLastfm(r.source)) sp.scrobbles++; }
    var s = sourceIdx.get(r.source);
    if (s === undefined) { s = sourceNames.length; sourceIdx.set(r.source, s); sourceNames.push(r.source); }
    obsList.push([si, r.role, r.at, r.naive_tz, s, r.dj, up, r.weight]);
  }
  log("  " + obsList.length + " observations, " + spellings.length + " spellings");

  // -------------------------------------------------------- artist aliases
  log("joining artist spellings...");
  var accentMin = opts.accentMin == null ? 2 : Number(opts.accentMin);
  var accents = accentBook(accentMin);
  var artistUnion = new KeyUnion();
  var artistSeen = new Map(); // key -> count
  var artistDisplay = new Map(); // key -> Map(display -> count)
  spellings.forEach(function(sp) {
    sp.parsed = tags.parse(sp.artist, sp.title);
    sp.parsed.artists.forEach(function(a) {
      var k = tags.artistKeyOf(a);
      artistSeen.set(k, (artistSeen.get(k) || 0) + sp.seen);
      if (!artistDisplay.has(k)) artistDisplay.set(k, new Map());
      var d = artistDisplay.get(k);
      // a YouTube channel name ("ArtistVEVO", "Artist - Topic") isn't how the room writes the artist
      var channel = /vevo$|\s-\stopic$/i.test(sp.artist) || onlyFrom(sp, WEAK_PLATFORM);
      d.set(a, (d.get(a) || 0) + (channel ? 0.1 : sp.seen + sp.maxWeight * 3));
      // an upload's own YouTube/SoundCloud data is one log, and not a trusted one,
      // for every song by an artist: it can be another artist with the same
      // letters (SoundCloud's "Márina" is not Marina)
      var uploadOnly = onlyFrom(sp, ALL_PLATFORM);
      if (!channel) accents.note("artist", k, a, uploadOnly ? 1 : sp.seen, trusted(sp) && !uploadOnly);
    });
  });
  var aliasReasons = [];
  function aliasPair(a, b, reason) {
    var la = tags.splitArtists(tags.parse(a, "x").artist);
    var lb = tags.splitArtists(tags.parse(b, "x").artist);
    if (la.length !== 1 || lb.length !== 1) return;
    var ka = tags.artistKeyOf(la[0]);
    var kb = tags.artistKeyOf(lb[0]);
    if (!ka || !kb || ka === kb) return;
    if (artistUnion.union(ka, kb)) aliasReasons.push([ka, kb, reason]);
  }
  adamArtist.forEach(function(set) { var l = Array.from(set); for (var i = 1; i < l.length; i++) aliasPair(l[0], l[i], "adam-artist-id"); });
  mbidArtists.forEach(function(set) { var l = Array.from(set); for (var i = 1; i < l.length && i < 12; i++) aliasPair(l[0], l[i], "lastfm-artist-id"); });
  db.prepare("SELECT query, result FROM lookups WHERE kind = 'artist' AND result IS NOT NULL").all().forEach(function(r) {
    var res = JSON.parse(r.result);
    aliasPair(r.query, res.name, "lastfm-correction");
    // Last.fm's own spelling is a source of accents too
    var k = tags.artistKeyOf(res.name);
    accents.note("artist", k, res.name, 1, true);
    if (!artistDisplay.has(k)) artistDisplay.set(k, new Map());
    artistDisplay.get(k).set(res.name, (artistDisplay.get(k).get(res.name) || 0) + 1);
    artistSeen.set(k, (artistSeen.get(k) || 0));
  });
  listFiles(opts.dir, "artist-aliases.csv").forEach(function(f) {
    readAliasCsv(f).forEach(function(p) { aliasPair(p[0], p[1], "artist-aliases.csv"); });
  });
  // accents dropped or turned into "?" by the old Last.fm bug: "Bjrk" = "Björk"
  var skeletonToKey = new Map();
  artistDisplay.forEach(function(displays, k) {
    displays.forEach(function(n, name) {
      if (!NON_ASCII_LETTER.test(name)) return;
      var sk = skeleton(name);
      if (usableSkeleton(name, sk) && sk !== k) skeletonToKey.set(sk, k);
    });
  });
  artistDisplay.forEach(function(displays, k) {
    var target = skeletonToKey.get(k);
    if (target && artistUnion.union(k, target)) aliasReasons.push([k, target, "accents"]);
  });
  // each group of artist keys is named by its most-seen key
  var groups = new Map();
  artistSeen.forEach(function(n, k) {
    var root = artistUnion.find(k);
    var g = groups.get(root);
    if (!g || n > artistSeen.get(g)) groups.set(root, k);
  });
  var artistMap = new Map();
  artistSeen.forEach(function(n, k) { var c = groups.get(artistUnion.find(k)); if (c !== k) artistMap.set(k, c); });
  log("  " + aliasReasons.length + " artist aliases");

  // ------------------------------------------------------------ keys
  var trackIndex = new Map(); // canonical track key -> [spelling]
  var rawKeyIndex = new Map(); // raw (no alias) track key -> [spelling]
  spellings.forEach(function(sp, i) {
    sp.raw = tags.keysOf(sp.parsed);
    sp.keys = tags.keysOf(sp.parsed, artistMap);
    // the artists with any leading "The" taken off ("The Kooks" -> "kooks")
    sp.theLess = sp.parsed.artists.map(function(a) { return tags.squash(tags.fold(a).replace(/^the\s+/, "")); }).sort().join("+");
    sp.weak = sp.parsed.weak;
    push(rawKeyIndex, sp.raw.track, i);
    if (!sp.weak) push(trackIndex, sp.keys.track, i);
  });

  // --------------------------------------------------------- decisions
  var decisions = new Map();
  db.prepare("SELECT a, b, decision FROM decisions").all().forEach(function(d) { decisions.set(pairKey(d.a, d.b), d.decision); });
  function decided(i, j) {
    return decisions.get(pairKey(spellings[i].raw.track, spellings[j].raw.track)) ||
      decisions.get(pairKey(spellings[i].keys.track, spellings[j].keys.track)) || null;
  }

  var uf = new UnionFind(spellings.length);
  var merges = [];
  var review = [];
  function join(i, j, reason, score) {
    var d = decided(i, j);
    if (d === "separate") return false;
    if (uf.union(i, j)) { merges.push([i, j, reason, score == null ? 1 : score]); return true; }
    return false;
  }
  function ask(kind, i, j, score, evidence) {
    if (decided(i, j)) return;
    review.push({ kind: kind, a: spellings[i].raw.track, b: spellings[j].raw.track, a_label: label(i), b_label: label(j), score: score, evidence: evidence || "" });
  }
  function label(i) { return spellings[i].artist + " - " + spellings[i].title; }

  // your "merge" answers first
  decisions.forEach(function(d, k) {
    if (d !== "merge") return;
    var parts = k.split("\u0002");
    var a = rawKeyIndex.get(parts[0]) || trackIndex.get(parts[0]);
    var b = rawKeyIndex.get(parts[1]) || trackIndex.get(parts[1]);
    if (a && b) join(a[0], b[0], "review.csv", 1);
  });

  // same tags after cleanup
  log("matching spellings...");
  trackIndex.forEach(function(list) { for (var i = 1; i < list.length; i++) join(list[0], list[i], "same-tags", 1); });

  // same upload
  var uploadSpellings = new Map(); // up -> Map(spelling -> weight)
  obsList.forEach(function(o) {
    if (!o[6]) return;
    var m = uploadSpellings.get(o[6]);
    if (!m) uploadSpellings.set(o[6], m = new Map());
    m.set(o[0], (m.get(o[0]) || 0) + o[7]);
  });
  var uploadMain = new Map(); // up -> its main spelling
  var conflicts = 0;
  uploadSpellings.forEach(function(m, up) {
    var best = -1;
    var bestW = -Infinity;
    m.forEach(function(w, si) {
      var adj = w + (spellings[si].weak ? -100 : 0) + tags.quality(spellings[si].artist, spellings[si].title) * 0.1;
      if (adj > bestW) { bestW = adj; best = si; }
    });
    uploadMain.set(up, best);
    m.forEach(function(w, si) {
      if (si === best || spellings[si].weak || spellings[best].weak) return;
      if (compatible(spellings[best], spellings[si])) join(best, si, "same-upload", 0.99);
      else if (uf.find(best) !== uf.find(si) && !onlyFrom(spellings[si], WEAK_PLATFORM) && !onlyFrom(spellings[best], WEAK_PLATFORM)) {
        conflicts++;
        var platform = onlyFrom(spellings[si], TRUSTED_PLATFORM) || onlyFrom(spellings[best], TRUSTED_PLATFORM);
        ask(platform ? "room-tag-vs-upload" : "upload-tagged-two-ways", best, si, 0.5,
          (platform ? "YouTube/SoundCloud say this upload is the other one: " : "upload tagged both ways: ") + uploadUrl(up));
      }
    });
  });

  // A spelling with only vague tags (the bot saved "Remember (feat. The
  // Presets)" as the artist, with no title) is the track of the upload it was
  // logged for, when every log of it is of uploads of that one track. Logged
  // anywhere without an upload (a scrobble of "Unknown - Intro"), or on
  // uploads of two tracks, it stays apart.
  var loose = new Set();
  obsList.forEach(function(o) { if (!o[6]) loose.add(o[0]); });
  var vague = new Map(); // si -> {mains: Set, bad}
  uploadSpellings.forEach(function(m, up) {
    var main = uploadMain.get(up);
    m.forEach(function(w, si) {
      if (!spellings[si].weak) return;
      var v = vague.get(si);
      if (!v) vague.set(si, v = { mains: new Set(), bad: false });
      if (si === main || spellings[main].weak) v.bad = true;
      else v.mains.add(main);
    });
  });
  vague.forEach(function(v, si) {
    if (v.bad || loose.has(si) || !v.mains.size) return;
    var mains = Array.from(v.mains);
    var root = uf.find(mains[0]);
    if (mains.every(function(m) { return uf.find(m) === root; })) join(mains[0], si, "same-upload-vague", 0.95);
  });

  // the same ISRC (a recording's industry id, from SoundCloud) = the same track
  isrcUploads.forEach(function(ups) {
    var list = Array.from(ups).filter(function(u) { return uploadMain.has(u); });
    for (var i = 1; i < list.length; i++) {
      var a = uploadMain.get(list[0]);
      var b = uploadMain.get(list[i]);
      if (spellings[a].weak || spellings[b].weak) continue;
      if (compatible(spellings[a], spellings[b])) join(a, b, "isrc", 0.99);
      else ask("same-isrc-different-tags", a, b, 0.7, "same ISRC");
    }
  });

  // titles Google Sheets damaged ("2:00" -> "2:00 AM")
  spellings.forEach(function(sp, i) {
    sp.parsed.altTitles.forEach(function(alt) {
      var k = sp.keys.artist + "|" + tags.titleKeyOf(alt) + "|" + sp.keys.version;
      var hit = trackIndex.get(k);
      if (hit) join(i, hit[0], "spreadsheet-repair", 0.95);
    });
  });

  // titles with letters dropped by the old Last.fm bug
  var titleSkeletons = new Map();
  spellings.forEach(function(sp, i) {
    if (sp.weak || !NON_ASCII_LETTER.test(sp.title)) return;
    var sk = skeleton(sp.parsed.title);
    if (usableSkeleton(sp.parsed.title, sk)) titleSkeletons.set(sp.keys.artist + "|" + sk + "|" + sp.keys.version, i);
  });
  titleSkeletons.forEach(function(i, k) {
    var hit = trackIndex.get(k);
    if (hit) join(i, hit[0], "accents", 0.97);
  });

  // featured artists: "A feat. B" = "A & B" = "A"
  var byTitle = new Map();
  spellings.forEach(function(sp, i) {
    if (sp.weak || sp.keys.title.length < 3) return;
    push(byTitle, sp.keys.title + "|" + sp.keys.version, i);
  });
  byTitle.forEach(function(list) {
    if (list.length < 2 || list.length > 300) return;
    var reps = distinctBy(list, function(i) { return spellings[i].keys.track; });
    for (var a = 0; a < reps.length; a++) {
      var A = artistSets(spellings[reps[a]]);
      for (var b = a + 1; b < reps.length; b++) {
        var B = artistSets(spellings[reps[b]]);
        if (subset(A.primary, B.full) && subset(B.primary, A.full)) { join(reps[a], reps[b], "featured-artist", 0.97); continue; }
        // "The X - Song" and "X - Song": different artists in general, the same
        // track when the (specific) title matches
        if (spellings[reps[a]].theLess && spellings[reps[a]].theLess === spellings[reps[b]].theLess) { join(reps[a], reps[b], "the-prefix", 0.96); continue; }
        // one name off ("The Nationals"), same title: worth a look
        if (A.primary.length === 1 && B.primary.length === 1) {
          var s = tags.similarity(A.primary[0], B.primary[0]);
          if (s >= 0.8 && uf.find(reps[a]) !== uf.find(reps[b])) {
            if (s >= 0.9 && A.primary[0].length >= 8 && spellings[reps[a]].keys.title.length >= 6) join(reps[a], reps[b], "artist-typo", s);
            else ask("similar-artist", reps[a], reps[b], s);
          }
        }
      }
    }
  });

  // typos in titles by the same artist
  var byArtist = new Map();
  spellings.forEach(function(sp, i) { if (!sp.weak) push(byArtist, sp.keys.artist + "|" + sp.keys.version, i); });
  byArtist.forEach(function(list) {
    if (list.length < 2) return;
    var reps = distinctBy(list, function(i) { return spellings[i].keys.title; });
    if (reps.length > 1500) return;
    reps.sort(function(x, y) { return spellings[x].keys.title.length - spellings[y].keys.title.length; });
    for (var a = 0; a < reps.length; a++) {
      var ta = spellings[reps[a]].keys.title;
      if (ta.length < 5) continue;
      for (var b = a + 1; b < reps.length; b++) {
        var tb = spellings[reps[b]].keys.title;
        if (tb.length > ta.length * 1.35) break;
        if (!tags.sameNumbers(ta, tb)) continue;
        var s = tags.similarity(ta, tb);
        if (s < 0.8 || uf.find(reps[a]) === uf.find(reps[b])) continue;
        if ((s >= 0.92 && ta.length >= 8) || (tags.isTransposition(ta, tb) && ta.length >= 6)) join(reps[a], reps[b], "title-typo", s);
        else ask("similar-title", reps[a], reps[b], s);
      }
    }
  });

  // ------------------------------------------------------------ tracks
  log("building tracks...");
  var clusters = new Map(); // root -> [spelling]
  spellings.forEach(function(sp, i) { push(clusters, uf.find(i), i); });

  // uploads point to their main spelling's track; weak spellings follow the upload
  var uploadRoot = new Map();
  uploadMain.forEach(function(si, up) { uploadRoot.set(up, uf.find(si)); });

  // ---------------------------------------------------------------- tz
  // ADAM's clock, measured against the plays whose time is exact (Last.fm):
  // the zone that lines up the most stamps. Its own exports had local times
  // with no zone (1); its history as moved into globalTracks had UTC times
  // read as local ones (2). Each kind is measured on its own.
  var given = opts.adamTz != null && opts.adamTz !== "auto" ? (isNaN(Number(opts.adamTz)) ? opts.adamTz : Number(opts.adamTz)) : null;
  var zones = { 1: given, 2: given };
  var rootOf = function(o) { return o[6] && uploadRoot.has(o[6]) ? uploadRoot.get(o[6]) : uf.find(o[0]); };
  var precise = new Map(); // root -> sorted times of exact plays
  obsList.forEach(function(o) {
    if (o[3] || !o[2] || o[1] !== "play") return;
    push(precise, rootOf(o), o[2]);
  });
  precise.forEach(function(l) { l.sort(function(a, b) { return a - b; }); });
  var tzReport = {};
  [1, 2].forEach(function(kind) {
    if (zones[kind] != null) return;
    var sample = [];
    for (var oi = 0; oi < obsList.length && sample.length < 30000; oi++) {
      var o2 = obsList[oi];
      if (o2[3] !== kind || !o2[2]) continue;
      var r2 = rootOf(o2);
      if (precise.has(r2)) sample.push([r2, o2[2]]);
    }
    if (!sample.length) { zones[kind] = 0; return; }
    var scores = ZONES.map(function(z) {
      var hits = 0;
      sample.forEach(function(s) { if (nearest(precise.get(s[0]), kind === 2 ? shiftedToUtc(s[1], z) : naiveToUtc(s[1], z)) <= 5 * MIN) hits++; });
      return [z, hits];
    }).sort(function(a, b) { return b[1] - a[1]; });
    zones[kind] = scores[0][1] >= 20 ? scores[0][0] : 0;
    tzReport[kind] = { sample: sample.length, best: scores.slice(0, 3), chosen: zones[kind] };
    log("  ADAM clock" + (kind === 2 ? " (history moved into globalTracks)" : "") + ": " + (zones[kind] === 0 ? "UTC (not enough overlap to tell)" : zones[kind]) +
      " (" + scores[0][1] + " of " + sample.length + " stamps line up)");
  });
  var zone = zones[1];

  // ------------------------------------------------------------ events
  log("lining up plays...");
  var djNames = new Map();
  db.prepare("SELECT source, id, name FROM dj_names").all().forEach(function(r) { djNames.set(r.source + ":" + r.id, r.name); });
  // Who is who. One DJ is an account: its username now, the names it
  // claimed (nameClaim keeps them after a rename) and its id. Each name has
  // at most one account: the one using it now or that claimed it, as
  // written, else the only one either way whatever the case. Old
  // claims kept their case, and people claimed each other's names in jest
  // ("ANDREW", "AnDrEw"), so a name more than one account claimed belongs to
  // none. dj-aliases.csv joins names, and so accounts, that are one person. A
  // DJ shows as the name they played under most, unless the list pins one:
  // "Noumenon,=Andrew".
  var usersExact = new Map(); // username -> uid
  var users = new Map();    // lower-case username -> uid (null: more than one)
  var claimed = new Map();  // name as claimed -> uid
  var claimedCi = new Map(); // lower case -> uid (null: more than one)
  var claimOwners = new Set();
  var oneOwner = function(m, k, uid) { m.set(k, m.has(k) && m.get(k) !== uid ? null : uid); };
  djNames.forEach(function(name, key) {
    var i = key.indexOf(":");
    var src = key.slice(0, i);
    var id = key.slice(i + 1);
    if (src === "fb") { usersExact.set(String(name), id); oneOwner(users, String(name).toLowerCase(), id); }
    else if (src === "claim") { claimed.set(id, String(name)); oneOwner(claimedCi, id.toLowerCase(), String(name)); claimOwners.add(String(name)); }
  });
  function djKey(name) {
    var l = name.toLowerCase();
    var uid = (djNames.has("fb:" + name) || claimOwners.has(name) ? name : null) || usersExact.get(name) || claimed.get(name) ||
      users.get(l) || claimedCi.get(l);
    return uid ? "u:" + uid : "n:" + l;
  }
  var djUnion = new KeyUnion();
  var pins = [];
  listFiles(opts.dir, "dj-aliases.csv").forEach(function(f) {
    readAliasCsv(f).forEach(function(p) {
      var pin = p[1].charAt(0) === "=";
      var to = pin ? p[1].slice(1).trim() : p[1];
      djUnion.union(djKey(p[0]), djKey(to));
      if (pin) pins.push(to);
    });
  });
  var djPinned = new Map(); // root -> name
  pins.forEach(function(n) { djPinned.set(djUnion.find(djKey(n)), n); });
  var djDisplay = new Map(); // root -> Map(display -> n)
  function djOf(raw, src) {
    if (!raw) return null;
    raw = String(raw).trim();
    var name = djNames.get((src.indexOf("fb:") === 0 ? "fb" : src) + ":" + raw) || djNames.get("fb:" + raw) || raw;
    if (src === "adam" && /^\d+$/.test(raw)) name = djNames.get("adam:" + raw) || name;
    var k = djUnion.find(djNames.has("fb:" + raw) ? "u:" + raw : djKey(name));
    if (!djDisplay.has(k)) djDisplay.set(k, new Map());
    djDisplay.get(k).set(name, (djDisplay.get(k).get(name) || 0) + 1);
    return k;
  }

  var events = new Map(); // root -> [[at, src, role, dj, up]]
  obsList.forEach(function(o) {
    if (!o[2] || o[1] === "tag") return;
    var at = toUtc(o[2], o[3], zones);
    var root = o[6] && uploadRoot.has(o[6]) ? uploadRoot.get(o[6]) : uf.find(o[0]);
    var src = sourceNames[o[4]];
    push(events, root, [at, src, o[1], djOf(o[5], src), o[6]]);
  });

  // ------------------------------------------------------------- write
  log("writing results...");
  var spellingTrack = new Array(spellings.length);
  var trackRows = [];
  var songUnion = new KeyUnion();
  var trackSongKeys = new Map();

  // the best way to write each artist: most used, a person's fix, accents kept
  var bestArtistName = new Map();
  artistDisplay.forEach(function(displays, k) {
    var c = artistMap.get(k) || k;
    var cur = bestArtistName.get(c);
    displays.forEach(function(n, name) {
      // ties go to the spelling with its spaces ("Tame Impala", not "TameImpala")
      var score = Math.log2(1 + n) + nonAsciiCount(name) * 0.01 + (name.split(" ").length - 1) * 0.001;
      if (!cur || score > cur.score) cur = { name: name, score: score };
    });
    bestArtistName.set(c, cur);
  });
  // the same name with its accents back wins over the stripped one, when
  // enough logs have it (years of stripping for the old Last.fm bug mean the
  // stripped one is usually the most common)
  // Which accents go on an artist's name across all their songs is checked
  // against YouTube Music (the artist's Topic channel): the logs, and mods'
  // fixes (often made to take accents out), only suggest. YouTube Music writing it without accents settles it
  // ("BLOW", not "Bülow"); an artist not found there yet is left as it is and
  // listed for check-artists to look up.
  var keysOfArtist = new Map(); // canonical key -> every key joined to it
  artistMap.forEach(function(to, from) { if (!keysOfArtist.has(to)) keysOfArtist.set(to, []); keysOfArtist.get(to).push(from); });
  // a mod's spelling of an artist ("SebastiAn"): it sets capitals and
  // punctuation, never accents (many fixes took them out for the old Last.fm
  // bug); those follow YouTube Music
  var personSpelling = new Map();
  spellings.forEach(function(sp) {
    if (!sp.sources.has("fb:tagLog")) return;
    sp.parsed.artists.forEach(function(a) {
      var k = tags.artistKeyOf(a);
      personSpelling.set(artistMap.get(k) || k, a);
    });
  });
  var artistAccents = []; // artist_accents.csv
  var ytmWanted = [];     // to look up on YouTube Music
  bestArtistName.forEach(function(cur, c) {
    var keys = [c].concat((keysOfArtist.get(c) || []).filter(function(k) { return k !== c; }));
    var pick = null;
    keys.forEach(function(k) {
      var p = accents.pick("artist", k, cur.name);
      if (p && (!pick || p.n > pick.n)) pick = p;
    });
    var ref = ytmRef(keys);
    var out = null;
    var outcome = null;
    if (ref) {
      var w = NON_ASCII_LETTER.test(ref.name) ? withAccentsOf(cur.name, ref.name) : null;
      if (w && w !== cur.name) { out = { word: w, n: ref.n, trusted: true, by: "YouTube Music" }; outcome = "accents from YouTube Music"; }
      else if (pick) outcome = "left as it is: YouTube Music writes it " + ref.name;
    } else if (pick) {
      outcome = ytmChecked.has(c) ? "left as it is: not found on YouTube Music" : "left as it is until YouTube Music is checked";
      if (!ytmChecked.has(c)) ytmWanted.push({ key: c, name: cur.name, accented: pick.word, logs: pick.n });
    }
    if (outcome) artistAccents.push({ name: cur.name, logs_suggest: pick ? pick.word + " (" + pick.n + " logs)" : "", youtube_music: ref ? ref.name : "", outcome: outcome, shown_as: out ? out.word : cur.name });
    if (out) bestArtistName.set(c, { name: out.word, score: cur.score, accent: out });
  });
  // YouTube Music's most used spelling of an artist, from any of their keys
  function ytmRef(keys) {
    var best = null;
    keys.forEach(function(k) {
      (ytmNames.get(k) || new Map()).forEach(function(n, name) { if (!best || n > best.n) best = { name: name, n: n }; });
    });
    return best;
  }
  // accented words in each artist's titles ("Jóga" for Björk), from every spelling
  spellings.forEach(function(sp) {
    if (sp.weak || !NON_ASCII_LETTER.test(sp.title)) return;
    var ok = trusted(sp);
    sp.keys.artist.split("+").forEach(function(ak) {
      wordsOf(sp.parsed.title).forEach(function(w) { if (NON_ASCII_LETTER.test(w)) accents.note("word:" + ak, null, w, sp.seen, ok); });
    });
  });

  // tag-exceptions.csv: artists ("Artist") or songs ("Artist - Title") never to tidy
  var exceptions = { artists: new Set(), tracks: new Set() };
  listFiles(opts.dir, "tag-exceptions.csv").forEach(function(exFile) {
    if (!fs.existsSync(exFile)) return;
    fs.readFileSync(exFile, "utf8").split(/\r?\n/).forEach(function(line) {
      line = line.replace(/^"|"$/g, "").trim();
      if (!line || /^#/.test(line) || /^(artist|exception|tag)s?$/i.test(line)) return;
      if (line.indexOf(" - ") > 0) {
        var k = tags.keysOf(tags.parse(line, null));
        exceptions.tracks.add(k.track);
        exceptions.tracks.add(tags.keysOf(tags.parse(line, null), artistMap).track);
      } else {
        var ak = tags.artistKeyOf(line);
        exceptions.artists.add(ak);
        exceptions.artists.add(artistMap.get(ak) || ak);
      }
    });
  });

  // Put each artist name in text back the way the logs write it, accents included
  function restoreNames(text, why, names) {
    var list = names || tags.splitArtists(tags.parse(text, "x").artist);
    list.forEach(function(name) {
      var k = tags.artistKeyOf(name);
      var best = bestArtistName.get(artistMap.get(k) || k);
      if (!best || !best.accent || nonAsciiCount(best.name) <= nonAsciiCount(name)) return;
      if (tags.fold(best.name) !== tags.fold(name) && skeleton(best.name) !== tags.squash(name)) return;
      var at = text.indexOf(name);
      if (at === -1) return;
      text = text.slice(0, at) + best.name + text.slice(at + name.length);
      why.push(name + "→" + best.name + " (" + (best.accent.by || best.accent.n + " logs" + (best.accent.trusted ? ", trusted source" : "")) + ")");
    });
    return text;
  }

  var accentFixes = [];
  var uploadOfRoot = new Map(); // a track's first upload, for tracks with only vague tags
  uploadRoot.forEach(function(r, up) { if (!uploadOfRoot.has(r)) uploadOfRoot.set(r, up); });
  var usedTrackIds = new Set();
  var idClashes = [];
  var idClashCount = 0;
  clusters.forEach(function(members, root) {
    var best = -1;
    var bestScore = -Infinity;
    members.forEach(function(si) {
      var sp = spellings[si];
      var score = Math.log2(1 + sp.weight) + tags.quality(sp.artist, sp.title) +
        (sp.maxWeight >= 6 ? 6 : sp.maxWeight >= 4 ? 3 : 0) + (sp.last > Date.now() - 3 * 365 * 86400000 ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; best = si; }
    });
    var chosen = spellings[best];
    var artist = chosen.artist;
    var title = chosen.title;
    // joined over a leading "The": the artist name the logs use more wins
    var theForms = new Map();
    members.forEach(function(si) {
      var sp = spellings[si];
      if (sp.weak || sp.theLess !== chosen.theLess || sp.keys.artist === chosen.keys.artist) return;
      theForms.set(sp.keys.artist, sp);
    });
    if (theForms.size) {
      var prevalent = chosen;
      theForms.forEach(function(sp, k) { if ((artistSeen.get(k) || 0) > (artistSeen.get(prevalent.keys.artist) || 0)) prevalent = sp; });
      if (prevalent !== chosen) {
        var name = bestArtistName.get(prevalent.keys.artist);
        artist = name && prevalent.parsed.artists.length === 1 && !prevalent.parsed.featured.length ? name.name : prevalent.artist;
      }
    }
    var restoredFrom = [];
    // accents, 1: the whole title as other spellings of this track have it
    var titleLogs = accentBook(accentMin);
    members.forEach(function(si) { titleLogs.note("t", "t", spellings[si].title, spellings[si].seen, trusted(spellings[si])); });
    var tp = titleLogs.pick("t", "t", title);
    if (tp) { title = tp.word; restoredFrom.push("title in " + tp.n + " logs" + (tp.trusted ? " (incl. a trusted source)" : "")); }
    // the artist as other spellings of this track have it (an upload's own
    // YouTube/SoundCloud data counts here, on its own track)
    var artistLogs = accentBook(accentMin);
    members.forEach(function(si) { artistLogs.note("a", "a", spellings[si].artist, spellings[si].seen, trusted(spellings[si])); });
    var ap = artistLogs.pick("a", "a", artist);
    // YouTube Music knows this artist: only its accents
    var apRef = ap && chosen.parsed.artists.length === 1 ? ytmRef([chosen.keys.artist].concat(keysOfArtist.get(chosen.keys.artist) || [])) : null;
    if (apRef && (withAccentsOf(artist, apRef.name) || "").toLowerCase() !== ap.word.toLowerCase()) ap = null;
    if (ap) { artist = ap.word; restoredFrom.push("artist in " + ap.n + " logs" + (ap.trusted ? " (incl. a trusted source)" : "")); }
    // 2: word by word, from this artist's other songs ("Joga (Live)" -> "Jóga (Live)")
    var restoredWords = [];
    title = title.split(WORD_SPLIT).map(function(tok) {
      if (!/[\p{L}]/u.test(tok) || tok.length < 3) return tok;
      var best = null;
      chosen.keys.artist.split("+").forEach(function(ak) {
        var p = accents.pick("word:" + ak, null, tok);
        if (p && (!best || p.n > best.n)) best = p;
      });
      if (!best) return tok;
      restoredWords.push(tok + "→" + best.word + " (" + best.n + " logs)");
      return matchCase(best.word, tok);
    }).join("");
    if (restoredWords.length) restoredFrom.push("words: " + restoredWords.join(", "));
    // 3: every artist name (and featured artist), the way the room's logs write it
    artist = restoreNames(artist, restoredFrom);
    if (chosen.parsed.featured.length) title = restoreNames(title, restoredFrom, chosen.parsed.featured);
    // tidying writes an artist one way everywhere only as a mod wrote it
    // (accents per YouTube Music), or with YouTube Music's accents; otherwise
    // the artist stays as typed
    // ("SebastiAn", "A R I Z O N A", "Tegan and Sara" are left alone)
    // One way of writing an artist everywhere, starting from the tag as typed:
    // a mod's spelling sets capitals and punctuation ("SebastiAn"), the room's
    // usual spelling only puts missing spaces back ("TameImpalaVEVO"), and
    // YouTube Music sets the accents, in the tag's own capitals. Nothing else
    // ("MAM", "A R I Z O N A", "For Esmé" stay).
    var unifyArtist = function(cur) { return cur; };
    if (chosen.parsed.artists.length === 1) {
      var ak = artistMap.get(chosen.keys.artist) || chosen.keys.artist;
      var bn = bestArtistName.get(chosen.keys.artist);
      var mine = personSpelling.get(ak);
      var aRef = ytmRef([ak].concat(keysOfArtist.get(ak) || []));
      var spaces = function(x) { return (x.match(/\s/g) || []).length; };
      unifyArtist = function(cur) {
        var r = cur;
        if (mine) r = withAccentsOf(mine, cur) || (nonAsciiCount(mine) >= nonAsciiCount(cur) ? mine : cur);
        else if (bn && bn.name.replace(/\s+/g, "") === cur.replace(/\s+/g, "") && spaces(bn.name) > spaces(cur)) r = bn.name;
        if (aRef) r = withAccentsOf(r, aRef.name) || r;
        return r;
      };
    }
    if (artist !== chosen.artist || title !== chosen.title) accentFixes.push({ from: chosen.artist + " - " + chosen.title, to: artist + " - " + title, why: restoredFrom.join("; ") });

    var nonWeak = members.filter(function(si) { return !spellings[si].weak; });
    var anchorKey = nonWeak.length ? nonWeak.map(function(si) { return spellings[si].raw.track; }).sort()[0]
      : "upload:" + (uploadOfRoot.get(root) || spellings[members[0]].raw.track);
    var id = "t" + tags.hash(anchorKey);
    if (usedTrackIds.has(id)) {
      // another track has the same key (vague tags with no upload, or two a
      // review answer kept apart): this one is named by its own spellings,
      // which belong to no other track
      var own = members.map(function(si) { return spellings[si].artist + "\u0001" + spellings[si].title; }).sort();
      for (var n = 0; usedTrackIds.has(id); n++) id = "t" + tags.hash("spellings:" + own.join("\u0002") + (n ? "#" + n : ""));
      if (idClashes.length < 5) idClashes.push(anchorKey + " (" + spellings[members[0]].artist + " - " + spellings[members[0]].title + ")");
      idClashCount++;
    }
    usedTrackIds.add(id);
    members.forEach(function(si) { spellingTrack[si] = id; });
    var keys = new Set();
    nonWeak.forEach(function(si) { keys.add(spellings[si].raw.track); keys.add(spellings[si].keys.track); });
    var songKeys = new Set();
    nonWeak.forEach(function(si) { songKeys.add(spellings[si].keys.song); });
    trackSongKeys.set(id, songKeys);
    var sk = Array.from(songKeys);
    for (var q = 1; q < sk.length; q++) songUnion.union(sk[0], sk[q]);
    var conf = 1;
    // a person chose these tags (logged fix) or you listed them as an exception: never tidied
    var isProtected = members.some(function(si) { return spellings[si].sources.has("fb:tagLog"); }) ||
      exceptions.artists.has(chosen.keys.artist) || exceptions.artists.has(chosen.raw.artist) ||
      exceptions.tracks.has(chosen.keys.track) || exceptions.tracks.has(chosen.raw.track);
    var tidyJunk = tags.tidy(artist, title, "junk");
    var tidyRsn = tags.tidy(artist, title, "rsn");
    // one way of writing each artist everywhere: a mod's fix first, then the most used
    if (chosen.parsed.artists.length === 1 && !chosen.parsed.featured.length) {
      [tidyJunk, tidyRsn].forEach(function(td) {
        var tk = tags.artistKeyOf(td.artist);
        if (tk === chosen.keys.artist || (artistMap.get(tk) || tk) === (artistMap.get(chosen.keys.artist) || chosen.keys.artist)) td.artist = unifyArtist(td.artist);
      });
    }
    trackRows.push({
      id: id, root: root, artist: artist, title: title,
      version: chosen.parsed.versions.filter(function(v) { return v.kind; }).map(function(v) { return v.text; }).join(", "),
      spellings: members.length, keys: Array.from(keys), weak: !nonWeak.length, conf: conf,
      tidyJunk: tidyJunk, tidyRsn: tidyRsn, protected: isProtected
    });
  });
  if (idClashCount) log("  " + idClashCount + " tracks share a key with another track and were named by their spellings, e.g. " + idClashes.join("; "));
  var rootToTrack = new Map(trackRows.map(function(t) { return [t.root, t]; }));
  merges.forEach(function(m) {
    var t = rootToTrack.get(uf.find(m[0]));
    if (t && m[3] < t.conf) t.conf = m[3];
  });

  // songs: tracks that share artist + title (any version)
  var songOfTrack = new Map();
  var songMembers = new Map();
  trackRows.forEach(function(t) {
    var sk = Array.from(trackSongKeys.get(t.id));
    var sid = sk.length ? "s" + tags.hash(songUnion.find(sk[0])) : "s" + tags.hash("track:" + t.id);
    songOfTrack.set(t.id, sid);
    push(songMembers, sid, t);
  });

  // plays: stamps within the window from different sources are one play
  var playRows = [];
  var djStats = new Map();
  function djStat(k) {
    var s = djStats.get(k);
    if (!s) djStats.set(k, s = { plays: 0, firsts: 0, tracks: new Set(), first: Infinity, last: 0 });
    return s;
  }
  trackRows.forEach(function(t) {
    var ev = events.get(t.root) || [];
    ev.sort(function(a, b) { return a[0] - b[0]; });
    var groups = [];
    var g = null;
    ev.forEach(function(e) {
      var fits = g && e[0] - g.start <= windowMs && (!g.srcs.has(e[1]) || e[0] - g.lastAt < 2 * MIN || e[2] !== "play");
      if (!fits) { g = { start: e[0], at: e[0], srcs: new Set(), dj: null, djRank: 99, lastAt: e[0], playAt: null, up: null, scrobbled: false }; groups.push(g); }
      g.srcs.add(e[1]);
      g.lastAt = e[0];
      if (e[2] === "play" && (g.playAt == null || djRank(e[1]) < 99)) g.playAt = g.playAt == null || !isLastfm(e[1]) ? (g.playAt == null ? e[0] : Math.min(g.playAt, e[0])) : g.playAt;
      if (isLastfm(e[1])) g.scrobbled = true;
      if (e[3] && djRank(e[1]) < g.djRank) { g.dj = e[3]; g.djRank = djRank(e[1]); }
      if (e[4] && !g.up) g.up = e[4];
    });
    t.plays = groups.length;
    t.scrobbles = groups.filter(function(x) { return x.scrobbled; }).length;
    var djsHere = new Set();
    groups.forEach(function(x) {
      x.at = x.playAt != null ? x.playAt : x.start;
      playRows.push([t.id, x.at, x.dj, Array.from(x.srcs).sort().join("+"), x.up ? Number(x.up[0]) : null, x.up ? x.up.slice(1) : null]);
      if (x.dj) {
        djsHere.add(x.dj);
        var s = djStat(x.dj);
        s.plays++; s.tracks.add(t.id);
        if (x.at < s.first) s.first = x.at;
        if (x.at > s.last) s.last = x.at;
      }
    });
    t.djs = djsHere.size;
    if (groups.length) {
      var f = groups[0];
      var l = groups[groups.length - 1];
      t.firstAt = f.at; t.firstDj = f.dj;
      var fd = groups.find(function(x) { return x.dj; });
      t.firstKnownDj = fd ? fd.dj : null; t.firstKnownDjAt = fd ? fd.at : null;
      t.lastAt = l.at; t.lastDj = l.dj;
      if (fd && fd === f) djStat(f.dj).firsts++;
    }
  });
  // the name played under most (whatever its case), written the way it is most often
  function djName(k) {
    if (!k) return null;
    if (djPinned.has(k)) return djPinned.get(k);
    var d = djDisplay.get(k);
    if (!d) return k.replace(/^[nu]:/, "");
    var byName = new Map();
    d.forEach(function(c, name) { var l = name.toLowerCase(); byName.set(l, (byName.get(l) || 0) + c); });
    var top = null;
    byName.forEach(function(c, l) { if (top === null || c > byName.get(top)) top = l; });
    var best = null;
    d.forEach(function(c, name) { if (name.toLowerCase() === top && (best === null || c > d.get(best))) best = name; });
    return best;
  }

  // uploads -> track, with the tags the room has for them now
  var uploadRows = [];
  uploadRoot.forEach(function(root, up) {
    var t = rootToTrack.get(root);
    var cur = uploadCurrent.get(up);
    uploadRows.push([Number(up[0]), up.slice(1), t.id, cur ? cur.artist : null, cur ? cur.title : null]);
  });
  var uploadsPerTrack = new Map();
  uploadRows.forEach(function(u) { uploadsPerTrack.set(u[2], (uploadsPerTrack.get(u[2]) || 0) + 1); });

  // review: tracks that pulled in suspiciously many different songs
  trackRows.forEach(function(t) {
    var members = clusters.get(t.root);
    var artistsIn = new Set(members.filter(function(si) { return !spellings[si].weak; }).map(function(si) { return spellings[si].keys.artist; }));
    if (artistsIn.size > 4) {
      var top = members.slice().sort(function(a, b) { return spellings[b].seen - spellings[a].seen; });
      ask("too-many-artists-in-one-track", top[0], top[1], 0.3, artistsIn.size + " different artists: " + Array.from(artistsIn).slice(0, 8).join(", "));
    }
  });

  store.tx(db, function() {
    ["variants", "tracks", "songs", "uploads", "plays", "djs", "merges", "review"].forEach(function(t) { db.exec("DELETE FROM " + t); });
    var insV = db.prepare("INSERT INTO variants (artist, title, track_key, song_key, track_id, seen, plays, scrobbles, sources, weak, suspect) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    spellings.forEach(function(sp, i) {
      insV.run(sp.artist, sp.title, sp.raw.track, sp.keys.song, spellingTrack[i], sp.seen, sp.plays, sp.scrobbles, Array.from(sp.sources).sort().join(","), sp.weak ? 1 : 0, sp.parsed.suspect);
    });
    var insT = db.prepare(`INSERT INTO tracks (id, song_id, artist, title, version, plays, scrobbles, djs, first_play_at, first_play_dj, first_dj, first_dj_at,
      last_play_at, last_play_dj, uploads, spellings, confidence, keys, tidy_junk, tidy_rsn, protected) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    trackRows.forEach(function(t) {
      insT.run(t.id, songOfTrack.get(t.id), t.artist, t.title, t.version || null, t.plays || 0, t.scrobbles || 0, t.djs || 0,
        t.firstAt == null ? null : t.firstAt, djName(t.firstDj), djName(t.firstKnownDj), t.firstKnownDjAt == null ? null : t.firstKnownDjAt,
        t.lastAt == null ? null : t.lastAt, djName(t.lastDj), uploadsPerTrack.get(t.id) || 0, t.spellings, t.weak ? 0 : t.conf, JSON.stringify(t.keys),
        JSON.stringify({ a: t.tidyJunk.artist, t: t.tidyJunk.title }), JSON.stringify({ a: t.tidyRsn.artist, t: t.tidyRsn.title }), t.protected ? 1 : 0);
    });
    var insS = db.prepare("INSERT INTO songs (id, artist, title, versions, plays, first_play_at, first_play_dj, last_play_at, last_play_dj, keys) VALUES (?,?,?,?,?,?,?,?,?,?)");
    songMembers.forEach(function(list, sid) {
      var main = list.slice().sort(function(a, b) { return (a.version ? 1 : 0) - (b.version ? 1 : 0) || (b.plays || 0) - (a.plays || 0); })[0];
      var played = list.filter(function(t) { return t.firstAt != null; });
      var first = played.slice().sort(function(a, b) { return a.firstAt - b.firstAt; })[0];
      var last = played.slice().sort(function(a, b) { return b.lastAt - a.lastAt; })[0];
      var keys = new Set();
      list.forEach(function(t) { trackSongKeys.get(t.id).forEach(function(k) { keys.add(k); }); });
      insS.run(sid, main.artist, main.title, list.length,
        list.reduce(function(n, t) { return n + (t.plays || 0); }, 0),
        first ? first.firstAt : null, first ? djName(first.firstDj) : null, last ? last.lastAt : null, last ? djName(last.lastDj) : null, JSON.stringify(Array.from(keys)));
    });
    var insU = db.prepare("INSERT INTO uploads (type, cid, track_id, artist, title) VALUES (?,?,?,?,?)");
    uploadRows.forEach(function(u) { insU.run(u[0], u[1], u[2], u[3], u[4]); });
    var insP = db.prepare("INSERT INTO plays (track_id, at, dj, sources, type, cid) VALUES (?,?,?,?,?,?)");
    playRows.forEach(function(p) { insP.run(p[0], p[1], djName(p[2]), p[3], p[4], p[5]); });
    var insD = db.prepare("INSERT INTO djs (name, aliases, plays, first_plays, tracks, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)");
    djStats.forEach(function(s, k) {
      var d = djDisplay.get(k);
      insD.run(djName(k), d ? Array.from(d.keys()).join(" | ") : k, s.plays, s.firsts, s.tracks.size, s.first === Infinity ? null : s.first, s.last || null);
    });
    var insM = db.prepare("INSERT INTO merges (track_id, a, b, reason, score) VALUES (?,?,?,?,?)");
    merges.forEach(function(m) { insM.run(spellingTrack[m[0]], label(m[0]), label(m[1]), m[2], m[3]); });
    aliasReasons.forEach(function(a) { insM.run(null, a[0], a[1], "artist:" + a[2], 1); });
    var insR = db.prepare("INSERT INTO review (kind, a, b, a_label, b_label, score, evidence) VALUES (?,?,?,?,?,?,?)");
    var seenPairs = new Set();
    review.forEach(function(r) {
      var k = pairKey(r.a, r.b);
      if (seenPairs.has(k) || r.a === r.b) return;
      seenPairs.add(k);
      insR.run(r.kind, r.a, r.b, r.a_label, r.b_label, Math.round(r.score * 1000) / 1000, r.evidence);
    });
    // each artist's most played song, to search YouTube Music with
    var bestSongOf = new Map();
    var songsOf = new Map();
    spellings.forEach(function(sp) {
      if (sp.weak || sp.parsed.artists.length !== 1) return;
      var k = artistMap.get(sp.keys.artist) || sp.keys.artist;
      songsOf.set(k, (songsOf.get(k) || 0) + 1);
      var b = bestSongOf.get(k);
      if (!b || sp.plays > b.plays) bestSongOf.set(k, sp);
    });
    ytmWanted.forEach(function(w) {
      var song = bestSongOf.get(w.key);
      w.song = song ? song.title : "";
      w.songs = songsOf.get(w.key) || 0;
    });
    ytmWanted.sort(function(a, b) { return b.songs - a.songs; });
    store.setState(db, "ytm_wanted", ytmWanted);
    store.setState(db, "artist_accents", artistAccents);
    store.setState(db, "reconcile", {
      at: Date.now(), zone: zone, zones: zones, tz: tzReport, window: windowMs / MIN, conflicts: conflicts,
      accentFixes: accentFixes.length, seconds: Math.round((Date.now() - started) / 1000)
    });
  });
  fs.mkdirSync(opts.dir, { recursive: true });
  csv.writeCsv(path.join(opts.dir, "restore_accents.csv"), ["from", "to", "why"], accentFixes);

  var summary = {
    observations: obsList.length, spellings: spellings.length, tracks: trackRows.length, songs: songMembers.size,
    uploads: uploadRows.length, plays: playRows.length, djs: djStats.size, merges: merges.length,
    artistAliases: aliasReasons.length, review: review.length, accentFixes: accentFixes.length, adamClock: zone, adamMovedClock: zones[2],
    seconds: Math.round((Date.now() - started) / 1000)
  };
  log("  " + JSON.stringify(summary));
  return summary;
}

// ------------------------------------------------- accent restoration
// How many logs write a name or word with its accents (or other non-English
// letters). An accented version replaces the plain one when at least
// accentMin logs have it, or a trusted source does; it doesn't need to beat
// the plain one, which years of stripping for the old Last.fm bug made common.
var TRUSTED_SOURCES = new Set(["fb:tagLog", "sc:meta", "yt:topic"]);
function trusted(sp) {
  for (var s of sp.sources) if (TRUSTED_SOURCES.has(s)) return true;
  return false;
}
// `name` with the accents `ref` has, letter by letter, in name's own capitals
// ("Etienne De Crecy" + "Etienne de Crécy" -> "Etienne De Crécy"); null when
// the letters aren't the same
function withAccentsOf(name, ref) {
  var LETTER = /[\p{L}\p{N}]/u;
  var b = Array.from(String(ref).normalize("NFC")).filter(function(ch) { return LETTER.test(ch); });
  var j = 0;
  var out = "";
  for (var ch of Array.from(String(name).normalize("NFC"))) {
    if (!LETTER.test(ch)) { out += ch; continue; }
    var r = b[j++];
    if (r == null || tags.fold(r) !== tags.fold(ch)) return null;
    out += ch !== ch.toLowerCase() ? r.toUpperCase() : r.toLowerCase();
  }
  return j === b.length ? out : null;
}
// an accent is a Latin letter with a mark (é, ø, Å, Ü); symbols, emoji and
// other scripts are not ("♫ Artist", "Friends諝", "GRYFF グリフ")
var NOT_AN_ACCENT = /(?![\x00-\x7F])[^\p{Script=Latin}\p{M}]/u;
function accentBook(min) {
  var book = new Map(); // scope|base -> Map(word -> {n, trusted})
  function baseOf(w) { return tags.fold(w).replace(/\s+/g, " ").trim(); }
  return {
    note: function(scope, key, word, n, isTrusted) {
      if (!word || !NON_ASCII_LETTER.test(word)) return;
      if (NOT_AN_ACCENT.test(word)) return;
      [baseOf(word), "~" + skeleton(word)].forEach(function(b, i) {
        if (i === 1 && !usableSkeleton(word, skeleton(word))) return;
        var k = scope + "|" + (key == null ? "" : key + "|") + b;
        var m = book.get(k);
        if (!m) book.set(k, m = new Map());
        var cur = m.get(word) || { n: 0, trusted: false };
        cur.n += n;
        cur.trusted = cur.trusted || !!isTrusted;
        m.set(word, cur);
      });
    },
    // the best-supported accented version of `plain`, or null
    pick: function(scope, key, plain) {
      var prefix = scope + "|" + (key == null ? "" : key + "|");
      var m = book.get(prefix + baseOf(plain)) || book.get(prefix + "~" + tags.squash(plain));
      if (!m) return null;
      var best = null;
      m.forEach(function(v, word) {
        if (nonAsciiCount(word) <= nonAsciiCount(plain)) return;
        if (v.n < min && !v.trusted) return;
        var score = v.n + (v.trusted ? min : 0);
        if (!best || score > best.score) best = { word: word, n: v.n, trusted: v.trusted, score: score };
      });
      return best;
    }
  };
}
var WORD_SPLIT = /([^\p{L}\p{N}'’]+)/u;
function wordsOf(title) { return String(title).split(WORD_SPLIT).filter(function(w) { return /\p{L}/u.test(w) && w.length >= 3; }); }
// "JOGA" -> "JÓGA", "joga" -> "jóga", "Joga" -> "Jóga"
function matchCase(word, like) {
  if (like === like.toUpperCase() && like !== like.toLowerCase()) return word.toUpperCase();
  if (like === like.toLowerCase()) return word.toLowerCase();
  if (like[0] === like[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

var WEAK_PLATFORM = new Set(["yt", "sc"]);
var TRUSTED_PLATFORM = new Set(["yt:topic", "sc:meta"]);
var ALL_PLATFORM = new Set(["yt", "sc", "yt:topic", "sc:meta"]);
function onlyFrom(sp, set) {
  if (!sp.sources.size) return false;
  for (var s of sp.sources) if (!set.has(s)) return false;
  return true;
}
function uploadUrl(up) { return up[0] === "1" ? "https://youtu.be/" + up.slice(1) : up[0] === "2" ? "https://api.soundcloud.com/tracks/" + up.slice(1) : up; }

function compatible(a, b) {
  if (a.keys.title === b.keys.title) return true;
  var sameArtist = a.keys.artist === b.keys.artist || overlap(artistSets(a).full, artistSets(b).full);
  var s = tags.similarity(a.keys.title, b.keys.title);
  if (sameArtist && (s >= 0.6 || a.keys.title.indexOf(b.keys.title) !== -1 || b.keys.title.indexOf(a.keys.title) !== -1)) return true;
  // the artist and title swapped, or the whole tag in one field
  if (a.keys.title.indexOf(b.keys.artist) !== -1 && b.keys.artist.length > 3 && (a.keys.title.indexOf(b.keys.title) !== -1)) return true;
  return s >= 0.85;
}
function artistSets(sp) {
  if (sp._sets) return sp._sets;
  var primary = sp.keys.artist.split("+").filter(Boolean);
  var featured = sp.parsed.featured.map(tags.artistKeyOf);
  sp._sets = { primary: primary, full: primary.concat(featured) };
  return sp._sets;
}
function subset(a, b) { return a.length > 0 && a.every(function(x) { return b.indexOf(x) !== -1; }); }
function overlap(a, b) { return a.some(function(x) { return b.indexOf(x) !== -1; }); }
function push(map, k, v) { var l = map.get(k); if (l) l.push(v); else map.set(k, [v]); }
function distinctBy(list, fn) {
  var seen = new Set();
  return list.filter(function(x) { var k = fn(x); if (seen.has(k)) return false; seen.add(k); return true; });
}
function pairKey(a, b) { return a < b ? a + "\u0002" + b : b + "\u0002" + a; }
function nearest(sorted, x) {
  if (!sorted || !sorted.length) return Infinity;
  var lo = 0;
  var hi = sorted.length - 1;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
  var d = Math.abs(sorted[lo] - x);
  if (lo > 0) d = Math.min(d, Math.abs(sorted[lo - 1] - x));
  return d;
}

module.exports = { reconcile: reconcile, naiveToUtc: naiveToUtc, shiftedToUtc: shiftedToUtc, pairKey: pairKey };
