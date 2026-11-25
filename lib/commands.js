// The room's chat commands (!addme, !skip, !theme, !flag, !bpm, ...): one
// message at a time, from app.js's chat feed. A command, a 🔥/🌧 or a theme
// vote; an error in one is logged and that command is dropped, never taking
// the bot down. Everything it reads or changes in the room comes through
// `room` (app.js), whose getters always answer with the room as it is now.
"use strict";

// Every command by name ("!addme" → addme), from its group
var COMMANDS = {};
["lineup", "room", "cards", "tracks", "services"].forEach(function(group) {
  var commands = require("./commands/" + group);
  Object.keys(commands).forEach(function(name) {
    if (COMMANDS[name]) throw new Error("!" + name + " is in two command groups");
    COMMANDS[name] = commands[name];
  });
});

/**
 * @param {Object} room - the room's state and actions, as getters (app.js)
 * @returns {{handleChat: function(*, *, *): void}}
 */
function createCommands(room) {
  function handleChat(chatID, feedKey) {
      room.lookupChatData(chatID, function(chatData) {
        if (!chatData || typeof chatData.txt !== "string") return; // already pruned
        var sender = room.users[chatData.id] || {};
        var senderIsMod = !!(sender.mod || sender.supermod);
        var senderIsSupermod = !!sender.supermod;
        var namebo = sender.username || chatData.id;
        console.log(namebo + ": " + chatData.txt);
        if (!room.chatCounts(chatID, feedKey, chatData)) {
          console.log("ignored a repeated chat message (" + chatID + ")");
          return;
        }
        room.fileMentions(chatID, chatData, namebo);
        room.push.chat(chatID, chatData, namebo);
        if (typeof chatData.time === "number" && room.serverNow() - chatData.time > room.CHAT_MAX_AGE) {
          console.log("ignored a chat message from " + Math.round((room.serverNow() - chatData.time) / 1000) + " seconds ago");
          return;
        }
        var matches = chatData.txt.match(/^(?:[!])(\w+)\s*(.*)/i);
        if (matches && room.botid !== chatData.id && room.started) {
          var command = matches[1].toLowerCase();
          var args = matches[2];
          var run = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : null;
          if (run) run(room, { chatData: chatData, command: command, args: args, sender: sender, senderIsMod: senderIsMod, senderIsSupermod: senderIsSupermod, namebo: namebo });
        } else if (room.reactionForOtherSong(chatData)) {
          // a 🔥/🌧 sent for the song before (it arrived after the song changed)
        } else if (chatData.txt == "🔥" || chatData.txt == ":fire:") {
          room.firelevel.hot(chatData.id, namebo);
        } else if (chatData.txt == "🌧" || chatData.txt == ":cloud_with_rain:") {
          room.firelevel.storm(chatData.id, namebo);
        } else if (chatData.txt == "1" && room.themevote.active) {
          room.themevote.params.votes[chatData.id] = 1;
        }

      });
  };

  // Messages already in the feed when the bot starts were handled by the bot
  // that was running then, so they're skipped: a restart never re-runs a !skip.
  // New ones wait (in order) until the bot has loaded the users and the decks.

  return { handleChat: handleChat };
}

module.exports = { createCommands: createCommands };
