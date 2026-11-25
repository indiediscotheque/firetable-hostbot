// The room's show: the theme and theme votes, the string lights, the screen, 🔥 and
// 🌧, the song's link, the D.A.N.C.E. satellite, and a couple of old jokes.
// Each command is function(room, m): room is app.js's room (lib/commands.js),
// m the message: {chatData, command, args, sender, senderIsMod, senderIsSupermod, namebo}.
"use strict";

// !theme
function theme(room, m) {
  if (room.theme) {
    room.talk("The current theme is: " + room.theme);
  } else {
    room.talk("There is no theme at the moment. `!suggest` one if you'd like.")
  }
}

// !suggest
function suggest(room, m) {
  var chatData = m.chatData, args = m.args, senderIsMod = m.senderIsMod, namebo = m.namebo;
  // Each vote pings @everyone, so: a real theme, one vote at a time,
  // and one suggestion per person every 15 minutes (mods excepted)
  var idea = String(args || "").replace(/\s+/g, " ").trim();
  var waitMs = (room.themevote.lastBy[chatData.id] || 0) + room.THEME_SUGGEST_COOLDOWN - Date.now();
  if (room.themevote.active) {
    room.talk("We are already voting for " + room.themevote.params.votingfor + ". Let's wait for that to finish first.");
  } else if (!idea) {
    room.talk("Suggest a theme like `!suggest 90s one-hit wonders`.");
  } else if (idea.length > room.THEME_MAX_LENGTH) {
    room.talk("Keep the theme under " + room.THEME_MAX_LENGTH + " characters, " + namebo + ".");
  } else if (waitMs > 0 && !senderIsMod) {
    room.talk(namebo + ", you can suggest another theme in " + Math.ceil(waitMs / 60000) + " minute(s).");
  } else {
    room.themevote.lastBy[chatData.id] = Date.now();
    room.themevote.go(idea, namebo);
  }
}

// !settheme
function settheme(room, m) {
  var args = m.args, senderIsSupermod = m.senderIsSupermod, namebo = m.namebo;
  if (senderIsSupermod) {
    if (args == "none") {
      room.setTheme(null);
      room.talk("There is no theme.");
    } else {
      room.setTheme(args);
      room.talk("Theme has been set to: " + args);
    }
  } else {
    room.talk("i will absolutely not do that " + namebo);
  }
}

// !lights, !lightson, !lightsoff
function lights(room, m) {
  var command = m.command, senderIsSupermod = m.senderIsSupermod, namebo = m.namebo;
  if (senderIsSupermod) {
    room.lightsCommand(command, namebo);
  } else {
    room.talk("i will absolutely not do that " + namebo);
  }
}

// !screen, !screendown
function screenDown(room, m) {
  var senderIsMod = m.senderIsMod;
  if (senderIsMod) {
    room.talk("activating the screen.");
    room.firebase.database().ref("thescreen").set(true);
  }
}

// !killscreen, !screenup
function screenUp(room, m) {
  var senderIsMod = m.senderIsMod;
  if (senderIsMod) {
    room.talk("ok.");
    room.firebase.database().ref("thescreen").set(false);
  }
}

// !hot
function hot(room, m) {
  var chatData = m.chatData, namebo = m.namebo;
  if (!room.reactionForOtherSong(chatData)) room.firelevel.hot(chatData.id, namebo);
}

// !storm
function storm(room, m) {
  var chatData = m.chatData, namebo = m.namebo;
  if (!room.reactionForOtherSong(chatData)) room.firelevel.storm(chatData.id, namebo);
}

// !link
function link(room, m) {
  if (room.song) {
    if (room.song.url) {
      room.talk(room.song.url);
    } else {
      room.talk("Nothing is playing...");
    }
  }
}

// !dance
function dance(room, m) {
  if (room.cardGiftedThisSong) {
    if (!room.robotsDancing) {
      room.writeRoomState({ dance: true });
      room.robotsDancing = true;
      room.talk(":artificial_satellite: D.A.N.C.E satellite: `GLOBAL DANCE SEQUENCE NO. 1 HAS BEEN INITIATED.`");
    } else {
      room.talk(":artificial_satellite: D.A.N.C.E satellite: `already broadcasting dance signal thanks`");
    }
  } else {
    room.talk(":red_circle::satellite: unable to communicate with the D.A.N.C.E. satellite... if you gift the DJ a h0t new card, i'm sure they'll help boost your signal");
  }
}

// !become
function become(room, m) {
  room.talk("i do not remember how to do that.")
}

// !wait
function wait(room, m) {
  room.talk("wait");
}

module.exports = {
  theme: theme,
  suggest: suggest,
  settheme: settheme,
  lights: lights,
  lightson: lights,
  lightsoff: lights,
  screen: screenDown,
  screendown: screenDown,
  killscreen: screenUp,
  screenup: screenUp,
  hot: hot,
  storm: storm,
  link: link,
  dance: dance,
  become: become,
  wait: wait
};
