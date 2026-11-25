// Unit tests for the bot's small helpers (lib/). No emulators needed:
//   cd test && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { splitTags, fitChat, md5, CHAT_MAX_LENGTH } = require("../lib/text.js");

test("splitTags splits on the first ' - ' and keeps the rest of the title", () => {
  assert.deepEqual(splitTags("Artist - Song"), ["Artist", "Song"]);
  assert.deepEqual(splitTags("Artist - Song - Live at KEXP"), ["Artist", "Song - Live at KEXP"]);
  assert.deepEqual(splitTags("Just a title"), ["Just a title", undefined]);
  assert.deepEqual(splitTags("Artist - "), ["Artist", ""]);
  assert.deepEqual(splitTags("Jay-Z - 99 Problems"), ["Jay-Z", "99 Problems"]);
  assert.deepEqual(splitTags(undefined), ["", undefined]);
});

test("fitChat keeps short messages and shortens long ones to the rules' limit", () => {
  assert.equal(fitChat("hi"), "hi");
  assert.equal(fitChat("x".repeat(CHAT_MAX_LENGTH)), "x".repeat(CHAT_MAX_LENGTH));
  const long = fitChat("x".repeat(500));
  assert.equal(long.length, CHAT_MAX_LENGTH);
  assert.ok(long.endsWith("…"));
  // never ends on half an emoji
  const emoji = fitChat("x".repeat(CHAT_MAX_LENGTH - 2) + "🔥🔥🔥");
  assert.ok(emoji.length <= CHAT_MAX_LENGTH);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(emoji));
  assert.equal(fitChat(null), "");
});

test("md5 hashes UTF-8 the way Last.fm signs calls", () => {
  // RFC 1321 test vectors
  assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  // non-English text (reference values from Python's hashlib): these failed
  // with the old hand-written MD5, so Last.fm refused those scrobbles
  assert.equal(md5("é"), "66ddcd97cfdeabb2f6fb8a999b4bc76f");
  assert.equal(md5("Björk"), "7dab4f23a40857b30fdd81370c211680");
  assert.equal(md5("シガー・ロス"), "0f4ceca7d0fff6491974ed6dd9923597");
});

const { youtubeProblem, soundcloudProblem, problemMessage, scrobbles } = require("../lib/checks.js");

test("youtubeProblem matches the site's playlist checker", () => {
  const ok = { snippet: {}, contentDetails: { duration: "PT3M" }, status: { embeddable: true, privacyStatus: "public", uploadStatus: "processed" } };
  assert.equal(youtubeProblem(ok), 0);
  assert.equal(youtubeProblem(undefined), 2);
  assert.equal(youtubeProblem({ ...ok, status: { privacyStatus: "private" } }), 2);
  assert.equal(youtubeProblem({ ...ok, status: { uploadStatus: "deleted" } }), 2);
  assert.equal(youtubeProblem({ ...ok, status: { embeddable: false } }), 6);
  assert.equal(youtubeProblem({ ...ok, contentDetails: { regionRestriction: { blocked: ["DE", "US"] } } }), 3);
  assert.equal(youtubeProblem({ ...ok, contentDetails: { regionRestriction: { allowed: ["GB"] } } }), 3);
  assert.equal(youtubeProblem({ ...ok, contentDetails: { regionRestriction: { allowed: ["US", "GB"] } } }), 0);
  assert.equal(youtubeProblem({ ...ok, contentDetails: { contentRating: { ytRating: "ytAgeRestricted" } } }), 7);
  assert.equal(youtubeProblem({ ...ok, snippet: { liveBroadcastContent: "upcoming" } }), 5);
  assert.equal(youtubeProblem({ ...ok, snippet: { liveBroadcastContent: "live" } }), 0);
});

test("soundcloudProblem: blocked, private and 30-second previews never play", () => {
  const ok = { id: 1, access: "playable", policy: "ALLOW", streamable: true, sharing: "public", duration: 200000, full_duration: 200000 };
  assert.equal(soundcloudProblem(ok), 0);
  assert.equal(soundcloudProblem({ id: 1 }), 0); // fields missing: assume it plays
  assert.equal(soundcloudProblem(null), 4);
  assert.equal(soundcloudProblem({ ...ok, access: "blocked" }), 5);
  assert.equal(soundcloudProblem({ ...ok, policy: "BLOCK" }), 5);
  assert.equal(soundcloudProblem({ ...ok, streamable: false }), 5);
  assert.equal(soundcloudProblem({ ...ok, sharing: "private" }), 5);
  assert.equal(soundcloudProblem({ ...ok, access: "preview" }), 5);
  assert.equal(soundcloudProblem({ ...ok, policy: "SNIP" }), 5);
  assert.equal(soundcloudProblem({ ...ok, duration: 30000 }), 5); // shorter than the full track
});

test("problemMessage fits a notice and doesn't @ping anyone", () => {
  for (const code of [2, 3, 4, 5, 6, 7]) {
    const m = problemMessage(code, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.ok(!m.includes("@") && m.length <= 240, "code " + code + ": " + m.length);
  }
});

test("scrobbles follows last.fm's rule", () => {
  assert.equal(scrobbles(25, 25, true), false); // 30 seconds or shorter: never
  assert.equal(scrobbles(200, 99), false);
  assert.equal(scrobbles(200, 100), true); // half of it
  assert.equal(scrobbles(1200, 239), false);
  assert.equal(scrobbles(1200, 240), true); // 4 minutes of a long one
  assert.equal(scrobbles(200, 3, true), true); // ran to its end
});

// ─── Web Push (lib/webpush.js) ───────────────────────────────────────────────
// Checked against http_ece, the reference implementation of the encryption.
const webpush = require("../lib/webpush.js");
const ece = require("http_ece");
const crypto = require("crypto");
const browser = () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, sub: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
};

test("webpush.encrypt: a browser can decrypt it (aes128gcm, RFC 8291)", () => {
  const b = browser();
  const msg = JSON.stringify({ title: "dj2", body: "hey @dj1 ✨ " + "x".repeat(300) });
  const body = webpush.encrypt(msg, b.sub.p256dh, b.sub.auth);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body[20], 65);
  assert.equal(ece.decrypt(body, { version: "aes128gcm", privateKey: b.ua, authSecret: b.sub.auth }).toString(), msg);
  // a new key and salt every time
  assert.notDeepEqual(webpush.encrypt(msg, b.sub.p256dh, b.sub.auth).subarray(0, 86), body.subarray(0, 86));
});

test("webpush.encrypt refuses bad keys and payloads too big for one push", () => {
  const b = browser();
  assert.throws(() => webpush.encrypt("x", "abc", b.sub.auth), /p256dh/);
  assert.throws(() => webpush.encrypt("x", b.sub.p256dh, "abc"), /auth/);
  assert.throws(() => webpush.encrypt("x".repeat(4000), b.sub.p256dh, b.sub.auth), /too big/);
});

test("VAPID: new keys sign a token the push service can check (ES256, RFC 8292)", () => {
  const keys = webpush.generateVAPIDKeys();
  assert.match(keys.publicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.match(keys.privateKey, /^[A-Za-z0-9_-]{43}$/);
  const header = webpush.vapidAuth("https://fcm.googleapis.com/fcm/send/abc", Object.assign({ subject: "mailto:room@example.com" }, keys));
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], "base64url"));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:room@example.com");
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(m[1] + "." + m[2]), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")));
});

test("VAPID: halves of two different pairs are refused", () => {
  const a = webpush.generateVAPIDKeys(), b = webpush.generateVAPIDKeys();
  assert.ok(webpush.vapidKey(a.publicKey, a.privateKey));
  assert.throws(() => webpush.vapidKey(a.publicKey, b.privateKey), /not a pair/);
  assert.throws(() => webpush.vapidKey("short", a.privateKey), /P-256/);
});

test("only real push services are posted to", () => {
  for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://web.push.apple.com/QO", "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-by3p.notify.windows.com/w/?token=x"]) assert.ok(webpush.isPushEndpoint(ok), ok);
  for (const bad of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x", "https://127.0.0.1/x", "file:///etc/passwd", "", null]) assert.ok(!webpush.isPushEndpoint(bad), String(bad));
});

test("webpush.send posts the encrypted message with VAPID and the push headers", async () => {
  const b = browser();
  const keys = Object.assign({ subject: "https://room.example" }, webpush.generateVAPIDKeys());
  const realFetch = global.fetch;
  let seen;
  global.fetch = async (url, init) => { seen = { url, init }; return new Response("", { status: url.endsWith("/gone") ? 410 : 201 }); };
  try {
    const res = await webpush.send(Object.assign({ endpoint: "https://web.push.apple.com/abc" }, b.sub), { title: "hi" }, keys, { ttl: 60, urgency: "high", topic: "away!" });
    assert.deepEqual([res.ok, res.gone, res.status], [true, false, 201]);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["Content-Encoding"], "aes128gcm");
    assert.equal(seen.init.headers.TTL, "60");
    assert.equal(seen.init.headers.Urgency, "high");
    assert.equal(seen.init.headers.Topic, "away");
    assert.match(seen.init.headers.Authorization, /^vapid t=.+, k=/);
    assert.equal(ece.decrypt(seen.init.body, { version: "aes128gcm", privateKey: b.ua, authSecret: b.sub.auth }).toString(), '{"title":"hi"}');
    const gone = await webpush.send(Object.assign({ endpoint: "https://web.push.apple.com/gone" }, b.sub), "x", keys);
    assert.deepEqual([gone.ok, gone.gone], [false, true]);
    await assert.rejects(webpush.send(Object.assign({ endpoint: "https://evil.example/x" }, b.sub), "x", keys), /not a known push service/);
  } finally {
    global.fetch = realFetch;
  }
});

// ─── Swap suggestions: YouTube Music search and matching ─────────────────────
const ytmusic = require("../lib/ytmusic.js");
const swaps = require("../lib/swaps.js");
const ytm = require("./fixtures/ytmusic.js");

test("YouTube Music answers: only audio tracks are kept, with artist, album and length", () => {
  const all = ytmusic.parseSearch(ytm.answer([
    { cid: "vid00000001", title: "Karma Police (Official Video)", artists: ["Radiohead"], kind: "OMV" },
    { cid: "aud00000001", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", dur: 262, explicit: true },
    { cid: "ugc00000001", title: "Radiohead - Karma Police (Official Audio)", artists: ["someone"], kind: "UGC" },
    { cid: "aud00000002", title: "Lucky", artists: ["Radiohead", "Thom Yorke"], label: "Song", dur: 259 }
  ]));
  assert.equal(all.length, 4);
  const songs = ytmusic.songsOnly(all);
  assert.deepEqual(songs.map((s) => s.cid), ["aud00000001", "aud00000002"]);
  assert.deepEqual(songs[0], { cid: "aud00000001", title: "Karma Police", artist: "Radiohead", album: "OK Computer", dur: 262, explicit: true, kind: ytmusic.ATV });
  // "Song • A & B • 4:19" (the unfiltered search): the label isn't an artist
  assert.equal(songs[1].artist, "Radiohead & Thom Yorke");
  assert.equal(songs[1].dur, 259);
  assert.deepEqual(ytmusic.parseSearch(ytm.answer([])), []);
  assert.deepEqual(ytmusic.parseSearch({}), []);
  assert.equal(ytmusic.seconds("1:02:03"), 3723);
  assert.equal(ytmusic.seconds("12K views"), 0);
});

test("swap matches: same recording only (title, version, artists, length)", () => {
  const songs = ytmusic.songsOnly(ytmusic.parseSearch(ytm.answer([
    { cid: "live0000001", title: "Karma Police (Live)", artists: ["Radiohead"], dur: 300 },
    { cid: "cover000001", title: "Karma Police", artists: ["Some Cover Band"], dur: 262 },
    { cid: "remix000001", title: "Karma Police (Four Tet Remix)", artists: ["Radiohead"], dur: 330 },
    { cid: "studio00001", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", dur: 262 }
  ])));
  const pick = (name, opts) => swaps.rankMatches(name, songs, opts).map((s) => s.cid);
  assert.deepEqual(pick("Radiohead - Karma Police"), ["studio00001"]);
  assert.deepEqual(pick("Radiohead - Karma Police (Official Audio) [HD]"), ["studio00001"]);
  assert.deepEqual(pick("RADIOHEAD - karma police - 1997 Remaster"), ["studio00001"]);
  assert.deepEqual(pick("Radiohead - Karma Police (Live)"), ["live0000001"]);
  assert.deepEqual(pick("Radiohead - Karma Police (Four Tet Remix)"), ["remix000001"]);
  assert.deepEqual(pick("Thom Yorke - Karma Police"), []);
  assert.deepEqual(pick("Radiohead - Paranoid Android"), []);
  // a known length that's far off rules a match out; close keeps it
  assert.deepEqual(pick("Radiohead - Karma Police", { dur: 600 }), []);
  assert.deepEqual(pick("Radiohead - Karma Police", { dur: 265 }), ["studio00001"]);
  // too vague to match on
  assert.deepEqual(pick("Unknown - Track 1"), []);
});

test("swap matches: featured artists may be in either field; clean only when asked", () => {
  const songs = ytmusic.songsOnly(ytmusic.parseSearch(ytm.answer([
    { cid: "feat0000001", title: "This Is What You Came For", artists: ["Calvin Harris", "Rihanna"], dur: 222, explicit: false },
    { cid: "feat0000002", title: "This Is What You Came For (feat. Rihanna)", artists: ["Calvin Harris"], dur: 222, explicit: true }
  ])));
  const got = swaps.rankMatches("Calvin Harris - This Is What You Came For feat. Rihanna", songs).map((s) => s.cid);
  assert.equal(got.length, 2);
  assert.equal(got[0], "feat0000002", "same artist field, album (explicit) version first");
  assert.equal(swaps.rankMatches("Calvin Harris - This Is What You Came For (Clean) feat. Rihanna", songs)[0].cid, "feat0000001");
});

test("swap queries, cache ids and saved lengths", () => {
  assert.equal(swaps.queryFor("Daft Punk - One More Time (Official Video)"), "Daft Punk One More Time");
  assert.equal(swaps.queryFor("Calvin Harris - Feel So Close (Nero Remix)"), "Calvin Harris Feel So Close (Nero Remix)");
  assert.equal(swaps.queryFor("Unknown - untitled"), null);
  assert.equal(swaps.cacheId("Daft Punk - One More Time"), swaps.cacheId("DAFT PUNK - One More Time [HD]"));
  assert.notEqual(swaps.cacheId("Daft Punk - One More Time"), swaps.cacheId("Daft Punk - One More Time (Live)"));
  assert.match(swaps.cacheId("a - b"), /^[A-Za-z0-9_-]{16}$/);
  assert.equal(swaps.trackSeconds({ duration: 245 }), 245);
  assert.equal(swaps.trackSeconds({ duration: 245000 }), 245);
  assert.equal(swaps.trackSeconds({}), 0);
  assert.deepEqual(swaps.pickOf({ cid: "x", artist: "A", title: "T", album: "", dur: 0, explicit: false, kind: "z" }), { cid: "x", artist: "A", title: "T" });
});

test("swap runner: finds, checks and saves suggestions; skips dismissed; re-checks old ones", async () => {
  // a tiny in-memory database with the calls the runner makes
  const data = {
    queues: {
      u1: {
        a: { type: 1, cid: "deadvideo01", name: "Radiohead - Karma Police", flagged: { date: 1, code: 2 } },
        b: { type: 2, cid: 77, name: "Radiohead - Karma Police (HQ)", flagged: { date: 1, code: 4 } },
        c: { type: 1, cid: "offtheme001", name: "Radiohead - Karma Police", flagged: { date: 1, code: 10 } },
        d: { type: 1, cid: "dismissed01", name: "Radiohead - Karma Police", flagged: { date: 1, code: 2 }, swap: { dismissed: "studio00001", date: Date.now() } },
        e: { type: 1, cid: "oldswap0001", name: "Radiohead - Lucky", flagged: { date: 1, code: 2 }, swap: { cid: "gonenow0001", artist: "Radiohead", title: "Lucky", date: 1 } },
        f: { type: 1, cid: "fine0000001", name: "Radiohead - Lucky" }
      }
    }
  };
  const at = (path) => path.split("/").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const setAt = (path, v) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    const parent = parts.reduce((o, k) => (o[k] = o[k] || {}), data);
    if (v === null || v === undefined) delete parent[last]; else parent[last] = v;
  };
  const snap = (key, v) => ({ key, val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))),
    forEach: (fn) => Object.keys(v || {}).forEach((k) => fn(snap(k, v[k]))) });
  const ref = (path) => ({
    child: (k) => ref(path + "/" + k),
    once: async () => snap(path.split("/").pop(), at(path)),
    set: async (v) => setAt(path, v),
    update: async (v) => Object.keys(v).forEach((k) => setAt(path + "/" + k, v[k])),
    orderByChild: () => ({ startAt: () => ({ once: async () => {
      const v = at(path) || {};
      const out = {};
      Object.keys(v).forEach((k) => { if (v[k].flagged) out[k] = v[k]; });
      return snap(path, out);
    } }) }),
    transaction: async (fn) => {
      // like Firebase: first with nothing cached, then with the real value
      if (fn(null) === undefined) return { committed: false };
      const r = fn(at(path) === undefined ? null : JSON.parse(JSON.stringify(at(path))));
      if (r === undefined) return { committed: false };
      setAt(path, r);
      return { committed: true };
    }
  });
  const searches = [];
  const notices = [];
  const verified = [];
  const sw = swaps.createSwapper({
    db: { ref },
    shallowKeys: async (p) => Object.keys(at(p) || {}),
    search: async (q) => {
      searches.push(q);
      const rows = /Lucky/.test(q) ? [{ cid: "lucky000001", title: "Lucky", artists: ["Radiohead"] }]
        : [{ cid: "studio00001", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", dur: 262 },
          { cid: "noembed0001", title: "Karma Police", artists: ["Radiohead"] }];
      const res = ytmusic.parseSearch(ytm.answer(rows));
      return { songs: ytmusic.songsOnly(res), any: res.length };
    },
    verify: async (ids) => { verified.push(ids.length); return Object.fromEntries(ids.filter((i) => i !== "gonenow0001").map((i) => [i, i === "noembed0001" ? 6 : 0])); },
    notify: (uid, txt, opts) => notices.push({ uid, txt, opts }),
    users: () => ({ u1: { username: "u1" }, u2: { username: "u2" } }), botid: () => "bot", delayMs: 0
  });
  const stats = await sw.run();
  const q = data.queues.u1;
  assert.equal(q.a.swap.cid, "studio00001");
  assert.equal(q.a.swap.album, "OK Computer");
  assert.equal(q.b.swap.cid, "studio00001", "a SoundCloud track gets a YouTube Music swap too");
  assert.equal(q.c.swap, undefined, "off-theme flags get no swap");
  assert.deepEqual(q.d.swap, data.queues.u1.d.swap, "a dismissed match isn't suggested again");
  assert.equal(q.d.swap.dismissed, "studio00001");
  assert.equal(q.e.swap, undefined, "an old suggestion that no longer plays is removed");
  assert.equal(q.f.swap, undefined);
  assert.deepEqual(searches, ["Radiohead Karma Police"], "one search per song, all spellings together");
  assert.ok(data.swapCache && Object.keys(data.swapCache).length === 1, "the search is remembered");
  assert.equal(stats.suggested, 2);
  assert.equal(stats.removed, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].uid, "u1");
  assert.match(notices[0].txt, /2 broken tracks/);
  assert.match(swaps.summary(stats), /2 new swaps for 1 person/);
  assert.equal(stats.units, 1, "one YouTube API call checks every match");
  assert.deepEqual(verified, [2], "the best match and the old suggestion in one call; the second choice is never checked when the first plays");
  assert.ok(data.swapScans.u1 && data.swapScans.u2, "everyone looked at is marked as scanned");
  const cached = Object.values(data.swapCache)[0];
  assert.ok(cached.picks[0].ok, "a match that plays is remembered as checked");

  // a plain run skips people not seen since their last scan: no reads, no searches, no quota
  const skipped = await sw.run();
  assert.equal(skipped.lists, 0);
  assert.equal(skipped.skippedPeople, 2);
  assert.equal(skipped.units, 0);

  // second run: tracks with a suggestion are left alone; the one whose old swap stopped
  // playing gets a fresh search and a new suggestion
  const again = await sw.run({ full: true });
  assert.deepEqual(searches, ["Radiohead Karma Police", "Radiohead Lucky"]);
  assert.equal(again.cached, 0);
  assert.equal(again.suggested, 1);
  assert.equal(q.e.swap.cid, "lucky000001");
  assert.equal(notices.length, 2);
  assert.match(notices[1].txt, /^A broken track/);

  // third run: everything remembered, nothing new, no notice
  const third = await sw.run({ full: true });
  assert.equal(searches.length, 2);
  assert.equal(third.units, 0, "matches checked this week aren't checked again");
  assert.equal(third.suggested, 0);
  assert.equal(notices.length, 2, "no notice when nothing is new");
});

// ─── Swaps: a catalog that doesn't answer, old "no match" answers, playlist formats ──
const fakeDb = (data) => {
  const at = (path) => path.split("/").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const setAt = (path, v) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    const parent = parts.reduce((o, k) => (o[k] = o[k] || {}), data);
    if (v === null || v === undefined) delete parent[last]; else parent[last] = v;
  };
  const snap = (key, v) => ({ key, val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))),
    forEach: (fn) => Object.keys(v || {}).forEach((k) => fn(snap(k, v[k]))) });
  const ref = (path) => ({
    child: (k) => ref(path + "/" + k),
    once: async () => snap(path.split("/").pop(), at(path)),
    set: async (v) => setAt(path, v),
    update: async (v) => Object.keys(v).forEach((k) => setAt(path + "/" + k, v[k])),
    orderByChild: () => ({ startAt: () => ({ once: async () => {
      const v = at(path) || {};
      const out = {};
      Object.keys(v).forEach((k) => { if (v[k] && v[k].flagged) out[k] = v[k]; });
      return snap(path, out);
    } }) }),
    transaction: async (fn) => {
      if (fn(null) === undefined) return { committed: false };
      const r = fn(at(path) === undefined ? null : JSON.parse(JSON.stringify(at(path))));
      if (r === undefined) return { committed: false };
      setAt(path, r);
      return { committed: true };
    }
  });
  return { db: { ref }, at };
};
const broken = (cid, name) => ({ type: 1, cid, name, flagged: { date: 1, code: 2 } });
const songRow = { cid: "studio00001", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", dur: 262 };
const realSearch = (rows) => {
  // the shape lib/ytmusic.js searchSongs answers in, `catalog` included
  const all = ytmusic.parseSearch(ytm.answer(rows));
  return { songs: ytmusic.songsOnly(all), any: all.length || 3, catalog: rows.length };
};

test("swap runner: a song catalog that answers nothing isn't saved as 'no match', and YouTube Music searches stop", async () => {
  const data = { queues: { u1: {
    a: broken("dead0000001", "Radiohead - Karma Police"), b: broken("dead0000002", "Radiohead - Lucky"),
    c: broken("dead0000003", "Radiohead - No Surprises"), d: broken("dead0000004", "Radiohead - Airbag"),
    e: broken("dead0000005", "Radiohead - Let Down")
  } } };
  const { db } = fakeDb(data);
  const searches = [];
  const sw = swaps.createSwapper({
    db, shallowKeys: async () => [], users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0,
    canary: "Daft Punk One More Time",
    search: async (q) => { searches.push(q); return realSearch([]); }, // "No results" for everything, the canary too
    verify: async () => ({}), notify: () => {}
  });
  const stats = await sw.run();
  assert.equal(data.swapCache, undefined, "nothing remembered as 'no match'");
  assert.match(stats.ytmOff, /catalog isn't answering/);
  assert.equal(stats.stopped, "", "the other sources carry on");
  assert.equal(searches.filter((q) => q === "Daft Punk One More Time").length, 1, "the canary is searched once");
  assert.equal(searches.length, 4, "three searches, the canary, then YouTube Music isn't asked again");
  assert.deepEqual(data.swapScans, { u1: 0 }, "nobody is marked as done: they're marked not done (0), so the next pass picks them up");
  assert.match(swaps.summary(stats), /YouTube Music: YouTube Music's song catalog isn't answering/);
});

test("swap runner: once the catalog has answered, a search without songs is a real 'no match'", async () => {
  const data = { queues: { u1: { a: broken("dead0000001", "Radiohead - Karma Police"), b: broken("dead0000002", "Obscure Act - Nowhere Song") } } };
  const { db } = fakeDb(data);
  const sw = swaps.createSwapper({
    db, shallowKeys: async () => [], users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0,
    search: async (q) => realSearch(/Karma/.test(q) ? [songRow] : []),
    verify: async (ids) => Object.fromEntries(ids.map((i) => [i, 0])), notify: () => {}
  });
  const stats = await sw.run();
  assert.equal(stats.stopped, "");
  assert.equal(data.queues.u1.a.swap.cid, "studio00001");
  const cached = Object.values(data.swapCache);
  assert.equal(cached.length, 2, "both answers remembered, the empty one included");
  assert.ok(cached.some((c) => c.picks.length === 0));
  assert.ok(cached.every((c) => c.v === swaps.CACHE_VERSION), "saved with the version that trusts them");
});

test("swap cache: 'no match' answers saved before the catalog fix are searched again", () => {
  const t = Date.now();
  const day = 86400000;
  assert.equal(swaps.usableCache({ date: t - day, picks: [] }, t), false, "old 'no match' (no version): search again");
  assert.equal(swaps.usableCache({ date: t - day }, t), false);
  assert.equal(swaps.usableCache({ date: t - day, picks: [{ cid: "x" }] }, t), true, "old matches still count");
  assert.equal(swaps.usableCache({ date: t - day, picks: [], v: swaps.CACHE_VERSION }, t), true, "a 'no match' since the fix counts");
  assert.equal(swaps.usableCache({ date: t - 31 * day, picks: [{ cid: "x" }] }, t), false, "older than 30 days: search again");
  assert.equal(swaps.usableCache(null, t), false);
});

test("swap runner: playlists kept to SoundCloud get SoundCloud copies; video playlists never get audio tracks", async () => {
  const data = {
    queues: { u1: { a: broken("dead0000001", "Radiohead - Karma Police") } },
    playlists: { u1: {
      scList: { name: "SC", list: { a: broken("dead0000002", "Radiohead - Lucky") } },
      vidList: { name: "Videos", list: { a: broken("dead0000003", "Radiohead - Airbag") } },
      ytmList: { name: "YTM", list: { a: broken("dead0000004", "Radiohead - Let Down") } },
      plain: { name: "Unset", list: { a: broken("dead0000005", "Radiohead - No Surprises") } }
    } },
    playlistPrefs: { u1: { format: { 0: "sc", scList: "sc", vidList: "video", ytmList: "ytm", junk: "spotify" } } }
  };
  const { db, at } = fakeDb(data);
  const searches = [];
  const scSearches = [];
  const sw = swaps.createSwapper({
    db, shallowKeys: async (p) => Object.keys(at(p) || {}), users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0,
    search: async (q) => { searches.push(q); return realSearch([songRow]); },
    scSearch: async (q) => {
      scSearches.push(q);
      return /Lucky/.test(q) ? [
        { cid: "111", title: "Radiohead - Lucky (preview)", user: "Someone", dur: 30, url: "https://soundcloud.com/x/lucky", problem: 5 }, // a preview: never
        { cid: "222", title: "Lucky", user: "Radiohead", dur: 259, url: "https://soundcloud.com/radiohead/lucky", img: "https://i1.sndcdn.com/a.jpg", problem: 0 }
      ] : [];
    },
    verify: async (ids) => Object.fromEntries(ids.map((i) => [i, 0])), notify: () => {}
  });
  const stats = await sw.run();
  assert.deepEqual(searches.sort(), ["Radiohead Let Down", "Radiohead No Surprises"], "YouTube Music's audio tracks only for YouTube Music and unset playlists");
  assert.deepEqual(scSearches.sort(), ["Radiohead Karma Police", "Radiohead Lucky"], "SoundCloud's search for SoundCloud playlists");
  assert.equal(stats.lists, 5);
  const sc = data.playlists.u1.scList.list.a.swap;
  assert.deepEqual([sc.cid, sc.kind, sc.url, sc.img, sc.artist], ["222", "soundcloud", "https://soundcloud.com/radiohead/lucky", "https://i1.sndcdn.com/a.jpg", "Radiohead"]);
  assert.equal(data.playlists.u1.vidList.list.a.swap, undefined, "no audio track for a video playlist");
  assert.match(swaps.summary(stats), /2 SoundCloud searches/);

  // a track flagged while playing from a SoundCloud playlist: SoundCloud only (remembered)
  searches.length = 0;
  scSearches.length = 0;
  await sw.track("u1", db.ref("playlists/u1/scList/list"), "a", "scList");
  assert.equal(searches.length, 0);
  assert.equal(scSearches.length, 0, "already remembered");
  await sw.track("u1", db.ref("playlists/u1/plain/list"), "a", "plain");
  assert.equal(searches.length, 0, "already remembered, no new search");
});

test("playlist formats: unset or unknown counts as YouTube Music", () => {
  assert.equal(swaps.formatOf({ a: "sc" }, "a"), "sc");
  assert.equal(swaps.formatOf({ a: "video" }, "a"), "video");
  assert.equal(swaps.formatOf({}, "a"), "ytm");
  assert.equal(swaps.formatOf({ a: "spotify" }, "a"), "ytm");
  assert.equal(swaps.formatOf(null, "0"), "ytm");
  assert.equal(swaps.swapsFor("ytm"), true);
  assert.equal(swaps.swapsFor("sc"), false);
  assert.equal(swaps.swapsFor("video"), true, "video playlists get video swaps");
  assert.equal(swaps.wantsAudio("ytm"), true);
  assert.equal(swaps.wantsAudio("video"), false);
});

// ─── Swaps: free sources first, then the paid search ──────────────────────
const vfy = (map) => async (ids) => Object.fromEntries(ids.filter((i) => map[i]).map((i) => [i, map[i]]));

test("new releases under YouTube's stand-in \"Release - Topic\" channel get the artist their description names", () => {
  const full = "Provided to YouTube by DistroKid\n\nNew Song · Real Band · Guest\n\n℗ 2026 Real Band\n\nReleased on: 2026-11-07\n\nAuto-generated by YouTube.";
  assert.equal(swaps.descriptionArtist(full, "New Song"), "Real Band");
  assert.equal(swaps.descriptionArtist(full, "Some Other Title"), "Real Band", "the · line, by itself, in a full description");
  // search results: one line, cut short
  assert.equal(swaps.descriptionArtist("Provided to YouTube by DistroKid New Song · Real Band ℗ 2026 Real Band Released on: 2026-11-07", "New Song"), "Real Band");
  assert.equal(swaps.descriptionArtist("Provided to YouTube by DistroKid New Song · Real Ba", "New Song"), "", "an artist cut off isn't trusted");
  assert.equal(swaps.descriptionArtist("Provided to YouTube by DistroKid New Song · Real Band ℗ 2026", "Other"), "", "one line without the title: no telling");
  assert.equal(swaps.descriptionArtist("Official video. Directed by …", "New Song"), "");
  assert.equal(swaps.descriptionArtist("Provided to YouTube by X\n\nSong · Various Artists\n\n℗ 2026", "Song"), "");
  assert.equal(swaps.topicChannel("Release - Topic", full, "New Song"), "Real Band - Topic");
  assert.equal(swaps.topicChannel("Various Artists - Topic", full, "New Song"), "Real Band - Topic");
  assert.equal(swaps.topicChannel("Release - Topic", "", "New Song"), "Release - Topic", "no description: as it is");
  assert.equal(swaps.topicChannel("Radiohead - Topic", full, "New Song"), "Radiohead - Topic", "an artist's own channel stays");
  assert.equal(swaps.topicChannel("Release", full, "New Song"), "Release", "not a Topic channel");
  assert.equal(swaps.isStandIn("Release"), true);
  assert.equal(swaps.isStandIn("release - Topic"), true);
  assert.equal(swaps.isStandIn("Released"), false);
});

test("Art Tracks, videos as songs, the artist's own videos", () => {
  assert.equal(swaps.isArtTrack({ channel: "Radiohead - Topic" }), true);
  assert.equal(swaps.isArtTrack({ channel: "Radiohead", description: "Provided to YouTube by XL Recordings\n\nKarma Police · Radiohead" }), true, "merged into the artist's channel");
  assert.equal(swaps.isArtTrack({ channel: "Radiohead", description: "Karma Police\n\nAuto-generated by YouTube." }), true);
  assert.equal(swaps.isArtTrack({ channel: "Radiohead", description: "Official video. Directed by …" }), false);
  assert.deepEqual(swaps.videoSong({ title: "Radiohead - Karma Police (Official Video)", channel: "x" }), { artist: "Radiohead", title: "Karma Police (Official Video)" });
  assert.deepEqual(swaps.videoSong({ title: "Karma Police", channel: "RadioheadVEVO" }), { artist: "Radiohead", title: "Karma Police" });
  assert.equal(swaps.officialFor("Radiohead - Karma Police", "Radiohead"), true);
  assert.equal(swaps.officialFor("Radiohead - Karma Police", "RadioheadVEVO"), true);
  assert.equal(swaps.officialFor("Radiohead - Karma Police", "Lyrics Daily"), false);
});

test("swap runner: the room's other uploads and the year playlists come before any search", async () => {
  const data = { queues: { u1: {
    a: broken("dead0000001", "Radiohead - Karma Police"),
    b: broken("dead0000002", "Radiohead - Lucky"),
    c: broken("dead0000003", "Radiohead - Airbag")
  } } };
  const { db } = fakeDb(data);
  const searches = [];
  const sw = swaps.createSwapper({
    db, shallowKeys: async () => [], users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0,
    siblings: async (ups) => (ups[0].cid === "dead0000001" ? [{ cid: "dead0000001", artist: "Radiohead", title: "Karma Police" },
      { cid: "roomvideo01", artist: "Radiohead", title: "Karma Police" }, { cid: "roomaudio01", artist: "Radiohead", title: "Karma Police" }] : []),
    library: async () => [{ cid: "libvideo001", artist: "Radiohead", title: "Lucky", kind: "MUSIC_VIDEO_TYPE_OMV" },
      { cid: "libaudio001", artist: "Radiohead", title: "Lucky", album: "OK Computer", dur: 260, kind: "MUSIC_VIDEO_TYPE_ATV" }],
    search: async (q) => { searches.push(q); return realSearch([]); },
    webSearch: async (q) => { searches.push("web " + q); return []; },
    verify: vfy({ roomvideo01: { problem: 0, audio: false }, roomaudio01: { problem: 0, audio: true, dur: 262 }, libaudio001: { problem: 0, audio: true } }),
    notify: () => {}
  });
  const stats = await sw.run();
  const q = data.queues.u1;
  assert.equal(q.a.swap.cid, "roomaudio01", "the room's audio track, not its video");
  assert.equal(q.a.swap.audio, undefined, "only what the rules allow is saved with the track");
  assert.equal(q.b.swap.cid, "libaudio001", "the year playlists' audio track");
  assert.equal(q.b.swap.album, "OK Computer");
  assert.equal(q.c.swap, undefined);
  assert.deepEqual(searches, ["Radiohead Airbag", "web Radiohead Airbag"], "only the song no free source had is searched for");
  assert.equal(stats.from.room, 1);
  assert.equal(stats.from.library, 1);
  assert.match(swaps.summary(stats), /matches from 1 room history, 1 year playlists/);
});

test("swap runner: YouTube search finds audio tracks for audio lists and the artist's videos for video lists", async () => {
  const data = {
    queues: { u1: { a: broken("dead0000001", "Radiohead - Karma Police") } },
    playlists: { u1: { vids: { name: "Videos", list: { a: broken("dead0000002", "Radiohead - Karma Police") } } } },
    playlistPrefs: { u1: { format: { vids: "video" } } }
  };
  const { db, at } = fakeDb(data);
  const web = [
    { cid: "fanlyrics01", title: "Radiohead - Karma Police (Lyrics)", channel: "Lyrics Daily", dur: 262 },
    { cid: "officialv01", title: "Radiohead - Karma Police (Official Video)", channel: "Radiohead", dur: 270 },
    { cid: "arttrack001", title: "Karma Police", channel: "Radiohead", dur: 262, description: "Provided to YouTube by XL Recordings Karma Police · Radiohead" }
  ];
  const sw = swaps.createSwapper({
    db, shallowKeys: async (p) => Object.keys(at(p) || {}), users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0,
    search: async () => realSearch([]),
    webSearch: async () => web,
    verify: vfy({ fanlyrics01: { problem: 0, audio: false }, officialv01: { problem: 0, audio: false, dur: 270 }, arttrack001: { problem: 0, audio: true, dur: 262 } }),
    notify: () => {}
  });
  await sw.run();
  assert.equal(data.queues.u1.a.swap.cid, "arttrack001", "an audio list gets the audio track");
  assert.equal(data.playlists.u1.vids.list.a.swap.cid, "officialv01", "a video list gets the artist's video, never the audio track or a fan upload");
  const ids = Object.keys(data.swapCache);
  assert.equal(ids.length, 2, "audio and video answers are remembered apart");
  assert.ok(ids.some((id) => id.startsWith("w")));
});

test("swap runner: people's playlists on YouTube hold the audio tracks YouTube's searches never list", async () => {
  const data = { queues: { u1: { a: broken("dead0000001", "Poolside - Harvest Moon") } } };
  const { db } = fakeDb(data);
  const read = [];
  const sw = swaps.createSwapper({
    db, shallowKeys: async () => [], users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0,
    search: async () => realSearch([songRow]),
    playlistSearch: async () => [{ id: "PLone" }, { id: "PLtwo" }, { id: "PLthree" }, { id: "PLfour" }],
    playlist: async (id) => { read.push(id); return { tracks: id === "PLtwo" ? [
      { cid: "omvvideo001", artist: "Poolside", title: "Harvest Moon", dur: 369, kind: "MUSIC_VIDEO_TYPE_OMV" },
      { cid: "arttrack001", artist: "Poolside", title: "Harvest Moon", dur: 369, kind: "" }] : [] }; },
    webSearch: async () => { throw new Error("not needed"); },
    verify: vfy({ omvvideo001: { problem: 0, audio: false }, arttrack001: { problem: 0, audio: true, dur: 369 } }),
    notify: () => {}
  });
  const stats = await sw.run();
  assert.equal(data.queues.u1.a.swap.cid, "arttrack001", "the audio track, checked to be one");
  assert.deepEqual(read, ["PLone", "PLtwo", "PLthree"], "the top three playlists' first pages");
  assert.equal(stats.from.lists, 1);
  assert.equal(stats.webSearched, 0, "found already: YouTube's video search isn't asked");
});

test("swap runner: the paid search stands in for a free search that doesn't answer, most-listed first, within the day's units", async () => {
  const names = ["Radiohead - Airbag", "Radiohead - Let Down", "Radiohead - Lucky"];
  const data = { queues: {
    u1: { a: broken("dead0000001", names[0]), b: broken("dead0000002", names[1]), c: broken("dead0000003", names[2]) },
    u2: { a: broken("dead0000004", names[1]) }
  } };
  const { db } = fakeDb(data);
  const paid = [];
  let t = Date.now();
  const sw = swaps.createSwapper({
    db, shallowKeys: async () => [], users: () => ({ u1: { username: "u1" }, u2: { username: "u2" } }), botid: () => "bot", delayMs: 0, now: () => t,
    search: async () => realSearch([songRow]), // the catalog answers, but has none of these
    playlistSearch: async () => { throw new Error("HTTP 429"); }, // YouTube's free playlist search is down
    playlist: async (id) => ({ tracks: id === "PLpaid" ? [{ cid: "paidaudio01", artist: "Radiohead", title: "Let Down", kind: "" }] : [] }),
    apiSearch: async () => { throw new Error("audio lists don't get the video search"); },
    apiPlaylistSearch: async (q) => { paid.push(q); return [{ id: "PLpaid" }]; },
    apiUnits: 100,
    verify: vfy({ paidaudio01: { problem: 0, audio: true } }),
    notify: () => {}
  });
  const unpaid = await sw.run({ quiet: true });
  assert.equal(paid.length, 0, "no paid search unless the run allows it");
  assert.equal(unpaid.apiUnits, 0);
  assert.match(unpaid.listsOff, /isn't answering/);
  const stats = await sw.run({ full: true, paid: true });
  assert.deepEqual(paid, ["Radiohead Let Down"], "one search (100 units): the song in the most lists first");
  assert.equal(stats.apiUnits, 100);
  assert.equal(stats.apiWaiting, 2, "the rest wait for tomorrow's units");
  assert.equal(data.queues.u1.b.swap.cid, "paidaudio01");
  assert.equal(data.queues.u2.a.swap.cid, "paidaudio01");
  assert.match(swaps.summary(stats), /YouTube API units \(100 on search\)/);
  const again = await sw.run({ full: true, paid: true });
  assert.equal(paid.length, 1, "today's units are spent");
  assert.equal(again.apiWaiting, 2);
  t += 86400000;
  await sw.run({ full: true, paid: true });
  assert.equal(paid.length, 2, "a new day, the next song");
  t += 86400000;
  await sw.run({ full: true, paid: true });
  t += 86400000;
  const done = await sw.run({ full: true, paid: true });
  assert.equal(paid.length, 3, "a song the paid search missed isn't paid for again for 30 days");
  assert.equal(done.apiSearched, 0);
});

test("swap runner: no paid search for a song whose free search answered (it would find the same)", async () => {
  const data = { queues: { u1: { a: broken("dead0000001", "Radiohead - Airbag") } } };
  const { db } = fakeDb(data);
  const paid = [];
  const sw = swaps.createSwapper({
    db, shallowKeys: async () => [], users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0,
    search: async () => realSearch([songRow]),
    playlistSearch: async () => [{ id: "PLnothing" }],
    playlist: async () => ({ tracks: [] }),
    apiPlaylistSearch: async (q) => { paid.push(q); return []; },
    apiUnits: 1000, verify: vfy({}), notify: () => {}
  });
  const stats = await sw.run({ paid: true });
  assert.equal(paid.length, 0);
  assert.equal(stats.apiUnits, 0);
  assert.ok(Object.values(data.swapCache)[0].free, "remembered as answered by a free search");
});

test("YouTube search answers: videos with their channel, length and description", () => {
  const answer = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { videoRenderer: { videoId: "abcdefghij1", title: { runs: [{ text: "Radiohead - Karma Police" }] }, ownerText: { runs: [{ text: "Radiohead - Topic" }] },
      lengthText: { simpleText: "4:22" }, detailedMetadataSnippets: [{ snippetText: { runs: [{ text: "Provided to YouTube by XL" }] } }] } },
    { videoRenderer: { videoId: "abcdefghij1", title: { runs: [{ text: "again" }] } } },
    { videoRenderer: { videoId: "bad" } },
    { shelfRenderer: {} }
  ] } }] } } } } };
  const got = ytmusic.parseWebSearch(answer);
  assert.deepEqual(got, [{ cid: "abcdefghij1", title: "Radiohead - Karma Police", channel: "Radiohead - Topic", dur: 262, description: "Provided to YouTube by XL" }]);
  assert.equal(swaps.isArtTrack(got[0]), true);
});

test("videoRank: the artist's official music video first; lyric videos, 'Official Audio', fan uploads and audio tracks never", () => {
  const name = "Radiohead - Karma Police";
  assert.equal(swaps.videoRank(name, { channel: "RadioheadVEVO", title: "Radiohead - Karma Police (Official Music Video)" }), 3);
  assert.equal(swaps.videoRank(name, { channel: "Radiohead", title: "Radiohead - Karma Police" }), 2);
  assert.equal(swaps.videoRank(name, { channel: "Some Label", title: "Karma Police", official: true }), 2, "the video YouTube Music pairs with the song");
  assert.equal(swaps.videoRank(name, { channel: "Radiohead", title: "Radiohead - Karma Police (Official Lyric Video)" }), 1);
  assert.equal(swaps.videoRank(name, { channel: "Radiohead", title: "Karma Police (Official Audio)" }), 1);
  assert.equal(swaps.videoRank(name, { channel: "Radiohead", title: "Karma Police (Visualizer)" }), 1);
  assert.equal(swaps.videoRank(name, { channel: "Lyrics Daily", title: "Radiohead - Karma Police (Official Video)" }), 0, "a fan upload, whatever its title says");
  assert.equal(swaps.videoRank(name, { channel: "Radiohead - Topic", title: "Karma Police" }), -1);
});

test("swap runner: video lists get the official music video first, through YouTube Music's toggle when searches miss it", async () => {
  const data = {
    playlists: { u1: {
      vids: { name: "Videos", list: { a: broken("dead0000002", "Radiohead - Karma Police"), b: broken("dead0000003", "Phoenix - Lisztomania") } }
    } },
    playlistPrefs: { u1: { format: { vids: "video" } } }
  };
  const { db, at } = fakeDb(data);
  const web = (q) => (/Karma/.test(q) ? [
    { cid: "kplyric0001", title: "Radiohead - Karma Police (Official Lyric Video)", channel: "Radiohead", dur: 262 },
    { cid: "kpaudio0001", title: "Radiohead - Karma Police (Official Audio)", channel: "Radiohead", dur: 262 },
    { cid: "kplive00001", title: "Radiohead - Karma Police", channel: "Radiohead", dur: 270 },
    { cid: "kpvideo0001", title: "Radiohead - Karma Police (Official Music Video)", channel: "RadioheadVEVO", dur: 270 }
  ] : [{ cid: "lcfan000001", title: "Phoenix - Lisztomania (Official Video)", channel: "Fan Uploads", dur: 245 }]);
  const info = (channel, title, dur) => ({ problem: 0, audio: false, dur, channel, title });
  const twins = [];
  const sw = swaps.createSwapper({
    db, shallowKeys: async (p) => Object.keys(at(p) || {}), users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0, twinDelayMs: 0,
    search: async () => realSearch([]),
    webSearch: async (q) => web(q),
    library: async () => [{ cid: "lcstudio001", artist: "Phoenix", title: "Lisztomania", dur: 241, kind: "MUSIC_VIDEO_TYPE_ATV" }],
    counterpart: async (cid) => { twins.push(cid); return cid === "lcstudio001" ? { cid: "lcvideo0001", artist: "Phoenix", title: "Lisztomania", dur: 245, kind: "MUSIC_VIDEO_TYPE_OMV" } : null; },
    verify: vfy({
      kplyric0001: info("Radiohead", "Radiohead - Karma Police (Official Lyric Video)", 262),
      kpaudio0001: info("Radiohead", "Radiohead - Karma Police (Official Audio)", 262),
      kplive00001: info("Radiohead", "Radiohead - Karma Police", 270),
      kpvideo0001: info("RadioheadVEVO", "Radiohead - Karma Police (Official Music Video)", 270),
      lcfan000001: info("Fan Uploads", "Phoenix - Lisztomania (Official Video)", 245),
      lcvideo0001: info("Phoenix", "Phoenix - Lisztomania (Official Video)", 245),
      lcstudio001: { problem: 0, audio: true, dur: 241, channel: "Phoenix - Topic", title: "Lisztomania" }
    }),
    notify: () => {}
  });
  await sw.run();
  const list = data.playlists.u1.vids.list;
  assert.equal(list.a.swap.cid, "kpvideo0001", "the official music video, ahead of the lyric video, the 'Official Audio' and another upload");
  assert.equal(list.b.swap.cid, "lcvideo0001", "the year playlists' audio track, toggled to its official video; never the fan upload");
  assert.deepEqual(twins, ["lcstudio001"]);
});

test("swap runner: suggestions that don't fit the playlist's format are cleared, and ones that fit are found", async () => {
  const withSwap = (cid, name, swap) => Object.assign(broken(cid, name), { swap: Object.assign({ date: Date.now() }, swap) });
  const data = {
    queues: { u1: { a: withSwap("dead0000001", "Radiohead - Lucky", { cid: "studio00001", kind: "audio" }) } }, // the Default list kept to SoundCloud
    playlists: { u1: {
      vids: { name: "Videos", list: {
        a: withSwap("dead0000002", "Radiohead - Karma Police", { cid: "studio00001", kind: "audio" }), // an audio track in a video list
        b: withSwap("dead0000003", "Radiohead - Karma Police", { cid: "studio00001" }), // saved before kinds: YouTube says it's audio
        c: withSwap("dead0000004", "Radiohead - Karma Police", { dismissed: "studio00001" }) // "not this one" stays
      } },
      ytm: { name: "YTM", list: {
        a: withSwap("dead0000005", "Radiohead - Karma Police", { cid: "officialv01", kind: "video" }), // a video in a YouTube Music list
        b: withSwap("dead0000006", "Radiohead - Karma Police", { cid: "studio00001" }) // saved before kinds, an audio track: kept, kind added
      } }
    } },
    playlistPrefs: { u1: { format: { 0: "sc", vids: "video", ytm: "ytm" } } }
  };
  const { db, at } = fakeDb(data);
  const sw = swaps.createSwapper({
    db, shallowKeys: async (p) => Object.keys(at(p) || {}), users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0,
    search: async () => realSearch([songRow]),
    webSearch: async () => [{ cid: "officialv01", title: "Radiohead - Karma Police (Official Video)", channel: "Radiohead", dur: 270 }],
    verify: vfy({
      studio00001: { problem: 0, audio: true, dur: 262, channel: "Radiohead - Topic", title: "Karma Police" },
      officialv01: { problem: 0, audio: false, dur: 270, channel: "Radiohead", title: "Radiohead - Karma Police (Official Video)" }
    }),
    notify: () => {}
  });
  const stats = await sw.run();
  assert.equal(data.queues.u1.a.swap, undefined, "a SoundCloud list's suggestion is cleared");
  const v = data.playlists.u1.vids.list, y = data.playlists.u1.ytm.list;
  assert.deepEqual([v.a.swap.cid, v.a.swap.kind], ["officialv01", "video"], "the audio track gives way to the artist's video");
  assert.equal(v.b.swap, undefined, "an old suggestion YouTube says is an audio track is cleared from a video list");
  assert.equal(v.c.swap.dismissed, "studio00001");
  assert.deepEqual([y.a.swap.cid, y.a.swap.kind], ["studio00001", "audio"], "the video gives way to the audio track");
  assert.deepEqual([y.b.swap.cid, y.b.swap.kind], ["studio00001", "audio"], "an old one that fits stays, and now says what it is");
  assert.ok(stats.cleared >= 2);
  assert.match(swaps.summary(stats), /didn't fit the playlist's format cleared/);
});

test("swap runner: tracks that play but don't fit their playlist's format get a copy that does", async () => {
  const yt = (cid, name) => ({ type: 1, cid, name });
  const sc = (cid, name) => ({ type: 2, cid, name, duration: 262 });
  const data = {
    playlists: { u1: {
      ytm: { name: "YTM", list: {
        v: yt("kpvideo0001", "Radiohead - Karma Police"), // a music video
        s: sc(333, "Radiohead - Karma Police"), // a SoundCloud track
        a: yt("studio00001", "Radiohead - Karma Police"), // fits
        old: Object.assign(yt("nsstudio001", "Radiohead - No Surprises"), { swap: { cid: "nsvideo0001", kind: "audio", why: "format", date: 1 } }) // fits now
      } },
      vids: { name: "Videos", list: { a: yt("studio00001", "Radiohead - Karma Police") } }, // an audio track in a video list
      any: { name: "Any", list: { v: yt("kpvideo0001", "Radiohead - Karma Police") } } // no format: anything goes, not read whole
    } },
    playlistPrefs: { u1: { format: { ytm: "ytm", vids: "video" } } }
  };
  const { db, at } = fakeDb(data);
  const verified = [];
  const sw = swaps.createSwapper({
    db, shallowKeys: async (p) => Object.keys(at(p) || {}), users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0, twinDelayMs: 0,
    search: async () => realSearch([songRow]),
    counterpart: async (cid) => (cid === "studio00001" ? { cid: "kpvideo0001", artist: "Radiohead", title: "Karma Police", dur: 270, kind: "MUSIC_VIDEO_TYPE_OMV" } : null),
    verify: async (ids) => {
      verified.push(...ids);
      return vfy({
        kpvideo0001: { problem: 0, audio: false, dur: 270, channel: "RadioheadVEVO", title: "Radiohead - Karma Police (Official Music Video)" },
        studio00001: { problem: 0, audio: true, dur: 262, channel: "Radiohead - Topic", title: "Karma Police" },
        nsstudio001: { problem: 0, audio: true, dur: 229, channel: "Radiohead - Topic", title: "No Surprises" }
      })(ids);
    },
    notify: () => {}
  });
  const stats = await sw.run();
  const y = data.playlists.u1.ytm.list;
  assert.deepEqual([y.v.swap.cid, y.v.swap.kind, y.v.swap.why], ["studio00001", "audio", "format"], "the video gets its audio track");
  assert.equal(y.v.flagged, undefined, "nothing is flagged");
  assert.deepEqual([y.s.swap.cid, y.s.swap.why], ["studio00001", "format"], "the SoundCloud track gets the audio track");
  assert.equal(y.a.swap, undefined, "an audio track fits");
  assert.equal(y.old.swap, undefined, "a format suggestion on a track that fits now is cleared");
  const v = data.playlists.u1.vids.list.a.swap;
  assert.deepEqual([v.cid, v.kind, v.why], ["kpvideo0001", "video", "format"], "the audio track gets its official video, through the toggle");
  assert.equal(data.playlists.u1.any.list.v.swap, undefined, "a list with no format set takes anything");
  assert.deepEqual(data.trackKinds, { kpvideo0001: "v3", studio00001: "a", nsstudio001: "a" }, "what each upload is (a video: how it ranks), remembered");
  assert.equal(stats.offFormat, 3);
  assert.match(swaps.summary(stats), /3 tracks that don't fit their playlist's format/);

  // next run: the kinds come from trackKinds, not YouTube
  verified.length = 0;
  await sw.run({ full: true });
  assert.ok(!verified.includes("nsstudio001"), "an upload's kind is asked once");
});

test("swap runner: trackKinds is followed (downloaded once, then what's added), not read again every run", async () => {
  const yt = (cid, name) => ({ type: 1, cid, name });
  const data = {
    playlists: { u1: { ytm: { name: "YTM", list: { v: yt("kpvideo0001", "Radiohead - Karma Police"), a: yt("studio00001", "Radiohead - Karma Police") } } } },
    playlistPrefs: { u1: { format: { ytm: "ytm" } } },
    trackKinds: { kpvideo0001: "v3" } // known already
  };
  const base = fakeDb(data);
  const kindReads = [];
  const listeners = [];
  // trackKinds with listeners, like the real database: child_added for what's there, then for what's added
  const db = { ref: (path) => {
    const r = base.db.ref(path);
    if (path !== "trackKinds") return r;
    return Object.assign({}, r, {
      once: async () => { kindReads.push("once"); return r.once(); },
      on: (ev, cb) => {
        if (ev === "child_added") {
          kindReads.push("listen");
          Object.keys(data.trackKinds || {}).forEach((k) => cb({ key: k, val: () => data.trackKinds[k] }));
          listeners.push(cb);
        }
        return cb;
      },
      update: async (v) => { await r.update(v); Object.keys(v).forEach((k) => listeners.forEach((cb) => cb({ key: k, val: () => v[k] }))); }
    });
  } };
  const verified = [];
  const sw = swaps.createSwapper({
    db, shallowKeys: async (p) => Object.keys(base.at(p) || {}), users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0, twinDelayMs: 0,
    search: async () => realSearch([songRow]),
    verify: async (ids) => {
      verified.push(...ids);
      return vfy({ studio00001: { problem: 0, audio: true, dur: 262, channel: "Radiohead - Topic", title: "Karma Police" } })(ids);
    },
    notify: () => {}
  });
  await sw.run({ full: true });
  assert.deepEqual(verified, ["studio00001"], "only the upload trackKinds doesn't know is asked of YouTube");
  assert.equal(data.trackKinds.studio00001, "a", "and remembered");
  assert.equal(data.playlists.u1.ytm.list.v.swap.cid, "studio00001", "the video in a YouTube Music list still gets its audio track");
  // someone else (another copy of the bot) learns a kind: it arrives through the listener
  data.trackKinds.other000001 = "a";
  listeners.forEach((cb) => cb({ key: "other000001", val: () => "a" }));
  verified.length = 0;
  await sw.run({ full: true });
  await sw.run({ full: true });
  assert.deepEqual(verified, [], "later runs ask YouTube nothing");
  assert.deepEqual(kindReads, ["listen", "once"], "one listener, one first read (answered from it); never read again");
});

test("swap runner: a video list's promoter and fan uploads get the official music video, where there is one", async () => {
  const yt = (cid, name) => ({ type: 1, cid, name });
  const data = {
    playlists: { u1: { vids: { name: "Videos", list: {
      p: yt("promoter001", "Radiohead - Karma Police"), // a promoter's upload
      o: yt("kpvideo0001", "Radiohead - Karma Police"), // the official video: nothing to do
      r: yt("remix000001", "Radiohead - Karma Police (Some DJ Remix)"), // an independent remix: no official video, stays
      c: yt("artistch001", "Radiohead - No Surprises") // the artist's own upload, not titled official; the official one exists
    } } } },
    playlistPrefs: { u1: { format: { vids: "video" } } }
  };
  const { db, at } = fakeDb(data);
  const info = (channel, title, dur) => ({ problem: 0, audio: false, dur, channel, title });
  const sw = swaps.createSwapper({
    db, shallowKeys: async (p) => Object.keys(at(p) || {}), users: () => ({ u1: { username: "u1" } }), botid: () => "bot", delayMs: 0, twinDelayMs: 0,
    search: async () => realSearch([]),
    webSearch: async (q) => (/Karma/.test(q) ? [{ cid: "kpvideo0001", title: "Radiohead - Karma Police (Official Music Video)", channel: "RadioheadVEVO", dur: 270 }]
      : /Surprises/.test(q) ? [{ cid: "nsvideo0001", title: "Radiohead - No Surprises (Official Video)", channel: "Radiohead", dur: 230 }] : []),
    verify: vfy({
      promoter001: info("Majestic Casual", "Radiohead - Karma Police", 268),
      kpvideo0001: info("RadioheadVEVO", "Radiohead - Karma Police (Official Music Video)", 270),
      remix000001: info("Some DJ", "Radiohead - Karma Police (Some DJ Remix)", 300),
      artistch001: info("Radiohead", "No Surprises", 229),
      nsvideo0001: info("Radiohead", "Radiohead - No Surprises (Official Video)", 230)
    }),
    notify: () => {}
  });
  await sw.run();
  const l = data.playlists.u1.vids.list;
  assert.deepEqual([l.p.swap.cid, l.p.swap.kind, l.p.swap.why], ["kpvideo0001", "video", "format"], "the promoter's upload gets the official video");
  assert.equal(l.o.swap, undefined);
  assert.equal(l.r.swap, undefined, "a remix with no official video stays as it is");
  assert.equal(l.r.flagged, undefined);
  assert.equal(l.c.swap.cid, "nsvideo0001", "the artist's plain upload gets their official video");
  assert.deepEqual([data.trackKinds.promoter001, data.trackKinds.kpvideo0001, data.trackKinds.artistch001], ["v0", "v3", "v2"]);
});

test("swap runner: what's over the search limits gets a catch-up pass the same day; someone coming online gets looked at", async () => {
  const data = { queues: {
    u1: { a: broken("dead0000001", "Radiohead - Airbag"), b: broken("dead0000002", "Radiohead - Let Down"), c: broken("dead0000003", "Radiohead - Lucky") },
    u2: { a: broken("dead0000004", "Radiohead - Karma Police") }
  } };
  const { db: store } = fakeDb(data);
  const reads = [];
  const db = { ref: (p) => Object.assign({}, store.ref(p), { once: (...a) => { reads.push(p); return store.ref(p).once(...a); } }) };
  const timers = [];
  let t = Date.UTC(2026, 10, 13, 4);
  const users = { u1: { username: "u1", status: true }, u2: { username: "u2", idle: { since: t - 1000 } } };
  const sw = swaps.createSwapper({
    db, shallowKeys: async () => [], users: () => users, botid: () => "bot", delayMs: 0, now: () => t,
    search: async (q) => realSearch([{ cid: "studio" + q.length.toString().padStart(5, "0"), title: q.replace("Radiohead ", ""), artists: ["Radiohead"] }]),
    verify: async (ids) => Object.fromEntries(ids.map((i) => [i, { problem: 0, audio: true }])), notify: () => {},
    maxSearches: 2, catchUp: true, catchUpMinutes: 30,
    setTimer: (fn, ms) => { const tm = { fn, ms }; timers.push(tm); return tm; }, clearTimer: (tm) => { tm.cancelled = true; }
  });
  const s1 = await sw.run({ reason: "nightly" });
  assert.equal(s1.capped, 2, "two songs over this run's limit of 2 searches");
  assert.ok(timers.length === 1 && timers[0].ms === 30 * 60 * 1000, "a catch-up pass in 30 minutes");
  assert.ok(sw.state.nextAt > t && sw.state.backlog.capped === 2);
  const pending = Object.values(data.swapScans).filter((v) => v === 0).length;
  assert.ok(pending >= 1, "whoever isn't done is marked not done");

  // the catch-up pass runs: only people not done, and what waited is found
  t += 30 * 60 * 1000;
  timers[0].fn();
  await new Promise((r) => setTimeout(r, 50));
  const all = [...Object.values(data.queues.u1), ...Object.values(data.queues.u2)];
  assert.ok(all.every((tr) => tr.swap && tr.swap.cid), "every broken track has its swap after the catch-up pass");
  assert.ok(Object.values(data.swapScans).every((v) => v > 0), "and everyone is done");
  assert.equal(sw.state.today.passes, 1);

  // someone comes online after a day: looked at in a few minutes
  t += 25 * 60 * 60 * 1000;
  timers.length = 0;
  reads.length = 0;
  assert.equal(await sw.online("u2"), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5 * 60 * 1000);
  assert.equal(await sw.online("u2"), true, "a second arrival shares the pass already planned");
  assert.equal(timers.length, 1);
  assert.ok(!reads.some((p) => /^swapScans/.test(p)), "an arrival this run has marked costs no read (" + reads.join(", ") + ")");
});

test("swap runner: an arrival reads just that person's mark, never everyone's", async () => {
  const t = Date.UTC(2026, 10, 13, 4);
  const data = { swapScans: { u3: t - 60 * 60 * 1000, u4: t - 2 * 86400000, u5: 0 } };
  const { db } = fakeDb(data);
  const reads = [];
  const timers = [];
  const sw = swaps.createSwapper({
    db: { ref: (p) => Object.assign({}, db.ref(p), { once: (...a) => { reads.push(p); return db.ref(p).once(...a); } }) },
    shallowKeys: async () => [], users: () => ({}), botid: () => "bot", delayMs: 0, now: () => t, notify: () => {},
    search: async () => realSearch([]), verify: async () => ({}), catchUp: true,
    setTimer: (fn, ms) => { const tm = { fn, ms }; timers.push(tm); return tm; }, clearTimer: (tm) => { tm.cancelled = true; }
  });
  assert.equal(await sw.online("u3"), false, "looked through an hour ago: nothing to do");
  assert.equal(await sw.online("u4"), true, "two days ago: a pass soon");
  assert.equal(await sw.online("u5"), true, "marked not done");
  assert.equal(await sw.online("new1"), true, "never looked at");
  assert.deepEqual(reads, ["swapScans/u3", "swapScans/u4", "swapScans/u5", "swapScans/new1"]);
  assert.equal(timers.length, 1);
});

test("swap runner: saved answers kept in memory are capped; older ones are read again from the database", async () => {
  const data = {};
  const { db } = fakeDb(data);
  const reads = [];
  const searches = [];
  const rows = { "Radiohead Airbag": "studio00001", "Radiohead Lucky": "studio00002", "Radiohead Let Down": "studio00003" };
  const sw = swaps.createSwapper({
    db: { ref: (p) => Object.assign({}, db.ref(p), { once: (...a) => { reads.push(p); return db.ref(p).once(...a); } }) },
    shallowKeys: async () => [], delayMs: 0, log: () => {}, memCacheMax: 2,
    search: async (q) => { searches.push(q); return realSearch([{ cid: rows[q], title: q.replace("Radiohead ", ""), artists: ["Radiohead"], dur: 200 }]); },
    verify: async (ids) => Object.fromEntries(ids.map((i) => [i, { problem: 0, dur: 200, audio: true }]))
  });
  const items = Object.keys(rows).map((q) => ({ name: q.replace("Radiohead ", "Radiohead - "), dur: 200 }));
  const first = await sw.lookup(items);
  assert.deepEqual(first.picks.map((p) => p[0] && p[0].cid), Object.values(rows));
  assert.equal(searches.length, 3);
  assert.equal(Object.keys(data.swapCache).length, 3, "all three saved in the database");
  // the database loses them: only the two newest are still in memory
  delete data.swapCache;
  reads.length = 0;
  const again = await sw.lookup(items);
  assert.deepEqual(again.picks.map((p) => p[0] && p[0].cid), Object.values(rows), "the same answers");
  assert.equal(reads.filter((p) => /^swapCache\//.test(p)).length, 1, "only the oldest is read again");
  assert.equal(searches.length, 4, "and, gone from the database, searched again");
});

// --------------------------------------------------------- the stage summary

test("the stage summary: who's in the room and at the table, the song's looks, nothing else about members", async () => {
  const { stageOf, createStage } = require("../lib/stage.js");
  const users = {
    bot: { username: "jarvis", status: true, hostbot: true },
    dj1: { username: "ana", status: true, avatarStyle: "dicebear:pixel-art", foundVia: "a friend", featured: { 0: "c1" } },
    dj2: { username: "ben", status: true },
    gone: { username: "cy", status: false }
  };
  const v = stageOf({ users, botid: "bot", table: [{ id: "dj1", name: "old" }, { id: "dj2" }, null], colors: { color: "#123", txt: "#fff", junk: 1 },
    theme: "Italo", bpm: { started: 5, bpm: 120, src: "deezer" }, tag: { cid: 9, adamData: { artist: "A" }, other: 1 }, fires: { started: 5, count: 2 } });
  assert.deepEqual(v, { online: 2, deck: [{ id: "dj1", n: "ana", av: "dicebear:pixel-art" }, { id: "dj2", n: "ben" }], colors: { color: "#123", txt: "#fff" },
    theme: "Italo", bpm: { started: 5, bpm: 120 }, tag: { cid: "9", adamData: { artist: "A" } }, fires: { started: 5, count: 2 }, style: null });
  assert.deepEqual(stageOf({ users: {} }), { online: 0, deck: [], colors: null, theme: null, bpm: null, tag: null, fires: null, style: null });

  const { fakeDb } = await import("./fake-db.mjs");
  const db = fakeDb({ table: [{ id: "dj1" }], theme: "Italo" });
  const pub = createStage({ db, users: () => users, botid: () => "bot", delay: 1000 });
  pub.start();
  assert.equal(await pub.flush(), true);
  assert.equal(db.get("stage/theme"), "Italo");
  assert.equal(db.get("stage/deck/0/n"), "ana");
  const n = db.writes.filter((p) => p === "stage").length;
  users.dj2.idle = { isIdle: true }; // a change the stage doesn't show
  pub.changed();
  assert.equal(await pub.flush(), false, "nothing it shows changed: nothing sent");
  users.dj2.status = false;
  assert.equal(await pub.flush(), true);
  assert.equal(db.get("stage/online"), 1);
  assert.equal(db.writes.filter((p) => p === "stage").length, n + 1);
});

test("the stage summary: the room's avatar style and each DJ's own Bouletmaton", async () => {
  const { stageOf, legacyOf, createStage } = require("../lib/stage.js");
  const bm = "2.5.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20";
  const users = { dj1: { username: "ana", status: true, boulet: bm, bouletOn: true }, dj2: { username: "ben", status: true, boulet: "<img src=x>", bouletOn: true },
    dj3: { username: "cy", status: true, boulet: bm, bouletOn: false } };
  const v = stageOf({ users, table: [{ id: "dj1" }, { id: "dj2" }, { id: "dj3" }], style: "bouletmaton" });
  assert.deepEqual(v.deck, [{ id: "dj1", n: "ana", bm }, { id: "dj2", n: "ben" }, { id: "dj3", n: "cy" }], "only a real Bouletmaton that's switched on is published");
  assert.equal(v.style, "bouletmaton");
  assert.equal(stageOf({ users, style: "dicebear:bottts" }).style, null, "a style the room no longer offers isn't published");
  assert.equal(stageOf({ users, style: "set2" }).style, "robohash:set2");
  const old = legacyOf(v);
  assert.equal("style" in old, false);
  assert.deepEqual(old.deck, [{ id: "dj1", n: "ana" }, { id: "dj2", n: "ben" }, { id: "dj3", n: "cy" }]);
  assert.equal(v.deck[0].bm, bm, "the full summary is untouched");

  // Older rules refuse the new fields: the rest is still published
  const { fakeDb } = await import("./fake-db.mjs");
  const db = fakeDb({ table: [{ id: "dj1" }], roomSettings: { avatarStyle: "bouletmaton" } });
  const realRef = db.ref.bind(db);
  db.ref = (path) => {
    const r = realRef(path);
    if (path !== "stage") return r;
    return Object.assign({}, r, { set: (val) => (val.style || val.deck.some((d) => d.bm)) ? Promise.reject(new Error("PERMISSION_DENIED")) : r.set(val) });
  };
  const logs = [];
  const pub = createStage({ db, users: () => users, delay: 1000, log: (m) => logs.push(m) });
  pub.start();
  assert.equal(await pub.flush(), true);
  assert.equal(db.get("stage/deck/0/n"), "ana");
  assert.equal(db.get("stage/deck/0/bm"), null);
  assert.ok(logs.some((m) => /without the room's avatar style/.test(m)));
});

test("avatar styles: only the room's six, robots by default", () => {
  const a = require("../lib/avatars.js");
  assert.deepEqual(a.STYLES, ["robohash:set1", "robohash:set2", "robohash:set4", "dicebear:notionists", "dicebear:pixel-art", "bouletmaton"]);
  assert.equal(a.DEFAULT_STYLE, "robohash:set1");
  assert.equal(a.normalizeAvatarStyle("set2"), "robohash:set2");
  assert.equal(a.normalizeAvatarStyle("set3"), null, "robot heads are gone");
  assert.equal(a.normalizeAvatarStyle("dicebear:bottts"), null);
  assert.equal(a.normalizeAvatarStyle(" bouletmaton "), "bouletmaton");
  assert.equal(a.normalizeAvatarStyle(""), null);
  assert.equal(a.normalizeAvatarStyle(null), null);
  assert.equal(a.isBoulet("4.12.12.62.27.54.17.93.96.25.42.18.21.32.72.18.25.33.27"), true);
  assert.equal(a.isBoulet("0.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1"), false);
  assert.equal(a.isBoulet("1.1.13.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1"), false, "beard colour 13");
  assert.equal(a.isBoulet(42), false);
});

test("who looks like what: October's monsters for everyone, else a switched-on Bouletmaton, else the room's style", () => {
  const a = require("../lib/avatars.js");
  const bm = "2.5.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20";
  const on = { boulet: bm, bouletOn: true }, off = { boulet: bm, bouletOn: false }, none = {};
  assert.deepEqual(a.avatarFor(on, null, null), { style: "bouletmaton", bm });
  assert.deepEqual(a.avatarFor(on, "dicebear:pixel-art", null), { style: "bouletmaton", bm }, "theirs stays on whatever the supermod picks");
  assert.deepEqual(a.avatarFor(on, "bouletmaton", "robohash:set2"), { style: "robohash:set2" }, "October: monsters, Bouletmatons too");
  assert.deepEqual(a.avatarFor(off, "bouletmaton", null), { style: "robohash:set1" }, "switched off: the room's");
  assert.deepEqual(a.avatarFor(none, "bouletmaton", null), { style: "robohash:set1" }, "Bouletmaton room: robots for anyone without one");
  assert.deepEqual(a.avatarFor(none, "robohash:set4", null), { style: "robohash:set4" });
  assert.deepEqual(a.avatarFor(none, null, null), { style: "robohash:set1" }, "robot busts by default");
  assert.equal(a.activeBoulet({ boulet: "2.5.12.30.4.9.40.10.50.20.0.8.3.40.0.0.12.0", bouletOn: true }), null, "the old 18-number codes aren't Bouletmatons any more");
  assert.equal(a.randomBoulet, undefined, "no made-up Bouletmatons");
});

// -------------------------------------------------------------- lean tracks

test("lean tracks: a YouTube track's own thumbnail and watch page go; anything else stays", () => {
  const { lean, derivedImg, derivedUrl } = require("../lib/tracks.js");
  const yt = { type: 1, cid: "abcDEF12345", name: "A - B", img: "https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg", url: "https://www.youtube.com/watch?v=abcDEF12345", from: "discover" };
  assert.deepEqual(lean(yt), { type: 1, cid: "abcDEF12345", name: "A - B", from: "discover" });
  assert.equal(yt.img.length > 0, true, "the original is untouched");
  assert.ok(derivedImg("https://i9.ytimg.com/vi_webp/abcDEF12345/maxresdefault.webp", "abcDEF12345"));
  assert.ok(derivedUrl("https://youtu.be/abcDEF12345", "abcDEF12345"));
  // kept: another video's art, a link with a start time, a custom image, a SoundCloud track's
  assert.equal(lean({ type: 1, cid: "abcDEF12345", img: "https://i.ytimg.com/vi/zzzZZZ99999/mqdefault.jpg" }).img, "https://i.ytimg.com/vi/zzzZZZ99999/mqdefault.jpg");
  assert.equal(lean({ type: 1, cid: "abcDEF12345", url: "https://www.youtube.com/watch?v=abcDEF12345&t=30" }).url, "https://www.youtube.com/watch?v=abcDEF12345&t=30");
  assert.equal(lean({ type: 1, cid: "abcDEF12345", img: "https://example.com/cover.jpg" }).img, "https://example.com/cover.jpg");
  const sc = { type: 2, cid: 123, img: "https://i1.sndcdn.com/artworks-x-large.jpg", url: "https://soundcloud.com/a/b" };
  assert.deepEqual(lean(sc), sc);
  assert.equal(lean(null), null);
});

// -------------------------------------------------------------- grab counts

test("grab counts: each DJ's grabs summed for the site, written only when they change", async () => {
  const { summaryOf, createGrabCounts } = require("../lib/grabs.js");
  assert.deepEqual(summaryOf({ "1_aaa": { u1: 5, u2: 9 }, "1_bbb": { u3: 7 } }), { n: 3, t: 2, last: "1_aaa", lastAt: 9 });
  assert.equal(summaryOf({}), null);
  assert.equal(summaryOf(null), null);
  const { fakeDb } = await import("./fake-db.mjs");
  const db = fakeDb({ grabs: { dj1: { "1_aaa": { u1: 5 } }, dj2: { "2_123": { u1: 6, u2: 8 } } } });
  const g = createGrabCounts({ db, delay: 1000 });
  g.start();
  assert.equal(await g.flush(), 2, "every DJ's summary, once at start");
  assert.deepEqual(db.get("grabCount/dj1"), { n: 1, t: 1, last: "1_aaa", lastAt: 5 });
  assert.deepEqual(db.get("grabCount/dj2"), { n: 2, t: 1, last: "2_123", lastAt: 8 });
  await db.ref("grabs/dj1/1_bbb/u3").set(12);
  assert.equal(await g.flush(), 1, "a new grab: that DJ's summary only");
  assert.deepEqual(db.get("grabCount/dj1"), { n: 2, t: 2, last: "1_bbb", lastAt: 12 });
  assert.equal(await g.flush(), 0, "nothing new: nothing written");
  const reads = db.reads.filter((p) => p.startsWith("grabs")).length;
  assert.equal(reads, 3, "three listeners on grabs/, no reads");
});

// ─── Spreading a mod's tag fix (lib/retag.js) ───────────────────────────────
const retag = require("../lib/retag.js");
const library = () => ({
  tracks: {
    "1fix": { artist: "POOLSIDE", title: "Harvest Moon" },
    "1copy": { artist: "POOLSIDE", title: "Harvest Moon (Official Video)" },
    "1low": { artist: "poolside", title: "harvest moon" },
    "1other": { artist: "POOLSIDE", title: "Do It Again" },
    "1duo": { artist: "POOLSIDE & Friend", title: "Thing" },
    "1guest": { artist: "Someone", title: "Song feat. POOLSIDE (POOLSIDE Remix)" },
    "1near": { artist: "Poolsider", title: "Harvest Moon" },
    "1linked": { song: "t1" },
    "1kites": { artist: "Foals", title: "Kites" },
    "1daft": { artist: "Daft Punk", title: "One More Time" }
  },
  songs: { t1: { artist: "POOLSIDE", title: "Do It Again" }, t2: { artist: "Foals", title: "Kites" } },
  works: { s1: { artist: "POOLSIDE", title: "Do It Again" } },
  history: { h1: { artist: "POOLSIDE", title: "Harvest Moon", cid: "fix" } }
});

test("retag: a respelled artist goes on every copy and all their songs", () => {
  const e = { k: "1fix", a: "Poolside", t: "Harvest Moon", fa: "POOLSIDE", ft: "Harvest Moon" };
  const r = retag.plan(e, library());
  assert.deepEqual(r.updates, {
    "globalTracks/1copy/artist": "Poolside", "globalTracks/1copy/title": "Harvest Moon",
    "globalTracks/1low/artist": "Poolside", "globalTracks/1low/title": "Harvest Moon",
    "globalTracks/1other/artist": "Poolside",
    "globalTracks/1duo/artist": "Poolside & Friend",
    "globalTracks/1guest/title": "Song feat. Poolside (Poolside Remix)",
    "songHistory/h1/artist": "Poolside",
    "globalSongs/t1/artist": "Poolside",
    "globalWorks/s1/artist": "Poolside"
  });
  assert.deepEqual(r.copies.sort(), ["1copy", "1low"]);
  assert.equal(r.artistCount, 3);
  assert.equal(retag.summary(r, e), "Tags: also fixed 2 other copies of \"POOLSIDE - Harvest Moon\", and wrote POOLSIDE as Poolside on 3 more songs.");
});

test("retag: a spelling fix goes on every copy of the old tags, and only them", () => {
  const lib = { tracks: { a: { artist: "Poolsdie", title: "harvest moon" }, b: { artist: "Poolsdie", title: "Other Song" }, c: { artist: "Daft Punk", title: "One More Tme" } } };
  const r = retag.plan({ k: "x", a: "Poolside", t: "Harvest Moon", fa: "Poolsdie", ft: "Harvest Moon" }, lib);
  assert.deepEqual(r.updates, { "globalTracks/a/artist": "Poolside", "globalTracks/a/title": "Harvest Moon" });
  assert.equal(r.artistFrom, null, "a misspelling isn't the same name: the artist's other songs wait for their own fix");
  const typo = retag.plan({ k: "x", a: "Daft Punk", t: "One More Time", fa: "Daft Punk", ft: "One More Tme" }, lib);
  assert.deepEqual(typo.copies, ["c"]);
});

test("retag: a fix that names another version or another song leaves the other copies alone", () => {
  assert.equal(retag.plan({ k: "1kites", a: "Foals", t: "Kites (Limousines Remix)", fa: "Foals", ft: "Kites" }, library()), null);
  assert.equal(retag.plan({ k: "1daft", a: "Daft Punk", t: "Digital Love", fa: "Daft Punk", ft: "One More Time" }, library()), null);
  assert.equal(retag.plan({ k: "1daft", a: "Justice", t: "One More Time", fa: "Daft Punk", ft: "One More Time" }, library()), null);
});

test("retag: vague, unchanged or old-style entries spread nothing", () => {
  const lib = { tracks: { a: { artist: "Unknown", title: "Intro" }, b: { artist: "Unknown Artist", title: "Thing" } } };
  assert.equal(retag.plan({ k: "x", a: "Unknown", t: "Intro (Live)", fa: "Unknown", ft: "Intro" }, lib), null);
  assert.equal(retag.plan({ k: "x", a: "UNKNOWN ARTIST", t: "Song", fa: "Unknown Artist", ft: "Song" }, lib), null);
  assert.equal(retag.plan({ k: "1fix", a: "POOLSIDE", t: "Harvest Moon", fa: "POOLSIDE", ft: "Harvest Moon" }, library()), null);
  assert.equal(retag.plan({ k: "1fix", a: "Poolside", t: "Harvest Moon" }, library()), null, "no old tags (an older site): nothing to go on");
  assert.equal(retag.plan({ k: "x", a: "Song", t: "B", fa: "Placeholder", ft: "B" }, { tracks: { y: { artist: "Placeholder", title: "B" } } }, { isPlaceholder: (a) => a === "Placeholder" }), null);
});

test("retag: spreads() says up front which fixes can spread, as plan() finds (so app.js reads the library only for them)", () => {
  const ph = { isPlaceholder: (a) => a === "Placeholder" };
  const none = [
    { k: "1kites", a: "Foals", t: "Kites (Limousines Remix)", fa: "Foals", ft: "Kites" }, // another version
    { k: "1daft", a: "Daft Punk", t: "Digital Love", fa: "Daft Punk", ft: "One More Time" }, // another song
    { k: "1daft", a: "Justice", t: "One More Time", fa: "Daft Punk", ft: "One More Time" }, // another artist
    { k: "x", a: "Unknown", t: "Intro (Live)", fa: "Unknown", ft: "Intro" },
    { k: "x", a: "UNKNOWN ARTIST", t: "Song", fa: "Unknown Artist", ft: "Song" },
    { k: "1fix", a: "POOLSIDE", t: "Harvest Moon", fa: "POOLSIDE", ft: "Harvest Moon" }, // unchanged
    { k: "1fix", a: "Poolside", t: "Harvest Moon" }, // an older site: no old tags
    { k: "x", a: "Song", t: "B", fa: "Placeholder", ft: "B" }
  ];
  for (const e of none) {
    assert.equal(retag.spreads(e, ph), false, JSON.stringify(e));
    assert.equal(retag.plan(e, library(), ph), null, "and plan() finds nothing for it: " + JSON.stringify(e));
  }
  const some = [
    { k: "1fix", a: "Poolside", t: "Harvest Moon", fa: "POOLSIDE", ft: "Harvest Moon" }, // the artist respelled
    { k: "x", a: "Poolside", t: "Harvest Moon", fa: "Poolsdie", ft: "Harvest Moon" }, // a spelling fix: its copies
    { k: "x", a: "Daft Punk", t: "One More Time", fa: "Daft Punk", ft: "One More Tme" }
  ];
  for (const e of some) assert.equal(retag.spreads(e, ph), true, JSON.stringify(e));
  // it may spread and still find nothing to change in this library
  assert.equal(retag.spreads({ k: "x", a: "Nobody", t: "Here", fa: "NOBODY", ft: "Here" }), true);
  assert.equal(retag.plan({ k: "x", a: "Nobody", t: "Here", fa: "NOBODY", ft: "Here" }, library()), null);
});

test("retag: respelling names keeps the rest of the artist list and title", () => {
  const key = "poolside";
  assert.equal(retag.respellArtist("POOLSIDE, Friend & poolside", key, "Poolside"), "Poolside, Friend & Poolside");
  assert.equal(retag.respellArtist("Poolsider", key, "Poolside"), "Poolsider");
  assert.equal(retag.respellTitle("Song (POOLSIDE's Remix)", key, "Poolside"), "Song (Poolside's Remix)");
  assert.equal(retag.respellTitle("Song ft. Friend & POOLSIDE [Live]", key, "Poolside"), "Song ft. Friend & Poolside [Live]");
  assert.equal(retag.respellTitle("Poolside Dreams", key, "Poolside"), "Poolside Dreams");
});

// ─── The room's colours from artwork (lib/colors.js) ────────────────────────
// A real 4x4 PNG of one colour, so the colours are worked out for real
function png(r, g, b) {
  const zlib = require("zlib");
  const crc = (buf) => { let c, n = 0xffffffff; for (const byte of buf) { c = (n ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; n = (n >>> 8) ^ c; } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, r, g, b, r, g, b, r, g, b, r, g, b])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("artwork colours: an image seen lately isn't downloaded again; one that couldn't be read is tried again", async () => {
  const { artworkColors } = require("../lib/colors.js");
  const realFetch = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    asked.push(String(url));
    return /bad/.test(url)
      ? new Response("not really a jpeg", { status: 200, headers: { "content-type": "image/jpeg" } })
      : new Response(png(200, 30, 40), { status: 200, headers: { "content-type": "image/png" } });
  };
  try {
    const first = await artworkColors("https://img.test/cache-a.png");
    assert.match(first.color, /^#[0-9a-f]{6}$/i);
    first.color = "#000000"; // what a caller does with its copy stays with it
    const again = await artworkColors("https://img.test/cache-a.png");
    assert.notEqual(again.color, "#000000");
    assert.equal(again.txt, first.txt);
    assert.deepEqual(asked, ["https://img.test/cache-a.png"], "the second time comes from memory");
    await assert.rejects(artworkColors("https://img.test/bad.jpg"));
    await assert.rejects(artworkColors("https://img.test/bad.jpg"));
    assert.equal(asked.filter((u) => /bad/.test(u)).length, 2, "a failure isn't remembered");
    // only the last 500 images are kept: the first goes
    for (let i = 0; i < 500; i++) await artworkColors("https://img.test/many-" + i + ".png");
    asked.length = 0;
    await artworkColors("https://img.test/cache-a.png");
    await artworkColors("https://img.test/many-499.png");
    assert.deepEqual(asked, ["https://img.test/cache-a.png"]);
  } finally {
    global.fetch = realFetch;
  }
});

// ─── Site health (tools/site-health.js) ─────────────────────────────────────
const health = require("../tools/site-health.js");
// esbuild --minify --sourcemap of a small script: greet() on lines 1-4, broken() on 5-8
const GEN = 'var greet=function(r){var e="hi "+r;return e.toUpperCase()};function broken(r){var e=r[0];return e.missing.value}';
const MAP = { version: 3, sources: ["demo.js"], names: ["personName", "message", "things", "first"],
  mappings: "AAAA,IAAI,MAAQ,SAAUA,EAAY,CAChC,IAAIC,EAAU,MAAQD,EACtB,OAAOC,EAAQ,YAAY,CAC7B,EACA,SAAS,OAAOC,EAAQ,CACtB,IAAIC,EAAQD,EAAO,CAAC,EACpB,OAAOC,EAAM,QAAQ,KACvB" };

test("site health: a minified position maps back to its line in the source", () => {
  const col = (s) => GEN.indexOf(s) + 1; // browsers count columns from 1
  assert.equal(health.originalPosition(MAP, 1, col("e.missing")).line, 7);
  assert.equal(health.originalPosition(MAP, 1, col("e.missing")).name, "first");
  assert.equal(health.originalPosition(MAP, 1, col("e.toUpperCase")).line, 3);
  assert.equal(health.originalPosition(MAP, 1, col("var e=r[0]")).line, 6);
  assert.equal(health.originalPosition(MAP, 1, 1).line, 1);
  assert.equal(health.originalPosition(MAP, 2, 1), null); // no such line
  assert.deepEqual(health.vlq("AAAA"), [0, 0, 0, 0]);
  assert.deepEqual(health.vlq("D"), [-1]);
  assert.deepEqual(health.vlq("gB"), [16]);
});

test("site health: errors group by what and where, vitals take the 75th percentile", async () => {
  assert.deepEqual(health.splitFile("js/chat.js?v=0123456789"), { path: "js/chat.js", v: "0123456789" });
  assert.deepEqual(health.splitFile(""), { path: "", v: null });
  const errors = {
    a: { m: "boom", f: "js/chat.js?v=0123456789", l: 1, c: 50, b: "Chrome 140 / Android", p: "/#live", at: 1 },
    b: { m: "boom", f: "js/chat.js?v=0123456789", l: 1, c: 50, b: "Chrome 140 / Android", p: "/#live", at: 3 },
    c: { m: "other", f: "js/ui.js?v=aaaaaaaaaa", l: 1, c: 9, b: "Safari 17 / iOS", at: 2 }
  };
  const g = health.groupErrors(errors);
  assert.equal(g.length, 2);
  assert.equal(g[0].count, 2);
  assert.equal(g[0].last, 3);
  assert.equal(health.p75([1, 2, 3, 4]), 3);
  assert.equal(health.p75([]), null);
  const vitals = {};
  for (let i = 0; i < 20; i++) vitals["p" + i] = { lcp: 5000 + i, inp: 100, cls: 0.01, mob: true, at: i };
  for (let i = 0; i < 4; i++) vitals["c" + i] = { lcp: 1000, inp: 600, cls: 0.5, mob: false, at: i };
  const v = health.vitalsBy(vitals);
  assert.equal(v.phones.visits, 20);
  assert.equal(v.phones.lcp, 5014);
  assert.equal(v.computers.inp, 600);
  // a live error and a poor vital over enough visits need a look; a poor one over 4 visits doesn't
  const r = await health.report({ errors, vitals, days: 7, live: async (grp) => ({ where: grp.path, live: grp.m === "boom" }) });
  assert.match(r.markdown, /\| 2 \| boom \| js\/chat\.js \| \*\*yes\*\*/);
  assert.deepEqual(r.problems, ["2× boom", "Largest paint on phones: 5014 ms"]);
  const quiet = await health.report({ errors: {}, vitals: {}, days: 7, live: async () => ({ where: "", live: false }) });
  assert.deepEqual(quiet.problems, []);
  assert.match(quiet.markdown, /None reported/);
});

// ─── Seasons from the site (lib/seasons.js) ─────────────────────────────────
const seasons = require("../lib/seasons.js");

test("seasons: the site's settings are read as plain data, never run", () => {
  const src = `var AVATAR_SEASONS = [{ months: [10], style: "set2" }];
    var ftconfigs = { avatarset: "", lightsMonths: [11, 12], roomName: \`Basement\` };
    ftconfigs.snowMonths = [1, 2];
    window.LIGHTS_MONTHS = [12];
    var ran = (function () { globalThis.__ranSiteCode = true; return 1; })();
    var __proto__ = { polluted: true };
    ftconfigs.__proto__ = { polluted: true };
    var neg = -3, re = /x/;`;
  const out = seasons.readPlainData(src, "config.js");
  assert.deepEqual(out.AVATAR_SEASONS, [{ months: [10], style: "set2" }]);
  assert.deepEqual(out.ftconfigs, { avatarset: "", lightsMonths: [11, 12], roomName: "Basement", snowMonths: [1, 2] });
  assert.deepEqual(out.LIGHTS_MONTHS, [12]);
  assert.equal(out.neg, -3);
  assert.ok(!("ran" in out) && !("re" in out), "code and regexes aren't data");
  assert.equal(globalThis.__ranSiteCode, undefined, "nothing in the file runs");
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(out.ftconfigs), Object.prototype);
  assert.throws(() => seasons.readPlainData("var x = {", "broken.js"));
});

test("seasons: without SITE_URL the defaults hold, and .env forces a value", async () => {
  const quiet = () => {};
  const def = seasons.createSiteSeasons({}, quiet);
  await def.refresh();
  assert.deepEqual(def.lightsMonths(), seasons.SITE_SEASON_DEFAULTS.lightsMonths);
  assert.equal(def.isLightsSeason(new Date(2026, 11, 5)), true);
  assert.equal(def.isLightsSeason(new Date(2026, 5, 5)), false);
  assert.equal(def.avatarset(), "");
  const forced = seasons.createSiteSeasons({ AVATARSET: "set4", LIGHTS_MONTHS: "6,7" }, quiet);
  assert.equal(forced.forcedAvatarStyle(), "robohash:set4");
  assert.deepEqual(forced.lightsMonths(), [6, 7]);
  assert.equal(forced.isLightsSeason(new Date(2026, 5, 5)), true);
});

// ─── Last.fm (lib/lastfm.js) ────────────────────────────────────────────────
test("lastfm: calls are signed the way Last.fm asks, and nothing is sent without the secret", () => {
  const { createLastfm } = require("../lib/lastfm.js");
  const { createHash } = require("crypto");
  const lf = createLastfm({ LASTFM_APIKEY: "key", LASTFM_SECRET: "shh", LASTFM_SESSIONKEY: "sk" });
  const params = { method: "track.scrobble", track: "Song ü", artist: "Artist", api_key: "key", sk: "sk" };
  // sorted by name: api_key, artist, method, sk, track; then the secret
  const raw = "api_keykey" + "artistArtist" + "methodtrack.scrobble" + "sksk" + "trackSong ü" + "shh";
  assert.equal(lf.getApiSignature(params), createHash("md5").update(raw, "utf8").digest("hex"));
  assert.equal(createLastfm({ LASTFM_APIKEY: "key" }).key, null, "no secret: no scrobbling");
});

// ─── Chat commands (lib/commands.js and its groups) ─────────────────────────
const { createCommands } = require("../lib/commands.js");
const commandGroups = ["lineup", "room", "cards", "tracks", "services"].map((g) => require("../lib/commands/" + g + ".js"));

/** A room as app.js hands it over, with the deck, the line and what was said. */
function fakeRoom(table, extra) {
  const said = [], calls = [];
  const room = Object.assign({
    said, calls, table, queue: [], playDex: 3, botid: "bot", started: true, CHAT_MAX_AGE: 120000,
    users: { u1: { username: "Ann" }, mod: { username: "Mo", mod: true }, u2: { username: "Bea", status: true } },
    serverNow: () => Date.now(), chatCounts: () => true, fileMentions() {}, push: { chat() {} },
    talk: (t) => said.push(t), addCheck: () => 0, uidLookup: (n) => ({ bea: "u2", bot: "bot" })[String(n).toLowerCase()] || false,
    updateWaitlist: () => calls.push("waitlist"), updateLimit: () => calls.push("limit"), startSong: () => calls.push("start"),
    seatDJ: (s) => { room.table.push(s); calls.push("seat"); }, updateThings: () => calls.push("things"),
    autoDJ: { botName: () => "jarvis", botSeat: () => null, override: (how) => calls.push("override " + how) },
    reactionForOtherSong: () => false, themevote: { active: false }, firelevel: { hot: () => calls.push("hot"), storm: () => calls.push("storm") }
  }, extra);
  return room;
}
const say = (room, from, txt) => {
  room.lookupChatData = (id, cb) => cb({ id: from, txt, time: Date.now() });
  createCommands(room).handleChat("c" + Math.random(), "f");
};
const seat = (id) => ({ name: id, id, plays: 0 });

test("commands: every one belongs to one group and is a function", () => {
  const names = commandGroups.flatMap((g) => Object.keys(g));
  assert.equal(new Set(names).size, names.length, "no command in two groups");
  assert.equal(names.length, 52);
  for (const g of commandGroups) for (const [name, fn] of Object.entries(g)) assert.equal(typeof fn, "function", "!" + name);
  for (const n of ["addme", "removeme", "skip", "theme", "suggest", "flag", "bpm", "fixtags", "grab", "dance", "ytsync", "swaps"]) assert.ok(names.includes(n), "!" + n);
});

test("commands: !addme seats you when there's room and lines you up when there isn't", () => {
  const empty = fakeRoom([]);
  say(empty, "u1", "!AddMe"); // any case
  assert.deepEqual(empty.table, [{ name: "Ann", id: "u1", plays: 0 }]);
  assert.equal(empty.playDex, 0);
  assert.deepEqual(empty.calls, ["start"]);
  const some = fakeRoom([seat("a"), seat("b")]);
  say(some, "u1", "!addme");
  assert.deepEqual(some.calls, ["seat", "things"]);
  const full = fakeRoom([seat("a"), seat("b"), seat("c"), seat("d")]);
  say(full, "u1", "!addme");
  assert.deepEqual(full.queue, [{ name: "Ann", id: "u1", plays: 0 }]);
  assert.deepEqual(full.said, ["Ann added to waitlist. Length is now 1"]);
  assert.deepEqual(full.calls, ["waitlist", "limit"]);
  const already = fakeRoom([], { addCheck: () => 2 });
  say(already, "u1", "!addme");
  assert.deepEqual(already.said, ["You are already on deck."]);
});

test("commands: a mod's !upbot and !add use the same seating, in their own words", () => {
  const up = fakeRoom([seat("a")]);
  say(up, "mod", "!upbot");
  assert.deepEqual(up.said, ["OK! I will DJ."]);
  assert.deepEqual(up.calls, ["override up", "seat", "things"]);
  assert.equal(up.table[1].name, "jarvis");
  const upFull = fakeRoom([seat("a"), seat("b"), seat("c"), seat("d")]);
  say(upFull, "mod", "!upbot");
  assert.deepEqual(upFull.said, ["jarvis (that's me) added to waitlist. Length is now 1"]);
  const add = fakeRoom([seat("a"), seat("b"), seat("c"), seat("d")]);
  say(add, "mod", "!add Bea");
  assert.deepEqual(add.said, ["Bea added to waitlist. Length is now 1"]);
  const notMod = fakeRoom([]);
  say(notMod, "u1", "!add Bea");
  assert.deepEqual(notMod.table, [], "only mods add people");
});

test("commands: unknown words and the bot's own messages do nothing", () => {
  for (const txt of ["!nope", "!constructor", "!__proto__", "!toString", "hello"]) {
    const r = fakeRoom([]);
    assert.doesNotThrow(() => say(r, "u1", txt), txt);
    assert.deepEqual([r.said, r.calls], [[], []], txt);
  }
  const fire = fakeRoom([]);
  say(fire, "u1", "🔥");
  assert.deepEqual(fire.calls, ["hot"], "a 🔥 still counts");
  const fromBot = fakeRoom([]);
  say(fromBot, "bot", "!addme");
  assert.deepEqual(fromBot.table, []);
});
