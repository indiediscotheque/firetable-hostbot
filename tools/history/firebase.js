// The room's database over HTTPS, signed in as the bot (.env FIRETABLE_USER /
// FIRETABLE_PASS, FIREBASE_KEY, FIREBASE_DB). Reads big lists a piece at a
// time and writes in batches, so nothing times out.
"use strict";

function client(env) {
  var dbUrl = String(env.FIREBASE_DB || "").replace(/\/+$/, "");
  if (!dbUrl || !env.FIREBASE_KEY || !env.FIRETABLE_USER || !env.FIRETABLE_PASS) {
    throw new Error("needs FIREBASE_DB, FIREBASE_KEY, FIRETABLE_USER and FIRETABLE_PASS (the bot's .env)");
  }
  var token = null;
  var refresh = null;
  var expires = 0;

  async function auth() {
    if (token && Date.now() < expires - 60000) return token;
    var res;
    if (refresh) {
      res = await fetch("https://securetoken.googleapis.com/v1/token?key=" + env.FIREBASE_KEY, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refresh)
      });
      var r = await res.json();
      if (!res.ok) throw new Error("couldn't refresh the sign-in: " + JSON.stringify(r.error || r));
      token = r.id_token; refresh = r.refresh_token; expires = Date.now() + Number(r.expires_in) * 1000;
      return token;
    }
    res = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + env.FIREBASE_KEY, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: env.FIRETABLE_USER, password: env.FIRETABLE_PASS, returnSecureToken: true })
    });
    var j = await res.json();
    if (!res.ok) throw new Error("couldn't sign in as the bot: " + ((j.error && j.error.message) || res.status));
    token = j.idToken; refresh = j.refreshToken; expires = Date.now() + Number(j.expiresIn) * 1000;
    return token;
  }

  async function call(method, path, params, body) {
    for (var attempt = 0; ; attempt++) {
      var url = new URL(dbUrl + "/" + String(path || "").replace(/^\/+/, "") + ".json");
      url.searchParams.set("auth", await auth());
      Object.keys(params || {}).forEach(function(k) { url.searchParams.set(k, params[k]); });
      try {
        var res = await fetch(url, {
          method: method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(300000)
        });
        if (res.status === 401 || res.status === 403) {
          var t = await res.text();
          var err = new Error("permission denied for " + path + " (" + t.slice(0, 120) + ")");
          err.denied = true;
          throw err;
        }
        if (res.status >= 500 || res.status === 429) throw new Error("database answered " + res.status);
        if (!res.ok) throw new Error("database answered " + res.status + ": " + (await res.text()).slice(0, 200));
        return await res.json();
      } catch (e) {
        if (e.denied || attempt >= 5) throw e;
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
  }

  return {
    get: function(path, params) { return call("GET", path, params); },
    keys: async function(path) { return Object.keys((await call("GET", path, { shallow: "true" })) || {}); },
    // a big list in pages of `size` children, by key
    getPaged: async function(path, size, onPage) {
      var start = null;
      for (;;) {
        var params = { orderBy: '"$key"', limitToFirst: String(size + (start ? 1 : 0)) };
        if (start) params.startAt = JSON.stringify(start);
        var page = (await call("GET", path, params)) || {};
        var keys = Object.keys(page).sort(keyOrder);
        if (start && keys[0] === start) { delete page[start]; keys.shift(); }
        if (!keys.length) return;
        await onPage(page);
        if (keys.length < size) return;
        start = keys[keys.length - 1];
      }
    },
    // multi-path write: {"a/b": 1, "c": null}
    update: function(updates) { return call("PATCH", "", null, updates); },
    uid: async function() {
      await auth();
      return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).user_id;
    }
  };
}

// The database's own key order: whole numbers (32-bit) first, by value, then
// everything else as text.
function keyOrder(a, b) {
  var ia = isIntKey(a);
  var ib = isIntKey(b);
  if (ia && ib) return Number(a) - Number(b);
  if (ia !== ib) return ia ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function isIntKey(k) {
  return /^-?(?:0|[1-9]\d{0,9})$/.test(k) && Number(k) >= -2147483648 && Number(k) <= 2147483647;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

module.exports = { client: client, sleep: sleep, keyOrder: keyOrder };
