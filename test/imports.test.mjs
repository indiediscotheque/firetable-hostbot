// Importing a list of songs (lib/imports.js) against an in-memory database,
// with the lookups faked. No emulators needed:
//   cd test && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { fakeDb } from "./fake-db.mjs";

const require = createRequire(import.meta.url);
const imports = require("../lib/imports.js");
const tags = require("../lib/tags.js");

const keyOf = (a, t) => tags.hash(tags.keysOf(tags.parse(a, t)).track);
const NOW = 1_800_000_000_000;

// The room knows two songs: one with a YouTube Music audio track and a
// SoundCloud upload, one with only a music video.
function room() {
  return {
    globalSongKeys: { [keyOf("Khruangbin", "Maria También")]: "tKH", [keyOf("Poolside", "Harvest Moon")]: "tPO" },
    globalSongs: { tKH: { artist: "Khruangbin", title: "María También", plays: 12 }, tPO: { artist: "Poolside", title: "Harvest Moon", plays: 3 } },
    globalTracks: {
      "1khaudio0001": { song: "tKH", artist: "Khruangbin", title: "Maria Tambien", last_play_date: 20 },
      "1khgone00001": { song: "tKH", artist: "Khruangbin", title: "Maria Tambien", last_play_date: 30 },
      "2123456": { song: "tKH", artist: "Khruangbin", title: "Maria Tambien", last_play_date: 10 },
      "1poolvideo01": { song: "tPO", artist: "Poolside", title: "Harvest Moon (Official Video)", last_play_date: 5 }
    }
  };
}

// verify: khgone00001 is gone (missing), the rest play; the lookup knows a
// few songs; SoundCloud's search knows one
function deps(db, seen = {}) {
  return {
    db,
    now: () => NOW,
    verify: async (cids) => {
      (seen.verify = seen.verify || []).push(...cids);
      const known = { khaudio0001: { audio: true, dur: 245 }, poolvideo01: { audio: false, dur: 280 }, poolaudio01: { audio: true, dur: 270 } };
      return Object.fromEntries(cids.filter((c) => known[c]).map((c) => [c, known[c]]));
    },
    lookup: async (items, opts) => {
      (seen.lookup = seen.lookup || []).push(...items.map((i) => i.name + (i.audio ? " (audio)" : " (video)")));
      const songs = {
        "Poolside - Harvest Moon": [{ cid: "poolaudio01", artist: "Poolside", title: "Harvest Moon", dur: 270, audio: true, src: "ytm" }],
        "Men I Trust - Show Me How": [{ cid: "mitaudio0001", artist: "Men I Trust", title: "Show Me How", dur: 215, audio: true, src: "library" },
          { cid: "mitvideo0001", artist: "Men I Trust", title: "Show Me How", dur: 230, audio: false, src: "web", channel: "Men I Trust" }],
        "Busy - Song": []
      };
      return { picks: items.map((i) => songs[i.name] || []), looked: items.map((i) => i.name !== "Busy - Song") };
    },
    scSearch: async () => [{ cid: "999", title: "Men I Trust - Show Me How", user: "Men I Trust", dur: 215, url: "https://soundcloud.com/menitrust/show-me-how", img: "https://i1.sndcdn.com/a.jpg" }],
    log: () => {}
  };
}

const job = (items, format = "ytm") => ({ items: items.map(([a, t, d]) => (d ? { a, t, d } : { a, t })), format, status: "new", at: NOW });

test("items are cleaned and capped", () => {
  const items = imports.itemsOf({ items: { 1: { a: " B ", t: "Two" }, 0: { a: "", t: "Just a title", d: 99999 } } });
  assert.deepEqual(items, [{ a: "", t: "Just a title", d: 0, name: "Just a title" }, { a: "B", t: "Two", d: 0, name: "B - Two" }]);
  assert.equal(imports.itemsOf({ items: Array.from({ length: 900 }, () => ({ a: "A", t: "T" })) }).length, imports.MAX_ITEMS);
});

test("a YouTube Music list: the room's audio track first, then the free lookups", async () => {
  const db = fakeDb(Object.assign(room(), { importJobs: { eve: { j1: job([["khruangbin", "maria tambien"], ["Poolside", "Harvest Moon"], ["Men I Trust", "Show Me How"], ["Nobody", "Knows This"], ["Busy", "Song"]]) } } }));
  const seen = {};
  const stats = await imports.createImports(deps(db, seen)).runJob("eve", "j1");
  const out = db.get("importJobs/eve/j1");
  assert.equal(out.status, "done");
  assert.equal(out.n, 5);
  const r = out.results;
  // played here: the latest upload that still plays (the newer one is gone), named the room's way
  assert.equal(r[0].s, "room");
  assert.deepEqual(r[0].picks, [{ type: 1, cid: "khaudio0001", artist: "Khruangbin", title: "María También", src: "room", dur: 245, kind: "a", plays: 12 }]);
  // the room has only a video: a YouTube Music song first, the room's video stays a choice
  assert.equal(r[1].s, "song");
  assert.deepEqual(r[1].picks.map((p) => p.cid + ":" + p.src), ["poolaudio01:ytm", "poolvideo01:room"]);
  assert.equal(r[2].s, "song");
  assert.equal(r[2].picks[0].cid, "mitaudio0001");
  assert.equal(r[3].s, "none");
  assert.deepEqual(r[3].picks ?? [], []);
  assert.equal(r[4].s, "later", "the lookup ran out of searches: looked up later, not 'not found'");
  // only what the room didn't have went to the lookup
  assert.deepEqual(seen.lookup, ["Poolside - Harvest Moon (audio)", "Men I Trust - Show Me How (audio)", "Nobody - Knows This (audio)", "Busy - Song (audio)"]);
  assert.deepEqual(seen.verify.sort(), ["khaudio0001", "khgone00001", "poolvideo01"]);
  assert.equal(stats.found, 3);
  assert.equal(stats.room, 1);
});

test("a list kept to videos never takes an audio track", async () => {
  const db = fakeDb(Object.assign(room(), { importJobs: { eve: { j2: job([["Khruangbin", "Maria Tambien"], ["Poolside", "Harvest Moon"], ["Men I Trust", "Show Me How"]], "video") } } }));
  const seen = {};
  await imports.createImports(deps(db, seen)).runJob("eve", "j2");
  const r = db.get("importJobs/eve/j2/results");
  assert.equal(r[0].s, "none", "the room's only playable upload is an audio track");
  assert.equal(r[1].s, "room");
  assert.equal(r[1].picks[0].cid, "poolvideo01");
  assert.deepEqual(r[2].picks.map((p) => p.cid), ["mitvideo0001"]);
  assert.equal(r[2].s, "video");
  assert.ok(seen.lookup.every((n) => n.endsWith("(video)")));
});

test("a SoundCloud list: the room's SoundCloud upload, else SoundCloud's search", async () => {
  const db = fakeDb(Object.assign(room(), { importJobs: { eve: { j3: job([["Khruangbin", "Maria Tambien"], ["Men I Trust", "Show Me How", 215]], "sc") } } }));
  const seen = {};
  await imports.createImports(deps(db, seen)).runJob("eve", "j3");
  const r = db.get("importJobs/eve/j3/results");
  assert.equal(r[0].s, "room");
  assert.deepEqual(r[0].picks[0], { type: 2, cid: "123456", artist: "Khruangbin", title: "María También", src: "room", kind: "sc", plays: 12 });
  assert.equal(r[1].s, "sc");
  assert.equal(r[1].picks[0].url, "https://soundcloud.com/menitrust/show-me-how");
  assert.equal(seen.lookup, undefined, "no YouTube lookups for a SoundCloud list");
  assert.equal(seen.verify, undefined);
});

test("a cancelled job stops; a job that isn't new is left alone", async () => {
  const items = Array.from({ length: 25 }, (_, i) => ["Nobody", "Song " + i]);
  const db = fakeDb(Object.assign(room(), { importJobs: { eve: { j4: job(items), j5: Object.assign(job(items), { status: "done" }) } } }));
  const d = deps(db);
  const lookup = d.lookup;
  let calls = 0;
  d.lookup = async (it, o) => {
    // the site deletes the job while the first ten are looked up
    if (++calls === 1) await db.ref("importJobs/eve/j4").set(null);
    return lookup(it, o);
  };
  const imp = imports.createImports(d);
  assert.equal(await imp.runJob("eve", "j4"), null);
  assert.equal(db.get("importJobs/eve/j4"), null, "nothing written back to a deleted job");
  assert.equal(calls, 1);
  assert.equal(await imp.runJob("eve", "j5"), null);
});

test("start() picks up new jobs in order, and old ones are cleared", async () => {
  const db = fakeDb(Object.assign(room(), { importJobs: { bob: { old: Object.assign(job([["A", "B"]]), { at: NOW - 2 * 24 * 3600 * 1000, status: "done" }) } } }));
  const imp = imports.createImports(deps(db));
  imp.start();
  await imp.prune();
  assert.equal(db.get("importJobs/bob/old"), null);
  await db.ref("importJobs/eve/k1").set(job([["Poolside", "Harvest Moon"]]));
  await db.ref("importJobs/eve/k2").set(job([["Men I Trust", "Show Me How"]]));
  for (let i = 0; i < 20 && db.get("importJobs/eve/k2/status") !== "done"; i++) await imp.idle();
  assert.equal(db.get("importJobs/eve/k1/status"), "done");
  assert.equal(db.get("importJobs/eve/k2/results/0/s"), "song");
});

// ---- Spotify playlists (1.21)
const fakeSpotify = (playlists, opts = {}) => ({
  configured: () => opts.configured !== false,
  check: async () => opts.ok !== false,
  playlist: async (id) => {
    if (playlists[id]) return playlists[id];
    throw Object.assign(new Error("not shared"), { code: "gone" });
  }
});

test("a Spotify playlist: its songs, name and owner go into the job, then each is found", async () => {
  const db = fakeDb(Object.assign(room(), { importJobs: { eve: {
    s1: { spotify: "6rqhFgbbKwnb9MLmUQDhG6", format: "ytm", status: "new", at: NOW },
    s2: { spotify: "37i9dQZF1DXcBWIGoYBM5M", format: "ytm", status: "new", at: NOW } } } }));
  const d = deps(db);
  d.spotify = fakeSpotify({ "6rqhFgbbKwnb9MLmUQDhG6": { name: "Night Drive", by: "Chris", total: 3, skipped: 1,
    tracks: [{ a: "Khruangbin", t: "María También", d: 245 }, { a: "Men I Trust", t: "Show Me How", d: 215 }] } });
  const imp = imports.createImports(d);
  await imp.runJob("eve", "s1");
  const job = db.get("importJobs/eve/s1");
  assert.equal(job.status, "done");
  assert.equal(job.name, "Night Drive");
  assert.equal(job.by, "Chris");
  assert.equal(job.skipped, 1);
  assert.deepEqual(job.items, [{ a: "Khruangbin", t: "María También", d: 245 }, { a: "Men I Trust", t: "Show Me How", d: 215 }]);
  assert.equal(job.results[0].s, "room");
  assert.equal(job.results[1].s, "song");
  // one Spotify won't share: a note that says why
  await imp.runJob("eve", "s2");
  const no = db.get("importJobs/eve/s2");
  assert.equal(no.status, "failed");
  assert.match(no.note, /private, or one of Spotify's own mixes/);
  assert.equal(no.items, undefined);
});

test("without working Spotify keys: a Spotify job fails with a note, and the site isn't offered Spotify", async () => {
  const db = fakeDb(Object.assign(room(), { discover: { caps: { spotify: true } }, importJobs: { eve: { s3: { spotify: "6rqhFgbbKwnb9MLmUQDhG6", format: "ytm", status: "new", at: NOW } } } }));
  const d = deps(db);
  d.spotify = fakeSpotify({}, { configured: false });
  const imp = imports.createImports(d);
  await imp.runJob("eve", "s3");
  assert.equal(db.get("importJobs/eve/s3/status"), "failed");
  assert.match(db.get("importJobs/eve/s3/note"), /isn't working on the room's bot/);
  assert.equal(await imp.publishCaps(), false);
  assert.equal(db.get("discover/caps/spotify"), null);
  // keys that work: offered
  const d2 = deps(db);
  d2.spotify = fakeSpotify({});
  assert.equal(await imports.createImports(d2).publishCaps(), true);
  assert.equal(db.get("discover/caps/spotify"), true);
});
