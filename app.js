require('dotenv').config({
  silent: process.env.NODE_ENV === 'production'
});
var request = require('request');
var firebase = require('firebase');
var YouTube = require('youtube-node');
var Vibrant = require('node-vibrant');
var acorn = require('acorn');

// A failed promise somewhere (a write the rules refused, a network blip) is
// logged; it doesn't take the bot down (Node would exit otherwise).
process.on("unhandledRejection", function(reason) {
  console.log("unhandled error:", reason);
});
var youTube = new YouTube();

youTube.setKey(process.env.YOUTUBE_KEY);

var users = {};
var botid = null;
var started = false;
var queue = [];
var removalPending = {};
var queueRef = null;
theDJ = null;
var cardForGrabs = null;
var totalCards = 0;
var cardGen = false;
var colors = {
  color: "#fff",
  txt: "#fff"
};
var robotsDancing = false;
var cardGiftedThisSong = false;
var table = [];
var lastBlipped = {};
var playlimit = 2;
var thingcopy;
var tagFixData = null;
var song = null;
var playDex = 0; //where does the spotlight go? (tracks SEATS not people)
var theme = null;
var songTimeout = null;
var adam_last = null;
var songtimer = null;
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
// The site (firetable-user) decides the seasonal trading-card avatars and the
// string-lights months: js/seasons.js holds the defaults and config.js can
// override them. With SITE_URL set, the bot reads both files from the live
// site at startup and every 10 minutes, so a change there reaches the bot on
// its own. Without SITE_URL (or if the site can't be reached) it uses the
// last values it read, or these defaults, which match the site's.
// AVATARSET / LIGHTS_MONTHS in .env still force a value, but leave them unset
// to follow the site.
var SITE_SEASONS_REFRESH_MS = 10 * 60 * 1000;
var SITE_SEASON_DEFAULTS = {
  avatarset: "",
  avatarSeasons: [{ months: [10], style: "set2" }], // October: monsters
  lightsMonths: [12] // December
};
var siteSeasons = JSON.parse(JSON.stringify(SITE_SEASON_DEFAULTS));
var siteSeasonsRead = false;

function fetchSiteFile(path) {
  var url = new URL(path, process.env.SITE_URL.trim().replace(/\/?$/, "/"));
  url.searchParams.set("t", Date.now()); // skip any cached copy
  return fetch(url, { signal: AbortSignal.timeout(15000) }).then(function(res) {
    if (!res.ok) throw new Error(path + " answered HTTP " + res.status);
    return res.text();
  });
}

// The top-level settings in one of the site's scripts, read with a parser:
// nothing in the file runs, so a broken or tampered site can't run code on the
// bot. It reads `var NAME = <data>`, `NAME = <data>`, `window.NAME = <data>`
// and `NAME.key = <data>`, where <data> is plain data (text, numbers,
// true/false/null, lists and objects of those). Anything else is left out.
var NOT_DATA = {};
function plainValue(node) {
  if (!node) return NOT_DATA;
  switch (node.type) {
    case "Literal":
      return node.regex || typeof node.value === "bigint" ? NOT_DATA : node.value;
    case "TemplateLiteral":
      return node.expressions.length ? NOT_DATA : node.quasis[0].value.cooked;
    case "UnaryExpression":
      if ((node.operator === "-" || node.operator === "+") && node.argument.type === "Literal" && typeof node.argument.value === "number") {
        return node.operator === "-" ? -node.argument.value : node.argument.value;
      }
      return NOT_DATA;
    case "Identifier":
      return node.name === "undefined" ? undefined : NOT_DATA;
    case "ArrayExpression":
      var list = [];
      for (var i = 0; i < node.elements.length; i++) {
        var item = node.elements[i] ? plainValue(node.elements[i]) : null;
        if (item === NOT_DATA) return NOT_DATA;
        list.push(item);
      }
      return list;
    case "ObjectExpression":
      var obj = {};
      node.properties.forEach(function(prop) {
        if (prop.type !== "Property" || prop.kind !== "init" || prop.method || prop.computed) return;
        var key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
        var value = plainValue(prop.value);
        if (value !== NOT_DATA && key !== "__proto__") obj[key] = value;
      });
      return obj;
    default:
      return NOT_DATA;
  }
}

function readPlainData(source, filename) {
  var ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true, sourceFile: filename });
  var out = {};
  var set = function(name, node) {
    var value = plainValue(node);
    if (value !== NOT_DATA && name !== "__proto__") out[name] = value;
  };
  ast.body.forEach(function(stmt) {
    if (stmt.type === "VariableDeclaration") {
      stmt.declarations.forEach(function(decl) {
        if (decl.id.type === "Identifier" && decl.init) set(decl.id.name, decl.init);
      });
      return;
    }
    var expr = stmt.type === "ExpressionStatement" && stmt.expression;
    if (!expr || expr.type !== "AssignmentExpression" || expr.operator !== "=") return;
    var left = expr.left;
    if (left.type === "Identifier") return set(left.name, expr.right);
    if (left.type !== "MemberExpression" || left.computed || left.object.type !== "Identifier") return;
    if (left.object.name === "window") return set(left.property.name, expr.right);
    // NAME.key = <data>, e.g. ftconfigs.avatarset = "set3"
    var target = out[left.object.name];
    var value = plainValue(expr.right);
    if (target && typeof target === "object" && value !== NOT_DATA && left.property.name !== "__proto__") {
      target[left.property.name] = value;
    }
  });
  return out;
}

function firstDefined() {
  for (var i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined) return arguments[i];
  }
}

function refreshSiteSeasons() {
  if (!process.env.SITE_URL) {
    if (!siteSeasonsRead) console.log("site seasons: SITE_URL isn't set, using the defaults:", JSON.stringify(siteSeasons));
    siteSeasonsRead = true;
    return Promise.resolve();
  }
  return Promise.all([
    // An older site without js/seasons.js still works: its defaults are ours.
    fetchSiteFile("js/seasons.js").catch(function() { return ""; }),
    fetchSiteFile("config.js")
  ]).then(function(files) {
    // Read the settings out of both files without running them (a syntax
    // error throws, and the last values read are kept)
    var context = Object.assign(readPlainData(files[0], "seasons.js"), readPlainData(files[1], "config.js"));
    var cfg = context.ftconfigs || {};
    var next = JSON.parse(JSON.stringify({
      avatarset: String(cfg.avatarset || "").trim(),
      avatarSeasons: firstDefined(cfg.avatarSeasons, context.AVATAR_SEASONS, SITE_SEASON_DEFAULTS.avatarSeasons),
      lightsMonths: firstDefined(cfg.lightsMonths, context.LIGHTS_MONTHS, SITE_SEASON_DEFAULTS.lightsMonths)
    }));
    // Say what was read at startup, then only when something changes.
    if (!siteSeasonsRead || JSON.stringify(next) !== JSON.stringify(siteSeasons)) {
      console.log("site seasons:", JSON.stringify(next), "from", process.env.SITE_URL);
    }
    siteSeasons = next;
    siteSeasonsRead = true;
  }).catch(function(err) {
    console.log("couldn't read seasons from " + process.env.SITE_URL + " (keeping the last ones):", err.message);
  });
}
refreshSiteSeasons();
setInterval(refreshSiteSeasons, SITE_SEASONS_REFRESH_MS);

function inMonths(months, date) {
  return Array.isArray(months) && months.map(Number).indexOf(date.getMonth() + 1) !== -1;
}

// Same as the site's normalizeAvatarStyle: "set2" → "robohash:set2".
function normalizeAvatarStyle(val) {
  val = String(val || "").trim();
  if (!val) return null;
  return /^(robohash|dicebear):/.test(val) ? val : "robohash:" + val;
}

// Robohash set stamped on new trading cards: the room's avatar theme, the way
// the site picks it (config.js avatarset, else the seasonal theme).
function cardAvatarSet() {
  if (process.env.AVATARSET) return process.env.AVATARSET;
  var now = new Date();
  var style = normalizeAvatarStyle(siteSeasons.avatarset);
  if (!style && Array.isArray(siteSeasons.avatarSeasons)) {
    for (var i = 0; i < siteSeasons.avatarSeasons.length; i++) {
      var season = siteSeasons.avatarSeasons[i];
      if (season && inMonths(season.months, now)) {
        style = normalizeAvatarStyle(season.style);
        break;
      }
    }
  }
  // Cards draw Robohash sets only; a DiceBear room theme keeps the robots.
  return style && style.indexOf("robohash:") === 0 ? (style.slice(9) || "set1") : "set1";
}

// Stage string lights. The site keeps them on by itself in its lights months;
// the rest of the year supermods switch them with !lights, !lightson, !lightsoff.
function currentLightsMonths() {
  if (process.env.LIGHTS_MONTHS) return process.env.LIGHTS_MONTHS.split(",").map(Number);
  return siteSeasons.lightsMonths;
}

// Chat notices when a DJ's song is broken/blocked. .env values are strings,
// so parse "true"/"1"/"on"/"yes" instead of comparing to the boolean true.
var trackBrokenMessages = /^(true|1|on|yes)$/i.test(String(process.env.TRACKBROKEN_MESSAGES || "").trim());
var lightsOn = false;
firebase.database().ref("lights").on("value", function(snapshot) {
  lightsOn = !!snapshot.val();
});

function isLightsSeason() {
  return inMonths(currentLightsMonths(), new Date());
}

function lightsCommand(command, namebo) {
  if (isLightsSeason()) {
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

firebase.auth().onAuthStateChanged(function(user) {
  if (user) {
    botid = user.uid;
    console.log(botid);
    var ref0 = firebase.database().ref("users/" + user.uid + "/status");
    ref0.set(true);
    ref0.onDisconnect().set(false);
    if (!started) {
      var tpeek = firebase.database().ref("table");
      tpeek.once("value").then(function(snapshot) {
        var data = snapshot.val();
        if (data) {
          for (var key in data) {
            if (data.hasOwnProperty(key)) {
              table.push(data[key]);
            }
          }
        } else {
          console.log("no DJS");
        }
        var wpeek = firebase.database().ref("waitlist");
        wpeek.once("value").then(function(snapshot) {
          var data = snapshot.val();
          if (data) {
            for (var key in data) {
              if (data.hasOwnProperty(key)) {
                queue.push(data[key]);
              }
            }
          } else {
            console.log("no waiters");
          }
          var ppeek = firebase.database().ref("playdex");
          ppeek.once("value").then(function(snapshot) {
            var data = snapshot.val();
            if (data) {
              playDex = data;
            }
            var twopeek = firebase.database().ref("songToPlay");
            twopeek.once("value").then(function(snapshot) {
              var data = snapshot.val();
              var nownow = serverNow();
              song = data;
              theDJ = table[playDex];
              console.log(queue);
              if (data) {
                var timeSince = nownow - data.started;
                var secSince = Math.floor(timeSince / 1000);
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
            });

          });
        });
      });
    }
  }
});

// A user id from a name ("@name" works too), matching the exact name first,
// then in any case ("boss" finds "Boss"), then a user id itself.
var uidLookup = function(name) {
  name = String(name || "").trim().replace(/^@/, "");
  if (!name) return false;
  var lower = name.toLowerCase();
  var exact = false;
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

var talk = function(txt, card) {
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
  // The message and its feed entry in one write; the older three steps until
  // the database rules allow that
  var chatID = chatData.push().key;
  var feedID = chatFeed.push().key;
  var updates = {};
  updates["chatData/" + chatID] = Object.assign({}, chooto, { feedID: feedID });
  updates["chatFeed/" + feedID] = { chatID: chatID };
  firebase.database().ref().update(updates).catch(function(err) {
    if (!/permission/i.test(err.code || err.message)) throw err;
    var chatItem = chatData.push(chooto, function() {
      var feedItem = chatFeed.push({ chatID: chatItem.key }, function() {
        chatItem.child("feedID").set(feedItem.key);
      });
    });
  }).catch(function(err) {
    console.log("couldn't say \"" + txt + "\":", err.message);
  });
};

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

var updatePlaydex = function() {
  writeRoomState({ playdex: playDex });
};

var firelevel = {
  hot: function(id, name) {
    firelevel.fires[id] = true;
    firelevel.storms[id] = false;
    var fires = firelevel.size(firelevel.fires);
    var storms = firelevel.size(firelevel.storms);
    var level = fires - storms;
    console.log(level);
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
    var fires = firelevel.size(firelevel.fires);
    var storms = firelevel.size(firelevel.storms);
    var level = fires - storms;
    console.log(level);
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

var ytVideoCheck = function(result) {
  var isBroken = false;
  if (result.items[0].contentDetails) {
    if (result.items[0].contentDetails.regionRestriction) {
      if (result.items[0].contentDetails.regionRestriction.allowed) {
        if (result.items[0].contentDetails.regionRestriction.allowed.length) {
          if (!result.items[0].contentDetails.regionRestriction.allowed.includes("US")) {
            //blocked in US.... SKIP!
            isBroken = true;
          } else {
            //not blocked in US...
          }
        }
      }
      if (result.items[0].contentDetails.regionRestriction.blocked) {
        if (result.items[0].contentDetails.regionRestriction.blocked.length) {
          //there's some BLOCKED guys
          if (result.items[0].contentDetails.regionRestriction.blocked.includes("US")) {
            //blocked in US.... SKIP!
            isBroken = true;
          } else {
            //not blocked in US...
          }
        }
      }
    }
  }
  return isBroken;
};

var ytAgeRestrictionCheck = function(result) {
  var isRestricted = false;
  if (result.items[0].contentDetails) {
    if (result.items[0].contentDetails.contentRating) {
      if (result.items[0].contentDetails.contentRating.ytRating) {
        if (result.items[0].contentDetails.contentRating.ytRating == "ytAgeRestricted") {
          isRestricted = true;
        }
      }
    }
  }
  return isRestricted;
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

var flagAndRetry = function(listRef, key, track, code, message) {
  listRef.child(key).remove()
    .then(function() {
      // keep everything saved with the track (artwork, page URL)
      listRef.push(Object.assign({}, track, {
        flagged: { date: Date.now(), code: code }
      }));
    })
    .catch(function(error) {
      console.log("Song Remove failed: " + error.message);
    });
  if (theDJ.id !== botid && trackBrokenMessages) talk(message);
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

// ─── SoundCloud track lookups ───────────────────────────────────────────────
// Free, and what the room uses: SoundCloud's own web API (api-v2) with a
// client id (SOUNDCLOUD_KEY). It needs no registered app, but it isn't
// SoundCloud's public API, so they can change it or stop that client id at any
// time; the bot then can't check SoundCloud tracks and passes the decks (see
// "soundcloud" in the README).
// Optional: with SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET (a
// registered SoundCloud app) set, it uses the official API with an OAuth token
// instead. Unset, nothing changes.
var scOfficial = !!(process.env.SOUNDCLOUD_CLIENT_ID && process.env.SOUNDCLOUD_CLIENT_SECRET);
var scToken = null; // { value, expires }

var scAccessToken = function(forceNew, cb) {
  if (!forceNew && scToken && scToken.expires > Date.now()) return cb(null, scToken.value);
  var basic = Buffer.from(process.env.SOUNDCLOUD_CLIENT_ID + ":" + process.env.SOUNDCLOUD_CLIENT_SECRET).toString("base64");
  request({
    method: "POST",
    url: "https://secure.soundcloud.com/oauth/token",
    timeout: 15000,
    headers: {
      Authorization: "Basic " + basic,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json; charset=utf-8"
    },
    body: "grant_type=client_credentials"
  }, function(err, res, body) {
    var json = null;
    try {
      json = JSON.parse(body);
    } catch (e) {
      json = null;
    }
    if (err || !res || res.statusCode !== 200 || !json || !json.access_token) {
      return cb(err || new Error("SoundCloud token request answered HTTP " + (res && res.statusCode)));
    }
    // reuse it until a minute before it expires (SoundCloud limits new tokens)
    scToken = { value: json.access_token, expires: Date.now() + (Math.max(120, Number(json.expires_in) || 3600) - 60) * 1000 };
    cb(null, scToken.value);
  });
};

// cb(error, httpStatus, track): track is SoundCloud's track object when found
var soundcloudTrack = function(cid, cb) {
  var parse = function(error, response, body) {
    var status = response && response.statusCode;
    var track = null;
    if (!error && status == 200) {
      try {
        track = JSON.parse(body);
      } catch (e) {
        track = null;
      }
    }
    return { status: status, track: track };
  };
  if (!scOfficial) {
    return request({
      url: 'https://api-v2.soundcloud.com/resolve?url=https%3A//api.soundcloud.com/tracks/' + encodeURIComponent(cid) + '&format=json&client_id=' + process.env.SOUNDCLOUD_KEY,
      timeout: 15000
    }, function(error, response, body) {
      var r = parse(error, response, body);
      cb(error, r.status, r.track);
    });
  }
  var attempt = function(retried) {
    scAccessToken(retried, function(err, token) {
      if (err) return cb(err, null, null);
      request({
        url: "https://api.soundcloud.com/tracks/" + encodeURIComponent(cid),
        timeout: 15000,
        headers: { Authorization: "OAuth " + token, Accept: "application/json; charset=utf-8" }
      }, function(error, response, body) {
        var r = parse(error, response, body);
        if (r.status === 401 && !retried) return attempt(true); // token expired early
        // the official API says when a track can't be played here
        if (r.track && r.track.access === "blocked") return cb(null, 404, null);
        cb(error, r.status, r.track);
      });
    });
  };
  attempt(false);
};

// ─── Starting a track ───────────────────────────────────────────────────────
var songLoading = false; // a track is being looked up (between turns); !skip waits
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
  Vibrant.from(image).getPalette().then(function(palette) {
    if (seq !== startSeq) return; // a newer song has its own colours
    var main = palette && palette.Vibrant;
    // just the accent the site uses; every song's colours go to everyone in
    // the room and into Recent, Fresh and cards
    setColors({
      color: main ? main.getHex() : plain.color,
      txt: main ? main.getBodyTextColor() : plain.txt
    });
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
  lastfm.duration = totalseconds;
  lastfm.songStart = Math.floor(Date.now() / 1000);
  if (songtimer != null) clearTimeout(songtimer);
  songtimer = setTimeout(function() {
    songtimer = null;
    if (lastfm.key) lastfm.scrobble();
  }, (totalseconds * 1000) - 3000);
  applyArtworkColors(seq, songInfo.image);
  song = songInfo;
  firebase.database().ref("songToPlay").set(songInfo);
  if (lastfm.key) lastfm.nowPlaying();
  listRef.child(key).remove()
    .then(function() {
      // keep everything saved with the track, and remember SoundCloud
      // artwork / page URL learned just now
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
      listRef.push(songBack);
      if (seq === startSeq) gts.np(); // global tags, for the song still playing
    })
    .catch(function(error) {
      console.log("Song Remove failed: " + error.message);
    });
  // move forward at the end of the song
  if (songTimeout != null) clearTimeout(songTimeout);
  songTimeout = setTimeout(function() {
    songTimeout = null;
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
  startSong(noPrevPlay);
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
    add: function(entry) {
      ref.push(entry).catch(function(err) {
        console.log("couldn't save to " + path + ":", err.message);
      });
      // oldest first (push keys sort by time)
      keys.slice(0, Math.max(0, keys.length - max)).forEach(function(key) {
        ref.child(key).remove();
      });
    }
  };
};
var recentPlays = trimmedList("songHistory", 500);
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

// The first track in a list that isn't flagged, in play order (key order).
// Read a page at a time, so a song costs a few tracks of download instead of
// the DJ's whole list.
var TRACK_PAGE = 20;
var firstPlayable = function(listRef, after) {
  var query = listRef.orderByKey();
  if (after) query = query.startAfter(after);
  return query.limitToFirst(TRACK_PAGE).once("value").then(function(snap) {
    var found = null;
    var last = null;
    var count = 0;
    snap.forEach(function(child) {
      count++;
      last = child.key;
      var track = child.val();
      if (!found && track && !track.flagged) found = { key: child.key, track: track };
    });
    if (found || count < TRACK_PAGE) return found;
    return firstPlayable(listRef, last);
  });
};

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
  console.log(table.length);
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
        img: song.image
      };
      if (song.adamid) newEntry.adamid = song.adamid;
      if (song.playcount) newEntry.playcount = song.playcount;
      newEntry = JSON.parse(JSON.stringify(newEntry)); // Firebase refuses undefined fields
      recentPlays.add(newEntry);
      var isNew = newMusicCheck(newEntry);
      if (isNew) {

        if (Math.floor(Math.random() * 15) == 5) printCard(newEntry);

        // NEW MUSIC
        freshPlays.add(newEntry);
      }
    }
  }
  if (songtimer != null) {
    clearTimeout(songtimer);
    songtimer = null;
  }
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
  maxindex = table.length - 1;
  if (playDex > maxindex) {
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
  firstPlayable(listRef).then(function(found) {
    if (seq !== startSeq) return; // skipped or restarted meanwhile
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
        youTube.getById(data[nextSongkey].cid, guarded(seq, "YouTube", function(error, result) {
          if (seq !== startSeq) return; // skipped or restarted while YouTube answered
          if (error || !result || !Array.isArray(result.items)) {
            // quota, API key or network trouble: the track itself may be fine
            lookupFailed("YouTube", error);
          } else {
            lookupWorked("YouTube");
            if (!result.items.length) {
              // the video is gone (deleted or private)
              flagAndRetry(listRef, nextSongkey, data[nextSongkey], 2, "@" + theDJ.name + " you tried to play a broken song. Letting you play whatever is next in your queue instead... Clean up your queue please thanks.");
            } else if (ytVideoCheck(result)) {
              flagAndRetry(listRef, nextSongkey, data[nextSongkey], 3, "Hey @" + theDJ.name + ", looks like https://www.youtube.com/watch?v=" + data[nextSongkey].cid + " is blocked in the US. Letting you play whatever is next in your queue instead.");
            } else if (ytAgeRestrictionCheck(result)) {
              flagAndRetry(listRef, nextSongkey, data[nextSongkey], 7, "Hey @" + theDJ.name + ", looks like https://www.youtube.com/watch?v=" + data[nextSongkey].cid + " is age restricted and can't be played outside of Youtube.com. Letting you play whatever is next in your queue instead.");
            } else {
              var video = result.items[0];
              var snippet = video.snippet || {};
              var yargo = String(data[nextSongkey].name || "").split(" - ");
              var sartist = yargo[0];
              var stitle = yargo[1];
              var input = (video.contentDetails && video.contentDetails.duration) || "";
              var reptms = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;
              var totalseconds = 10 * 60; // unknown length: give it 10 minutes
              var matches = reptms.exec(input);
              if (matches) {
                totalseconds = Number(matches[1] || 0) * 3600 + Number(matches[2] || 0) * 60 + Number(matches[3] || 0);
              }
              var channel = String(snippet.channelTitle || "Unknown");
              if (!stitle) {
                stitle = sartist;
                // "Various Artists - Topic": this youtube channel name is a lie...
                sartist = channel == "Various Artists - Topic" ? "Unknown" : channel.replace(" - Topic", "");
              } else if (sartist == "Unknown") {
                sartist = channel.replace(" - Topic", "");
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
            flagAndRetry(listRef, nextSongkey, data[nextSongkey], 4, "@" + theDJ.name + " you tried to play a broken song. Letting you play whatever is next in your queue instead... Clean up your queue please thanks.");
          } else if (!scTrack || !scTrack.id) {
            // down, rate limited or refusing the key: the track itself may be fine
            lookupFailed("SoundCloud", error || ("HTTP " + status));
          } else {
            lookupWorked("SoundCloud");
            var uploader = (scTrack.user && scTrack.user.username) || "Unknown";
            var yargo = String(data[nextSongkey].name || "").split(" - ");
            var sartist = yargo[0];
            var stitle = yargo[1];
            if (sartist == "Unknown" && !stitle) {
              var cutetags = String(scTrack.title || "").split(" - ");
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
        flagAndRetry(listRef, nextSongkey, data[nextSongkey], 2, "@" + theDJ.name + " you tried to play a broken song. Letting you play whatever is next in your queue instead... Clean up your queue please thanks.");
      }

    } else {
      console.log("no songs in queue... remove this DJ");
      songLoading = false;
      if (theDJ.id == botid) autoDJ.crateEmpty();
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
        img: song.image
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
      set: cardAvatarSet(),
      date: now,
      special: cardSpecial,
      owner: false
    };
    cardData = JSON.parse(JSON.stringify(cardData)); // Firebase refuses undefined fields

    var ref = firebase.database().ref("cards");
    var cuteCard = ref.push(cardData, function(err) {
      if (err) return console.log("couldn't print a card:", err.message);
      cardForGrabs = cuteCard.key;
      talk("A new trading card has been printed. Type !grab to grab it for yourself!");
    });
  }).catch(function(err) {
    console.log("couldn't print a card:", err && err.message);
  });
};

var giveCard = function(id, name) {
  if (!cardForGrabs) return;
  var cardid = cardForGrabs;
  cardForGrabs = null;
  var ref = firebase.database().ref("cards/" + cardid + "/owner");
  ref.set(id);
  talk("good job @" + name + " you got the card.", cardid);
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
  for (var i = 0; i < table.length; i++) {
    if (table[i].id == id) {
      if (theDJ && id == theDJ.id) {
        // The DJ playing now leaves: end the song. nextSong() takes them off
        // and gives the seat to the waitlist.
        theDJ.removeAfter = true;
        table[i].removeAfter = true;
        nextSong();
        return true;
      }
      table.splice(i, 1);
      // keep the spotlight on the DJ playing now
      if (i < playDex) playDex = playDex - 1;
      if (playDex >= table.length) playDex = 0;
      if (queue.length) seatDJ(queue.shift());
      updateThings();
      return true;
    }
  }
  return false;
};

var isAlphaNumeric = function(str) {
  var code, i, len;

  for (i = 0, len = str.length; i < len; i++) {
    code = str.charCodeAt(i);
    if (!(code > 47 && code < 58) && // numeric (0-9)
      !(code > 64 && code < 91) && // upper alpha (A-Z)
      !(code > 96 && code < 123)) { // lower alpha (a-z)
      return false;
    }
  }
  return true;
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
  for (var i = 0; i < table.length; i++) {
    if (table[i].id == id) {
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

var ref2 = firebase.database().ref("users");
var usersLoaded = false;
ref2.on('value', function(dataSnapshot) {
  users = dataSnapshot.val() || {};
  autoDJ.check(); // the bot needs its own profile before it can sit down
  if (botid && !(users[botid] && users[botid].status)) {
    firebase.database().ref("users/" + botid + "/status").set(true);
  }
  if (!usersLoaded) {
    usersLoaded = true;
    markChatReady();
  }
});

//this is a blip detector
ref2.orderByChild('status').equalTo(true).on('child_added', function(dataSnapshot) {
  lastBlipped[dataSnapshot.key] = Date.now();
});
ref2.orderByChild('status').equalTo(true).on('child_removed', function(dataSnapshot) {
  lastBlipped[dataSnapshot.key] = Date.now();
});
ref2.orderByChild('status').equalTo(true).on('child_changed', function(dataSnapshot) {
  lastBlipped[dataSnapshot.key] = Date.now();
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

// ─── Song tempo (BPM) ────────────────────────────────────────────────────────
// When a song starts, look up its tempo on Deezer (free, no key) and publish
// it as songBpm {started, bpm, src} so the site can bop to the beat (not on
// songToPlay: clients treat any change there as a new song). Tempos are cached per
// track in bpm/<type>_<cid>; anyone DJing or a mod can correct one with
// "!bpm 128" (manual values are never overwritten by a lookup).
var BPM_MIN = 40, BPM_MAX = 250;
var bpmKey = function(type, cid) {
  return String(type) + "_" + String(cid).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
};
var normalizeForMatch = function(str) {
  return String(str || "").toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&amp;/g, "&").replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "") // (Official Video), [Remastered]...
    .replace(/\b(feat|ft|featuring)\.?\s.*$/, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
};
var looselyMatches = function(a, b) {
  a = normalizeForMatch(a); b = normalizeForMatch(b);
  if (!a || !b) return false;
  return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0;
};
var getJSON = function(url) {
  return new Promise(function(resolve, reject) {
    request({ url: url, json: true, timeout: 10000 }, function(err, res, body) {
      if (err || !res || res.statusCode !== 200 || !body || body.error) return reject(err || (body && body.error) || new Error("HTTP " + (res && res.statusCode)));
      resolve(body);
    });
  });
};
var deezerBpm = function(artist, title) {
  var q = 'artist:"' + String(artist).replace(/"/g, "") + '" track:"' + normalizeForMatch(title).replace(/"/g, "") + '"';
  return getJSON("https://api.deezer.com/search?limit=5&q=" + encodeURIComponent(q)).then(function(res) {
    var hit = (res.data || []).filter(function(t) {
      return t && t.artist && looselyMatches(t.artist.name, artist) && looselyMatches(t.title, title);
    })[0];
    if (!hit) return null;
    return getJSON("https://api.deezer.com/track/" + hit.id).then(function(t) {
      var bpm = Number(t && t.bpm);
      return bpm >= BPM_MIN && bpm <= BPM_MAX ? Math.round(bpm * 10) / 10 : null;
    });
  });
};
// Put a tempo on the playing song, if it's still the same song
var setSongBpm = function(started, bpm, src) {
  if (!song || song.started !== started) return Promise.resolve();
  song.bpm = bpm;
  song.bpmSrc = src;
  return firebase.database().ref("songBpm").set({ started: started, bpm: bpm, src: src }).catch(function(e) {
    console.log("bpm update failed:", e.message);
  });
};
var findBpm = function(s) {
  if (!s || !s.cid || !s.started) return;
  var key = bpmKey(s.type, s.cid);
  firebase.database().ref("bpm/" + key).once("value").then(function(snap) {
    var cached = snap.val();
    if (cached && cached.bpm) return setSongBpm(s.started, cached.bpm, cached.src || "cache");
    if (cached && cached.none && Date.now() - cached.at < 30 * 24 * 3600 * 1000) return; // looked up recently, nothing found
    if (!s.artist || !s.title || s.artist === "Unknown") return;
    return deezerBpm(s.artist, s.title).then(function(bpm) {
      var entry = bpm ? { bpm: bpm, src: "deezer", at: Date.now() } : { none: true, at: Date.now() };
      return firebase.database().ref("bpm/" + key).set(entry).then(function() {
        if (bpm) return setSongBpm(s.started, bpm, "deezer");
      });
    });
  }).catch(function(e) {
    console.log("bpm lookup failed:", e && e.message);
  });
};
var bpmLookedUpFor = null;
firebase.database().ref("songToPlay").on("value", function(snap) {
  var s = snap.val();
  if (!s || !s.started || s.started === bpmLookedUpFor) return;
  bpmLookedUpFor = s.started;
  setTimeout(function() { findBpm(s); }, 500); // let the song settle first
});

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

// Who a bus command is for: the sender, or (mods) someone of lower rank.
var busRank = function(u) {
  if (!u) return 0;
  if (u.supermod) return 2;
  if (u.mod) return 1;
  return 0; // members, and the room bot (mods may send it home too)
};
var busTargetFor = function(senderId, senderName, args) {
  var name = (args || "").trim().replace(/^@/, "");
  if (!name) return { id: senderId, name: senderName, self: true };
  var sender = users[senderId] || {};
  if (!sender.mod && !sender.supermod) return { error: "Only mods can do that for someone else, " + senderName + "." };
  var id = uidLookup(name);
  if (!id) return { error: "who is that" };
  if (id == senderId) return { id: senderId, name: senderName, self: true };
  if (busRank(users[id]) >= busRank(sender)) return { error: "You can't do that for " + name + "." };
  return { id: id, name: (users[id] && users[id].username) || name, self: false };
};
var setBus = function(target, on, byId) {
  var check = addCheck(target.id);
  var who = target.self ? target.name + ", " : "@" + target.name + ", a mod has set it so ";
  if (!check) {
    talk(target.self ? target.name + ", you aren't even DJing..." : target.name + " isn't DJing.");
    return;
  }
  // A mod sending the bot home (or keeping it) overrides the autopilot.
  if (target.id == botid) autoDJ.override(on ? "down" : "up");
  var list = check == 1 ? queue : table;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id == target.id) {
      list[i].removeAfter = on;
      break;
    }
  }
  var isPlaying = check == 2 && theDJ && theDJ.id == target.id;
  if (isPlaying) theDJ.removeAfter = on;
  if (target.self) {
    if (on) talk(isPlaying ? who + "I'll remove you at the end of this song." : who + "I'll remove you after your next song.");
    else talk(isPlaying ? who + "I will NOT remove you after this song." : who + "I will NOT remove you after your next song.");
  } else {
    if (on) talk(who + (isPlaying ? "you'll step down at the end of this song." : "you'll step down after your next song."));
    else talk("@" + target.name + ", you're staying on after all.");
  }
  if (check == 1) updateWaitlist(); else updateTable();
};

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

var handleChat = function(chatID) {
    lookupChatData(chatID, function(chatData) {
      if (!chatData || typeof chatData.txt !== "string") return; // already pruned
      var sender = users[chatData.id] || {};
      var senderIsMod = !!(sender.mod || sender.supermod);
      var senderIsSupermod = !!sender.supermod;
      var namebo = sender.username || chatData.id;
      console.log(namebo + ": " + chatData.txt);
      fileMentions(chatID, chatData, namebo);
      var matches = chatData.txt.match(/^(?:[!])(\w+)\s*(.*)/i);
      if (matches && botid !== chatData.id && started) {
        var command = matches[1].toLowerCase();
        var args = matches[2];
        console.log("COMMAND:", command);
        if (command == "addme") {
          var check = addCheck(chatData.id);
          if (!check) {
            var pson = {
              name: namebo,
              id: chatData.id,
              plays: 0
            };

            if (table.length >= 4) {
              // table full. time to be on the waitlist now k
              queue.push(pson);
              talk(namebo + " added to waitlist. Length is now " + queue.length);
              updateWaitlist();
              updateLimit();
            } else {
              //table has room. add to table directly
              if (table.length == 0) {
                table.push(pson);
                console.log(table);
                playDex = 0;
                startSong();
              } else {
                seatDJ(pson);
                console.log(table);
                updateThings();
              }
            }
          } else {
            if (check == 1) {
              talk("You are already in the waitlist.");
            } else if (check == 2) {
              talk("You are already on deck.");
            }
          }
        } else if (command == "removeme") {
          var removed = removeMe(chatData.id);
          if (!removed) talk(namebo + ", you aren't even DJing...");
        } else if (command == "removemeafter" || command == "removeafter" || command == "gottacatchmybus" ||
                   command == "dontremovemeafter" || command == "dontremoveafter" || command == "dontremoveme" || command == "dontremove") {
          // "take the bus": step down after your next play. Mods can also set
          // it for someone of lower rank: !removeafter <name> (#121).
          var busOn = command.indexOf("dont") !== 0;
          var busTarget = busTargetFor(chatData.id, namebo, args);
          if (busTarget.error) {
            talk(busTarget.error);
          } else {
            setBus(busTarget, busOn, chatData.id);
          }
        } else if (command == "skip") {
          if (senderIsMod || (theDJ && chatData.id == theDJ.id)) {
            if (songLoading) {
              // the next song is already on its way: one skip per song
              console.log("skip ignored: the next song is still loading");
            } else {
              nextSong();
            }
          }
        } else if (command == "theme") {
          if (theme) {
            talk("The current theme is: " + theme);
          } else {
            talk("There is no theme at the moment. `!suggest` one if you'd like.")
          }
        } else if (command == "suggest") {
          // Each vote pings @everyone, so: a real theme, one vote at a time,
          // and one suggestion per person every 15 minutes (mods excepted)
          var idea = String(args || "").replace(/\s+/g, " ").trim();
          var waitMs = (themevote.lastBy[chatData.id] || 0) + THEME_SUGGEST_COOLDOWN - Date.now();
          if (themevote.active) {
            talk("We are already voting for " + themevote.params.votingfor + ". Let's wait for that to finish first.");
          } else if (!idea) {
            talk("Suggest a theme like `!suggest 90s one-hit wonders`.");
          } else if (idea.length > THEME_MAX_LENGTH) {
            talk("Keep the theme under " + THEME_MAX_LENGTH + " characters, " + namebo + ".");
          } else if (waitMs > 0 && !senderIsMod) {
            talk(namebo + ", you can suggest another theme in " + Math.ceil(waitMs / 60000) + " minute(s).");
          } else {
            themevote.lastBy[chatData.id] = Date.now();
            themevote.go(idea, namebo);
          }
        } else if (command == "settheme") {
          if (senderIsSupermod) {
            if (args == "none") {
              setTheme(null);
              talk("There is no theme.");
            } else {
              setTheme(args);
              talk("Theme has been set to: " + args);
            }
          } else {
            talk("i will absolutely not do that " + namebo);
          }
        } else if (command == "lights" || command == "lightson" || command == "lightsoff") {
          if (senderIsSupermod) {
            lightsCommand(command, namebo);
          } else {
            talk("i will absolutely not do that " + namebo);
          }
        } else if (command == "printcard") {
          if (senderIsSupermod) {
            printCard();
          } else {
            talk("i will absolutely not do that " + namebo);
          }
        } else if (command == "giftcard") {
          if (chatData.card && theDJ) {
            var ccref = firebase.database().ref("cards/" + chatData.card + "/owner");
            ccref.set(theDJ.id);
            talk(":white_check_mark: Card has been transfered from " + namebo + " to @" + theDJ.name);
            if (chatData.id !== theDJ.id) cardGiftedThisSong = true;
          }
        } else if (command == "grab") {
          if (cardForGrabs) giveCard(chatData.id, namebo);
        } else if (command == "upbot") {
          // Stay on the decks (even alone with a crowd) until the next
          // autopilot trigger.
          if (senderIsMod) {
            var namebo2 = autoDJ.botName();
            var check = addCheck(botid);
            var seat = autoDJ.botSeat();
            autoDJ.override("up");
            if (seat && seat.removeAfter) {
              seat.removeAfter = false;
              if (theDJ && theDJ.id == botid) theDJ.removeAfter = false;
              talk("OK! I'll stay on the decks.");
              updateTable();
            } else if (!check) {
              var pson = {
                name: namebo2,
                id: botid,
                plays: 0
              };
              if (table.length >= 4) {
                // table full. time to be on the waitlist now k
                queue.push(pson);
                talk(namebo2 + " (that's me) added to waitlist. Length is now " + queue.length);
                updateWaitlist();
                updateLimit();
              } else {
                //table has room. add to table directly
                talk("OK! I will DJ.");
                if (table.length == 0) {
                  table.push(pson);
                  playDex = 0;
                  startSong();
                } else {
                  seatDJ(pson);
                  updateThings();
                }
              }
            } else if (check == 1) {
              talk("I am already in the waitlist.");
            } else {
              talk("I am already on deck.");
            }
          }
        } else if (command == "downbot") {
          // Leave now and stay off the decks until the next autopilot trigger.
          if (senderIsMod) {
            autoDJ.override("down");
            removeMe(botid);
            talk("OK! I will not DJ.");
          }
        } else if (command == "autodj") {
          if ((args || "").trim().toLowerCase() == "auto" && (senderIsMod)) {
            autoDJ.override("auto");
            talk("OK! Back on autopilot.");
            autoDJ.check();
          } else {
            talk(autoDJ.status());
          }
        } else if (command == "screen" || command == "screendown") {
          if (senderIsMod) {
            talk("activating the screen.");
            var thescreen = firebase.database().ref("thescreen");
            thescreen.set(true);
          }
        } else if (command == "killscreen" || command == "screenup") {
          if (senderIsMod) {
            talk("ok.");
            var thescreen = firebase.database().ref("thescreen");
            thescreen.set(false)
          }

        } else if (command == "flag") {
          if (senderIsMod) {
            // do the flag thing
            var code = false;
            if (args == "broken" || args == "8") {
              code = 8;
            } else if (args == "bitrate" || args == "quality" || args == "incomplete" || args == "9") {
              code = 9;
            } else if (args == "offtheme" || args == "10") {
              code = 10;
            }

            if (song && song.cid && currentListRef()) {
              if (code) {
                var flag = {
                  date: Date.now(),
                  code: code
                };
                queueRef.orderByChild('cid').equalTo(song.cid).once("value")
                  .then(function(snapshot) {
                    var data = snapshot.val();
                    if (data) {
                      for (var key in data) {
                        if (data[key].type == song.type) {
                          newData = data[key];
                          newData.flagged = flag;
                          queueRef.child(key).set(newData);
                        }
                      }
                    }
                    talk(":triangular_flag_on_post: FLAGGED (CODE " + code + ")");
                  });
              } else {
                talk("Please specify a valid flag reason (ex: !flag broken, !flag offtheme, !flag quality)");
              }
            } else {
              talk("I just reloaded... I don't remember where in the DJ's lists I got this from.");
            }
          }
        } else if (command == "flagplay") {
          // Flag a track from Recent: !flagplay <songHistory id> <reason>.
          // Marks it in every list of the DJ who played it.
          if (senderIsMod) {
            var fp = (args || "").trim().split(/\s+/);
            var fpCode = flagCodeFor(fp[1]);
            if (!fp[0] || !fpCode) {
              talk("Use !flagplay <play> <broken|quality|offtheme>");
            } else {
              firebase.database().ref("songHistory/" + fp[0]).once("value").then(function(snap) {
                var play = snap.val();
                if (!play || !play.djid || !play.cid) return talk("I can't find that play anymore.");
                return flagTrackForDJ(play.djid, play.cid, play.type, { date: Date.now(), code: fpCode }).then(function(n) {
                  talk(n ? ":triangular_flag_on_post: FLAGGED " + play.artist + " - " + play.title + " (CODE " + fpCode + ")"
                         : "That track isn't in " + play.dj + "'s playlists anymore.");
                });
              }).catch(function(err) {
                console.log("flagplay error:", err);
              });
            }
          }
        } else if (command == "bpm") {
          if (!song || !song.cid) {
            talk("Nothing's playing.");
          } else if (!args) {
            talk(song.bpm ? "This track is about " + song.bpm + " BPM" + (song.bpmSrc === "manual" ? " (set by hand)." : ".") : "I don't know this one's tempo. The DJ or a mod can set it with `!bpm 128`.");
          } else {
            var u = users[chatData.id] || {};
            var newBpm = Math.round(Number(String(args).trim()) * 10) / 10;
            if (!(chatData.id === song.djid || u.mod || u.supermod)) {
              talk("Only the DJ or a mod can set the tempo.");
            } else if (!(newBpm >= BPM_MIN && newBpm <= BPM_MAX)) {
              talk("Give me a number between " + BPM_MIN + " and " + BPM_MAX + ", like `!bpm 128`.");
            } else {
              firebase.database().ref("bpm/" + bpmKey(song.type, song.cid)).set({ bpm: newBpm, src: "manual", by: chatData.id, at: Date.now() });
              setSongBpm(song.started, newBpm, "manual");
              talk("Got it: " + newBpm + " BPM.");
            }
          }
        } else if (command == "fixtags") {
          if (!senderIsMod) {
            talk("Only mods can fix tags, " + namebo + ". Ask a mod to fix this one.");
          } else if (!song || !song.cid) {
            talk("Nothing's playing.");
          } else if (args) {
            // split on the FIRST " - " only, so "Song - Live" titles stay whole
            var sep = args.indexOf(' - ');
            if (sep < 1 || !args.slice(sep + 3).trim()) {
              //bad format
              talk("what");
            } else {
              var newartist = args.slice(0, sep).trim().replace(/&amp;/g, '&');
              var newtitle = args.slice(sep + 3).trim().replace(/&amp;/g, '&');
              gts.fixTags(newartist, newtitle);
              talk("ok. updating tags to artist: `" + newartist + "` and title: `" + newtitle + "`. thank you.")
            }

          } else {
            talk("update current tags with `!fixtags artist - title` and refer to Rohn Standard Notation if unsure. thanks!");
          }
        } else if (command == "lastblipped"){
          if (args){
            var prsn = uidLookup(args);
            if (prsn){
              let result = null;
              if (lastBlipped[prsn]){
                talk("this person last blipped "+ (Date.now() - lastBlipped[prsn]) / 1000 / 60 +" minutes ago. or i just rebooted.");
              } else {
                talk("i am confused thank you");
              }
            }
          }
        } else if (command == "remove") {
          if (senderIsMod) {
            var prsnToRemove = uidLookup(args);
            if (prsnToRemove == botid) autoDJ.override("down");
            if (prsnToRemove) {
              var removed = removeMe(prsnToRemove);
              if (!removed) talk("Can not remove " + args + " because they are not on the table or in the waitlist. Thanks.");
            } else {
              talk("who is that");
            }
          }
        } else if (command == "add") {
          if (senderIsMod) {
            var prsnToAdd = uidLookup(args);
            if (prsnToAdd == botid) autoDJ.override("up");
            if (prsnToAdd) {
              var check = addCheck(prsnToAdd, true);
              if (!check) {
                var pson = {
                  name: users[prsnToAdd].username,
                  id: prsnToAdd,
                  plays: 0
                };

                if (table.length >= 4) {
                  // table full. time to be on the waitlist now k
                  queue.push(pson);
                  talk(users[prsnToAdd].username + " added to waitlist. Length is now " + queue.length);
                  updateWaitlist();
                  updateLimit();
                } else {
                  //table has room. add to table directly
                  if (table.length == 0) {
                    table.push(pson);
                    console.log(table);
                    playDex = 0;
                    startSong();
                  } else {
                    seatDJ(pson);
                    console.log(table);
                    updateThings();
                  }
                }
              } else {
                if (check == 1) {
                  talk(users[prsnToAdd].username + " is already in the waitlist.");
                } else if (check == 2) {
                  talk(users[prsnToAdd].username + " is already on deck.");
                } else if (check == 3) {
                  talk(users[prsnToAdd].username + " is almost for sure not here.");
                }
              }

            } else {
              talk("who is that");
            }
          }
        } else if (command == "become") {
          talk("i do not remember how to do that.")
        } else if (command == "wait") {
          talk("wait");
        } else if (command == "hot") {
          if (!reactionForOtherSong(chatData)) firelevel.hot(chatData.id, namebo);
        } else if (command == "storm") {
          if (!reactionForOtherSong(chatData)) firelevel.storm(chatData.id, namebo);
        } else if (command == "link") {
          if (song) {
            if (song.url) {
              talk(song.url);
            } else {
              talk("Nothing is playing...");
            }
          }
        } else if (command == "dance") {
          if (cardGiftedThisSong) {
            if (!robotsDancing) {
              writeRoomState({ dance: true });
              robotsDancing = true;
              talk(":artificial_satellite: D.A.N.C.E satellite: `GLOBAL DANCE SEQUENCE NO. 1 HAS BEEN INITIATED.`");
            } else {
              talk(":artificial_satellite: D.A.N.C.E satellite: `already broadcasting dance signal thanks`");
            }
          } else {
            talk(":red_circle::satellite: unable to communicate with the D.A.N.C.E. satellite... if you gift the DJ a h0t new card, i'm sure they'll help boost your signal");
          }
        }
      } else if (reactionForOtherSong(chatData)) {
        // a 🔥/🌧 sent for the song before (it arrived after the song changed)
      } else if (chatData.txt == "🔥" || chatData.txt == ":fire:") {
        firelevel.hot(chatData.id, namebo);
      } else if (chatData.txt == "🌧" || chatData.txt == ":cloud_with_rain:") {
        firelevel.storm(chatData.id, namebo);
      } else if (chatData.txt == "1" && themevote.active) {
        themevote.params.votes[chatData.id] = 1;
      }

    });
};

// Messages already in the feed when the bot starts were handled by the bot
// that was running then, so they're skipped: a restart never re-runs a !skip.
// New ones wait (in order) until the bot has loaded the users and the decks.
var chatReady = false;
var chatWaiting = [];
var CHAT_WAITING_MAX = 200;

var markChatReady = function() {
  if (chatReady || !started || !usersLoaded) return;
  chatReady = true;
  var waiting = chatWaiting;
  chatWaiting = [];
  waiting.forEach(handleChat);
  console.log("Listening now.");
  claimLowercaseNames();
  pruneMentions();
};

var chatFeedRef = firebase.database().ref("chatFeed");
chatFeedRef.once("value").then(function(snap) {
  var before = {};
  snap.forEach(function(item) {
    before[item.key] = true;
  });
  chatFeedRef.on("child_added", function(childSnapshot) {
    if (before[childSnapshot.key]) return;
    var feedData = childSnapshot.val() || {};
    if (!feedData.chatID) return;
    if (chatReady) return handleChat(feedData.chatID);
    chatWaiting.push(feedData.chatID);
    if (chatWaiting.length > CHAT_WAITING_MAX) chatWaiting.shift();
  });
}).catch(function(err) {
  console.log("couldn't read the chat feed; commands won't work until a restart:", err);
});

// GLOBAL TAG SYSTEM
var gts = {
  np: function() {
    var globalpeek = firebase.database().ref("globalTracks/" + song.type + "" + song.cid);
    globalpeek.once("value")
      .then(function(snapshot) {
        var thing = snapshot.val();
        console.log("THING START", thing);
        if (thing) {
          // NOT FIRST... LET'S MANAGE THAT
          gts.reportNp(thing);
          //update lp
          var thing2 = thing;
          thing2.last_play_date = Date.now();
          thing2.last_play_dj = song.djname;
          globalpeek.set(thing2);
        } else {
          // FIRST PLAY
          gts.reportNp({
            artist: song.artist,
            title: song.title,
            type: song.type
          });

          globalpeek.set({
            artist: song.artist,
            title: song.title,
            last_play_date: Date.now(),
            first_play_date: Date.now(),
            last_play_dj: song.djname,
            first_play_dj: song.djname,
            type: song.type
          });
        }
      });
  },
  fixTags: function(fixedartist, fixedtitle) {
    var globalpeek = firebase.database().ref("globalTracks/" + song.type + "" + song.cid);
    globalpeek.once("value")
      .then(function(snapshot) {
        var thing = snapshot.val();
        console.log("THING FIX", thing);
        if (thing) {
          var thing2 = thing;
          thing2.artist = fixedartist;
          thing2.title = fixedtitle;
          globalpeek.set(thing2);
          gts.reportNp(thing2);
        } else {
          // FIRST PLAY
          gts.reportNp({
            artist: fixedartist,
            title: fixedtitle,
            type: song.type
          });

          globalpeek.set({
            artist: fixedartist,
            title: fixedtitle,
            last_play_date: Date.now(),
            first_play_date: Date.now(),
            last_play_dj: song.djname,
            first_play_dj: song.djname,
            type: song.type
          });
        }
      });
  },
  reportNp: function(adm) {
    console.log("thing 3", adm);
    if (adm) {
      if (adm.title) {
        //if no track name, adam tags bad... dont use.
        if (adm.artist) {
          if (adm.artist !== "Unknown") {
            song.artist = adm.artist;
            song.title = adm.title;
          } else {
            // if ADAM thinks the artist's name is UNKNOWN, overwrite with whatever hostbot came up with
            //adam.fix_tags(adm.track_id, song.artist + " - " + song.title);
          }
        }
      } else {
        //NO TRACK NAME... if we have enough data, let's tell ADAM what we know
        //adam.fix_tags(adm.track_id, song.artist + " - " + song.title);
      }


      tagFixData = {
        adamData: {
          artist: song.artist,
          track_name: song.title
        },
        cid: song.cid
      };
      if (adm.last_play_dj) tagFixData.adamData.last_play_dj = adm.last_play_dj;
      if (adm.last_play_date) tagFixData.adamData.last_play = new Date(adm.last_play_date).toISOString();
      if (adm.first_play_dj) tagFixData.adamData.first_play_dj = adm.first_play_dj;
      if (adm.first_play_date) tagFixData.adamData.first_play = new Date(adm.first_play_date).toISOString();

      request('https://ws.audioscrobbler.com/2.0/?method=track.getInfo&track=' + encodeURIComponent(adm.title) + '&artist=' + encodeURIComponent(adm.artist) + '&username=' + process.env.LASTFM_USERNAME + '&api_key=' + process.env.LASTFM_APIKEY + '&format=json', function cbfunc(error, response, body) {
        //If call returned correctly, continue
        var playcount = false;
        console.log("thing 4", tagFixData);

        if (!error && response.statusCode == 200) {
          try {
            var lfm = [JSON.parse(body)];
            if (lfm[0].track.userplaycount) {
              playcount = parseInt(lfm[0].track.userplaycount);
            } else {

            }
          } catch (e) {
            console.log(e);

          }
        }

        var tagUpdate = firebase.database().ref("tagUpdate");
        if (playcount) {
          tagFixData.adamData.playcount = playcount;
          song.playcount = playcount;
        }
        // send tag update to clients
        tagUpdate.set(tagFixData);

      });


      // update the dj's playlist with updated tags
      var listRef = currentListRef();
      if (listRef) listRef.orderByChild('cid').equalTo(song.cid).once("value")
        .then(function(snapshot) {
          var data = snapshot.val();
          if (data) {
            for (var key in data) {
              var fixedName = song.artist + " - " + song.title;
              // unchanged names aren't rewritten: the DJ's site would download it again
              if (data[key].type == song.type && data[key].name !== fixedName) {
                listRef.child(key + "/name").set(fixedName);
              }
            }
          }
        });
    }

  }
}
/*
var adam = {
  np: function(song_name, dj, link, source) {
    if (!process.env.ADAM_URL) return;
    var thesource = "youtube";
    if (source == 2) {
      thesource = "soundcloud"
    }
    var adam_data = {
      data: {
        song_name: song_name,
        dj: dj,
        link: link,
        source: thesource
      }
    };
    // try posting to ADAM
    var options = {
      method: "POST",
      url: process.env.ADAM_URL + "/new_song",
      headers: {
        "Content-Type": "text/html;charset=utf-8"
      },
      form: adam_data
    };

    request(options, function(err1, res1, body1) {
      if (err1) console.log(err1);
      console.log(body1);
      if (body1) {
        try {
          var adm = JSON.parse(body1);
          adam_last = adm;

          console.log(adm);
          if (adm) {
            if (adm.track_name) {
              //if no track name, adam tags bad... dont use.
              if (adm.artist) {
                if (adm.artist !== "Unknown") {
                  song.artist = adm.artist;
                  song.title = adm.track_name;
                } else {
                  // if ADAM thinks the artist's name is UNKNOWN, overwrite with whatever hostbot came up with
                  adam.fix_tags(adm.track_id, song.artist + " - " + song.title);
                }
              }
            } else {
              //NO TRACK NAME... if we have enough data, let's tell ADAM what we know
              adam.fix_tags(adm.track_id, song.artist + " - " + song.title);
            }

            if (adm.track_id) song.adamid = adm.track_id;
            if (adm.playcount) song.playcount = adm.playcount;
            var tagUpdate = firebase.database().ref("tagUpdate");
            var tagFixData = {
              adamData: adm,
              cid: song.cid
            };

            // send tag update to clients
            tagUpdate.set(tagFixData);

            // update the dj's playlist with updated tags
            queueRef.orderByChild('cid').equalTo(song.cid).once("value")
              .then(function(snapshot) {
                var data = snapshot.val();
                if (data) {
                  for (var key in data) {
                    if (data[key].type == song.type) {
                      newData = data[key];
                      newData.name = song.artist + " - " + song.title;
                      queueRef.child(key).set(newData);
                    }
                  }
                }
              });
          }
        } catch (e) {
          console.log(e);
        }
      }
    });
  },
  fix_tags: function(adamid, args) {
    var song_data = args.split(' - ')
    if (song_data.length < 2) {
      //bad format
    } else {
      var artist0 = song_data[0].replace(/&amp;/g, '&');
      var title0 = song_data[1].replace(/&amp;/g, '&');

      var adam_data = {
        data: {
          artist: artist0,
          title: title0,
          track_id: adamid
        }
      };
      var options = {
        method: "POST",
        url: "https://adam-indie-discotheque.herokuapp.com//fix_tags",
        headers: {
          "Content-Type": "text/html;charset=utf-8"
        },
        form: adam_data
      };

      request(options, function(err1, res1, body1) {
        if (err1) console.log(err1);
        console.log(body1);
        if (body1) {
          var adm = JSON.parse(body1);
          console.log("good tag fix");
        }
      });


    }
  }
};

*/

var lastfm = {
  sk: process.env.LASTFM_SESSIONKEY, //for last.fm user tt_discotheque
  // Scrobbling needs the API key and its shared secret (.env LASTFM_SECRET)
  key: process.env.LASTFM_SECRET ? process.env.LASTFM_APIKEY : null,
  secret: process.env.LASTFM_SECRET,
  songStart: null,
  duration: null,
  scrobble: function() {
    var artist = song.artist;
    var track = song.title;

    var params = {
      artist: artist,
      track: track,
      timestamp: lastfm.songStart,
      api_key: lastfm.key,
      sk: lastfm.sk,
      method: "track.scrobble"
    };

    var sig = lastfm.getApiSignature(params);
    params.api_sig = sig;

    var request_url = 'https://ws.audioscrobbler.com/2.0/?' + serialize(params);

    var request_url = 'https://ws.audioscrobbler.com/2.0/?' + serialize(params);
    var options = {
      method: "POST",
      url: request_url
    };

    request(options, function(err1, res1, body1) {
      if (err1) console.log(err1);
      //console.log(body1);
    });
  },
  love: function() {
    var artist = song.artist;
    var track = song.title;

    var params = {
      artist: artist,
      track: track,
      api_key: lastfm.key,
      sk: lastfm.sk,
      method: "track.love"
    };

    var sig = lastfm.getApiSignature(params);
    params.api_sig = sig;

    var request_url = 'https://ws.audioscrobbler.com/2.0/?' + serialize(params);
    var options = {
      method: "POST",
      url: request_url
    };

    request(options, function(err1, res1, body1) {
      if (err1) console.log(err1);
      // console.log(body1);
    });

  },
  _onAjaxError: function(xhr, status, error) {
    console.log(xhr);
    console.log(status);
    console.log(error);
  },
  nowPlaying: function() {
    var artist = song.artist;
    var track = song.title;

    var params = {
      artist: artist,
      track: track,
      duration: lastfm.duration,
      api_key: lastfm.key,
      sk: lastfm.sk,
      method: "track.updateNowPlaying"
    };

    var sig = lastfm.getApiSignature(params);
    params.api_sig = sig;

    var request_url = 'https://ws.audioscrobbler.com/2.0/?' + serialize(params);

    var request_url = 'https://ws.audioscrobbler.com/2.0/?' + serialize(params);
    var options = {
      method: "POST",
      url: request_url
    };

    request(options, function(err1, res1, body1) {
      if (err1) console.log(err1);
      // console.log(body1);
    });

  },
  getApiSignature: function(params) {
    var i, key, keys, max, paramString;

    keys = [];
    paramString = "";

    for (key in params) {
      if (params.hasOwnProperty(key)) {
        keys.push(key);
      }
    }
    keys.sort();

    for (i = 0, max = keys.length; i < max; i += 1) {
      key = keys[i];
      paramString += key + params[key];
    }

    return calcMD5(paramString + lastfm.secret);
  }
};


console.log("soundcloud: " + (scOfficial ? "official API (SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET)" : "web API with SOUNDCLOUD_KEY"));
if (process.env.LASTFM_APIKEY && !process.env.LASTFM_SECRET) {
  console.log("last.fm: LASTFM_SECRET isn't set in .env, so plays won't be scrobbled.");
}

setInterval(function() {
  //keep stored chat history at 20 chats.
  console.log("hi");
  var ref = firebase.database().ref("chatFeed");
  ref.once("value").then(function(snapshot) {
    var data = snapshot.val();
    var chats = [];
    for (var key in data) {
      chats.push({
        feed: key,
        data: data[key].chatID
      });
    }
    console.log(chats.length);
    if (chats.length > 20) {
      var shave = chats.length - 21;
      for (var i = 0; i <= shave; i++) {
        console.log(chats[i]);
        var removeThis = firebase.database().ref('chatFeed/' + chats[i].feed);
        var removeData = firebase.database().ref('chatData/' + chats[i].data);
        removeThis.remove();
        removeData.remove();
      }
    }
  });
}, 5 * 60000);

// Every two minutes: anyone on deck or in line who has left gets one "are you
// there?", then is removed at the next check, unless they were seen online in
// the last 30 minutes (a quick reconnect).
var AWAY_GRACE_MS = 30 * 60 * 1000;
setInterval(function() {
  // a copy of the ids: removing someone changes the lists
  var ids = table.concat(queue).map(function(p) { return p && p.id; });
  ids.forEach(function(id) {
    if (!id) return;
    var u = users[id] || {};
    if (u.status) return;
    if (lastBlipped[id] && Date.now() - lastBlipped[id] <= AWAY_GRACE_MS) {
      console.log(id + " saved");
    } else if (!removalPending[id]) {
      removalPending[id] = true;
      console.log(id + " removal pending.");
      talk("@" + (u.username || id) + " are you there?");
    } else {
      removalPending[id] = null;
      console.log(id + " removed");
      removeMe(id);
    }
  });
  for (var key in removalPending) {
    if (removalPending.hasOwnProperty(key) && removalPending[key] && users[key] && users[key].status) {
      console.log("removal for " + key + " aborted");
      removalPending[key] = null;
    }
  }
}, 2 * 60000);

/*
 * A JavaScript implementation of the RSA Data Security, Inc. MD5 Message
 * Digest Algorithm, as defined in RFC 1321.
 * Copyright (C) Paul Johnston 1999 - 2000.
 * Updated by Greg Holt 2000 - 2001.
 * See http://pajhome.org.uk/site/legal.html for details.
 */

/*
 * Convert a 32-bit number to a hex string with ls-byte first
 */
var hex_chr = "0123456789abcdef";

function rhex(num) {
  str = "";
  for (j = 0; j <= 3; j++)
    str += hex_chr.charAt((num >> (j * 8 + 4)) & 0x0F) +
    hex_chr.charAt((num >> (j * 8)) & 0x0F);
  return str;
}

/*
 * Convert a string to a sequence of 16-word blocks, stored as an array.
 * Append padding bits and the length, as described in the MD5 standard.
 */
function str2blks_MD5(str) {
  nblk = ((str.length + 8) >> 6) + 1;
  blks = new Array(nblk * 16);
  for (i = 0; i < nblk * 16; i++) blks[i] = 0;
  for (i = 0; i < str.length; i++)
    blks[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
  blks[i >> 2] |= 0x80 << ((i % 4) * 8);
  blks[nblk * 16 - 2] = str.length * 8;
  return blks;
}

/*
 * Add integers, wrapping at 2^32. This uses 16-bit operations internally
 * to work around bugs in some JS interpreters.
 */
function add(x, y) {
  var lsw = (x & 0xFFFF) + (y & 0xFFFF);
  var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xFFFF);
}

/*
 * Bitwise rotate a 32-bit number to the left
 */
function rol(num, cnt) {
  return (num << cnt) | (num >>> (32 - cnt));
}

/*
 * These functions implement the basic operation for each round of the
 * algorithm.
 */
function cmn(q, a, b, x, s, t) {
  return add(rol(add(add(a, q), add(x, t)), s), b);
}

function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | ((~b) & d), a, b, x, s, t);
}

function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & (~d)), a, b, x, s, t);
}

function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | (~d)), a, b, x, s, t);
}

/*
 * Take a string and return the hex representation of its MD5.
 */
function calcMD5(str) {
  x = str2blks_MD5(str);
  a = 1732584193;
  b = -271733879;
  c = -1732584194;
  d = 271733878;

  for (i = 0; i < x.length; i += 16) {
    olda = a;
    oldb = b;
    oldc = c;
    oldd = d;

    a = ff(a, b, c, d, x[i + 0], 7, -680876936);
    d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819);
    b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897);
    d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063);
    b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, x[i + 1], 5, -165796510);
    d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713);
    b = gg(b, c, d, a, x[i + 0], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691);
    d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335);
    b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438);
    d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961);
    b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, x[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, x[i + 5], 4, -378558);
    d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632);
    b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174);
    d = hh(d, a, b, c, x[i + 0], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979);
    b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487);
    d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520);
    b = hh(b, c, d, a, x[i + 2], 23, -995338651);

    a = ii(a, b, c, d, x[i + 0], 6, -198630844);
    d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523);
    b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070);
    d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259);
    b = ii(b, c, d, a, x[i + 9], 21, -343485551);

    a = add(a, olda);
    b = add(b, oldb);
    c = add(c, oldc);
    d = add(d, oldd);
  }
  return rhex(a) + rhex(b) + rhex(c) + rhex(d);
}

var serialize = function(obj, prefix) {
  var str = [];
  for (var p in obj) {
    if (obj.hasOwnProperty(p)) {
      var k = prefix ? prefix + "[" + p + "]" : p,
        v = obj[p];
      str.push(typeof v == "object" ?
        serialize(v, k) :
        encodeURIComponent(k) + "=" + encodeURIComponent(v));
    }
  }
  return str.join("&");
}

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