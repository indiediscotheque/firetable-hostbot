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
| `LASTFM_APIKEY` / `LASTFM_SESSIONKEY` / `LASTFM_USERNAME` | optional: scrobble plays to last.fm |
| `ADAM_URL` | optional: server that's sent each new song |
| `AVATARSET` | optional: one Robohash set for new trading cards all year |
| `LIGHTS_MONTHS` | optional: months the string lights are on, e.g. `11,12` (match `config.js` in firetable-user) |

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
```
In nano: Ctrl+O, Enter, Ctrl+X saves and exits. To send a `.env` you already have from your PC instead (`exit` back to PowerShell first):
`scp -i $HOME\.ssh\hostbot.key .env ubuntu@<server-ip>:~/firetable-hostbot/.env`

A healthy start logs the bot's user id, the DJ/waitlist state, then `Listening now.`

### update
```
cd ~/firetable-hostbot && git pull && npm install && pm2 restart hostbot
```
If `firebase-rules.json` changed, deploy the rules too.

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
| `quotaExceeded` (YouTube) | wait; the quota resets at midnight Pacific |
| `ENOSPC` / no space left | `pm2 flush && pm2 restart hostbot` |

Broke right after an update? Go back one version:
`cd ~/firetable-hostbot && git checkout HEAD~1 && npm install && pm2 restart hostbot`
Return to the latest later with `git checkout master && git pull && npm install && pm2 restart hostbot`.

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

## timing
Song start times (`songToPlay/started`, and the "when" of each play) use the database's clock (`.info/serverTimeOffset`), the same clock firetable-user uses. Every listener's position, the progress bar and the DJ's bop line up even if this server's clock drifts.

## tempo lookups
When a song starts, the bot looks up its BPM on Deezer's public API (no key needed). Results, including "not found", are cached per track in `bpm/`, and the playing song's tempo is published as `songBpm`. A tempo set with `!bpm` is never overwritten by a lookup.

## database rules
`firebase-rules.json` is applied separately: Firebase console → Realtime Database → Rules, paste the file, Publish. Updating or restarting the bot doesn't change the rules, so deploy them whenever this file changes.
