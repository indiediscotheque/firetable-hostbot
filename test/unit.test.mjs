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

test("problemMessage fits in chat and names the DJ", () => {
  for (const code of [2, 3, 4, 5, 6, 7]) {
    const m = problemMessage(code, "x".repeat(22), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.ok(m.includes("@" + "x".repeat(22)) && m.length <= 240, "code " + code + ": " + m.length);
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
