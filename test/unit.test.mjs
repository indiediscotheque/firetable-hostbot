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
  const { db } = fakeDb(data);
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
  assert.equal(await sw.online("u2"), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5 * 60 * 1000);
  assert.equal(await sw.online("u2"), true, "a second arrival shares the pass already planned");
  assert.equal(timers.length, 1);
});
