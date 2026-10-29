# firetable-hostbot
node.js "chatbot" back end for firetable, a virtual music listening room powered by firebase.

pairs with a client side front end ([firetable-user](https://github.com/mxew/firetable-user)).

## install
- `git clone https://github.com/mxew/firetable-hostbot.git`
- cd to created directory and `npm install` to get dependencies
- make copy of .env.example, rename to `.env`, add in your api keys and the bot's firetable login credentials
- `node app.js` to run

## dependencies
- node.js
- dotenv ^8.2.0
- firebase ^7.9.1
- youtube-node ^1.3.3
- node-soundcloud 0.0.6
- node-vibrant ^3.0.0

## commands added recently
- `!removeafter` / `!dontremoveme`: step down after your next song, or cancel it. Mods can add a name (`!removeafter name`, `!dontremove name`) to do it for someone of lower rank.
- `!fixtags artist - title`: correct the playing song's tags (only the first " - " splits artist from title).
- `!flagplay <play id> <reason>` (mods): flag a play from Recent in the DJ's queue and all of their playlists. Reasons: `broken`, `quality`, `offtheme`.
- `!bpm`: say the playing song's tempo. The DJ or a mod can set it with `!bpm 128`.

## timing
Song start times (`songToPlay/started`, and the "when" of each play) use the database's clock (`.info/serverTimeOffset`), the same clock firetable-user uses. Every listener's position, the progress bar and the DJ's bop line up even if this server's clock drifts.

## tempo lookups
When a song starts, the bot looks up its BPM on Deezer's public API (no key needed). Results, including "not found", are cached per track in `bpm/`, and the playing song's tempo is published as `songBpm`. A tempo set with `!bpm` is never overwritten by a lookup.

## database rules
`firebase-rules.json` is applied separately: Firebase console → Realtime Database → Rules, paste the file, Publish. Updating or restarting the bot doesn't change the rules, so deploy them whenever this file changes.
