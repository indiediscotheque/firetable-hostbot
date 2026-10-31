// The tag engine (lib/tags.js) and the play history toolkit (tools/history)
// on small made-up exports shaped like the real ones. No emulators needed:
//   cd test && npm run test:history
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const require = createRequire(import.meta.url);
const tags = require("../lib/tags.js");
const ROOT = new URL("..", import.meta.url).pathname;
const FIX = new URL("./fixtures/history/", import.meta.url).pathname;
const key = (a, t) => tags.trackKey(a, t);

test("the same recording, however it was tagged, has one key", () => {
  const same = [
    ["Foals", "My Number"], ["FOALS", "My Number"], ["Foals", "My Number - Radio Edit"], ["Foals", "My Number (Official Video)"],
    ["Foals", "My Number [HD]"], ["Foals - Topic", "My Number"], ["FoalsVEVO", "My Number (2013 Remaster)"], ["Unknown", "Foals - My Number"],
    ["Foals", "My Number | Warner Records"], ["Foals", "My Number (feat. Nobody)"], ["Foals", "My  Number "], ["Foals", "My Number (Extended Mix)"]
  ];
  for (const [a, t] of same) assert.equal(key(a, t), "foals|mynumber|", a + " - " + t);
});

test("versions that sound different stay apart; the song key still joins them", () => {
  assert.notEqual(key("Foals", "My Number (Lemaitre Remix)"), key("Foals", "My Number"));
  assert.notEqual(key("Foals", "My Number - Live at KEXP"), key("Foals", "My Number"));
  assert.notEqual(key("Foals", "My Number (Acoustic)"), key("Foals", "My Number"));
  assert.equal(key("Foals", "My Number (Lemaitre Remix)"), key("Foals", "My Number [Lemaitre Remix] (Official Audio)"));
  assert.equal(tags.songKey("Foals", "My Number (Lemaitre Remix)"), tags.songKey("Foals", "My Number"));
  assert.notEqual(key("Artist", "Song Part 1"), key("Artist", "Song Part 2"));
});

test("artists: order, &/and, accents and case don't matter; 'The X' and 'X' are different artists", () => {
  assert.equal(key("Simon & Garfunkel", "The Boxer"), key("Simon and Garfunkel", "The Boxer"));
  assert.notEqual(key("The Rolling Stones", "Angie"), key("Rolling Stones", "Angie"));
  assert.equal(key("Beatles, The", "Help!"), key("The Beatles", "Help!"));
  assert.equal(key("Beyoncé", "Halo"), key("BEYONCE", "Halo"));
  assert.equal(key("Sigur Rós", "Hoppípolla"), key("Sigur Ros", "Hoppipolla"));
  assert.equal(key("Mura Masa x Charli XCX", "1 Night"), key("Charli XCX & Mura Masa", "1 Night"));
});

test("Rohn Standard Notation is suggested, never forced", () => {
  const f = (a, t) => tags.format(tags.parse(a, t));
  assert.equal(f("Calvin Harris", "One Kiss (feat. Dua Lipa) [Official Video]"), "Calvin Harris - One Kiss feat. Dua Lipa");
  assert.equal(f("ODESZA", "Say My Name (feat. Zyra) [RL Grime Edit]"), "ODESZA - Say My Name feat. Zyra (RL Grime Edit)");
  assert.equal(f("Daft Punk ft. Pharrell Williams", "Get Lucky - Live at the Grammys"), "Daft Punk - Get Lucky feat. Pharrell Williams (Live at the Grammys)");
  assert.equal(f("Rolling Stones", "(I Can't Get No) Satisfaction"), "Rolling Stones - (I Can't Get No) Satisfaction");
  assert.ok(tags.quality("Foals", "My Number") > tags.quality("FOALS", "MY NUMBER (OFFICIAL VIDEO)"));
});

test("titles Google Sheets damaged are flagged with what they probably were", () => {
  const p = tags.parse("Bear Hands", "2:00 AM");
  assert.equal(p.suspect, "time");
  assert.ok(p.altTitles.map(tags.titleKeyOf).includes("2am"));
  assert.equal(tags.parse("Lemaitre", "1:18").suspect, null); // a real title
});

test("vague tags are never matched across uploads", () => {
  assert.ok(tags.parse("Unknown", "Intro").weak);
  assert.ok(tags.parse("Various Artists", "Track 3").weak);
  assert.ok(!tags.parse("Foals", "Inhaler").weak);
});

test("hash is short, stable and safe as a database key", () => {
  const h = tags.hash("foals|mynumber|");
  assert.equal(h, tags.hash("foals|mynumber|"));
  assert.match(h, /^[A-Za-z0-9_-]{16}$/);
});

test("toolkit: ADAM + Last.fm + Firebase become one history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    run("import-adam", FIX + "adam-trax.csv");
    run("import-lastfm", FIX + "lastfm.csv", "--user", "room");
    run("import-firebase", FIX + "firebase.json");
    run("reconcile");
    run("report");
    const foals = run("lookup", "Foals - My Number");
    assert.match(foals, /track t\S+: Foals - My Number\n/);
    assert.match(foals, /5 plays \(3 on Last\.fm\), 3 DJs, 2 uploads, 4 spellings/);
    assert.match(foals, /first: 2017-03-04 18:00 by girlkris/, "true first play comes from ADAM, not the 2023 upload");
    assert.match(foals, /all 2 versions: 6 plays/);
    assert.match(run("lookup", "Bear Hands - 2AM"), /2 spellings/, "the Sheets-damaged '2:00 AM' joined '2AM'");
    assert.match(run("lookup", "Calvin Harris & Dua Lipa - One Kiss"), /3 spellings/, "feat. and & spellings joined");
    // "Sigur Rós" is in 3 logs (ADAM, a playlist), but an artist's name changes
    // on all their songs only as YouTube Music writes it: until it's looked up,
    // it stays, and the artist is listed for check-artists
    assert.match(run("lookup", "Sigur Ros - Hoppipolla"), /track \S+: Sigur Ros - Hoppipolla\n/, "not checked on YouTube Music yet: left as it is");
    assert.match(readFileSync(join(dir, "artist_accents.csv"), "utf8"), /Sigur Ros,Sigur Rós \(\d+ logs\),,left as it is until YouTube Music is checked,Sigur Ros/);
    {
      const store = require("../tools/history/store.js");
      const db = store.open(dir);
      const wanted = store.getState(db, "ytm_wanted");
      assert.ok(wanted.some((w) => w.key === "sigurros" && w.song === "Hoppipolla"), "check-artists would search for its most played song");
      // what check-artists found: the "Sigur Rós - Topic" channel
      db.prepare("INSERT INTO lookups (kind, query, result, fetched_at) VALUES ('ytm', 'sigurros', ?, 1)").run(JSON.stringify({ names: ["Sigur Rós"] }));
      db.close();
    }
    run("reconcile");
    run("report");
    // "Hoppípolla" is in only 1 log (one playlist entry): not enough, the title stays as it is
    assert.match(run("lookup", "Sigur Ros - Hoppipolla"), /track \S+: Sigur Rós - Hoppipolla\n/, "YouTube Music writes it 'Sigur Rós': restored; a single log isn't enough for the title");
    assert.match(readFileSync(join(dir, "restore_accents.csv"), "utf8"), /Sigur Ros - Hoppipolla,Sigur Rós - Hoppipolla,/);
    assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /\| plays \| 19 /);

    run("publish", "--restore-accents");
    const preview = JSON.parse(readFileSync(join(dir, "publish-preview.json"), "utf8"));
    assert.equal(preview.counts.accents, 1);
    assert.equal(preview.counts.retags, 0, "no tag is rewritten without --retag");
    assert.equal(preview.counts.checks, "passed");
    assert.ok(preview.sample.some(([p, v]) => /^globalSongKeys\//.test(p) && /^t/.test(v)));

    // the safety checks: a history with fewer tracks or plays than the one
    // already published is refused
    const store = require("../tools/history/store.js");
    const { publish } = require("../tools/history/publish.js");
    const db = store.open(dir);
    const quiet = () => {};
    const worse = await publish(db, {}, { dir, previous: { tracks: 1000, plays: 99999 } }, quiet);
    assert.ok(worse.checks.some((p) => /tracks fell/.test(p)) && worse.checks.some((p) => /plays fell/.test(p)), "a worse history fails the checks");
    const same = await publish(db, {}, { dir, previous: { tracks: 8, plays: 18 } }, quiet); // "Unknown - Intro" is too vague to publish
    assert.equal(same.checks, "passed");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toolkit: YouTube/SoundCloud answers add evidence, catch dead uploads and link by ISRC", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH } });
  try {
    run("import-firebase", FIX + "firebase.json");
    const store = require("../tools/history/store.js");
    const db = store.open(dir);
    const save = db.prepare("INSERT INTO lookups (kind, query, result, fetched_at) VALUES (?, ?, ?, ?)");
    // what the platforms would answer (stored, so nothing is fetched)
    save.run("yt", "aaaaaaaaaaa", JSON.stringify({ title: "My Number", channel: "Foals - Topic", dur: 245 }), Date.now());
    save.run("yt", "bbbbbbbbbbb", JSON.stringify({ dead: true }), Date.now());
    save.run("yt", "ccccccccccc", JSON.stringify({ title: "Tame Impala - The Less I Know The Better (Official Audio)", channel: "Tame Impala", dur: 216 }), Date.now());
    save.run("yt", "ddddddddddd", JSON.stringify({ title: "Calvin Harris, Dua Lipa - One Kiss (Official Video)", channel: "Calvin Harris", dur: 214 }), Date.now());
    save.run("sc", "123456", JSON.stringify({ title: "Hoppípolla", user: "sigurros", artist: "Sigur Rós", release: "Hoppípolla", isrc: "GBAYE0500001" }), Date.now());
    db.close();
    const out = run("verify-uploads");
    assert.match(out, /checked 0 YouTube and 0 SoundCloud uploads/, "answers already known aren't asked again");
    run("reconcile");
    run("report");
    const dead = readFileSync(join(dir, "dead_uploads.csv"), "utf8");
    assert.match(dead, /https:\/\/youtu\.be\/bbbbbbbbbbb,Foals - My Number,\d+,https:\/\/youtu\.be\/aaaaaaaaaaa/, "a dead upload comes with a working copy of the same track");
    assert.match(run("lookup", "Foals - My Number"), /yt:topic/, "YouTube's Topic channel counts as a spelling");
    assert.match(run("lookup", "Sigur Ros - Hoppipolla"), /Sigur Rós - Hoppípolla/, "SoundCloud's own artist/title restores accents too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tidy never loses what a tag says about the song: only upload junk goes, RSN only moves feat. and brackets", () => {
  const rsn = (a, t) => { const r = tags.tidy(a, t, "rsn", { titleCase: false }); return r.artist + " - " + r.title; };
  const junk = (a, t) => { const r = tags.tidy(a, t, "junk"); return r.artist + " - " + r.title; };
  // laid out
  assert.equal(rsn("Steve Angello", "Remember (feat. The Presets)"), "Steve Angello - Remember feat. The Presets");
  assert.equal(rsn("Kris Menace feat. Black Hills", "Waiting For You (Oliver Remix)"), "Kris Menace - Waiting For You feat. Black Hills (Oliver Remix)");
  assert.equal(rsn("RAC", "Hollywood (feat. Penguin Prison) (Felix Da Housecat Remix)"), "RAC - Hollywood feat. Penguin Prison (Felix Da Housecat Remix)");
  assert.equal(rsn("Analog People In a Digital World", "Liar - Guys In Venice Remix"), "Analog People In a Digital World - Liar (Guys In Venice Remix)");
  assert.equal(rsn("Gramatik", "Corporate Demons Feat. Luxas"), "Gramatik - Corporate Demons feat. Luxas");
  assert.equal(rsn("Grum", "Heartbeats [Worship Remix]"), "Grum - Heartbeats (Worship Remix)");
  assert.equal(rsn("N.A.S.A.", "Gifted (Aston Shuffle Remix feat. Kanye West, Santigold & Lykke Li) (Bonus Track)"),
    "N.A.S.A. - Gifted (Aston Shuffle Remix feat. Kanye West, Santigold & Lykke Li) (Bonus Track)", "a credit inside a version's brackets stays there");
  assert.equal(rsn("Major Lazer feat. Amber (of Dirty Projectors)", "Get Free"), "Major Lazer - Get Free feat. Amber (of Dirty Projectors)");
  assert.equal(rsn("September 87", "Bad Dream Baby feat. Dream Fiend (Dream Fiend Cut)"), "September 87 - Bad Dream Baby feat. Dream Fiend (Dream Fiend Cut)");
  assert.equal(junk("MNDR", "#1 in Heaven"), "MNDR - #1 in Heaven", "'#1' is not a hashtag");
  assert.equal(junk("Artist", "Song #tbt #house"), "Artist - Song");
  assert.equal(junk("#Xinobi#", "#Bmx# [#Moullinex remix#]"), "#Xinobi# - #Bmx# [#Moullinex remix#]", "a title written in hashtags stays");
  assert.equal(junk("Miike Snow", "Paddling Out (Jacques Lu Cont Remix (Audio))"), "Miike Snow - Paddling Out (Jacques Lu Cont Remix)");
  assert.equal(junk("Mitch Murder", "Kiesza - Hideaway (Mitch Murder Remix) FREE DOWNLOAD"), "Mitch Murder - Kiesza - Hideaway (Mitch Murder Remix)", "only the junk at the end goes");
  assert.equal(rsn("Can", "Vitamin C (Live - 2004)"), "Can - Vitamin C (Live - 2004)", "a dash inside brackets stays");
  assert.equal(rsn("Can", "Vitamin C (2004 Remaster)"), "Can - Vitamin C", "same-recording notes go: one track holds them all");
  assert.equal(rsn("Bag Raiders", "Shooting Stars (Radio Edit)"), "Bag Raiders - Shooting Stars");
  assert.equal(rsn("Lian Ross", "Fantasy (12\" Version)"), "Lian Ross - Fantasy");
  for (const keep of ["Blood Makes Noise (Remix)", "This Emotion (Rework)", "Time (Vocal Mix)", "Two Of Us (Naked Version / Remastered 2013)", "Song (Club Mix)", "Song (VIP)"])
    assert.equal(rsn("Artist", keep), "Artist - " + keep, "another version keeps its name: " + keep);
  assert.equal(rsn("Foals", "My Number (Lemaitre Remix)"), "Foals - My Number (Lemaitre Remix)", "a remix is its own track and keeps its name");
  assert.equal(rsn("PREMIERE: Interstate", "Get Down [Play Label Records]"), "Interstate - Get Down", "blog premieres and labels are upload junk");
  assert.equal(junk("Lace", "Can't Play Around ( Mark Curse ReEdit )"), "Lace - Can't Play Around (Mark Curse ReEdit)");
  assert.equal(tags.apTitleCase('ACTORS: "In Real Life"'), 'ACTORS: "In Real Life"');
  // upload junk out
  assert.equal(junk("Datarock", "Bulldozer [Official Music Video]"), "Datarock - Bulldozer");
  assert.equal(junk("Oleska", "Road Trip (Original Mix) [OUT NOW ON THE BEARDED MAN]"), "Oleska - Road Trip (Original Mix)");
  assert.equal(junk("Ella Henderson", "Mirror Man (Henry Krinkle Remix) [Thissongissick.com Premiere]"), "Ella Henderson - Mirror Man (Henry Krinkle Remix)");
  // left as typed
  for (const [a, t] of [
    ["Azari & III", "Reckless (With Your Love)"], ["Walker & Royce", "Take Me To Your Leader feat. Dances With White Girls"],
    ["Matthew Dear", "Bad Ones feat. Tegan and Sara"], ["karensyork", "Disclosure | You & Me (Flume Remix)"], ["Flight Facilities", "37,000 ft Mixtape (2013)"],
    ["Willie Hutch", "Brother's Gonna Work It Out (The Mack/Soundtrack Version)"], ["Reva DeVito", "So Bad (Prod. Kaytranada)"],
    ["Black Gold", "C'mon Stop (1983)"], ["Breakbot", "Peanuts (Bonus Track)"], ["SebastiAn", "Embody"], ["A R I Z O N A", "Electric Touch"],
    ["Late Nite Tuff Guy", "Bless The Rains [LNTG Epic Journey]"]
  ]) assert.equal(rsn(a, t), a + " - " + t, a + " - " + t);
  // AP title case (on by default at rsn): English titles only, slips only
  const ap = tags.apTitleCase;
  assert.equal(ap("The Less I Know The Better"), "The Less I Know the Better");
  assert.equal(ap("walking on a dream"), "Walking on a Dream");
  assert.equal(ap("Waiting For You feat. Black Hills (Oliver Remix)"), "Waiting for You feat. Black Hills (Oliver Remix)");
  assert.equal(ap("Hollywood feat. Penguin Prison (felix da housecat remix)"), "Hollywood feat. Penguin Prison (felix da housecat Remix)", "names in parentheses as typed");
  assert.equal(tags.tidy("Flight Facilities", "37,000 ft Mixtape (2013)", "rsn").title, "37,000 ft Mixtape (2013)", "units after numbers as typed");
  for (const keep of ["Comme des enfants", "Je ne regrette rien", "ISLANDS", "iPhone Love", "Where Are Ü Now", "Mr. Brightside", "Dancing in the Moonlight", "2 Hearts"]) assert.equal(ap(keep), keep, keep);
  assert.equal(tags.tidy("Tame Impala", "The Less I Know The Better", "rsn").title, "The Less I Know the Better");
  assert.equal(tags.tidy("Tame Impala", "The Less I Know The Better", "junk").title, "The Less I Know The Better", "junk never changes capitals");
});

test("a mod's fix sets an artist's capitals everywhere, never their accents (those follow YouTube Music)", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    writeFileSync(join(dir, "fb.json"), JSON.stringify({
      globalTracks: {
        "1embody00001": { artist: "Sebastian", title: "Embody (Official Video)", type: 1, first_play_date: 1600000000000 },
        "1totale00001": { artist: "Sebastian", title: "Total (Official Video)", type: 1, first_play_date: 1600000000000 },
        "1joga0000001": { artist: "Björk", title: "Jóga (Official Video)", type: 1, first_play_date: 1600000000000 },
        "1army0000001": { artist: "Bjork", title: "Army of Me", type: 1, first_play_date: 1600000000000 }
      },
      // mods' fixes: one for capitals, one that took the accent out (the old Last.fm bug)
      tagLog: {
        "-t1": { k: "1totale00001", a: "SebastiAn", t: "Total", by: "boss", at: 1715000000000 },
        "-t2": { k: "1army0000001", a: "Bjork", t: "Army of Me", by: "boss", at: 1715000000000 }
      }
    }));
    run("import-firebase", join(dir, "fb.json"));
    run("reconcile");
    run("report");
    let preview = readFileSync(join(dir, "tidy_preview.csv"), "utf8");
    assert.match(preview, /SebastiAn - Embody \(Official Video\),SebastiAn - Embody,/, "the mod's 'SebastiAn' is the artist's one name, on their other songs too");
    assert.match(preview, /Björk - Jóga \(Official Video\),Björk - Jóga,/, "the mod's 'Bjork' doesn't take the accent out (no YouTube Music answer yet)");
    const store = require("../tools/history/store.js");
    const db = store.open(dir);
    db.prepare("INSERT INTO lookups (kind, query, result, fetched_at) VALUES ('ytm', 'bjork', ?, 1)").run(JSON.stringify({ names: ["Björk"] }));
    db.close();
    run("reconcile");
    run("report");
    preview = readFileSync(join(dir, "tidy_preview.csv"), "utf8");
    assert.match(preview, /Björk - Jóga \(Official Video\),Björk - Jóga,/, "with YouTube Music's 'Björk', the accent stays");
    assert.match(run("lookup", "Bjork - Army of Me"), /track \S+: Björk - Army of Me\n/, "and goes back on the song the mod took it off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one artist, one name: YouTube Music's spelling when well attested; it never takes accents off on one upload's word", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH } });
  try {
    const t = (artist, title) => ({ artist, title, type: 1, first_play_date: 1600000000000 });
    writeFileSync(join(dir, "fb.json"), JSON.stringify({ globalTracks: {
      "1lemaitre001": t("Lemâitre", "Cut To Black"), "1lemaitre002": t("Lemâitre", "Coffee Table"), "1lemaitre003": t("lemaitre", "Nishio"),
      "1evora000001": t("Cesária Évora", "Angola"), "1evora000002": t("Cesária Évora", "Sodade"), "1evora000003": t("Cesaria Evora", "Petit Pays")
    } }));
    run("import-firebase", join(dir, "fb.json"));
    const store = require("../tools/history/store.js");
    const db = store.open(dir);
    const yt = db.prepare("INSERT INTO lookups (kind, query, result, fetched_at) VALUES ('yt', ?, ?, 1)");
    // the room's uploads came from these Topic channels: Lemaitre three times, Cesaria Evora once
    yt.run("lemaitre001", JSON.stringify({ title: "Cut To Black", channel: "Lemaitre - Topic" }));
    yt.run("lemaitre002", JSON.stringify({ title: "Coffee Table", channel: "Lemaitre - Topic" }));
    yt.run("lemaitre003", JSON.stringify({ title: "Nishio", channel: "Lemaitre - Topic" }));
    yt.run("evora000003", JSON.stringify({ title: "Petit Pays", channel: "Cesaria Evora - Topic" }));
    db.close();
    run("verify-uploads");
    run("reconcile");
    const look = (q) => run("lookup", q).split("\n").find((l) => /^track /.test(l));
    assert.match(look("Lemaitre - Nishio"), /: Lemaitre - Nishio$/, "YouTube Music on 3 uploads: its spelling, capitals included");
    assert.match(look("Lemaitre - Cut To Black"), /: Lemaitre - Cut To Black$/, "and the room's 'Lemâitre' follows it");
    assert.match(look("Cesaria Evora - Angola"), /: Cesária Évora - Angola$/, "one upload's auto channel doesn't take the accents off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo: a publish backs up every upload tag it changes, and undo-tags puts them back (not over a later fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  const fb = require("../tools/history/firebase.js");
  const realClient = fb.client;
  try {
    const fixture = JSON.parse(readFileSync(FIX + "firebase-tidy.json", "utf8"));
    run("import-firebase", FIX + "firebase-tidy.json");
    run("reconcile");
    // the room's database, in memory
    const root = { globalTracks: JSON.parse(JSON.stringify(fixture.globalTracks)) };
    const at = (p) => p.split("/").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), root);
    const put = (p, v) => {
      const ks = p.split("/").filter(Boolean);
      let o = root;
      ks.slice(0, -1).forEach((k) => { o = o[k] = o[k] && typeof o[k] === "object" ? o[k] : {}; });
      if (v === null) delete o[ks[ks.length - 1]];
      else o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v, (k, x) => (x && x[".sv"] ? Date.now() : x)));
    };
    fb.client = () => ({
      get: async (p) => JSON.parse(JSON.stringify(at(p) ?? null)),
      getPaged: async (p, size, onPage) => onPage(JSON.parse(JSON.stringify(at(p) || {}))),
      update: async (u) => Object.entries(u).forEach(([p, v]) => put(p, v)),
      uid: async () => "bot"
    });
    const store = require("../tools/history/store.js");
    const { publish, undoTags } = require("../tools/history/publish.js");
    const db = store.open(dir);
    const quiet = () => {};
    await publish(db, {}, { dir, write: true, tidy: "junk", restoreAccents: true }, quiet);
    db.close();
    assert.equal(root.globalTracks["1eeeeeeeeee"].artist, "Tame Impala", "the publish tidied the upload's tags");
    const runs = Object.keys(root.historyArchive.tagBackupRuns);
    assert.equal(runs.length, 1);
    assert.equal(root.historyArchive.tagBackups[runs[0]]["1eeeeeeeeee"].a, "TameImpalaVEVO", "and kept them as they were");
    // a mod retags another changed upload afterwards
    root.globalTracks["1ggggggggggg"].title = "Get Lucky (fixed by a mod)";
    const r = await undoTags({}, { write: true }, quiet);
    assert.equal(root.globalTracks["1eeeeeeeeee"].artist, "TameImpalaVEVO", "undo puts the old tags back");
    assert.equal(root.globalTracks["1eeeeeeeeee"].title, "Feels Like We Only Go Backwards (Official Video) HD");
    assert.equal(root.globalTracks["1ggggggggggg"].title, "Get Lucky (fixed by a mod)", "a fix made since is left alone");
    assert.ok(r.restored >= 1 && r.kept === 1);
  } finally {
    fb.client = realClient;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tidy: junk out, RSN layout opt-in, one artist spelling, a mod's fix and exceptions left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    writeFileSync(join(dir, "tag-exceptions.csv"), "!!!\n");
    run("import-firebase", FIX + "firebase-tidy.json");
    run("reconcile");
    run("report");
    const csvText = readFileSync(join(dir, "tidy_preview.csv"), "utf8");
    assert.match(csvText, /Tame Impala - Feels Like We Only Go Backwards \(Official Video\) HD,Tame Impala - Feels Like We Only Go Backwards,/,
      "junk out, and the artist shown with their one name ('TameImpalaVEVO' is 'Tame Impala')");
    assert.match(csvText, /Daft Punk ft\. Pharrell Williams - Get Lucky \| Columbia Records,Daft Punk ft\. Pharrell Williams - Get Lucky,Daft Punk - Get Lucky feat\. Pharrell Williams,/,
      "junk keeps 'ft.' as typed; rsn lays it out");
    assert.match(csvText, /ODESZA - Say My Name ft\. Zyra \[RL Grime Edit\],.*yes \(a mod's fix/, "a logged mod fix is left alone");
    assert.match(csvText, /!!! - One Girl \/ One Boy \(Official Video\),.*yes/, "tag-exceptions.csv is respected");

    run("publish", "--tidy", "junk");
    let preview = JSON.parse(readFileSync(join(dir, "publish-preview.json"), "utf8"));
    const changed = (p) => preview.tagChanges.find((c) => c.upload === p);
    assert.equal(changed("1eeeeeeeeee").to, "Tame Impala - Feels Like We Only Go Backwards");
    assert.equal(changed("1ggggggggggg").to, "Daft Punk ft. Pharrell Williams - Get Lucky");
    assert.ok(!changed("1fffffffffff") && !changed("1hhhhhhhhhhh") && !changed("1ccccccccccc"), "fixed, excepted and clean tags untouched");
    run("publish", "--tidy", "rsn");
    preview = JSON.parse(readFileSync(join(dir, "publish-preview.json"), "utf8"));
    assert.equal(changed("1ggggggggggg").to, "Daft Punk - Get Lucky feat. Pharrell Williams");
    assert.ok(!changed("1fffffffffff"), "a mod's fix stays even with rsn");
    run("publish");
    preview = JSON.parse(readFileSync(join(dir, "publish-preview.json"), "utf8"));
    assert.equal(preview.tagChanges.length, 0, "without --tidy nothing is tidied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accents: decoration (♫, block letters, emoji), other scripts and one upload's data are never put back on an artist's songs", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH } });
  try {
    const t = (artist, cid) => ({ artist, title: "Someday", type: 1, first_play_date: 1600000000000 });
    writeFileSync(join(dir, "fb.json"), JSON.stringify({ globalTracks: {
      "1someday0001": t("Two Door Cinema Club"), "1someday0002": t("Two Door Cinema Club"), "1someday0003": t("Two Door Cinema Club"),
      "1someday0004": t("♫ Two Door Cinema Club"), "1someday0005": t("♫ Two Door Cinema Club"),
      "1someday0006": t("█▬█ █ ▀█▀ Two Door Cinema Club"), "1someday0007": t("█▬█ █ ▀█▀ Two Door Cinema Club"),
      "1friends0001": { artist: "Friends", title: "I'm His Girl", type: 1 }, "1friends0002": { artist: "Friends諝", title: "I'm His Girl", type: 1 },
      "1friends0003": { artist: "Friends諝", title: "I'm His Girl", type: 1 }, "1friends0004": { artist: "Friends", title: "I'm His Girl", type: 1 },
      "1friends0005": { artist: "Friends", title: "I'm His Girl", type: 1 },
      "1sigurros001": { artist: "Sigur Ros", title: "Hoppipolla", type: 1 }, "1sigurros002": { artist: "Sigur Rós", title: "Hoppipolla", type: 1 },
      "1sigurros003": { artist: "Sigur Rós", title: "Hoppipolla", type: 1 },
      // the room's Marina, and an upload SoundCloud says is by "Márina" (another artist)
      "1marina00001": { artist: "Marina", title: "Primadonna", type: 1 }, "1marina00002": { artist: "Marina", title: "Primadonna", type: 1 },
      "2300259189": { artist: "Marina", title: "Around", type: 2 }
    } }));
    run("import-firebase", join(dir, "fb.json"));
    const store = require("../tools/history/store.js");
    const db = store.open(dir);
    db.prepare("INSERT INTO lookups (kind, query, result, fetched_at) VALUES ('sc', '300259189', ?, 1)").run(JSON.stringify({ title: "Around", user: "marina", artist: "Márina", release: "Around" }));
    db.close();
    run("verify-uploads");
    run("reconcile");
    assert.match(run("lookup", "Marina - Primadonna"), /track \S+: Marina - Primadonna\n/, "one upload's SoundCloud data doesn't respell the artist everywhere");
    assert.match(run("lookup", "Marina - Around"), /track \S+: Márina - Around\n/, "only on its own track");
    assert.match(run("lookup", "Two Door Cinema Club - Someday"), /track \S+: Two Door Cinema Club - Someday\n/, "the plain name stays");
    assert.match(run("lookup", "Friends - I'm His Girl"), /track \S+: Friends - I'm His Girl\n/, "letters of another script aren't accents");
    assert.match(run("lookup", "Sigur Ros - Hoppipolla"), /track \S+: Sigur Rós - Hoppipolla\n/, "a real accent is still put back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accents: restored when enough logs (or a trusted source) have them, word by word across an artist's songs", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH } });
  try {
    run("import-firebase", FIX + "firebase-accents.json");
    const store = require("../tools/history/store.js");
    const db = store.open(dir);
    // SoundCloud's own artist/title for one upload: a trusted source, once is enough
    db.prepare("INSERT INTO lookups (kind, query, result, fetched_at) VALUES ('sc', '777', ?, 1)").run(JSON.stringify({ title: "Sæglópur", artist: "Sigur Rós", release: "Sæglópur" }));
    db.close();
    run("verify-uploads");
    run("reconcile");
    const look = (q) => run("lookup", q).split("\n").find((l) => /^track /.test(l));
    // an artist's name changes on all their songs only as YouTube Music writes it
    assert.match(look("Bjork - Hyperballad"), /: Bjork - Hyperballad$/, "one artist, one name ('Bjrk' is 'Bjork'); accents wait for YouTube Music");
    assert.match(look("Sigur Ros - Saeglopur"), /: Sigur Rós - Sæglópur$/, "an upload's own SoundCloud tags still put the accents on its own track");
    const db2 = store.open(dir);
    const ytm = db2.prepare("INSERT INTO lookups (kind, query, result, fetched_at) VALUES ('ytm', ?, ?, 1)");
    ytm.run("bjork", JSON.stringify({ names: ["Björk"] })); // what check-artists found: "Björk - Topic"
    ytm.run("dram", JSON.stringify({ names: ["DRÄM"] }));
    ytm.run("foals", JSON.stringify({ names: ["Foals"] }));
    db2.close();
    run("reconcile");
    assert.match(look("Bjork - Joga"), /: Björk - Jóga$/, "two playlists write it with accents: restored");
    assert.match(look("Bjork - Joga (Live)"), /: Björk - Jóga \(Live\)$/, "'Bj?rk' and the live version's title restored from the artist's other songs");
    assert.match(look("Bjork - Hyperballad"), /: Björk - Hyperballad$/, "'Bjrk' (letter dropped) restored");
    assert.match(look("Foals - My Number"), /: Foals - My Number$/, "one odd spelling ('Nümber') isn't enough");
    run("report");
    assert.match(readFileSync(join(dir, "artist_accents.csv"), "utf8"), /Bjork,Björk \(\d+ logs\),Björk \(1\),accents from YouTube Music,Björk/);
    assert.match(look("Gorillaz - Andromeda"), /: Gorillaz - Andromeda feat\. DRÄM$/, "a featured artist's name restored too");
    assert.match(look("Sigur Ros - Saeglopur"), /: Sigur Rós - Sæglópur$/, "SoundCloud's own tags: trusted, restored from one log");
    run("report");
    const why = readFileSync(join(dir, "restore_accents.csv"), "utf8");
    assert.match(why, /Bj\?rk - Joga \(Live\),Björk - Jóga \(Live\),.*Joga→Jóga \(2 logs\)/, "the report says why");
    run("reconcile", "--accent-min", "3");
    assert.match(look("Bjork - Joga"), /: Björk - Joga$/, "--accent-min 3: 'Björk' (YouTube Music) stays, 'Jóga' in 2 logs doesn't");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("'The X' and 'X': different artists, but the same track when the title matches, shown under the more used name", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    const entry = (name, cid) => ({ name, type: 1, cid });
    writeFileSync(join(dir, "fb.json"), JSON.stringify({
      globalTracks: {
        "1naive000001": { artist: "Kooks", title: "Naive", first_play_date: 1700000000000, first_play_dj: "ana", type: 1 },
        "1naive000002": { artist: "The Kooks", title: "Naive", first_play_date: 1600000000000, first_play_dj: "ben", type: 1 },
        "1intro000001": { artist: "The Kills", title: "Intro", first_play_date: 1600000000000, type: 1 },
        "1intro000002": { artist: "Kills", title: "Intro", first_play_date: 1600000000000, type: 1 }
      },
      playlists: { u: { p: { name: "x", list: {
        a: entry("The Kooks - Ooh La", "oohla0000001"), b: entry("The Kooks - She Moved In", "moved0000001"), c: entry("The Kooks - Naive", "naive000002")
      } } } }
    }));
    run("import-firebase", join(dir, "fb.json"));
    run("reconcile");
    const naive = run("lookup", "Kooks - Naive");
    assert.match(naive, /: The Kooks - Naive\n/, "'The Kooks' is used more, so it's the name shown");
    assert.match(naive, /2 uploads/, "both uploads are one track");
    assert.match(naive, /first: 2020-09-13 .* by ben/, "with the true first play");
    assert.match(run("lookup", "The Kills - Intro"), /1 uploads/, "a vague title never joins them");
    assert.notEqual(tags.trackKey("The Kooks", "Ooh La"), tags.trackKey("Kooks", "Ooh La"), "otherwise they stay different artists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADAM's history as moved into Firebase: ids, text dates and raw tags are read, and joined to the bot's uploads", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    const out = run("import-firebase", FIX + "firebase-adam.json");
    assert.match(out, /globalTracks: 4 entries; keys: .*number×2.*; fields: .*first_play_date:date-text/, "the layout is described");
    run("reconcile", "--adam-tz", "0");
    const lem = run("lookup", "Lemaitre - 1:18");
    assert.match(lem, /first: 2016-12-11 00:45 by robsclone/, "ADAM's first play, its DJ found by id");
    assert.match(lem, /last: {2}2023-11-14 .* by eve/, "the bot's later play is the last one");
    assert.match(lem, /1 uploads/, "ADAM's raw tag linked the track to the bot's upload by its link");
    const bear = run("lookup", "Bear Hands - 2AM");
    assert.match(bear, /first: 2016-08-23 21:52 by understater/, "artist and DJ ids resolved, the Sheets-style '2:00 AM' joined");
    assert.match(bear, /1 uploads/, "'2123456789' is a SoundCloud upload, '8817' is an ADAM id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// How the live database holds it: the 2023 "global tag system" folded ADAM's
// first and last plays into the bot's own globalTracks entries ("type + upload
// id" keys, times in ms, DJs by name or now and then by uid).
test("who is who: an account's claimed names are one DJ, shown as the name played most; aliases join, '=' pins", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    const t = (n, first, last) => ({ artist: "Act " + n, title: "Song " + n, type: 1, first_play_date: 1500000000000 + n * 1e9, first_play_dj: first, last_play_date: 1600000000000 + n * 1e9, last_play_dj: last });
    writeFileSync(join(dir, "fb.json"), JSON.stringify({
      users: { uidRob00000000000000000001: { username: "rob" }, uidSnips000000000000000001: { username: "pinksnips" }, uidMatt0000000000000000001: { username: "matt" },
        uidEve0000000000000000001: { username: "eve" } },
      // every name an account took, kept after a rename (lower case now; older claims kept their case)
      nameClaim: { rob: "uidRob00000000000000000001", robsgreenclone: "uidRob00000000000000000001", citizensnips: "uidSnips000000000000000001",
        pinksnips: "uidSnips000000000000000001", citizensips: "uidMatt0000000000000000001", matt: "uidMatt0000000000000000001",
        EVE: "uidRob00000000000000000001", ZED: "uidMatt0000000000000000001", Zed: "uidSnips000000000000000001" },
      globalTracks: {
        "1aaaaaaaaaa1": t(1, "robsgreenclone", "uidRob00000000000000000001"),
        "1aaaaaaaaaa2": t(2, "rob", "rob"),
        "1aaaaaaaaaa3": t(3, "citizensnips", "CitizenSnips"),
        "1aaaaaaaaaa4": t(4, "citizensnips", "pinksnips"),
        "1aaaaaaaaaa5": t(5, "CJ-", "CJ"),
        "1aaaaaaaaaa6": t(6, "CJ", "rocka2"),
        "1aaaaaaaaaa7": t(7, "citizensips", "matt"),
        "1aaaaaaaaaa8": t(8, "matt", "matt"),
        "1aaaaaaaaaa9": t(9, "eve", "EVE"),
        "1aaaaaaaa010": t(10, "ZED", "Zed")
      }
    }));
    run("import-firebase", join(dir, "fb.json"));
    writeFileSync(join(dir, "dj-aliases.csv"), "alias,canonical\nrocka2,=Rocka\n");
    run("reconcile");
    const look = (n) => run("lookup", "Act " + n + " - Song " + n);
    assert.match(look(1), /first: .* by rob\n[^]*last: .* by rob\n/, "a claimed name and the bare account id are the account's DJ");
    assert.match(look(4), /last: .* by citizensnips\n/, "shown as the name played most, not the account's name now");
    assert.match(look(3), /last: .* by citizensnips\n/, "case doesn't matter, the usual spelling shows");
    assert.match(look(7), /first: .* by matt\n/, "a name that looks like someone else's belongs to the account that claimed it");
    assert.match(look(9), /first: .* by eve\n[^]*last: .* by rob\n/, "a name in use is its account's; another account's claim of it in other capitals is theirs");
    assert.match(look(10), /first: .* by matt\n[^]*last: .* by citizensnips\n/, "claims as written: 'ZED' and 'Zed' are two accounts");
    assert.match(look(5), /first: .* by CJ\n/, "tools/history/dj-aliases.csv: 'CJ-' is CJ");
    assert.match(look(6), /last: .* by Rocka\n/, "the data folder's list is read too, and '=' pins the name shown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// When ADAM's history was moved into globalTracks its UTC times were read as
// US Central time, so they are 5 or 6 hours late; the bot's own, from
// December 2022, are right.
test("ADAM's moved dates: the shift is measured against Last.fm and taken off, so plays count once and keep their DJ", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    const chicago = (ms) => -Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" })
      .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName").value.match(/GMT-(\d\d)/)[1]) * 3600000;
    const tracks = {};
    const scrobbles = ["uts,utc_time,artist,artist_mbid,album,album_mbid,track,track_mbid"];
    for (let i = 0; i < 24; i++) {
      const at = Date.UTC(2017, i % 12, 3 + i, 1, 30); // a winter and a summer of plays
      scrobbles.push(Math.floor(at / 1000) + ",,Shift Act " + i + ",,,,Song " + i + ",");
      const moved = at - chicago(at); // UTC read as Chicago time: 5 or 6 hours late
      tracks["1shift" + String(i).padStart(6, "0")] = { artist: "Shift Act " + i, title: "Song " + i, type: 1, first_play_date: moved, first_play_dj: "ana", last_play_date: moved, last_play_dj: "ana" };
    }
    // the bot's own date (2023): already right
    const botAt = Date.UTC(2023, 5, 1, 20, 0);
    scrobbles.push(Math.floor(botAt / 1000) + ",,Bot Era,,,,Song,");
    tracks["1botera00000"] = { artist: "Bot Era", title: "Song", type: 1, first_play_date: botAt, first_play_dj: "ben", last_play_date: botAt, last_play_dj: "ben" };
    writeFileSync(join(dir, "fb.json"), JSON.stringify({ globalTracks: tracks }));
    writeFileSync(join(dir, "lastfm.csv"), scrobbles.join("\n") + "\n");
    run("import-firebase", join(dir, "fb.json"));
    run("import-lastfm", join(dir, "lastfm.csv"), "--user", "room");
    assert.match(run("reconcile"), /ADAM clock \(history moved into globalTracks\): America\/Chicago \(24 of 24 stamps line up\)/);
    const winter = run("lookup", "Shift Act 0 - Song 0");
    assert.match(winter, /1 plays \(1 on Last\.fm\)/, "ADAM's play and the scrobble are one play");
    assert.match(winter, /first: 2017-01-03 01:30 by ana/, "at the scrobble's time, with ADAM's DJ");
    assert.match(run("lookup", "Shift Act 6 - Song 6"), /1 plays[^]*first: 2017-07-09 01:30 by ana/, "summer time too (5 hours, not 6)");
    assert.match(run("lookup", "Bot Era - Song"), /1 plays[^]*first: 2023-06-01 20:00 by ben/, "the bot's own dates are left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vague spelling (the whole tag saved as the artist) is its upload's track, not a track of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    const entry = (name, cid) => ({ name, type: 2, cid });
    writeFileSync(join(dir, "fb.json"), JSON.stringify({
      globalTracks: {
        // the bot couldn't split it: the whole tag is the artist, no title
        "2231205170": { artist: "Remember (feat. The Presets)", type: 2, first_play_date: 1600000000000, first_play_dj: "ana" },
        // a vague spelling on uploads of two different songs stays apart
        "2900000001": { artist: "Intro", type: 2 }, "2900000002": { artist: "Intro", type: 2 }
      },
      playlists: { u: { p: { name: "x", list: {
        a: entry("Steve Angello - Remember (feat. The Presets)", "231205170"), b: entry("Steve Angello - Remember (feat. The Presets)", "231205170"),
        c: entry("The xx - Intro", "900000001"), d: entry("M83 - Intro", "900000002")
      } } } }
    }));
    run("import-firebase", join(dir, "fb.json"));
    run("reconcile");
    run("report");
    const look = run("lookup", "Steve Angello - Remember (feat. The Presets)");
    assert.match(look, /track \S+: Steve Angello - Remember \(feat\. The Presets\)\n/);
    assert.match(look, /1 plays .* 1 uploads, 2 spellings/, "the vague spelling joined its upload's track");
    const tracks = readFileSync(join(dir, "tracks.csv"), "utf8");
    assert.doesNotMatch(tracks, /^[^,]+,Remember \(feat\. The Presets\),/m, "no empty track left behind");
    assert.match(run("lookup", "The xx - Intro"), /1 spellings/, "'Intro' on two songs' uploads joins neither");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADAM's history as it is in globalTracks: short SoundCloud ids, 'undefined' keys, uid DJs, first after last", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", "tools/history/cli.js", "--dir", dir, ...args], { cwd: ROOT, encoding: "utf8" });
  try {
    writeFileSync(join(dir, "fb.json"), JSON.stringify({
      users: { "uidDjRob000000000000000001": { username: "rob" } },
      globalTracks: {
        // an early SoundCloud upload: "2" + "17819", as short as an ADAM id
        "217819": { artist: "Early Act", title: "Fool", type: 2, first_play_date: 1545087896476, first_play_dj: "Wendee", last_play_date: 1706742946446, last_play_dj: "matt" },
        // a bot bug once left the type out of the key
        "undefinedAbCdEfGhIjK": { artist: "Lost Key", title: "Found" },
        "undefinedundefined": { artist: "Fakey", title: "McFakesong" },
        // DJ saved as a uid; the first play logged after the last one; type as text
        "1qwertyuiopa": { artist: "Uid Band", title: "Who", type: "1", first_play_date: 1600000000000, first_play_dj: "uidDjRob000000000000000001", last_play_date: 1500000000000, last_play_dj: "wendee" },
        // only a last play (most entries ADAM had no first play for)
        "1lastonly000": { artist: "Last Only", title: "Once", type: 1, last_play_date: 1480000000000, last_play_dj: "eve" }
      },
      songHistory: {
        "-Nplay000000000000001": { artist: "Early Act", title: "Fool (Free Download)", type: 2, cid: "17819", dj: "eve", when: 1710000000000 }
      }
    }));
    const out = run("import-firebase", join(dir, "fb.json"));
    assert.match(out, /keys: .*number \(type agrees\)×1.*undefined\+id×2/, "the layout is described");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(join(dir, "history.db"), { readOnly: true });
    const up = (ref) => db.prepare("SELECT type, cid, extra FROM obs WHERE source = 'fb:globalTracks' AND ref = ?").get(ref);
    assert.deepEqual({ ...up("217819") }, { type: 2, cid: "17819", extra: JSON.stringify({ id: "217819" }) }, "'217819' is SoundCloud 17819, not ADAM track 217819");
    assert.equal(up("undefinedAbCdEfGhIjK").cid, "AbCdEfGhIjK", "the YouTube id is recovered from an 'undefined' key");
    assert.equal(up("undefinedundefined").cid, null, "a key with no id stays without an upload");
    db.close();

    run("reconcile");
    const fool = run("lookup", "Early Act - Fool");
    assert.match(fool, /first: 2018-12-17 .* by Wendee/, "ADAM's first play and DJ");
    assert.match(fool, /last: {2}2024-03-09 .* by eve/, "the room's later play is the last one");
    assert.match(fool, /1 uploads/, "the room's play of SoundCloud 17819 is the same upload");
    const who = run("lookup", "Uid Band - Who");
    assert.match(who, /first: 2017-07-14 .* by Wendee/, "a first play logged after the last one: the earlier is first; a DJ shows as most often written");
    assert.match(who, /last: {2}2020-09-13 .* by rob/, "a DJ saved as a uid shows by name");
    assert.match(run("lookup", "Last Only - Once"), /first: 2016-11-24 .* by eve/, "a last play alone is still a play");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
