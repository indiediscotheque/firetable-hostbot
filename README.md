# firetable-hostbot
node.js "chatbot" back end for firetable, a virtual music listening room powered by firebase.

pairs with a client side front end ([firetable-user](https://github.com/mxew/firetable-user)).

## install
Needs Node.js 22 or newer (`node -v`); on an older one the bot stops at startup and says so.
- `git clone https://github.com/indiediscotheque/firetable-hostbot.git`
- `cd firetable-hostbot` and `npm ci` (installs the exact versions in `package-lock.json`)
- copy `.env.example` to `.env` and fill it in (see below)
- deploy `firebase-rules.json` (see [database rules](#database-rules))
- `npm start` to run (or use pm2, below, to keep it running)

### .env settings
| setting | what it's for |
|---|---|
| `FIRETABLE_USER` / `FIRETABLE_PASS` | the bot's firetable login |
| `FIREBASE_KEY` / `FIREBASE_AUTH` / `FIREBASE_DB` | Firebase console → ⚙️ Project settings → General → Your apps |
| `YOUTUBE_KEY` | Google Cloud API key with YouTube Data API v3 enabled |
| `SOUNDCLOUD_KEY` | SoundCloud web client id, for checking SoundCloud tracks (see [soundcloud](#soundcloud); keep it as is) |
| `SOUNDCLOUD_CLIENT_ID` / `SOUNDCLOUD_CLIENT_SECRET` | optional, leave unset: a registered SoundCloud app, to use SoundCloud's official API instead (see [soundcloud](#soundcloud)) |
| `AUTODJ` | autopilot DJ, on unless set to `false` |
| `TRACKBROKEN_MESSAGES` | `true` to tell a DJ in chat when their song is broken or blocked (off by default) |
| `LASTFM_APIKEY` / `LASTFM_SECRET` / `LASTFM_SESSIONKEY` / `LASTFM_USERNAME` | optional: scrobble plays to last.fm (`LASTFM_SECRET` is the API key's "Shared secret" at last.fm/api/accounts) |
| `SITE_URL` | the firetable-user site's address; the bot follows its seasons from there (see [seasons](#seasons)) |
| `TZ` | time zone for the seasonal months, e.g. `America/Chicago` (default: the server's, usually UTC) |
| `AVATARSET` / `LIGHTS_MONTHS` | optional: force a card avatar set / lights months (e.g. `11,12`) instead of following the site; leave unset |
| `SWAP_SUGGESTIONS` | nightly YouTube Music swap suggestions for broken tracks, on unless set to `false` (see [swap suggestions](#swap-suggestions)) |
| `SWAP_HOUR` / `SWAP_MAX_SEARCHES` / `SWAP_MAX_DEEP` | optional: the hour the swap search runs (in `TZ`, default `4`), its limit per run for each kind of free search (default `600`), and how many songs a run looks up on artist and album pages and in Apple's catalog (default `300`) |
| `APPLE_LOOKUP` / `YTMUSIC_ALT_CLIENT` | optional: `false` stops asking Apple's catalog which album a song is on; `off` stops asking as YouTube Music's Android app when the web app's song catalog says "No results" |
| `SWAP_API_UNITS` | optional: the most YouTube Data API units a day the swap search may spend on paid searches (`search.list`, 100 each) for songs whose free search didn't answer (default `1000`; `0` turns them off) |
| `YTMUSIC_SYNC` | the daily sync of the bot's YOUTUBE MUSIC playlist with the Indie Discotheque year playlists, on unless set to `false` (see [the YOUTUBE MUSIC playlist](#the-youtube-music-playlist)) |
| `YTMUSIC_SYNC_HOUR` / `YTMUSIC_PLAYLIST` / `YTMUSIC_SOURCES` / `YTMUSIC_DUPE_SECONDS` / `YTMUSIC_MAX_SEARCHES` / `YTMUSIC_MAX_DEEP` | optional: the hour it runs (in `TZ`, default `5`), the playlist's name (default `YOUTUBE MUSIC`), other year playlists (`year=link`, comma separated; default the official 2001–2026 ones), how close two lengths are for a duplicate (default `3` seconds) and its search limit per sync, per search source (default `1000`), and the songs per sync looked up on artist and album pages and in Apple's catalog (`YTMUSIC_MAX_DEEP`, default `500`) |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN` | optional: the room's YouTube account, for the [genre playlists on YouTube Music](#genre-playlists-on-youtube-music) (`tools/youtube-auth.js` prints them). Off until all three are set |
| `YTM_PLAYLIST_HOUR` / `YTM_PLAYLIST_UNITS` / `YTM_GENRE_SONGS` / `YTM_GENRE_PLAYLISTS` | optional: the hour the genre playlists update (in `TZ`, default `6`), the quota units a run may spend (default `4000`), songs per playlist (default `50`), and `false` to turn them off |
| `DISCOVER` | the public data for the site's Discover side (charts, new releases, chat peek), on unless set to `false` (see [discover](#discover)) |
| `PUSH_NOTIFICATIONS` | push @mentions to phones and computers, on unless set to `false` (see [push notifications](#push-notifications)) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | optional, leave unset: the bot makes its own push keys. Set them only to bring keys from elsewhere |
| `AWAY_CLOSED_MIN` / `AWAY_ANSWER_MIN` / `AWAY_LOST_HOURS` | optional: when DJs who left are asked and put on the bus (default `5` / `5` / `3`, see [away DJs](#away-djs)) |

## hosting (free, always on)
The bot is a long-running process with no web server, so it needs a host that never sleeps. Oracle Cloud's Always Free tier works and costs nothing.

### set up the server
1. Sign up at oracle.com/cloud/free (the home region can't be changed later). Then Billing → Upgrade to **Pay As You Go** so Oracle never stops the server for being idle. Always Free items stay free; add a $1 budget alert for peace of mind.
2. Compute → Instances → Create instance:
   - image **Canonical Ubuntu 24.04**, shape **VM.Standard.A1.Flex** (1 OCPU, 6 GB). If it's out of capacity, try another availability domain or **VM.Standard.E2.1.Micro** (under "Specialty and previous generation", with the non-aarch64 Ubuntu image).
   - networking: **Create new virtual cloud network** + **Create new public subnet**.
   - SSH keys: **Generate a key pair for me** → **Save private key**. Back this file up; it's the only way in.
3. If the instance has no public IP: instance → Networking → the VNIC → IP administration → ⋮ on the private IP → Edit → **Ephemeral public IP**.
4. On Windows, lock the key down or ssh refuses it (PowerShell):
   ```
   mkdir $HOME\.ssh -Force
   Move-Item .\ssh-key-*.key $HOME\.ssh\hostbot.key
   icacls $HOME\.ssh\hostbot.key /inheritance:r
   icacls $HOME\.ssh\hostbot.key /grant:r "${env:USERNAME}:(R)"
   ```
   On a Mac: `chmod 400 path/to/key`.

### install the bot
Connect with `ssh -i $HOME\.ssh\hostbot.key ubuntu@<server-ip>`. Commands from here run on the server (prompt starts with `ubuntu@`), not your PC.
```
sudo NEEDRESTART_MODE=a apt update && sudo NEEDRESTART_MODE=a apt upgrade -y
sudo reboot
```
Reconnect after a minute, then:
```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs git
git clone https://github.com/indiediscotheque/firetable-hostbot.git
cd firetable-hostbot && npm ci
cp .env.example .env && nano .env
sudo npm install -g pm2
pm2 install pm2-logrotate
pm2 start app.js --name hostbot
sudo pm2 startup systemd -u ubuntu --hp /home/ubuntu
pm2 save
bash scripts/auto-update.sh --install
```
In nano: Ctrl+O, Enter, Ctrl+X saves and exits. To send a `.env` you already have from your PC instead (`exit` back to PowerShell first):
`scp -i $HOME\.ssh\hostbot.key .env ubuntu@<server-ip>:~/firetable-hostbot/.env`

A healthy start logs the bot's user id, the DJ/waitlist state, then `Listening now.`

### updates (automatic)
`bash scripts/auto-update.sh --install` (once) makes the server check GitHub every 5 minutes. When `master` has new commits it pulls them, runs `npm ci` if `package.json` or `package-lock.json` changed (the exact versions the code was tested with), checks `app.js` and every dependency load, restarts the bot, and watches it for a minute. If a check or the install fails, or the restarted bot keeps crashing, it puts the old code back (restarting the bot on it if needed) and skips that version until a newer commit lands. Nothing runs when nothing changed.
- what it did: `cat ~/firetable-hostbot/auto-update.log`
- update right now: `bash ~/firetable-hostbot/scripts/auto-update.sh`
- turn it off: `bash ~/firetable-hostbot/scripts/auto-update.sh --uninstall`
- it pauses (and says so in the log) while you're on another branch or a rolled-back version, or if files in the folder were edited by hand. `.env` edits are fine.
- whatever lands on `master` runs on the server within 5 minutes, so protect the branch on GitHub: Settings → Branches → add a rule for `master` that requires a pull request.

Two things it can't do for you: if `firebase-rules.json` changed, deploy the rules; if a new `.env` setting was added, add it (`.env.example` lists them).

Without auto-update: `cd ~/firetable-hostbot && git pull && npm ci && pm2 restart hostbot`

## if the bot goes down
Work down the list; stop when it's back.

**1. Connect.** `ssh -i $HOME\.ssh\hostbot.key ubuntu@<server-ip>`. If it times out or is refused, the server is off: go to step 4.

**2. Check the bot.** `pm2 status`
| you see | type |
|---|---|
| `hostbot` **online** but not in the room | `pm2 restart hostbot` |
| **errored** / **stopped** | `pm2 restart hostbot`; if it fails again, step 3 |
| `hostbot` not listed | `cd ~/firetable-hostbot && pm2 start app.js --name hostbot && pm2 save` |
| `pm2: command not found` | `sudo npm install -g pm2`, the line above, then `sudo pm2 startup systemd -u ubuntu --hp /home/ubuntu` |

**3. Read the error.** `pm2 logs hostbot --lines 50` (Ctrl+C to exit)
| error mentions | fix |
|---|---|
| `couldn't sign in`, `wrong-password`, `user-not-found` | `nano ~/firetable-hostbot/.env`, fix `FIRETABLE_USER` / `FIRETABLE_PASS`, `pm2 restart hostbot` (until then the bot keeps retrying, up to every 5 minutes) |
| `PERMISSION_DENIED` | redeploy `firebase-rules.json` |
| `Cannot find module` | `cd ~/firetable-hostbot && npm ci && pm2 restart hostbot` |
| `needs Node.js 22 or newer` | upgrade Node: `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo bash -`, `sudo apt install -y nodejs`, then `cd ~/firetable-hostbot && npm ci && pm2 restart hostbot` |
| `quotaExceeded` (YouTube), `couldn't check the track` | wait; the YouTube quota resets at midnight Pacific. Until then the bot retries, then passes the decks along (SoundCloud tracks still play). It never flags tracks it couldn't check |
| `ENOSPC` / no space left | `pm2 flush && pm2 restart hostbot` |
| bot is on old code | `cat ~/firetable-hostbot/auto-update.log` says why (paused, failed check, GitHub unreachable) |

Broke right after an update? `cat ~/firetable-hostbot/auto-update.log` shows what changed and when. Go back one version (this also pauses auto-update):
`cd ~/firetable-hostbot && git checkout HEAD~1 && npm ci && pm2 restart hostbot`
Return to the latest (and resume auto-update) with `git checkout master && git pull && npm ci && pm2 restart hostbot`.

**4. Server off or frozen** (works from a phone). cloud.oracle.com → Compute → Instances → the instance. **Stopped** → Start; **Running** → Reboot → Force reboot. pm2 starts the bot on boot, so check the room after ~2 minutes.

**5. Fresh reinstall** (keeps `.env`):
```
cd ~
pm2 delete hostbot
mv firetable-hostbot firetable-hostbot-old
git clone https://github.com/indiediscotheque/firetable-hostbot.git
cp firetable-hostbot-old/.env firetable-hostbot/
cd firetable-hostbot && npm ci
pm2 start app.js --name hostbot && pm2 save
```

## dependencies
- Node.js 22+ (its own `fetch` for every web request, and its own `.env` reader; values already set in the environment win over `.env`)
- `@firebase/app-compat`, `@firebase/auth-compat`, `@firebase/database-compat` (Firebase 13's auth and Realtime Database, pinned with `@firebase/app` so there's one copy)
- `@vibrant/*` (the room's colours from the artwork; node-vibrant 4's parts, set up in `lib/colors.js`)
- `acorn` (reads the site's season settings without running them)

Push notifications (`lib/webpush.js`) use Node's own crypto and `fetch`: Web Push encryption and VAPID signing, no extra packages.

YouTube is checked with one direct call to the YouTube Data API (`videos.list`, 1 unit of quota per song). Swap suggestions look songs up with no API key or quota (`lib/ytmusic.js`), check their matches 50 at a time (1 unit per call), and use `search.list` (100 units) only when the free searches don't answer, within `SWAP_API_UNITS` a day.

## commands added recently
- `!remove name` (mods): takes someone off the decks or the waitlist; a mod can't remove a supermod.
- `!removeafter` / `!dontremoveme`: step down after your next song, or cancel it. Mods can add a name (`!removeafter name`, `!dontremove name`) to do it for someone of lower rank.
- `!fixtags artist - title` (mods): correct the playing song's tags (only the first " - " splits artist from title).
- `!suggest <theme>`: start a theme vote (pings @everyone). One vote at a time, up to 80 characters, and one suggestion per person every 15 minutes (mods are exempt).
- `!flagplay <play id> <reason>` (mods): flag a play from Recent in the DJ's queue and all of their playlists. Reasons: `broken`, `quality`, `offtheme`.
- `!bpm`: say the playing song's tempo. The DJ or a mod can set it with `!bpm 128`.
- `!autodj`: say what the autopilot DJ is doing; mods can add `auto` to end an `!upbot` / `!downbot` override (see below).
- `!plays` / `!firstplay`: how many times the playing song has been played, every version included, and when and by whom it was first and last played (see [play history](#play-history)).
- `!review`, `!same <n>`, `!different <n>` (mods): answer the play history's tag questions, a few at a time.
- `!pushtest`: send a test push notification to your own devices (the site's Settings has a button for it).
- `!swaps`: how the last swap search went (see [swap suggestions](#swap-suggestions)). `!swapscan` (mods) runs it now for people seen since their last scan; `!swapscan all` for everyone.
- `!ytmtest Artist - Title` (mods): what YouTube Music answers the bot's server for that song (songs, artist videos, fan uploads, the best match), to tell a missing song from a catalog that isn't answering.
- `!genrelists`: how the last update of the [genre playlists on YouTube Music](#genre-playlists-on-youtube-music) went. `!genrelists run` (mods) runs one now.
- `!ytmusic`: how the last sync of the bot's YOUTUBE MUSIC playlist went, or what it's doing now (see [the YOUTUBE MUSIC playlist](#the-youtube-music-playlist)). `!ytsync` (mods) runs one now.

## play history
`tools/history` joins the room's database (with ADAM's history, which was moved into it) and Last.fm into one history of every play since the room began. Every spelling and upload of a song counts as one track, and the room gets true first plays (back past 2023, to its first play) and its own play counts. It runs as a GitHub Action (Actions → **Play history**: weekly, or by hand with a preview first) or from the command line; see [tools/history/README.md](tools/history/README.md). Publishing refuses to replace a better history (fewer tracks or plays than last time, mass tag changes).

Once published (deploy `firebase-rules.json` first), for every song the bot:
- links each upload to its track by its tags (`globalTracks/<upload>/song` → `globalSongs`), so a new copy of an old song shows its real first play
- counts the play on the track and on the song, all versions together (`globalWorks`), and shows the room that count instead of Last.fm's per-spelling one
- logs the play in `playLog` (who, what, when, how long, skipped) and every tag fix in `tagLog`; only the bot can read these

Before a publish, or after `publish --off`, the bot works as it did: per-upload first plays and Last.fm counts. Last.fm scrobbling is unchanged either way.

`!plays` (or `!firstplay`) says what the history knows about the song on the decks. `!review` (mods) asks the next tag question the history couldn't settle; answer with `!same <n>` or `!different <n>`.

## away DJs
Being idle never costs anyone their seat: you can DJ for as long as the room is open in your browser, whether or not you're at the keyboard or the tab is in the background. While you're on deck or in line, the site keeps Chrome from freezing its tab.
- **You closed the browser** (or the tab, signed out, or left the site): after `AWAY_CLOSED_MIN` minutes (default 5) you get one "are you there?" (a notice, and a push if you turned them on). `AWAY_ANSWER_MIN` minutes later (default 5) you catch the bus: you step down after your next song (or the one playing), or leave the waitlist. The room sees ":bus: name left, so they're catching the bus…".
- **Only the connection dropped** (the computer slept, a phone put the browser away, the network went down): you keep your seat. After `AWAY_LOST_HOURS` offline (default 3) you get the same question and bus.
- Coming back online at any point cancels it and takes you off a bus this put you on (not one you caught yourself).
- Needs the latest `firebase-rules.json` published (`users/<uid>/closed` and `offlineAt`). Until then the site can't say a browser was closed, so everyone who goes offline keeps their seat for `AWAY_LOST_HOURS`.

## autopilot DJ
The bot keeps the music going. When no one is DJing it takes the decks and plays its own DJ playlist; once 3 people are DJing it catches the bus, stepping down after its next song (or after the one it's playing), never mid-song. If the count drops below 3 before it leaves, it stays.
- `!upbot` (mods): the bot DJs and stays on, even with a crowd. `!downbot` (mods): it leaves and stays off, even when the decks are empty. A mod's `!add` / `!remove` / `!removeafter` / `!dontremove` aimed at the bot work the same way.
- An override lasts until the next trigger (the decks emptying, or the DJ count reaching 3); then the autopilot takes over again.
- `!autodj` says what the bot is doing; `!autodj auto` (mods) ends an override now.
- The override is saved under `autodj` in the database, so it survives a restart (deploy `firebase-rules.json` for this).
- Stock the bot's DJ playlist by logging in to the site as the bot. If it's empty, the bot says so and tries again 15 minutes later.
- On by default. Set `AUTODJ=false` to turn it off.

## seasons
The site decides the seasonal trading-card avatars and the months the string lights stay on: `js/seasons.js` in firetable-user holds the defaults and its `config.js` (`avatarset`, `avatarSeasons`, `lightsMonths`) overrides them. With `SITE_URL` set, the bot reads both files from the live site at startup and every 10 minutes, so changing them on the site is all it takes; nothing changes on the bot. The bot parses the settings out of those files and never runs them, so the site can't run code on the bot; values that aren't plain data (an expression or a function call) are skipped. The log shows `site seasons: …` at startup and whenever they change. If the site can't be reached, or a file has a syntax error, the bot keeps the last values it read (or the site's defaults: monsters in October, lights in December).

## soundcloud
**How SoundCloud works in the room today (no paid service):**
- Playback on the site uses SoundCloud's embeddable player, which needs no key.
- Before a SoundCloud track plays, the bot checks it still exists and gets its length, title and artwork from SoundCloud's own web API (`api-v2`, the one soundcloud.com uses) with the client id in `SOUNDCLOUD_KEY`. That needs no registered app.
- On the site, pasted SoundCloud links and playlist imports go through the older link resolver; keyword search asks for a link instead (it needs the official API, below).

**Keep it as it is.** SoundCloud's official API only answers requests signed with a registered app's client id *and* client secret, and this room doesn't have one (the site's `api/soundcloud.php` answers `501 not configured`). Switching the bot to the official API without them would make every SoundCloud check fail, so SoundCloud tracks would never play. Leave `SOUNDCLOUD_KEY` set and `SOUNDCLOUD_CLIENT_ID` / `SOUNDCLOUD_CLIENT_SECRET` unset; the log says `soundcloud: web API with SOUNDCLOUD_KEY` at startup.

**The risk, and what to do.** `api-v2` isn't SoundCloud's public API, so they can change it or stop accepting that client id without notice. If that happens, the log shows `couldn't check the track on SoundCloud (not flagging it): HTTP 401` (or 403), and the room is told once that SoundCloud can't be reached. No tracks are flagged; the bot passes the decks so YouTube tracks keep playing. To fix it, put a working client id in `SOUNDCLOUD_KEY` in `.env`, then `pm2 restart hostbot`.

**Adding an official SoundCloud key later** (if the room gets a registered SoundCloud app; SoundCloud reviews app requests, and depending on their current terms that may mean a paid plan):
1. Register the app at https://soundcloud.com/you/apps and note its **client ID** and **client secret**.
2. The site: on the server, copy `api/soundcloud-config.php.example` to `api/soundcloud-config.php` and fill in both values (details in the firetable-user README). Check `https://<your site>/api/soundcloud.php?action=tracks&ids=13158665` answers with JSON, not `501`. Keyword search on the site starts working.
3. The bot: add both values to `.env`, then `pm2 restart hostbot`:
   ```
   SOUNDCLOUD_CLIENT_ID="your client id"
   SOUNDCLOUD_CLIENT_SECRET="your client secret"
   ```
   The log says `soundcloud: official API` at startup. The bot gets an OAuth token and reuses it until it expires (SoundCloud limits how often new ones can be made). Tracks the official API marks as blocked are flagged as unavailable.
4. Keep `SOUNDCLOUD_KEY` in `.env`: removing the two new lines and restarting goes straight back to today's setup.

## tracks that can't play here
Before a track plays, the bot checks it with the same rules (and flag codes) as the site's playlist checker (`lib/checks.js`). It flags the track, moves it to the bottom of the DJ's list and plays their next one when it is:
- YouTube: gone or private (2), blocked in the US (3), not allowed to be embedded on other sites (6), age restricted (7), or a premiere that hasn't started (5)
- SoundCloud: gone (4), blocked, private or not streamable (5), or only a 30-second preview (SoundCloud Go+ snippets; 5). Previews never play.

When YouTube or SoundCloud can't be reached it flags nothing (see the README's soundcloud and troubleshooting notes).

Flagged tracks can stay anywhere in a list (many DJs keep them at the top). The bot finds a DJ's first playable track with one indexed read (`flagged/date`), however many flagged tracks come before it. If a DJ's list has nothing playable (empty, or every track flagged), the bot says so in chat, tells them privately, and takes them off the decks.

## swap suggestions
Every night at 4 a.m. (`SWAP_HOUR`, in `TZ`) the bot looks for a working copy of each broken track in people's playlists and saves it with the track; the site shows a ⇄ button on it, and a **Swap all** bar over the list. Nothing in a playlist changes until its owner swaps (and Undo puts it back).
- **Which tracks:** flagged as gone, private, blocked, not embeddable, age restricted, broken or low audio quality (codes 1–9; not off-theme). YouTube and SoundCloud tracks alike.
- **What counts as a match:** the title, the artists (featured artists may sit in either field) and the version must match: a remix never stands in for the original, live never for studio. A known length must be within 15% (30% for videos, which have intros). Each match is checked with the same rules the bot uses before every song (`lib/checks.js`), so a swapped track plays, and checked to be the right kind (below).
- **Playlist formats** (set on the site, saved in `playlistPrefs/<uid>/format/<listID>`, `0` being the built-in list):
  - **YouTube Music, or not set:** YouTube Music's audio tracks only ("Art Tracks": uploaded by an "Artist - Topic" channel, or described "Provided to YouTube by …" / "Auto-generated by YouTube", for artists whose Topic channel was merged into their own). Music videos, "Official Audio" uploads and fan uploads are never suggested.
  - **YouTube videos:** the artist's **official music video** first: from the artist's channel or VEVO (or the video YouTube Music pairs with the song), titled "Official Video" / "Official Music Video" / "Music Video"; then the artist's other videos. Never an audio track, a fan upload, a lyric video, a visualizer or an "Official Audio" upload. Every candidate for a song is checked (channel and title, from YouTube) and ranked before one is suggested, and the search for a song goes on until it finds the official music video. YouTube Music's Song / Video toggle works the other way too: the song's audio track (from the year playlists or the room) leads to its official video, with no search.
  - **SoundCloud:** a SoundCloud upload of the same recording (title, artists, version, length) that plays in full here, the artist's own upload first. Found with SoundCloud's own search through the same web client id the bot already checks SoundCloud tracks with (`SOUNDCLOUD_KEY`; no registered app or API key). `SOUNDCLOUD_SWAPS=false` turns it off; if SoundCloud stops answering, the summary says so and everything else carries on.
- **Tracks that play but don't fit their playlist's format** get a suggestion too, in playlists with a format set (these are read whole; playlists with none take anything): a music video or SoundCloud track in a YouTube Music playlist gets the audio track; an audio track or SoundCloud track in a video playlist gets the artist's video; a YouTube track in a SoundCloud playlist gets the SoundCloud upload. In a video playlist, a video that isn't the artist's official music video (a promoter's or fan's upload, or the artist's own plain upload) gets the official music video when there is one; when there isn't (an independent remix, a song with no video) it stays as it is. Nothing is flagged; the suggestion carries `why: "format"`. Whether each YouTube upload is an audio track or a video, and how a video ranks for its song, is asked of YouTube once (1 unit per 50) and remembered in `trackKinds/`.
  - **Only suggestions that fit stay.** Each suggestion says what it is (`swap.kind`: `audio` or `video`). Every night a suggestion that doesn't fit its playlist's format is cleared: any suggestion in a SoundCloud playlist, an audio track in a playlist kept to videos, a video in any other, and one on a track since flagged for a reason of its own (off-theme). The track is looked up again for one that fits, in the same run. Suggestions saved before they said what they are are checked with YouTube and kept only if they fit (a video, for a list kept to videos, only if it's the artist's own). The site hides a suggestion that doesn't fit straight away, and clears them when a playlist's format changes. Needs the latest `firebase-rules.json` published (`swap.kind`).
- **Where matches come from, free first.** Each song stops at the first source that has one:
  1. **room history:** other uploads of the same song the room has played (`globalTracks`, linked by the play history).
  2. **year playlists:** the official Indie Discotheque year playlists on YouTube Music (about 27,000 tracks, read with no quota and shared with the [YOUTUBE MUSIC sync](#the-youtube-music-playlist) for 3 hours).
  3. **Song / Video toggle** (audio playlists, no search): YouTube Music pairs a music video with its audio track (the toggle above its player). The bot asks it for the track's own video when it still plays, and the room's other videos of the song.
  4. **YouTube Music search** (no quota). When its Songs search says "No results", the bot first starts a fresh session the way a browser does (the web app's current version and a new visitor id, read from music.youtube.com), then asks as YouTube Music's Android app (`YTMUSIC_ALT_CLIENT=off` turns that off; it rests 6 hours after three empty answers).
  5. **YouTube playlists** (audio playlists, no quota): YouTube's playlist search, then the first page of the top three playlists. YouTube's own searches (free and paid alike) never list YouTube Music's audio tracks, but people's playlists of a song or its album usually hold them.
  6. **YouTube search** (no quota): the artist's videos for video playlists, or an audio track if one shows.
  7. **Deeper looks** (audio playlists, songs every search above missed, `SWAP_MAX_DEEP` a run, default 300): the Song / Video toggle of the artist's official video YouTube's search found; **Apple's catalog** (iTunes Search, free, no key, one lookup every 3.2 seconds; `APPLE_LOOKUP=false` turns it off) for the album the song is on; the **artist's YouTube Music page** (its top songs, the single named after the song, and Apple's album); and the album's own **YouTube Music playlist** ("OLAK5uy_…", every track an audio track) from YouTube's playlist search. Apple never supplies a track itself, only the album to look in.
  8. **Paid search** (YouTube Data API `search.list`, 100 units): nightly runs and `!swapscan` only, and only for songs whose free search (5 for audio playlists, 6 for video playlists) didn't answer at all. It finds the same as the free one, so it's a stand-in for when YouTube stops answering the bot's free searches. The songs in the most lists go first, within `SWAP_API_UNITS` a day (default 1,000: 10 searches; `0` turns it off). A song it misses isn't paid for again for 30 days.
- **A track the bot flags while playing** is looked up straight away (free sources only).
- **When YouTube Music's song catalog doesn't answer:** from some servers its Songs search says "No results" for everything. Until a search in a run has come back with songs, an answer without songs isn't trusted. After three, the bot searches a song YouTube Music certainly has (`YTMUSIC_CANARY`, default "Daft Punk One More Time"). If that has no songs either, YouTube Music isn't asked again that run (the other sources carry on), and nothing it couldn't answer is remembered as "no match". Answers saved before the newest sources existed (no `v: 4`) that found nothing are searched again.
- **`!ytmtest Artist - Title`** (mods) shows what YouTube answers the bot's server for a song: YouTube Music's Songs search, its full search's songs, artist videos and fan uploads, the best match, and YouTube's search (videos, and audio tracks among them).
- **The owner** gets one private notice (toast, and a push when away) when new swaps are ready. "Not this one" on the site keeps that match from being suggested again for 90 days.

**What it costs each night:**
| | |
|---|---|
| Free sources | no key or quota (`lib/ytmusic.js`). One lookup per song (and kind), shared by every copy and spelling in every list, remembered for 30 days in `swapCache/` (a video answer apart from an audio one); searches paced (one every 2.5 seconds) and each kind capped (`SWAP_MAX_SEARCHES`); the rest wait a night |
| YouTube Data API checks | 1 unit per 50 matches checked. Matches confirmed in the last 7 days aren't checked again, and a next-choice match only when the one before fails. Usually a few units a night |
| Paid search | 0 units while the free searches answer; at most `SWAP_API_UNITS` (1,000) a day when they don't |
| Database | only people seen since their last scan (`swapScans/`), only the flagged tracks of their lists (an indexed query on `flagged/date`), never whole playlists; two small reads a song in `globalTracks` |

The log and `!swaps` say what each run did: how many songs each source matched, the searches, and the YouTube units used (search units apart).

**Needs the latest `firebase-rules.json` published** (the `flagged/date` index, `swapCache`, `swapScans`, and the bot reading `playlistPrefs/<uid>/format`; until that last one is published every playlist counts as YouTube Music). Until then the run stops before reading any playlist and the log says so. YouTube Music's search isn't a public API: if YouTube changes it, searches find nothing (the log says `YouTube Music returned nothing` or `isn't answering`), no suggestions are made and nothing else is affected. If the server's region gets no songs from YouTube Music, the same happens. `SWAP_SUGGESTIONS=false` turns it all off.

## the YOUTUBE MUSIC playlist
The bot keeps its playlist called **YOUTUBE MUSIC** in step with the official Indie Discotheque year playlists on YouTube Music (2001 to 2026, about 27,000 tracks). Every day at 5 a.m. (`YTMUSIC_SYNC_HOUR`, in `TZ`), and a few minutes after a start when the last sync is more than a day old, it:
1. **checks every track** in the list with the same rules the bot uses before every song (`lib/checks.js`).
2. **replaces broken tracks** (gone, private, blocked, not embeddable, age restricted, flagged broken; YouTube and SoundCloud alike) in their place with the same recording from YouTube Music, found and matched exactly the way [swap suggestions](#swap-suggestions) are (the same sources: the room's history, the year playlists, YouTube Music's Song / Video toggle and search, people's YouTube playlists, YouTube's search, artist and album pages guided by Apple's catalog, then the capped paid search; title, artists, version and length) and checked to play here. **Only YouTube Music audio tracks are ever used**: YouTube confirms each match is an Art Track (an "Artist - Topic" upload or "Provided to YouTube by …"); videos, "Official Audio" and fan uploads are never put in. A track flagged automatically (gone, blocked, not embeddable, age restricted: codes 1–7) that YouTube says plays again is **unflagged**, as the site's playlist checker does. The track keeps its tags and remembers where it came from (`swappedFrom`). A track with no match **stays in the list**, flagged so the bot skips it, and later syncs keep looking. A track the bot flags while playing from this list is replaced straight away.
3. **adds new songs** from the year playlists, oldest year first: only tracks that can play here, and **never DJ-mixed compilation tracks** ("(Mixed)" in the title, or an album "Mixed by …", "(Mixed)", "Continuous Mix", "DJ Mix", "Mix Cut"). Remixes, "Unmixed DJ" editions and songs called "Mixed Emotions" are fine.
4. **swaps YouTube videos for YouTube Music tracks**, first through YouTube Music's own Song / Video toggle for the video: every playable track that isn't a YouTube Music audio track (anything not uploaded by an "Artist - Topic" channel: music videos, "Official Audio" uploads, fan uploads), in the list or coming in from the year playlists, is replaced by the same song's audio track: same artists, title and version, a length within 45 seconds or 30% of the video's (intros and outros), never DJ-mixed. It takes the video's place and gets YouTube Music's name for the song ("Radiohead - Karma Police", not "… (Official Video)"). When the list already has that audio track, the video is removed. A video with no audio track yet **stays**, and later syncs keep looking.
5. **removes duplicates**: the same upload twice, or the same song (title, artists and version) within 3 seconds (`YTMUSIC_DUPE_SECONDS`) of the same length. The copy kept is a **YouTube Music track** if there is one, **the earliest in the list that can play**. Each track saves when it joined (`added`) and its length (`duration`), so "earliest" holds through shuffles and a track that breaks later can still be matched.
6. **shuffles** the whole list.

**Flags stay.** A track someone flagged for a reason of their own (off-theme, low quality), video or not, is never replaced, renamed or unflagged, and no copy of it from the year playlists is added. Tracks flagged as broken stay flagged until a working copy replaces them. When duplicates include such a copy, that copy is the one kept, with its flag.

**Only this playlist changes.** The bot's other lists and everyone else's are never touched. Tracks saved by their title alone ("Lose Control") get their artist from their " - Topic" channel ("Young Franco - Lose Control"), the name the room already shows when they play. Everything is saved in one transaction at the end, so a track the bot plays, moves or flags meanwhile is never lost or doubled, and a sync that stops (YouTube's quota, an outage) changes nothing. If the bot has no playlist by that name, the first sync makes it.

**What it costs:** the year playlists and the searches come from YouTube Music with no key or quota (`lib/ytmusic.js`); when YouTube Music can't answer for a playlist, the bot reads it with the YouTube Data API instead. Checking tracks is 1 YouTube Data API unit per 50: about 550 units a sync for 27,000 tracks, of the 10,000 a day. Lookups are remembered for 30 days in `swapCache/`, shared with swap suggestions (so the nightly swap search's finds for this list are reused, and the other way round); searches are paced one every 2.5 seconds and capped at 1,000 per source a sync (`YTMUSIC_MAX_SEARCHES`), and the paid search shares swap suggestions' daily `SWAP_API_UNITS`. Matches in the room's history and the year playlists need no search at all. Broken tracks go first, and anything over the cap waits for the next day's sync, so thousands of broken tracks or videos are worked through over a few days. While it runs, `!ytmusic` says how far the lookup is (`looking up songs (500 of 6949)`).

**A new year:** add its playlist to `SOURCES` in `lib/ytmsync.js`, or set `YTMUSIC_SOURCES` in `.env` (`2027=link, 2026=link, …`; it replaces the built-in list).

`!ytmusic` says what the last sync did in one chat line (replaced, still broken, unflagged, videos swapped, new, duplicates, and why it stopped early, if it did); the log (`youtube music: …`) and `ytmSync/summary` have the full summary, with where the replacements were found. Needs the latest `firebase-rules.json` published (`ytmSync`, where the last sync is remembered); until then the log says so and the bot syncs after every restart. `YTMUSIC_SYNC=false` turns it off.

## genre playlists on YouTube Music
A public playlist for each genre on the room's YouTube account, **"Indie Discotheque · Nu-Disco"** and so on: the genre's 50 room favorites (its most played YouTube songs here, from the weekly [play history](#play-history)), with the genre's line and a link to its page on the site in the description (`SITE_URL`). The site's genre pages link to them. Genres with fewer than 20 YouTube songs get none. Every day at 6 a.m. (`YTM_PLAYLIST_HOUR`) the bot brings each playlist in step with that week's favorites: songs that dropped out are taken out, new ones added, and a song YouTube won't take (gone, private) is skipped for 30 days with the next one in its place (`lib/ytplaylists.js`).

**What it costs:** adding or taking out a song is 50 of YouTube's 10,000 daily quota units, so a run spends at most 4,000 (`YTM_PLAYLIST_UNITS`), biggest genres first, and stops there: the first fill takes a couple of weeks, after which a day's changes are a few hundred units. `!genrelists` says how the last run went.

**Connect the account (once):**
1. In the [Google Cloud console](https://console.cloud.google.com/), in the project that has the bot's `YOUTUBE_KEY`: **APIs & Services → OAuth consent screen**: set it up (External), add yourself as a test user, then **Publish app** (a test-mode sign-in stops working after 7 days).
2. **Credentials → Create credentials → OAuth client ID → Desktop app.** Copy its client ID and secret.
3. On your computer, in this repository: `node tools/youtube-auth.js <client id> <client secret>`. Sign in as the YouTube account that should own the playlists (Google warns the app isn't verified: **Advanced → Go to …**), and allow it.
4. Put the three lines it prints in the bot's `.env` and restart the bot. `!genrelists run` (mods) starts the first run straight away.

If the sign-in is ever refused (the account's password changed, access removed), `!genrelists` and the log say so: run step 3 again. A playlist deleted on YouTube is made again the next day.

## discover
The site's Discover side shows the library to everyone, signed in or not. Most of it reads data that's already public (Recent, Fresh, the play history's songs and genres, tempos). The bot publishes the rest under `discover/`, which anyone can read and only the bot writes (`lib/discover.js`):
- **Room charts** (`discover/charts/<period>/<id>`): this week's (`2026-W45`), month's (`2026-11`) and year's (`2026`) most played songs, from the play log, and the all-time chart from the play history's counts. A play counts when the song ran out or played for 30 seconds; fires never change a chart. Weekly charts show places up or down, new entries, re-entries and weeks in a row. Weeks run Monday to Monday in `TZ`. The week's chart is rebuilt a minute after each play; the others once a day. Each period is finished off once it's over, so old charts stay as they ended, and `discover/chartIds/<period>` lists them.
- **New releases** (`discover/new`): songs in the current year's playlist (and last year's, January to March) released in the last 90 days, newest first, whether or not the room has played them yet. Songs join the year playlists whenever, so each one's release date is looked up once on YouTube ("Released on" for "Artist - Topic" uploads, otherwise the upload date; 1 quota unit per 50 songs) and kept in `discoverCache/`. Each comes with its room plays, who played it first, and its artwork colour. Once a day.
- **Theme nights** (`discover/themes/index`, `discover/themes/night/<id>`): plays under one room theme, no more than 2 hours apart, with their songs in order, DJs and fires. The bot saves the theme and the `!hot` fires with each play (`playLog` `th` and `f`) since November 2026, so the archive starts there and grows. The latest night is updated a minute after each play, and the whole archive once a day. Nights under 3 songs are left out. Chart rows show their fires too, but fires never change a chart.
- **Genre playlists** (`discover/ytm/<slug>`): each genre's YouTube Music playlist id, once the bot has made it (see [genre playlists on YouTube Music](#genre-playlists-on-youtube-music)).
- **Fires earned** (`discover/fires`): each DJ's `!hot` fires since November 2026, how many of their plays got any, and their 10 most-fired songs, plus `index`, every DJ by fires. Rebuilt once a day. DJs who turned off "Show my name on public pages" aren't listed.
- **Chat peek** (`discover/chat`): the last 20 messages for visitors, who can't read the chat itself, without bot commands or hidden messages, and how many messages there were in the last hour.

Members choose whether their name shows on these public pages: `users/<uid>/publicName = false` (a setting on the site) shows them as nobody in charts, new releases and the chat peek. The site also saves which Discover page each new member first came from (`users/<uid>/foundVia`, set once), so you can tell which pages bring people in.

Needs the latest `firebase-rules.json` published (`discover`, `discoverCache`, the user settings, including `users/<uid>/featured`, the up to 6 cards a member picks for their DJ page, and indexes on `globalSongs/plays` and `globalTracks/song`); until then the log says once what it couldn't save and the bot carries on. The all-time chart needs the [play history](#play-history) published. `DISCOVER=false` turns it all off.

## one copy at a time
Only one copy of the bot runs the room. The running copy holds `botLock` in the database; another copy (say, one started on a laptop with the live `.env`) logs `another copy of the bot is running` and waits, taking over only if the first stops. A copy that loses the lock to another stops itself (pm2 then restarts it, and it waits). Needs the latest `firebase-rules.json` published; before that the log says so and the bot runs as before.

## push notifications
People who install the site as an app (Add to Home Screen on iPhone/iPad, Install app on Android) and turn on **Settings → Push @mentions to this device** get a notification on their phone when someone @mentions them, even with the app closed. It works in desktop browsers too.
- **What's sent:** every mention that lands in the site's @ inbox; the bot's private notices (see below); and `@everyone` from mods and the bot, to devices that turned that on (at most one every 10 minutes). Tapping a notification opens the room's @ inbox; the app icon shows the unread count where the phone supports it.
- **Not sent:** while you're looking at the room (online and not idle), to people blocked either way, or for messages more than 10 minutes old. At most 6 a minute per person, to their 10 most recently used devices.
- **Setup: none.** On first start the bot makes a key pair (VAPID), keeps it under `pushVapid` in the database (only bot accounts can read it) and publishes the public half as `pushKey`; the log says `push: on (new keys saved in the database, …)`, then `push: on (keys from the database, …)` on later starts. It needs the latest `firebase-rules.json` published; until then the log says so and push stays off.
- Each device is saved under `pushSubs/<uid>/` (the site writes it; only that person and the bot can read it). The bot posts only to Apple's, Google's, Mozilla's and Microsoft's push services, removes devices those services say are gone, and drops devices not opened in 60 days.
- The notification's contact address (VAPID subject) is `SITE_URL`'s address, or `VAPID_SUBJECT` (a `mailto:` or `https:` address) if set.
- Changing the keys (setting `VAPID_*`, or deleting `pushVapid`) means every device has to sign up again; the site does it on its own the next time each one opens the room.
- `PUSH_NOTIFICATIONS=false` turns it off. Sent pushes are logged as `push: mention for <name> to N device(s)`.

## private notices
The bot doesn't @ping people in chat. What's meant for one person (someone gave you a card, your GRAB was too late, a mod put you on the bus, "are you there?" when you're on deck and closed the browser, the track you queued can't play) goes to `notices/<uid>/`: the site shows it as a toast and removes it, and the person also gets a push notification when they're away from the room. Notices left over after a day are cleared. Needs the latest `firebase-rules.json` published; until then the log says so once and the bot pings in chat as before.

## trading cards
Now and then (or with a supermod's `!printcard`) the bot prints a card of the song playing. Its chat message carries the card's id (`grab`), and the site shows a big GRAB button under it. The button sends `!grab <card id>` as a hidden bot command; typing `!grab` still works and takes whichever card is up. The first one gets the card and the room sees "<name> grabbed the card!" with the card. Anyone too late, or grabbing a card that a newer one replaced, gets a private notice and their button greys out. Needs the latest `firebase-rules.json` published (the `grab` field on chat messages); until then the log says so once and the bot asks for `!grab` in chat as before.

## last.fm
With the `LASTFM_*` settings, each song is sent to last.fm as "now playing" and scrobbled when it ends, or when it's skipped after playing long enough by last.fm's rule (longer than 30 seconds, and played for half its length or 4 minutes).

## timing
Song start times (`songToPlay/started`, and the "when" of each play) use the database's clock (`.info/serverTimeOffset`), the same clock firetable-user uses. Every listener's position, the progress bar and the DJ's bop line up even if this server's clock drifts.

## tempo lookups
When a song starts, the bot looks up its BPM on Deezer's public API (no key needed): it searches for the artist and title, and tries up to four matching versions of the song, since Deezer has no tempo for many tracks. Results, including "not found", are cached per track in `bpm/`, and the playing song's tempo is published as `songBpm`. A tempo set with `!bpm` is never overwritten by a lookup. "Not found" results from an older version of the lookup are tried again.

## database rules
`firebase-rules.json` is applied separately: Firebase console → Realtime Database → Rules, paste the file, Publish (or `npx firebase deploy --only database` with the Firebase CLI; `firebase.json` points at the file). Updating or restarting the bot doesn't change the rules, so deploy them whenever this file changes.

Playlists and queues have no limit on how many tracks they hold (the bot's own crate is over 10,000). The rules only check each track's fields: `type` and `cid` are short text or numbers (older imports saved them as text), `name` is text up to 1,000 characters, `img` / `url` links up to 2,048, `flagged` is `{date, code}`, `swap` is the bot's suggestion (a YouTube id, artist, title, album, length, date, or `dismissed`), `swappedFrom` is `{type, cid, date}`, and any other field can't be text over 2,048 characters. Playlist names, and the artist / title mods fix in Recent and the global tags, are text up to 500 characters. The tests reorder a 12,000-track list to make sure big lists keep working.

Usernames are unique whatever their case ("Boss" and "boss" are one name): names are claimed in lowercase under `nameClaim/`. The bot gives every existing name its lowercase claim when it starts (and every 6 hours); if two older accounts differ only in case, the earlier member keeps the claim and the log says so.

Chat messages are saved together with their chat feed entry in one write. Older copies of the site that save them in three steps keep working. The bot acts on each message once, and ignores commands more than 2 minutes old (sent before a long disconnect, or a copy of an old message added to the feed again).

## tests
`.github/workflows/test.yml` runs on every push and pull request: ESLint on `app.js`, `lib/` and `tools/` (it catches undeclared variables), unit tests of the helpers in `lib/` (push encryption is checked against `http_ece`, the reference implementation; the YOUTUBE MUSIC sync against an in-memory database, with DJ-mix titles from the real year playlists), the tag matcher and the play history toolkit on sample ADAM / Last.fm / Firebase exports, the rules against the Firebase emulator (what users mustn't write, and everything the site and bot do write), the bot itself in the emulators with fake YouTube / SoundCloud / push-service answers (outages, broken tracks, skips, commands, names, push notifications, the YOUTUBE MUSIC sync, restarts), and the auto-update script with a fake pm2. Run them on your computer (Java 21 needed for the emulators):
```
npm ci && cd test && npm ci && npm test
```
Nothing in `test/` is installed on the bot server.
