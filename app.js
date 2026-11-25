'use strict';
// Node 22 or newer (Firebase and the .env loader below need it). Under an older
// Node this stops with a clear message; auto-update then puts the old code back.
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("firetable-hostbot needs Node.js 22 or newer; this server has " + process.version +
    ". Upgrade Node (see the README's install steps), then pm2 restart hostbot.");
  process.exit(1);
}
// Settings from .env, next to this file. Values already set in the
// environment win, and a missing .env is fine (e.g. on a host with env vars).
try {
  process.loadEnvFile(require('path').join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
var firebase = require('@firebase/app-compat').default;
require('@firebase/auth-compat');
require('@firebase/database-compat');
var http = require('./lib/http').http;
var artworkColors = require('./lib/colors').artworkColors;
var text = require('./lib/text');
var splitTags = text.splitTags;
var fitChat = text.fitChat;
var checks = require('./lib/checks');
var ytmusic = require('./lib/ytmusic');
var swaps = require('./lib/swaps');
var ytmsync = require('./lib/ytmsync');
var apple = require('./lib/apple');
var discover = require('./lib/discover');
var stage = require('./lib/stage');
var avatars = require('./lib/avatars');
var grabCounts = require('./lib/grabs');
var imports = require('./lib/imports');
var spotify = require('./lib/spotify');
var tracks = require('./lib/tracks');
var ytplaylists = require('./lib/ytplaylists');
var social = require('./lib/social');
var lastfm = require('./lib/lastfm').createLastfm(process.env); // scrobbling

// A failed promise somewhere (a write the rules refused, a network blip) is
// logged; it doesn't take the bot down (Node would exit otherwise).
process.on("unhandledRejection", function(reason) {
  console.log("unhandled error:", reason);
});
var users = {};
var botid = null;
var started = false;
var queue = [];
var queueRef = null;
var theDJ = null;
var cardForGrabs = null;
var totalCards = 0;
var colors = {
  color: "#fff",
  txt: "#fff"
};
var robotsDancing = false;
var cardGiftedThisSong = false;
var table = [];
var lastBlipped = {};
var playlimit = 2;
var song = null;
var playDex = 0; //where does the spotlight go? (tracks SEATS not people)
var theme = null;
var songTimeout = null;
var cardSpecial = false;

var configs = {
  apiKey: process.env.FIREBASE_KEY,
  authDomain: process.env.FIREBASE_AUTH,
  databaseURL: process.env.FIREBASE_DB
};
firebase.initializeApp(configs);

// The database's clock, as the site uses it (ftapi.now()). Song start times
// are stamped with it so every listener's position, the beat and the
// progress bar line up, whatever this server's own clock says.
var serverTimeOffset = 0;
firebase.database().ref(".info/serverTimeOffset").on("value", function(snapshot) {
  serverTimeOffset = snapshot.val() || 0;
});
function serverNow() {
  return Date.now() + serverTimeOffset;
}

// ─── Seasons, from the site ─────────────────────────────────────────────────
// The seasonal trading-card avatars and the string-lights months, read from
// the live site every 10 minutes (lib/seasons.js).
var siteSeasons = require("./lib/seasons").createSiteSeasons(process.env);
siteSeasons.start();

// Same as the site's normalizeAvatarStyle: "set2" → "robohash:set2", and a
// style the room no longer offers → null (lib/avatars.js).
var normalizeAvatarStyle = avatars.normalizeAvatarStyle;

// Everyone's avatar style when a supermod has picked one (the site's Mod tools,
// roomSettings/avatarStyle); null means the room's default below. With older
// rules the read is refused and the default stands.
var roomAvatarChoice = null;
firebase.database().ref("roomSettings/avatarStyle").on("value", function(snapshot) {
  roomAvatarChoice = normalizeAvatarStyle(snapshot.val());
}, function() {
  roomAvatarChoice = null;
});

// What a card stamps so it always shows the DJ as the room drew them when it
// was printed (lib/avatars.js avatarFor): the style (avs: October's monsters,
// else "bouletmaton" with their own (bm) when it's on, else the room's), and
// the Robohash set (set, which older copies of the site read; robots for any
// other style).
function cardAvatar(djid) {
  var a = avatars.avatarFor(users[djid] || {}, roomAvatarChoice || normalizeAvatarStyle(siteSeasons.avatarset()), siteSeasons.forcedAvatarStyle());
  var out = { avs: a.style, set: a.style.indexOf("robohash:") === 0 ? a.style.slice(9) : "set1" };
  if (a.bm) out.bm = a.bm;
  return out;
}

// Chat notices when a DJ's song is broken/blocked. .env values are strings,
// so parse "true"/"1"/"on"/"yes" instead of comparing to the boolean true.
var trackBrokenMessages = /^(true|1|on|yes)$/i.test(String(process.env.TRACKBROKEN_MESSAGES || "").trim());
var lightsOn = false;
firebase.database().ref("lights").on("value", function(snapshot) {
  lightsOn = !!snapshot.val();
});

// Stage string lights. The site keeps them on by itself in its lights months;
// the rest of the year supermods switch them with !lights, !lightson, !lightsoff.
function lightsCommand(command, namebo) {
  if (siteSeasons.isLightsSeason()) {
    var month = new Date().toLocaleString("en-US", { month: "long" });
    talk("🎄 The string lights stay on all " + month + ", " + namebo + ".");
    return;
  }
  var turnOn = command == "lightson" ? true : command == "lightsoff" ? false : !lightsOn;
  if (turnOn === lightsOn) {
    talk("The string lights are already " + (turnOn ? "on" : "off") + ".");
    return;
  }
  firebase.database().ref("lights").set(turnOn).then(function() {
    talk(turnOn ? "💡 String lights on." : "String lights off.");
  }).catch(function(err) {
    console.log("lights error:", err);
    talk("Couldn't switch the string lights.");
  });
}

// ─── One copy at a time, and the heartbeat (lib/lock.js) ────────────────────
var lock = require("./lib/lock").createLock({
  db: function() { return firebase.database(); },
  serverNow: serverNow,
  tookOver: function() { chatWaiting = []; }
});
var botLock = lock.botLock;
var heartbeat = lock.heartbeat;

// Read the deck, waitlist, spotlight and playing song (all at once), then
// pick up where the last copy left off.
var loadRoom = function() {
  var db = firebase.database();
  return Promise.all(["table", "waitlist", "playdex", "songToPlay"].map(function(path) {
    return db.ref(path).once("value");
  })).then(function(snaps) {
    // what was played lately, before the first track is picked
    return repeats.load(snaps[3].val()).then(function() { return snaps; });
  }).then(function(snaps) {
    table = Object.values(snaps[0].val() || {});
    queue = Object.values(snaps[1].val() || {});
    playDex = snaps[2].val() || 0;
    var data = snaps[3].val();
    song = data;
    theDJ = table[playDex];
    console.log("on deck: " + table.length + ", waitlist: " + queue.length);
    if (data) {
      var secSince = Math.floor((serverNow() - data.started) / 1000);
      var timeLeft = data.duration - secSince;
      if (timeLeft <= 0) {
        nextSong();
      } else {
        songTimeout = setTimeout(function() {
          songTimeout = null;
          nextSong(); //NEEEEEEXT
        }, timeLeft * 1000);
      }
    }
    updateThings();
    started = true;
    markChatReady();
    heartbeat.start();
  });
};


var starting = false;
firebase.auth().onAuthStateChanged(function(user) {
  if (!user) return;
  botid = user.uid;
  console.log("signed in as " + botid);
  var ref0 = firebase.database().ref("users/" + user.uid + "/status");
  ref0.set(true);
  ref0.onDisconnect().set(false);
  if (started || starting) return;
  starting = true;
  var start = function() {
    loadRoom().catch(function(err) {
      console.log("couldn't read the room (" + err.message + "); trying again in 10 seconds");
      setTimeout(start, 10 * 1000);
    });
  };
  botLock.acquire().then(start);
});

// A user id from a name ("@name" works too), matching the exact name first,
// then in any case ("boss" finds "Boss"), then a user id itself.
var uidLookup = function(name) {
  name = String(name || "").trim().replace(/^@/, "");
  if (!name) return false;
  var lower = name.toLowerCase();
  /** @type {string|false} */
  var exact = false;
  /** @type {string|false} */
  var anyCase = false;
  for (var key in users) {
    if (!users.hasOwnProperty(key) || !users[key] || typeof users[key].username !== "string") continue;
    if (users[key].username == name) exact = key;
    else if (!anyCase && users[key].username.toLowerCase() == lower) anyCase = key;
  }
  return exact || anyCase || (users[name] ? name : false);
};

// Usernames are unique whatever their case, through lowercase name claims
// (nameClaim/<lowercase name> = uid). This gives every existing username its
// lowercase claim; names claimed before, in their original case, keep working.
// If two older accounts differ only in case, the earlier member gets the claim
// and the log says so. Runs once the bot is ready and every 6 hours; it writes
// nothing once everyone has a claim.
var nameClashLogged = {};
var claimLowercaseNames = function() {
  var db = firebase.database();
  db.ref("nameClaim").once("value").then(function(snap) {
    var claims = snap.val() || {};
    var pending = {};
    var named = Object.keys(users).filter(function(uid) {
      return users[uid] && typeof users[uid].username === "string" && /^[0-9A-Za-z_]{1,22}$/.test(users[uid].username);
    }).sort(function(a, b) {
      return (users[a].joined || Infinity) - (users[b].joined || Infinity);
    });
    named.forEach(function(uid) {
      var lower = users[uid].username.toLowerCase();
      var holder = pending[lower] || claims[lower];
      if (holder === uid) return;
      var holderName = holder && users[holder] && users[holder].username;
      if (typeof holderName === "string" && holderName.toLowerCase() === lower) {
        if (!nameClashLogged[lower]) {
          nameClashLogged[lower] = true;
          console.log("names: " + holderName + " and " + users[uid].username + " differ only in case; " + holderName + " holds the claim.");
        }
        return;
      }
      pending[lower] = uid;
    });
    var names = Object.keys(pending);
    if (!names.length) return;
    return Promise.all(names.map(function(lower) {
      return db.ref("nameClaim/" + lower).set(pending[lower]).then(function() { return 1; }, function(err) {
        console.log("names: couldn't claim " + lower + ":", err.message);
        return 0;
      });
    })).then(function(done) {
      console.log("names: added " + done.reduce(function(a, b) { return a + b; }, 0) + " lowercase name claim(s).");
    });
  }).catch(function(err) {
    console.log("names: couldn't read the name claims (are the latest firebase-rules.json published?):", err.message);
  });
};
setInterval(claimLowercaseNames, 6 * 60 * 60 * 1000);

// opts.grab: a card id, so the site shows a GRAB button for it (#247); until
// the database rules allow that, opts.plain is said instead.
// What the log has said once already (the rules not published yet, ...)
var warnedOnce = {};
var talk = function(txt, card, opts) {
  txt = fitChat(txt);
  var namebo2 = botid;
  if (users[botid]) {
    if (users[botid].username) namebo2 = users[botid].username;
  }
  var chatData = firebase.database().ref("chatData");
  var chatFeed = firebase.database().ref("chatFeed");
  var chooto = {
    time: firebase.database.ServerValue.TIMESTAMP,
    id: botid,
    txt: txt,
    name: namebo2
  };
  if (card) chooto.card = card;
  if (opts && opts.grab) chooto.grab = opts.grab;
  // The message and its feed entry in one write; the older three steps until
  // the database rules allow that
  var chatID = chatData.push().key;
  var feedID = chatFeed.push().key;
  var updates = {};
  updates["chatData/" + chatID] = Object.assign({}, chooto, { feedID: feedID });
  updates["chatFeed/" + feedID] = { chatID: chatID };
  firebase.database().ref().update(updates).catch(function(err) {
    if (!/permission/i.test(err.code || err.message)) throw err;
    if (chooto.grab) {
      if (!warnedOnce.grab) {
        warnedOnce.grab = true;
        console.log("cards: the database rules don't allow GRAB buttons yet (publish firebase-rules.json); asking for !grab in chat until then.");
      }
      return talk(opts.plain || txt, card);
    }
    var chatItem = chatData.push(chooto, function() {
      var feedItem = chatFeed.push({ chatID: chatItem.key }, function() {
        chatItem.child("feedID").set(feedItem.key);
      });
    });
  }).catch(function(err) {
    console.log("couldn't say \"" + txt + "\":", err.message);
  });
};

// Tell one person something without pinging them in chat (#231): a notice
// they see as a toast on the site (notices/<uid>), and a push notification
// when they're away from the room. Until the database rules have notices/,
// it falls back to the old "@name ..." line in chat.
// opts: card (a card id to show), ttl (seconds it stays worth seeing),
// tag / topic (replace an earlier push of the same kind), name (fallback).
var NOTICE_MAX = 300;
var QUIET_NOTICES = { track: true, swap: true }; // playlist upkeep: no sound on the phone
var notify = function(uid, txt, opts) {
  opts = opts || {};
  if (!uid || uid == botid) return Promise.resolve();
  txt = String(txt || "").replace(/\s+/g, " ").trim().slice(0, NOTICE_MAX);
  var botName = (users[botid] && users[botid].username) || "hostbot";
  var ref = firebase.database().ref("notices/" + uid).push();
  var notice = { txt: txt, time: firebase.database.ServerValue.TIMESTAMP, kind: opts.kind || "bot" };
  if (opts.card) notice.card = opts.card;
  if (opts.ttl) notice.expires = serverNow() + opts.ttl * 1000;
  return ref.set(notice).then(function() {
    push.toUser(uid, {
      kind: "bot", id: ref.key, title: botName, body: push.text(txt), from: botName, fromId: botid,
      time: Date.now(), tag: opts.tag || "bot-" + ref.key, url: opts.card ? "./#cards" : "./",
      silent: QUIET_NOTICES[notice.kind] === true
    }, { ttl: opts.ttl || 60 * 60, topic: opts.topic });
  }, function(err) {
    if (!/permission/i.test(err.code || err.message)) return console.log("couldn't send a notice:", err.message);
    if (!warnedOnce.notices) {
      warnedOnce.notices = true;
      console.log("notices: the database rules don't allow them yet (publish firebase-rules.json); pinging in chat until then.");
    }
    var name = (users[uid] && users[uid].username) || opts.name;
    talk(name ? "@" + name + " " + txt : txt, opts.card);
  });
};

// Notices are read (and removed) by the site; any left over after a day go
var pruneNotices = function() {
  var cutoff = serverNow() - 24 * 60 * 60 * 1000;
  var ref = firebase.database().ref("notices");
  shallowKeys("notices").then(function(people) {
    return Promise.all(people.map(function(uid) {
      return ref.child(uid).orderByChild("time").endAt(cutoff).once("value").then(function(snap) {
        var updates = {};
        snap.forEach(function(item) { updates[uid + "/" + item.key] = null; });
        return updates;
      });
    }));
  }).then(function(perPerson) {
    var updates = Object.assign.apply(null, [{}].concat(perPerson));
    if (Object.keys(updates).length) return ref.update(updates);
  }).catch(function(err) {
    if (!/permission/i.test((err && (err.code || err.message)) || "")) console.log("notice prune error:", err && err.message);
  });
};
setInterval(pruneNotices, 6 * 60 * 60 * 1000);

// What visitors' browsers report (the site's js/telemetry.js): errors in its
// scripts (clientErrors) and how fast each visit felt (clientVitals). The
// weekly Site health workflow (tools/site-health.js) reads the last week;
// anything older than two weeks goes, 500 at a time.
var REPORT_DAYS = 14;
var pruneReports = function() {
  var cutoff = serverNow() - REPORT_DAYS * 24 * 60 * 60 * 1000;
  ["clientErrors", "clientVitals"].forEach(function(path) {
    var ref = firebase.database().ref(path);
    var round = function() {
      return ref.orderByChild("at").endAt(cutoff).limitToFirst(500).once("value").then(function(snap) {
        var updates = {};
        snap.forEach(function(item) { updates[item.key] = null; });
        var n = Object.keys(updates).length;
        if (!n) return;
        return ref.update(updates).then(function() { if (n === 500) return round(); });
      });
    };
    round().catch(function(err) {
      if (!/permission/i.test((err && (err.code || err.message)) || "")) console.log(path + " prune error:", err && err.message);
    });
  });
};
setInterval(pruneReports, 6 * 60 * 60 * 1000);
setTimeout(pruneReports, 10 * 1000); // and soon after a start

// Room state only the bot writes (deck, line, spotlight, play limit, dance,
// colours). Everyone in the room downloads every write, even one that changes
// nothing, so only values that changed are sent.
var lastWritten = {};
var writeRoomState = function(values) {
  var changes = {};
  Object.keys(values).forEach(function(path) {
    var value = values[path] === undefined ? null : values[path];
    var json = JSON.stringify(value);
    if (lastWritten[path] === json) return;
    lastWritten[path] = json;
    changes[path] = value;
  });
  var paths = Object.keys(changes);
  if (!paths.length) return Promise.resolve();
  return firebase.database().ref().update(changes).catch(function(err) {
    paths.forEach(function(path) { delete lastWritten[path]; }); // send it again next time
    console.log("couldn't save " + paths.join(", ") + ":", err.message);
  });
};
var currentLimit = function() {
  return queue.length && table.length >= 4 ? playlimit : "∞";
};

var updateTable = function() {
  writeRoomState({ table: table });
  autoDJ.check();
};

var updateWaitlist = function() {
  writeRoomState({ waitlist: queue });
  autoDJ.check();
};

var updateLimit = function() {
  writeRoomState({ playlimit: currentLimit() });
};


// 🔥/🌧 on the playing song. The count of 🔥 (one per person, 🌧 takes theirs
// back) is published as songFires {started, count}, readable by anyone, for
// the site's live stage for other sites (firetable-user embed/stage/), which
// can't read the members-only chat; it ignores a count for another song.
var firelevel = {
  hot: function(id, name) {
    firelevel.fires[id] = true;
    firelevel.storms[id] = false;
    firelevel.publish();
    var fires = firelevel.size(firelevel.fires);
    var storms = firelevel.size(firelevel.storms);
    var level = fires - storms;
    if (level <= 0) {
      talk(name + " thinks this track is h0t... doesn't seem very hot...");
    } else if (level == 1) {
      talk(name + " thinks this track is h0t! A small fire has started.");
    } else if (level <= 7) {
      talk(name + " thinks this track is h0t! Fire is burnin' :chart_with_upwards_trend:");
    } else {
      talk(name + " thinks this track is h0t! FIRE LEVEL IS OFF THE CHARTS. CHARTS ON FIRE!");
    }
  },
  storm: function(id, name) {
    firelevel.fires[id] = false;
    firelevel.storms[id] = true;
    firelevel.publish();
    var fires = firelevel.size(firelevel.fires);
    var storms = firelevel.size(firelevel.storms);
    var level = fires - storms;
    if (level >= 4) {
      talk(name + " is trying to put out the DJ's fire... doesn't seem to matter...");
    } else if (level >= 1) {
      talk(name + " is trying to put out the DJ's fire... maybe this track isn't so hot afterall...");
    } else if (level == 0) {
      talk("fire is out. thanks " + name);
    } else if (level == -1) {
      talk("this track has caused a storm to form around " + name + ". hard to start a fire with all this rain...");
    } else if (level >= -5) {
      talk("the storm has expanded with the help of " + name + ". certainly not a h0t track.");
    } else {
      talk(":rotating_light: :warning: SEVERE WEATHER ALERT. STAY FAR AWAY FROM THIS TRACK.");
    }
  },
  clear: function() {
    firelevel.fires = {};
    firelevel.storms = {};
    writeRoomState({ songFires: null });
  },
  publish: function() {
    if (!song || !song.started || song.cid == 0) return;
    writeRoomState({ songFires: { started: song.started, count: firelevel.size(firelevel.fires) } });
  },
  fires: {},
  storms: {},
  size: function(obj) {
    var size = 0;
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        if (obj[key]) {
          size++;
        }
      }
    }
    return size;
  }
};

var newMusicCheck = function(data) {
  var daysAgo;
  var isNew = false;
  var playcount = 0;
  if (data.playcount) playcount = parseInt(data.playcount);
  if (data) {
    var dif = Date.now() - data.postedDate;
    daysAgo = Math.floor(dif / 1000 / 60 / 60 / 24);
    if (daysAgo <= 30 && !playcount) {
      isNew = true;
    }
  }
  return isNew;
};

var updateThings = function() {
  // One write, so clients never see the new deck with the old spotlight
  writeRoomState({
    table: table,
    waitlist: queue,
    playdex: playDex,
    playlimit: currentLimit()
  });
  autoDJ.check();
};

// Seat a new DJ at the back of the line: they play after everyone already on
// deck. They go just before the seat the spotlight is on, which is the DJ
// playing now (mid-song) or the DJ about to play (between songs, when
// nextSong() has already moved the spotlight on).
var seatDJ = function(pson) {
  if (!table.length) {
    table.push(pson);
    playDex = 0;
    return;
  }
  if (playDex < 0 || playDex >= table.length) playDex = 0;
  table.splice(playDex, 0, pson);
  playDex++;
};

// ─── When the next track can't be played ────────────────────────────────────
// Broken for good (deleted, private, blocked in the US, age restricted): flag
// it, move it to the bottom of the DJ's list and play their next track.
// Couldn't check it (YouTube quota or key trouble, SoundCloud down, network):
// flag nothing, try again a little later, then pass the decks along. That way
// an outage never marks good tracks as broken.
var LOOKUP_RETRY_DELAYS = [5000, 15000, 30000];
var startSeq = 0; // each startSong() call; older lookups that answer late are ignored
var retryTimer = null;
var lookupFailures = 0; // failed checks in a row this turn
var lookupDown = {}; // source -> true once the room was told it can't be reached

// Play this DJ's next track (or try this one again) after a pause.
var retrySameDJ = function(delay) {
  // startSong() counts a play each time it runs; this try played nothing
  if (theDJ && theDJ.plays > 0) theDJ.plays--;
  songLoading = false; // waiting, not loading: a skip may move on
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(function() {
    retryTimer = null;
    startSong(true);
  }, delay);
};

// Move a track to the bottom of its list (as `entry`) in one write: the old
// slot goes and the new one appears together, so a crash in between can't
// lose the track, and the DJ's site redraws the list once.
// (saved lean: a YouTube track's thumbnail and watch page follow from its id,
// so they aren't kept; every member downloads their whole playlist)
var moveToBottom = function(listRef, key, entry) {
  var updates = {};
  var newKey = listRef.push().key;
  updates[key] = null;
  updates[newKey] = tracks.lean(entry);
  return listRef.update(updates).then(function() { return newKey; }, function(error) {
    console.log("couldn't move the track to the bottom of the list: " + error.message);
    throw error;
  });
};

var flagAndRetry = function(listRef, key, track, code, message) {
  // keep everything saved with the track (artwork, page URL)
  var djid = theDJ.id;
  moveToBottom(listRef, key, bus.endOfSet(theDJ, Object.assign({}, track, { // a set's last track: the next one ends it
    flagged: { date: Date.now(), code: code }
  }), false)).then(function(newKey) {
    // the bot's YOUTUBE MUSIC playlist: put a YouTube Music copy in its place
    // now. Anyone else's list: look for one to suggest (one search, no quota)
    if (ytmOn && djid === botid && ytmSync().isList(listRef)) setTimeout(function() { ytmSync().track(listRef, newKey); }, 5000);
    // (the list's id says whether it's kept to SoundCloud or videos: no swaps there)
    else if (swapsOn) setTimeout(function() { swapper().track(djid, listRef, newKey, listRef.key === "list" && listRef.parent ? listRef.parent.key : "0"); }, 5000);
  }, function() {});
  if (theDJ.id !== botid && trackBrokenMessages) notify(theDJ.id, message, { kind: "track", name: theDJ.name });
  retrySameDJ(3000);
};

var lookupFailed = function(source, err) {
  var detail = (err && (err.message || err.code)) || String(err || "no answer");
  console.log("couldn't check the track on " + source + " (not flagging it): " + detail);
  if (lookupFailures < LOOKUP_RETRY_DELAYS.length) {
    retrySameDJ(LOOKUP_RETRY_DELAYS[lookupFailures++]);
    return;
  }
  // Still nothing: give the decks to the next DJ (their track may be on the
  // other service). Said once per outage, not every turn.
  if (!lookupDown[source]) {
    lookupDown[source] = true;
    talk("I can't reach " + source + " right now, so I'm passing the decks along. No tracks are being flagged; I'll keep trying.");
  }
  if (theDJ && theDJ.plays > 0) theDJ.plays--; // nothing played this turn
  nextSong(true);
};

// A lookup's callback that can't crash the bot: an error in it counts as a
// failed check (retry, then pass the decks), not a dead process.
var guarded = function(seq, source, fn) {
  return function() {
    try {
      return fn.apply(this, arguments);
    } catch (err) {
      console.log("error handling the " + source + " answer:", err);
      if (seq === startSeq) lookupFailed(source, err);
    }
  };
};

var lookupWorked = function(source) {
  lookupFailures = 0;
  if (lookupDown[source]) {
    lookupDown[source] = false;
    console.log(source + " is reachable again.");
  }
};

// ─── YouTube and SoundCloud lookups (lib/media.js) ──────────────────────────
var media = require("./lib/media").createMedia(process.env);
var scOfficial = media.scOfficial;
var youtubeVideo = media.youtubeVideo, soundcloudTrack = media.soundcloudTrack, soundcloudSearch = media.soundcloudSearch;
var youtubeProblems = media.youtubeProblems, youtubeSearch = media.youtubeSearch, youtubeVideos = media.youtubeVideos;
var youtubeSnippets = media.youtubeSnippets, youtubePlaylistItems = media.youtubePlaylistItems;

// ─── Starting a track ───────────────────────────────────────────────────────
var songLoading = false; // a track is being looked up (between turns); !skip waits
var songRanOut = false; // the song on the decks reached its end (for last.fm)
var skipNoticeFor = 0; // the load a "hang on" was already said for
var loadingSource = null; // what it's waiting on, for the watchdog's message
var LOAD_TIMEOUT = 30000; // no answer by then: count it as a failed check

var setColors = function(thecolors) {
  colors = thecolors;
  writeRoomState({ colors: thecolors });
};

// The room's colours, from the track's artwork (plain white without one, or if
// the image can't be read).
var applyArtworkColors = function(seq, image) {
  var plain = { color: "#fff", txt: "#fff" };
  if (!image || image === "img/idlogo.png") return setColors(plain);
  artworkColors(image).then(function(found) {
    if (seq !== startSeq) return; // a newer song has its own colours
    // just the accent the site uses; every song's colours go to everyone in
    // the room and into Recent, Fresh and cards
    setColors(found || plain);
  }).catch(function(err) {
    console.log("couldn't read the artwork's colours (" + image + "):", err && err.message);
    if (seq === startSeq) setColors(plain);
  });
};

// Put a looked-up track on the decks: publish it, colour the room from its
// artwork, move it to the bottom of the DJ's list and time the next song.
// listRef/track are the DJ's own list and entry, so a skip that lands while
// this runs can't put the track back into someone else's list.
var beginSong = function(seq, listRef, key, track, songInfo) {
  songLoading = false;
  if (!songInfo.image) songInfo.image = "img/idlogo.png";
  var totalseconds = songInfo.duration;
  applyArtworkColors(seq, songInfo.image);
  song = songInfo;
  firebase.database().ref("songToPlay").set(songInfo);
  repeats.played(songInfo); // passed over in everyone's lists for the next few hours
  lastfm.started(songInfo);
  // keep everything saved with the track, and remember SoundCloud artwork /
  // page URL learned just now
  var songBack = Object.assign({}, track, {
    cid: songInfo.cid,
    name: songInfo.artist + " - " + songInfo.title,
    type: songInfo.type
  });
  delete songBack.flagged;
  if (songInfo.type == 2) {
    if (!songBack.img && songInfo.image !== "img/idlogo.png") songBack.img = songInfo.image;
    if (!songBack.url && songInfo.url) songBack.url = songInfo.url;
  }
  moveToBottom(listRef, key, bus.endOfSet(theDJ, songBack, true)).then(function() { // the last of a set: step down after it
    if (seq === startSeq) gts.np(songInfo, listRef); // global tags, for the song still playing
  }, function() {});
  // move forward at the end of the song
  if (songTimeout != null) clearTimeout(songTimeout);
  songTimeout = setTimeout(function() {
    songTimeout = null;
    songRanOut = true; // played to its end, not skipped
    nextSong(); //NEEEEEEXT
  }, totalseconds * 1000);
};

var nextSong = function(noPrevPlay) {
  lookupFailures = 0; // a new turn starts with a full set of retries
  //we need to remove this song that just played to the bottom of dj's queue
  playDex++; //shift the spotlight to the right
  if (theDJ && theDJ.id == botid && theDJ.removeAfter && autoDJ.autoBus) {
    talk(":bus: Catching the bus. The decks are yours!");
  }
  if (queue.length && theDJ) {
    if (theDJ.removeAfter) {
      removePerson(theDJ.id);
    } else if (theDJ.plays >= playlimit) {
      var foundDJ = removePerson(theDJ.id);
      if (foundDJ && !theDJ.removeAfter) {
        //re-add this DJ to waitlist
        //if we didn't find them then I assume they left mid song?idk
        theDJ.plays = 0;
        queue.push(theDJ);
      }
    }
  } else if (theDJ) {
    if (theDJ.removeAfter) removePerson(theDJ.id);
  }
  // staying on: one song fewer on a !leaveafter countdown (not for a turn that played nothing)
  if (theDJ && !theDJ.removeAfter && !noPrevPlay) bus.played(theDJ);
  startSong(noPrevPlay);
};

// Every play, for good: Recent keeps only the last 500, so this is the room's
// history of who played what when (read by tools/history; only the bot can
// read or write it, so nobody's browser ever downloads it).
var logPlay = function(s, ranOut, fires) {
  if (!s || !s.cid || !s.started) return;
  var entry = {
    k: s.type + "" + s.cid,
    a: s.artist || null,
    t: s.title || null,
    s: s.songId || null,
    dj: s.djname || null,
    djid: s.djid || null,
    w: s.started,
    d: s.duration || null,
    p: Math.max(0, Math.round((serverNow() - s.started) / 1000)),
    sk: !ranOut,
    // the room's theme when it played, for theme nights in Discover
    th: typeof theme === "string" && theme ? theme.slice(0, 80) : null,
    // the room's !hot fires on it (Discover shows them; charts never count them)
    f: fires > 0 ? fires : null
  };
  firebase.database().ref("playLog").push(JSON.parse(JSON.stringify(entry))).then(function() {
    discoverPlayed();
  }, function(err) {
    console.log("play log error:", err && err.message);
  });
};

// A list the bot keeps to a fixed length: Recent plays (500) and Fresh (100).
// A listener keeps its keys, so the list downloads once at startup and then
// only changes, instead of the whole list after every song.
var trimmedList = function(path, max) {
  var ref = firebase.database().ref(path);
  var keys = [];
  ref.on("child_added", function(snap) {
    keys.push(snap.key);
    if (keys.length > 1 && keys[keys.length - 2] > snap.key) keys.sort();
  });
  ref.on("child_removed", function(snap) {
    var i = keys.indexOf(snap.key);
    if (i !== -1) keys.splice(i, 1);
  });
  return {
    /** Save `entry`; resolves its key (null if it couldn't be saved). */
    add: function(entry) {
      var pushed = ref.push(entry);
      var saved = pushed.then(function() { return pushed.key; }, function(err) {
        console.log("couldn't save to " + path + ":", err.message);
        return null;
      });
      // oldest first (push keys sort by time)
      keys.slice(0, Math.max(0, keys.length - max)).forEach(function(key) {
        ref.child(key).remove();
      });
      return saved;
    }
  };
};
var recentPlays = trimmedList("songHistory", 500);

/**
 * A play's genre on its Recent plays row (`g`, the song's first genre in
 * globalSongs), once the history job has linked the track. The site's sound
 * map rings the genres played tonight with it. Nothing is written when the
 * song isn't linked yet or has no genre.
 */
var playGenre = function(path, entry) {
  var db = firebase.database();
  return db.ref("globalTracks/" + entry.type + entry.cid + "/song").once("value").then(function(s) {
    var id = s.val();
    if (!id) return null;
    return db.ref("globalSongs/" + id + "/genres/0").once("value").then(function(g) {
      var genre = g.val();
      if (typeof genre === "string" && genre) return db.ref(path + "/g").set(genre.slice(0, 80));
      return null;
    });
  }).catch(function(err) {
    console.log("couldn't add the genre to " + path + ":", err && err.message);
  });
};
var freshPlays = trimmedList("newMusic", 100);

// The list a DJ plays from: their chosen playlist, or their default queue.
var djListRef = function(djid) {
  var selectedList = (users[djid] || {}).selectedList;
  if (selectedList && selectedList != "0") {
    return firebase.database().ref("playlists/" + djid + "/" + selectedList + "/list");
  }
  return firebase.database().ref("queues/" + djid);
};

// The playing song's list. After a restart mid-song the bot hasn't picked a
// track yet, so it's worked out from the song's DJ.
var currentListRef = function() {
  if (!queueRef && song && song.djid && song.cid) queueRef = djListRef(song.djid);
  return queueRef;
};

// A number from the environment (unset or not a number: the fallback)
var envNumber = function(name, fallback) {
  var n = Number(process.env[name]);
  return process.env[name] && n >= 0 ? n : fallback;
};

// The track a DJ's list plays next: neither flagged nor played in the last
// REPEAT_HOURS (lib/repeats.js; the site warns on those rows).
var repeats = require("./lib/repeats").createRepeats({
  db: function() { return firebase.database(); }, now: serverNow, hours: envNumber("REPEAT_HOURS", 4)
});
var repeatMessages = !/^(false|0|off|no)$/i.test(String(process.env.REPEAT_MESSAGES || "").trim());

var startSong = function(noPrevPlay) {
  var seq = ++startSeq;
  if (retryTimer) {
    // a skip or a new DJ got here first; that retry isn't needed anymore
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (songTimeout != null) {
    // the last song is over (or was skipped): its end-of-song timer must not
    // move the decks again while this one is being looked up
    clearTimeout(songTimeout);
    songTimeout = null;
  }
  var songFires = firelevel.size(firelevel.fires); // before they're cleared, for the play log
  firelevel.clear();
  writeRoomState({ dance: false });
  robotsDancing = false;
  cardGiftedThisSong = false;
  if (song && !noPrevPlay) {
    if (song.cid != 0) {
      var newEntry = {
        artist: song.artist,
        title: song.title,
        dj: song.djname || (theDJ && theDJ.name) || null,
        djid: song.djid || (theDJ && theDJ.id) || null,
        type: song.type,
        duration: song.duration,
        url: song.url,
        cid: song.cid,
        colors: { color: colors.color, txt: colors.txt },
        when: song.started,
        postedDate: song.postedDate,
        img: song.image,
        theme: typeof theme === "string" && theme ? theme.slice(0, 80) : null
      };
      if (song.adamid) newEntry.adamid = song.adamid;
      if (song.playcount) newEntry.playcount = song.playcount;
      newEntry = JSON.parse(JSON.stringify(newEntry)); // Firebase refuses undefined fields
      recentPlays.add(newEntry).then(function(key) { if (key) playGenre("songHistory/" + key, newEntry); });
      logPlay(song, songRanOut, songFires);
      var isNew = newMusicCheck(newEntry);
      if (isNew) {

        if (Math.floor(Math.random() * 15) == 5) printCard(newEntry);

        // NEW MUSIC
        freshPlays.add(newEntry);
      }
    }
  }
  lastfm.ended(songRanOut); // scrobble the song that just ended, if it played long enough
  songRanOut = false;
  if (!table.length) autoDJ.fillEmptyTable();
  if (!table.length) {
    songLoading = false;
    console.log("no length");
    var s2p = firebase.database().ref("songToPlay");
    var now = serverNow();
    var songInfo = {
      type: 1,
      cid: 0,
      title: "Nothing Is Playing",
      started: now,
      url: null,
      duration: 0,
      image: "img/idlogo.png",
      artist: "You could (should) queue something!"
    };
    song = songInfo;
    s2p.set(songInfo);
    setColors({ color: "#fff", txt: "#fff" });
    updateThings();
    return false;
  };
  if (playDex > table.length - 1) {
    playDex = 0;
  }
  theDJ = table[playDex];
  table[playDex].plays = (table[playDex].plays || 0) + 1;
  songLoading = true;
  loadingSource = "that DJ's playlist";
  setTimeout(function() {
    if (seq === startSeq && songLoading) lookupFailed(loadingSource, new Error("no answer in " + LOAD_TIMEOUT / 1000 + " seconds"));
  }, LOAD_TIMEOUT);
  updateThings();
  queueRef = djListRef(theDJ.id);

  var listRef = queueRef; // this DJ's list, even if queueRef moves on meanwhile
  repeats.firstPlayable(listRef).then(function(found) {
    if (seq !== startSeq) return; // skipped or restarted meanwhile
    var skippedNote = repeatMessages && found && theDJ.id !== botid && repeats.notice(theDJ.id, found);
    if (skippedNote) notify(theDJ.id, skippedNote, { kind: "track", name: theDJ.name, ttl: 60 * 60 });
    var data = {};
    var goodTrack = null;
    if (found) {
      goodTrack = found.key;
      data[goodTrack] = found.track;
    }
    if (goodTrack) {
      var nextSongkey = goodTrack;
      if (data[nextSongkey].type == 1) {
        loadingSource = "YouTube";
        youtubeVideo(data[nextSongkey].cid, guarded(seq, "YouTube", function(error, result) {
          if (seq !== startSeq) return; // skipped or restarted while YouTube answered
          if (error || !result || !Array.isArray(result.items)) {
            // quota, API key or network trouble: the track itself may be fine
            lookupFailed("YouTube", error);
          } else {
            lookupWorked("YouTube");
            // gone, private, not embeddable, blocked here, age restricted or
            // a premiere that hasn't started: flag it and play the next one
            var ytProblem = checks.youtubeProblem(result.items[0]);
            if (ytProblem) {
              flagAndRetry(listRef, nextSongkey, data[nextSongkey], ytProblem,
                checks.problemMessage(ytProblem, "https://www.youtube.com/watch?v=" + data[nextSongkey].cid));
            } else {
              var video = result.items[0];
              var snippet = video.snippet || {};
              var yargo = splitTags(data[nextSongkey].name);
              var sartist = yargo[0];
              var stitle = yargo[1];
              var input = (video.contentDetails && video.contentDetails.duration) || "";
              var reptms = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;
              var totalseconds = 10 * 60; // unknown length: give it 10 minutes
              var matches = reptms.exec(input);
              if (matches) {
                // a live stream says 0: give it the 10 minutes too
                totalseconds = Number(matches[1] || 0) * 3600 + Number(matches[2] || 0) * 60 + Number(matches[3] || 0) || totalseconds;
              }
              var rawChannel = String(snippet.channelTitle || "Unknown");
              // a new release YouTube hasn't sorted into the artist's own
              // "Artist - Topic" channel yet sits in "Release - Topic" (or
              // "Various Artists - Topic"): its description names the artist
              var channel = swaps.topicChannel(rawChannel, snippet.description, snippet.title);
              var channelName = swaps.isStandIn(channel) ? "Unknown" : channel.replace(" - Topic", "");
              if (!stitle) {
                stitle = sartist;
                sartist = channelName;
              } else if (sartist == "Unknown" || (channel !== rawChannel && swaps.isStandIn(sartist))) {
                // saved as "Release - Song" (named from the stand-in channel)
                sartist = channelName;
              }
              var thumbs = snippet.thumbnails || {};
              beginSong(seq, listRef, nextSongkey, data[nextSongkey], {
                type: data[nextSongkey].type,
                cid: data[nextSongkey].cid,
                title: stitle,
                started: serverNow(),
                duration: totalseconds,
                url: "https://www.youtube.com/watch?v=" + data[nextSongkey].cid,
                artist: sartist,
                image: (thumbs.medium || thumbs.default || {}).url || null,
                djid: theDJ.id,
                postedDate: new Date(snippet.publishedAt).getTime() || Date.now(),
                djname: theDJ.name,
                key: nextSongkey
              });
            }
          }
        }));

      } else if (data[nextSongkey].type == 2) {
        /*
begin sc check
        */
        loadingSource = "SoundCloud";
        soundcloudTrack(data[nextSongkey].cid, guarded(seq, "SoundCloud", function(error, status, scTrack) {
          if (seq !== startSeq) return; // skipped or restarted while SoundCloud answered
          if (status == 404 || status == 410) {
            // SoundCloud answered: the track is gone (deleted or private)
            lookupWorked("SoundCloud");
            flagAndRetry(listRef, nextSongkey, data[nextSongkey], 4, checks.problemMessage(4));
          } else if (!scTrack || !scTrack.id) {
            // down, rate limited or refusing the key: the track itself may be fine
            lookupFailed("SoundCloud", error || ("HTTP " + status));
          } else if (checks.soundcloudProblem(scTrack)) {
            // blocked, private, not streamable or only a 30-second preview
            lookupWorked("SoundCloud");
            var scProblem = checks.soundcloudProblem(scTrack);
            flagAndRetry(listRef, nextSongkey, data[nextSongkey], scProblem,
              checks.problemMessage(scProblem, scTrack.permalink_url || "that SoundCloud track"));
          } else {
            lookupWorked("SoundCloud");
            var uploader = (scTrack.user && scTrack.user.username) || "Unknown";
            var yargo = splitTags(data[nextSongkey].name);
            var sartist = yargo[0];
            var stitle = yargo[1];
            if (sartist == "Unknown" && !stitle) {
              var cutetags = splitTags(scTrack.title);
              sartist = cutetags[0];
              stitle = cutetags[1];
            }
            if (!stitle) {
              stitle = sartist;
              sartist = uploader;
            }
            if (sartist == "Unknown") sartist = uploader;
            beginSong(seq, listRef, nextSongkey, data[nextSongkey], {
              type: data[nextSongkey].type,
              cid: data[nextSongkey].cid,
              title: stitle,
              started: serverNow(),
              url: scTrack.permalink_url || null,
              duration: Math.floor((Number(scTrack.duration) || 600000) / 1000),
              artist: sartist,
              image: scTrack.artwork_url || null,
              postedDate: new Date(scTrack.created_at).getTime() || Date.now(),
              djid: theDJ.id,
              djname: theDJ.name,
              key: nextSongkey
            });
          }
        }));
        /*
end sc check
        */
      } else {
        // a kind of track this bot can't play
        flagAndRetry(listRef, nextSongkey, data[nextSongkey], 2, checks.problemMessage(2));
      }

    } else {
      console.log("nothing playable in " + listRef.toString() + ": " + theDJ.name + " steps down");
      songLoading = false;
      if (theDJ.id == botid) {
        autoDJ.crateEmpty();
      } else {
        // never take someone off the decks without saying why
        talk(theDJ.name + "'s DJ playlist has nothing I can play, so they're off the decks.");
        notify(theDJ.id, "Your DJ playlist has nothing I can play (it's empty, or every track in it is flagged ⚠), so I took you off the decks. " +
          "Pick a playlist with playable tracks as your DJ playlist, then hop back on.", { kind: "track", name: theDJ.name });
      }
      removePerson(theDJ.id);
      nextSong(true);
    }
  }).catch(function(err) {
    // couldn't read the DJ's list (or a bug above): try again, don't stall
    if (seq !== startSeq) return;
    console.log("couldn't start the next song:", err);
    lookupFailed("that DJ's playlist", err);
  });
};

var printCard = function(newEntry) {
  if (!newEntry){
    if (!song || !song.cid) return talk("Nothing's playing, so there's no card to print.");
    newEntry = {
        artist: song.artist,
        title: song.title,
        dj: song.djname || (theDJ && theDJ.name),
        djid: song.djid || (theDJ && theDJ.id),
        type: song.type,
        duration: song.duration,
        url: song.url,
        cid: song.cid,
        colors: { color: colors.color, txt: colors.txt },
        when: song.started,
        postedDate: song.postedDate,
        img: song.image,
        theme: typeof theme === "string" && theme ? theme.slice(0, 80) : null
      };
  }
  var now = Date.now();
  var cardCount = firebase.database().ref("cardCount");
  // a transaction, so two cards printed at once never share a number
  cardCount.transaction(function(count) {
    return (count || 0) + 1;
  }).then(function(result) {
    if (!result.committed) return;
    totalCards = result.snapshot.val();
    var thenum = Math.floor(Math.random() * 9) + 1;
    var tempWeighter = Math.floor(Math.random() * 100) + 1;
    var max;
    var min;
    if (tempWeighter <= 75) {
      max = 130;
      min = 110;
    } else if (tempWeighter <= 95) {
      max = 230;
      min = 131;
    } else {
      min = 231;
      max = 420;
    }
    var thetemp = Math.floor(Math.random() * (max - min)) + min;

    var cardData = {
      djname: newEntry.dj,
      djid: newEntry.djid,
      cid: newEntry.cid,
      num: thenum,
      temp: thetemp,
      colors: newEntry.colors,
      cardnum: totalCards,
      title: newEntry.title,
      artist: newEntry.artist,
      image: newEntry.img,
      date: now,
      special: cardSpecial,
      owner: false
    };
    Object.assign(cardData, cardAvatar(newEntry.djid));
    cardData = JSON.parse(JSON.stringify(cardData)); // Firebase refuses undefined fields

    var ref = firebase.database().ref("cards");
    var cuteCard = ref.push(cardData, function(err) {
      if (err) return console.log("couldn't print a card:", err.message);
      cardForGrabs = cuteCard.key;
      talk("A new trading card has been printed!", null, {
        grab: cuteCard.key,
        plain: "A new trading card has been printed. Type !grab to grab it for yourself!"
      });
    });
  }).catch(function(err) {
    console.log("couldn't print a card:", err && err.message);
  });
};

// !grab (typed, or the site's GRAB button, which sends "!grab <card id>"):
// the first one gets the card and the room sees it in chat (#245). A button
// for a card that's gone (grabbed, or a newer one printed) gets a quiet "too
// late" that also greys that button out.
var giveCard = function(id, name, wanted) {
  if (!cardForGrabs || (wanted && wanted != cardForGrabs)) {
    if (wanted) notify(id, "Too late, that card's gone. Watch the chat for the next one!", { card: wanted, kind: "grab-missed", name: name });
    return;
  }
  var cardid = cardForGrabs;
  cardForGrabs = null;
  firebase.database().ref("cards/" + cardid + "/owner").set(id).then(function() {
    talk(name + " grabbed the card!", cardid);
  }, function(err) {
    console.log("couldn't give a card:", err.message);
  });
};

var THEME_MAX_LENGTH = 80;
var THEME_SUGGEST_COOLDOWN = 15 * 60 * 1000;
var themevote = {
  active: false,
  params: null,
  lastBy: {}, // uid -> when they last started a vote
  go: function(txt, name) {
    themevote.active = true;
    var requiredVotes = 4;
    talk("@everyone " + name + " wants to change the theme to '" + txt + "'. Needs " + requiredVotes + " vote(s) to change. Say 1 to vote yes.");
    themevote.params = {
      votes: {},
      guy: name,
      required: requiredVotes,
      votingfor: txt
    };
    setTimeout(function() {
      themevote.end();
    }, 60 * 1000);
  },
  size: function(obj) {
    var size = 0;
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) size++;
    }
    return size;
  },
  end: function() {
    var votes = themevote.size(themevote.params.votes);

    if (votes >= themevote.params.required) {
      setTheme(themevote.params.votingfor);
      talk(votes + " vote(s). The theme is now " + theme + "!");
    } else if (theme) {
      talk("Sorry. We're staying with " + theme + ".");
    } else {
      talk("Sorry. Not enough votes to set theme.");
    }

    themevote.params = null;
    themevote.active = false;
  }
};

var setTheme = function(themeIdea) {
  theme = themeIdea;
  var ref = firebase.database().ref("theme");
  ref.set(theme);
};

var removeMe = function(id) {
  for (var i = 0; i < queue.length; i++) {
    if (queue[i].id == id) {
      queue.splice(i, 1);
      updateWaitlist();
      return true;
    }
  }
  for (var t = 0; t < table.length; t++) {
    if (table[t].id == id) {
      if (theDJ && id == theDJ.id) {
        // The DJ playing now leaves: end the song. nextSong() takes them off
        // and gives the seat to the waitlist.
        theDJ.removeAfter = true;
        table[t].removeAfter = true;
        nextSong();
        return true;
      }
      table.splice(t, 1);
      // keep the spotlight on the DJ playing now
      if (t < playDex) playDex = playDex - 1;
      if (playDex >= table.length) playDex = 0;
      if (queue.length) seatDJ(queue.shift());
      updateThings();
      return true;
    }
  }
  return false;
};


// Take a DJ off the deck between songs (nextSong() has already moved the
// spotlight on) and give the seat to the first person on the waitlist.
var removePerson = function(id) {
  for (var i = 0; i < table.length; i++) {
    if (table[i].id == id) {
      table.splice(i, 1);
      // keep the spotlight on the same DJ when someone to its left leaves
      if (i < playDex) playDex = playDex - 1;
      if (playDex >= table.length) playDex = 0;
      if (queue.length) seatDJ(queue.shift());
      return true;
    }
  }
  return false;
};

var addCheck = function(id, hereCheck) {
  if (hereCheck && !(users[id] && users[id].status)) return 3;
  for (var i = 0; i < queue.length; i++) {
    if (queue[i].id == id) {
      return 1;
    }
  }
  for (var t = 0; t < table.length; t++) {
    if (table[t].id == id) {
      return 2;
    }
  }
  return false;
};

// ─── Autopilot DJ ────────────────────────────────────────────────────────────
// The bot keeps the music going: it takes the decks whenever no one is DJing,
// and once 3 people are DJing it catches the bus (steps down after its next
// song, never mid-song). If the count drops below 3 before it leaves, it stays.
//
// Overrides: !upbot (stay on), !downbot (stay off), and a mod's !add, !remove,
// !removeafter or !dontremove aimed at the bot. An override lasts until the
// next trigger (the decks emptying, or the DJ count reaching 3); then the
// autopilot takes over again. !autodj shows the state; mods can say
// !autodj auto to end an override now. AUTODJ=false turns the autopilot off.
var AUTODJ_CROWD = 3; // human DJs on deck that send the bot home
var AUTODJ_EMPTY_CRATE_WAIT = 15 * 60000; // bot's playlist was empty: wait this long
var autoDJ = {
  enabled: !/^(false|0|off|no)$/i.test(String(process.env.AUTODJ || "true").trim()),
  mode: "auto", // "auto", "up" (stay on) or "down" (stay off)
  autoBus: false, // the autopilot set the bot's bus, so it may cancel it
  lastHumans: null, // human DJs on deck at the last check (null: no baseline yet)
  emptyUntil: 0,
  loaded: false,
  pending: false,

  humans: function() {
    var n = 0;
    for (var i = 0; i < table.length; i++) {
      if (table[i] && table[i].id != botid) n++;
    }
    return n;
  },
  botName: function() {
    return (users && users[botid] && users[botid].username) || botid;
  },
  botSeat: function() {
    for (var i = 0; i < table.length; i++) {
      if (table[i].id == botid) return table[i];
    }
    return null;
  },
  save: function() {
    firebase.database().ref("autodj").set({
      mode: autoDJ.mode,
      autoBus: autoDJ.autoBus
    }).catch(function(e) {
      console.log("autodj save failed: " + e.message);
    });
  },
  setMode: function(mode) {
    if (autoDJ.mode === mode) return;
    autoDJ.mode = mode;
    console.log("autodj mode: " + mode);
    autoDJ.save();
  },
  // A command overrides the autopilot. Triggers are measured from now.
  override: function(mode) {
    autoDJ.lastHumans = autoDJ.humans();
    autoDJ.autoBus = false;
    autoDJ.mode = mode;
    console.log("autodj mode: " + mode);
    autoDJ.save();
  },
  // Track the human DJ count. A trigger (decks emptied, or the count reached
  // 3) ends any override.
  observe: function() {
    var humans = autoDJ.humans();
    var prev = autoDJ.lastHumans;
    autoDJ.lastHumans = humans;
    if (prev === null || prev === humans || autoDJ.mode === "auto") return humans;
    if (humans === 0 || (prev < AUTODJ_CROWD && humans >= AUTODJ_CROWD)) autoDJ.setMode("auto");
    return humans;
  },
  ready: function() {
    return autoDJ.enabled && autoDJ.loaded && started && botid && users && users[botid];
  },
  shouldJoin: function(humans) {
    return autoDJ.mode === "auto" && humans === 0 && !addCheck(botid) && Date.now() >= autoDJ.emptyUntil;
  },
  seatBot: function() {
    table.push({ name: autoDJ.botName(), id: botid, plays: 0 });
    playDex = 0;
    talk("No one's on the decks, so I'll keep the music going. Hop on anytime!");
  },
  // startSong() found the deck empty: seat the bot so it plays next, no gap.
  fillEmptyTable: function() {
    if (!autoDJ.ready() || table.length) return false;
    if (!autoDJ.shouldJoin(autoDJ.observe())) return false;
    autoDJ.seatBot();
    return true;
  },
  // Run after the table or waitlist changes, once per tick.
  check: function() {
    if (autoDJ.pending) return;
    autoDJ.pending = true;
    setImmediate(function() {
      autoDJ.pending = false;
      autoDJ.run();
    });
  },
  run: function() {
    if (!autoDJ.ready()) return;
    var humans = autoDJ.observe();
    var seat = autoDJ.botSeat();
    if (!seat && autoDJ.autoBus) {
      autoDJ.autoBus = false;
      autoDJ.save();
    }
    if (autoDJ.mode !== "auto") return;
    if (autoDJ.shouldJoin(humans)) {
      if (!table.length) {
        autoDJ.seatBot();
        startSong(true);
      }
    } else if (humans >= AUTODJ_CROWD) {
      autoDJ.catchBus(seat);
    } else if (seat && autoDJ.autoBus && seat.removeAfter) {
      autoDJ.stayOn(seat, humans);
    }
  },
  catchBus: function(seat) {
    if (!seat) {
      // waiting in line: no song to finish, just step out
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].id == botid) {
          queue.splice(i, 1);
          updateWaitlist();
          updateLimit();
          return;
        }
      }
      return;
    }
    if (seat.removeAfter) return; // already leaving
    var playing = theDJ && theDJ.id == botid;
    seat.removeAfter = true;
    if (playing) theDJ.removeAfter = true;
    autoDJ.autoBus = true;
    autoDJ.save();
    talk(AUTODJ_CROWD + " DJs on deck! I'll catch the bus after " + (playing ? "this song." : "my next song."));
    updateTable();
  },
  stayOn: function(seat, humans) {
    seat.removeAfter = false;
    if (theDJ && theDJ.id == botid) theDJ.removeAfter = false;
    autoDJ.autoBus = false;
    autoDJ.save();
    talk("Down to " + humans + " DJ" + (humans == 1 ? "" : "s") + ", so I'll stay on after all.");
    updateTable();
  },
  // The bot's DJ playlist has nothing playable: stop trying for a while.
  crateEmpty: function() {
    autoDJ.emptyUntil = Date.now() + AUTODJ_EMPTY_CRATE_WAIT;
    talk("My DJ playlist is empty, so I can't keep the music going. Add some tracks to it and I'll be back.");
    setTimeout(autoDJ.check, AUTODJ_EMPTY_CRATE_WAIT + 1000);
  },
  status: function() {
    if (!autoDJ.enabled) return "Autopilot is off.";
    if (autoDJ.mode === "up") return "Autopilot is paused: I'm staying on the decks until they empty or " + AUTODJ_CROWD + " people are DJing.";
    if (autoDJ.mode === "down") return "Autopilot is paused: I'm staying off the decks until they empty or " + AUTODJ_CROWD + " people are DJing.";
    return "Autopilot is on: I DJ when no one else is, and catch the bus once " + AUTODJ_CROWD + " people are DJing.";
  }
};

firebase.database().ref("autodj").once("value").then(function(snap) {
  var saved = snap.val() || {};
  if (saved.mode === "up" || saved.mode === "down") autoDJ.mode = saved.mode;
  autoDJ.autoBus = !!saved.autoBus;
}).catch(function(e) {
  console.log("autodj load failed: " + e.message);
}).then(function() {
  autoDJ.loaded = true;
  autoDJ.check();
});

// Every member's profile, kept current one person at a time: a change (an
// idle update, someone joining) updates that one entry instead of rebuilding
// the whole list from scratch, as a single listener on all of users/ did.
// It also notes when each person's presence last changed (the blip detector,
// for the "are you there?" check and !lastblipped).
var usersRef = firebase.database().ref("users");
var usersLoaded = false;
// the live stage's public summary (lib/stage.js): who's in the room and at
// the table, for the embed on QueUp, which would otherwise follow all of users/
// each DJ's grab stats, summed (lib/grabs.js), so the site needn't download
// every grab a DJ has had at every sign-in
var grabSummaries = grabCounts.createGrabCounts({ db: firebase.database(), log: console.log });
// lists of songs people import on the site (lib/imports.js): each found in the
// room's own uploads first, then with the swap search's free lookups
var songImports = imports.createImports({
  db: firebase.database(),
  lookup: function(items, o) { return swapper().lookup(items, o); },
  verify: function(cids) { return youtubeProblems(cids); },
  scSearch: process.env.SOUNDCLOUD_SWAPS === "false" ? null : function(q) { return soundcloudSearch(q); },
  // Spotify playlists (1.21): only with SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env
  spotify: spotify.createSpotify({
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    http: http
  }),
  log: console.log
});
var stagePub = stage.createStage({
  db: firebase.database(),
  users: function() { return users; },
  botid: function() { return botid; },
  log: console.log
});
var keepBotOnline = function() {
  if (botid && users[botid] && !users[botid].status) {
    firebase.database().ref("users/" + botid + "/status").set(true);
  }
};
usersRef.on("child_added", function(snap) {
  var u = snap.val();
  users[snap.key] = u;
  if (u && u.status) lastBlipped[snap.key] = Date.now();
  if (usersLoaded) autoDJ.check();
  stagePub.changed();
});
usersRef.on("child_changed", function(snap) {
  var before = users[snap.key];
  var u = snap.val();
  users[snap.key] = u;
  if ((before && before.status) || (u && u.status)) lastBlipped[snap.key] = Date.now();
  // came online: their lists get a swap pass soon if it's been a day
  if (swapsOn && started && snap.key !== botid && u && u.status && !(before && before.status)) {
    swapper().online(snap.key).catch(function() {});
  }
  if (snap.key === botid) keepBotOnline();
  autoDJ.check(); // the bot needs its own profile before it can sit down
  stagePub.changed();
});
usersRef.on("child_removed", function(snap) {
  if (users[snap.key] && users[snap.key].status) lastBlipped[snap.key] = Date.now();
  delete users[snap.key];
  stagePub.changed();
});
// the same data the listeners above download, so this costs nothing extra
usersRef.once("value").then(function() {
  usersLoaded = true;
  keepBotOnline();
  autoDJ.check();
  markChatReady();
}).catch(function(err) {
  console.log("couldn't read the members (" + err.message + "); commands wait until they load");
});

var refCardSpecial = firebase.database().ref("cardSpecial");
refCardSpecial.on('value', function(dataSnapshot) {
  var resultActual = dataSnapshot.val();
  if (resultActual) {
    cardSpecial = resultActual;
  } else {
    cardSpecial = false;
  }
});

var themepeek = firebase.database().ref("theme");
themepeek.once("value").then(function(snapshot) {
  var data = snapshot.val();
  if (!data) {
    theme = null;
  } else {
    theme = data;
  }
});

// The site stamps 🔥/🌧 reactions with the song they were sent for
// (songToPlay.started). One that arrives after the song changed is for the
// previous song and must not count towards this one.
var reactionForOtherSong = function(chatData) {
  return !!(chatData.forSong && song && song.started && chatData.forSong !== song.started);
};

// ─── Song tempo (BPM): Deezer, cached in bpm/ (lib/bpm.js) ──────────────────
var bpmLib = require("./lib/bpm");
var BPM_MIN = bpmLib.BPM_MIN, BPM_MAX = bpmLib.BPM_MAX, bpmKey = bpmLib.bpmKey;
var tempo = bpmLib.createTempo({ db: function() { return firebase.database(); }, song: function() { return song; } });
var setSongBpm = tempo.setSongBpm;
tempo.watch();

// !flag / !flagplay reasons
var flagCodeFor = function(reason) {
  if (reason == "broken" || reason == "8") return 8;
  if (reason == "bitrate" || reason == "quality" || reason == "incomplete" || reason == "9") return 9;
  if (reason == "offtheme" || reason == "10") return 10;
  return false;
};

// Flag a track in all of a DJ's lists (default queue and every playlist).
// Resolves with how many copies were flagged.
// The child keys of a path without their contents (the database's REST
// "shallow" read, signed in as the bot). Falls back to a full read.
var shallowKeys = function(path) {
  var user = firebase.auth().currentUser;
  var full = function() {
    return firebase.database().ref(path).once("value").then(function(snap) {
      var keys = [];
      snap.forEach(function(child) {
        keys.push(child.key);
      });
      return keys;
    });
  };
  if (!user || !process.env.FIREBASE_DB || typeof fetch !== "function") return full();
  return user.getIdToken().then(function(token) {
    var url = new URL(process.env.FIREBASE_DB);
    url.pathname = url.pathname.replace(/\/?$/, "/") + path + ".json";
    url.searchParams.set("shallow", "true");
    url.searchParams.set("auth", token);
    return fetch(url, { signal: AbortSignal.timeout(15000) });
  }).then(function(res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function(data) {
    return data && typeof data === "object" ? Object.keys(data) : [];
  }).catch(function(err) {
    console.log("shallow read of " + path + " failed (" + err.message + "); reading it in full");
    return full();
  });
};

var flagTrackForDJ = function(djid, cid, type, flag) {
  var db = firebase.database();
  var lists = [db.ref("queues/" + djid)];
  // just the playlist ids, not every track in them
  return shallowKeys("playlists/" + djid).then(function(listIds) {
    listIds.forEach(function(id) {
      lists.push(db.ref("playlists/" + djid + "/" + id + "/list"));
    });
    return Promise.all(lists.map(function(ref) {
      return ref.orderByChild("cid").equalTo(cid).once("value").then(function(s) {
        var writes = [];
        s.forEach(function(t) {
          if (t.val() && t.val().type == type) writes.push(ref.child(t.key + "/flagged").set(flag));
        });
        return Promise.all(writes).then(function() { return writes.length; });
      });
    }));
  }).then(function(counts) {
    return counts.reduce(function(a, b) { return a + b; }, 0);
  });
};

// ─── Swap suggestions for broken tracks (lib/swaps.js) ──────────────────────
// Every night (SWAP_HOUR, 4 a.m. by default, in TZ) the bot looks through
// everyone's playlists for flagged tracks, finds the same recording (a
// YouTube Music audio track; a video for lists kept to videos) and saves it
// with the track as a suggestion; the site shows a swap button. Free sources
// first: other uploads the room has played, the year playlists, YouTube
// Music's and YouTube's searches. Songs none of them has get the YouTube
// Data API's search, within SWAP_API_UNITS a day (1,000 by default: 10
// searches; 0 turns it off). A track the bot flags while playing is looked up
// straight away (free sources only). SWAP_SUGGESTIONS=false turns it off.
var swapsOn = process.env.SWAP_SUGGESTIONS !== "false";
var SWAP_HOUR = parseInt(process.env.SWAP_HOUR, 10);
if (!(SWAP_HOUR >= 0 && SWAP_HOUR <= 23)) SWAP_HOUR = 4;
var SWAP_MAX_SEARCHES = parseInt(process.env.SWAP_MAX_SEARCHES, 10) || 600;
// Catch-up passes: what a night's run couldn't get to (its search limits, a
// source that was rate-limited) is picked up the same day, pass after pass,
// SWAP_CATCHUP_MINUTES apart (30), within SWAP_DAILY_SEARCHES free searches
// (6,000) and SWAP_MAX_PASSES passes (24) a day. Someone who comes online
// with lists not looked through for SWAP_RESCAN_HOURS (20) gets a pass in a
// few minutes. SWAP_CATCHUP=false: the nightly run only.
var SWAP_CATCHUP = process.env.SWAP_CATCHUP !== "false";
// (the numbers are read with envNumber when the swapper starts)
// songs a run looks up on artist and album pages and in Apple's catalog
// (each a few requests, so capped apart)
var SWAP_MAX_DEEP = parseInt(process.env.SWAP_MAX_DEEP, 10) || 300;
var SWAP_API_UNITS = parseInt(process.env.SWAP_API_UNITS, 10);
if (!(SWAP_API_UNITS >= 0)) SWAP_API_UNITS = 1000;


// Other uploads of the same song the room has played: globalTracks links
// every upload to its song (once the play history is published), and has
// each one's tags. Up to 25 a song, YouTube ones only.
var songSiblings = function(uploads) {
  var db = firebase.database();
  var seen = {};
  return Promise.all((uploads || []).map(function(u) {
    return db.ref("globalTracks/" + u.type + u.cid + "/song").once("value").then(function(s) { return s.val(); }, function() { return null; });
  })).then(function(songs) {
    var seenSong = new Set();
    songs = songs.filter(function(id) {
      if (!id || seenSong.has(id)) return false;
      seenSong.add(id);
      return true;
    });
    return Promise.all(songs.map(function(id) {
      return db.ref("globalTracks").orderByChild("song").equalTo(id).limitToFirst(25).once("value").then(function(snap) {
        var out = [];
        snap.forEach(function(c) {
          var v = c.val() || {};
          if (c.key.charAt(0) !== "1" || seen[c.key]) return;
          seen[c.key] = true;
          out.push({ cid: c.key.slice(1), artist: String(v.artist || ""), title: String(v.title || "") });
        });
        return out;
      }, function() { return []; });
    }));
  }).then(function(lists) { return [].concat.apply([], lists); });
};

// A YouTube Music playlist's tracks (no quota), remembered for 3 hours, so
// the swap search, the YOUTUBE MUSIC sync and Discover read each year
// playlist once a night instead of three times.
var playlistMemo = {};
var cachedPlaylist = function(id) {
  var m = playlistMemo[id];
  if (m && Date.now() - m.at < 3 * 60 * 60 * 1000) return m.p;
  var p = ytmusic.playlistTracks(id);
  playlistMemo[id] = { at: Date.now(), p: p };
  p.catch(function() { if (playlistMemo[id] && playlistMemo[id].p === p) delete playlistMemo[id]; });
  return p;
};
// Every track of the year playlists, for the swap search to look songs up in.
var yearPlaylistTracks = function() {
  var all = [];
  return ytmsync.parseSources(process.env.YTMUSIC_SOURCES).reduce(function(p, src) {
    return p.then(function() {
      return cachedPlaylist(src.id).then(function(r) { all = all.concat(r.tracks); }, function(err) {
        console.log("swaps: couldn't read the " + (src.year || "") + " playlist:", err && err.message);
      });
    });
  }, Promise.resolve()).then(function() { return all; });
};

// The flagged tracks of one list, and nothing else: an indexed query on
// flagged/date (database REST, signed in as the bot). Without the index
// (firebase-rules.json not published) the database would send whole
// playlists, so this refuses (err.noIndex) and the run stops instead.
// Other REST trouble falls back to the same query through Firebase.
var flaggedTracks = function(ref) {
  var sdk = function() {
    return ref.orderByChild("flagged/date").startAt(1).once("value").then(function(snap) {
      var out = [];
      snap.forEach(function(c) { out.push({ key: c.key, track: c.val() }); });
      return out;
    });
  };
  var user = firebase.auth().currentUser;
  if (!user || !process.env.FIREBASE_DB) return sdk();
  var path = decodeURIComponent(ref.toString().slice(ref.root.toString().length).replace(/^\/+/, ""));
  return user.getIdToken().then(function(token) {
    var url = new URL(process.env.FIREBASE_DB);
    url.pathname = url.pathname.replace(/\/?$/, "/") + path + ".json";
    url.searchParams.set("orderBy", JSON.stringify("flagged/date"));
    url.searchParams.set("startAt", "1");
    url.searchParams.set("auth", token);
    return http(url, { timeout: 30000 });
  }).then(function(res) {
    if (res.status === 400 && /index not defined/i.test(String(res.body))) {
      throw Object.assign(new Error("no index on flagged/date"), { noIndex: true });
    }
    if (res.status !== 200) return sdk();
    var data = res.json && typeof res.json === "object" ? res.json : {};
    return Object.keys(data).sort().map(function(k) { return { key: k, track: data[k] }; });
  }, function() { return sdk(); });
};

var swapperInstance = null;
var swapper = function() {
  if (!swapperInstance) {
    swapperInstance = swaps.createSwapper({
      db: firebase.database(),
      shallowKeys: shallowKeys,
      flagged: flaggedTracks,
      search: ytmusic.searchSongs,
      webSearch: ytmusic.webSearch,
      playlistSearch: ytmusic.webPlaylists,
      playlist: function(id) { return ytmusic.playlistTracks(id, { maxPages: 1 }); },
      counterpart: ytmusic.counterpart,
      artists: ytmusic.searchArtists,
      artistPage: ytmusic.artistPage,
      album: ytmusic.albumTracks,
      apple: process.env.APPLE_LOOKUP === "false" ? null : apple.searchSongs,
      maxDeep: SWAP_MAX_DEEP,
      // SoundCloud's search, with the same web client id as the track checks
      // (SOUNDCLOUD_KEY, no registered app); SOUNDCLOUD_SWAPS=false turns it off
      scSearch: process.env.SOUNDCLOUD_SWAPS === "false" ? null : soundcloudSearch,
      siblings: songSiblings,
      library: yearPlaylistTracks,
      apiSearch: function(q) { return youtubeSearch(q); },
      apiPlaylistSearch: function(q) { return youtubeSearch(q, "playlist"); },
      apiUnits: SWAP_API_UNITS,
      verify: youtubeProblems,
      notify: notify,
      users: function() { return users; },
      botid: function() { return botid; },
      log: console.log,
      maxSearches: SWAP_MAX_SEARCHES,
      catchUp: SWAP_CATCHUP,
      catchUpMinutes: envNumber("SWAP_CATCHUP_MINUTES", 30),
      dailySearches: envNumber("SWAP_DAILY_SEARCHES", 6000),
      maxPasses: envNumber("SWAP_MAX_PASSES", 24),
      rescanHours: envNumber("SWAP_RESCAN_HOURS", 20),
      delayMs: 2500
    });
  }
  return swapperInstance;
};

// ─── The bot's YOUTUBE MUSIC playlist (lib/ytmsync.js) ──────────────────────
// Kept in step with the official Indie Discotheque year playlists every day
// (YTMUSIC_SYNC_HOUR, 5 a.m. by default, in TZ): broken tracks and YouTube
// videos are replaced with their YouTube Music audio track, new songs added,
// duplicates removed, and the list shuffled. Also right after a start when the last sync is over a day
// old, and on !ytsync. YTMUSIC_SYNC=false turns it off.
var ytmOn = process.env.YTMUSIC_SYNC !== "false";
var YTM_HOUR = parseInt(process.env.YTMUSIC_SYNC_HOUR, 10);
if (!(YTM_HOUR >= 0 && YTM_HOUR <= 23)) YTM_HOUR = 5;
var YTM_DUPE_SECONDS = parseFloat(process.env.YTMUSIC_DUPE_SECONDS);
if (!(YTM_DUPE_SECONDS >= 0 && YTM_DUPE_SECONDS <= 30)) YTM_DUPE_SECONDS = 3;


var ytmSyncInstance = null;
var ytmSync = function() {
  if (!ytmSyncInstance) {
    ytmSyncInstance = ytmsync.createSync({
      db: firebase.database(),
      botid: function() { return botid; },
      shallowKeys: shallowKeys,
      videos: youtubeVideos,
      playlist: cachedPlaylist,
      playlistItems: youtubePlaylistItems,
      search: ytmusic.searchSongs,
      // every source the swap suggestions use (YouTube Music audio tracks only)
      lookup: function(items, o) { return swapper().lookup(items, o); },
      log: console.log,
      listName: process.env.YTMUSIC_PLAYLIST || "YOUTUBE MUSIC",
      sources: ytmsync.parseSources(process.env.YTMUSIC_SOURCES),
      dupeSeconds: YTM_DUPE_SECONDS,
      maxSearches: parseInt(process.env.YTMUSIC_MAX_SEARCHES, 10) || 1000,
      maxDeep: parseInt(process.env.YTMUSIC_MAX_DEEP, 10) || 500,
      // hold the list between daily syncs instead of downloading it again
      keepList: process.env.YTMUSIC_KEEP_LIST !== "false",
      delayMs: 2500
    });
  }
  return ytmSyncInstance;
};

// A sync, then catch-up syncs while tracks still wait for a lookup (the
// search limits): YTMUSIC_CATCHUP_MINUTES apart (60), at most
// YTMUSIC_MAX_CATCHUPS a day (8), without reshuffling the list each time.
var ytmCatch = { day: "", n: 0, timer: null };
var ytmRun = function(opts) {
  return ytmSync().run(opts).then(function(s) {
    if (!s || s.failed || !s.waiting || process.env.YTMUSIC_CATCHUP === "false") return s;
    var day = new Date().toDateString();
    if (ytmCatch.day !== day) { ytmCatch.day = day; ytmCatch.n = 0; }
    if (ytmCatch.n >= envNumber("YTMUSIC_MAX_CATCHUPS", 8) || ytmCatch.timer) return s;
    ytmCatch.timer = setTimeout(function() {
      ytmCatch.timer = null;
      ytmCatch.n++;
      ytmRun({ reason: "catch-up", shuffle: false });
    }, envNumber("YTMUSIC_CATCHUP_MINUTES", 60) * 60 * 1000);
    if (ytmCatch.timer.unref) ytmCatch.timer.unref();
    return s;
  });
};

var ytmRanOn = null;
var ytmChecked = false;
var ytmTick = function() {
  if (!ytmOn || !started) return;
  var d = new Date();
  if (!ytmChecked) {
    // first look after a start: catch up if the last sync is over a day old
    ytmChecked = true;
    ytmSync().findList().catch(function(err) { console.log("youtube music: couldn't find the playlist:", err.message); });
    ytmSync().lastRunAt().then(function(at) {
      if (Date.now() - at > 24 * 60 * 60 * 1000) {
        ytmRanOn = d.toDateString();
        ytmRun({ reason: at ? "catching up" : "first sync" });
      }
    });
    return;
  }
  if (d.getHours() !== YTM_HOUR || ytmRanOn === d.toDateString()) return;
  ytmRanOn = d.toDateString();
  ytmRun({ reason: "daily" });
};
setInterval(ytmTick, 10 * 60 * 1000);
setTimeout(ytmTick, 3 * 60 * 1000);

// Discover's public data (lib/discover.js): room charts, new releases and the
// chat as visitors see it. DISCOVER=false turns it off.
var discoverOn = process.env.DISCOVER !== "false";
var discoverInstance = null;
var discoverer = function() {
  if (!discoverInstance) {
    discoverInstance = discover.createDiscover({
      db: firebase.database(),
      now: serverNow,
      hidden: function(uid) { return !!(uid && users[uid] && users[uid].publicName === false); },
      house: function(uid) { return !!uid && uid === botid; }, // the bot's own plays aren't a DJ's
      uidOf: uidLookup,
      nameOf: function(uid) { return (users[uid] && users[uid].username) || null; },
      playlist: cachedPlaylist,
      snippets: youtubeSnippets,
      colors: artworkColors,
      sources: ytmsync.parseSources(process.env.YTMUSIC_SOURCES),
      // the recent play log in memory: the chart after each song reads nothing
      playLog: discover.playLogWindow(firebase.database(), { now: serverNow, log: console.log }),
      log: console.log
    });
  }
  return discoverInstance;
};
var discoverDo = function(label, fn) {
  if (!discoverOn || !started) return Promise.resolve(false);
  return fn(discoverer()).then(function() { return true; }, function(err) {
    console.log("discover: " + label + " error:", err && err.message);
    return false;
  });
};
// the week's chart a minute after each play (several plays, one rebuild)
var discoverWeekTimer = null;
var discoverPlayed = function() {
  if (discoverWeekTimer) return;
  discoverWeekTimer = setTimeout(function() {
    discoverWeekTimer = null;
    discoverDo("weekly chart", function(d) { return d.refreshPeriod("week"); });
    discoverDo("theme nights", function(d) { return d.refreshThemes(36); });
  }, 60 * 1000);
};
// The rest once a day (and a few minutes after a start). A job only counts
// as done for the day when it worked; one that failed (the database rules not
// published yet, YouTube or the network down) is tried again within 30 minutes.
var discoverDone = {};
var discoverRunning = {};
var discoverJob = function(name, fn) {
  var day = new Date().toDateString();
  if (discoverDone[name] === day || discoverRunning[name]) return;
  discoverRunning[name] = true;
  discoverDo(name, fn).then(function(ok) {
    discoverRunning[name] = false;
    if (ok) discoverDone[name] = day;
  });
};
var discoverTick = function() {
  if (!discoverOn || !started) return;
  discoverJob("charts", function(d) {
    return d.refreshPeriod("week")
      .then(function() { return d.refreshPeriod("month"); })
      .then(function() { return d.refreshPeriod("year"); })
      .then(function() { return d.refreshAllTime(); });
  });
  discoverJob("new releases", function(d) { return d.refreshNew(); });
  discoverJob("retired data", function(d) { return d.retire(); });
  discoverJob("theme nights", function(d) { return d.refreshThemes(24 * 400); });
  discoverJob("fires", function(d) { return d.refreshFires(); });
};
setInterval(discoverTick, 30 * 60 * 1000);
setTimeout(discoverTick, 2 * 60 * 1000);
// Genre playlists on YouTube Music (lib/ytplaylists.js), daily at
// YTM_PLAYLIST_HOUR, once the bot can sign in to the room's YouTube account
// (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN; see
// tools/youtube-auth.js). YTM_GENRE_PLAYLISTS=false turns it off.
var YTM_PLAYLIST_HOUR = parseInt(process.env.YTM_PLAYLIST_HOUR, 10);
if (!(YTM_PLAYLIST_HOUR >= 0 && YTM_PLAYLIST_HOUR <= 23)) YTM_PLAYLIST_HOUR = 6;
var genrePlaylistsOn = process.env.YTM_GENRE_PLAYLISTS !== "false" &&
  !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN);
var genrePlaylistsRanOn = null;
var genrePlaylistsRunning = false;
var genrePlaylists = function() {
  if (genrePlaylistsRunning) return Promise.resolve(null);
  genrePlaylistsRunning = true;
  return ytplaylists.createGenrePlaylists({
    db: firebase.database(),
    http: http,
    auth: { clientId: process.env.YOUTUBE_CLIENT_ID, clientSecret: process.env.YOUTUBE_CLIENT_SECRET, refreshToken: process.env.YOUTUBE_REFRESH_TOKEN },
    site: process.env.SITE_URL,
    units: parseInt(process.env.YTM_PLAYLIST_UNITS, 10) || 4000,
    songs: parseInt(process.env.YTM_GENRE_SONGS, 10) || 50,
    now: serverNow,
    log: console.log
  }).run().catch(function(err) {
    console.log("youtube music playlists error:", err && err.message);
    return null;
  }).then(function(sum) {
    genrePlaylistsRunning = false;
    return sum;
  });
};
var genrePlaylistsTick = function() {
  if (!genrePlaylistsOn || !discoverOn || !started) return;
  var d = new Date();
  if (d.getHours() !== YTM_PLAYLIST_HOUR || genrePlaylistsRanOn === d.toDateString()) return;
  genrePlaylistsRanOn = d.toDateString();
  genrePlaylists();
};
setInterval(genrePlaylistsTick, 10 * 60 * 1000);

var swapRanOn = null;
var swapTick = function() {
  if (!swapsOn || !started) return;
  var d = new Date();
  var today = d.toDateString();
  if (d.getHours() !== SWAP_HOUR || swapRanOn === today) return;
  swapRanOn = today;
  swapper().run({ reason: "nightly", paid: true });
};
setInterval(swapTick, 10 * 60 * 1000);

// The room's social posting (firetable-user's social.yml workflow), started
// once an hour from here: GitHub's own schedules run late or not at all
// (lib/social.js). On once SOCIAL_GITHUB_TOKEN is set; SOCIAL_POSTING=false
// turns it off. It runs whether or not the bot is in the room.
var socialMinute = parseInt(process.env.SOCIAL_MINUTE, 10);
var socialOn = process.env.SOCIAL_POSTING !== "false" && !!process.env.SOCIAL_GITHUB_TOKEN;
var socialTrigger = socialOn ? social.createSocialTrigger({
  http: http,
  token: process.env.SOCIAL_GITHUB_TOKEN,
  repo: process.env.SOCIAL_REPO,
  workflow: process.env.SOCIAL_WORKFLOW,
  minute: socialMinute >= 0 && socialMinute <= 59 ? socialMinute : 17,
  log: console.log
}) : null;
if (socialTrigger) {
  setInterval(socialTrigger.tick, 60 * 1000);
  console.log("social posting: starting " + socialTrigger.status().workflow + " in " + socialTrigger.status().repo + " every hour at :" + String(socialTrigger.status().minute).padStart(2, "0"));
}

// The bus (!removeafter, !leaveafter 3, !leavein 45m): lib/bus.js, made with the room below.

// @mention inbox (indiediscotheque/firetable-user#96): file every @name in a
// chat message under mentions/<their uid>, so they see it even if they were
// away. Not for bot commands, @everyone, yourself, the bot, or between people
// who have blocked each other.
var fileMentions = function(chatID, chatData, fromName) {
  if (chatData.botCmd || !chatData.id || chatData.id == botid) return;
  var re = /@([A-Za-z0-9_]{1,22})(?![A-Za-z0-9_])/g, m, seen = {};
  while ((m = re.exec(chatData.txt))) {
    var name = m[1].toLowerCase();
    if (name == "everyone" || seen[name]) continue;
    seen[name] = true;
    var target = null;
    for (var uid in users) {
      if (users.hasOwnProperty(uid) && users[uid].username && users[uid].username.toLowerCase() == name) target = uid;
    }
    if (!target || target == chatData.id || users[target].hostbot) continue;
    (function(target) {
      var db = firebase.database();
      Promise.all([
        db.ref("blocks/" + target + "/" + chatData.id).once("value"),
        db.ref("blocks/" + chatData.id + "/" + target).once("value")
      ]).then(function(blocked) {
        if (blocked[0].val() || blocked[1].val()) return;
        return db.ref("mentions/" + target + "/" + chatID).set({
          from: fromName,
          fromId: chatData.id,
          txt: chatData.txt,
          time: chatData.time || Date.now(),
          read: false
        }).then(function() {
          push.mention(target, chatID, chatData, fromName);
        });
      }).catch(function(err) {
        console.log("mention error:", err && err.message);
      });
    })(target);
  }
};

// Mentions are kept for 30 days
// (only the old ones are read: who has mentions, then each person's mentions
// older than 30 days through the time index)
var pruneMentions = function() {
  var cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  var ref = firebase.database().ref("mentions");
  shallowKeys("mentions").then(function(people) {
    return Promise.all(people.map(function(uid) {
      return ref.child(uid).orderByChild("time").endAt(cutoff).once("value").then(function(snap) {
        var updates = {};
        snap.forEach(function(item) {
          updates[uid + "/" + item.key] = null;
        });
        return updates;
      });
    }));
  }).then(function(perPerson) {
    var updates = Object.assign.apply(null, [{}].concat(perPerson));
    if (Object.keys(updates).length) return ref.update(updates);
  }).catch(function(err) {
    console.log("mention prune error:", err && err.message);
  });
};
setInterval(pruneMentions, 6 * 60 * 60 * 1000);

// ─── Push notifications: @mentions to phones and computers (lib/push.js) ────
var push = require("./lib/push").createPush({
  db: function() { return firebase.database(); },
  env: process.env,
  users: function() { return users; },
  botid: function() { return botid; },
  serverNow: serverNow,
  uidLookup: function(name) { return uidLookup(name); },
  shallowKeys: function(path) { return shallowKeys(path); }
});
setInterval(push.prune, 6 * 60 * 60 * 1000);

// One chat message: a command, a 🔥/🌧 or a theme vote. An error in a command
// is logged and that command is dropped; it never takes the bot down.
var lookupChatData = function(chatID, callback) {
  firebase.database().ref("chatData/" + chatID).once('value')
    .then(function(snap) {
      return callback(snap.val());
    })
    .catch(function(err) {
      console.log("chat message " + chatID + " failed:", err);
    });
};

// Commands, 🔥/🌧 and votes only count once, from their own feed entry, and
// only while fresh. Anyone can add a feed entry pointing at an older message
// (one saved without a feedID by an older site), which would otherwise run
// that message again as if its sender had just sent it; a late one (after a
// long disconnect) would act on a room that has moved on.
var CHAT_MAX_AGE = 2 * 60 * 1000;
var HANDLED_MAX = 500;
var handledChats = new Set();
var chatCounts = function(chatID, feedKey, chatData) {
  if (handledChats.has(chatID)) return false;
  handledChats.add(chatID);
  if (handledChats.size > HANDLED_MAX) handledChats.delete(handledChats.values().next().value);
  if (feedKey && chatData.feedID && chatData.feedID !== feedKey) return false;
  return true;
};

// ─── Chat commands (lib/commands.js) ────────────────────────────────────────
// What the commands read and change: always the room as it is now.
var room = {
  get talk() { return talk; },
  get song() { return song; },
  get theDJ() { return theDJ; },
  get users() { return users; },
  get table() { return table; },
  get autoDJ() { return autoDJ; },
  get themevote() { return themevote; },
  get botid() { return botid; },
  get swapper() { return swapper; },
  get queue() { return queue; },
  get firebase() { return firebase; },
  get fitChat() { return fitChat; },
  get ytmSync() { return ytmSync; },
  get swaps() { return swaps; },
  get socialTrigger() { return socialTrigger; },
  get firelevel() { return firelevel; },
  get updateWaitlist() { return updateWaitlist; },
  get updateThings() { return updateThings; },
  get updateLimit() { return updateLimit; },
  get uidLookup() { return uidLookup; },
  get startSong() { return startSong; },
  get serverNow() { return serverNow; },
  get seatDJ() { return seatDJ; },
  get removeMe() { return removeMe; },
  get bus() { return bus; },
  get reactionForOtherSong() { return reactionForOtherSong; },
  get push() { return push; },
  get playDex() { return playDex; },
  set playDex(v) { playDex = v; },
  get addCheck() { return addCheck; },
  get ytmusic() { return ytmusic; },
  get theme() { return theme; },
  get tagReview() { return tagReview; },
  get startSeq() { return startSeq; },
  get skipNoticeFor() { return skipNoticeFor; },
  set skipNoticeFor(v) { skipNoticeFor = v; },
  get setTheme() { return setTheme; },
  get robotsDancing() { return robotsDancing; },
  set robotsDancing(v) { robotsDancing = v; },
  get queueRef() { return queueRef; },
  get notify() { return notify; },
  get lastBlipped() { return lastBlipped; },
  get currentListRef() { return currentListRef; },
  get cardGiftedThisSong() { return cardGiftedThisSong; },
  set cardGiftedThisSong(v) { cardGiftedThisSong = v; },
  get THEME_MAX_LENGTH() { return THEME_MAX_LENGTH; },
  get BPM_MIN() { return BPM_MIN; },
  get BPM_MAX() { return BPM_MAX; },
  get ytmsync() { return ytmsync; },
  get ytmRun() { return ytmRun; },
  get ytmOn() { return ytmOn; },
  get writeRoomState() { return writeRoomState; },
  get updateTable() { return updateTable; },
  get swapsOn() { return swapsOn; },
  get started() { return started; },
  get songLoading() { return songLoading; },
  get setSongBpm() { return setSongBpm; },
  get printCard() { return printCard; },
  get playsReply() { return playsReply; },
  get nextSong() { return nextSong; },
  get lookupChatData() { return lookupChatData; },
  get lightsCommand() { return lightsCommand; },
  get gts() { return gts; },
  get giveCard() { return giveCard; },
  get genrePlaylistsRunning() { return genrePlaylistsRunning; },
  get genrePlaylistsOn() { return genrePlaylistsOn; },
  get genrePlaylists() { return genrePlaylists; },
  get flagTrackForDJ() { return flagTrackForDJ; },
  get flagCodeFor() { return flagCodeFor; },
  get fileMentions() { return fileMentions; },
  get chatCounts() { return chatCounts; },
  get bpmKey() { return bpmKey; },
  get YTM_PLAYLIST_HOUR() { return YTM_PLAYLIST_HOUR; },
  get YTM_HOUR() { return YTM_HOUR; },
  get THEME_SUGGEST_COOLDOWN() { return THEME_SUGGEST_COOLDOWN; },
  get SWAP_HOUR() { return SWAP_HOUR; },
  get CHAT_MAX_AGE() { return CHAT_MAX_AGE; }
};
var bus = require("./lib/bus").createBus(room);
var handleChat = require("./lib/commands").createCommands(room).handleChat;

var chatReady = false;
var chatWaiting = [];
var CHAT_WAITING_MAX = 200;

var markChatReady = function() {
  if (chatReady || !started || !usersLoaded) return;
  chatReady = true;
  var waiting = chatWaiting;
  chatWaiting = [];
  waiting.forEach(function(item) { handleChat(item.chatID, item.feedKey); });
  console.log("Listening now.");
  stagePub.start();
  tagSystem.start();
  grabSummaries.start();
  songImports.start();
  claimLowercaseNames();
  pruneMentions();
  push.init();
  bus.start();
};

var chatFeedRef = firebase.database().ref("chatFeed");
var feedEntries = []; // every chat feed entry {key, chatID}, oldest first (for pruneChat)
chatFeedRef.once("value").then(function(snap) {
  var before = {};
  snap.forEach(function(item) {
    before[item.key] = true;
  });
  chatFeedRef.on("child_added", function(childSnapshot) {
    var feedData = childSnapshot.val() || {};
    feedEntries.push({ key: childSnapshot.key, chatID: feedData.chatID, hidden: !!feedData.hidden });
    var n = feedEntries.length;
    if (n > 1 && feedEntries[n - 2].key > childSnapshot.key) feedEntries.sort(function(x, y) { return x.key < y.key ? -1 : 1; });
    if (before[childSnapshot.key]) return;
    if (!feedData.chatID) return;
    if (chatReady) return handleChat(feedData.chatID, childSnapshot.key);
    chatWaiting.push({ chatID: feedData.chatID, feedKey: childSnapshot.key });
    if (chatWaiting.length > CHAT_WAITING_MAX) chatWaiting.shift();
  });
  chatFeedRef.on("child_removed", function(childSnapshot) {
    for (var i = 0; i < feedEntries.length; i++) {
      if (feedEntries[i].key === childSnapshot.key) {
        feedEntries.splice(i, 1);
        break;
      }
    }
  });
  setTimeout(pruneChat, 5000); // and every 5 minutes, below
}).catch(function(err) {
  console.log("couldn't read the chat feed; commands won't work until a restart:", err);
});

// !plays: what the room's history knows about the song on the decks.
var playsReply = function() {
  if (!song || !song.cid) return talk("Nothing's playing.");
  var t = song.track;
  if (!t) {
    return talk(song.playcount ? "Played " + song.playcount + " times before (Last.fm's count for these exact tags)." : "I don't have a history for this one yet.");
  }
  var when = function(ms) { return new Date(ms).toISOString().slice(0, 10); };
  var msg = t.plays ? "Played " + t.plays + (t.plays == 1 ? " time" : " times") + " before" : "First time in the room";
  if (t.work_plays > t.plays) msg += " (" + t.work_plays + " counting every version)";
  if (t.plays && t.first_play_date) msg += ". First played " + when(t.first_play_date) + (t.first_play_dj ? " by " + t.first_play_dj : "");
  if (t.plays && t.prev_play_date) msg += ", last " + when(t.prev_play_date) + (t.prev_play_dj ? " by " + t.prev_play_dj : "");
  talk(msg + ".");
};

// Tag questions the history toolkit couldn't settle on its own (publish puts
// them in tagReview). Mods answer them in chat a few at a time; the next
// history refresh uses the answers and never asks again.
var tagReview = {
  next: function() {
    firebase.database().ref("tagReview").orderByChild("n").limitToFirst(200).once("value").then(function(snap) {
      var open = [];
      snap.forEach(function(c) { var v = c.val(); if (v && !v.decision) open.push(v); });
      if (!open.length) return talk("No tag questions waiting. 🎉");
      var q = open[0];
      talk("#" + q.n + " (" + open.length + " waiting): same track? `" + q.a + "` vs `" + q.b + "`" + (q.why ? " (" + q.why + ")" : "") + ". Answer `!same " + q.n + "` or `!different " + q.n + "`.");
    }).catch(function(err) {
      console.log("tag review error:", err && err.message);
      talk("I couldn't read the tag questions.");
    });
  },
  answer: function(args, decision, by) {
    var n = parseInt(String(args || "").replace(/^#/, ""), 10);
    if (!(n > 0)) return talk("Which one? Like `!" + (decision == "merge" ? "same" : "different") + " 12`.");
    var ref = firebase.database().ref("tagReview");
    ref.orderByChild("n").equalTo(n).once("value").then(function(snap) {
      var key = null;
      snap.forEach(function(c) { key = c.key; });
      if (!key) return talk("I can't find question #" + n + ".");
      return ref.child(key).update({ decision: decision, by: by, at: Date.now() }).then(function() {
        talk("Got it: #" + n + (decision == "merge" ? " is the same track." : " stays separate.") + " `!review` for the next one.");
      });
    }).catch(function(err) {
      console.log("tag review error:", err && err.message);
    });
  }
};

// ─── The global tag system and spreading tag fixes (lib/gts.js) ─────────────
var tagSystem = require("./lib/gts").createGts({
  db: function() { return firebase.database(); },
  song: function() { return song; },
  botid: function() { return botid; },
  serverNow: serverNow,
  currentListRef: function() { return currentListRef(); },
  lastfm: lastfm,
  discoverDo: function(name, fn) { return discoverDo(name, fn); },
  notify: function(uid, txt, opts) { return notify(uid, txt, opts); },
  talk: function(txt) { return talk(txt); }
});
var gts = tagSystem.gts;

console.log("soundcloud: " + (scOfficial ? "official API (SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET)" : "web API with SOUNDCLOUD_KEY"));
if (process.env.LASTFM_APIKEY && !process.env.LASTFM_SECRET) {
  console.log("last.fm: LASTFM_SECRET isn't set in .env, so plays won't be scrobbled.");
}

// Keep the chat to its latest 20 messages. The feed listener already knows
// every entry, so nothing is downloaded: the oldest messages and their feed
// entries go in one write.
var CHAT_KEEP = 20;
var pruneChat = function() {
  if (botLock.held === false && botLock.waitingSaid) return; // the other copy prunes
  var extra = feedEntries.length - CHAT_KEEP;
  if (extra <= 0) return;
  var updates = {};
  feedEntries.slice(0, extra).forEach(function(entry) {
    updates["chatFeed/" + entry.key] = null;
    if (entry.chatID) updates["chatData/" + entry.chatID] = null;
  });
  firebase.database().ref().update(updates).catch(function(err) {
    console.log("couldn't prune the chat:", err.message);
  });
};
setInterval(pruneChat, 5 * 60000);

// Away DJs. Being idle never costs anyone their seat: you can DJ for as long
// as the room is open in your browser. When you go offline:
// - you closed the browser (or the tab, or left the site): the site marks
//   users/<uid>/closed. After AWAY_CLOSED_MIN minutes you get one "are you
//   there?" (a notice, and a push if you turned them on); AWAY_ANSWER_MIN
//   minutes later you catch the bus: you step down after your next song (or
//   this one, if it's playing), or leave the waitlist.
// - only the connection dropped (the computer slept, the browser froze the
//   tab, a phone put the browser away): you keep your seat. Only after
//   AWAY_LOST_HOURS offline do you get the same question and bus.
// Coming back online at any point cancels it all, and takes you off a bus
// this put you on (not one you caught yourself).
var AWAY_CLOSED_MS = envNumber("AWAY_CLOSED_MIN", 5) * 60000;
var AWAY_ANSWER_MS = envNumber("AWAY_ANSWER_MIN", 5) * 60000;
var AWAY_LOST_MS = envNumber("AWAY_LOST_HOURS", 3) * 3600000;
var awayCheckStarted = Date.now();
var awayDJs = {}; // id -> { askedAt, bused }
// How long someone has been offline: from the database's record of when
// their connection dropped, else from when the bot saw it (or started)
var offlineFor = function(id) {
  var u = users[id] || {};
  if (typeof u.offlineAt === "number") return serverNow() - u.offlineAt;
  return Date.now() - Math.max(lastBlipped[id] || 0, awayCheckStarted);
};
var seatOf = function(id) {
  return table.filter(function(p) { return p && p.id == id; })[0] || null;
};
var awayName = function(id, fallback) {
  return (users[id] && users[id].username) || (fallback && fallback.name) || id;
};
var busForAway = function(id) {
  var seat = seatOf(id);
  var name = awayName(id, seat);
  if (!seat) {
    // in the waitlist: there's no song to finish, so just step out of line
    if (removeMe(id)) talk(":bus: " + name + " left, so they're off the waitlist.");
    return false;
  }
  if (seat.removeAfter) return false; // already on a bus of their own
  var playing = theDJ && theDJ.id == id;
  seat.removeAfter = true;
  if (playing) theDJ.removeAfter = true;
  updateTable();
  talk(":bus: " + name + " left, so they're catching the bus after " + (playing ? "this song." : "their next song."));
  return true;
};
var welcomeBack = function(id) {
  var away = awayDJs[id];
  delete awayDJs[id];
  if (!away || !away.bused) return;
  var seat = seatOf(id);
  if (!seat || !seat.removeAfter) return;
  seat.removeAfter = false;
  if (theDJ && theDJ.id == id) theDJ.removeAfter = false;
  updateTable();
  talk("Welcome back, " + awayName(id, seat) + "! You're staying on the decks.");
};
var checkAway = function() {
  var ids = table.concat(queue).map(function(p) { return p && p.id; }).filter(function(id) {
    return id && id != botid;
  });
  Object.keys(awayDJs).forEach(function(id) {
    if (ids.indexOf(id) === -1) delete awayDJs[id]; // stepped down or was removed
  });
  ids.forEach(function(id) {
    var u = users[id] || {};
    if (u.status) {
      if (awayDJs[id]) welcomeBack(id);
      return;
    }
    var away = awayDJs[id];
    if (away && away.bused) return;
    var closed = typeof u.closed === "number";
    if (!away) {
      if (offlineFor(id) < (closed ? AWAY_CLOSED_MS : AWAY_LOST_MS)) return;
      awayDJs[id] = { askedAt: Date.now(), bused: false };
      var mins = Math.max(1, Math.round(AWAY_ANSWER_MS / 60000));
      console.log(id + " is away (" + (closed ? "closed the browser" : "offline") + "): asked");
      notify(id, "Are you there? You've left the room, so you'll catch the bus in " + mins + " minute" + (mins == 1 ? "" : "s") +
        " (step down after your next song) unless you come back.",
        { kind: "away", ttl: Math.round(AWAY_ANSWER_MS / 1000) + 60, tag: "away", topic: "away", name: u.username || id });
      return;
    }
    if (Date.now() - away.askedAt < AWAY_ANSWER_MS) return;
    console.log(id + " didn't come back: catching the bus");
    away.bused = busForAway(id);
    if (!away.bused) delete awayDJs[id];
  });
};
(function awayLoop() {
  setTimeout(function() {
    try { checkAway(); } catch (e) { console.log("away check failed:", e); }
    awayLoop();
  }, 30000);
})();

// Sign in; if that fails (network down, Firebase busy, wrong login), keep
// trying, waiting longer each time up to 5 minutes, instead of sitting idle.
var SIGN_IN_RETRY_MAX = 5 * 60000;
var signIn = function(delay) {
  firebase.auth().signInWithEmailAndPassword(process.env.FIRETABLE_USER, process.env.FIRETABLE_PASS).catch(function(error) {
    var next = Math.min((delay || 15000) * 2, SIGN_IN_RETRY_MAX);
    console.log("couldn't sign in (" + (error.code || error.message) + "); trying again in " + next / 1000 +
      " seconds. If this keeps happening, check FIRETABLE_USER / FIRETABLE_PASS in .env.");
    setTimeout(function() {
      signIn(next);
    }, next);
  });
};
signIn();