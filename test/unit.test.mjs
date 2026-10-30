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
