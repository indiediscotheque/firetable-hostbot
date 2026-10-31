# play history

Joins every play the room has ever had into one history: ADAM (2016–2022), Last.fm scrobbles (back to the room's first), and the room's database (2023 on, plus every DJ's playlists). Every spelling, re-upload and platform of a recording becomes one **track**; every version of a song (remix, live, acoustic) is grouped into one **song**. The result is true first plays, the room's own play counts, DJ history, tag fixes, and accents restored. Publishing it switches the bot over, and from then on the bot keeps it up to date live.

Runs on Node 22 with nothing to install (SQLite is built in). Run it on the bot server or any computer with the bot's `.env`. A million plays take about a minute and ~2 GB of memory, so on a 1 GB server, run it on your own computer instead.

```bash
npm run history -- help
```

## as a GitHub Action (no server needed)
`.github/workflows/history.yml` runs it all on GitHub: every Monday, or by hand from Actions → **Play history** → Run workflow.
1. Add the bot's `.env` values as repository secrets (Settings → Secrets and variables → Actions): `FIREBASE_KEY`, `FIREBASE_DB`, `FIRETABLE_USER`, `FIRETABLE_PASS`, `LASTFM_APIKEY`, `LASTFM_USERNAME`, `YOUTUBE_KEY`, `SOUNDCLOUD_KEY`.
2. Deploy `firebase-rules.json`.
3. **ADAM, once.** In the "ADAM DATA" sheet: File → Make a copy, then share the copy as "Anyone with the link". Open the TRAX tab and copy its address. Run the workflow with that link in **ADAM sheet tab**, leaving **publish** unticked. The import is kept in the room's database (`historyArchive`, readable only by the bot), so unshare the copy afterwards; every later run has it. Repeat for any other tab.
4. Read the run's summary page and its reports (downloadable in a private repository). When it looks right, run it again with **publish** ticked.
5. From then on the Monday runs refresh everything and show a preview. To have them publish too, add the repository variable `HISTORY_AUTO_PUBLISH` = `true` (Settings → Secrets and variables → Actions → Variables).

Each run starts from the last run's data, so a refresh takes minutes. The first one downloads every Last.fm scrobble, about an hour for a million. Nothing depends on that saved data: mods' answers and imports are kept in the room's database, so if GitHub clears it, the next run rebuilds everything (or tick **rebuild**). YouTube checks stop at 3,000 quota units a run, so the bot always has enough left for the day.

**Safety checks.** A publish is refused, and the run fails, when:
- the history has 10% fewer tracks or 5% fewer plays than the last one published (usually a source that didn't download)
- it would change the tags of more than 10% of uploads
- many tracks pulled in lots of different artists (a matching problem)

Tick **force** to send it anyway. A preview never writes anything. `publish --off` (or removing `globalSongsMeta/ready`) puts the bot back on the old counts.

## first run (on a computer or the bot server)
1. **ADAM.** Open the "ADAM DATA" sheet → File → Download → CSV, once per tab (TRAX and any others). Then:
   ```bash
   npm run history -- import-adam ~/Downloads/ADAM\ DATA\ -\ TRAX.csv
   ```
   It works out what each tab is from its columns. Google Sheets turned some titles into times and numbers (`2:00` became `2:00 AM`); these are repaired where any other source has the real title, and listed in `spreadsheet_damage.csv`. An export straight from ADAM's own database avoids that damage and may include every play: ask for one if it still exists.
2. **The room's database**, read as the bot (global tags, Recent, Fresh, every DJ's playlists and queues, the play and tag logs, mods' review answers):
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

## tidying tags
Matching ignores upload junk, but by default the room's tags are only changed to put accents back (`--restore-accents`). To clean them too, publish with `--tidy` (or pick **tidy** when running the Action). Check `tidy_preview.csv` first; it shows both levels for every track:
- `--tidy junk` takes out what only describes the upload: `(Official Video)`, `[Official Audio]`, `HD`, `(Visualizer)`, `[Monstercat Release]`, `| uploader text`, hashtags, `- Topic`, `VEVO`. Everything else stays exactly as typed, `ft.` and `[brackets]` included.
- `--tidy rsn` also lays tags out in Rohn Standard Notation: `feat.` after the title, versions in parentheses. Notes like `Radio Edit` or `2011 Remaster` stay.

Both also write each artist one way everywhere: the spelling a mod chose, otherwise the one the room uses most, with accents restored. That's how a fix to one song's artist reaches that artist's other songs.

Tidy never touches:
- tags a mod fixed: logged in `tagLog`, which covers every fix from now on (`!fixtags` or the site's editor)
- anything in `history-data/tag-exceptions.csv`: one artist (`!!!`) or song (`Artist - Title`) per line, for deliberate exceptions to RSN

Fixes made before the tag log existed can't be told apart from the bot's own guesses. Add the ones that break RSN on purpose to the exceptions file. For the Action, set the repository variable `HISTORY_TIDY` to `junk` or `rsn` to make it the weekly default.

## how songs are matched
Rohn Standard Notation is the guide for *recognising* a song, never a rule for rewriting one. Tags people chose stay exactly as they are.
- **Same upload** (YouTube/SoundCloud id) = same track. If its tags disagree completely, it goes to review.
- **Same artist(s) and title after cleanup**: case, accents, "The", `&`/`and`/`x`, artist order, `feat.`, `(Official Video)`, `[HD]`, `- Topic`, `VEVO`, label tags, `| uploader text`, `Radio Edit`, `Extended Mix`, `Remastered`.
- **Different versions stay apart** but are grouped as one song: `(X Remix)`, `Edit`, `Bootleg`, `VIP`, live, acoustic, instrumental, demo, slowed/sped up, covers.
- **Artist aliases**: ADAM's artist ids, Last.fm's artist ids and corrections, `artist-aliases.csv`.
- **The old Last.fm accent bug**: `Bjrk`, `Bj?rk` and `Bjork` all match `Björk`. The accented spelling is restored when any source has it (`restore_accents.csv`).
- **ISRC** (SoundCloud's recording id) links uploads of the same recording.
- **Typos**: swapped letters and very close titles are merged; anything less certain goes to review. Numbers never count as typos (`Part 1` ≠ `Part 2`).
- **Vague tags** (`Unknown - Intro`, `Track 3`) are never matched across uploads.

**The best spelling** for each track is chosen in this order: a mod's fix (`tagLog`, then the room's saved tags), then the most-used spelling, then cleanliness, with accents restored. YouTube and SoundCloud's own data is just one source: their trusted fields (Topic channels, SoundCloud's artist/title) count about as much as an ADAM tag, plain video titles hardly at all, and channel names never decide how an artist is written.

**Plays** from different sources within 10 minutes of each other count once (`--window`). ADAM's clock had no time zone, so it's lined up against Last.fm automatically (or set it: `--adam-tz America/Chicago`). A track's first play is its earliest play in any source. When only Last.fm has that play, the date is known but the DJ isn't; `first_known_dj` gives the earliest play with a DJ.

## review
Some pairs only a person can call ("are `Star Rain` and `Star Ruin` the same?"). Two ways to answer:
- **In chat, by any mod:** `publish` sends up to 300 questions. `!review` shows the next one; answer with `!same 12` or `!different 12`. The next `refresh` uses the answers.
- **In a spreadsheet** (when running it yourself): fill the `decision` column of `history-data/review.csv` with `merge` or `separate`, then `npm run history -- review apply history-data/review.csv` and `reconcile`.

Answers are kept for good, in the room's database too (`historyDecisions`), and never asked again.

Two files in `history-data/` cover what the history can't know on its own (`alias,canonical` per line):
- `artist-aliases.csv`, e.g. `Shiina Ringo,椎名林檎`
- `dj-aliases.csv`, for a DJ who changed names

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
| `dead_uploads.csv` | uploads that are gone, with a working upload of the same track |
| `djs.csv` | every DJ: plays, first plays, years active |
| `merges.csv` | why each pair of spellings was joined |
| `review.csv` | questions waiting for an answer |
| `tidy_preview.csv` | what `--tidy junk` and `--tidy rsn` would show for each track, and which are left alone |
| `rsn_suggestions.csv` | RSN versions, by RSN's strictest reading (drops notes like "Radio Edit"); for a look only |

`history-data/` is ignored by git; back up `history.db` if you've saved review answers in it.
