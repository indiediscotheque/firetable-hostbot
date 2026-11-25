// Trading cards: printing one for the DJ, gifting it, and grabbing what's up.
// Each command is function(room, m): room is app.js's room (lib/commands.js),
// m the message: {chatData, command, args, sender, senderIsMod, senderIsSupermod, namebo}.
"use strict";

// !printcard
function printcard(room, m) {
  var senderIsSupermod = m.senderIsSupermod, namebo = m.namebo;
  if (senderIsSupermod) {
    room.printCard();
  } else {
    room.talk("i will absolutely not do that " + namebo);
  }
}

// !giftcard
function giftcard(room, m) {
  var chatData = m.chatData, namebo = m.namebo;
  if (chatData.card && room.theDJ) {
    var ccref = room.firebase.database().ref("cards/" + chatData.card + "/owner");
    ccref.set(room.theDJ.id);
    room.notify(room.theDJ.id, ":white_check_mark: " + namebo + " gave you a card! It's in your card case.", { card: chatData.card, kind: "card", name: room.theDJ.name });
    if (chatData.id !== room.theDJ.id) room.notify(chatData.id, ":white_check_mark: Card sent to " + room.theDJ.name + ".", { kind: "card" });
    if (chatData.id !== room.theDJ.id) room.cardGiftedThisSong = true;
  }
}

// !grab
function grab(room, m) {
  var chatData = m.chatData, args = m.args, namebo = m.namebo;
  // the GRAB button names its card; typed, "!grab" takes whichever is up
  room.giveCard(chatData.id, namebo, chatData.botCmd ? (args || "").trim().slice(0, 64) : "");
}

module.exports = {
  printcard: printcard,
  giftcard: giftcard,
  grab: grab
};
