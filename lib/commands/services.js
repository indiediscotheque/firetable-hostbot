// The bot's background jobs, by hand (mods): swap suggestions, the YOUTUBE MUSIC
// sync, genre playlists, social posting, YouTube Music checks, and a push test.
// Each command is function(room, m): room is app.js's room (lib/commands.js),
// m the message: {chatData, command, args, sender, senderIsMod, senderIsSupermod, namebo}.
"use strict";

// !pushtest
function pushtest(room, m) {
  var chatData = m.chatData, namebo = m.namebo;
  // a test notification to your own devices (the site's settings
  // send it hidden, as a bot command; typed in chat, the bot answers)
  var quiet = !!chatData.botCmd;
  if (!room.push.vapid) {
    if (!quiet) room.talk(namebo + ", push notifications aren't set up on the bot.");
  } else {
    room.push.toUser(chatData.id, {
      kind: "test", title: "Push notifications are on", body: "You'll get @mentions here when you're away from the room.",
      tag: "test", url: "./", time: room.serverNow()
    }, { force: true, ttl: 5 * 60 }).then(function(n) {
      if (!quiet) room.talk(n ? namebo + ", sent a test notification to " + n + " device" + (n == 1 ? "" : "s") + "." :
        namebo + ", none of your devices get push notifications yet: turn them on in Settings.");
    });
  }
}

// !ytmtest
function ytmtest(room, m) {
  var args = m.args, senderIsMod = m.senderIsMod, namebo = m.namebo;
  // !ytmtest Artist - Title (mods): what YouTube Music answers this
  // server, to tell a missing song from a catalog that isn't answering
  if (!senderIsMod) {
    room.talk("Only mods can run !ytmtest, " + namebo + ".");
  } else if (!(args || "").trim()) {
    room.talk("Use !ytmtest Artist - Title");
  } else {
    var ytmName2 = String(args).trim().slice(0, 200);
    var ytmQuery = room.swaps.queryFor(ytmName2) || ytmName2;
    var webAnswer = room.ytmusic.webSearch(ytmQuery).catch(function() { return null; });
    room.ytmusic.diagnose(ytmQuery).then(function(d) {
      return webAnswer.then(function(w) { return Object.assign({ web: w }, d); });
    }).then(function(d) {
      var best = room.swaps.rankMatches(ytmName2, d.songs)[0];
      var k = d.kinds;
      var line = ":mag: YouTube Music for \"" + ytmQuery + "\" from my server: Songs search " +
        (d.catalog ? d.catalog + (d.catalog === 1 ? " result" : " results") + " (" + d.catalogSongs + " songs)" : "NO RESULTS (the song catalog isn't answering me)") +
        "; full search " + k.songs + " songs, " + k.videos + " artist videos, " + k.uploads + " fan uploads" + (k.other ? ", " + k.other + " other" : "") +
        ". " + (best ? "Best match: " + best.title + " · " + best.artist + (best.dur ? " (" + Math.floor(best.dur / 60) + ":" + String(best.dur % 60).padStart(2, "0") + ")" : "") + " youtu.be/" + best.cid
          : d.songs.length ? "None of the " + d.songs.length + " songs is the same recording." : "No songs to match.") +
        " YouTube search: " + (d.web ? d.web.length + " videos, " + d.web.filter(room.swaps.isArtTrack).length + " audio tracks" : "no answer") + ".";
      room.talk(room.fitChat(line));
    }, function(err) {
      room.talk("YouTube Music didn't answer: " + (err && err.message));
    });
  }
}

// !swaps, !swapscan
function swaps(room, m) {
  var command = m.command, args = m.args, senderIsMod = m.senderIsMod;
  if (!room.swapsOn) {
    room.talk("Swap suggestions are off (SWAP_SUGGESTIONS=false).");
  } else if (command == "swapscan" && senderIsMod) {
    // !swapscan: people seen since their last scan (like the nightly run);
    // !swapscan all: everyone
    var fullScan = args == "all";
    if (room.swapper().state.running) {
      room.talk("Already looking for swaps; !swaps says how it went once it's done.");
    } else {
      room.talk(":mag: Looking through " + (fullScan ? "everyone's" : "recently active people's") + " playlists for broken tracks with a YouTube Music copy. !swaps says how it went.");
      room.swapper().run({ reason: "!swapscan", full: fullScan, paid: true });
    }
  } else if (room.swapper().state.running) {
    room.talk("Looking for swaps right now (started " + Math.round((Date.now() - room.swapper().state.startedAt) / 60000) + " min ago).");
  } else {
    var lastRun = room.swapper().state.last;
    var st = room.swapper().state;
    // what still waits, and when the next catch-up pass is, first (chat cuts long lines)
    var backlog = st.nextAt ? "next pass in " + Math.max(1, Math.round((st.nextAt - Date.now()) / 60000)) + " min" +
      (st.backlog && st.backlog.tracks ? " (" + st.backlog.tracks + " waiting)" : "") + "; " : "";
    room.talk(room.fitChat("Swaps (nightly at " + room.SWAP_HOUR + ":00, " + st.today.searches + " searches today): " + backlog +
      (lastRun ? room.swaps.summary(lastRun) : "no run yet; mods can start one with !swapscan.")));
  }
}

// !ytmusic, !ytsync
function ytmusicSync(room, m) {
  var command = m.command, senderIsMod = m.senderIsMod, namebo = m.namebo;
  var ytmName = process.env.YTMUSIC_PLAYLIST || "YOUTUBE MUSIC";
  if (!room.ytmOn) {
    room.talk("The " + ytmName + " playlist sync is off (YTMUSIC_SYNC=false).");
  } else if (room.ytmSync().state.running) {
    room.talk("Syncing " + ytmName + " right now: " + (room.ytmSync().state.step || "starting") + " (started " +
      Math.round((Date.now() - room.ytmSync().state.startedAt) / 60000) + " min ago).");
  } else if (command == "ytsync" && senderIsMod) {
    room.talk(":arrows_counterclockwise: Syncing my " + ytmName + " playlist with the Indie Discotheque year playlists. !ytmusic says how it went.");
    room.ytmRun({ reason: "!ytsync" });
  } else if (command == "ytsync") {
    room.talk("Only mods can start a sync, " + namebo + ". !ytmusic says how the last one went.");
  } else {
    var ytmLast = room.ytmSync().state.last;
    room.talk(room.fitChat(ytmName + " (daily at " + room.YTM_HOUR + ":00): " + (ytmLast ? room.ytmsync.brief(ytmLast) : "no sync since I started; mods can start one with !ytsync.")));
  }
}

// !social
function social(room, m) {
  var args = m.args, senderIsMod = m.senderIsMod;
  if (!room.socialTrigger) {
    room.talk("Social posting isn't started from here: the bot needs SOCIAL_GITHUB_TOKEN first (see the README).");
  } else if (args && args.trim() == "now" && senderIsMod) {
    room.socialTrigger.dispatch().then(function(ok) {
      room.talk(ok ? ":mega: Social posting started: anything due goes out in a few minutes." : "Couldn't start social posting: " + room.socialTrigger.status().lastError);
    });
  } else {
    var soc = room.socialTrigger.status();
    room.talk(room.fitChat("Social posting runs every hour at :" + String(soc.minute).padStart(2, "0") + ". " +
      (soc.lastError ? "The last start failed: " + soc.lastError : soc.lastOk ? "Last started " + Math.max(1, Math.round((Date.now() - soc.lastOk) / 60000)) + " min ago." : "Not started yet since I came online.") +
      (senderIsMod ? " !social now starts it now." : "")));
  }
}

// !genrelists
function genrelists(room, m) {
  var args = m.args, senderIsMod = m.senderIsMod;
  if (!room.genrePlaylistsOn) {
    room.talk("Genre playlists on YouTube Music are off: the bot needs the room's YouTube account connected first (see the README).");
  } else if (room.genrePlaylistsRunning) {
    room.talk("Updating the genre playlists on YouTube Music right now. !genrelists says how it went.");
  } else if (args == "run" && senderIsMod) {
    room.talk(":arrows_counterclockwise: Updating the genre playlists on YouTube Music. !genrelists says how it went.");
    room.genrePlaylists();
  } else {
    room.firebase.database().ref("discoverCache/ytPlaylistsRun").once("value").then(function(snap) {
      var r = snap.val();
      room.talk(room.fitChat("Genre playlists on YouTube Music (daily at " + room.YTM_PLAYLIST_HOUR + ":00): " + (r
        ? r.done + " in step, " + r.created + " made, " + r.added + " songs added, " + r.removed + " taken out" + (r.stopped ? "; stopped: " + r.stopped : "") + "."
        : "no run yet; mods can start one with !genrelists run.")));
    }, function() { room.talk("I couldn't read the last run."); });
  }
}

module.exports = {
  pushtest: pushtest,
  ytmtest: ytmtest,
  swaps: swaps,
  swapscan: swaps,
  ytmusic: ytmusicSync,
  ytsync: ytmusicSync,
  social: social,
  genrelists: genrelists
};
