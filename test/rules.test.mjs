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
    cards: { c1: { owner: "eve" }, c2: { owner: "eve" }, c3: { owner: "bob" } },
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
const bob = () => db("bob");
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
await expect("DENIED", "message with a GRAB button", atomicChat("eve", "g1", "fg1", { grab: "c1" }));
// The site puts chat keys in element ids: only push-style keys are allowed
await expect("DENIED", "message key with selector characters", atomicChat("eve", "x,*", "fk1"));
await expect("DENIED", "message key with markup", atomicChat("eve", "x\"><b>", "fk2"));
await expect("DENIED", "message key with a space", eve.ref("chatData/a b").set({ id: "eve", name: "eve", txt: "x", time: TS }));
await expect("DENIED", "feed key with selector characters", atomicChat("eve", "k3", "f,*"));
await expect("DENIED", "feed entry pointing into a message", eve.ref("chatFeed/fk4").set({ chatID: "evemsg/txt" }));
await expect("DENIED", "message key longer than 40", atomicChat("eve", "k".repeat(41), "fk5"));

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
await expect("ALLOWED", "bot prints a card with a GRAB button", atomicChat("bot", "b2", "fb2", { grab: "c1" }));

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
await expect("ALLOWED", "offlineAt set when the connection drops, closed when the page closes, both cleared on return",
  eve.ref("users/eve/offlineAt").onDisconnect().set(TS).then(() => eve.ref("users/eve/closed").set(TS))
    .then(() => eve.ref("users/eve/closed").remove()).then(() => eve.ref("users/eve/offlineAt").set(TS)));
await expect("DENIED", "someone else's offlineAt", db("bob").ref("users/eve/offlineAt").set(TS));
await expect("DENIED", "closed that isn't now", eve.ref("users/eve/closed").set(1));
await expect("DENIED", "offlineAt in the future", eve.ref("users/eve/offlineAt").set(Date.now() + 86400000));
await expect("ALLOWED", "avatarStyle", eve.ref("users/eve/avatarStyle").set("robohash:set2"));
await expect("ALLOWED", "my Turntable avatar", eve.ref("users/eve/ttAvatar").set("2001"));
await expect("ALLOWED", "a Turntable special avatar", eve.ref("users/eve/ttAvatar").set("4dff8d24a3f75104de04797e"));
await expect("DENIED", "someone else's Turntable avatar", eve.ref("users/bob/ttAvatar").set("8"));
await expect("DENIED", "a Turntable avatar that's a link", eve.ref("users/eve/ttAvatar").set("https://example.com/a.png"));
await expect("DENIED", "a Turntable avatar that's a number", eve.ref("users/eve/ttAvatar").set(8));
await expect("ALLOWED", "my laptop's stickers", eve.ref("users/eve/ttLaptop").set("pink;heart,25,30,-10,100;e1faa9,70,60,12,120"));
await expect("ALLOWED", "a bare lid", eve.ref("users/eve/ttLaptop").set("silver"));
await expect("DENIED", "someone else's laptop", eve.ref("users/bob/ttLaptop").set("black"));
await expect("DENIED", "eleven stickers", eve.ref("users/eve/ttLaptop").set("black" + ";id,1,1,0,100".repeat(11)));
await expect("DENIED", "a sticker that's a link", eve.ref("users/eve/ttLaptop").set("black;https://x,1,1,0,100"));
await expect("DENIED", "avatarStyle the room no longer offers", eve.ref("users/eve/avatarStyle").set("dicebear:bottts"));
await expect("ALLOWED", "save my Bouletmaton", eve.ref("users/eve/boulet").set("2.5.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20"));
await expect("ALLOWED", "change my Bouletmaton", eve.ref("users/eve/boulet").set("1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1"));
await expect("DENIED", "save someone else's Bouletmaton", eve.ref("users/bob/boulet").set("2.5.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20"));
await expect("DENIED", "a Bouletmaton with a fifth skin tone", eve.ref("users/eve/boulet").set("5.5.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20"));
await expect("DENIED", "a Bouletmaton with hair colour 13", eve.ref("users/eve/boulet").set("2.13.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20"));
await expect("DENIED", "a Bouletmaton with beard colour 13", eve.ref("users/eve/boulet").set("2.5.13.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20"));
await expect("DENIED", "a Bouletmaton missing a part", eve.ref("users/eve/boulet").set("2.5.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33"));
await expect("DENIED", "an old 18-number Bouletmaton", eve.ref("users/eve/boulet").set("2.5.12.30.4.9.40.10.50.20.0.8.3.40.0.0.12.0"));
await expect("ALLOWED", "switch my Bouletmaton on", eve.ref("users/eve/bouletOn").set(true));
await expect("ALLOWED", "and off", eve.ref("users/eve/bouletOn").set(false));
await expect("ALLOWED", "save it and switch it on at once", eve.ref("users/eve").update({ boulet: "2.5.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20", bouletOn: true }));
await expect("DENIED", "switch someone else's on", eve.ref("users/bob/bouletOn").set(true));
await expect("DENIED", "an on/off that isn't true or false", eve.ref("users/eve/bouletOn").set("yes"));
await expect("DENIED", "a Bouletmaton with a picture in it", eve.ref("users/eve/boulet").set("https://example.com/x.png"));
await expect("DENIED", "a Bouletmaton that isn't text", eve.ref("users/eve/boulet").set(123));
await expect("ALLOWED", "feature two of my cards on my DJ page, then none", eve.ref("users/eve/featured").set(["c2", "c1"]).then(() => eve.ref("users/eve/featured").remove()));
await expect("DENIED", "feature someone else's card", eve.ref("users/eve/featured").set(["c3"]));
await expect("DENIED", "feature a card that doesn't exist", eve.ref("users/eve/featured").set(["nope"]));
await expect("DENIED", "feature a 7th card", eve.ref("users/eve/featured").set({ 0: "c1", 6: "c2" }));
await expect("DENIED", "set someone else's featured cards", db("bob").ref("users/eve/featured").set(["c1"]));
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
// swap suggestions (lib/swaps.js) and the site's swap / "not this one"
const swapPick = { cid: "kpstudio001", artist: "Radiohead", title: "Karma Police", album: "OK Computer", dur: 262, explicit: false, date: 1 };
await expect("ALLOWED", "bot saves a swap suggestion on a track", db("bot").ref("queues/eve/old4/swap").set(swapPick));
await expect("ALLOWED", "bot saves a swap in a playlist", db("bot").ref("playlists/eve/pl3/list/a/swap").set(swapPick));
await expect("DENIED", "swap with a video id that isn't one", db("bot").ref("queues/eve/old4/swap").set(Object.assign({}, swapPick, { cid: "x".repeat(300) })));
await expect("DENIED", "swap with extra fields", db("bot").ref("queues/eve/old4/swap").set(Object.assign({}, swapPick, { junk: big })));
await expect("DENIED", "swap without a date", db("bot").ref("queues/eve/old4/swap").set({ cid: "kpstudio001" }));
await expect("ALLOWED", "bot says what kind a swap is", db("bot").ref("playlists/eve/pl3/list/a/swap").set(Object.assign({}, swapPick, { kind: "video" })));
await expect("DENIED", "a swap kind that isn't audio or video", db("bot").ref("playlists/eve/pl3/list/a/swap").set(Object.assign({}, swapPick, { kind: "podcast" })));
await expect("ALLOWED", "the owner clears a swap that doesn't fit the list's format", eve.ref("playlists/eve/pl3/list/a/swap").set(null));
await expect("DENIED", "someone else's swap", db("bob").ref("queues/eve/old4/swap").set(swapPick));
await expect("ALLOWED", "say \"not this one\" to a swap", eve.ref("queues/eve/old4/swap").set({ dismissed: "kpstudio001", date: Date.now() }));
await expect("ALLOWED", "swap a track in, keeping where it came from", eve.ref("queues/eve/old4").set({ type: 1, cid: "kpstudio001", name: "Flagged - Track", url: "https://www.youtube.com/watch?v=kpstudio001",
  swappedFrom: { type: 1, cid: "def", date: Date.now() } }));
await expect("DENIED", "swappedFrom with extra fields", eve.ref("queues/eve/old4/swappedFrom/junk").set(big));
await expect("ALLOWED", "bot remembers a search", db("bot").ref("swapCache/abcDEF123_-xyz").set({ q: "Radiohead Karma Police", date: 1, picks: [swapPick] }));
await expect("DENIED", "people read the search cache", eve.ref("swapCache").once("value"));
await expect("DENIED", "people write the search cache", eve.ref("swapCache/abc").set({ date: 1 }));
await expect("ALLOWED", "bot marks people as scanned", db("bot").ref("swapScans").update({ eve: Date.now(), bob: Date.now() }));
await expect("DENIED", "scan marks that aren't times", db("bot").ref("swapScans/eve").set("yesterday"));
await expect("DENIED", "people read or change scan marks", eve.ref("swapScans/eve").set(0));
// the bot's YOUTUBE MUSIC playlist sync (lib/ytmsync.js)
await expect("ALLOWED", "bot makes its YOUTUBE MUSIC playlist", db("bot").ref("playlists/bot/ytm").set({ name: "YOUTUBE MUSIC" }));
await expect("ALLOWED", "bot adds a track with its length and when it joined", db("bot").ref("playlists/bot/ytm/list/k1").set({ type: 1, cid: "fa5IWHDbftI",
  name: "Daft Punk - One More Time", url: "https://www.youtube.com/watch?v=fa5IWHDbftI", duration: 321, added: Date.now() }));
await expect("ALLOWED", "bot replaces a broken track in place", db("bot").ref("playlists/bot/ytm/list/k1").set({ type: 1, cid: "kpstudio001",
  name: "Radiohead - Karma Police", url: "https://www.youtube.com/watch?v=kpstudio001", duration: 262, added: 1, swappedFrom: { type: 1, cid: "fa5IWHDbftI", date: Date.now() } }));
await expect("ALLOWED", "bot saves how the sync went", db("bot").ref("ytmSync").set({ at: Date.now(), ok: true, summary: "2 broken tracks replaced." }));
await expect("DENIED", "sync state with extra fields", db("bot").ref("ytmSync/junk").set(1));
await expect("DENIED", "a sync summary that's too long", db("bot").ref("ytmSync/summary").set("x".repeat(1001)));
await expect("DENIED", "people read the sync state", eve.ref("ytmSync").once("value"));
await expect("DENIED", "people change the sync state", eve.ref("ytmSync/at").set(0));
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

console.log("-- visitors' reports (clientErrors, clientVitals: the site's js/telemetry.js)");
const anon = env.unauthenticatedContext().database();
const errRep = (x) => Object.assign({ m: "TypeError: x is undefined", f: "js/chat.js?v=0123456789", l: 1, c: 2048, st: "at a (https://example.com/js/chat.js?v=0123456789:1:2048)",
  p: "/#live", b: "Chrome 140 / Android", v: "0123456789", u: false, at: TS }, x);
const vitRep = (x) => Object.assign({ lcp: 1800, fcp: 900, ttfb: 200, inp: 120, cls: 0.02, view: "live", mob: true, b: "Safari 18 / iOS", v: "0123456789", u: true, at: TS }, x);
await expect("ALLOWED", "a visitor's browser reports an error", anon.ref("clientErrors").push(errRep()));
await expect("ALLOWED", "a member's browser reports how fast the visit felt", eve.ref("clientVitals").push(vitRep()));
await expect("ALLOWED", "a report with only what's known", anon.ref("clientVitals").push({ ttfb: 300, at: TS }));
await expect("DENIED", "a visitor reads the reports", anon.ref("clientErrors").once("value"));
await expect("DENIED", "a member reads the reports", eve.ref("clientVitals").once("value"));
await expect("ALLOWED", "a supermod reads the reports", db("boss").ref("clientErrors").once("value"));
await expect("ALLOWED", "the bot reads the reports", db("bot").ref("clientVitals").once("value"));
await env.withSecurityRulesDisabled((ctx) => ctx.database().ref("clientErrors/kept").set({ m: "kept", at: 1 }));
await expect("DENIED", "someone changes a report", anon.ref("clientErrors/kept/m").set("changed"));
await expect("DENIED", "someone replaces a report", eve.ref("clientErrors/kept").set(errRep()));
await expect("DENIED", "someone deletes a report", eve.ref("clientErrors/kept").remove());
await expect("DENIED", "someone deletes every report", eve.ref("clientErrors").remove());
await expect("ALLOWED", "the bot prunes a report", db("bot").ref("clientErrors/kept").remove());
await expect("DENIED", "an error report of 200 KB", anon.ref("clientErrors").push(errRep({ m: big })));
await expect("DENIED", "a stack of 200 KB", anon.ref("clientErrors").push(errRep({ st: big })));
await expect("DENIED", "an extra field", anon.ref("clientErrors").push(errRep({ junk: "x" })));
await expect("DENIED", "an error report without its message", anon.ref("clientErrors").push(errRep({ m: null })));
await expect("DENIED", "a backdated report", anon.ref("clientErrors").push(errRep({ at: 1 })));
await expect("DENIED", "a vital that's text", anon.ref("clientVitals").push(vitRep({ lcp: "fast" })));
await expect("DENIED", "a vital out of range", anon.ref("clientVitals").push(vitRep({ cls: 1000 })));
await expect("DENIED", "a negative vital", anon.ref("clientVitals").push(vitRep({ inp: -1 })));
await expect("DENIED", "an extra field in a vitals report", anon.ref("clientVitals").push(vitRep({ uid: "eve" })));

console.log("-- played lately (playedRecently, lib/repeats.js)");
const lately = { w: 1, u: 2, n: "art song", dj: "dj1" };
await expect("ALLOWED", "bot saves a play", db("bot").ref("playedRecently/1abc").set(lately));
await expect("ALLOWED", "anyone, signed in or not, reads them", env.unauthenticatedContext().database().ref("playedRecently").once("value"));
await expect("DENIED", "someone else adds one", eve.ref("playedRecently/1xyz").set(lately));
await expect("DENIED", "someone else clears them", eve.ref("playedRecently").remove());

console.log("-- heartbeat (botSeen)");
await expect("ALLOWED", "bot writes its heartbeat (server time)", db("bot").ref("botSeen").set(TS));
await expect("ALLOWED", "anyone, signed in or not, reads it", env.unauthenticatedContext().database().ref("botSeen").once("value"));
await expect("DENIED", "someone else writes the heartbeat", eve.ref("botSeen").set(TS));
await expect("DENIED", "bot writes a made-up time", db("bot").ref("botSeen").set(Date.now() + 3600000));
await expect("DENIED", "bot writes text", db("bot").ref("botSeen").set("up"));
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

// Private notices from the bot (#231): shown as a toast, then removed by the site
const notice = (extra) => Object.assign({ txt: "You got the card!", time: TS, kind: "card", card: "c1" }, extra);
await expect("ALLOWED", "bot sends someone a notice", db("bot").ref("notices/eve/n1").set(notice()));
await expect("ALLOWED", "bot sends one that expires", db("bot").ref("notices/eve/n2").set(notice({ kind: "away", expires: 1, card: null })));
await expect("ALLOWED", "read your own notices", eve.ref("notices/eve").once("value"));
await expect("ALLOWED", "remove a notice once shown", eve.ref("notices/eve/n1").remove());
await expect("ALLOWED", "bot reads every notice (to prune old ones)", db("bot").ref("notices").once("value"));
await expect("DENIED", "read someone else's notices", eve.ref("notices/bob").once("value"));
await expect("DENIED", "read every notice", eve.ref("notices").once("value"));
await expect("DENIED", "send yourself a notice", eve.ref("notices/eve/n3").set(notice()));
await expect("DENIED", "send someone else a notice", eve.ref("notices/bob/n3").set(notice()));
await expect("DENIED", "change a notice", eve.ref("notices/eve/n2/txt").set("changed"));
await expect("DENIED", "bot notice of 200 KB", db("bot").ref("notices/eve/n4").set(notice({ txt: big })));
await expect("DENIED", "bot notice with an extra field", db("bot").ref("notices/eve/n4").set(notice({ junk: "x" })));

// Discover (#discover): visitors read the bot's public data; only the bot writes it
const visitor = env.unauthenticatedContext().database();
await expect("ALLOWED", "bot saves a chart", db("bot").ref("discover/charts/week/2026-W45").set({ at: 1, rows: [] }));
await expect("ALLOWED", "a visitor reads the charts", visitor.ref("discover/charts/week/2026-W45").once("value"));
await expect("ALLOWED", "a visitor reads the fires earned", visitor.ref("discover/fires").once("value"));
await expect("DENIED", "a member writes a chart", eve.ref("discover/charts/week/2026-W45").set({ rows: [] }));
await expect("DENIED", "a visitor writes the fires earned", visitor.ref("discover/fires").set({ djs: {} }));
await expect("ALLOWED", "bot keeps release dates", db("bot").ref("discoverCache/release/abc").set({ d: "2026-11-01", src: "yt" }));
await expect("DENIED", "a member reads the bot's Discover cache", eve.ref("discoverCache").once("value"));
await expect("DENIED", "a visitor reads the play log", visitor.ref("playLog").once("value"));
// the playing song's 🔥 count, for the site's live stage (it can't read the chat)
await expect("ALLOWED", "bot publishes the song's fires", db("bot").ref("songFires").set({ started: 1700000000000, count: 3 }));
await expect("ALLOWED", "a visitor reads the song's fires", visitor.ref("songFires").once("value"));
await expect("DENIED", "a member sets the song's fires", eve.ref("songFires").set({ started: 1700000000000, count: 99 }));
await expect("DENIED", "a visitor sets the song's fires", visitor.ref("songFires/count").set(99));
await expect("DENIED", "bot fires with an extra field", db("bot").ref("songFires").set({ started: 1, count: 1, junk: "x" }));
await expect("DENIED", "bot fires that aren't a number", db("bot").ref("songFires").set({ started: 1, count: "lots" }));
await expect("ALLOWED", "bot clears the song's fires", db("bot").ref("songFires").set(null));
// grab counts (lib/grabs.js): the bot reads grabs/ and sums each DJ's; only that DJ reads theirs
await expect("ALLOWED", "the bot reads everyone's grabs", db("bot").ref("grabs").once("value"));
await expect("DENIED", "a member reads everyone's grabs", eve.ref("grabs").once("value"));
await expect("ALLOWED", "the bot writes a DJ's grab count", db("bot").ref("grabCount/eve").set({ n: 3, t: 2, last: "1_abc", lastAt: 1700000000000 }));
await expect("ALLOWED", "a DJ reads their own grab count", eve.ref("grabCount/eve").once("value"));
await expect("DENIED", "a member reads someone else's grab count", eve.ref("grabCount/bob").once("value"));
await expect("DENIED", "a member writes their own grab count", eve.ref("grabCount/eve/n").set(999));
await expect("DENIED", "bot grab count with an extra field", db("bot").ref("grabCount/eve/who").set("bob"));
await expect("ALLOWED", "the bot clears a grab count", db("bot").ref("grabCount/eve").set(null));
const stageNow = { online: 3, deck: [{ id: "dj1", n: "dj1", av: "robohash:set2" }, { id: "dj2", n: "dj2", bm: "2.5.7.12.3.30.4.40.10.1.20.18.21.8.40.9.1.33.20" }], colors: { color: "#123456", txt: "#fff" }, style: "bouletmaton",
  theme: "Italo Night", bpm: { started: 1700000000000, bpm: 120 }, tag: { cid: "abc", adamData: { track_name: "Song", artist: "Artist", playcount: 4 } },
  fires: { started: 1700000000000, count: 2 } };
await expect("ALLOWED", "bot publishes the stage summary", db("bot").ref("stage").set(stageNow));
await expect("ALLOWED", "a visitor reads the stage summary", visitor.ref("stage").once("value"));
await expect("DENIED", "a member writes the stage summary", eve.ref("stage/online").set(99));
await expect("DENIED", "a visitor writes the stage summary", visitor.ref("stage/theme").set("hacked"));
await expect("DENIED", "bot stage summary with an extra field", db("bot").ref("stage/junk").set("x"));
await expect("DENIED", "bot stage seat with an extra field", db("bot").ref("stage/deck/0/email").set("a@b.c"));
await expect("DENIED", "bot stage seat with no name", db("bot").ref("stage/deck/0").set({ id: "dj1" }));
await expect("DENIED", "bot stage seat with a Bouletmaton that isn't one", db("bot").ref("stage/deck/0/bm").set("https://example.com/x.png"));
await expect("DENIED", "bot stage with an avatar style the room doesn't offer", db("bot").ref("stage/style").set("dicebear:bottts"));
await expect("ALLOWED", "a visitor reads the history's songs by plays", visitor.ref("globalSongs").orderByChild("plays").limitToLast(5).once("value"));
await expect("ALLOWED", "turn off your name on public pages", eve.ref("users/eve/publicName").set(false));
await expect("ALLOWED", "turn it back on", eve.ref("users/eve/publicName").set(true));
await expect("DENIED", "publicName that isn't true or false", eve.ref("users/eve/publicName").set("no"));
await expect("DENIED", "turn off someone else's name", eve.ref("users/bob/publicName").set(false));
await expect("ALLOWED", "a supermod sets everyone's avatar style", db("boss").ref("roomSettings/avatarStyle").set("robohash:set4"));
await expect("ALLOWED", "a supermod sets a DiceBear style", db("boss").ref("roomSettings/avatarStyle").set("dicebear:pixel-art"));
await expect("ALLOWED", "a supermod sets DiceBear Notionists", db("boss").ref("roomSettings/avatarStyle").set("dicebear:notionists"));
await expect("ALLOWED", "a supermod sets Robohash monsters", db("boss").ref("roomSettings/avatarStyle").set("robohash:set2"));
await expect("ALLOWED", "a supermod sets Robohash robots", db("boss").ref("roomSettings/avatarStyle").set("robohash:set1"));
await expect("ALLOWED", "a supermod sets Bouletmaton", db("boss").ref("roomSettings/avatarStyle").set("bouletmaton"));
await expect("DENIED", "a style the room no longer offers (robot heads)", db("boss").ref("roomSettings/avatarStyle").set("robohash:set3"));
await expect("DENIED", "a style the room no longer offers (DiceBear Bottts)", db("boss").ref("roomSettings/avatarStyle").set("dicebear:bottts"));
await expect("ALLOWED", "a supermod goes back to the room's default", db("boss").ref("roomSettings/avatarStyle").set(null));
await expect("ALLOWED", "a visitor reads the room's settings", visitor.ref("roomSettings").once("value"));
await expect("DENIED", "a mod sets everyone's avatar style", db("mod1").ref("roomSettings/avatarStyle").set("robohash:set2"));
await expect("DENIED", "a member sets everyone's avatar style", eve.ref("roomSettings/avatarStyle").set("robohash:set2"));
await expect("DENIED", "an avatar style that isn't one of the sets", db("boss").ref("roomSettings/avatarStyle").set("https://example.com/x.png"));
await expect("DENIED", "a supermod writes another room setting", db("boss").ref("roomSettings/other").set(true));
await expect("ALLOWED", "save the page you found the room through", eve.ref("users/eve/foundVia").set("genre/nu-disco"));
await expect("DENIED", "change it later", eve.ref("users/eve/foundVia").set("charts/2026-W45"));
await expect("DENIED", "set someone else's", eve.ref("users/bob/foundVia").set("x"));
await expect("DENIED", "a foundVia of 200 KB", bob().ref("users/bob/foundVia").set(big));

console.log("-- playlist formats");
await expect("ALLOWED", "set a playlist to SoundCloud", eve.ref("playlistPrefs/eve/format/-Nabc123").set("sc"));
await expect("ALLOWED", "set the built-in list to YouTube videos", eve.ref("playlistPrefs/eve/format/0").set("video"));
await expect("ALLOWED", "set one to YouTube Music", eve.ref("playlistPrefs/eve/format/-Nabc124").set("ytm"));
await expect("ALLOWED", "clear one", eve.ref("playlistPrefs/eve/format/-Nabc124").remove());
await expect("DENIED", "a format that isn't one of the three", eve.ref("playlistPrefs/eve/format/-Nabc123").set("spotify"));
await expect("DENIED", "a format of 200 KB", eve.ref("playlistPrefs/eve/format/-Nabc123").set(big));
await expect("DENIED", "set someone else's", eve.ref("playlistPrefs/bob/format/0").set("sc"));
await expect("ALLOWED", "the bot reads someone's formats", db("bot").ref("playlistPrefs/eve/format").once("value"));
await expect("DENIED", "the bot reads the rest of their preferences", db("bot").ref("playlistPrefs/eve").once("value"));
await expect("DENIED", "someone else reads them", bob().ref("playlistPrefs/eve/format").once("value"));
await expect("ALLOWED", "you read your own", eve.ref("playlistPrefs/eve").once("value"));

console.log("-- importing a list of songs (importJobs)");
const importJob = (extra) => Object.assign({ items: [{ a: "Khruangbin", t: "Maria Tambien", d: 245 }, { a: "", t: "Just a title" }], format: "ytm", status: "new", at: TS }, extra);
await expect("ALLOWED", "ask the bot to find a list of songs", eve.ref("importJobs/eve/-Nimp001").set(importJob()));
await expect("ALLOWED", "read your own", eve.ref("importJobs/eve/-Nimp001").once("value"));
await expect("DENIED", "someone else reads it", bob().ref("importJobs/eve/-Nimp001").once("value"));
await expect("DENIED", "ask in someone else's name", eve.ref("importJobs/bob/-Nimp002").set(importJob()));
await expect("DENIED", "write the bot's answers yourself", eve.ref("importJobs/eve/-Nimp003").set(importJob({ results: { 0: { s: "room" } } })));
await expect("DENIED", "start one as done", eve.ref("importJobs/eve/-Nimp004").set(importJob({ status: "done" })));
await expect("DENIED", "change one after asking", eve.ref("importJobs/eve/-Nimp001/format").set("sc"));
await expect("DENIED", "a song name of 200 KB", eve.ref("importJobs/eve/-Nimp005").set(importJob({ items: [{ a: big, t: "x" }] })));
await expect("DENIED", "a song with no title", eve.ref("importJobs/eve/-Nimp006").set(importJob({ items: [{ a: "A", t: "" }] })));
await expect("DENIED", "more than a thousand songs", eve.ref("importJobs/eve/-Nimp007").set(importJob({ items: { 1000: { a: "A", t: "B" } } })));
await expect("DENIED", "a format that isn't one of the three", eve.ref("importJobs/eve/-Nimp008").set(importJob({ format: "spotify" })));
await expect("DENIED", "an extra field", eve.ref("importJobs/eve/-Nimp009").set(importJob({ junk: big })));
await expect("ALLOWED", "the bot reads every job", db("bot").ref("importJobs").once("value"));
await expect("ALLOWED", "the bot answers", db("bot").ref("importJobs/eve/-Nimp001").update({ status: "working", n: 1, "results/0": { s: "room", picks: [{ type: 1, cid: "khaudio0001" }] } }));
await expect("ALLOWED", "the bot finishes", db("bot").ref("importJobs/eve/-Nimp001").update({ status: "done", n: 2 }));
await expect("DENIED", "a status the bot doesn't use", db("bot").ref("importJobs/eve/-Nimp001/status").set("whatever"));
await expect("ALLOWED", "you delete yours when you're done with it", eve.ref("importJobs/eve/-Nimp001").remove());
await expect("ALLOWED", "the bot clears an old one", db("bot").ref("importJobs/eve/-Nimp010").set(null));
console.log("-- importing a Spotify playlist (importJobs with spotify)");
const spotifyJob = (extra) => Object.assign({ spotify: "6rqhFgbbKwnb9MLmUQDhG6", format: "ytm", status: "new", at: TS }, extra);
await expect("ALLOWED", "ask the bot to read a Spotify playlist (no songs yet)", eve.ref("importJobs/eve/-Nspo001").set(spotifyJob()));
await expect("DENIED", "a job with neither songs nor a playlist", eve.ref("importJobs/eve/-Nspo002").set(spotifyJob({ spotify: null })));
await expect("DENIED", "a playlist id that isn't one", eve.ref("importJobs/eve/-Nspo003").set(spotifyJob({ spotify: "../../users/bob" })));
await expect("DENIED", "write the playlist's name yourself", eve.ref("importJobs/eve/-Nspo004").set(spotifyJob({ name: "Mine" })));
await expect("ALLOWED", "the bot writes the playlist's songs, name and owner", db("bot").ref("importJobs/eve/-Nspo001").update({ status: "working", n: 0,
  items: [{ a: "Khruangbin", t: "Maria Tambien", d: 245 }], name: "Night Drive", by: "Chris", skipped: 1 }));
await expect("DENIED", "a playlist name of 200 KB", db("bot").ref("importJobs/eve/-Nspo001/name").set(big));
await expect("ALLOWED", "the bot says why it can't", db("bot").ref("importJobs/eve/-Nspo001").update({ status: "failed", note: "Spotify won't share that playlist." }));
await expect("ALLOWED", "the bot says the site can offer Spotify", db("bot").ref("discover/caps/spotify").set(true));
await expect("DENIED", "someone else says so", eve.ref("discover/caps/spotify").set(true));
await expect("ALLOWED", "a visitor reads it", visitor.ref("discover/caps/spotify").once("value"));

await env.withSecurityRulesDisabled((ctx) => ctx.database().ref("banned/bob").set(true));
await expect("DENIED", "someone suspended asks", bob().ref("importJobs/bob/-Nimp011").set(importJob()));

await env.cleanup();
console.log(failed ? "\n" + failed + " RULES TEST(S) FAILED" : "\nrules: all as expected");
process.exit(failed ? 1 : 0);
