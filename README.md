# firetable-hostbot
node.js "chatbot" back end for firetable, a virtual music listening room powered by firebase.

pairs with a client side front end ([firetable-user](https://github.com/mxew/firetable-user)).

## install
Needs Node.js 18 or newer (22 recommended).
- `git clone https://github.com/indiediscotheque/firetable-hostbot.git`
- `cd firetable-hostbot` and `npm install`
- copy `.env.example` to `.env` and fill it in (see below)
- deploy `firebase-rules.json` (see [database rules](#database-rules))
- `npm start` to run (or use pm2, below, to keep it running)

### .env settings
| setting | what it's for |
|---|---|
| `FIRETABLE_USER` / `FIRETABLE_PASS` | the bot's firetable login |
| `FIREBASE_KEY` / `FIREBASE_AUTH` / `FIREBASE_DB` | Firebase console → ⚙️ Project settings → General → Your apps |
| `YOUTUBE_KEY` | Google Cloud API key with YouTube Data API v3 enabled |
| `SOUNDCLOUD_KEY` | SoundCloud client id |
| `AUTODJ` | autopilot DJ, on unless set to `false` |
| `TRACKBROKEN_MESSAGES` | `true` to tell a DJ in chat when their song is broken or blocked (off by default) |
| `LASTFM_APIKEY` / `LASTFM_SECRET` / `LASTFM_SESSIONKEY` / `LASTFM_USERNAME` | optional: scrobble plays to last.fm (`LASTFM_SECRET` is the API key's "Shared secret" at last.fm/api/accounts) |
| `ADAM_URL` | optional: server that's sent each new song |
| `SITE_URL` | the firetable-user site's address; the bot follows its seasons from there (see [seasons](#seasons)) |
| `TZ` | time zone for the seasonal months, e.g. `America/Chicago` (default: the server's, usually UTC) |
| `AVATARSET` / `LIGHTS_MONTHS` | optional: force a card avatar set / lights months (e.g. `11,12`) instead of following the site; leave unset |

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
cd firetable-hostbot && npm install
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
`bash scripts/auto-update.sh --install` (once) makes the server check GitHub every 5 minutes. When `master` has new commits it pulls them, runs `npm install` if `package.json` changed, checks `app.js` loads, and restarts the bot. If that check or the install fails, it puts the old code back, leaves the bot running, and skips that version until a newer commit lands. Nothing runs when nothing changed.
- what it did: `cat ~/firetable-hostbot/auto-update.log`
- update right now: `bash ~/firetable-hostbot/scripts/auto-update.sh`
- turn it off: `bash ~/firetable-hostbot/scripts/auto-update.sh --uninstall`
- it pauses (and says so in the log) while you're on another branch or a rolled-back version, or if files in the folder were edited by hand. `.env` edits are fine.

Two things it can't do for you: if `firebase-rules.json` changed, deploy the rules; if a new `.env` setting was added, add it (`.env.example` lists them).

Without auto-update: `cd ~/firetable-hostbot && git pull && npm install && pm2 restart hostbot`

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
| `wrong-password`, `user-not-found` | `nano ~/firetable-hostbot/.env`, fix `FIRETABLE_USER` / `FIRETABLE_PASS`, `pm2 restart hostbot` |
| `PERMISSION_DENIED` | redeploy `firebase-rules.json` |
| `Cannot find module` | `cd ~/firetable-hostbot && npm install && pm2 restart hostbot` |
| `quotaExceeded` (YouTube), `couldn't check the track` | wait; the YouTube quota resets at midnight Pacific. Until then the bot retries, then passes the decks along (SoundCloud tracks still play). It never flags tracks it couldn't check |
| `ENOSPC` / no space left | `pm2 flush && pm2 restart hostbot` |
| bot is on old code | `cat ~/firetable-hostbot/auto-update.log` says why (paused, failed check, GitHub unreachable) |

Broke right after an update? `cat ~/firetable-hostbot/auto-update.log` shows what changed and when. Go back one version (this also pauses auto-update):
`cd ~/firetable-hostbot && git checkout HEAD~1 && npm install && pm2 restart hostbot`
Return to the latest (and resume auto-update) with `git checkout master && git pull && npm install && pm2 restart hostbot`.

**4. Server off or frozen** (works from a phone). cloud.oracle.com → Compute → Instances → the instance. **Stopped** → Start; **Running** → Reboot → Force reboot. pm2 starts the bot on boot, so check the room after ~2 minutes.

**5. Fresh reinstall** (keeps `.env`):
```
cd ~
pm2 delete hostbot
mv firetable-hostbot firetable-hostbot-old
git clone https://github.com/indiediscotheque/firetable-hostbot.git
cp firetable-hostbot-old/.env firetable-hostbot/
cd firetable-hostbot && npm install
pm2 start app.js --name hostbot && pm2 save
```

## dependencies
- node.js 18+
- dotenv ^8.2.0
- firebase ^8.10.0
- youtube-node ^1.3.3
- node-soundcloud 0.0.6
- node-vibrant ^3.1.5
- request (loaded through youtube-node)

## commands added recently
- `!removeafter` / `!dontremoveme`: step down after your next song, or cancel it. Mods can add a name (`!removeafter name`, `!dontremove name`) to do it for someone of lower rank.
- `!fixtags artist - title`: correct the playing song's tags (only the first " - " splits artist from title).
- `!flagplay <play id> <reason>` (mods): flag a play from Recent in the DJ's queue and all of their playlists. Reasons: `broken`, `quality`, `offtheme`.
- `!bpm`: say the playing song's tempo. The DJ or a mod can set it with `!bpm 128`.
- `!autodj`: say what the autopilot DJ is doing; mods can add `auto` to end an `!upbot` / `!downbot` override (see below).

## autopilot DJ
The bot keeps the music going. When no one is DJing it takes the decks and plays its own DJ playlist; once 3 people are DJing it catches the bus, stepping down after its next song (or after the one it's playing), never mid-song. If the count drops below 3 before it leaves, it stays.
- `!upbot` (mods): the bot DJs and stays on, even with a crowd. `!downbot` (mods): it leaves and stays off, even when the decks are empty. A mod's `!add` / `!remove` / `!removeafter` / `!dontremove` aimed at the bot work the same way.
- An override lasts until the next trigger (the decks emptying, or the DJ count reaching 3); then the autopilot takes over again.
- `!autodj` says what the bot is doing; `!autodj auto` (mods) ends an override now.
- The override is saved under `autodj` in the database, so it survives a restart (deploy `firebase-rules.json` for this).
- Stock the bot's DJ playlist by logging in to the site as the bot. If it's empty, the bot says so and tries again 15 minutes later.
- On by default. Set `AUTODJ=false` to turn it off.

## seasons
The site decides the seasonal trading-card avatars and the months the string lights stay on: `js/seasons.js` in firetable-user holds the defaults and its `config.js` (`avatarset`, `avatarSeasons`, `lightsMonths`) overrides them. With `SITE_URL` set, the bot reads both files from the live site at startup and every 10 minutes, so changing them on the site is all it takes; nothing changes on the bot. The log shows `site seasons: …` at startup and whenever they change. If the site can't be reached the bot keeps the last values it read (or the site's defaults: monsters in October, lights in December).

## timing
Song start times (`songToPlay/started`, and the "when" of each play) use the database's clock (`.info/serverTimeOffset`), the same clock firetable-user uses. Every listener's position, the progress bar and the DJ's bop line up even if this server's clock drifts.

## tempo lookups
When a song starts, the bot looks up its BPM on Deezer's public API (no key needed). Results, including "not found", are cached per track in `bpm/`, and the playing song's tempo is published as `songBpm`. A tempo set with `!bpm` is never overwritten by a lookup.

## database rules
`firebase-rules.json` is applied separately: Firebase console → Realtime Database → Rules, paste the file, Publish. Updating or restarting the bot doesn't change the rules, so deploy them whenever this file changes.
