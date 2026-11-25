// lib/repeats.js: no song twice in a few hours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { fakeDb } from "./fake-db.mjs";
const { createRepeats, nameKey, span } = createRequire(import.meta.url)("../lib/repeats.js");

const HOUR = 3600000;
const T0 = 1_800_000_000_000;

// A DJ's list for firstPlayable: the indexed query (unflagged first, in key
// order) and pages by key, counting what each reads.
function listRef(tracks) {
  const keys = Object.keys(tracks).sort();
  const snap = (ks) => ({
    numChildren: () => ks.length,
    forEach(cb) { ks.some((k) => cb({ key: k, val: () => tracks[k] })); }
  });
  const ref = { reads: 0 };
  ref.orderByChild = () => ({ endAt: () => ({ limitToFirst: (n) => ({ once: async () => {
    ref.reads++;
    return snap(keys.filter((k) => !(tracks[k].flagged && tracks[k].flagged.date)).slice(0, n));
  } }) }) });
  ref.orderByKey = () => {
    let after = null;
    const q = {
      startAfter: (k) => { after = k; return q; },
      limitToFirst: (n) => ({ once: async () => { ref.reads++; return snap(keys.filter((k) => after === null || k > after).slice(0, n)); } })
    };
    return q;
  };
  return ref;
}

function setup(data = {}, hours = 4) {
  let now = T0;
  const db = fakeDb(data);
  const r = createRepeats({ db: () => db, now: () => now, hours });
  return { db, r, later: (ms) => { now += ms; }, now: () => now };
}
const yt = (cid, name, extra) => Object.assign({ type: 1, cid, name: name || "Art - " + cid }, extra);
const playing = (cid, artist, title, started, dj) => ({ type: 1, cid, artist, title, started, djname: dj || "dj2" });

test("nameKey: the same song across uploads, nothing for names without Artist - Title", () => {
  assert.equal(nameKey("Röyksopp - Running to the Sea (Official Video)"), "royksopp running to the sea");
  assert.equal(nameKey("ROYKSOPP – Running To The Sea [HD]"), "royksopp running to the sea");
  assert.equal(nameKey("Röyksopp - Running to the Sea feat. Susanne Sundfør"), "royksopp running to the sea");
  assert.equal(nameKey("Simon & Garfunkel - Cecilia (2011 Remaster)"), "simon and garfunkel cecilia");
  assert.notEqual(nameKey("Art - Song (Someone Remix)"), nameKey("Art - Song"), "a remix is another track");
  assert.equal(nameKey("Intro"), "");
  assert.equal(nameKey(""), "");
  assert.equal(nameKey(null), "");
});

test("span: hours and minutes", () => {
  assert.equal(span(65 * 60000), "1 hr 5 min");
  assert.equal(span(40 * 60000), "40 min");
  assert.equal(span(2 * HOUR), "2 hr");
  assert.equal(span(1000), "1 min");
});

test("a play is remembered for 4 hours, by upload and by song, and saved for the site", async () => {
  const { db, r, later } = setup();
  await r.played(playing("a1", "Art", "Song", T0, "dj2"));
  const saved = db.get("playedRecently/1a1");
  assert.deepEqual(saved, { w: T0, u: T0 + 4 * HOUR, n: "art song", dj: "dj2" });
  assert.ok(r.lately(yt("a1", "Whatever - Else")), "same upload");
  assert.ok(r.lately(yt("other", "ART - Song (Official Audio)")), "another upload of the song");
  assert.equal(r.lately(yt("b1", "Art - Other Song")), null);
  later(4 * HOUR - 1000);
  assert.ok(r.lately(yt("a1")), "still within the hours");
  later(2000);
  assert.equal(r.lately(yt("a1")), null, "over 4 hours: plays again");
  await r.played(playing("c1", "C", "D", T0 + 4 * HOUR + 1000));
  assert.equal(db.get("playedRecently/1a1"), null, "expired plays are removed with the next one");
});

test("the first track not played lately plays; the skipped one stays put", async () => {
  const { r } = setup();
  await r.played(playing("a1", "Art", "Song", T0));
  await r.played(playing("x9", "Other", "Hit", T0));
  const list = listRef({ k1: yt("a1"), k2: yt("dupe", "Other - Hit (Lyrics)"), k3: yt("b1"), k4: yt("c1") });
  const pick = await r.firstPlayable(list);
  assert.equal(pick.key, "k3");
  assert.deepEqual(pick.skipped.map((s) => s.key), ["k1", "k2"]);
  assert.equal(pick.allRecent, undefined);
  assert.equal(list.reads, 1, "one read when the answer is on the first page");
});

test("flagged tracks are passed over as before, also after pages of them", async () => {
  const { r } = setup();
  const tracks = {};
  for (let i = 0; i < 30; i++) tracks["k" + String(i).padStart(3, "0")] = yt("f" + i, null, { flagged: { code: 2 } }); // old flags: no date
  tracks.k100 = yt("ok");
  const pick = await r.firstPlayable(listRef(tracks));
  assert.equal(pick.key, "k100");
  assert.deepEqual(pick.skipped, []);
});

test("when every track was played lately, the first plays anyway", async () => {
  const { r } = setup();
  await r.played(playing("a1", "Art", "One", T0));
  await r.played(playing("b1", "Art", "Two", T0));
  const pick = await r.firstPlayable(listRef({ k1: yt("a1"), k2: yt("b1"), k0: yt("z", "Z - Z", { flagged: { code: 2, date: 1 } }) }));
  assert.equal(pick.key, "k1");
  assert.equal(pick.allRecent, true);
  assert.equal(await r.firstPlayable(listRef({})), null, "an empty list: nothing");
});

test("REPEAT_HOURS=0: nothing is skipped, nothing saved, old warnings cleared", async () => {
  const { db, r } = setup({ playedRecently: { "1a1": { w: T0, u: T0 + HOUR } } }, 0);
  await r.load(null);
  await r.played(playing("a1", "Art", "Song", T0));
  assert.equal(db.get("playedRecently"), null);
  const pick = await r.firstPlayable(listRef({ k1: yt("a1") }));
  assert.equal(pick.key, "k1");
  assert.deepEqual(pick.skipped, []);
});

test("load: saved plays, Recent plays from before and the song on the decks; expired ones dropped", async () => {
  const { db, r } = setup({
    playedRecently: { "1old": { w: T0 - 5 * HOUR, u: T0 - HOUR, n: "x y" }, "1kept": { w: T0 - HOUR, u: T0 + 3 * HOUR, n: "kept song" } },
    songHistory: {
      h1: { type: 1, cid: "hist", artist: "Hist", title: "Song", when: T0 - 2 * HOUR, dj: "dj1" },
      h2: { type: 2, cid: 55, artist: "Very", title: "Old", when: T0 - 9 * HOUR }
    }
  });
  await r.load(playing("now1", "Now", "Playing", T0 - 60000));
  assert.ok(r.lately(yt("kept")));
  assert.ok(r.lately(yt("other", "Hist - Song")));
  assert.ok(r.lately(yt("now1")));
  assert.equal(r.lately({ type: 2, cid: 55, name: "Very - Old" }), null);
  const stored = db.get("playedRecently");
  assert.deepEqual(Object.keys(stored).sort(), ["1hist", "1kept", "1now1"]);
  assert.equal(stored["1hist"].dj, "dj1");
});

test("the DJ hears about a skipped song once, until it can play again", async () => {
  const { r, later } = setup();
  await r.played(playing("a1", "Art", "Song", T0, "dj2"));
  later(72 * 60000);
  const list = () => listRef({ k1: yt("a1", "Art - Song"), k2: yt("b1", "B - Next") });
  const pick = await r.firstPlayable(list());
  assert.equal(r.notice("dj1", pick), "Skipped \"Art - Song\": the room heard it 1 hr 12 min ago (dj2). It can play again in 2 hr 48 min. Playing \"B - Next\" instead.");
  assert.equal(r.notice("dj1", await r.firstPlayable(list())), null, "not again next turn");
  assert.ok(r.notice("dj3", await r.firstPlayable(list())), "someone else with the song is told too");
  const all = await r.firstPlayable(listRef({ k1: yt("a1") }));
  assert.match(r.notice("dj1", all), /^Every song in your playlist has played in the last 4 hours, so "Art - 1?a?/);
  assert.equal(r.notice("dj1", all), null, "said once an hour");
});
