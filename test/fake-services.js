// Preload for app.js in the tests (node -r ./test/fake-services.js app.js):
// fake YouTube, SoundCloud, Last.fm/Deezer and artwork images (answered in
// place of fetch), Firebase sign-in through the auth emulator, and timers of a
// second or more run 20x faster. SCENARIO / YT_DELAY (env) pick how the fakes
// answer. Requests to the emulators (127.0.0.1) go through untouched.
const Module = require("module");
const zlib = require("zlib");
const realST = global.setTimeout;
global.setTimeout = function (fn, ms, ...a) { return realST(fn, ms >= 1000 ? ms / 20 : ms, ...a); };
const SC = process.env.SCENARIO;
const YT_DELAY = Number(process.env.YT_DELAY || 0);

const json = (status, body, delay) => new Promise((resolve) => realST(() => resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })), delay || 0));

// A real 4x4 PNG (one colour), so the artwork colours run for real
function png(r, g, b) {
  const crc = (buf) => { let c, crc = 0xffffffff; for (const byte of buf) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, r, g, b, r, g, b, r, g, b, r, g, b])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const ARTWORK = png(200, 30, 40);

const video = (img, extra) => {
  const item = { contentDetails: { duration: "PT10M" }, status: { embeddable: true, privacyStatus: "public", uploadStatus: "processed" },
    snippet: { channelTitle: "Chan", publishedAt: "2020-01-01T00:00:00Z", liveBroadcastContent: "none", thumbnails: { medium: { url: img } } } };
  for (const k of Object.keys(extra || {})) item[k] = Object.assign({}, item[k], extra[k]);
  return { items: [item] };
};
function youtube(id) {
  if (SC === "yt_outage") return json(403, { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota." } }, YT_DELAY);
  if (id === "hang1") return new Promise(() => {});
  if (id === "dead1") return json(200, { items: [] }, YT_DELAY);
  if (id === "badart") return json(200, video("https://img.example/bad.jpg"), YT_DELAY);
  if (id === "noembed") return json(200, video("https://img.example/x.jpg", { status: { embeddable: false } }), YT_DELAY);
  if (id === "premiere") return json(200, video("https://img.example/x.jpg", { snippet: { liveBroadcastContent: "upcoming" } }), YT_DELAY);
  if (id === "private1") return json(200, video("https://img.example/x.jpg", { status: { privacyStatus: "private" } }), YT_DELAY);
  if (id === "short1") return json(200, video("https://img.example/x.jpg", { contentDetails: { duration: "PT40S" } }), YT_DELAY);
  return json(200, video("https://img.example/x.jpg"), YT_DELAY);
}

const scTrack = (extra) => Object.assign({ id: 1, duration: 120000, title: "SC - Song", user: { username: "u" }, created_at: "2020-01-01", permalink_url: "https://soundcloud.com/u/s", artwork_url: null }, extra);
let scTokens = 0;
function soundcloud(url, init) {
  // official API (only used with SOUNDCLOUD_CLIENT_ID / SECRET set)
  if (url === "https://secure.soundcloud.com/oauth/token") {
    scTokens++;
    const ok = init.method === "POST" && /^Basic /.test(init.headers.Authorization) && init.body === "grant_type=client_credentials";
    return ok ? json(200, { access_token: "tok" + scTokens, expires_in: 3600 }) : json(401, {});
  }
  if (url.startsWith("https://api.soundcloud.com/tracks/")) {
    if (!/^OAuth tok/.test((init.headers || {}).Authorization || "")) return json(401, {});
    const cid = decodeURIComponent(url.split("/tracks/")[1]);
    if (cid === "sc404") return json(404, {});
    if (cid === "scblocked") return json(200, scTrack({ access: "blocked" }));
    return json(200, scTrack({ access: "playable" }));
  }
  // the web API (api-v2) with SOUNDCLOUD_KEY
  const cid = decodeURIComponent(url).match(/tracks\/([^&]+)/)[1];
  if (cid === "sc404") return json(404, {});
  if (cid === "sc503") return json(503, "Service Unavailable");
  if (cid === "scpreview") return json(200, scTrack({ access: "preview" }));
  if (cid === "scsnip") return json(200, scTrack({ policy: "SNIP", duration: 30000, full_duration: 200000 }));
  if (cid === "scshort") return json(200, scTrack({ duration: 30000, full_duration: 200000 }));
  return json(200, scTrack());
}

// YouTube's videos.list for many ids at once (the swap checks): one item per
// known id, with its id. "nogo" ids are unknown (gone), "noembed" ones can't
// be embedded.
function youtubeBatch(ids) {
  if (SC === "yt_outage") return youtube("x");
  return json(200, { items: ids.filter((id) => !/nogo/.test(id)).map((id) =>
    Object.assign(video("https://img.example/x.jpg", /noembed/.test(id) ? { status: { embeddable: false } } : {}).items[0], { id })) });
}

// YouTube Music search: audio tracks (ATV) next to videos (OMV), in the
// shape music.youtube.com answers. Logs each search.
const ytm = require("./fixtures/ytmusic.js");
const YTM_CATALOG = [
  { cid: "kpvideo0001", title: "Karma Police (Official Video)", artists: ["Radiohead"], kind: "OMV" },
  { cid: "kpnoembed01", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", dur: 262 },
  { cid: "kpstudio001", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", dur: 262 },
  { cid: "omtstudio01", title: "One More Time", artists: ["Daft Punk"], album: "Discovery", dur: 320 },
  { cid: "omtofficial", title: "One More Time (Official Audio)", artists: ["Daft Punk"], kind: "OMV" }
];
function ytmusic(init) {
  const body = JSON.parse(init.body);
  console.log("fake youtube music: search \"" + body.query + "\"" + (body.params ? " (songs)" : ""));
  if (SC === "ytm_down") return json(503, "");
  const words = body.query.toLowerCase();
  return json(200, ytm.answer(YTM_CATALOG.filter((r) => words.includes(r.title.toLowerCase().replace(/ \(.*$/, "")))));
}

const realFetch = global.fetch;
global.fetch = function (input, init) {
  const url = String(input);
  init = init || {};
  const host = new URL(url).hostname;
  if (host === "127.0.0.1" || host === "localhost") return realFetch(input, init);
  if (host === "www.googleapis.com") {
    const params = new URL(url).searchParams;
    return params.get("maxResults") ? youtubeBatch(params.get("id").split(",")) : youtube(params.get("id"));
  }
  if (host === "music.youtube.com") return ytmusic(init);
  if (/soundcloud\.com$/.test(host)) return soundcloud(url, init);
  if (host === "img.example") {
    return Promise.resolve(/bad/.test(url)
      ? new Response("not really a jpeg", { status: 200, headers: { "content-type": "image/jpeg" } })
      : new Response(ARTWORK, { status: 200, headers: { "content-type": "image/png" } }));
  }
  if (host === "ws.audioscrobbler.com" && process.env.LASTFM_SECRET) return lastfm(url, init);
  if (host === "fcm.googleapis.com" || /push\.apple\.com$/.test(host)) return pushService(url, init);
  return json(500, ""); // deezer, and last.fm unless a scenario sets it up
};

// Last.fm: checks each signed call the way Last.fm does (UTF-8 MD5 of the
// sorted name+value pairs and the secret) and says so in the bot's log
function lastfm(url, init) {
  if ((init.method || "GET") === "GET") return json(200, { track: { userplaycount: "7" } });
  const params = Object.fromEntries(new URLSearchParams(init.body));
  const { api_sig, format, ...signed } = params;
  const raw = Object.keys(signed).sort().map((k) => k + signed[k]).join("") + process.env.LASTFM_SECRET;
  const ok = require("crypto").createHash("md5").update(raw, "utf8").digest("hex") === api_sig;
  console.log("fake last.fm: " + params.method + " signature " + (ok ? "ok" : "WRONG") + " (" + params.artist + " - " + params.track + ")");
  return ok ? json(200, {}) : json(403, { error: 13, message: "Invalid method signature supplied" });
}

const orig = Module._load;
Module._load = function (name) {
  const m = orig.apply(this, arguments);
  if (name === "@firebase/app-compat" && !m.__emu) {
    m.__emu = true;
    const fb = m.default;
    const init = fb.initializeApp.bind(fb);
    fb.initializeApp = (c) => { const app = init(c); fb.auth().useEmulator("http://127.0.0.1:9099"); return app; };
  }
  return m;
};

// Push services (Google, Apple): checks the VAPID token against the public key
// the bot published, decrypts the message with the test browser's keys
// (PUSH_UA_KEY / PUSH_AUTH) and logs it. A path ending in /gone answers 410
// (the app was removed), as a real push service does.
function pushService(url, init) {
  const crypto = require("crypto");
  const path = new URL(url).pathname;
  if (path.endsWith("/gone")) return json(410, "");
  const m = String(init.headers.Authorization).match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  const pub = Buffer.from(m[4], "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  const signed = crypto.verify("sha256", Buffer.from(m[1] + "." + m[2]), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"));
  const aud = JSON.parse(Buffer.from(m[2], "base64url")).aud;
  const ua = crypto.createECDH("prime256v1");
  ua.setPrivateKey(Buffer.from(process.env.PUSH_UA_KEY, "base64url"));
  const msg = JSON.parse(require("http_ece").decrypt(init.body, { version: "aes128gcm", privateKey: ua, authSecret: process.env.PUSH_AUTH }).toString());
  console.log("fake push " + path + " [" + (signed && aud === new URL(url).origin ? "vapid ok" : "VAPID WRONG") + " ttl=" + init.headers.TTL + "]: " +
    msg.title + " | " + msg.body + (msg.badge != null ? " | badge=" + msg.badge : ""));
  return json(201, "");
}
