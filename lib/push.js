// Push notifications.
// @mentions reach people's phones (the site installed as an app) and
// computers through Web Push, even with the room closed. The site saves each
// device that turned it on under pushSubs/<uid>/<device>; the bot sends:
//   - every mention filed in the inbox (app.js fileMentions)
//   - the bot's own @name messages ("are you there?" when you're on deck)
//   - @everyone from mods and the bot, to devices that opted in to those
// Nobody is pushed while they're looking at the room (online and not idle).
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env, or (unset) a pair the
// bot makes once and keeps in pushVapid (only bots can read it). The public
// half is published as pushKey for the site. PUSH_NOTIFICATIONS=false: off.
"use strict";
var webpush = require("./webpush");

var PUSH_FRESH_MS = 10 * 60 * 1000; // older messages (after a long disconnect) aren't pushed
var PUSH_PER_MINUTE = 6; // per person
var PUSH_MAX_DEVICES = 10; // per person
var PUSH_EVERYONE_GAP = 10 * 60 * 1000; // between @everyone pushes
var PUSH_STALE_MS = 60 * 24 * 60 * 60 * 1000; // devices not opened in 60 days are dropped
/**
 * @param {object} deps
 * @param {function(): any} deps.db - firebase.database()
 * @param {Object<string, string|undefined>} deps.env - process.env (PUSH_NOTIFICATIONS, VAPID_*, SITE_URL)
 * @param {function(): Object} deps.users - the members as the bot holds them
 * @param {function(): string} deps.botid
 * @param {function(): number} deps.serverNow
 * @param {function(string): (string|false)} deps.uidLookup - a member's uid from their name
 * @param {function(string): Promise<string[]>} deps.shallowKeys - a node's keys
 * @param {function(...*): void} [deps.log]
 */
function createPush(deps) {
  var env = deps.env;
  var log = deps.log || console.log;
  var push = {
    on: !/^(false|0|off|no)$/i.test(String(env.PUSH_NOTIFICATIONS || "").trim()),
    vapid: null,
    recent: {}, // uid -> send times in the last minute
    everyoneAt: 0,
    subject: function() {
      var s = String(env.VAPID_SUBJECT || "").trim();
      if (/^(mailto:|https:\/\/)/i.test(s)) return s;
      try {
        var site = new URL(env.SITE_URL);
        if (site.protocol === "https:") return site.origin;
      } catch (e) { /* no SITE_URL */ }
      return "https://github.com/indiediscotheque/firetable-hostbot";
    },
    init: function() {
      if (!push.on) return log("push: off (PUSH_NOTIFICATIONS=false)");
      var db = deps.db();
      var envPub = String(env.VAPID_PUBLIC_KEY || "").trim();
      var envPriv = String(env.VAPID_PRIVATE_KEY || "").trim();
      var made = false;
      var keys = envPub && envPriv
        ? Promise.resolve({ publicKey: envPub, privateKey: envPriv })
        : db.ref("pushVapid").transaction(function(cur) {
          if (cur && cur.publicKey && cur.privateKey) return; // keep the saved pair
          return webpush.generateVAPIDKeys();
        }).then(function(result) {
          made = result.committed;
          return result.snapshot.val();
        });
      return keys.then(function(k) {
        var vapid = { publicKey: k.publicKey, privateKey: k.privateKey, subject: push.subject() };
        vapid.key = webpush.vapidKey(vapid.publicKey, vapid.privateKey);
        push.vapid = vapid;
        return db.ref("pushKey").once("value").then(function(snap) {
          if (snap.val() !== vapid.publicKey) return db.ref("pushKey").set(vapid.publicKey);
        }).then(function() {
          log("push: on (" + (envPub ? "keys from .env" : made ? "new keys saved in the database" : "keys from the database") + ", subject " + vapid.subject + ")");
          push.prune();
        });
      }).catch(function(err) {
        push.vapid = null;
        if (/permission/i.test(err.code || err.message)) {
          log("push: the database rules don't allow push notifications yet (publish firebase-rules.json); they're off until then.");
        } else {
          log("push: off (" + err.message + ")");
        }
      });
    },
    // looking at the room right now (on any device)
    watching: function(uid) {
      var u = deps.users()[uid];
      return !!(u && u.status && u.idle && u.idle.isIdle === false);
    },
    allowed: function(uid) {
      var now = Date.now();
      var times = (push.recent[uid] || []).filter(function(t) { return now - t < 60000; });
      if (times.length >= PUSH_PER_MINUTE) return false;
      times.push(now);
      push.recent[uid] = times;
      return true;
    },
    // unread mentions, for the number on the app icon
    unread: function(uid) {
      return deps.db().ref("mentions/" + uid).orderByChild("time").limitToLast(50).once("value").then(function(snap) {
        var n = 0;
        snap.forEach(function(m) {
          if (m.val() && !m.val().read) n++;
        });
        return n;
      }).catch(function() { return null; });
    },
    // Send one message to every device a person signed up. filter(sub) picks
    // devices; opts: ttl, urgency, topic, force (even while they're watching),
    // badge (add the unread count). Resolves with how many devices got it.
    toUser: function(uid, message, opts) {
      opts = opts || {};
      if (!push.vapid || !uid || uid === deps.botid()) return Promise.resolve(0);
      if (!opts.force && push.watching(uid)) return Promise.resolve(0);
      if (!push.allowed(uid)) {
        log("push: " + uid + " was sent " + PUSH_PER_MINUTE + " in the last minute; skipped one");
        return Promise.resolve(0);
      }
      var db = deps.db();
      return db.ref("pushSubs/" + uid).once("value").then(function(snap) {
        var subs = [];
        snap.forEach(function(s) {
          var v = s.val();
          if (!v || !v.endpoint || (opts.filter && !opts.filter(v))) return;
          // made with keys the bot no longer uses: the site re-subscribes it next visit
          if (v.key && v.key !== push.vapid.publicKey) return;
          subs.push({ id: s.key, sub: v });
        });
        // the 10 devices used most recently (each one is a request)
        subs = subs.sort(function(a, b) { return (b.sub.seen || 0) - (a.sub.seen || 0); }).slice(0, PUSH_MAX_DEVICES);
        if (!subs.length) return 0;
        return (opts.badge ? push.unread(uid) : Promise.resolve(null)).then(function(badge) {
          var payload = Object.assign({}, message);
          if (badge !== null) payload.badge = badge;
          return Promise.all(subs.map(function(item) {
            return webpush.send(item.sub, payload, push.vapid, { ttl: opts.ttl, urgency: opts.urgency || "high", topic: opts.topic }).then(function(res) {
              if (res.ok) return 1;
              if (res.gone) {
                db.ref("pushSubs/" + uid + "/" + item.id).remove().catch(function() {});
                log("push: removed a device of " + uid + " that unsubscribed (HTTP " + res.status + ")");
              } else {
                log("push: " + new URL(item.sub.endpoint).hostname + " answered HTTP " + res.status + " for " + uid + (res.body ? ": " + res.body.replace(/\s+/g, " ") : ""));
              }
              return 0;
            }, function(err) {
              log("push: couldn't send to a device of " + uid + ": " + err.message);
              return 0;
            });
          }));
        }).then(function(sent) {
          var n = sent.reduce(function(a, b) { return a + b; }, 0);
          if (n) log("push: " + (message.kind || "message") + " for " + ((deps.users()[uid] && deps.users()[uid].username) || uid) + " to " + n + " device(s)");
          return n;
        });
      }).catch(function(err) {
        log("push: couldn't read " + uid + "'s devices: " + err.message);
        return 0;
      });
    },
    text: function(txt) {
      txt = String(txt || "").replace(/\s+/g, " ").trim();
      return txt.length > 200 ? txt.slice(0, 199) + "…" : txt;
    },
    fresh: function(chatData) {
      return typeof chatData.time !== "number" || deps.serverNow() - chatData.time < PUSH_FRESH_MS;
    },
    // a mention just filed in someone's inbox
    mention: function(target, chatID, chatData, fromName) {
      if (!push.fresh(chatData)) return;
      push.toUser(target, {
        kind: "mention", id: chatID, title: fromName, body: push.text(chatData.txt), from: fromName,
        fromId: chatData.id, time: chatData.time || Date.now(), tag: "m-" + chatID, url: "./#mentions"
      }, { badge: true, ttl: 24 * 60 * 60 });
    },
    // the bot's own @name messages and @everyone (inbox mentions go through mention())
    chat: function(chatID, chatData, fromName) {
      if (!push.vapid || chatData.botCmd || !chatData.id || !push.fresh(chatData)) return;
      var txt = String(chatData.txt || "");
      var sender = deps.users()[chatData.id] || {};
      var fromBot = chatData.id === deps.botid();
      var base = { id: chatID, title: fromName, body: push.text(txt), from: fromName, fromId: chatData.id, time: chatData.time || Date.now() };
      if (fromBot) {
        var re = /@([A-Za-z0-9_]{1,22})(?![A-Za-z0-9_])/g, m, seen = {};
        while ((m = re.exec(txt))) {
          var name = m[1].toLowerCase();
          if (name === "everyone" || seen[name]) continue;
          seen[name] = true;
          var target = deps.uidLookup(name);
          if (!target || target === deps.botid()) continue;
          // "are you there?" goes out once and stops mattering when they're removed
          var awayCheck = /are you there\?/i.test(txt);
          push.toUser(target, Object.assign({}, base, { kind: "bot", tag: awayCheck ? "away" : "bot-" + chatID, url: "./" }),
            awayCheck ? { ttl: 4 * 60, topic: "away" } : { ttl: 60 * 60 });
        }
      }
      if ((fromBot || sender.mod || sender.supermod) && /@everyone(?![A-Za-z0-9_])/i.test(txt)) {
        var now = Date.now();
        if (now - push.everyoneAt < PUSH_EVERYONE_GAP) return log("push: @everyone sent less than 10 minutes ago; not pushed");
        push.everyoneAt = now;
        var db = deps.db();
        deps.shallowKeys("pushSubs").then(function(uids) {
          uids.forEach(function(uid) {
            if (uid === chatData.id || uid === deps.botid()) return;
            var blocked = fromBot ? Promise.resolve(false) : Promise.all([
              db.ref("blocks/" + uid + "/" + chatData.id).once("value"),
              db.ref("blocks/" + chatData.id + "/" + uid).once("value")
            ]).then(function(b) { return !!(b[0].val() || b[1].val()); });
            blocked.then(function(isBlocked) {
              if (isBlocked) return;
              push.toUser(uid, Object.assign({}, base, { kind: "@everyone", title: fromName + " → everyone", tag: "everyone", url: "./" }),
                { ttl: 60 * 60, urgency: "normal", topic: "everyone", filter: function(sub) { return sub.everyone === true; } });
            }).catch(function() {});
          });
        }).catch(function(err) {
          log("push: couldn't read the devices for @everyone: " + err.message);
        });
      }
    },
    // devices not opened in 60 days, or saved in a shape the bot can't use
    prune: function() {
      if (!push.vapid) return;
      var cutoff = deps.serverNow() - PUSH_STALE_MS;
      deps.db().ref("pushSubs").once("value").then(function(snap) {
        var updates = {};
        snap.forEach(function(person) {
          person.forEach(function(dev) {
            var v = dev.val() || {};
            if (!(v.seen > cutoff) || !webpush.isPushEndpoint(v.endpoint)) updates[person.key + "/" + dev.key] = null;
          });
        });
        var n = Object.keys(updates).length;
        if (n) {
          log("push: dropping " + n + " device(s) not seen in 60 days");
          return deps.db().ref("pushSubs").update(updates);
        }
      }).catch(function(err) {
        log("push: prune error: " + err.message);
      });
    }
  };
  return push;
}

module.exports = { createPush: createPush };
