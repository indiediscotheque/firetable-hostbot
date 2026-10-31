// Database rules tests: what users must not be able to write, and everything
// the site and the bot do write. Run inside the emulators (see README):
//   cd test && npx firebase emulators:exec --only database,auth --project demo-ft "node rules.test.mjs"
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";

const rules = readFileSync(new URL("../firebase-rules.json", import.meta.url), "utf8");
const env = await initializeTestEnvironment({ projectId: "demo-rules", database: { host: "127.0.0.1", port: 9000, rules } });
const TS = { ".sv": "timestamp" };
const big = "A".repeat(200000);

await env.withSecurityRulesDisabled(async (ctx) => {
  await ctx.database().ref().set({
    users: {
      boss: { username: "boss", supermod: true }, mod1: { username: "mod1", mod: true },
      eve: { username: "eve" }, bob: { username: "Bob" }, bot: { username: "bot", hostbot: true },
      left: { username: "renamed" }
    },
    nameClaim: { boss: "boss", eve: "eve", bob: "bob", mod1: "mod1", oldname: "left" },
    cards: { c1: { owner: "eve" } },
    chatData: {
      bobmsg: { id: "bob", name: "Bob", txt: "hi", feedID: "f1", time: 1 },
      evemsg: { id: "eve", name: "eve", txt: "yo", time: 1 },
      bobloose: { id: "bob", name: "Bob", txt: "not in the feed yet", time: 1 }
    },
    chatFeed: { f1: { chatID: "bobmsg" } }
  });
});

const db = (uid) => env.authenticatedContext(uid).database();
const eve = db("eve");
let failed = 0;
const expect = async (want, label, promise) => {
  let got;
  try { await promise; got = "ALLOWED"; } catch (e) { got = "DENIED"; }
  if (got !== want) failed++;
  console.log((got === want ? "  ok   " : "  FAIL ") + got.padEnd(8) + label);
};
const atomicChat = (who, chatID, feedID, data) => db(who).ref().update({
  ["chatData/" + chatID]: Object.assign({ id: who, name: who, txt: "hello", time: TS, feedID }, data),
  ["chatFeed/" + feedID]: { chatID }
});

console.log("-- chat: abuse (DENIED)");
await expect("DENIED", "overwrite someone else's message", eve.ref("chatData/bobmsg").set({ id: "eve", name: "eve", txt: "replaced", time: TS }));
await expect("DENIED", "change own message's id to a supermod", eve.ref("chatData/evemsg/id").set("boss"));
await expect("DENIED", "extra field in a message", eve.ref("chatData/junk").set({ id: "eve", name: "eve", txt: "x", time: TS, junk: big }));
await expect("DENIED", "backdated message time", eve.ref("chatData/old").set({ id: "eve", name: "eve", txt: "x", time: 1 }));
await expect("DENIED", "post a message already in the feed again", eve.ref("chatFeed/f9").set({ chatID: "bobmsg" }));
await expect("DENIED", "re-link someone else's message to a new feed entry", atomicChat("eve", "bobmsg", "f10", { id: "bob", name: "Bob" }));
await expect("DENIED", "extra field in a feed entry", eve.ref("chatFeed/f8").set({ chatID: "evemsg", junk: big }));
await expect("DENIED", "feed entry chatID that's an object", eve.ref("chatFeed/f7").set({ chatID: { a: 1 } }));
await expect("DENIED", "message with a card you don't own", eve.ref("chatData/cardx").set({ id: "eve", name: "eve", txt: "x", time: TS, card: "nope" }));

console.log("-- chat: normal use (ALLOWED)");
await expect("ALLOWED", "message + feed entry in one write", atomicChat("eve", "a1", "fa1"));
await expect("ALLOWED", "older three-step send", eve.ref("chatData/s1").set({ id: "eve", name: "eve", txt: "hi", time: TS, forSong: 123 })
  .then(() => eve.ref("chatFeed/fs1").set({ chatID: "s1" })).then(() => eve.ref("chatData/s1/feedID").set("fs1")));
await expect("ALLOWED", "bot command in one write", atomicChat("eve", "a2", "fa2", { txt: "!addme", botCmd: true }));
await expect("ALLOWED", "message sharing your card", atomicChat("eve", "a3", "fa3", { card: "c1" }));
await expect("ALLOWED", "react to a message", eve.ref("chatData/bobmsg/reactions/fire/eve").set(true));
await expect("ALLOWED", "delete own message", eve.ref("chatData/a2").remove());
await expect("ALLOWED", "mod hides a message", db("mod1").ref("chatFeed/f1/hidden").set(true));
await expect("ALLOWED", "bot talks in one write", atomicChat("bot", "b1", "fb1"));

console.log("-- public data: abuse (DENIED)");
await expect("DENIED", "selectedList of 200 KB", eve.ref("users/eve/selectedList").set(big));
await expect("DENIED", "selectedList that's an object", eve.ref("users/eve/selectedList").set({ a: 1 }));
await expect("DENIED", "status that's an object", eve.ref("users/eve/status").set({ big }));
await expect("DENIED", "status that's text", eve.ref("users/eve/status").set("online"));
await expect("DENIED", "idle with an extra field", eve.ref("users/eve/idle").set({ isIdle: false, audio: 1, since: TS, junk: big }));
await expect("DENIED", "idle without since", eve.ref("users/eve/idle").set({ isIdle: false, audio: 1 }));
await expect("DENIED", "typing with an extra field", eve.ref("typing/eve").set({ name: "eve", at: TS, junk: big }));
await expect("DENIED", "block value that isn't true", eve.ref("blocks/eve/Bob").set(big));
await expect("DENIED", "mod sets hidden to text", db("mod1").ref("chatFeed/f1/hidden").set("yes"));
await expect("DENIED", "supermod sets mod to text", db("boss").ref("users/eve/mod").set("x"));

console.log("-- public data: normal use (ALLOWED)");
await expect("ALLOWED", "status true, then false", eve.ref("users/eve/status").set(true).then(() => eve.ref("users/eve/status").set(false)));
await expect("ALLOWED", "idle {isIdle, audio, since}", eve.ref("users/eve/idle").set({ isIdle: true, audio: 1, since: TS }));
await expect("ALLOWED", "selectedList '0' and a playlist id", eve.ref("users/eve/selectedList").set("0").then(() => eve.ref("users/eve/selectedList").set("-OabcDEF123456789xyz")));
await expect("ALLOWED", "joined", eve.ref("users/eve/joined").set(TS));
await expect("ALLOWED", "avatarStyle", eve.ref("users/eve/avatarStyle").set("robohash:set2"));
await expect("ALLOWED", "typing, then stop typing", eve.ref("typing/eve").set({ name: "eve", at: TS }).then(() => eve.ref("typing/eve").remove()));
await expect("ALLOWED", "block and unblock", eve.ref("blocks/eve/bob").set(true).then(() => eve.ref("blocks/eve/bob").remove()));
await expect("ALLOWED", "supermod mods and unmods", db("boss").ref("users/eve/mod").set(true).then(() => db("boss").ref("users/eve/mod").set(false)));
await expect("ALLOWED", "bot sets its status", db("bot").ref("users/bot/status").set(true));

console.log("-- usernames (unique whatever the case)");
await expect("DENIED", "claim a name in mixed case", eve.ref("nameClaim/Eve2").set("eve"));
await expect("DENIED", "claim 'bob' while Bob uses it", eve.ref("nameClaim/bob").set("eve"));
await expect("DENIED", "take the name BOB (no claim)", eve.ref("users/eve/username").set("BOB"));
await expect("DENIED", "username that isn't text", eve.ref("users/eve/username").set({ a: 1 }));
await expect("ALLOWED", "anyone can read the claims", env.unauthenticatedContext().database().ref("nameClaim/bob").once("value"));
await expect("ALLOWED", "claim and take a free name in any case", eve.ref("nameClaim/newname").set("eve").then(() => eve.ref("users/eve/username").set("NewName")));
await expect("ALLOWED", "change the case of your own name", eve.ref("users/eve/username").set("newNAME"));
await expect("ALLOWED", "claim a name its old holder no longer uses", eve.ref("nameClaim/oldname").set("eve"));
await expect("ALLOWED", "bot writes lowercase claims for others", db("bot").ref("nameClaim/renamed").set("left"));

console.log("-- playlists and queues: abuse (DENIED)");
const track = (cid, extra) => Object.assign({ type: 1, name: "Artist - Title " + cid, cid: String(cid), img: "https://i.ytimg.com/vi/" + cid + "/mqdefault.jpg", url: "https://www.youtube.com/watch?v=" + cid }, extra);
await expect("DENIED", "track name of 200 KB", eve.ref("queues/eve/j1").set(track("a", { name: big })));
await expect("DENIED", "track name that's an object", eve.ref("queues/eve/j2").set(track("a", { name: { big } })));
await expect("DENIED", "track type that's an object", eve.ref("queues/eve/j3").set(track("a", { type: { big } })));
await expect("DENIED", "track cid of 200 KB", eve.ref("queues/eve/j4").set(track("a", { cid: big })));
await expect("DENIED", "track artwork link of 200 KB", eve.ref("queues/eve/j5").set(track("a", { img: big })));
await expect("DENIED", "extra track field of 200 KB", eve.ref("queues/eve/j6").set(track("a", { junk: big })));
await expect("DENIED", "track that's just text", eve.ref("queues/eve/j7").set(big));
await expect("DENIED", "flagged that's text", eve.ref("queues/eve/j8").set(track("a", { flagged: big })));
await expect("DENIED", "playlist track name of 200 KB", eve.ref("playlists/eve/pl1/list/j1").set(track("a", { name: big })));
await expect("DENIED", "playlist name of 200 KB", eve.ref("playlists/eve/pl1/name").set(big));
await expect("DENIED", "write someone else's queue", eve.ref("queues/bob/x").set(track("a")));
await expect("DENIED", "mod sets a global artist of 200 KB", db("mod1").ref("globalTracks/1abc/artist").set(big));
await expect("DENIED", "mod sets a global title that's an object", db("mod1").ref("globalTracks/1abc/title").set({ big }));
await expect("DENIED", "mod sets a Recent title of 200 KB", db("mod1").ref("songHistory/h1/title").set(big));

console.log("-- playlists and queues: normal use (ALLOWED)");
await env.withSecurityRulesDisabled(async (ctx) => {
  // old tracks, as older versions of the site and imports saved them
  const legacy = {
    old1: { type: "1", name: "Old import - Track", cid: "dQw4w9WgXcQ" },
    old2: { type: 2, name: "SoundCloud - Track", cid: 13158665 },
    old3: { type: 1, name: "Extra fields - Track", cid: "abc", duration: 213, added: { by: "someone", at: 1 }, note: "hi" },
    old4: { type: 1, name: "Flagged - Track", cid: "def", flagged: { date: 1577836800000, code: 3 } }
  };
  const many = (n) => { const l = {}; for (let i = 0; i < n; i++) l["k" + String(i).padStart(6, "0")] = track("v" + i, i % 7 ? {} : { flagged: { date: 1, code: 2 } }); return l; };
  await ctx.database().ref().update({
    "queues/eve": Object.assign(many(10000), legacy),
    "playlists/bot/big": { name: "the bot's crate", list: many(12000) },
    "playlists/eve/pl2": { name: "2,500 tracks", list: many(2500) },
    "songHistory/h1": { artist: "A", title: "T", cid: "abc", type: 1 }
  });
});
await expect("ALLOWED", "add a track as the site does", eve.ref("queues/eve").push(track("n1")));
await expect("ALLOWED", "add a SoundCloud track (number id, no artwork)", eve.ref("playlists/eve/pl2/list").push({ type: 2, name: "SC - Song", cid: 13158665, url: "https://soundcloud.com/u/s" }));
await expect("ALLOWED", "create a playlist", eve.ref("playlists/eve/pl3").set({ name: "new list", list: { a: track("x") } }));
await expect("ALLOWED", "rename a playlist", eve.ref("playlists/eve/pl3/name").set("renamed"));
await expect("ALLOWED", "flag and unflag a track", eve.ref("queues/eve/old1/flagged").set({ date: Date.now(), code: 8 }).then(() => eve.ref("queues/eve/old1/flagged").remove()));
await expect("ALLOWED", "rename a track (bot's tag fix)", db("bot").ref("queues/eve/old2/name").set("Fixed - Name"));
await expect("ALLOWED", "bot moves a played track to the bottom in one write",
  db("bot").ref("playlists/bot/big/list").update({ k000001: null, zzz: track("v1") }));
const reverse = (who, path) => db(who).ref(path).transaction((cur) => {
  if (!cur) return cur;
  const keys = Object.keys(cur).sort(), vals = keys.map((k) => cur[k]).reverse(), out = {};
  keys.forEach((k, i) => { out[k] = vals[i]; });
  return out;
}).then((r) => { if (!r.committed) throw new Error("not committed"); });
let t = Date.now();
await expect("ALLOWED", "reorder a 10,000-track queue with old-style tracks in it", reverse("eve", "queues/eve"));
console.log("         (" + (Date.now() - t) + " ms)");
t = Date.now();
await expect("ALLOWED", "reorder the bot's 12,000-track playlist", reverse("bot", "playlists/bot/big/list"));
console.log("         (" + (Date.now() - t) + " ms)");
await expect("ALLOWED", "reorder a 2,500-track playlist", reverse("eve", "playlists/eve/pl2/list"));
await expect("ALLOWED", "mod fixes a play's tags (Recent + global, one write)", db("mod1").ref().update({
  "songHistory/h1/artist": "Artist", "songHistory/h1/title": "Song - Live", "globalTracks/1abc/artist": "Artist", "globalTracks/1abc/title": "Song - Live"
}));
await expect("ALLOWED", "delete a playlist", eve.ref("playlists/eve/pl3").remove());

console.log("-- play history: abuse (DENIED)");
const logEntry = (by, extra) => Object.assign({ k: "1abc", a: "Artist", t: "Song", fa: "Artsit", ft: "Song", by, at: TS }, extra);
await expect("DENIED", "listener writes the play log", eve.ref("playLog").push({ k: "1abc", w: 1 }));
await expect("DENIED", "listener reads the play log", eve.ref("playLog").once("value"));
await expect("DENIED", "listener sets a play count", eve.ref("globalSongs/t1/plays").set(9999));
await expect("DENIED", "listener points a spelling at another track", eve.ref("globalSongKeys/abc").set("t2"));
await expect("DENIED", "mod sets a play count", db("mod1").ref("globalSongs/t1/plays").set(9999));
await expect("DENIED", "listener logs a tag fix", eve.ref("tagLog").push(logEntry("eve")));
await expect("DENIED", "mod logs a tag fix as someone else", db("mod1").ref("tagLog").push(logEntry("boss")));
await expect("DENIED", "mod backdates a tag fix", db("mod1").ref("tagLog").push(logEntry("mod1", { at: 1 })));
await expect("DENIED", "mod logs a 200 KB tag", db("mod1").ref("tagLog").push(logEntry("mod1", { a: big })));
await expect("DENIED", "mod logs a tag with extra fields", db("mod1").ref("tagLog").push(logEntry("mod1", { junk: 1 })));
await expect("DENIED", "mod reads the tag log", db("mod1").ref("tagLog").once("value"));
await expect("DENIED", "mod answers a tag question directly", db("mod1").ref("tagReview/q1/decision").set("merge"));
await expect("DENIED", "listener switches the history off", eve.ref("globalSongsMeta/ready").set(false));
await expect("DENIED", "mod reads the archived ADAM export", db("mod1").ref("historyArchive").once("value"));
await expect("DENIED", "mod changes a saved review answer", db("mod1").ref("historyDecisions/x").set({ a: "a", b: "b", decision: "merge" }));

console.log("-- play history: normal use (ALLOWED)");
await expect("ALLOWED", "anyone reads a track's history", eve.ref("globalSongs/t1").once("value"));
await expect("ALLOWED", "bot counts a play", db("bot").ref("globalSongs/t1").transaction((t) => Object.assign(t || {}, { plays: ((t && t.plays) || 0) + 1 })));
await expect("ALLOWED", "bot links an upload and a spelling", db("bot").ref().update({ "globalTracks/1abc/song": "t1", "globalSongKeys/abc": "t1", "globalWorkKeys/abc": "s1" }));
await expect("ALLOWED", "bot logs a play", db("bot").ref("playLog").push({ k: "1abc", a: "A", t: "T", w: Date.now(), dj: "eve", sk: false }));
await expect("ALLOWED", "bot logs a !fixtags fix", db("bot").ref("tagLog").push({ k: "1abc", a: "A", t: "T", by: "mod1", at: Date.now() }));
await expect("ALLOWED", "mod fixes tags from the site and logs it, one write", db("mod1").ref().update({
  "globalTracks/1abc/artist": "Artist", "globalTracks/1abc/title": "Song", ["tagLog/" + db("mod1").ref("tagLog").push().key]: logEntry("mod1")
}));
await expect("ALLOWED", "bot records a mod's answer to a tag question", db("bot").ref("tagReview/q1").update({ decision: "merge", by: "mod1", at: Date.now() }));
await expect("ALLOWED", "bot reads the open tag questions", db("bot").ref("tagReview").orderByChild("n").limitToFirst(5).once("value"));
await expect("ALLOWED", "the toolkit archives a file and saves review answers", db("bot").ref().update({
  "historyArchive/chunks/adam_csv/0": "H4sI", "historyArchive/files/adam_csv": { name: "adam.csv", chunks: 1, at: TS }, "historyDecisions/x": { a: "a", b: "b", decision: "merge" }
}));
await expect("ALLOWED", "publish switches the history on", db("bot").ref("globalSongsMeta").update({ ready: true, published_at: TS }));

console.log("-- push notifications");
const P256 = "B" + "A".repeat(86), AUTH = "c2VjcmV0c2VjcmV0c2VjcmV0", ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc:def";
const device = (extra) => Object.assign({ endpoint: ENDPOINT, p256dh: P256, auth: AUTH, key: P256, device: "Android", everyone: false, seen: TS }, extra);
await expect("ALLOWED", "save your phone (as the site does)", eve.ref("pushSubs/eve/dev_eve_1").set(device()));
await expect("ALLOWED", "save an iPhone (Apple's push service)", eve.ref("pushSubs/eve/dev_eve_2").set(device({ endpoint: "https://web.push.apple.com/QOabc", device: "iPhone" })));
await expect("ALLOWED", "turn @everyone on (and see it again)", eve.ref("pushSubs/eve/dev_eve_1").update({ everyone: true, seen: TS }));
await expect("ALLOWED", "read your own devices", eve.ref("pushSubs/eve").once("value"));
await expect("ALLOWED", "anyone signed in reads the public push key", eve.ref("pushKey").once("value"));
await expect("ALLOWED", "bot reads every device", db("bot").ref("pushSubs").once("value"));
await expect("ALLOWED", "bot removes a device that unsubscribed", db("bot").ref("pushSubs/eve/dev_eve_2").remove());
await expect("ALLOWED", "bot saves its keys and publishes the public one", db("bot").ref("pushVapid").set({ publicKey: P256, privateKey: "k".repeat(43) })
  .then(() => db("bot").ref("pushKey").set(P256)));
await expect("ALLOWED", "turn it off (remove your device)", eve.ref("pushSubs/eve/dev_eve_1").remove());
await expect("DENIED", "save a device for someone else", eve.ref("pushSubs/bob/dev_eve_1").set(device()));
await expect("DENIED", "read someone else's devices", eve.ref("pushSubs/bob").once("value"));
await expect("DENIED", "read every device", eve.ref("pushSubs").once("value"));
await expect("DENIED", "read the bot's private key", eve.ref("pushVapid").once("value"));
await expect("DENIED", "change the public push key", eve.ref("pushKey").set(P256));
await expect("DENIED", "device on your own server (not a push service)", eve.ref("pushSubs/eve/dev_eve_3").set(device({ endpoint: "https://evil.example/push" })));
await expect("DENIED", "device on a look-alike host", eve.ref("pushSubs/eve/dev_eve_3").set(device({ endpoint: "https://fcm.googleapis.com.evil.example/x" })));
await expect("DENIED", "device on plain http", eve.ref("pushSubs/eve/dev_eve_3").set(device({ endpoint: "http://fcm.googleapis.com/fcm/send/x" })));
await expect("DENIED", "endpoint of 200 KB", eve.ref("pushSubs/eve/dev_eve_3").set(device({ endpoint: "https://fcm.googleapis.com/" + big })));
await expect("DENIED", "extra field of 200 KB", eve.ref("pushSubs/eve/dev_eve_3").set(device({ junk: big })));
await expect("DENIED", "bad p256dh key", eve.ref("pushSubs/eve/dev_eve_3").set(device({ p256dh: "nope" })));
await expect("DENIED", "backdated seen", eve.ref("pushSubs/eve/dev_eve_3").set(device({ seen: 1 })));
await expect("DENIED", "device id with odd characters", eve.ref("pushSubs/eve/has spaces!").set(device()));
await env.withSecurityRulesDisabled((ctx) => ctx.database().ref("banned/eve").set(true));
await expect("DENIED", "a banned user saves a device", eve.ref("pushSubs/eve/dev_eve_4").set(device()));
await env.withSecurityRulesDisabled((ctx) => ctx.database().ref("banned/eve").remove());

await env.cleanup();
console.log(failed ? "\n" + failed + " RULES TEST(S) FAILED" : "\nrules: all as expected");
process.exit(failed ? 1 : 0);
