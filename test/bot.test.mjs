// End-to-end tests: the real app.js against the database and auth emulators,
// with fake YouTube / SoundCloud answers (fake-services.js). Run inside the
// emulators (see README):
//   cd test && npx firebase emulators:exec --only database,auth --project demo-ft "node bot.test.mjs"
// Pass a scenario name to run just that one.
import { spawn } from "child_process";
import { readFileSync } from "fs";
import crypto from "crypto";
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
      FIREBASE_DB: "http://127.0.0.1:9000?ns=demo-ft", SOUNDCLOUD_KEY: "web-client-id",
      YTMUSIC_SYNC: "false" // on in the youtube_music_sync scenario only
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
  async card_grabs() {
    await put("/", base(nowPlaying("dj1", "yt1")));
    const p = startBot("card_grabs");
    await waitFor(p, "Listening now.");
    const grabFor = async (uid, txt) => {
      const id = await post("/chatData", { id: uid, name: uid, txt, botCmd: true, time: { ".sv": "timestamp" } });
      await post("/chatFeed", { chatID: id });
    };
    await say("dj2", "!grab"); // nothing printed yet
    await say("boss", "!printcard");
    await sleep(1500);
    let st = await get("/");
    const printed = Object.values(st.chatData).find((c) => c.id === BOT && c.grab);
    check(printed && printed.txt === "A new trading card has been printed!" && st.cards[printed.grab] && st.cards[printed.grab].owner === false,
      "a printed card comes with a GRAB button, not \"type !grab\"");
    await grabFor("dj2", "!grab " + printed.grab);
    await sleep(800);
    await grabFor("boss", "!grab " + printed.grab); // a moment too slow
    await grabFor("dj1", "!grab nope");
    await sleep(1500);
    st = await get("/");
    const announced = Object.values(st.chatData).find((c) => c.id === BOT && c.card === printed.grab);
    check(st.cards[printed.grab].owner === "dj2" && announced && announced.txt === "dj2 grabbed the card!" && !/@/.test(announced.txt),
      "the GRAB button gets the card and the room sees who grabbed it, with the card");
    const missed = (uid) => Object.values((st.notices || {})[uid] || {}).filter((n) => n.kind === "grab-missed");
    check(missed("boss").length === 1 && missed("boss")[0].card === printed.grab && missed("dj1").length === 1 && !(st.notices || {}).dj2,
      "a GRAB that's too late (or for another card) gets a quiet notice; the winner gets none");
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
  async broken_tracks_at_the_top() {
    // DJs park broken tracks at the top of big lists. The bot must find the
    // first playable one quickly (one indexed read, not hundreds of pages),
    // skip an old flag that has no date, and say why when there's nothing.
    const list = {};
    for (let i = 0; i < 8635; i++) { // the size of a real DJ's list, with its 1,371 flagged tracks on top
      const key = "-Ok" + String(i).padStart(5, "0");
      list[key] = Object.assign(yt("yc" + i, "Art - Song " + i), i < 1370 ? { flagged: { date: 1, code: 2 } } : i === 1370 ? { flagged: { code: 8 } } : {});
    }
    const dead = { a: Object.assign(yt("dd1"), { flagged: { date: 1, code: 2 } }), b: Object.assign(yt("dd2"), { flagged: { code: 8 } }) };
    await put("/", base({
      users: {
        [BOT]: { username: "hostbot", hostbot: true, status: true },
        dj1: { username: "dj1", status: true, selectedList: "big" }, dj2: { username: "dj2", status: true },
        boss: { username: "boss", status: true, mod: true, supermod: true }
      },
      playlists: { dj1: { big: { name: "Big", list } } },
      queues: { dj2: dead }
    }));
    const p = startBot("broken_top");
    await waitFor(p, "Listening now.");
    let st;
    for (let i = 0; i < 40; i++) { await sleep(250); st = await get("/songToPlay"); if (st && st.djid === "dj1") break; }
    check(st && st.djid === "dj1" && st.cid === "yc1371", "1,371 flagged tracks on top, and an old flag with no date: plays the first good one (" + (st && st.cid) + ")");
    check(!/no answer in|couldn't check the track on that DJ's playlist/.test(p.out), "found well within the time limit");
    await say("boss", "!skip");
    await waitFor(p, "nothing playable", 8000);
    await sleep(1000);
    st = await get("/");
    check(!(st.table || []).some((x) => x && x.id === "dj2"), "every track flagged: off the decks");
    check(said(st).some((t) => /dj2's DJ playlist has nothing I can play, so they're off the decks/.test(t)) &&
      Object.values((st.notices || {}).dj2 || {}).some((n) => /Your DJ playlist has nothing I can play/.test(n.txt)), "and told why, in chat and privately");
    await healthy(p);
    return p;
  },
  async away_djs() {
    // idle with the room open: stays. Connection dropped (asleep, frozen tab):
    // stays. Closed the browser: asked, then the bus. Back online: off the bus.
    const now = Date.now();
    const seat = (id) => ({ name: id, id, plays: 0 });
    await put("/", base(Object.assign(nowPlaying("dj1", "cur1"), {
      users: {
        [BOT]: { username: "hostbot", hostbot: true, status: true },
        dj1: { username: "dj1", status: true },
        idler: { username: "idler", status: true, idle: { isIdle: true, audio: 1, since: now - 3600000 } },
        sleeper: { username: "sleeper", status: false, offlineAt: now - 60000 },
        closer: { username: "closer", status: false, offlineAt: now - 60000, closed: now - 60000 },
        waiter: { username: "waiter", status: false, offlineAt: now - 60000, closed: now - 60000 }
      },
      table: [seat("dj1"), seat("idler"), seat("sleeper"), seat("closer")],
      waitlist: [seat("waiter")]
    })));
    const p = startBot("away", { AWAY_CLOSED_MIN: "0.02", AWAY_ANSWER_MIN: "0.05", AWAY_LOST_HOURS: "1" });
    await waitFor(p, "Listening now.");
    await waitFor(p, "closer didn't come back", 15000);
    await sleep(1500);
    let st = await get("/");
    const notices = (id) => Object.values((st.notices || {})[id] || {}).map((n) => n.txt);
    const at = (id) => (st.table || []).find((x) => x && x.id === id);
    check(notices("closer").some((t) => /^Are you there\?/.test(t)), "closed the browser: asked first");
    check(at("closer") && at("closer").removeAfter === true && said(st).some((t) => /:bus: closer left, so they're catching the bus after their next song/.test(t)),
      "then catches the bus: steps down after their next song");
    check(!(st.waitlist || []).some((x) => x && x.id === "waiter") && said(st).some((t) => /waiter left, so they're off the waitlist/.test(t)), "closed and in the waitlist: out of line");
    check(at("idler") && !at("idler").removeAfter && !notices("idler").length, "idle with the room open: stays, nothing asked");
    check(at("sleeper") && !at("sleeper").removeAfter && !notices("sleeper").length, "connection dropped, browser not closed: stays");
    check(at("dj1") && !at("dj1").removeAfter, "the DJ playing now is left alone");
    // closer comes back before their turn
    await put("/users/closer/status", true);
    await put("/users/closer/closed", null);
    await waitFor(p, "Welcome back, closer", 8000);
    st = await get("/");
    check(at("closer") && at("closer").removeAfter === false && said(st).some((t) => /Welcome back, closer! You're staying on the decks/.test(t)), "back online: off the bus, staying on");
    await healthy(p);
    return p;
  },
  async song_tempo() {
    // an old lookup found nothing; the new one searches plainly, skips the
    // karaoke cover and the version with no tempo, and finds the radio edit's
    await put("/", base({
      queues: { dj1: { k1: yt("ytbpm1", "Bpm Artist - Bpm Song (Official Video)") }, dj2: { s1: yt("ytbpm2", "Nobody - Unknown Tune") } },
      bpm: { "1_ytbpm1": { none: true, at: Date.now() - 1000 } }
    }));
    const p = startBot("bpm");
    await waitFor(p, "Listening now.");
    await sleep(2500);
    let st = await get("/");
    check(/fake deezer: search "bpm artist bpm song"/.test(p.out), "the old \"not found\" is looked up again, with a plain search");
    check(st.songBpm && st.songBpm.bpm === 122.7 && st.songBpm.src === "deezer" && st.songBpm.started === st.songToPlay.started, "the playing song's tempo is published (" + JSON.stringify(st.songBpm) + ")");
    check(st.bpm["1_ytbpm1"].bpm === 122.7, "and cached for the track");
    await say("dj1", "!skip");
    await sleep(2500);
    st = await get("/");
    check(st.songToPlay.cid === "ytbpm2" && st.bpm["1_ytbpm2"] && st.bpm["1_ytbpm2"].none === true && st.bpm["1_ytbpm2"].v === 2, "no tempo found: remembered with the lookup's version");
    check(!st.songBpm || st.songBpm.started !== st.songToPlay.started, "and nothing published for it");
    await say("dj2", "!bpm 111");
    await sleep(1500);
    st = await get("/");
    check(st.songBpm && st.songBpm.bpm === 111 && st.songBpm.src === "manual" && st.bpm["1_ytbpm2"].bpm === 111, "the DJ sets it with !bpm 111");
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
  async accents_restored_live() {
    // the history writes this track "Björk - Jóga"; a DJ's copy lost its
    // accents to the old Last.fm bug
    await put("/", base({
      queues: { dj1: { k1: yt("ytj", "Bjork - Joga") }, dj2: { s1: yt("yt2") } },
      globalSongsMeta: { ready: true },
      globalSongs: { t1: { artist: "Björk", title: "Jóga", plays: 5, first_play_date: Date.UTC(2016, 0, 1) } },
      globalSongKeys: { [tags.hash(tags.trackKey("Bjork", "Joga"))]: "t1" }
    }));
    const p = startBot("accents");
    await waitFor(p, "Listening now.");
    await sleep(2500);
    const st = await get("/");
    check(st.globalTracks["1ytj"].artist === "Björk" && st.globalTracks["1ytj"].title === "Jóga" && st.globalTracks["1ytj"].song === "t1", "the upload's tags get their accents back");
    check(st.tagUpdate && st.tagUpdate.adamData.artist === "Björk" && st.tagUpdate.adamData.track_name === "Jóga", "the room sees them");
    check(Object.values(st.queues.dj1).some((t) => t.name === "Björk - Jóga"), "and so does the DJ's queue");
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
    const told = Object.values((st.notices || {}).dj1 || {}).map((n) => n.txt);
    check(told.some((t) => /only a preview/.test(t)) && !said(st).some((t) => /only a preview|@dj1/.test(t)),
      "the DJ is told why, privately (a notice, not an @ping in chat)");
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
  async push_notifications() {
    // a browser's push keys, as the site saves them
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const auth = crypto.randomBytes(16).toString("base64url");
    const dev = (endpoint, extra) => Object.assign({ endpoint, p256dh: ua.getPublicKey().toString("base64url"), auth, device: "Android", everyone: false, seen: Date.now() }, extra);
    await put("/", base({
      users: {
        [BOT]: { username: "hostbot", hostbot: true, status: true },
        dj1: { username: "dj1", status: true, idle: { isIdle: true, audio: 1, since: Date.now() } }, // phone in a pocket
        dj2: { username: "dj2", status: true, idle: { isIdle: false, audio: 1, since: Date.now() } }, // looking at the room
        boss: { username: "boss", status: true, mod: true, supermod: true },
        far: { username: "far", status: false }
      },
      nameClaim: { hostbot: BOT, dj1: "dj1", dj2: "dj2", boss: "boss", far: "far" },
      pushSubs: {
        dj1: { phone_dj1: dev("https://fcm.googleapis.com/fcm/send/dj1-phone", { everyone: true }), ipad_dj1: dev("https://web.push.apple.com/gone", { device: "iPad" }),
          old_dj1x: dev("https://fcm.googleapis.com/fcm/send/dj1-old", { seen: Date.now() - 90 * 24 * 3600 * 1000 }) },
        dj2: { phone_dj2: dev("https://fcm.googleapis.com/fcm/send/dj2-phone", { everyone: true }) },
        far: { phone_far: dev("https://web.push.apple.com/far-iphone") }
      },
      blocks: { far: { boss: true } }
    }));
    const p = startBot("push", { PUSH_UA_KEY: ua.getPrivateKey().toString("base64url"), PUSH_AUTH: auth, SITE_URL: "https://room.example/" });
    check(await waitFor(p, "push: on (new keys saved in the database, subject https://room.example)"), "first start: makes a key pair and keeps it in the database");
    let st = await get("/");
    check(st.pushKey && st.pushVapid && st.pushKey === st.pushVapid.publicKey, "publishes the public key for the site");
    // the bot drops old devices just after it says push is on: wait for it
    await waitFor(p, "push: dropping 1 device(s) not seen in 60 days");
    for (let i = 0; i < 30 && st.pushSubs.dj1 && st.pushSubs.dj1.old_dj1x; i++) { await sleep(100); st = await get("/"); }
    check(st.pushSubs.dj1 && !st.pushSubs.dj1.old_dj1x && st.pushSubs.dj1.phone_dj1, "devices not opened in 60 days are dropped");
    await say("dj2", "hey @dj1 come back");
    check(await waitFor(p, "fake push /fcm/send/dj1-phone [vapid ok ttl=86400]: dj2 | hey @dj1 come back | badge=1"), "a mention reaches the phone, signed, with the unread count");
    await sleep(500);
    st = await get("/");
    check(!st.pushSubs.dj1.ipad_dj1 && /removed a device of dj1 that unsubscribed \(HTTP 410\)/.test(p.out), "a device the push service says is gone is removed");
    await say("dj1", "@dj2 I'm here");
    await say("dj1", "@far you there?");
    await sleep(1500);
    check(!/fake push \/fcm\/send\/dj2-phone/.test(p.out), "nobody is pushed while they're looking at the room");
    check(/fake push \/far-iphone .*: dj1 \| @far you there\?/.test(p.out), "someone offline gets it");
    await say("boss", "@everyone party time");
    check(await waitFor(p, "fake push /fcm/send/dj1-phone [vapid ok ttl=3600]: boss → everyone | @everyone party time"), "@everyone from a mod reaches devices that opted in");
    await sleep(1000);
    check(!/far-iphone .*everyone/.test(p.out), "@everyone skips devices that didn't opt in and people who blocked the sender");
    await say("dj2", "!pushtest");
    check(await waitFor(p, "fake push /fcm/send/dj2-phone [vapid ok ttl=300]: Push notifications are on"), "!pushtest reaches your devices even while you're in the room");
    await sleep(1000);
    check(said(await get("/")).some((t) => /dj2, sent a test notification to 1 device\./.test(t)), "and the bot says how many");
    check(!/VAPID WRONG/.test(p.out), "every push carries a valid VAPID token for its push service");
    await healthy(p);
    p.kill();
    await sleep(400);
    const again = startBot("push", { PUSH_UA_KEY: ua.getPrivateKey().toString("base64url"), PUSH_AUTH: auth });
    check(await waitFor(again, "push: on (keys from the database"), "a restart keeps the same keys");
    check((await get("/pushKey")) === st.pushKey, "the published key stays the same");
    return again;
  },
  async swap_suggestions() {
    const flagged = (cid, name, code) => ({ type: 1, cid, name, flagged: { date: 1, code } });
    await put("/", base({
      queues: { dj1: { k1: yt("dead1", "Radiohead - Karma Police (HD)"), k2: yt("yt1") }, dj2: { s1: yt("yt2") } },
      playlists: { dj2: { pl1: { name: "Faves", list: {
        a: flagged("gone0000001", "Daft Punk - One More Time [Official Video]", 2),
        b: flagged("offtheme001", "Daft Punk - One More Time", 10),
        c: flagged("nomatch0001", "Nobody - Nothing At All", 2)
      } } } }
    }));
    const p = startBot("swaps");
    // the bot flags dead1 while playing and looks it up straight away
    check(await waitFor(p, 'fake youtube music: search "Radiohead Karma Police" (songs)'), "a track flagged while playing is searched on YouTube Music right away");
    await sleep(1500);
    let st = await get("/");
    const k = Object.values(st.queues.dj1).find((t) => t.cid === "dead1");
    check(k && k.flagged && k.swap && k.swap.cid === "kpstudio001" && k.swap.album === "OK Computer",
      "its swap is the audio track that can play (not the video, not the one that can't be embedded)");
    // a mod starts the nightly run by hand
    // (its own summary: the flagged-track lookup above logged one already;
    // searches share one pace with that lookup, 2.5 s apart)
    const runsBefore = (p.out.match(/swaps: \d+ flagged tracks? in /g) || []).length;
    await say("boss", "!swapscan");
    let scanned = false;
    for (let i = 0; i < 200 && !scanned; i++) { scanned = (p.out.match(/swaps: \d+ flagged tracks? in /g) || []).length > runsBefore; if (!scanned) await sleep(100); }
    check(scanned, "!swapscan runs the search");
    await sleep(800);
    st = await get("/");
    const list = st.playlists.dj2.pl1.list;
    check(list.a.swap && list.a.swap.cid === "omtstudio01", "a broken track in a playlist gets its swap");
    check(!list.b.swap && !list.c.swap, "off-theme tracks and songs with no match get none");
    check(!/search "Radiohead Karma Police"[^\n]*\n[\s\S]*search "Radiohead Karma Police"/.test(p.out), "a track that already has a swap isn't searched again");
    check(Object.keys(st.swapCache || {}).length >= 2, "searches are remembered in swapCache");
    const told = Object.values((st.notices || {}).dj2 || {});
    check(told.length === 1 && told[0].kind === "swap" && /working copy on YouTube Music/.test(told[0].txt), "the playlist's owner gets one notice");
    await say("dj1", "!swaps");
    await sleep(800);
    check(said(await get("/")).some((t) => /^Swaps \(nightly at 4:00\): .*new swap/.test(t)), "!swaps says how the last run went");
    await healthy(p);
    return p;
  },
  async youtube_music_sync() {
    const k = (n) => "-NA0000000000000000" + n; // push keys from 2023, in order
    await put("/", base({
      playlists: { [BOT]: {
        other: { name: "Crate", list: { x: yt("nogo_other1", "Left - Alone") } },
        ytm: { name: "YOUTUBE MUSIC", list: {
          [k(1)]: yt("nogo0000001", "Daft Punk - One More Time"), // gone: replaced
          [k(2)]: { type: 1, cid: "nogo0000002", name: "Some Band - Off Theme", flagged: { date: 1, code: 10 } }, // someone's flag: left alone
          [k(3)]: yt("chromeo0001", "Chromeo - 100%"),
          [k(4)]: yt("chromeo0002", "Chromeo - 100%"), // the same song again, a second longer: goes
          [k(5)]: yt("lose0000001", "Lose Control"), // saved by title only
          [k(6)]: yt("nogo0000003", "Nobody - Nothing At All"), // gone, no copy: flagged, kept
          [k(7)]: yt("mvideo00001", "Radiohead - Karma Police (Official Video)") // a music video: its audio track instead
        } }
      } }
    }));
    const p = startBot("ytm", { YTMUSIC_SYNC: "true", YTMUSIC_SOURCES: "2001=https://music.youtube.com/playlist?list=PLfakeyear2001&si=x, 2002=PLfakeyear2002, 2003=PLfakemissing1" });
    // the first look after a start: it has never synced, so it syncs now
    check(await waitFor(p, "youtube music: ", 30000), "the first sync starts on its own after a start");
    check(await waitFor(p, "YouTube API unit", 30000), "and finishes");
    await sleep(500);
    let st = await get("/");
    const list = st.playlists[BOT].ytm.list;
    const byCid = Object.fromEntries(Object.values(list).map((t) => [t.cid, t]));
    check(byCid.omtstudio01 && byCid.omtstudio01.name === "Daft Punk - One More Time" && !byCid.omtstudio01.flagged &&
      byCid.omtstudio01.swappedFrom && byCid.omtstudio01.swappedFrom.cid === "nogo0000001", "a broken track is replaced with its YouTube Music copy");
    check(byCid.nogo0000002 && byCid.nogo0000002.flagged.code === 10, "a track someone flagged stays as it was");
    check(byCid.nogo0000003 && byCid.nogo0000003.flagged && byCid.nogo0000003.flagged.code === 2, "a broken track with no match stays, flagged");
    check(byCid.chromeo0001 && !byCid.chromeo0002, "a duplicate goes; the earliest copy stays");
    check(byCid.newsong0001 && byCid.newsong0001.name === "New Band - New Song" && byCid.newsong0001.duration === 210, "a new song from a year playlist is added");
    check(!byCid.mixedsong01, "a DJ-mixed compilation track isn't added");
    check(byCid.lose0000001 && byCid.lose0000001.name === "Young Franco - Lose Control", "a title-only track gets its artist");
    check(!byCid.mvideo00001 && byCid.kpstudio001 && byCid.kpstudio001.name === "Radiohead - Karma Police" &&
      byCid.kpstudio001.swappedFrom.cid === "mvideo00001", "a music video is swapped for its YouTube Music audio track");
    check(Object.keys(list).length === 7 && Object.values(list).every((t) => t.added > 0), "7 tracks, each knows when it joined");
    const other = st.playlists[BOT].other;
    check(other.name === "Crate" && JSON.stringify(other.list) === JSON.stringify({ x: { cid: "nogo_other1", name: "Left - Alone", type: 1 } }), "the bot's other playlists aren't touched");
    check(st.ytmSync && st.ytmSync.ok === true && st.ytmSync.at > 0, "the sync is remembered in the database");
    check(/couldn't read the 2003 playlist PLfakemissing1/.test(p.out), "a playlist that can't be read is skipped and logged");
    // chat: anyone can ask how it went; only mods start one
    await say("dj1", "!ytmusic");
    await say("dj1", "!ytsync");
    await sleep(1200);
    st = await get("/");
    check(said(st).some((t) => /^YOUTUBE MUSIC \(daily at 5:00\): 1 broken track replaced, 1 still broken\b.*\b7 tracks\./.test(t) && t.length <= 240), "!ytmusic says how the last sync went, in one chat line");
    check(said(st).some((t) => /^Only mods can start a sync/.test(t)), "!ytsync is for mods");
    const syncs = () => (p.out.match(/youtube music: \d+ tracks checked[^\n]*/g) || []);
    await say("boss", "!ytsync");
    check(await waitFor(p, "Syncing my YOUTUBE MUSIC playlist"), "a mod's !ytsync starts one");
    for (let i = 0; i < 150 && syncs().length < 2; i++) await sleep(100);
    check(syncs().length === 2 && /0 broken tracks replaced, 1 with no match yet \(kept\); 0 new songs from 2 year playlists \(1 DJ-mixed skipped\); 0 duplicates removed; shuffled 7/.test(syncs()[1]),
      "a second sync adds nothing and shuffles again");
    // a restart soon after doesn't sync again
    p.kill();
    await sleep(400);
    const again = startBot("ytm", { YTMUSIC_SYNC: "true", YTMUSIC_SOURCES: "PLfakeyear2001" });
    await sleep(15000);
    check(!/youtube music: \d/.test(again.out), "a restart within a day doesn't sync again");
    await healthy(again);
    return again;
  },
  async discover() {
    // the song on the decks when the bot starts has ended: its play is logged
    await put("/", base({ queues: { dj1: { k1: yt("yt1") }, dj2: { s1: yt("yt2") } },
      users: Object.assign(base({}).users, { quiet: { username: "quiet", status: true, publicName: false } }) }));
    const p = startBot("discover", { YTMUSIC_SOURCES: "2026=PLfakeyear2001" });
    check(await waitFor(p, "Listening now."), "bot says Listening now.");
    await say("dj1", "this one is great");
    await say("quiet", "hello from someone private");
    await say("dj1", "!plays");
    await sleep(12000);
    const st = await get("/");
    const week = Object.values((st.discover && st.discover.charts && st.discover.charts.week) || {}).find((c) => !c.final) || {};
    check((week.rows || []).some((r) => r.cid === "old" && r.plays === 1 && r.dj === "dj2"), "the week's chart counts the play that just ended");
    check(st.discover && st.discover.chartIds && st.discover.chartIds.week && Object.keys(st.discover.chartIds.week).length >= 2, "last week's chart is finished off too");
    const msgs = (st.discover && st.discover.chat && st.discover.chat.msgs) || [];
    check(msgs.some((m) => m.txt === "this one is great" && m.n === "dj1"), "the chat peek shows messages with names");
    check(msgs.some((m) => m.txt === "hello from someone private" && !m.n && !m.uid), "someone who turned off their public name shows as nobody");
    check(!msgs.some((m) => /^!/.test(m.txt)), "bot commands stay out of the chat peek");
    check(st.discover && st.discover.new && Array.isArray(st.discover.new.tracks || []), "new releases are published");
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
