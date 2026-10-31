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
| `SWAP_HOUR` / `SWAP_MAX_SEARCHES` | optional: the hour the swap search runs (in `TZ`, default `4`) and its search limit per run (default `300`) |
| `PUSH_NOTIFICATIONS` | push @mentions to phones and computers, on unless set to `false` (see [push notifications](#push-notifications)) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | optional, leave unset: the bot makes its own push keys. Set them only to bring keys from elsewhere |

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

YouTube is checked with one direct call to the YouTube Data API (`videos.list`, 1 unit of quota per song). Swap suggestions search YouTube Music with no API key or quota (`lib/ytmusic.js`) and check their matches 50 at a time (1 unit per call).

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

## play history
`tools/history` joins the room's database (with ADAM's history, which was moved into it) and Last.fm into one history of every play since the room began. Every spelling and upload of a song counts as one track, and the room gets true first plays (back past 2023, to its first play) and its own play counts. It runs as a GitHub Action (Actions → **Play history**: weekly, or by hand with a preview first) or from the command line; see [tools/history/README.md](tools/history/README.md). Publishing refuses to replace a better history (fewer tracks or plays than last time, mass tag changes).

Once published (deploy `firebase-rules.json` first), for every song the bot:
- links each upload to its track by its tags (`globalTracks/<upload>/song` → `globalSongs`), so a new copy of an old song shows its real first play
- counts the play on the track and on the song, all versions together (`globalWorks`), and shows the room that count instead of Last.fm's per-spelling one
- logs the play in `playLog` (who, what, when, how long, skipped) and every tag fix in `tagLog`; only the bot can read these

Before a publish, or after `publish --off`, the bot works as it did: per-upload first plays and Last.fm counts. Last.fm scrobbling is unchanged either way.

`!plays` (or `!firstplay`) says what the history knows about the song on the decks. `!review` (mods) asks the next tag question the history couldn't settle; answer with `!same <n>` or `!different <n>`.

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

## swap suggestions
Every night at 4 a.m. (`SWAP_HOUR`, in `TZ`) the bot looks for a working copy of each broken track in people's playlists and saves it with the track; the site shows a ⇄ button on it, and a **Swap all** bar over the list. Nothing in a playlist changes until its owner swaps (and Undo puts it back).
- **Which tracks:** flagged as gone, private, blocked, not embeddable, age restricted, broken or low audio quality (codes 1–9; not off-theme). YouTube and SoundCloud tracks alike.
- **What counts as a match:** YouTube Music's audio tracks only (the labels' "Artist - Topic" uploads). Music videos, "Official Audio" uploads and fan uploads are never suggested. The title, the artists (featured artists may sit in either field) and the version must match: a remix never stands in for the original, live never for studio. A known length must be within 15%. Each match is checked with the same rules the bot uses before every song (`lib/checks.js`), so a swapped track plays.
- **A track the bot flags while playing** is looked up straight away (one search).
- **The owner** gets one private notice (toast, and a push when away) when new swaps are ready. "Not this one" on the site keeps that match from being suggested again for 90 days.

**What it costs each night:**
| | |
|---|---|
| YouTube Music searches | free, no key or quota (`lib/ytmusic.js`, the search music.youtube.com itself uses). One per song, shared by every copy and spelling in every list, remembered for 30 days in `swapCache/`; paced (one every 2.5 seconds) and capped (`SWAP_MAX_SEARCHES`) |
| YouTube Data API | 1 unit per 50 matches checked. Matches confirmed in the last 7 days aren't checked again, and a second-choice match only when the first fails. A typical night is 0–5 units of the 10,000 |
| Database | only people seen since their last scan (`swapScans/`), and only the flagged tracks of their lists (an indexed query on `flagged/date`), never whole playlists |

The log and `!swaps` say what each run did, including the YouTube units it used.

**Needs the latest `firebase-rules.json` published** (the `flagged/date` index, `swapCache`, `swapScans`). Until then the run stops before reading any playlist and the log says so. YouTube Music's search isn't a public API: if YouTube changes it, searches find nothing (the log says `YouTube Music returned nothing` or `isn't answering`), no suggestions are made and nothing else is affected. If the server's region gets no songs from YouTube Music, the same happens. `SWAP_SUGGESTIONS=false` turns it all off.

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
The bot doesn't @ping people in chat. What's meant for one person (you got a card, someone gave you a card, a mod put you on the bus, "are you there?" when you're on deck and went quiet, the track you queued can't play) goes to `notices/<uid>/`: the site shows it as a toast and removes it, and the person also gets a push notification when they're away from the room. Notices left over after a day are cleared. Needs the latest `firebase-rules.json` published; until then the log says so once and the bot pings in chat as before.

## last.fm
With the `LASTFM_*` settings, each song is sent to last.fm as "now playing" and scrobbled when it ends, or when it's skipped after playing long enough by last.fm's rule (longer than 30 seconds, and played for half its length or 4 minutes).

## timing
Song start times (`songToPlay/started`, and the "when" of each play) use the database's clock (`.info/serverTimeOffset`), the same clock firetable-user uses. Every listener's position, the progress bar and the DJ's bop line up even if this server's clock drifts.

## tempo lookups
When a song starts, the bot looks up its BPM on Deezer's public API (no key needed). Results, including "not found", are cached per track in `bpm/`, and the playing song's tempo is published as `songBpm`. A tempo set with `!bpm` is never overwritten by a lookup.

## database rules
`firebase-rules.json` is applied separately: Firebase console → Realtime Database → Rules, paste the file, Publish (or `npx firebase deploy --only database` with the Firebase CLI; `firebase.json` points at the file). Updating or restarting the bot doesn't change the rules, so deploy them whenever this file changes.

Playlists and queues have no limit on how many tracks they hold (the bot's own crate is over 10,000). The rules only check each track's fields: `type` and `cid` are short text or numbers (older imports saved them as text), `name` is text up to 1,000 characters, `img` / `url` links up to 2,048, `flagged` is `{date, code}`, `swap` is the bot's suggestion (a YouTube id, artist, title, album, length, date, or `dismissed`), `swappedFrom` is `{type, cid, date}`, and any other field can't be text over 2,048 characters. Playlist names, and the artist / title mods fix in Recent and the global tags, are text up to 500 characters. The tests reorder a 12,000-track list to make sure big lists keep working.

Usernames are unique whatever their case ("Boss" and "boss" are one name): names are claimed in lowercase under `nameClaim/`. The bot gives every existing name its lowercase claim when it starts (and every 6 hours); if two older accounts differ only in case, the earlier member keeps the claim and the log says so.

Chat messages are saved together with their chat feed entry in one write. Older copies of the site that save them in three steps keep working. The bot acts on each message once, and ignores commands more than 2 minutes old (sent before a long disconnect, or a copy of an old message added to the feed again).

## tests
`.github/workflows/test.yml` runs on every push and pull request: ESLint on `app.js`, `lib/` and `tools/` (it catches undeclared variables), unit tests of the helpers in `lib/` (push encryption is checked against `http_ece`, the reference implementation), the tag matcher and the play history toolkit on sample ADAM / Last.fm / Firebase exports, the rules against the Firebase emulator (what users mustn't write, and everything the site and bot do write), the bot itself in the emulators with fake YouTube / SoundCloud / push-service answers (outages, broken tracks, skips, commands, names, push notifications, restarts), and the auto-update script with a fake pm2. Run them on your computer (Java 21 needed for the emulators):
```
npm ci && cd test && npm ci && npm test
```
Nothing in `test/` is installed on the bot server.
