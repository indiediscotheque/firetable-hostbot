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

await env.cleanup();
console.log(failed ? "\n" + failed + " RULES TEST(S) FAILED" : "\nrules: all as expected");
process.exit(failed ? 1 : 0);
