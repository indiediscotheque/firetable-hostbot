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
