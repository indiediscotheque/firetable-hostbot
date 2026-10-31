// End-to-end tests: the real app.js against the database and auth emulators,
// with fake YouTube / SoundCloud answers (fake-services.js). Run inside the
// emulators (see README):
//   cd test && npx firebase emulators:exec --only database,auth --project demo-ft "node bot.test.mjs"
// Pass a scenario name to run just that one.
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const tags = createRequire(import.meta.url)("../lib/tags.js");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKES = fileURLToPath(new URL("./fake-services.js", import.meta.url));
const DB = "http://127.0.0.1:9000", NS = "?ns=demo-ft", OWNER = { Authorization: "Bearer owner" };
const get = async (p) => (await fetch(DB + p + ".json" + NS, { headers: OWNER })).json();
const put = (p, v) => fetch(DB + p + ".json" + NS, { method: "PUT", headers: OWNER, body: JSON.stringify(v) });
const post = async (p, v) => (await (await fetch(DB + p + ".json" + NS, { method: "POST", headers: OWNER, body: JSON.stringify(v) })).json()).name;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the bot's account in the auth emulator, and the real rules on the test database
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:";
const account = async (method) => (await (await fetch(AUTH + method + "?key=fake", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "bot@test.dev", password: "botpass123", returnSecureToken: true }) })).json()).localId;
const BOT = (await account("signUp")) || (await account("signInWithPassword"));
await fetch(DB + "/.settings/rules.json" + NS, { method: "PUT", headers: OWNER, body: readFileSync(new URL("../firebase-rules.json", import.meta.url)) });

// someone says something in chat (written as the owner, like the site would)
const say = async (uid, txt) => {
  const id = await post("/chatData", { id: uid, name: uid, txt, time: { ".sv": "timestamp" } });
  await post("/chatFeed", { chatID: id });
};
const ended = () => ({ type: 1, cid: "old", title: "Old", artist: "Old", started: Date.now() - 300000, duration: 100, djid: "dj2", djname: "dj2",
  url: "https://www.youtube.com/watch?v=old", image: "https://img.example/o.jpg", postedDate: 1577836800000 });
const base = (extra) => Object.assign({
  users: {
    [BOT]: { username: "hostbot", hostbot: true, status: true },
    dj1: { username: "dj1", status: true }, dj2: { username: "dj2", status: true },
    boss: { username: "boss", status: true, mod: true, supermod: true }
  },
  nameClaim: { hostbot: BOT, dj1: "dj1", dj2: "dj2", boss: "boss" },
  table: [{ name: "dj1", id: "dj1", plays: 0 }, { name: "dj2", id: "dj2", plays: 0 }],
  playdex: 1,
  songToPlay: ended()
}, extra);
const nowPlaying = (djid, cid) => ({
  table: [{ name: "dj1", id: "dj1", plays: 1 }, { name: "dj2", id: "dj2", plays: 0 }], playdex: 0,
  songToPlay: { type: 1, cid, title: "Now", artist: "Now", started: Date.now(), duration: 600, djid, djname: djid,
    url: "https://www.youtube.com/watch?v=" + cid, image: "https://img.example/n.jpg", postedDate: 1577836800000, key: "kx" }
});
const yt = (cid, name) => ({ type: 1, cid, name: name || "Art - " + cid });
const sc = (cid, name) => ({ type: 2, cid, name: name || "SC - " + cid });

function startBot(scenario, env = {}) {
  const p = spawn(process.execPath, ["-r", FAKES, "app.js"], {
    cwd: ROOT,
    env: Object.assign({
      PATH: process.env.PATH, HOME: process.env.HOME, SCENARIO: scenario, AUTODJ: "false", TRACKBROKEN_MESSAGES: "true",
      FIRETABLE_USER: "bot@test.dev", FIRETABLE_PASS: "botpass123", FIREBASE_KEY: "fake", FIREBASE_AUTH: "demo-ft.firebaseapp.com",
      FIREBASE_DB: "http://127.0.0.1:9000?ns=demo-ft", SOUNDCLOUD_KEY: "web-client-id"
    }, env)
  });
  p.out = "";
  p.stdout.on("data", (d) => (p.out += d));
  p.stderr.on("data", (d) => (p.out += d));
  return p;
}
const waitFor = async (p, text, ms = 10000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (p.out.includes(text)) return true; await sleep(100); }
  return false;
};
let failures = 0;
const check = (ok, msg) => { console.log((ok ? "  PASS " : "  FAIL ") + msg); if (!ok) failures++; };
const said = (st) => Object.values(st.chatData || {}).filter((c) => c.id === BOT).map((c) => c.txt);
const flags = (list) => Object.values(list || {}).filter((t) => t.flagged).map((t) => t.cid + ":" + t.flagged.code);
const healthy = async (p) => {
  const st = await get("/");
  const botMsgs = Object.values(st.chatData || {}).filter((c) => c.id === BOT);
  check(p.exitCode === null && !/TypeError|ReferenceError|unhandled error|PERMISSION_DENIED|permission_denied/i.test(p.out), "bot still running, no errors or refused writes in its log");
  check(botMsgs.every((c) => c.feedID && st.chatFeed && st.chatFeed[c.feedID] && st.chatFeed[c.feedID].chatID), "the bot's chat messages are linked to their feed entries");
};

const scenarios = {
  async yt_outage() {
    await put("/", base({ queues: { dj1: { k1: yt("yt1"), k2: yt("yt2") }, dj2: { s1: sc("sc1") } } }));
    const p = startBot("yt_outage");
    await sleep(8000);
    const st = await get("/");
    check(flags(st.queues.dj1).length === 0 && JSON.stringify(Object.keys(st.queues.dj1)) === '["k1","k2"]', "YouTube outage: nothing flagged, list untouched");
    check(st.songToPlay.cid === "sc1" && st.songToPlay.djid === "dj2", "decks passed to the DJ with a SoundCloud track");
    check(said(st).filter((t) => /can't reach YouTube/.test(t)).length === 1, "room told once");
    await healthy(p);
    return p;
  },
  async yt_deleted_and_bad_art() {
    await put("/", base({ queues: { dj1: { k1: yt("dead1"), k2: yt("badart") }, dj2: { s1: yt("yt2") } } }));
    const p = startBot("yt_deleted");
    await sleep(3500);
    const st = await get("/");
    check(JSON.stringify(flags(st.queues.dj1)) === '["dead1:2"]' && st.songToPlay.cid === "badart" && st.table[0].plays === 1,
      "deleted video flagged (code 2), next track plays, one play counted");
    check(st.colors && st.colors.color === "#fff" && /couldn't read the artwork's colours/.test(p.out), "unreadable artwork: plain colours, logged, no crash");
    await healthy(p);
    return p;
  },
  async soundcloud_web_api() {
    await put("/", base({ queues: { dj1: { k1: sc("sc404"), k2: sc("sc503") }, dj2: { s1: yt("yt1") } } }));
    const p = startBot("sc");
    await sleep(7000);
    const st = await get("/");
    check(/soundcloud: web API with SOUNDCLOUD_KEY/.test(p.out), "default: SoundCloud's web API with SOUNDCLOUD_KEY");
    check(JSON.stringify(flags(st.queues.dj1)) === '["sc404:4"]', "404 flagged (code 4), 503 not");
    check(st.songToPlay.cid === "yt1", "SoundCloud down: decks passed on");
    await healthy(p);
    return p;
  },
  async soundcloud_official_api() {
    await put("/", base({ queues: { dj1: { k1: sc("scblocked"), k2: sc("sc404"), k3: sc("sc1") } } }));
    const p = startBot("sc_official", { SOUNDCLOUD_CLIENT_ID: "id", SOUNDCLOUD_CLIENT_SECRET: "secret" });
    await sleep(4000);
    const st = await get("/");
    check(/soundcloud: official API/.test(p.out), "with client id + secret: the official API");
    check(JSON.stringify(flags(st.queues.dj1).sort()) === '["sc404:4","scblocked:5"]' && st.songToPlay.cid === "sc1", "blocked and missing tracks flagged, a playable one plays");
    await healthy(p);
    return p;
  },
  async replay_and_skips() {
    await put("/", base(Object.assign(nowPlaying("dj1", "yt1"), { queues: { dj1: { k1: yt("yt3") }, dj2: { s1: yt("yt2") } } })));
    await say("boss", "!skip"); // sent before the restart
    const before = await get("/songToPlay");
    const p = startBot("skips", { YT_DELAY: "800" });
    check(await waitFor(p, "Listening now."), "bot says Listening now.");
    await sleep(1500);
    check((await get("/songToPlay")).started === before.started, "an old !skip isn't re-run after a restart");
    await Promise.all([say("boss", "!skip"), say("boss", "!skip"), say("boss", "!skip")]);
    await sleep(3000);
    const st = await get("/");
    check(Object.keys(st.songHistory || {}).length === 1 && st.songToPlay.djid === "dj2", "three quick skips skip one song");
    check(said(st).filter((t) => /Hang on, boss, the next song is already loading/.test(t)).length === 1, "skips while it loads get one \"hang on\"");
    await healthy(p);
    return p;
  },
  async commands() {
    await put("/", base(Object.assign(nowPlaying("dj1", "yt1"), { queues: { dj1: { k1: yt("yt3") }, dj2: { s1: yt("yt2") } } })));
    const p = startBot("commands");
    await waitFor(p, "Listening now.");
    await say("dj1", "!fixtags Someone - Else");
    await say("boss", "!fixtags Art - Fixed Title");
    await say("ghost", "!skip"); // no profile
    await say("dj2", "!suggest");
    await say("dj2", "!suggest " + "x".repeat(81));
    await say("dj2", "!suggest 90s one-hit wonders");
    await sleep(4000); // the vote ends (60 s, sped up)
    await say("dj2", "!suggest another one");
    await sleep(1500);
    const st = await get("/");
    const s = said(st);
    check(s.some((t) => /Only mods can fix tags, dj1/.test(t)) && st.globalTracks && st.globalTracks["1yt1"] && st.globalTracks["1yt1"].title === "Fixed Title",
      "!fixtags: refused for a member, works for a mod");
    check(s.some((t) => /Suggest a theme like/.test(t)) && s.some((t) => /under 80 characters/.test(t)), "!suggest: needs a theme, 80 characters at most");
    check(s.filter((t) => /@everyone/.test(t)).length === 1 && s.some((t) => /suggest another theme in 15 minute/.test(t)), "!suggest: one vote, then a 15-minute wait");
    await healthy(p);
    return p;
  },
  async titles_long_replies_and_replays() {
    await put("/", base({ queues: { dj1: { k1: yt("yt1", "Art - Song - Live Version") }, dj2: { s1: yt("yt2") } } }));
    const p = startBot("guards");
    await waitFor(p, "Listening now.");
    await sleep(1500);
    // a command from 10 minutes ago (e.g. delivered after a long disconnect)
    const oldID = await post("/chatData", { id: "boss", name: "boss", txt: "!remove dj2", time: Date.now() - 600000 });
    await post("/chatFeed", { chatID: oldID });
    // the same message added to the feed twice: it counts once
    const twice = await post("/chatData", { id: "dj1", name: "dj1", txt: "!theme", time: { ".sv": "timestamp" } });
    await post("/chatFeed", { chatID: twice });
    await post("/chatFeed", { chatID: twice });
    // a reply longer than chat allows is shortened, not lost
    await say("boss", "!fixtags Art - " + "t".repeat(200));
    await sleep(2000);
    const st = await get("/");
    const s = said(st);
    check(st.songToPlay.cid === "yt1" && st.songToPlay.artist === "Art" && st.songToPlay.title === "Song - Live Version",
      "a title with a second ' - ' keeps all of it (" + st.songToPlay.title + ")");
    check((st.table || []).some((d) => d.id === "dj2") && /ignored a chat message from \d+ seconds ago/.test(p.out), "a 10-minute-old !remove is ignored");
    check(s.filter((t) => /no theme/.test(t)).length === 1, "a message in the feed twice is handled once");
    check(s.some((t) => /^ok\. updating tags/.test(t) && t.length === 240 && t.endsWith("…")), "a reply over 240 characters is shortened to fit");
    await healthy(p);
    return p;
  },
  async lastfm_and_artwork() {
    await put("/", base({ queues: { dj1: { k1: yt("yt1", "Björk - Jóga") }, dj2: { s1: yt("yt2") } } }));
    const p = startBot("lastfm", { LASTFM_APIKEY: "key", LASTFM_SECRET: "secret", LASTFM_SESSIONKEY: "sk", LASTFM_USERNAME: "room" });
    await sleep(3000);
    const st = await get("/");
    check(/fake last.fm: track.updateNowPlaying signature ok \(Björk - Jóga\)/.test(p.out), "now playing sent to last.fm, signed correctly for a non-English artist");
    check(st.tagUpdate && st.tagUpdate.cid === "yt1" && st.tagUpdate.adamData.playcount === 7, "the room's last.fm play count reaches the site");
    check(st.colors && /^#[0-9a-f]{6}$/i.test(st.colors.color) && st.colors.color.toLowerCase() !== "#ffffff", "room colours read from the artwork (" + (st.colors && st.colors.color) + ")");
    await healthy(p);
    return p;
  },
  async play_history() {
    // the history was published: "Foals - My Number" is track t1, first played
    // in 2016, 41 plays (60 counting its remix); a DJ brings a new upload of it
    const key = tags.hash(tags.trackKey("Foals", "My Number"));
    const workKey = tags.hash(tags.songKey("Foals", "My Number"));
    const first = Date.UTC(2016, 7, 23, 21, 52);
    await put("/", base({
      queues: { dj1: { k1: yt("yt9", "Foals - My Number (Official Video)") }, dj2: { s1: yt("yt2") } },
      globalSongsMeta: { ready: true },
      globalSongs: { t1: { artist: "Foals", title: "My Number", work: "s1", plays: 41, first_play_date: first, first_play_dj: "understater", last_play_date: first + 1000, last_play_dj: "eve" } },
      globalWorks: { s1: { artist: "Foals", title: "My Number", plays: 60, versions: 2, first_play_date: first } },
      globalSongKeys: { [key]: "t1" },
      globalWorkKeys: { [workKey]: "s1" },
      tagReview: { q1: { n: 1, a: "Foals - My Number", b: "Foals - My Numbr", a_key: "foals|mynumber|", b_key: "foals|mynumbr|", why: "similar title" } }
    }));
    const p = startBot("history");
    await waitFor(p, "Listening now.");
    await sleep(2500);
    let st = await get("/");
    check(st.globalTracks && st.globalTracks["1yt9"] && st.globalTracks["1yt9"].song === "t1", "a new upload of a known song is linked to its track by its tags");
    check(st.globalSongs.t1.plays === 42 && st.globalWorks.s1.plays === 61 && st.globalSongs.t1.last_play_dj === "dj1", "the play is counted on the track and on the song (all versions)");
    const ad = st.tagUpdate && st.tagUpdate.adamData || {};
    check(st.tagUpdate && st.tagUpdate.cid === "yt9" && ad.playcount === 41 && ad.all_versions_playcount === 60 && /^2016-08-23/.test(ad.first_play || "") && ad.first_play_dj === "understater" && ad.last_play_dj === "eve",
      "the room sees the true first play (2016), its own count and the all-versions count");
    check(Object.values(st.playLog || {}).some((e) => e.k === "1old" && e.dj === "dj2" && e.w), "the song that ended is in the permanent play log");
    await say("dj2", "!plays");
    await say("dj2", "!review");
    await say("boss", "!review");
    await say("boss", "!same 1");
    await say("boss", "!fixtags Foals - My Number");
    await sleep(2500);
    st = await get("/");
    const s = said(st);
    check(s.some((t) => /Played 41 times before \(60 counting every version\)\. First played 2016-08-23 by understater/.test(t)), "!plays tells the room the track's history");
    check(s.some((t) => /Only mods can sort out tags, dj2/.test(t)) && s.some((t) => /#1 \(1 waiting\): same track\?/.test(t)), "!review: mods only, shows the next question");
    check(st.tagReview.q1.decision === "merge" && st.tagReview.q1.by === "boss", "!same records a mod's answer for the next history refresh");
    const log = Object.values(st.tagLog || {});
    check(log.some((e) => e.k === "1yt9" && e.a === "Foals" && e.t === "My Number" && e.by === "boss" && e.ft === "My Number (Official Video)"), "!fixtags is logged with what it replaced");
    check(st.globalSongKeys[key] === "t1" && st.globalSongs.t1.title === "My Number", "the fixed spelling points at the same track");
    await healthy(p);
    return p;
  },
  async remove_respects_rank() {
    await put("/", base({
      users: Object.assign(base().users, { mod1: { username: "mod1", status: true, mod: true } }),
      nameClaim: Object.assign(base().nameClaim, { mod1: "mod1" }),
      table: [{ name: "dj1", id: "dj1", plays: 0 }, { name: "dj2", id: "dj2", plays: 0 }, { name: "boss", id: "boss", plays: 0 }],
      queues: { dj1: { k1: yt("yt1") }, dj2: { s1: yt("yt2") }, boss: { b1: yt("yt3") } }
    }));
    const p = startBot("ranks");
    await waitFor(p, "Listening now.");
    await sleep(1500);
    await say("mod1", "!remove boss");
    await say("mod1", "!remove dj2");
    await sleep(1500);
    const st = await get("/");
    const ids = (st.table || []).map((d) => d.id);
    check(ids.includes("boss") && said(st).some((t) => /You can't remove boss, mod1/.test(t)), "a mod can't remove a supermod");
    check(!ids.includes("dj2"), "a mod can still remove a member");
    await healthy(p);
    return p;
  },
  async tracks_that_cant_play_here() {
    await put("/", base({ queues: {
      dj1: { k1: yt("noembed"), k2: yt("premiere"), k3: yt("private1"), k4: sc("scpreview"), k5: sc("scsnip"), k6: sc("scshort"), k7: yt("good1") },
      dj2: { s1: yt("yt2") }
    } }));
    const p = startBot("cant_play");
    await sleep(5000);
    const st = await get("/");
    check(JSON.stringify(flags(st.queues.dj1).sort()) === '["noembed:6","premiere:5","private1:2","scpreview:5","scshort:5","scsnip:5"]',
      "not embeddable (6), premiere (5), private (2) and SoundCloud previews (5) flagged: " + JSON.stringify(flags(st.queues.dj1).sort()));
    check(st.songToPlay.cid === "good1", "the first track that can play, plays");
    const keys = Object.keys(st.queues.dj1).sort();
    check(keys.length === 7 && !keys.some((k) => k.startsWith("k")), "every checked track moved to the bottom, none lost (" + keys.join(",") + ")");
    check(said(st).some((t) => /only a preview/.test(t)), "the DJ is told why");
    await healthy(p);
    return p;
  },
  async scrobbles_and_one_copy() {
    await put("/", base({ queues: { dj1: { k1: yt("short1", "Art - Short"), k2: yt("yt3", "Art - Skipped") }, dj2: { s1: yt("yt2", "Art - Two") } } }));
    const lfm = { LASTFM_APIKEY: "key", LASTFM_SECRET: "secret", LASTFM_SESSIONKEY: "sk", LASTFM_USERNAME: "room" };
    const p = startBot("one_copy", lfm);
    check(await waitFor(p, "Listening now."), "first copy starts");
    const p2 = startBot("one_copy", lfm);
    check(await waitFor(p2, "another copy of the bot is running"), "a second copy waits");
    await sleep(3500); // the 40-second track runs out (sped up), the next one starts
    await say("boss", "!skip"); // ...and is skipped right away
    await say("dj1", "!theme");
    await sleep(1500);
    let st = await get("/");
    check(/track.scrobble signature ok \(Art - Short\)/.test(p.out), "a song that ran to its end is scrobbled");
    check(!/track.scrobble signature ok \(Art - Two\)/.test(p.out), "a song skipped right away isn't");
    check(said(st).filter((t) => /no theme/.test(t)).length === 1 && !p2.out.includes("Listening now."), "only one copy answers");
    p.kill();
    check(await waitFor(p2, "Listening now.", 15000), "when the first copy stops, the second takes over");
    await say("dj1", "!theme");
    await sleep(1500);
    st = await get("/");
    check(said(st).filter((t) => /no theme/.test(t)).length === 2, "and answers commands");
    await healthy(p2);
    return p2;
  },
  async members_kept_current_and_chat_pruned() {
    const chatData = {}, chatFeed = {};
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(3, "0");
      chatData["-c" + n] = { id: "dj1", name: "dj1", txt: "old " + i, time: 1, feedID: "-f" + n };
      chatFeed["-f" + n] = { chatID: "-c" + n };
    }
    await put("/", base({ chatData, chatFeed, queues: { dj1: { k1: yt("yt1") }, dj2: { s1: yt("yt2") }, newbie: { n1: yt("yt3") } } }));
    const p = startBot("members");
    await waitFor(p, "Listening now.");
    await sleep(1500);
    let st = await get("/");
    const left = Object.keys(st.chatFeed || {}).sort();
    check(left.length === 20 && left[0] === "-f010" && !st.chatData["-c009"] && st.chatData["-c010"], "chat trimmed to the latest 20, messages and feed entries together (" + left.length + ")");
    // someone signs up after the bot started, then renames
    await put("/users/newbie", { username: "newbie", status: true });
    await sleep(500);
    await say("boss", "!add newbie");
    await sleep(1000);
    check(((await get("/table")) || []).some((d) => d && d.id === "newbie"), "!add finds a member who joined after the bot started");
    await put("/users/newbie/username", "renamed1");
    await put("/users/dj1/status", false);
    await sleep(500);
    await say("boss", "!remove renamed1");
    await say("boss", "!lastblipped dj1");
    await sleep(1500);
    st = await get("/");
    const s = said(st);
    check(!s.some((t) => /who is that/.test(t)) && !(st.table || []).some((d) => d && d.id === "newbie"), "!remove finds them by their new name");
    check(s.some((t) => /this person last blipped 0 minutes ago/.test(t)), "presence changes are noticed (!lastblipped)");
    await healthy(p);
    return p;
  },
  async names() {
    await put("/", base({
      users: Object.assign(base().users, {
        mx: { username: "MiXed", joined: 5 }, t1: { username: "Twin", joined: 1 }, t2: { username: "twin", joined: 2 }
      }),
      nameClaim: Object.assign(base().nameClaim, { MiXed: "mx" }),
      queues: { dj1: { k1: yt("yt1") }, dj2: { s1: yt("yt2") } }
    }));
    const p = startBot("names");
    await waitFor(p, "Listening now.");
    await sleep(1500);
    await say("boss", "!remove DJ2");
    await sleep(1500);
    const st = await get("/");
    check(st.nameClaim.mixed === "mx" && st.nameClaim.MiXed === "mx", "existing names get a lowercase claim (the old one stays)");
    check(st.nameClaim.twin === "t1" && /Twin and twin differ only in case/.test(p.out), "two names differing only in case: the earlier member gets it, logged");
    check(!(st.table || []).some((d) => d.id === "dj2"), "!remove DJ2 finds dj2 (any case)");
    await healthy(p);
    return p;
  },
  async trimming_and_shallow_reads() {
    const history = {};
    for (let i = 0; i < 505; i++) history["-0" + String(i).padStart(4, "0")] = { artist: "A", title: "T" + i, cid: "c" + i, type: 1, djid: "dj1", dj: "dj1" };
    history["-0h1"] = { artist: "Flag", title: "Me", cid: "yt9", type: 1, djid: "dj1", dj: "dj1" };
    const old = Date.now() - 40 * 24 * 3600 * 1000;
    await put("/", base({
      songHistory: history,
      queues: { dj1: { k1: yt("yt1") }, dj2: { s1: yt("yt2") } },
      playlists: { dj1: { pl1: { name: "one", list: { t1: yt("yt9") } }, pl2: { name: "two", list: { t2: yt("other") } } } },
      mentions: { dj1: { m1: { time: old, txt: "old" }, m2: { time: Date.now(), txt: "new" } }, dj2: { m3: { time: old, txt: "old" } } }
    }));
    const p = startBot("trim");
    await waitFor(p, "Listening now.");
    await sleep(1500);
    await say("boss", "!flagplay -0h1 broken");
    await sleep(2000);
    const st = await get("/");
    const keys = Object.keys(st.songHistory).sort();
    check(keys.length === 500 && keys[0] === "-00007", "Recent kept to 500, oldest removed first (" + keys.length + ")");
    check(st.playlists.dj1.pl1.list.t1.flagged && st.playlists.dj1.pl1.list.t1.flagged.code === 8 && !st.playlists.dj1.pl2.list.t2.flagged,
      "!flagplay flags the track in the DJ's playlists");
    check(!/shallow read .* failed/.test(p.out), "playlists and mentions listed without downloading them");
    check(st.mentions.dj1 && st.mentions.dj1.m2 && !st.mentions.dj1.m1 && !(st.mentions.dj2 && st.mentions.dj2.m3), "mentions older than 30 days pruned, newer kept");
    await healthy(p);
    return p;
  },
  async long_list_reads_a_page_at_a_time() {
    // 45 flagged tracks ahead of the first playable one: the bot pages past them
    const list = {};
    for (let i = 0; i < 45; i++) list["k" + String(i).padStart(3, "0")] = Object.assign(yt("f" + i), { flagged: { date: 1, code: 2 } });
    list.k100 = yt("good1");
    list.k101 = yt("good2");
    await put("/", base({ queues: { dj1: list, dj2: { s1: yt("yt2") } } }));
    const p = startBot("paging");
    await sleep(3500);
    const st = await get("/");
    const keys = Object.keys(st.queues.dj1).sort();
    check(st.songToPlay.cid === "good1" && st.songToPlay.djid === "dj1", "plays the first unflagged track past several pages of flagged ones");
    check(keys.length === 47 && st.queues.dj1.k101 && !st.queues.dj1.k100 && flags(st.queues.dj1).length === 45,
      "played track moves to the bottom, flagged ones untouched");
    check(st.colors && !st.colors.altColors && Object.values(st.songHistory || {}).every((h) => !h.colors || !h.colors.altColors),
      "room colours and Recent entries carry only the accent");
    await healthy(p);
    return p;
  },
  async lookup_never_answers() {
    await put("/", base({ queues: { dj1: { k1: yt("hang1") }, dj2: { s1: sc("sc1") } } }));
    const p = startBot("hang");
    await sleep(12000);
    const st = await get("/");
    check(st.songToPlay.cid === "sc1" && flags(st.queues.dj1).length === 0 && /no answer in 30 seconds/.test(p.out),
      "no answer: gives up after 30 s, nothing flagged, decks passed on");
    await healthy(p);
    return p;
  },
  async no_dj() {
    await put("/", base({ table: null, playdex: 0, songToPlay: { type: 1, cid: 0, title: "Nothing Is Playing", started: Date.now(), duration: 0, image: "img/idlogo.png", artist: "x" } }));
    const p = startBot("no_dj");
    await waitFor(p, "Listening now.");
    await say("dj1", "!skip");
    await say("boss", "!printcard");
    await say("boss", "!flag broken");
    await sleep(1500);
    await say("dj2", "!theme");
    await sleep(1500);
    const s = said(await get("/"));
    check(s.some((t) => /no theme/.test(t)) && s.some((t) => /no card to print/.test(t)), "commands with nobody DJing don't crash the bot");
    await healthy(p);
    return p;
  },
  async wrong_password() {
    await put("/", base({}));
    const p = startBot("login", { FIRETABLE_PASS: "wrong" });
    await sleep(5000);
    check(p.exitCode === null && (p.out.match(/couldn't sign in/g) || []).length >= 2, "wrong password: keeps retrying and says so");
    return p;
  }
};

const only = process.argv[2];
for (const [name, run] of Object.entries(scenarios)) {
  if (only && name !== only) continue;
  console.log("\n== " + name);
  let p;
  try { p = await run(); } catch (e) { check(false, "scenario threw: " + e.stack); }
  if (p) {
    if (process.env.SHOW_LOG) console.log(p.out);
    p.kill();
    await sleep(400);
  }
}
console.log(failures ? "\n" + failures + " BOT TEST(S) FAILED" : "\nbot: all passed");
process.exit(failures ? 1 : 0);
