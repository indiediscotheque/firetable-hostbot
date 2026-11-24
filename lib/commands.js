// The room's chat commands (!addme, !skip, !theme, !flag, !bpm, ...): one
// message at a time, from app.js's chat feed. A command, a 🔥/🌧 or a theme
// vote; an error in one is logged and that command is dropped, never taking
// the bot down. Everything it reads or changes in the room comes through
// `room` (app.js), whose getters always answer with the room as it is now.
"use strict";

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
          if (command == "addme") {
            var check = room.addCheck(chatData.id);
            if (!check) {
              var pson = {
                name: namebo,
                id: chatData.id,
                plays: 0
              };

              if (room.table.length >= 4) {
                // table full. time to be on the waitlist now k
                room.queue.push(pson);
                room.talk(namebo + " added to waitlist. Length is now " + room.queue.length);
                room.updateWaitlist();
                room.updateLimit();
              } else {
                //table has room. add to table directly
                if (room.table.length == 0) {
                  room.table.push(pson);
                  room.playDex = 0;
                  room.startSong();
                } else {
                  room.seatDJ(pson);
                  room.updateThings();
                }
              }
            } else {
              if (check == 1) {
                room.talk("You are already in the waitlist.");
              } else if (check == 2) {
                room.talk("You are already on deck.");
              }
            }
          } else if (command == "removeme") {
            var removed = room.removeMe(chatData.id);
            if (!removed) room.talk(namebo + ", you aren't even DJing...");
          } else if (command == "removemeafter" || command == "removeafter" || command == "gottacatchmybus" ||
                     command == "dontremovemeafter" || command == "dontremoveafter" || command == "dontremoveme" || command == "dontremove") {
            // "take the bus": step down after your next play. Mods can also set
            // it for someone of lower rank: !removeafter <name> (#121).
            var busOn = command.indexOf("dont") !== 0;
            var busTarget = room.busTargetFor(chatData.id, namebo, args);
            if (busTarget.error) {
              room.talk(busTarget.error);
            } else {
              room.setBus(busTarget, busOn, chatData.id);
            }
          } else if (command == "skip") {
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
          } else if (command == "theme") {
            if (room.theme) {
              room.talk("The current theme is: " + room.theme);
            } else {
              room.talk("There is no theme at the moment. `!suggest` one if you'd like.")
            }
          } else if (command == "suggest") {
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
          } else if (command == "settheme") {
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
          } else if (command == "lights" || command == "lightson" || command == "lightsoff") {
            if (senderIsSupermod) {
              room.lightsCommand(command, namebo);
            } else {
              room.talk("i will absolutely not do that " + namebo);
            }
          } else if (command == "printcard") {
            if (senderIsSupermod) {
              room.printCard();
            } else {
              room.talk("i will absolutely not do that " + namebo);
            }
          } else if (command == "giftcard") {
            if (chatData.card && room.theDJ) {
              var ccref = room.firebase.database().ref("cards/" + chatData.card + "/owner");
              ccref.set(room.theDJ.id);
              room.notify(room.theDJ.id, ":white_check_mark: " + namebo + " gave you a card! It's in your card case.", { card: chatData.card, kind: "card", name: room.theDJ.name });
              if (chatData.id !== room.theDJ.id) room.notify(chatData.id, ":white_check_mark: Card sent to " + room.theDJ.name + ".", { kind: "card" });
              if (chatData.id !== room.theDJ.id) room.cardGiftedThisSong = true;
            }
          } else if (command == "grab") {
            // the GRAB button names its card; typed, "!grab" takes whichever is up
            room.giveCard(chatData.id, namebo, chatData.botCmd ? (args || "").trim().slice(0, 64) : "");
          } else if (command == "upbot") {
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
                var botSeat = {
                  name: namebo2,
                  id: room.botid,
                  plays: 0
                };
                if (room.table.length >= 4) {
                  // table full. time to be on the waitlist now k
                  room.queue.push(botSeat);
                  room.talk(namebo2 + " (that's me) added to waitlist. Length is now " + room.queue.length);
                  room.updateWaitlist();
                  room.updateLimit();
                } else {
                  //table has room. add to table directly
                  room.talk("OK! I will DJ.");
                  if (room.table.length == 0) {
                    room.table.push(botSeat);
                    room.playDex = 0;
                    room.startSong();
                  } else {
                    room.seatDJ(botSeat);
                    room.updateThings();
                  }
                }
              } else if (botCheck == 1) {
                room.talk("I am already in the waitlist.");
              } else {
                room.talk("I am already on deck.");
              }
            }
          } else if (command == "downbot") {
            // Leave now and stay off the decks until the next autopilot trigger.
            if (senderIsMod) {
              room.autoDJ.override("down");
              room.removeMe(room.botid);
              room.talk("OK! I will not DJ.");
            }
          } else if (command == "pushtest") {
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
          } else if (command == "autodj") {
            if ((args || "").trim().toLowerCase() == "auto" && (senderIsMod)) {
              room.autoDJ.override("auto");
              room.talk("OK! Back on autopilot.");
              room.autoDJ.check();
            } else {
              room.talk(room.autoDJ.status());
            }
          } else if (command == "screen" || command == "screendown") {
            if (senderIsMod) {
              room.talk("activating the screen.");
              room.firebase.database().ref("thescreen").set(true);
            }
          } else if (command == "killscreen" || command == "screenup") {
            if (senderIsMod) {
              room.talk("ok.");
              room.firebase.database().ref("thescreen").set(false);
            }

          } else if (command == "flag") {
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
          } else if (command == "flagplay") {
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
          } else if (command == "ytmtest") {
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
          } else if (command == "swaps" || command == "swapscan") {
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
          } else if (command == "ytmusic" || command == "ytsync") {
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
          } else if (command == "social") {
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
          } else if (command == "genrelists") {
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
          } else if (command == "bpm") {
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
          } else if (command == "fixtags") {
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
          } else if (command == "plays" || command == "firstplay") {
            room.playsReply();
          } else if (command == "review") {
            if (!senderIsMod) room.talk("Only mods can sort out tags, " + namebo + ".");
            else room.tagReview.next();
          } else if (command == "same" || command == "different") {
            if (!senderIsMod) room.talk("Only mods can sort out tags, " + namebo + ".");
            else room.tagReview.answer(args, command == "same" ? "merge" : "separate", namebo);
          } else if (command == "lastblipped"){
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
          } else if (command == "remove") {
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
          } else if (command == "add") {
            if (senderIsMod) {
              var prsnToAdd = room.uidLookup(args);
              if (prsnToAdd == room.botid) room.autoDJ.override("up");
              if (prsnToAdd) {
                var addState = room.addCheck(prsnToAdd, true);
                if (!addState) {
                  var addSeat = {
                    name: room.users[prsnToAdd].username,
                    id: prsnToAdd,
                    plays: 0
                  };

                  if (room.table.length >= 4) {
                    // table full. time to be on the waitlist now k
                    room.queue.push(addSeat);
                    room.talk(room.users[prsnToAdd].username + " added to waitlist. Length is now " + room.queue.length);
                    room.updateWaitlist();
                    room.updateLimit();
                  } else {
                    //table has room. add to table directly
                    if (room.table.length == 0) {
                      room.table.push(addSeat);
                      room.playDex = 0;
                      room.startSong();
                    } else {
                      room.seatDJ(addSeat);
                      room.updateThings();
                    }
                  }
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
          } else if (command == "become") {
            room.talk("i do not remember how to do that.")
          } else if (command == "wait") {
            room.talk("wait");
          } else if (command == "hot") {
            if (!room.reactionForOtherSong(chatData)) room.firelevel.hot(chatData.id, namebo);
          } else if (command == "storm") {
            if (!room.reactionForOtherSong(chatData)) room.firelevel.storm(chatData.id, namebo);
          } else if (command == "link") {
            if (room.song) {
              if (room.song.url) {
                room.talk(room.song.url);
              } else {
                room.talk("Nothing is playing...");
              }
            }
          } else if (command == "dance") {
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
