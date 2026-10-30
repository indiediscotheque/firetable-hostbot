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

const video = (img) => ({ items: [{ contentDetails: { duration: "PT10M" }, snippet: { channelTitle: "Chan", publishedAt: "2020-01-01T00:00:00Z", thumbnails: { medium: { url: img } } } }] });
function youtube(id) {
  if (SC === "yt_outage") return json(403, { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota." } }, YT_DELAY);
  if (id === "hang1") return new Promise(() => {});
  if (id === "dead1") return json(200, { items: [] }, YT_DELAY);
  if (id === "badart") return json(200, video("https://img.example/bad.jpg"), YT_DELAY);
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
  return json(200, scTrack());
}

const realFetch = global.fetch;
global.fetch = function (input, init) {
  const url = String(input);
  init = init || {};
  const host = new URL(url).hostname;
  if (host === "127.0.0.1" || host === "localhost") return realFetch(input, init);
  if (host === "www.googleapis.com") return youtube(new URL(url).searchParams.get("id"));
  if (/soundcloud\.com$/.test(host)) return soundcloud(url, init);
  if (host === "img.example") {
    return Promise.resolve(/bad/.test(url)
      ? new Response("not really a jpeg", { status: 200, headers: { "content-type": "image/jpeg" } })
      : new Response(ARTWORK, { status: 200, headers: { "content-type": "image/png" } }));
  }
  if (host === "ws.audioscrobbler.com" && process.env.LASTFM_SECRET) return lastfm(url, init);
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
