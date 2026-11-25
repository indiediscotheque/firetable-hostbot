// The tracks themselves: flagging broken ones, tempo (BPM), mods' tag fixes and
// review, and the song's play history.
// Each command is function(room, m): room is app.js's room (lib/commands.js),
// m the message: {chatData, command, args, sender, senderIsMod, senderIsSupermod, namebo}.
"use strict";

// !flag
function flag(room, m) {
  var args = m.args, senderIsMod = m.senderIsMod;
  if (senderIsMod) {
    // do the flag thing
    var code = 0;
    if (args == "broken" || args == "8") {
      code = 8;
    } else if (args == "bitrate" || args == "quality" || args == "incomplete" || args == "9") {
      code = 9;
    } else if (args == "offtheme" || args == "10") {
      code = 10;
    }

    if (room.song && room.song.cid && room.currentListRef()) {
      if (code) {
        var flag = {
          date: Date.now(),
          code: code
        };
        room.queueRef.orderByChild('cid').equalTo(room.song.cid).once("value")
          .then(function(snapshot) {
            var data = snapshot.val();
            if (data) {
              for (var key in data) {
                if (data[key].type == room.song.type) {
                  room.queueRef.child(key + "/flagged").set(flag);
                }
              }
            }
            room.talk(":triangular_flag_on_post: FLAGGED (CODE " + code + ")");
          });
      } else {
        room.talk("Please specify a valid flag reason (ex: !flag broken, !flag offtheme, !flag quality)");
      }
    } else {
      room.talk("I just reloaded... I don't remember where in the DJ's lists I got this from.");
    }
  }
}

// !flagplay
function flagplay(room, m) {
  var args = m.args, senderIsMod = m.senderIsMod;
  // Flag a track from Recent: !flagplay <songHistory id> <reason>.
  // Marks it in every list of the DJ who played it.
  if (senderIsMod) {
    var fp = (args || "").trim().split(/\s+/);
    var fpCode = room.flagCodeFor(fp[1]);
    if (!fp[0] || !fpCode) {
      room.talk("Use !flagplay <play> <broken|quality|offtheme>");
    } else {
      room.firebase.database().ref("songHistory/" + fp[0]).once("value").then(function(snap) {
        var play = snap.val();
        if (!play || !play.djid || !play.cid) return room.talk("I can't find that play anymore.");
        return room.flagTrackForDJ(play.djid, play.cid, play.type, { date: Date.now(), code: fpCode }).then(function(n) {
          room.talk(n ? ":triangular_flag_on_post: FLAGGED " + play.artist + " - " + play.title + " (CODE " + fpCode + ")"
                 : "That track isn't in " + play.dj + "'s playlists anymore.");
        });
      }).catch(function(err) {
        console.log("flagplay error:", err);
      });
    }
  }
}

// !bpm
function bpm(room, m) {
  var chatData = m.chatData, args = m.args;
  if (!room.song || !room.song.cid) {
    room.talk("Nothing's playing.");
  } else if (!args) {
    room.talk(room.song.bpm ? "This track is about " + room.song.bpm + " BPM" + (room.song.bpmSrc === "manual" ? " (set by hand)." : ".") : "I don't know this one's tempo. The DJ or a mod can set it with `!bpm 128`.");
  } else {
    var u = room.users[chatData.id] || {};
    var newBpm = Math.round(Number(String(args).trim()) * 10) / 10;
    if (!(chatData.id === room.song.djid || u.mod || u.supermod)) {
      room.talk("Only the DJ or a mod can set the tempo.");
    } else if (!(newBpm >= room.BPM_MIN && newBpm <= room.BPM_MAX)) {
      room.talk("Give me a number between " + room.BPM_MIN + " and " + room.BPM_MAX + ", like `!bpm 128`.");
    } else {
      room.firebase.database().ref("bpm/" + room.bpmKey(room.song.type, room.song.cid)).set({ bpm: newBpm, src: "manual", by: chatData.id, at: Date.now() });
      room.setSongBpm(room.song.started, newBpm, "manual");
      room.talk("Got it: " + newBpm + " BPM.");
    }
  }
}

// !fixtags
function fixtags(room, m) {
  var args = m.args, senderIsMod = m.senderIsMod, namebo = m.namebo;
  if (!senderIsMod) {
    room.talk("Only mods can fix tags, " + namebo + ". Ask a mod to fix this one.");
  } else if (!room.song || !room.song.cid) {
    room.talk("Nothing's playing.");
  } else if (args) {
    // split on the FIRST " - " only, so "Song - Live" titles stay whole
    var sep = args.indexOf(' - ');
    if (sep < 1 || !args.slice(sep + 3).trim()) {
      //bad format
      room.talk("what");
    } else {
      var newartist = args.slice(0, sep).trim().replace(/&amp;/g, '&');
      var newtitle = args.slice(sep + 3).trim().replace(/&amp;/g, '&');
      room.gts.fixTags(room.song, room.currentListRef(), newartist, newtitle, namebo);
      room.talk("ok. updating tags to artist: `" + newartist + "` and title: `" + newtitle + "`. thank you.")
    }

  } else {
    room.talk("update current tags with `!fixtags artist - title` and refer to Rohn Standard Notation if unsure. thanks!");
  }
}

// !plays, !firstplay
function plays(room, m) {
  room.playsReply();
}

// !review
function review(room, m) {
  var senderIsMod = m.senderIsMod, namebo = m.namebo;
  if (!senderIsMod) room.talk("Only mods can sort out tags, " + namebo + ".");
  else room.tagReview.next();
}

// !same, !different
function sameOrDifferent(room, m) {
  var command = m.command, args = m.args, senderIsMod = m.senderIsMod, namebo = m.namebo;
  if (!senderIsMod) room.talk("Only mods can sort out tags, " + namebo + ".");
  else room.tagReview.answer(args, command == "same" ? "merge" : "separate", namebo);
}

module.exports = {
  flag: flag,
  flagplay: flagplay,
  bpm: bpm,
  fixtags: fixtags,
  plays: plays,
  firstplay: plays,
  review: review,
  same: sameOrDifferent,
  different: sameOrDifferent
};
