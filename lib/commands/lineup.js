// The decks and the waitlist: joining, leaving, taking the bus, skipping, mods adding
// and removing people, and the bot's own seat (autopilot).
// Each command is function(room, m): room is app.js's room (lib/commands.js),
// m the message: {chatData, command, args, sender, senderIsMod, senderIsSupermod, namebo}.
"use strict";

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

// !removemeafter, !removeafter, !gottacatchmybus, !dontremovemeafter, !dontremoveafter, !dontremoveme, !dontremove
function takeTheBus(room, m) {
  var chatData = m.chatData, command = m.command, args = m.args, namebo = m.namebo;
  // "take the bus": step down after your next play. Mods can also set
  // it for someone of lower rank: !removeafter <name> (#121).
  var busOn = command.indexOf("dont") !== 0;
  var busTarget = room.busTargetFor(chatData.id, namebo, args);
  if (busTarget.error) {
    room.talk(busTarget.error);
  } else {
    room.setBus(busTarget, busOn, chatData.id);
  }
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
    if (prsnToRemove && prsnToRemove != chatData.id && room.busRank(room.users[prsnToRemove]) > room.busRank(sender)) {
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
  dontremovemeafter: takeTheBus,
  dontremoveafter: takeTheBus,
  dontremoveme: takeTheBus,
  dontremove: takeTheBus,
  skip: skip,
  upbot: upbot,
  downbot: downbot,
  autodj: autodj,
  remove: remove,
  add: add,
  lastblipped: lastblipped
};
