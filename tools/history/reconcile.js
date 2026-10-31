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
var ZONES = ["UTC", "America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin"];
for (var off = -12; off <= 14; off++) if (off) ZONES.push(off);

var SOURCE_DJ_RANK = ["fb:playLog", "fb:songHistory", "fb:newMusic", "adam", "fb:globalTracks"];
function djRank(src) {
  var i = SOURCE_DJ_RANK.indexOf(src);
  return i === -1 ? 99 : i;
}
function isLastfm(src) { return src.slice(0, 7) === "lastfm:"; }

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
    if (!artistDisplay.has(k)) artistDisplay.set(k, new Map());
    artistDisplay.get(k).set(res.name, (artistDisplay.get(k).get(res.name) || 0) + 1);
    artistSeen.set(k, (artistSeen.get(k) || 0));
  });
  readAliasCsv(path.join(opts.dir, "artist-aliases.csv")).forEach(function(p) { aliasPair(p[0], p[1], "artist-aliases.csv"); });
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
    var bestW = -1;
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
  var zone = opts.adamTz != null && opts.adamTz !== "auto" ? (isNaN(Number(opts.adamTz)) ? opts.adamTz : Number(opts.adamTz)) : null;
  var precise = new Map(); // root -> sorted times of non-ADAM plays
  obsList.forEach(function(o) {
    if (o[3] || !o[2] || o[1] !== "play") return;
    var root = o[6] && uploadRoot.has(o[6]) ? uploadRoot.get(o[6]) : uf.find(o[0]);
    push(precise, root, o[2]);
  });
  precise.forEach(function(l) { l.sort(function(a, b) { return a - b; }); });
  var tzReport = null;
  if (zone == null) {
    var sample = [];
    for (var oi = 0; oi < obsList.length && sample.length < 30000; oi++) {
      var o2 = obsList[oi];
      if (!o2[3] || !o2[2]) continue;
      var r2 = uf.find(o2[0]);
      if (precise.has(r2)) sample.push([r2, o2[2]]);
    }
    var scores = ZONES.map(function(z) {
      var hits = 0;
      sample.forEach(function(s) { if (nearest(precise.get(s[0]), naiveToUtc(s[1], z)) <= 5 * MIN) hits++; });
      return [z, hits];
    }).sort(function(a, b) { return b[1] - a[1]; });
    zone = sample.length && scores[0][1] >= 20 ? scores[0][0] : 0;
    tzReport = { sample: sample.length, best: scores.slice(0, 3), chosen: zone };
    log("  ADAM clock: " + (zone === 0 ? "UTC (not enough overlap to tell)" : zone) + " (" + (scores[0] ? scores[0][1] : 0) + " of " + sample.length + " stamps line up)");
  }

  // ------------------------------------------------------------ events
  log("lining up plays...");
  var djNames = new Map();
  db.prepare("SELECT source, id, name FROM dj_names").all().forEach(function(r) { djNames.set(r.source + ":" + r.id, r.name); });
  var djAlias = new Map();
  readAliasCsv(path.join(opts.dir, "dj-aliases.csv")).forEach(function(p) { djAlias.set(p[0].toLowerCase(), p[1]); });
  var djDisplay = new Map(); // key -> Map(display -> n)
  function djOf(raw, src) {
    if (!raw) return null;
    raw = String(raw).trim();
    var name = djNames.get((src.indexOf("fb:") === 0 ? "fb" : src) + ":" + raw) || djNames.get("fb:" + raw) || raw;
    if (src === "adam" && /^\d+$/.test(raw)) name = djNames.get("adam:" + raw) || name;
    name = djAlias.get(name.toLowerCase()) || name;
    var k = name.toLowerCase();
    if (!djDisplay.has(k)) djDisplay.set(k, new Map());
    djDisplay.get(k).set(name, (djDisplay.get(k).get(name) || 0) + 1);
    return k;
  }

  var events = new Map(); // root -> [[at, src, role, dj, up]]
  obsList.forEach(function(o) {
    if (!o[2] || o[1] === "tag") return;
    var at = o[3] ? naiveToUtc(o[2], zone) : o[2];
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
  // the same name with its accents back wins over the stripped one
  artistDisplay.forEach(function(displays, k) {
    var c = artistMap.get(k) || k;
    var cur = bestArtistName.get(c);
    displays.forEach(function(n, name) {
      if (nonAsciiCount(name) > nonAsciiCount(cur.name) && (tags.fold(name) === tags.fold(cur.name) || skeleton(name) === tags.squash(cur.name))) {
        cur = { name: name, score: cur.score };
      }
    });
    bestArtistName.set(c, cur);
  });

  // tag-exceptions.csv: artists ("Artist") or songs ("Artist - Title") never to tidy
  var exceptions = { artists: new Set(), tracks: new Set() };
  var exFile = path.join(opts.dir, "tag-exceptions.csv");
  if (fs.existsSync(exFile)) {
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
  }

  var accentFixes = [];
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
    var restoredFrom = [];
    // accents: the same words with their letters back, from any spelling
    members.forEach(function(si) {
      var sp = spellings[si];
      if (nonAsciiCount(sp.title) > nonAsciiCount(title) && (tags.fold(sp.title) === tags.fold(title) || skeleton(sp.title) === tags.squash(title) && usableSkeleton(sp.title, skeleton(sp.title)))) {
        title = sp.title; restoredFrom.push(Array.from(sp.sources).join("+"));
      }
    });
    var aBest = chosen.parsed.artists.length === 1 ? bestArtistName.get(chosen.keys.artist) : null;
    if (aBest && nonAsciiCount(aBest.name) > nonAsciiCount(artist) &&
        (tags.fold(aBest.name) === tags.fold(artist) || skeleton(aBest.name) === tags.squash(artist))) {
      artist = aBest.name; restoredFrom.push("artist");
    }
    if (artist !== chosen.artist || title !== chosen.title) accentFixes.push({ from: chosen.artist + " - " + chosen.title, to: artist + " - " + title, sources: restoredFrom.join("; ") });

    var nonWeak = members.filter(function(si) { return !spellings[si].weak; });
    var anchorKey = nonWeak.length ? nonWeak.map(function(si) { return spellings[si].raw.track; }).sort()[0]
      : "upload:" + (Array.from(uploadRoot.entries()).find(function(e) { return e[1] === root; }) || [spellings[members[0]].raw.track])[0];
    var id = "t" + tags.hash(anchorKey);
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
    if (aBest && chosen.parsed.artists.length === 1 && !chosen.parsed.featured.length) {
      if (tags.artistKeyOf(tidyJunk.artist) === tags.artistKeyOf(aBest.name) || artistMap.get(tags.artistKeyOf(tidyJunk.artist)) === chosen.keys.artist) tidyJunk.artist = aBest.name;
      if (tags.artistKeyOf(tidyRsn.artist) === tags.artistKeyOf(aBest.name) || artistMap.get(tags.artistKeyOf(tidyRsn.artist)) === chosen.keys.artist) tidyRsn.artist = aBest.name;
    }
    trackRows.push({
      id: id, root: root, artist: artist, title: title,
      version: chosen.parsed.versions.filter(function(v) { return v.kind; }).map(function(v) { return v.text; }).join(", "),
      spellings: members.length, keys: Array.from(keys), weak: !nonWeak.length, conf: conf,
      tidyJunk: tidyJunk, tidyRsn: tidyRsn, protected: isProtected
    });
  });
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
  function djName(k) {
    if (!k) return null;
    var d = djDisplay.get(k);
    if (!d) return k;
    var best = null;
    var n = -1;
    d.forEach(function(c, name) { if (c > n) { n = c; best = name; } });
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
    store.setState(db, "reconcile", {
      at: Date.now(), zone: zone, tz: tzReport, window: windowMs / MIN, conflicts: conflicts,
      accentFixes: accentFixes.length, seconds: Math.round((Date.now() - started) / 1000)
    });
  });
  fs.mkdirSync(opts.dir, { recursive: true });
  csv.writeCsv(path.join(opts.dir, "restore_accents.csv"), ["from", "to", "sources"], accentFixes);

  var summary = {
    observations: obsList.length, spellings: spellings.length, tracks: trackRows.length, songs: songMembers.size,
    uploads: uploadRows.length, plays: playRows.length, djs: djStats.size, merges: merges.length,
    artistAliases: aliasReasons.length, review: review.length, accentFixes: accentFixes.length, adamClock: zone,
    seconds: Math.round((Date.now() - started) / 1000)
  };
  log("  " + JSON.stringify(summary));
  return summary;
}

var WEAK_PLATFORM = new Set(["yt", "sc"]);
var TRUSTED_PLATFORM = new Set(["yt:topic", "sc:meta"]);
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

module.exports = { reconcile: reconcile, naiveToUtc: naiveToUtc, pairKey: pairKey };
