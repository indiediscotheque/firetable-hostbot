// Preload for app.js in the tests (node -r ./test/fake-services.js app.js):
// fake YouTube, SoundCloud, Last.fm/Deezer and artwork colours, Firebase
// sign-in through the auth emulator, and timers of a second or more run 20x
// faster. SCENARIO / YT_DELAY (env) pick how the fakes answer.
const Module = require("module");
const realST = global.setTimeout;
global.setTimeout = function (fn, ms, ...a) { return realST(fn, ms >= 1000 ? ms / 20 : ms, ...a); };
const SC = process.env.SCENARIO;
const video = (img) => ({ items: [{ contentDetails: { duration: "PT10M" }, snippet: { channelTitle: "Chan", publishedAt: "2020-01-01T00:00:00Z", thumbnails: { medium: { url: img } } } }] });
const okVideo = video("https://img.example/x.jpg");
const YT_DELAY = Number(process.env.YT_DELAY || 0);
function yt(id) {
  if (SC === "yt_outage") return { err: { code: 403, message: "The request cannot be completed because you have exceeded your quota." } };
  if (id === "dead1") return { res: { items: [] } };
  if (id === "badart") return { res: video("https://img.example/bad.jpg") };
  if (id === "hang1") return { hang: true };
  return { res: okVideo };
}
const scTrack = (extra) => JSON.stringify(Object.assign({ id: 1, duration: 120000, title: "SC - Song", user: { username: "u" }, created_at: "2020-01-01", permalink_url: "https://soundcloud.com/u/s", artwork_url: null }, extra));
let scTokens = 0;
function req(url, o) {
  // official API (only used with SOUNDCLOUD_CLIENT_ID / SECRET set)
  if (url === "https://secure.soundcloud.com/oauth/token") {
    scTokens++;
    const ok = o.method === "POST" && /^Basic /.test(o.headers.Authorization) && o.body === "grant_type=client_credentials";
    return ok ? { resp: { statusCode: 200 }, body: JSON.stringify({ access_token: "tok" + scTokens, expires_in: 3600 }) } : { resp: { statusCode: 401 }, body: "{}" };
  }
  if (url.indexOf("https://api.soundcloud.com/tracks/") === 0) {
    if (!/^OAuth tok/.test((o.headers || {}).Authorization || "")) return { resp: { statusCode: 401 }, body: "{}" };
    const cid = decodeURIComponent(url.split("/tracks/")[1]);
    if (cid === "sc404") return { resp: { statusCode: 404 }, body: "{}" };
    if (cid === "scblocked") return { resp: { statusCode: 200 }, body: scTrack({ access: "blocked" }) };
    return { resp: { statusCode: 200 }, body: scTrack({ access: "playable" }) };
  }
  if (url.indexOf("api-v2.soundcloud.com") !== -1) {
    const cid = decodeURIComponent(url).match(/tracks\/([^&]+)/)[1];
    if (cid === "sc404") return { resp: { statusCode: 404 }, body: "{}" };
    if (cid === "sc503") return { resp: { statusCode: 503 }, body: "Service Unavailable" };
    return { resp: { statusCode: 200 }, body: JSON.stringify({ id: 1, duration: 120000, title: "SC - Song", user: { username: "u" }, created_at: "2020-01-01", permalink_url: "https://soundcloud.com/u/s", artwork_url: null }) };
  }
  return { resp: { statusCode: 500 }, body: "" }; // deezer, last.fm: off
}
const orig = Module._load;
Module._load = function (name) {
  if (name === "youtube-node") return function () { this.setKey = () => {}; this.getById = (id, cb) => { const r = yt(id); if (r.hang) return; realST(() => cb(r.err, r.res), YT_DELAY); }; };
  if (name === "request") return function (o, cb) { const r = req(typeof o === "string" ? o : o.url, typeof o === "string" ? {} : o); setImmediate(() => cb(r.err || null, r.resp, r.body)); };
  if (name === "node-vibrant") return { from: (img) => ({ getPalette: () => (/bad/.test(img) ? Promise.reject(new Error("can't decode " + img)) : Promise.resolve({ Vibrant: { getHex: () => "#123456", getBodyTextColor: () => "#fff" } })) }) };
  const m = orig.apply(this, arguments);
  if (name === "firebase" && !m.__emu) {
    m.__emu = true;
    const init = m.initializeApp.bind(m);
    m.initializeApp = (c) => { const app = init(c); m.auth().useEmulator("http://127.0.0.1:9099"); return app; };
  }
  return m;
};
