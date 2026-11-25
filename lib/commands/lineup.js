// The decks and the waitlist: joining, leaving, taking the bus (now, after n songs or in a while), skipping, mods adding
// and removing people, and the bot's own seat (autopilot).
// Each command is function(room, m): room is app.js's room (lib/commands.js),
// m the message: {chatData, command, args, sender, senderIsMod, senderIsSupermod, namebo}.
"use strict";
var bus = require("../bus");

/**
 * Seat someone at the decks, or put them on the waitlist when all four seats
 * are taken (the room says so: `<waitName> added to waitlist. Length is now N`).
 * @param {Object} room
 * @param {{name: string, id: string, plays: number}} seat
 * @param {string} waitName - who the waitlist message names
 * @param {function(): void} [seating] - said just before they're seated
 */
function join(room, seat, waitName, seating) {
  if (room.table.length >= 4) {
    // table full. time to be on the waitlist now k
    room.queue.push(seat);
    room.talk(waitName + " added to waitlist. Length is now " + room.queue.length);
    room.updateWaitlist();
    room.updateLimit();
    return;
  }
  //table has room. add to table directly
  if (seating) seating();
  if (room.table.length == 0) {
    room.table.push(seat);
    room.playDex = 0;
    room.startSong();
  } else {
    room.seatDJ(seat);
    room.updateThings();
  }
}

// !addme
function addme(room, m) {
  var chatData = m.chatData, namebo = m.namebo;
  var check = room.addCheck(chatData.id);
  if (!check) {
    join(room, { name: namebo, id: chatData.id, plays: 0 }, namebo);
  } else {
    if (check == 1) {
      room.talk("You are already in the waitlist.");
    } else if (check == 2) {
      room.talk("You are already on deck.");
    }
  }
}

// !removeme
function removeme(room, m) {
  var chatData = m.chatData, namebo = m.namebo;
  var removed = room.removeMe(chatData.id);
  if (!removed) room.talk(namebo + ", you aren't even DJing...");
}

// !removeafter, !removemeafter, !gottacatchmybus, !lastsong, !leaveafter, !stepdownafter:
// step down after your next song, or after a number of songs (!removeafter 3,
// the one playing now included), or in a while (!removeafter 45m). No amount
// is 1: after your next song, as the bus always was. Mods add a name (#121).
function takeTheBus(room, m) {
  var parsed = bus.splitArgs(m.args, bus.parseWhen);
  var target = room.bus.targetFor(m.chatData.id, m.namebo, parsed.name);
  if (target.error) return room.talk(target.error);
  if (parsed.off) return room.bus.set(target, false, m.chatData.id);
  var amount = parsed.amount || { songs: 1 };
  if (amount.minutes) return catchAt(room, m, target, amount.minutes);
  if (amount.songs > bus.MAX_SONGS) return room.talk("That's a lot of songs, " + m.namebo + "! Up to " + bus.MAX_SONGS + ", please.");
  room.bus.setSongs(target, amount.songs, m.chatData.id);
}

/** A bus at a time, within the limit. */
function catchAt(room, m, target, minutes) {
  if (minutes > bus.MAX_MINUTES) return room.talk("Up to " + bus.MAX_MINUTES / 60 + " hours, " + m.namebo + ".");
  room.bus.setTime(target, minutes, m.chatData.id);
}

// !dontremoveme, !dontremove, !dontremovemeafter, !dontremoveafter, !stay:
// off the bus, whichever kind (mods add a name)
function stayOn(room, m) {
  var target = room.bus.targetFor(m.chatData.id, m.namebo, m.args);
  if (target.error) return room.talk(target.error);
  room.bus.set(target, false, m.chatData.id);
}

// !leavein 45, !leavein 1h30 name (mods), !leavein off: step down in that
// long (a plain number is minutes), finishing the song you're playing then
function leavein(room, m) {
  var parsed = bus.splitArgs(m.args, bus.parseIn);
  if (!parsed.off && !parsed.amount) return room.talk("How long, " + m.namebo + "? Like !leavein 30 or !leavein 1h30.");
  var target = room.bus.targetFor(m.chatData.id, m.namebo, parsed.name);
  if (target.error) return room.talk(target.error);
  if (parsed.off) return room.bus.set(target, false, m.chatData.id);
  catchAt(room, m, target, parsed.amount.minutes);
}

// !bus: who's catching the bus and when; !bus me: just yours
function busList(room, m) {
  var mine = /^(?:me|mine|my)$/i.test((m.args || "").trim());
  room.talk(mine ? room.bus.status(m.chatData.id, m.namebo) : room.bus.list());
}

// !skip
function skip(room, m) {
  var chatData = m.chatData, senderIsMod = m.senderIsMod, namebo = m.namebo;
  if (senderIsMod || (room.theDJ && chatData.id == room.theDJ.id)) {
    if (room.songLoading) {
      // the next song is already on its way: one skip per song (said
      // once, so a few quick skips don't fill the chat)
      console.log("skip ignored: the next song is still loading");
      if (room.skipNoticeFor !== room.startSeq) {
        room.skipNoticeFor = room.startSeq;
        room.talk("Hang on, " + namebo + ", the next song is already loading.");
      }
    } else {
      room.nextSong();
    }
  }
}

// !upbot
function upbot(room, m) {
  var senderIsMod = m.senderIsMod;
  // Stay on the decks (even alone with a crowd) until the next
  // autopilot trigger.
  if (senderIsMod) {
    var namebo2 = room.autoDJ.botName();
    var botCheck = room.addCheck(room.botid);
    var seat = room.autoDJ.botSeat();
    room.autoDJ.override("up");
    if (seat && seat.removeAfter) {
      seat.removeAfter = false;
      if (room.theDJ && room.theDJ.id == room.botid) room.theDJ.removeAfter = false;
      room.talk("OK! I'll stay on the decks.");
      room.updateTable();
    } else if (!botCheck) {
      join(room, { name: namebo2, id: room.botid, plays: 0 }, namebo2 + " (that's me)", function() { room.talk("OK! I will DJ."); });
    } else if (botCheck == 1) {
      room.talk("I am already in the waitlist.");
    } else {
      room.talk("I am already on deck.");
    }
  }
}

// !downbot
function downbot(room, m) {
  var senderIsMod = m.senderIsMod;
  // Leave now and stay off the decks until the next autopilot trigger.
  if (senderIsMod) {
    room.autoDJ.override("down");
    room.removeMe(room.botid);
    room.talk("OK! I will not DJ.");
  }
}

// !autodj
function autodj(room, m) {
  var args = m.args, senderIsMod = m.senderIsMod;
  if ((args || "").trim().toLowerCase() == "auto" && (senderIsMod)) {
    room.autoDJ.override("auto");
    room.talk("OK! Back on autopilot.");
    room.autoDJ.check();
  } else {
    room.talk(room.autoDJ.status());
  }
}

// !remove
function remove(room, m) {
  var chatData = m.chatData, args = m.args, sender = m.sender, senderIsMod = m.senderIsMod, namebo = m.namebo;
  if (senderIsMod) {
    var prsnToRemove = room.uidLookup(args);
    if (prsnToRemove && prsnToRemove != chatData.id && room.bus.rank(room.users[prsnToRemove]) > room.bus.rank(sender)) {
      // a mod can't take a supermod off the decks
      room.talk("You can't remove " + ((room.users[prsnToRemove] && room.users[prsnToRemove].username) || args) + ", " + namebo + ".");
    } else if (prsnToRemove) {
      if (prsnToRemove == room.botid) room.autoDJ.override("down");
      if (!room.removeMe(prsnToRemove)) room.talk("Can not remove " + args + " because they are not on the table or in the waitlist. Thanks.");
    } else {
      room.talk("who is that");
    }
  }
}

// !add
function add(room, m) {
  var args = m.args, senderIsMod = m.senderIsMod;
  if (senderIsMod) {
    var prsnToAdd = room.uidLookup(args);
    if (prsnToAdd == room.botid) room.autoDJ.override("up");
    if (prsnToAdd) {
      var addState = room.addCheck(prsnToAdd, true);
      if (!addState) {
        join(room, { name: room.users[prsnToAdd].username, id: prsnToAdd, plays: 0 }, room.users[prsnToAdd].username);
      } else {
        if (addState == 1) {
          room.talk(room.users[prsnToAdd].username + " is already in the waitlist.");
        } else if (addState == 2) {
          room.talk(room.users[prsnToAdd].username + " is already on deck.");
        } else if (addState == 3) {
          room.talk(room.users[prsnToAdd].username + " is almost for sure not here.");
        }
      }

    } else {
      room.talk("who is that");
    }
  }
}

// !lastblipped
function lastblipped(room, m) {
  var args = m.args;
  if (args){
    var prsn = room.uidLookup(args);
    if (prsn){
      if (room.lastBlipped[prsn]){
        room.talk("this person last blipped " + Math.round((Date.now() - room.lastBlipped[prsn]) / 60000) + " minutes ago. or i just rebooted.");
      } else {
        room.talk("i am confused thank you");
      }
    }
  }
}

module.exports = {
  addme: addme,
  removeme: removeme,
  removemeafter: takeTheBus,
  removeafter: takeTheBus,
  gottacatchmybus: takeTheBus,
  lastsong: takeTheBus,
  leaveafter: takeTheBus,
  stepdownafter: takeTheBus,
  dontremovemeafter: stayOn,
  dontremoveafter: stayOn,
  dontremoveme: stayOn,
  dontremove: stayOn,
  stay: stayOn,
  leavein: leavein,
  stepdownin: leavein,
  bus: busList,
  skip: skip,
  upbot: upbot,
  downbot: downbot,
  autodj: autodj,
  remove: remove,
  add: add,
  lastblipped: lastblipped
};
