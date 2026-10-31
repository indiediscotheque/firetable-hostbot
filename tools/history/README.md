# play history

Joins every play the room has ever had into one history: the room's database (including ADAM's 2016–2022 history, which was moved into it, and every DJ's playlists) and Last.fm scrobbles (back to the room's first). Every spelling, re-upload and platform of a recording becomes one **track**; every version of a song (remix, live, acoustic) is grouped into one **song**. The result is true first plays, the room's own play counts, DJ history, tag fixes, and accents restored. Publishing it switches the bot over, and from then on the bot keeps it up to date live.

Runs on Node 22 with nothing to install (SQLite is built in). Run it on the bot server or any computer with the bot's `.env`. A million plays take about a minute and ~2 GB of memory, so on a 1 GB server, run it on your own computer instead.

```bash
npm run history -- help
```

## as a GitHub Action (no server needed)
`.github/workflows/history.yml` runs it all on GitHub: every Monday, or by hand from Actions → **Play history** → Run workflow.
1. Add the bot's `.env` values as repository secrets (Settings → Secrets and variables → Actions): `FIREBASE_KEY`, `FIREBASE_DB`, `FIRETABLE_USER`, `FIRETABLE_PASS`, `LASTFM_APIKEY`, `LASTFM_USERNAME`, `YOUTUBE_KEY`, `SOUNDCLOUD_KEY`.
2. Deploy `firebase-rules.json`.
3. Run the workflow with **publish** unticked. ADAM's history was moved into the room's database in 2023: each upload's first and last play and DJ in `globalTracks` (keyed by type + upload id, so early SoundCloud ids as short as `217819` are read as uploads too). It comes in with everything else. The run's log describes how each path is laid out (fields and kinds of values, no data); if something there isn't read yet, that log line is what to send. ADAM's own ids, raw tags, artists and DJs (`globalTrackRaws`, `globalArtists`, `globalDjs`) are read too if they ever turn up there. The **ADAM sheet tab** field is only for a separate ADAM export, if one ever turns up.
4. Read the run's summary page and its reports (downloadable in a private repository). When it looks right, run it again with **publish** ticked.
5. From then on the Monday runs refresh everything and show a preview. To have them publish too, add the repository variable `HISTORY_AUTO_PUBLISH` = `true` (Settings → Secrets and variables → Actions → Variables).

Each run starts from the last run's data, so a refresh takes minutes. The first one downloads every Last.fm scrobble, about an hour for a million. Nothing depends on that saved data: mods' answers and imports are kept in the room's database, so if GitHub clears it, the next run rebuilds everything (or tick **rebuild**). YouTube checks stop at 3,000 quota units a run, so the bot always has enough left for the day.

**Safety checks.** A publish is refused, and the run fails, when:
- the history has 10% fewer tracks or 5% fewer plays than the last one published (usually a source that didn't download)
- it would change the tags of more than 10% of uploads
- many tracks pulled in lots of different artists (a matching problem)

Tick **force** to send it anyway. A preview never writes anything. `publish --off` (or removing `globalSongsMeta/ready`) puts the bot back on the old counts.

## first run (on a computer or the bot server)
1. **ADAM** is already in the room's database (its first and last plays, in `globalTracks`) and comes in with step 2. Only if you have a separate ADAM export (CSV, one per sheet): `npm run history -- import-adam file.csv`. Google Sheets turns some titles into times and numbers (`2:00` becomes `2:00 AM`); those are repaired where any other source has the real title, and listed in `spreadsheet_damage.csv`.
2. **The room's database**, read as the bot: global tags and ADAM's moved history, Recent, Fresh, every DJ's playlists and queues, the play and tag logs, mods' review answers. `npm run history -- probe` shows how each path is laid out first, without its data.
   ```bash
   npm run history -- fetch-firebase
   ```
3. **Last.fm**, every scrobble of `LASTFM_USERNAME`. That's about 5,000 pages per million plays, roughly 25 minutes. It can be stopped and re-run; it carries on where it stopped:
   ```bash
   npm run history -- fetch-lastfm
   ```
   If the room used other accounts over the years, add them: `--user account1,account2`. A CSV of scrobbles from an export site works too: `import-lastfm file.csv --user name`.
4. **Uploads**: asks YouTube and SoundCloud what each upload is and whether it still exists (about 2,000 YouTube quota units per 100,000 uploads; if the quota runs out, run it again the next day):
   ```bash
   npm run history -- verify-uploads
   ```
5. **Artist spellings** from Last.fm (optional, about 15 minutes for 3,000 artists): `npm run history -- enrich`
6. **Reconcile and read the reports:**
   ```bash
   npm run history -- reconcile
   npm run history -- report
   ```
   Everything lands in `history-data/`. Start with `summary.md`. `npm run history -- lookup "Foals - My Number"` shows one song: every spelling, upload, play count and first play.
7. **Publish** (preview first; nothing is sent without `--write`):
   ```bash
   npm run history -- publish --restore-accents
   ```
   ```bash
   npm run history -- publish --write --restore-accents
   ```
   Deploy `firebase-rules.json` first. The bot switches over on its own: true first plays, its own counts, and `!plays`. `publish --off` switches it back.

## restoring accents
For years accents and other non-English letters were stripped from tags so Last.fm would take the scrobbles. The history puts them back wherever enough logs still have them:
- An accented name, title or word is restored when **at least 2 logs** write it that way (`--accent-min` changes this). One log from a trusted source is enough: a mod's logged fix, SoundCloud's own artist/title, a YouTube Topic channel, or Last.fm's spelling of the artist. It doesn't need to outnumber the stripped spelling, which years of stripping made the common one. If logs disagree on the accents (`Beyoncé` / `Beyoncè`), the most-logged version wins.
- **One artist, one name.** Every track shows its artist's one name, and a publish writes it to the room's tags where only capitals or accents differ. **YouTube Music** is the main reference: when at least 3 of the room's uploads came from the artist's Topic channel, its spelling is the name, capitals and accents included (`Lemaitre`, `Röyksopp`, `Tyler Touché`; `Blow`, `Louis La Roche` stay plain however many logs say `Bülow` or `Roché`). Seen on fewer uploads, YouTube Music can add accents but not take them off (its auto channels write `Cesaria Evora`; the room's `Cesária Évora` stays). Otherwise the name is the room's most used spelling (`Bjrk` and `TameImpalaVEVO` become `Bjork` and `Tame Impala`), and each tag keeps its own accents until YouTube Music confirms them. A mod's spelling sets capitals and punctuation (`SebastiAn`). Artists whose accents the logs disagree on and no upload settles are looked up by searching for their most played song (`check-artists`, which `refresh` and the Action run: 100 YouTube quota units each, most played first, within the run's quota). `artist_accents.csv` lists them and what was done. New plays match whatever their accents: `Bjork` finds `Björk`.
- On a single track, its own logs still restore its artist and title (an upload's SoundCloud tags, a Topic upload), unless YouTube Music writes that artist differently.
- Only accented Latin letters count: `♫ Artist`, `█▬█ █ ▀█▀ Artist`, emoji and other scripts (`GRYFF グリフ`) are never put back. **Words** in titles are restored across the same artist's songs: if `Jóga` is well logged, `Joga (Live)` becomes `Jóga (Live)`. It's never across different artists, so "resume" never turns into "résumé".
- Dropped letters and `?` count too: `Bjrk` and `Bj?rk` become `Björk`.
- `restore_accents.csv` lists every change and why (how many logs). `publish --restore-accents` applies them to the room's tags; the Action does it by default.
- From then on the bot restores them live: when a stripped upload of a known song plays, it shows and saves the accented tags, and the DJ's queue entry follows.

## tidying tags
Matching ignores upload junk, but by default the room's tags are only changed to put accents back (`--restore-accents`). To clean them too, publish with `--tidy` (or pick **tidy** when running the Action). Check `tidy_preview.csv` first; it shows both levels for every track:
- `--tidy junk` takes out only what describes the upload or its uploader: `(Official Video)`, `[Official Audio]`, `HD`, `(Visualizer)`, `[Monstercat Release]`, `[OUT NOW ON BEATPORT]`, `[EDM.com Premiere]`, `| Columbia Records`, `[Watergate Records]`, `PREMIERE: Artist`, hashtags at the end, `- Topic`, `VEVO`. Anything about the song stays exactly as typed: `ft.`, `[brackets]`, years `(1983)`, credits `(Prod. Kaytranada)`, `(Bonus Track)`, `(Soundtrack Version)`, and text after `|` or `//` that isn't upload junk (`Disclosure | You & Me (Flume Remix)`).
- `--tidy rsn` also lays tags out in Rohn Standard Notation, moving things and nothing else: the featured artists go after the title with `feat.` (`Steve Angello - Remember (feat. The Presets)` becomes `Steve Angello - Remember feat. The Presets`; `Kris Menace feat. Black Hills - Waiting For You (Oliver Remix)` becomes `Kris Menace - Waiting For You feat. Black Hills (Oliver Remix)`), names exactly as typed (`Tegan and Sara` stays), and versions go in parentheses (`[Worship Remix]`, `- Guys In Venice Remix`). Notes for the same recording go, because one track holds all of them: `(Radio Edit)`, `(Extended Mix)`, `(Original Mix)`, `(2011 Remaster)` (exactly the notes matching treats as the same track); remixes, live and acoustic versions keep theirs. `(With Your Love)` is a title, not a featuring, and `37,000 ft` is feet. English titles also get AP title case, fixing slips only: `The Less I Know The Better` becomes `The Less I Know the Better`, `walking on a dream` becomes `Walking on a Dream`. Titles in other languages (French takes a capital on the first word only), all-caps titles, styled words (`iPhone`, `DJ`) and names in parentheses stay as typed. The `title_case` column of `tidy_preview.csv` lists each change.

Artists are written with their one name (see restoring accents).

Tidy never touches:
- tags a mod fixed: logged in `tagLog`, which covers every fix from now on (`!fixtags` or the site's editor)
- anything in `tag-exceptions.csv` (in `tools/history/`, or `history-data/`): one artist (`!!!`) or song (`Artist - Title`) per line, for deliberate exceptions to RSN

Fixes made before the tag log existed can't be told apart from the bot's own guesses. Add the ones that break RSN on purpose to the exceptions file. The Action tidies in RSN by default (`Steve Angello - Remember (feat. The Presets)` is published as `Steve Angello - Remember feat. The Presets`); pick another level when running it by hand, or set the repository variable `HISTORY_TIDY` to `junk` or `none` to change the weekly default.

## how songs are matched
Rohn Standard Notation is the guide for *recognising* a song, never a rule for rewriting one. Tags people chose stay exactly as they are.
- **Same upload** (YouTube/SoundCloud id) = same track. If its tags disagree completely, it goes to review.
- **Same artist(s) and title after cleanup**: case, accents, `&`/`and`/`x`, artist order, `feat.`, `(Official Video)`, `[HD]`, `- Topic`, `VEVO`, label tags, `| uploader text`, `Radio Edit`, `Extended Mix`, `Remastered`.
- **Different versions stay apart** but are grouped as one song: `(X Remix)`, `Edit`, `Bootleg`, `VIP`, live, acoustic, instrumental, demo, slowed/sped up, covers.
- **"The X" and "X" are different artists**, except on a song they share: `The X - Song Title` and `X - Song Title` are one track, shown under whichever artist name the logs use more. Vague titles (`Intro`, `Track 1`) never join them. Otherwise they're joined only on evidence: the same upload tagged both ways, Last.fm or ADAM saying they're one artist, or `artist-aliases.csv`. `X, The` is read as `The X`.
- **Artist aliases**: ADAM's artist ids, Last.fm's artist ids and corrections, `artist-aliases.csv`.
- **The old Last.fm accent bug**: `Bjrk`, `Bj?rk` and `Bjork` all match `Björk`.
- **ISRC** (SoundCloud's recording id) links uploads of the same recording.
- **Typos**: swapped letters and very close titles are merged; anything less certain goes to review. Numbers never count as typos (`Part 1` ≠ `Part 2`).
- **Vague tags** (`Unknown - Intro`, `Track 3`) are never matched across uploads. One that is only ever logged for uploads of one track (the bot once saved `Remember (feat. The Presets)` as the artist, with no title) is that track's.

**The best spelling** for each track is chosen in this order: a mod's fix (`tagLog`, then the room's saved tags), then the most-used spelling, then cleanliness, with accents restored. YouTube and SoundCloud's own data is just one source: their trusted fields (Topic channels, SoundCloud's artist/title) count about as much as an ADAM tag, plain video titles hardly at all, and channel names never decide how an artist is written.

**Plays** from different sources within 10 minutes of each other count once (`--window`). ADAM's clock had no time zone, so it's lined up against Last.fm automatically (or set it: `--adam-tz America/Chicago`). A track's first play is its earliest play in any source. When only Last.fm has that play, the date is known but the DJ isn't; `first_known_dj` gives the earliest play with a DJ.

## review
Some pairs only a person can call ("are `Star Rain` and `Star Ruin` the same?"). Two ways to answer:
- **In chat, by any mod:** `publish` sends up to 300 questions. `!review` shows the next one; answer with `!same 12` or `!different 12`. The next `refresh` uses the answers.
- **In a spreadsheet** (when running it yourself): fill the `decision` column of `history-data/review.csv` with `merge` or `separate`, then `npm run history -- review apply history-data/review.csv` and `reconcile`.

Answers are kept for good, in the room's database too (`historyDecisions`), and never asked again.

Two files cover what the history can't know on its own (`alias,canonical` per line). Keep them in `tools/history/` and commit them, so the GitHub Action uses them too; one in `history-data/` is read as well:
- `artist-aliases.csv`, e.g. `Shiina Ringo,椎名林檎`
- `dj-aliases.csv`, for a DJ who played under more than one name (`CJ-,CJ`), or one person's several accounts.

**Who is who.** A DJ is an account: its username, every name it ever claimed (the room's `nameClaim` keeps old names after a rename) and its id, so a renamed DJ's plays stay together and a name that mimics someone else's (`citizensips`) goes to the account that took it. `dj-aliases.csv` only needs names from before claims existed, and accounts that are one person. Each DJ is shown as the name they played under most (case never matters); to show another, pin it with `=`: `Noumenon,=Andrew`. `djs.csv` lists every name each DJ played under.

## keeping it current
The bot does the day-to-day work:
- It links each new upload to its track by its tags, counts the play, and logs it in `playLog`.
- Mods' fixes (`!fixtags` and the site's tag editor) are logged in `tagLog` and teach the bot the new spelling.

Run `refresh` now and then (weekly is plenty). It catches what the bot can't: typos, `feat.` variations, accents, upload checks and review answers.
```bash
npm run history -- refresh --publish --restore-accents
```
To run it every Monday at 4:10 on the server (`crontab -e`):
```
10 4 * * 1 cd ~/firetable-hostbot && npm run history -- refresh --publish --restore-accents >> history-data/refresh.log 2>&1
```

## what's in history-data/
| file | what it is |
|---|---|
| `history.db` | everything, in SQLite (open with DB Browser for SQLite or Datasette) |
| `summary.md` | totals, sources, top tracks, DJs with the most first plays |
| `tracks.csv` / `songs.csv` | every track / song: plays, first and last play and DJ, uploads, spellings |
| `spellings.csv` | every spelling ever seen and the track it belongs to |
| `lastfm_split.csv` | how Last.fm's count was split across spellings |
| `tag_fixes.csv` | uploads whose room tags differ from the track's best spelling (`publish --retag` applies them) |
| `restore_accents.csv` | accents that will be put back (`publish --restore-accents`) |
| `artist_accents.csv` | artists the logs would put accents on, what YouTube Music writes, and what was done |
| `dead_uploads.csv` | uploads that are gone, with a working upload of the same track |
| `djs.csv` | every DJ: plays, first plays, years active |
| `merges.csv` | why each pair of spellings was joined |
| `review.csv` | questions waiting for an answer |
| `tidy_preview.csv` | what `--tidy junk` and `--tidy rsn` would show for each track, and which are left alone |
| `rsn_suggestions.csv` | RSN versions, by RSN's strictest reading (drops notes like "Radio Edit"); for a look only |

`history-data/` is ignored by git; back up `history.db` if you've saved review answers in it.
