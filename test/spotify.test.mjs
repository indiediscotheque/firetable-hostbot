// Spotify playlists (lib/spotify.js) against a fake Spotify. No network:
//   cd test && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const spotify = require("../lib/spotify.js");
const ID = "37i9dQZF1DXcBWIGoYBM5M"; // 22 characters
const MINE = "6rqhFgbbKwnb9MLmUQDhG6";

const track = (name, artists, ms, extra) => ({ track: Object.assign({ name, type: "track", is_local: false, duration_ms: ms, artists: artists.map((n) => ({ name: n })) }, extra) });

// a fake Spotify: one public playlist of 230 songs (three pages), a 404 for the rest
function fakeHttp(seen = { token: 0, calls: [] }, opts = {}) {
  return async (url, o = {}) => {
    seen.calls.push(String(url));
    if (String(url).startsWith("https://accounts.spotify.com/api/token")) {
      seen.token++;
      if (opts.badKeys) return { status: 400, json: { error: "invalid_client" }, headers: new Map() };
      assert.match(o.headers.Authorization, /^Basic /);
      assert.equal(o.body, "grant_type=client_credentials");
      return { status: 200, json: { access_token: "tok" + seen.token, expires_in: 3600 }, headers: new Map() };
    }
    assert.match(o.headers.Authorization, /^Bearer tok/);
    if (opts.expireOnce && seen.calls.filter((c) => c.includes("api.spotify.com")).length === 1) return { status: 401, json: {}, headers: new Map() };
    const u = new URL(url);
    if (!u.pathname.includes(MINE)) return { status: 404, json: { error: { status: 404 } }, headers: new Map() };
    if (!u.pathname.endsWith("/tracks")) return { status: 200, json: { name: "Night Drive", owner: { display_name: "Chris" }, tracks: { total: 232 } }, headers: new Map() };
    const offset = Number(u.searchParams.get("offset"));
    const items = [];
    for (let i = offset; i < Math.min(offset + 100, 232); i++) {
      if (i === 5) items.push(track("My Recording", ["Me"], 1000, { is_local: true }));
      else if (i === 6) items.push({ track: { name: "A Podcast", type: "episode", duration_ms: 1000, artists: [] } });
      else items.push(track("Song " + i, ["Artist " + i, "Guest"], 200000 + i));
    }
    return { status: 200, json: { items, next: offset + 100 < 232 ? "more" : null }, headers: new Map() };
  };
}

test("a playlist's id from its link, a spotify: URI or the id", () => {
  assert.equal(spotify.playlistId("https://open.spotify.com/playlist/" + MINE + "?si=abc123"), MINE);
  assert.equal(spotify.playlistId("https://open.spotify.com/intl-de/playlist/" + MINE), MINE);
  assert.equal(spotify.playlistId("spotify:playlist:" + MINE), MINE);
  assert.equal(spotify.playlistId("spotify:user:someone:playlist:" + MINE), MINE);
  assert.equal(spotify.playlistId(MINE), MINE);
  assert.equal(spotify.playlistId("https://open.spotify.com/album/" + MINE), null);
  assert.equal(spotify.playlistId("https://example.com/playlist/" + MINE), null);
  assert.equal(spotify.playlistId("night drive"), null);
});

test("a public playlist's songs, every page, local files and episodes left out", async () => {
  const seen = { token: 0, calls: [] };
  const sp = spotify.createSpotify({ clientId: "id", clientSecret: "secret", http: fakeHttp(seen) });
  const pl = await sp.playlist(MINE);
  assert.equal(pl.name, "Night Drive");
  assert.equal(pl.by, "Chris");
  assert.equal(pl.tracks.length, 230);
  assert.equal(pl.skipped, 2);
  assert.deepEqual(pl.tracks[0], { a: "Artist 0, Guest", t: "Song 0", d: 200 });
  assert.equal(seen.token, 1, "one token for every call");
  assert.equal(seen.calls.filter((c) => c.includes("/tracks?")).length, 3);
  await sp.playlist(MINE);
  assert.equal(seen.token, 1, "the token is kept until it runs out");
});

test("errors say what went wrong: a playlist Spotify won't share, bad keys, no keys", async () => {
  const sp = spotify.createSpotify({ clientId: "id", clientSecret: "secret", http: fakeHttp() });
  await assert.rejects(sp.playlist(ID), (e) => e.code === "gone");
  await assert.rejects(sp.playlist("nope"), (e) => e.code === "gone");
  const bad = spotify.createSpotify({ clientId: "id", clientSecret: "wrong", http: fakeHttp({ token: 0, calls: [] }, { badKeys: true }) });
  await assert.rejects(bad.playlist(MINE), (e) => e.code === "keys");
  assert.equal(await bad.check(), false);
  const none = spotify.createSpotify({ clientId: "", clientSecret: "", http: fakeHttp() });
  assert.equal(none.configured(), false);
  assert.equal(await none.check(), false);
  await assert.rejects(none.playlist(MINE), (e) => e.code === "keys");
  const down = spotify.createSpotify({ clientId: "id", clientSecret: "secret", http: async (u) => { if (String(u).includes("accounts")) return { status: 200, json: { access_token: "tokx", expires_in: 3600 } }; throw new Error("socket hang up"); } });
  await assert.rejects(down.playlist(MINE), (e) => e.code === "spotify");
});

test("a token Spotify says has run out is asked for again, once", async () => {
  const seen = { token: 0, calls: [] };
  const sp = spotify.createSpotify({ clientId: "id", clientSecret: "secret", http: fakeHttp(seen, { expireOnce: true }) });
  const pl = await sp.playlist(MINE);
  assert.equal(pl.tracks.length, 230);
  assert.equal(seen.token, 2);
});
