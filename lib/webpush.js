// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption
// (RFC 8291, RFC 8188), on Node's own crypto and fetch: no extra packages.
// Sends a notification to a browser's push service (Apple, Google, Mozilla,
// Microsoft), which wakes the site's service worker on that phone or computer.
"use strict";

var crypto = require("crypto");

var b64u = {
  encode: function(buf) { return Buffer.from(buf).toString("base64url"); },
  decode: function(str) { return Buffer.from(String(str || ""), "base64url"); }
};

// Push services the bot will post to. Subscriptions are written by users, so
// anything else (an address on someone's own server, a private network) is
// refused instead of fetched.
var PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung Internet, Opera
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/, // Safari, iPhone/iPad home-screen apps
  /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/, // Firefox
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/ // Edge on Windows
];
function isPushEndpoint(endpoint) {
  try {
    var u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") &&
      PUSH_HOSTS.some(function(re) { return re.test(u.hostname); });
  } catch (e) {
    return false;
  }
}

// A new VAPID key pair (P-256), as the base64url strings browsers and .env use:
// publicKey is the 65-byte uncompressed point, privateKey the 32-byte scalar.
function generateVAPIDKeys() {
  var jwk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  return {
    publicKey: b64u.encode(Buffer.concat([Buffer.from([4]), b64u.decode(jwk.x), b64u.decode(jwk.y)])),
    privateKey: jwk.d
  };
}

// The signing key for a VAPID pair. Throws if the two halves don't match.
function vapidKey(publicKey, privateKey) {
  var pub = b64u.decode(publicKey);
  var d = b64u.decode(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error("VAPID keys must be a P-256 public key (65 bytes) and private key (32 bytes), base64url");
  // createPrivateKey doesn't check x/y against d: derive the public half and compare
  var ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  if (!ecdh.getPublicKey().equals(pub)) throw new Error("VAPID public and private keys are not a pair");
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64u.encode(d), x: b64u.encode(pub.subarray(1, 33)), y: b64u.encode(pub.subarray(33)) },
    format: "jwk"
  });
}

// "Authorization: vapid t=<JWT>, k=<public key>" for one push service.
// Tokens are cached per service for most of their 12-hour life.
var tokenCache = new Map();
function vapidAuth(endpoint, vapid) {
  var aud = new URL(endpoint).origin;
  var cacheKey = aud + "|" + vapid.publicKey + "|" + vapid.subject;
  var now = Math.floor(Date.now() / 1000);
  var hit = tokenCache.get(cacheKey);
  if (hit && hit.exp - now > 60 * 60) return hit.header;
  var exp = now + 12 * 60 * 60;
  var signingInput = b64u.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })) + "." +
    b64u.encode(JSON.stringify({ aud: aud, exp: exp, sub: vapid.subject }));
  var sig = crypto.sign("sha256", Buffer.from(signingInput), { key: vapid.key || vapidKey(vapid.publicKey, vapid.privateKey), dsaEncoding: "ieee-p1363" });
  var header = "vapid t=" + signingInput + "." + b64u.encode(sig) + ", k=" + vapid.publicKey;
  tokenCache.set(cacheKey, { exp: exp, header: header });
  if (tokenCache.size > 50) tokenCache.delete(tokenCache.keys().next().value);
  return header;
}

// Encrypt a payload for one subscription (aes128gcm, a single record).
// p256dh / auth are the subscription's keys (base64url).
function encrypt(payload, p256dh, auth) {
  var uaPublic = b64u.decode(p256dh);
  var authSecret = b64u.decode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("bad p256dh key");
  if (authSecret.length < 16) throw new Error("bad auth secret");
  var plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02: last record, no padding
  if (plaintext.length > 3993) throw new Error("payload too big for one push (" + payload.length + " bytes)");

  var ecdh = crypto.createECDH("prime256v1");
  var asPublic = ecdh.generateKeys();
  var shared = ecdh.computeSecret(uaPublic);
  var salt = crypto.randomBytes(16);
  var hkdf = function(ikm, hkdfSalt, info, len) {
    return Buffer.from(crypto.hkdfSync("sha256", ikm, hkdfSalt, info, len));
  };
  var ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  var cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  var nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

  var cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  var body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  var header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16); // record size
  header[20] = asPublic.length; // key id: the sender's public key
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Send one push message.
 * @param {{endpoint: string, p256dh: string, auth: string}} sub
 * @param {Object|string} payload - sent as JSON (keep it under ~3 KB)
 * @param {{publicKey: string, privateKey: string, subject: string, key?: KeyObject}} vapid
 * @param {{ttl?: number, urgency?: string, topic?: string, timeout?: number}} [opts]
 * @returns {Promise<{status: number, gone: boolean, ok: boolean, body: string}>}
 *   gone: the subscription no longer exists (unsubscribed, app removed); delete it.
 */
function send(sub, payload, vapid, opts) {
  opts = opts || {};
  if (!isPushEndpoint(sub.endpoint)) return Promise.reject(new Error("not a known push service: " + String(sub.endpoint).slice(0, 80)));
  var body;
  try {
    body = encrypt(typeof payload === "string" ? payload : JSON.stringify(payload), sub.p256dh, sub.auth);
  } catch (err) {
    return Promise.reject(err);
  }
  var headers = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    TTL: String(Math.max(0, Math.floor(opts.ttl == null ? 86400 : opts.ttl))),
    Urgency: opts.urgency || "normal",
    Authorization: vapidAuth(sub.endpoint, vapid)
  };
  // same topic: a newer message replaces one the phone hasn't picked up yet
  if (opts.topic) headers.Topic = String(opts.topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return fetch(sub.endpoint, {
    method: "POST",
    headers: headers,
    body: body,
    redirect: "error",
    signal: AbortSignal.timeout(opts.timeout || 15000)
  }).then(function(res) {
    return res.text().catch(function() { return ""; }).then(function(text) {
      return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, body: text.slice(0, 300) };
    });
  });
}

module.exports = {
  generateVAPIDKeys: generateVAPIDKeys,
  vapidKey: vapidKey,
  vapidAuth: vapidAuth,
  encrypt: encrypt,
  send: send,
  isPushEndpoint: isPushEndpoint
};
