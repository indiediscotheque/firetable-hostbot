// Genre playlists on YouTube Music (lib/ytplaylists.js) against an in-memory
// database and a fake YouTube. No emulators needed:
//   cd test && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { fakeDb } from "./fake-db.mjs";

const require = createRequire(import.meta.url);
const yp = require("../lib/ytplaylists.js");

const vid = (n) => ("vid" + String(n).padStart(8, "0")).slice(0, 11);
const fav = (from, to, extra) => Array.from({ length: to - from }, (_, i) => Object.assign({ type: 1, cid: vid(from + i), a: "A", t: "T" + (from + i) }, extra));

// A YouTube that keeps playlists in memory and counts what it's asked.
function fakeYouTube(opts = {}) {
  const lists = new Map(); // id -> { title, description, items: [{id, videoId}] }
  let n = 0;
  const calls = [];
  const json = (status, body) => ({ status, json: body, body: JSON.stringify(body) });
  const http = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    calls.push(method + " " + u.pathname.split("/").pop());
    if (u.hostname === "oauth2.googleapis.com") {
      return opts.badToken ? json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }) : json(200, { access_token: "tok" });
    }
    if (init.headers.Authorization !== "Bearer tok") return json(401, { error: { message: "no" } });
    const body = init.body ? JSON.parse(init.body) : null;
    const path = u.pathname.split("/").pop();
    if (path === "playlists" && method === "POST") {
      const id = "PL" + ++n;
      lists.set(id, { title: body.snippet.title, description: body.snippet.description, privacy: body.status.privacyStatus, items: [] });
      return json(200, { id });
    }
    if (path === "playlists" && method === "PUT") {
      Object.assign(lists.get(body.id), { title: body.snippet.title, description: body.snippet.description });
      return json(200, { id: body.id });
    }
    if (path === "playlistItems" && method === "GET") {
      const list = lists.get(u.searchParams.get("playlistId"));
      if (!list) return json(404, { error: { message: "playlist not found", errors: [{ reason: "playlistNotFound" }] } });
      const start = Number(u.searchParams.get("pageToken") || 0);
      const page = list.items.slice(start, start + 50);
      return json(200, { items: page.map((it) => ({ id: it.id, snippet: { resourceId: { videoId: it.videoId } } })), nextPageToken: start + 50 < list.items.length ? String(start + 50) : undefined });
    }
    if (path === "playlistItems" && method === "POST") {
      if ((opts.refuse || []).includes(body.snippet.resourceId.videoId)) return json(404, { error: { message: "Video not found.", errors: [{ reason: "videoNotFound" }] } });
      lists.get(body.snippet.playlistId).items.push({ id: "it" + ++n, videoId: body.snippet.resourceId.videoId });
      return json(200, {});
    }
    if (path === "playlistItems" && method === "DELETE") {
      for (const l of lists.values()) l.items = l.items.filter((it) => it.id !== u.searchParams.get("id"));
      return json(204, null);
    }
    return json(400, { error: { message: "unexpected " + method + " " + path } });
  };
  return { http, lists, calls };
}

const genres = {
  "nu-disco": { name: "Nu-Disco", plays: 300, about: "Disco's grooves rebuilt with modern synths." },
  "soul-and-randb": { name: "Soul & R&B", plays: 60 },
  tiny: { name: "Tiny", plays: 5 }
};
const library = () => ({ discover: { lib: { genres, genre: {
  "nu-disco": { fav: fav(0, 60).concat([{ type: 2, cid: "123456789", a: "SC", t: "Not on YouTube" }]) },
  "soul-and-randb": { fav: fav(100, 130) },
  tiny: { fav: fav(200, 205) }
} } } });
const make = (db, yt, extra = {}) => yp.createGenrePlaylists(Object.assign({
  db, http: yt.http, auth: { clientId: "id", clientSecret: "secret", refreshToken: "refresh" },
  site: "https://www.indiediscotheque.com", units: 100000, now: () => 1e12
}, extra));

test("wantedSongs: YouTube songs only, no repeats, best first", () => {
  assert.deepEqual(yp.wantedSongs([{ type: 1, cid: vid(1) }, { type: 2, cid: "999" }, { type: 1, cid: vid(1) }, { cid: vid(2) }, { type: 1, cid: "bad" }], 5), [vid(1), vid(2)]);
});

test("plan: takes out what left the favorites and second copies, adds what's new in order", () => {
  const items = [{ itemId: "a", videoId: "v1" }, { itemId: "b", videoId: "v2" }, { itemId: "c", videoId: "v1" }];
  assert.deepEqual(yp.plan(items, ["v1", "v3", "v4"]), { remove: ["b", "c"], add: ["v3", "v4"] });
});

test("each genre gets a public playlist of its 50 favorites, linking back to the site; small genres get none", async () => {
  const db = fakeDb(library());
  const yt = fakeYouTube();
  const sum = await make(db, yt).run();
  assert.equal(sum.created, 2);
  assert.equal(sum.skipped, 1, "Tiny has 5 songs");
  const id = db.get("discover/ytm/nu-disco");
  const list = yt.lists.get(id);
  assert.equal(list.title, "Indie Discotheque · Nu-Disco");
  assert.equal(list.privacy, "public");
  assert.match(list.description, /Disco's grooves/);
  assert.match(list.description, /https:\/\/www\.indiediscotheque\.com\/music\/genres\/nu-disco\//);
  assert.deepEqual(list.items.map((it) => it.videoId), fav(0, 50).map((r) => r.cid));
  assert.equal(yt.lists.get(db.get("discover/ytm/soul-and-randb")).items.length, 30);
  assert.equal(db.get("discoverCache/ytPlaylistsRun").added, 80);
});

test("the next run changes only what moved, and fixes the description", async () => {
  const db = fakeDb(library());
  const yt = fakeYouTube();
  await make(db, yt).run();
  // a week later: two new favorites at the top, the last two drop off, a new line about the genre
  db.ref("discover/lib/genre/nu-disco/fav").set(fav(900, 902).concat(fav(0, 48)));
  db.ref("discover/lib/genres/nu-disco/about").set("New line.");
  yt.calls.length = 0;
  const sum = await make(db, yt).run();
  assert.deepEqual([sum.added, sum.removed, sum.created], [2, 2, 0]);
  const list = yt.lists.get(db.get("discover/ytm/nu-disco"));
  assert.equal(list.items.length, 50);
  assert.match(list.description, /New line\./);
  assert.equal(yt.calls.filter((c) => c === "PUT playlists").length, 1, "only Nu-Disco's description changed");
});

test("a run stops at its budget, and the next one carries on", async () => {
  const db = fakeDb(library());
  const yt = fakeYouTube();
  // 1 playlist (50) + a list (1) + 20 songs (50 each)
  const sum = await make(db, yt, { units: 50 + 1 + 20 * 50 }).run();
  assert.equal(sum.added, 20);
  assert.match(sum.stopped, /budget/);
  assert.equal(sum.waiting, 3, "Nu-Disco itself, and the genres after it");
  const sum2 = await make(db, yt).run();
  assert.equal(sum2.added, 60);
  assert.equal(yt.lists.get(db.get("discover/ytm/nu-disco")).items.length, 50);
});

test("a video YouTube refuses is left out for a while, and the next song takes its place", async () => {
  const db = fakeDb(library());
  const yt = fakeYouTube({ refuse: [vid(3)] });
  await make(db, yt).run();
  assert.equal(db.get("discoverCache/ytPlaylistsBad/" + vid(3)), 1e12);
  const sum = await make(db, yt).run();
  const items = yt.lists.get(db.get("discover/ytm/nu-disco")).items.map((it) => it.videoId);
  assert.ok(!items.includes(vid(3)));
  assert.equal(items.length, 50, "song 51 fills the gap on the next run");
  assert.equal(sum.added, 1);
});

test("a playlist deleted on YouTube is made again", async () => {
  const db = fakeDb(library());
  const yt = fakeYouTube();
  await make(db, yt).run();
  const old = db.get("discover/ytm/nu-disco");
  yt.lists.delete(old);
  await make(db, yt).run();
  assert.equal(db.get("discover/ytm/nu-disco"), null, "forgotten");
  await make(db, yt).run();
  assert.notEqual(db.get("discover/ytm/nu-disco"), old);
  assert.equal(yt.lists.get(db.get("discover/ytm/nu-disco")).items.length, 50);
});

test("a refused sign-in stops the run and says what to do", async () => {
  const db = fakeDb(library());
  const sum = await make(db, fakeYouTube({ badToken: true })).run();
  assert.match(sum.stopped, /youtube-auth\.js/);
  assert.equal(sum.created, 0);
});
