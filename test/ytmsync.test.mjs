// The YOUTUBE MUSIC playlist sync (lib/ytmsync.js) against an in-memory
// database and fake YouTube answers. No emulators needed:
//   cd test && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ytmsync = require("../lib/ytmsync.js");
const ytmusic = require("../lib/ytmusic.js");
const fixture = require("./fixtures/ytmusic.js");

// ------------------------------------------------------------ helpers

test("isMixed: DJ-mixed compilation tracks, not remixes or songs called Mixed", () => {
  const mixed = [
    { title: "Observer Effect (DJ-Kicks) (Mixed)", album: "DJ-Kicks: Disclosure" },
    { title: "Can’t Get Enough (Monte Remix / Mixed)", album: "Club Exotica" },
    { title: "The Truth (Moullinex & Xinobi Re-Imagine) [Mixed]", album: "Global Underground: Select #9 (Mixed)" },
    { title: "Let Them Bells Ring", album: "fabric presents Confidence Man (Mixed)" },
    { title: "Crystal Lover", album: "Meat Me Down The Disco (Mixed by Horse Meat Disco)" },
    { title: "The Girls Say (Greg Wilson Version)", album: "Lost Village, Vol. 1 (Continuous Mix by Jaymo & Andy George)" },
    { title: "Shades Of Black", album: "Let The Children Techno (Compiled and Mixed by Busy P & DJ Mehdi)" },
    { title: "Curious (Le Flex Remix) (Soleil Mix Edit - Mixed)", album: "Kitsuné Soleil Mix by Cesare" },
    { title: "Do It to the Max", album: "Optimo : The Underground Sound of Glasgow (Mixed By Jd Twitch)" },
    { title: "Some Song", album: "Ibiza Sessions (DJ Mix)" }
  ];
  const fine = [
    { title: "Moment With God (Perel Remix)", album: "Percepticide: Remixed" },
    { title: "Skyline (Remixed)", album: "Black Gold Sun Remixed" },
    { title: "Mixed Emotions", album: "Time Flies" },
    { title: "All of Me", album: "Mixed Emotions" },
    { title: "Mixed Signals (Radio Edit)", album: "Mixed Signals" },
    { title: "Labyrinth (Extended Mix)", album: "Cafe Mambo Ibiza 2012 (Unmixed DJ Format)" },
    { title: "Disco Dracula", album: "Fierce Angel Presents the Collection II (Dj Edition Unmixed)" },
    { title: "Regatta", album: "Anjunadeep 03 (Unmixed & DJ Ready) (iTunes)" },
    { title: "Grace (Hercules Club Mix)", album: "Mixed In Amber" },
    { title: "Both Of Us", album: "No Substance Mixtape" },
    { title: "Disco Odyssey (Beethoven Remixed)", album: "" }
  ];
  for (const t of mixed) assert.equal(ytmsync.isMixed(t), true, t.title + " | " + t.album);
  for (const t of fine) assert.equal(ytmsync.isMixed(t), false, t.title + " | " + t.album);
});

test("playlist ids from links, and the year playlists by default", () => {
  assert.equal(ytmsync.playlistIdOf("https://music.youtube.com/playlist?list=PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN&si=60gNrUd4LeIgbh_q"), "PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN");
  assert.equal(ytmsync.playlistIdOf("PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN"), "PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN");
  assert.equal(ytmsync.playlistIdOf("not a playlist!"), "");
  assert.equal(ytmsync.parseSources("").length, 26);
  assert.deepEqual(ytmsync.SOURCES.map((s) => s.year), Array.from({ length: 26 }, (_, i) => 2026 - i));
  assert.deepEqual(ytmsync.parseSources("2027=https://music.youtube.com/playlist?list=PLabcdefghij1234&si=x, PLzyxwvutsr98765"),
    [{ year: 2027, id: "PLabcdefghij1234" }, { year: 0, id: "PLzyxwvutsr98765" }]);
});

test("pushTime reads when a push key was made", () => {
  const at = Date.UTC(2024, 4, 1, 12);
  assert.equal(ytmsync.pushTime(pushKey(at)), at);
  assert.equal(ytmsync.pushTime("track1"), 0);
  assert.equal(ytmsync.pushTime("zzzzzzzzzzzzzzzzzzzz"), 0); // far future: not a real one
});

test("nameOf: artist from the row or the Topic channel", () => {
  assert.equal(ytmsync.nameOf("Young Franco, EARTHGANG & Jafunk", "Lose Control"), "Young Franco, EARTHGANG & Jafunk - Lose Control");
  assert.equal(ytmsync.nameOf("Chromeo - Topic", "100%"), "Chromeo - 100%");
  assert.equal(ytmsync.nameOf("Various Artists - Topic", "Song"), "Song");
});

const entry = (id, name, dur, extra) => Object.assign({ id, type: 1, cid: id, ident: ytmsync.identity(name), dur, added: 0, order: 0, available: true, deliberate: false }, extra);

test("duplicates: the same song within a few seconds, or the same upload; the earliest playable copy stays", () => {
  const list = [
    entry("a", "Daft Punk - One More Time", 320, { added: 3 }),
    entry("b", "Daft Punk - One More Time", 322, { added: 1, available: false }), // earliest, but can't play
    entry("c", "Daft Punk - One More Time", 330, { added: 2 }), // 10 s longer: another recording
    entry("d", "Daft Punk feat. Romanthony - One More Time", 321, { added: 4 }),
    entry("e", "Chromeo - 100%", 281, { added: 5 }),
    entry("e2", "Chromeo - 100%", 0, { cid: "e", added: 6 }), // same upload
    entry("f", "Dina Summer - Promise Me", 225, { added: 7 }),
    entry("g", "Dina Summer - Promise Me [Club Version]", 343, { added: 8 }),
    entry("h", "Other Band - One More Time", 320, { added: 9 }) // another artist's song
  ];
  // a (the earliest that plays) stays for One More Time; c is 10 s longer
  assert.deepEqual(ytmsync.duplicates(list, 3).sort(), ["b", "d", "e2"]);
  // a copy someone flagged (off-theme) is the one kept, so the flag stays
  const flagged = [entry("x", "Some Band - Some Song", 200, { added: 1 }), entry("y", "Some Band - Some Song", 201, { added: 2, available: false, deliberate: true })];
  assert.deepEqual(ytmsync.duplicates(flagged, 3), ["x"]);
});

test("sameSong: an unknown length only counts when loose and the version is spelled the same", () => {
  const a = entry("a", "Dina Summer - Promise Me", 0);
  const b = entry("b", "Dina Summer - Promise Me", 225);
  const c = entry("c", "Dina Summer - Promise Me [Club Version]", 343);
  assert.equal(ytmsync.sameSong(a, b, 3), false);
  assert.equal(ytmsync.sameSong(a, b, 3, true), true);
  assert.equal(ytmsync.sameSong(a, c, 3, true), false);
});

// ------------------------------------------------------- playlist pages

// A playlist page as music.youtube.com sends it from a server outside the
// US: rows greyed out, no links, columns title / artists / length / album.
const greyRow = (cid, title, artists, dur, album) => ({ musicResponsiveListItemRenderer: {
  flexColumns: [title, artists, Math.floor(dur / 60) + ":" + String(dur % 60).padStart(2, "0"), album].map((t) =>
    ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: t }] } } })),
  playlistItemData: { playlistSetVideoId: "X", videoId: cid },
  musicItemRendererDisplayPolicy: "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT" } });
const page1 = (rows, token) => ({
  header: { musicResponsiveHeaderRenderer: { title: { runs: [{ text: "2001 | Indie Discotheque" }] } } },
  contents: { twoColumnBrowseResultsRenderer: { secondaryContents: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: {
    contents: rows.concat(token ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token, request: "CONTINUATION_REQUEST_TYPE_BROWSE" } } } }] : []) } }] } } } }
});
const pageN = (rows, token) => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: {
  continuationItems: rows.concat(token ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } }] : []) } }] });

test("playlist pages: rows, the next page's token, and the last page", () => {
  const p = page1([greyRow("fa5IWHDbftI", "One More Time", "Daft Punk", 321, "Discovery")], "tok2");
  assert.deepEqual(ytmusic.parsePlaylistPage(p).map((r) => [r.cid, r.title, r.artist, r.album, r.dur]),
    [["fa5IWHDbftI", "One More Time", "Daft Punk", "Discovery", 321]]);
  assert.equal(ytmusic.nextPageToken(p), "tok2");
  const n = pageN([greyRow("kh1Ilq8U9Jk", "100%", "Chromeo", 281, "Fancy Footwork")]);
  assert.equal(ytmusic.parsePlaylistPage(n)[0].artist, "Chromeo");
  assert.equal(ytmusic.nextPageToken(n), "");
});

test("playlistTracks reads every page", async () => {
  const realFetch = global.fetch;
  const bodies = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const json = body.browseId ? page1([greyRow("aaaaaaaaaa1", "Song A", "Band", 200, "LP")], "tok2")
      : pageN([greyRow("aaaaaaaaaa2", "Song B", "Band & Friend", 210, "LP"), greyRow("aaaaaaaaaa1", "Song A", "Band", 200, "LP")]);
    return new Response(JSON.stringify(json), { status: 200 });
  };
  try {
    const r = await ytmusic.playlistTracks("PLtest123456", { delayMs: 0 });
    assert.equal(r.title, "2001 | Indie Discotheque");
    assert.deepEqual(r.tracks.map((t) => t.cid), ["aaaaaaaaaa1", "aaaaaaaaaa2"]);
    assert.equal(bodies[0].browseId, "VLPLtest123456");
    assert.equal(bodies[1].continuation, "tok2");
  } finally {
    global.fetch = realFetch;
  }
});

// ------------------------------------------------------------- the sync

// Firebase push keys (the time, then random characters), so tests can say
// when a track joined a list.
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
let pushCount = 0;
function pushKey(ms) {
  let out = "";
  for (let i = 7; i >= 0; i--) { out = PUSH_CHARS.charAt(ms % 64) + out; ms = Math.floor(ms / 64); }
  let n = pushCount++;
  let tail = "";
  for (let i = 0; i < 12; i++) { tail = PUSH_CHARS.charAt(n % 64) + tail; n = Math.floor(n / 64); }
  return out + tail;
}

// An in-memory Realtime Database: refs with once/set/push/child/transaction.
function fakeDb(data, hooks = {}) {
  const root = { v: data };
  const parts = (p) => String(p || "").split("/").filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), root.v) ?? null;
  const put = (p, val) => {
    const ks = parts(p);
    let o = root;
    let k = "v";
    for (const part of ks) {
      if (!o[k] || typeof o[k] !== "object") o[k] = {};
      o = o[k];
      k = part;
    }
    if (val === null || val === undefined) delete o[k]; else o[k] = JSON.parse(JSON.stringify(val));
  };
  const snap = (p, val) => ({
    key: parts(p).pop() || null,
    val: () => (val == null ? null : JSON.parse(JSON.stringify(val))),
    forEach(cb) { Object.keys(val || {}).sort().some((k) => cb(snap(p + "/" + k, val[k]))); }
  });
  const ref = (p) => ({
    key: parts(p).pop() || null,
    toString: () => "https://db.test/" + parts(p).join("/"),
    child: (c) => ref(p + "/" + c),
    once: async () => snap(p, get(p)),
    set: async (v) => { if (hooks.refuse && hooks.refuse.test(p)) throw new Error("PERMISSION_DENIED"); put(p, v); },
    push() { return ref(p + "/" + pushKey(Date.now())); },
    async transaction(fn) {
      if (hooks.beforeTransaction) hooks.beforeTransaction(p);
      // Firebase may first call with no cached value, then the real one
      let out = fn(null);
      const cur = get(p);
      if (cur !== null) out = fn(JSON.parse(JSON.stringify(cur)));
      if (out === undefined) return { committed: false, snapshot: snap(p, cur) };
      put(p, out);
      return { committed: true, snapshot: snap(p, get(p)) };
    }
  });
  return { ref, data: () => root.v, get };
}

const BOT = "bot1";
const T0 = Date.UTC(2026, 10, 8, 5);
const VIDEO = (dur, channel, title, problem = 0) => ({ problem, dur, title, channel });

function setup(extra = {}) {
  const k = (n) => pushKey(Date.UTC(2023, 0, n));
  const keys = { a: k(1), b: k(2), c: k(3), d: k(4), e: k(5), f: k(6), g: k(7), sc: k(8) };
  const list = {
    [keys.a]: { type: 1, cid: "kpdead00001", name: "Radiohead - Karma Police" }, // gone: replaced
    [keys.b]: { type: 1, cid: "offtheme001", name: "Some Band - Off Theme", flagged: { date: 1, code: 10 } }, // someone's call: left alone
    [keys.c]: { type: 1, cid: "omt00000001", name: "Daft Punk - One More Time" },
    [keys.d]: { type: 1, cid: "omt00000002", name: "Daft Punk - One More Time" }, // later copy, 1 s longer: goes
    [keys.e]: { type: 1, cid: "lose0000001", name: "Lose Control" }, // saved by its title only
    [keys.f]: { type: 1, cid: "nomatch0001", name: "Nobody - Unfindable Song" }, // gone, no copy anywhere: flagged, kept
    [keys.g]: { type: 1, cid: "omt00000001", name: "Daft Punk - One More Time (copy)" }, // the same upload again: goes
    [keys.sc]: { type: 2, cid: "123456", name: "SC Artist - Old Song", flagged: { date: 1, code: 4 }, duration: 200 } // gone from SoundCloud: replaced
  };
  const videos = {
    offtheme001: VIDEO(0, "", "", 2),
    omt00000001: VIDEO(320, "Daft Punk - Topic", "One More Time"),
    omt00000002: VIDEO(321, "Daft Punk", "One More Time"),
    omt00000003: VIDEO(321, "Daft Punk - Topic", "One More Time"),
    lose0000001: VIDEO(157, "Young Franco - Topic", "Lose Control"),
    kpstudio001: VIDEO(262, "Radiohead - Topic", "Karma Police"),
    kpmixed0001: VIDEO(262, "Radiohead - Topic", "Karma Police (Mixed)"),
    oldsong0001: VIDEO(200, "SC Artist - Topic", "Old Song"),
    chromeo0001: VIDEO(281, "Chromeo - Topic", "100%"),
    bells000001: VIDEO(249, "Confidence Man - Topic", "Let Them Bells Ring"),
    blocked0001: VIDEO(200, "X - Topic", "Blocked", 3),
    ...(extra.videos || {})
  };
  const catalog = [
    { cid: "kpmixed0001", title: "Karma Police (Mixed)", artists: ["Radiohead"], album: "Some DJ Session (Mixed)", dur: 262 },
    { cid: "kpstudio001", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", dur: 262 },
    { cid: "oldsong0001", title: "Old Song", artists: ["SC Artist"], album: "Old", dur: 200 }
  ];
  const playlists = {
    PL2001aaaaaa: { title: "2001 | Indie Discotheque", tracks: [
      { cid: "omt00000001", title: "One More Time", artist: "Daft Punk", album: "Discovery", dur: 320 }, // already there
      { cid: "chromeo0001", title: "100%", artist: "Chromeo", album: "Fancy Footwork", dur: 281 }, // new
      { cid: "bells000001", title: "Let Them Bells Ring", artist: "Confidence Man", album: "fabric presents Confidence Man (Mixed)", dur: 249 }, // DJ-mixed
      { cid: "omt00000003", title: "One More Time", artist: "Daft Punk", album: "Discovery", dur: 321 } // another upload of a song it has
    ] },
    PL2002bbbbbb: { title: "2002 | Indie Discotheque", tracks: [
      { cid: "blocked0001", title: "Blocked", artist: "X", album: "Y", dur: 200 }, // can't play here
      { cid: "chromeo0001", title: "100%", artist: "Chromeo", album: "Fancy Footwork", dur: 281 },
      { cid: "gone0000001", title: "Gone", artist: "X", album: "Y", dur: 200 } // YouTube doesn't know it
    ] }
  };
  const db = fakeDb({ playlists: { [BOT]: { other: { name: "Other list", list: { x: { type: 1, cid: "zzz", name: "untouched" } } },
    ytm1: { name: "YOUTUBE MUSIC", list } } } }, extra.hooks);
  const searches = [];
  const calls = { videos: 0 };
  const sync = ytmsync.createSync({
    db,
    botid: () => BOT,
    shallowKeys: async (p) => Object.keys(db.get(p) || {}),
    videos: async (ids) => {
      calls.videos++;
      assert.ok(ids.length <= 50);
      if (extra.youtubeDown) throw new Error("quota exceeded");
      const out = {};
      ids.forEach((id) => { if (videos[id]) out[id] = videos[id]; });
      return out;
    },
    playlist: async (id) => {
      if (!playlists[id]) throw new Error("YouTube Music has no playlist " + id);
      return playlists[id];
    },
    search: async (q) => {
      searches.push(q);
      const words = q.toLowerCase();
      const all = ytmusic.parseSearch(fixture.answer(catalog.filter((r) => words.includes(r.title.toLowerCase().replace(/ \(.*$/, "")))));
      return { songs: ytmusic.songsOnly(all), any: all.length };
    },
    sources: extra.sources || [{ year: 2002, id: "PL2002bbbbbb" }, { year: 2001, id: "PL2001aaaaaa" }],
    now: () => T0,
    delayMs: 0,
    random: extra.random,
    log: () => {}
  });
  const tracks = () => db.get("playlists/" + BOT + "/ytm1/list") || {};
  return { db, sync, keys, tracks, searches, calls };
}

test("a sync replaces broken tracks, adds new songs, removes duplicates and shuffles", async () => {
  const { db, sync, keys, tracks, searches } = setup();
  const before = Object.keys(tracks());
  const s = await sync.run({ reason: "test" });
  const after = tracks();
  const byCid = Object.fromEntries(Object.entries(after).map(([k, t]) => [t.cid, Object.assign({ key: k }, t)]));

  // broken tracks: the same recording from YouTube Music, never the DJ-mixed one
  assert.ok(byCid.kpstudio001, "Karma Police got its YouTube Music copy");
  assert.equal(byCid.kpstudio001.name, "Radiohead - Karma Police");
  assert.deepEqual(byCid.kpstudio001.swappedFrom, { type: 1, cid: "kpdead00001", date: T0 });
  assert.equal(byCid.kpstudio001.flagged, undefined);
  assert.equal(byCid.kpstudio001.duration, 262);
  assert.ok(!byCid.kpmixed0001, "the DJ-mixed copy is never used");
  assert.ok(byCid.oldsong0001, "a SoundCloud track that's gone gets a YouTube Music copy too");
  assert.equal(byCid.oldsong0001.type, 1);
  assert.deepEqual(byCid.oldsong0001.swappedFrom, { type: 2, cid: "123456", date: T0 });

  // no match: kept, and flagged so the bot skips it
  assert.ok(byCid.nomatch0001, "a broken track with no match stays");
  assert.deepEqual(byCid.nomatch0001.flagged, { date: T0, code: 2 });
  // flagged by someone: exactly as it was
  assert.deepEqual(byCid.offtheme001.flagged, { date: 1, code: 10 });
  assert.equal(byCid.offtheme001.name, "Some Band - Off Theme");

  // duplicates: the earliest copy stays
  assert.ok(byCid.omt00000001 && !byCid.omt00000002 && !byCid.omt00000003, "one One More Time, the earliest");
  assert.equal(byCid.omt00000001.name, "Daft Punk - One More Time", "the first of two copies of the same upload stays");
  // the year playlists: new songs in, DJ-mixed and unplayable ones out
  assert.ok(byCid.chromeo0001, "a new song is added");
  assert.equal(byCid.chromeo0001.name, "Chromeo - 100%");
  assert.equal(byCid.chromeo0001.duration, 281);
  assert.equal(byCid.chromeo0001.added, T0);
  assert.ok(!byCid.bells000001, "DJ-mixed compilation tracks aren't added");
  assert.ok(!byCid.blocked0001 && !byCid.gone0000001, "tracks that can't play here aren't added");
  // a track saved by its title alone gets its artist
  assert.equal(byCid.lose0000001.name, "Young Franco - Lose Control");
  assert.equal(byCid.lose0000001.duration, 157, "a working track's length is saved with it");
  assert.equal(byCid.offtheme001.duration, undefined, "a flagged track gets nothing");

  assert.equal(Object.keys(after).length, 7);
  // every track knows when it joined, so "the earliest" survives the shuffle
  assert.equal(byCid.omt00000001.added, ytmsync.pushTime(keys.c));
  for (const t of Object.values(after)) assert.ok(t.added > 0);
  // the old slots are reused (plus one new one): a shuffle, not a rewrite
  assert.ok(before.filter((k) => after[k]).length >= 5);

  assert.equal(s.replaced, 2);
  assert.equal(s.noMatch, 1);
  assert.equal(s.flagged, 1);
  assert.equal(s.added, 1);
  assert.equal(s.mixed, 1);
  assert.equal(s.duplicates, 1);
  assert.equal(s.upgraded, 1, "the later One More Time was a video: the audio track already there stands in for it");
  assert.equal(s.videosLeft, 0);
  assert.equal(s.named, 1);
  assert.equal(s.total, 7);
  assert.equal(s.shuffled, 7);
  assert.ok(!s.failed);
  assert.match(ytmsync.summary(s), /2 broken tracks replaced, 1 with no match yet \(kept, 1 newly flagged\); 1 new song from 2 year playlists \(1 DJ-mixed skipped\); 1 video swapped for YouTube Music tracks; 1 duplicate removed/);
  assert.deepEqual(searches.sort(), ["Nobody Unfindable Song", "Radiohead Karma Police", "SC Artist Old Song"]);

  // the bot's other playlists aren't touched; the searches are remembered
  assert.deepEqual(db.get("playlists/" + BOT + "/other/list"), { x: { type: 1, cid: "zzz", name: "untouched" } });
  assert.ok(Object.keys(db.get("swapCache") || {}).length >= 2);
  assert.equal(db.get("ytmSync/ok"), true);
  assert.equal(db.get("ytmSync/at"), T0);
});

test("a second sync adds nothing new and searches nothing again", async () => {
  const { sync, tracks, searches } = setup();
  await sync.run();
  const first = Object.values(tracks()).map((t) => t.cid).sort();
  const n = searches.length;
  const s = await sync.run();
  assert.deepEqual(Object.values(tracks()).map((t) => t.cid).sort(), first);
  // found or not, a search is remembered; only one YouTube Music answered
  // with nothing at all (maybe an outage) is tried again
  assert.deepEqual(searches.slice(n), ["Nobody Unfindable Song"], "searches come from the cache");
  assert.equal(s.added, 0);
  assert.equal(s.duplicates, 0);
  assert.equal(s.replaced, 0);
  assert.equal(s.noMatch, 1, "the track with no match is still waiting");
  assert.equal(s.flagged, 0, "and isn't flagged again");
});

test("the shuffle changes the order every sync", async () => {
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const { sync, tracks } = setup({ random });
  await sync.run();
  const order1 = Object.keys(tracks()).sort().map((k) => tracks()[k].cid).join();
  await sync.run();
  const order2 = Object.keys(tracks()).sort().map((k) => tracks()[k].cid).join();
  assert.notEqual(order1, order2);
});

test("when YouTube can't answer, nothing changes", async () => {
  const { sync, tracks } = setup({ youtubeDown: true });
  const before = JSON.stringify(tracks());
  const s = await sync.run();
  assert.equal(s.failed, true);
  assert.match(ytmsync.summary(s), /stopped before changing anything: quota exceeded/);
  assert.equal(JSON.stringify(tracks()), before);
});

test("a playlist that can't be read is skipped; the rest still sync", async () => {
  const { sync, tracks } = setup({ sources: [{ year: 2001, id: "PL2001aaaaaa" }, { year: 1999, id: "PLmissing000" }] });
  const s = await sync.run();
  assert.equal(s.sourceErrors, 1);
  assert.equal(s.sources, 1);
  assert.ok(Object.values(tracks()).some((t) => t.cid === "chromeo0001"));
});

test("a track the bot moves or changes during a sync is left as it is", async () => {
  let fx;
  const hooks = {
    beforeTransaction(p) {
      if (!/ytm1\/list$/.test(p)) return;
      // the bot plays Karma Police's slot meanwhile: it now holds another track
      const list = fx.db.get("playlists/" + BOT + "/ytm1/list");
      list[fx.keys.a] = { type: 1, cid: "newtrack001", name: "Someone - New" };
    }
  };
  fx = setup({ hooks });
  await fx.sync.run();
  const after = fx.tracks();
  const cids = Object.values(after).map((t) => t.cid);
  assert.ok(cids.includes("newtrack001"), "the track the bot put there stays");
  assert.ok(!cids.includes("kpstudio001"), "the replacement isn't forced over it");
});

test("the playlist is made when the bot has none by that name", async () => {
  const db = fakeDb({ playlists: { [BOT]: { other: { name: "Other", list: {} } } } });
  const sync = ytmsync.createSync({
    db, botid: () => BOT, shallowKeys: async (p) => Object.keys(db.get(p) || {}),
    videos: async (ids) => Object.fromEntries(ids.map((id) => [id, VIDEO(200, "Band - Topic", "Song " + id)])),
    playlist: async () => ({ title: "2001", tracks: [{ cid: "song0000001", title: "Song", artist: "Band", album: "LP", dur: 200 }] }),
    search: async () => ({ songs: [], any: 0 }), sources: [{ year: 2001, id: "PLx" }], delayMs: 0, now: () => T0
  });
  const s = await sync.run();
  assert.equal(s.created, true);
  const lists = db.get("playlists/" + BOT);
  const made = Object.keys(lists).find((k) => lists[k].name === "YOUTUBE MUSIC");
  assert.ok(made);
  assert.deepEqual(Object.values(lists[made].list).map((t) => t.name), ["Band - Song"]);
  // and is found by name next time, in any case
  lists[made].name = "youtube music";
  const s2 = await sync.run();
  assert.equal(s2.created, false);
});

test("track(): a track the bot just flagged gets its YouTube Music copy in place", async () => {
  const { db, sync, keys } = setup();
  await sync.findList();
  const ref = db.ref("playlists/" + BOT + "/ytm1/list");
  assert.equal(sync.isList(ref), true);
  assert.equal(sync.isList(db.ref("playlists/" + BOT + "/other/list")), false);
  db.get("playlists/" + BOT + "/ytm1/list")[keys.a].flagged = { date: 5, code: 2 };
  assert.equal(await sync.track(ref, keys.a), true);
  const t = db.get("playlists/" + BOT + "/ytm1/list/" + keys.a);
  assert.equal(t.cid, "kpstudio001");
  assert.equal(t.flagged, undefined);
  // someone's own flag isn't touched
  assert.equal(await sync.track(ref, keys.b), false);
  assert.equal(db.get("playlists/" + BOT + "/ytm1/list/" + keys.b).cid, "offtheme001");
});

test("videos become YouTube Music tracks; a video with none yet stays", async () => {
  const k = (n) => pushKey(Date.UTC(2022, 0, n));
  const keys = { mv: k(1), title: k(2), none: k(3), have: k(4), atv: k(5), off: k(6) };
  const db = fakeDb({ playlists: { [BOT]: { ytm: { name: "YOUTUBE MUSIC", list: {
    [keys.mv]: { type: 1, cid: "kpvideo0001", name: "Radiohead - Karma Police (Official Video)" }, // a music video: swapped
    [keys.title]: { type: 1, cid: "omtvideo001", name: "One More Time" }, // a video saved by its title: artist from the channel
    [keys.none]: { type: 1, cid: "rarevideo01", name: "Tiny Band - Rare Song" }, // no audio track anywhere: stays
    [keys.have]: { type: 1, cid: "lfvideo0001", name: "Young Franco - Lose Control (Official Video)" }, // its audio track is in the list
    [keys.atv]: { type: 1, cid: "lose0000001", name: "Young Franco - Lose Control" },
    [keys.off]: { type: 1, cid: "offvideo001", name: "Radiohead - No Surprises", flagged: { date: 1, code: 10 } } // flagged: left alone
  } } } } });
  const videos = {
    kpvideo0001: VIDEO(290, "RadioheadVEVO", "Radiohead - Karma Police (Official Video)"), // 28 s of intro
    omtvideo001: VIDEO(330, "DaftPunkVEVO", "Daft Punk - One More Time (Official Video)"),
    rarevideo01: VIDEO(200, "Tiny Band", "Rare Song"),
    lfvideo0001: VIDEO(170, "Young Franco", "Lose Control (Official Video)"),
    lose0000001: VIDEO(157, "Young Franco - Topic", "Lose Control"),
    offvideo001: VIDEO(229, "Radiohead", "No Surprises"),
    kpstudio001: VIDEO(262, "Radiohead - Topic", "Karma Police"),
    omtstudio01: VIDEO(320, "Daft Punk - Topic", "One More Time"),
    nsstudio001: VIDEO(229, "Radiohead - Topic", "No Surprises"),
    bvideo00001: VIDEO(250, "BandVEVO", "Band - Hit (Official Video)"),
    bstudio0001: VIDEO(245, "Band - Topic", "Hit")
  };
  const catalog = [
    { cid: "kpstudio001", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", dur: 262 },
    { cid: "omtstudio01", title: "One More Time", artists: ["Daft Punk"], album: "Discovery", dur: 320 },
    { cid: "nsstudio001", title: "No Surprises", artists: ["Radiohead"], album: "OK Computer", dur: 229 },
    { cid: "bstudio0001", title: "Hit", artists: ["Band"], album: "LP", dur: 245 },
    { cid: "lose0000001", title: "Lose Control", artists: ["Young Franco"], album: "Lose Control", dur: 157 }
  ];
  const searches = [];
  const sync = ytmsync.createSync({
    db, botid: () => BOT, shallowKeys: async (p) => Object.keys(db.get(p) || {}),
    videos: async (ids) => Object.fromEntries(ids.filter((id) => videos[id]).map((id) => [id, videos[id]])),
    playlist: async () => ({ title: "2010", tracks: [{ cid: "bvideo00001", title: "Hit (Official Video)", artist: "Band", album: "", dur: 250 }] }),
    search: async (q) => {
      searches.push(q);
      const all = ytmusic.parseSearch(fixture.answer(catalog.filter((r) => q.toLowerCase().includes(r.title.toLowerCase()))));
      return { songs: ytmusic.songsOnly(all), any: all.length || 1 };
    },
    sources: [{ year: 2010, id: "PL2010" }], delayMs: 0, now: () => T0
  });
  const s = await sync.run();
  const list = db.get("playlists/" + BOT + "/ytm/list");
  const cids = Object.values(list).map((t) => t.cid).sort();
  const byCid = Object.fromEntries(Object.values(list).map((t) => [t.cid, t]));
  assert.deepEqual(cids, ["bstudio0001", "kpstudio001", "lose0000001", "offvideo001", "omtstudio01", "rarevideo01"]);
  assert.equal(byCid.kpstudio001.name, "Radiohead - Karma Police", "the audio track's own name, without (Official Video)");
  assert.deepEqual(byCid.kpstudio001.swappedFrom, { type: 1, cid: "kpvideo0001", date: T0 });
  assert.equal(byCid.kpstudio001.added, ytmsync.pushTime(keys.mv), "it keeps the video's place in time");
  assert.equal(byCid.omtstudio01.name, "Daft Punk - One More Time");
  assert.ok(searches.includes("DaftPunk One More Time") || searches.includes("Daft Punk One More Time"));
  assert.equal(byCid.bstudio0001.name, "Band - Hit", "a video from a year playlist comes in as its audio track");
  assert.equal(byCid.bstudio0001.swappedFrom, undefined);
  assert.deepEqual(byCid.offvideo001.flagged, { date: 1, code: 10 }, "a flagged video is left alone");
  assert.equal(byCid.rarevideo01.name, "Tiny Band - Rare Song", "a video with no audio track stays");
  assert.equal(s.upgraded, 4);
  assert.equal(s.videosLeft, 1);
  assert.match(ytmsync.summary(s), /4 videos swapped for YouTube Music tracks \(1 with none yet\)/);
});

test("duplicates: a YouTube Music track is kept over an earlier video", () => {
  const list = [
    entry("v", "Some Band - Night Drive", 200, { added: 1 }),
    entry("a", "Some Band - Night Drive", 201, { added: 2, audio: true })
  ];
  assert.deepEqual(ytmsync.duplicates(list, 3), ["v"]);
});

test("channelArtist and isTopic", () => {
  assert.equal(ytmsync.channelArtist("DaftPunkVEVO"), "DaftPunk");
  assert.equal(ytmsync.channelArtist("Radiohead - Topic"), "Radiohead");
  assert.equal(ytmsync.channelArtist("Band Official"), "Band");
  assert.equal(ytmsync.isTopic("Chromeo - Topic"), true);
  assert.equal(ytmsync.isTopic("Chromeo"), false);
});

// ------------------------------------- the swap search's sources (lookup)

test("with the swap search's lookup: broken tracks get YouTube Music audio tracks even when YouTube Music's search is dead", async () => {
  const swaps = require("../lib/swaps.js");
  const k = (n) => pushKey(Date.UTC(2021, 0, n));
  const keys = { lib: k(1), list: k(2), vid: k(3), none: k(4), stale: k(5), manual: k(6), off: k(7) };
  const db = fakeDb({ playlists: { [BOT]: { ytm: { name: "YOUTUBE MUSIC", list: {
    [keys.lib]: { type: 1, cid: "kpdead00001", name: "Radiohead - Karma Police", duration: 262, flagged: { date: 1, code: 2 } }, // in a year playlist under another upload
    [keys.list]: { type: 1, cid: "nsdead00001", name: "Radiohead - No Surprises", duration: 229 }, // gone: a YouTube playlist has its audio track
    [keys.vid]: { type: 1, cid: "lcdead00001", name: "Phoenix - Lisztomania", duration: 241 }, // gone: only a music video anywhere
    [keys.none]: { type: 1, cid: "nomatch0001", name: "Nobody - Unfindable Song", duration: 200 },
    [keys.stale]: { type: 1, cid: "playsnow001", name: "Chromeo - Night By Night", flagged: { date: 1, code: 3 }, swap: { cid: "x" } }, // blocked once, plays now
    [keys.manual]: { type: 1, cid: "manual00001", name: "Band - Garbled", flagged: { date: 1, code: 8 } }, // a mod's "broken": stays flagged
    [keys.off]: { type: 1, cid: "offtheme001", name: "Some Band - Off Theme", flagged: { date: 1, code: 10 } }
  } } } } });
  const videos = {
    kpstudio001: { problem: 0, dur: 262, title: "Karma Police", channel: "Radiohead - Topic", audio: true },
    nsstudio001: { problem: 0, dur: 229, title: "No Surprises", channel: "Radiohead - Topic", audio: true },
    lcvideo0001: { problem: 0, dur: 245, title: "Phoenix - Lisztomania (Official Video)", channel: "PhoenixVEVO", audio: false },
    playsnow001: { problem: 0, dur: 230, title: "Night By Night", channel: "Chromeo - Topic", audio: true },
    manual00001: { problem: 0, dur: 200, title: "Garbled", channel: "Band - Topic", audio: true },
    offtheme001: { problem: 0, dur: 200, title: "Off Theme", channel: "Some Band - Topic", audio: true }
  };
  const verify = async (ids) => Object.fromEntries(ids.filter((id) => videos[id]).map((id) => [id, videos[id]]));
  const swapper = swaps.createSwapper({
    db, shallowKeys: async () => [], delayMs: 0, now: () => T0, log: () => {},
    search: async () => { const res = ytmusic.parseSearch(fixture.answer([])); return { songs: [], any: res.length, catalog: 0 }; }, // "No results" for everything
    library: async () => [{ cid: "kpstudio001", artist: "Radiohead", title: "Karma Police", dur: 262, kind: "MUSIC_VIDEO_TYPE_ATV" }],
    playlistSearch: async (q) => (/Surprises|Lisztomania/.test(q) ? [{ id: "PLfan" + q.length, title: q }] : []),
    playlist: async () => ({ tracks: [
      { cid: "nsstudio001", artist: "Radiohead", title: "No Surprises", dur: 229 },
      { cid: "lcvideo0001", artist: "Phoenix", title: "Lisztomania", dur: 245 }
    ] }),
    webSearch: async (q) => (/Lisztomania/.test(q) ? [{ cid: "lcvideo0001", title: "Phoenix - Lisztomania (Official Video)", channel: "PhoenixVEVO", dur: 245 }] : []),
    verify
  });
  const sync = ytmsync.createSync({
    db, botid: () => BOT, shallowKeys: async (p) => Object.keys(db.get(p) || {}),
    videos: async (ids) => verify(ids),
    playlist: async () => ({ title: "2010", tracks: [] }),
    search: async () => { throw new Error("not used with lookup"); },
    lookup: (items, o) => swapper.lookup(items, o),
    sources: [{ year: 2010, id: "PL2010" }], delayMs: 0, now: () => T0, log: () => {}
  });
  const s = await sync.run();
  const list = db.get("playlists/" + BOT + "/ytm/list");
  const byCid = Object.fromEntries(Object.values(list).map((t) => [t.cid, t]));
  assert.ok(byCid.kpstudio001, "found in the year playlists");
  assert.equal(byCid.kpstudio001.flagged, undefined);
  assert.deepEqual(byCid.kpstudio001.swappedFrom, { type: 1, cid: "kpdead00001", date: T0 });
  assert.ok(byCid.nsstudio001, "found in a YouTube playlist");
  assert.ok(!byCid.lcvideo0001, "a music video is never put in");
  assert.deepEqual(byCid.lcdead00001.flagged, { date: T0, code: 2 }, "no audio track: kept, flagged");
  assert.ok(byCid.nomatch0001.flagged);
  assert.equal(byCid.playsnow001.flagged, undefined, "an automatic flag on a track that plays again is cleared");
  assert.equal(byCid.playsnow001.swap, undefined);
  assert.deepEqual(byCid.manual00001.flagged, { date: 1, code: 8 }, "a mod's flag stays");
  assert.deepEqual(byCid.offtheme001.flagged, { date: 1, code: 10 });
  assert.equal(s.replaced, 2);
  assert.equal(s.unflagged, 1);
  assert.equal(s.noMatch, 3);
  assert.deepEqual(s.from, { room: 0, library: 1, twin: 0, ytm: 0, lists: 1, web: 0, artist: 0, album: 0, api: 0 });
  assert.match(ytmsync.summary(s), /2 broken tracks replaced \(found in 1 year playlists, 1 YouTube playlists\)/);
  assert.match(ytmsync.summary(s), /1 track that play again unflagged/);
  assert.match(ytmsync.summary(s), /2 tracks wait for the next sync/, "what no source could answer is tried again");
  const line = "YOUTUBE MUSIC (daily at 5:00): " + ytmsync.brief(s);
  assert.ok(line.length <= 240, line);
  assert.match(line, /2 broken tracks replaced, 3 still broken, 1 unflagged/);

  // the next sync reuses what was learned: nothing is searched again for the found ones
  const s2 = await sync.run();
  assert.equal(s2.replaced, 0);
  assert.equal(s2.noMatch, 3);
  assert.ok(s2.remembered >= 1, "the song no source had an audio track for is remembered, not searched again");
});

test("track() with the lookup: a freshly flagged track gets its audio track straight away", async () => {
  const swaps = require("../lib/swaps.js");
  const key = pushKey(Date.UTC(2021, 0, 1));
  const db = fakeDb({ playlists: { [BOT]: { ytm: { name: "YOUTUBE MUSIC", list: {
    [key]: { type: 1, cid: "kpdead00001", name: "Radiohead - Karma Police", duration: 262, flagged: { date: 5, code: 2 } } } } } } });
  const verify = async (ids) => Object.fromEntries(ids.filter((id) => id === "kpstudio001").map((id) => [id, { problem: 0, dur: 262, audio: true, channel: "Radiohead - Topic" }]));
  const swapper = swaps.createSwapper({ db, shallowKeys: async () => [], delayMs: 0, now: () => T0, verify,
    library: async () => [{ cid: "kpstudio001", artist: "Radiohead", title: "Karma Police", dur: 262, kind: "MUSIC_VIDEO_TYPE_ATV" }] });
  const sync = ytmsync.createSync({ db, botid: () => BOT, shallowKeys: async (p) => Object.keys(db.get(p) || {}), videos: verify,
    playlist: async () => ({ tracks: [] }), lookup: (items, o) => swapper.lookup(items, o), sources: [], now: () => T0 });
  await sync.findList();
  assert.equal(await sync.track(db.ref("playlists/" + BOT + "/ytm/list"), key), true);
  assert.equal(db.get("playlists/" + BOT + "/ytm/list/" + key).cid, "kpstudio001");
});

// ------------------------------- more free ways to find audio tracks

const panel = (cid, title, artist, dur, kind) => ({ playlistPanelVideoRenderer: { videoId: cid, title: { runs: [{ text: title }] },
  longBylineText: { runs: [{ text: artist, navigationEndpoint: { browseEndpoint: { browseId: "UCx", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } }] },
  lengthText: { runs: [{ text: Math.floor(dur / 60) + ":" + String(dur % 60).padStart(2, "0") }] },
  navigationEndpoint: { watchEndpoint: { videoId: cid, watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_" + kind } } } } } });
const watchAnswer = (items) => ({ contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [{ tabRenderer: { content: {
  musicQueueRenderer: { content: { playlistPanelRenderer: { contents: items } } } } } }] } } } } });
const twinAnswer = (video, audio) => watchAnswer([{ playlistPanelVideoWrapperRenderer: {
  primaryRenderer: panel(video, "Karma Police (Official Video)", "Radiohead", 290, "OMV"),
  counterpart: [{ counterpartRenderer: panel(audio, "Karma Police", "Radiohead", 262, "ATV") }] } },
  panel("othersong01", "Creep", "Radiohead", 238, "ATV")]);

test("the Song / Video toggle: a music video's audio track", () => {
  const t = ytmusic.parseCounterpart(twinAnswer("kpvideo0001", "kpstudio001"), "kpvideo0001");
  assert.deepEqual([t.cid, t.title, t.artist, t.dur, t.kind], ["kpstudio001", "Karma Police", "Radiohead", 262, "MUSIC_VIDEO_TYPE_ATV"]);
  assert.equal(ytmusic.parseCounterpart(watchAnswer([panel("lonely00001", "Song", "Band", 200, "OMV")]), "lonely00001"), null, "no toggle: none");
  assert.equal(ytmusic.parseCounterpart(twinAnswer("kpvideo0001", "kpstudio001"), "someoneelse"), null, "another video's toggle doesn't count");
});

const twoRow = (id, title) => ({ musicTwoRowItemRenderer: { title: { runs: [{ text: title }] }, navigationEndpoint: { browseEndpoint: { browseId: id } } } });
const carousel = (title, items) => ({ musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: title }] } } }, contents: items } });

test("artist pages, album pages, the web app's session and Apple's songs", () => {
  const search = fixture.answer([{ cid: "kpvideo0001", title: "Karma Police", artists: ["Radiohead"], dur: 290, kind: "OMV", label: "Video" }]);
  assert.deepEqual(ytmusic.parseArtists(search), [{ id: "UC9", name: "Radiohead" }], "artists linked from a song row");
  const page = { header: { musicImmersiveHeaderRenderer: { title: { runs: [{ text: "Radiohead" }] } } }, contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { musicShelfRenderer: { contents: [fixture.row({ cid: "creep000001", title: "Creep", artists: [], dur: 238 })] } },
    carousel("Albums", [twoRow("MPREokc", "OK Computer"), twoRow("MPREbends", "The Bends")]),
    carousel("Singles & EPs", [twoRow("MPREkp", "Karma Police")]),
    carousel("Videos", [twoRow("MPREno", "Not a release")])
  ] } } } }] } } };
  const a = ytmusic.parseArtistPage(page);
  assert.equal(a.name, "Radiohead");
  assert.deepEqual(a.releases, [{ id: "MPREokc", title: "OK Computer", kind: "album" }, { id: "MPREbends", title: "The Bends", kind: "album" }, { id: "MPREkp", title: "Karma Police", kind: "single" }]);
  assert.deepEqual(a.songs.map((s) => [s.cid, s.artist]), [["creep000001", "Radiohead"]], "top songs, with the artist's name");
  const album = { contents: { twoColumnBrowseResultsRenderer: {
    tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicResponsiveHeaderRenderer: { title: { runs: [{ text: "OK Computer" }] },
      straplineTextOne: { runs: [{ text: "Radiohead", navigationEndpoint: { browseEndpoint: { browseId: "UCr", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } }] } } }] } } } }],
    secondaryContents: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [fixture.row({ cid: "kpstudio001", title: "Karma Police", artists: [], dur: 262 })] } }] } } } },
    microformat: { microformatDataRenderer: { urlCanonical: "x" } }, background: { audioPlaylistId: "OLAK5uy_okcomputer00000" } };
  const al = ytmusic.parseAlbum(album);
  assert.deepEqual([al.title, al.artist, al.playlistId], ["OK Computer", "Radiohead", "OLAK5uy_okcomputer00000"]);
  assert.deepEqual(al.tracks.map((t) => [t.cid, t.artist, t.album, t.dur]), [["kpstudio001", "Radiohead", "OK Computer", 262]]);
  assert.deepEqual(ytmusic.parseSession('<script>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"1.20261111.01.00","VISITOR_DATA":"CgtBQkNE%3D%3D"})</script>'),
    { version: "1.20261111.01.00", visitorData: "CgtBQkNE%3D%3D" });
  const apple = require("../lib/apple.js");
  assert.deepEqual(apple.parseSongs({ results: [
    { kind: "song", artistName: "Radiohead", trackName: "Karma Police", collectionName: "OK Computer", trackTimeMillis: 264067, trackExplicitness: "notExplicit" },
    { kind: "music-video", artistName: "Radiohead", trackName: "Karma Police" }
  ] }), [{ artist: "Radiohead", title: "Karma Police", album: "OK Computer", dur: 264, explicit: false }]);
});

test("searchSongs: 'No results' gets a fresh session, then the other app, before the full search", async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    url = String(url);
    if (url === "https://music.youtube.com/") { calls.push("home"); return new Response('"INNERTUBE_CLIENT_VERSION":"1.20991231.00.00","VISITOR_DATA":"CgtmcmVzaA%3D%3D"', { status: 200 }); }
    const body = JSON.parse(init.body);
    const who = body.context.client.clientName + (body.params ? ":songs" : ":all");
    calls.push(who + "@" + body.context.client.clientVersion);
    const songs = [{ cid: "kpstudio001", title: "Karma Police", artists: ["Radiohead"], dur: 262 }];
    return new Response(JSON.stringify(fixture.answer(body.context.client.clientName === "ANDROID_MUSIC" ? songs : [])), { status: 200 });
  };
  try {
    const r = await ytmusic.searchSongs("Radiohead Karma Police");
    assert.equal(r.songs[0].cid, "kpstudio001");
    assert.equal(r.via, "android");
    assert.deepEqual(calls.map((c) => c.replace(/@.*/, "")), ["WEB_REMIX:songs", "home", "WEB_REMIX:songs", "ANDROID_MUSIC:songs"]);
    assert.match(calls[2], /@1\.20991231\.00\.00$/, "the web app's current version from its page");
  } finally {
    global.fetch = realFetch;
  }
});

test("lookup: the Song / Video toggle, artist pages, and Apple's album pointing at its YouTube Music playlist", async () => {
  const swaps = require("../lib/swaps.js");
  const db = fakeDb({});
  const audio = { kpstudio001: 262, nsstudio001: 229, lcstudio001: 241, hsstudio001: 200 };
  const verify = async (ids) => Object.fromEntries(ids.filter((id) => audio[id]).map((id) => [id, { problem: 0, dur: audio[id], audio: true }]));
  const asked = { twin: [], apple: [], lists: [], album: [] };
  const sw = swaps.createSwapper({
    db, shallowKeys: async () => [], delayMs: 0, appleDelayMs: 0, twinDelayMs: 0, now: () => T0, log: () => {}, verify,
    search: async () => ({ songs: [], any: 0, catalog: 0 }),
    webSearch: async (q) => (/No Surprises/.test(q) ? [{ cid: "nsvideo0001", title: "Radiohead - No Surprises (Official Video)", channel: "RadioheadVEVO", dur: 235 }] : [{ cid: "junk0000001", title: "something", channel: "x", dur: 1 }]),
    counterpart: async (cid) => {
      asked.twin.push(cid);
      return { kpvideo0001: { cid: "kpstudio001", artist: "Radiohead", title: "Karma Police", dur: 262, kind: "MUSIC_VIDEO_TYPE_ATV" },
        nsvideo0001: { cid: "nsstudio001", artist: "Radiohead", title: "No Surprises", dur: 229, kind: "MUSIC_VIDEO_TYPE_ATV" } }[cid] || null;
    },
    artists: async (name) => [{ id: "UC" + name, name }],
    artistPage: async (id) => (id === "UCPhoenix" ? { name: "Phoenix", songs: [], releases: [{ id: "MPRElisz", title: "Lisztomania", kind: "single" }] } : { name: "", songs: [], releases: [] }),
    album: async (id) => { asked.album.push(id); return { title: "Lisztomania", tracks: [{ cid: "lcstudio001", artist: "Phoenix", title: "Lisztomania", dur: 241, kind: "MUSIC_VIDEO_TYPE_ATV" }] }; },
    apple: async (q) => { asked.apple.push(q); return /Hidden/.test(q) ? [{ artist: "Quiet Band", title: "Hidden Song", album: "Deep Cuts", dur: 200 }] : []; },
    playlistSearch: async (q) => { asked.lists.push(q); return /Deep Cuts/.test(q) ? [{ id: "PLfan00000001", title: "fan" }, { id: "OLAK5uy_deepcuts0000000", title: "Album - Deep Cuts" }] : []; },
    playlist: async (id) => ({ tracks: id === "OLAK5uy_deepcuts0000000" ? [{ cid: "hsstudio001", artist: "Quiet Band", title: "Hidden Song", dur: 200, kind: "MUSIC_VIDEO_TYPE_ATV" }] : [] })
  });
  const r = await sw.lookup([
    { name: "Radiohead - Karma Police", dur: 290, slack: 60, uploads: [{ type: 1, cid: "kpvideo0001", live: true }] }, // a video that plays: its toggle
    { name: "Radiohead - No Surprises", dur: 229, uploads: [{ type: 1, cid: "nsdead00001" }] }, // gone: the toggle of the official video YouTube finds
    { name: "Phoenix - Lisztomania", dur: 241, uploads: [{ type: 1, cid: "lcdead00001" }] }, // the single on the artist's page
    { name: "Quiet Band - Hidden Song", dur: 200, uploads: [{ type: 1, cid: "hsdead00001" }] } // Apple: on "Deep Cuts", whose YouTube Music playlist has it
  ]);
  assert.deepEqual(r.picks.map((p) => p[0] && p[0].cid), ["kpstudio001", "nsstudio001", "lcstudio001", "hsstudio001"]);
  assert.deepEqual(r.picks.map((p) => p[0].src), ["twin", "twin", "album", "album"]);
  assert.deepEqual(asked.twin.slice(0, 2), ["kpvideo0001", "nsvideo0001"]);
  assert.ok(!asked.album.includes("OLAK5uy_deepcuts0000000") && asked.lists.some((q) => /Quiet Band Deep Cuts/.test(q)), "Apple's album is found as its playlist");
  assert.equal(r.stats.from.twin, 2);
  assert.equal(r.stats.from.album, 2);
  assert.match(swaps.summary(r.stats), /Song \/ Video toggle/);
});
