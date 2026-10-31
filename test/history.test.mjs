// The tag engine (lib/tags.js) and the play history toolkit (tools/history)
// on small made-up exports shaped like the real ones. No emulators needed:
//   cd test && npm run test:history
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
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

test("artists: order, &/and, The, accents and case don't matter", () => {
  assert.equal(key("Simon & Garfunkel", "The Boxer"), key("Simon and Garfunkel", "The Boxer"));
  assert.equal(key("The Rolling Stones", "Angie"), key("Rolling Stones", "Angie"));
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

test("toolkit: ADAM + Last.fm + Firebase become one history", () => {
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
    assert.match(run("lookup", "Sigur Ros - Hoppipolla"), /track \S+: Sigur Rós - Hoppípolla/, "accents restored from a playlist and ADAM");
    const accents = readFileSync(join(dir, "restore_accents.csv"), "utf8");
    assert.match(accents, /Sigur Ros - Hoppipolla,Sigur Rós - Hoppípolla/);
    const summary = readFileSync(join(dir, "summary.md"), "utf8");
    assert.match(summary, /\| plays \| 19 /);
    run("publish", "--restore-accents");
    const preview = JSON.parse(readFileSync(join(dir, "publish-preview.json"), "utf8"));
    assert.equal(preview.counts.accents, 1);
    assert.equal(preview.counts.retags, 0, "no tag is rewritten without --retag");
    assert.ok(preview.sample.some(([p, v]) => /^globalSongKeys\//.test(p) && /^t/.test(v)));
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
