// The hourly start of firetable-user's social posting workflow (lib/social.js),
// against a fake GitHub. No network.
//   cd test && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createSocialTrigger } = require("../lib/social.js");

const at = (h, m) => new Date(2026, 10, 24, h, m).getTime();

function fakeGitHub(answers) {
  const calls = [];
  const http = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const a = answers.length ? answers.shift() : { status: 204 };
    return { status: a.status, body: a.body || "", json: a.json || null };
  };
  return { http, calls };
}

test("starts the workflow once an hour, at its minute or the first chance after", async () => {
  let t = at(10, 5);
  const gh = fakeGitHub([]);
  const s = createSocialTrigger({ http: gh.http, token: "tok", minute: 17, now: () => t });
  assert.equal(await s.tick(), false, "not before :17");
  t = at(10, 17);
  assert.equal(await s.tick(), true);
  t = at(10, 40);
  assert.equal(await s.tick(), false, "once an hour");
  t = at(11, 50); // the bot was busy or down at :17: it still starts this hour
  assert.equal(await s.tick(), true);
  assert.equal(gh.calls.length, 2);
  const c = gh.calls[0];
  assert.equal(c.url, "https://api.github.com/repos/indiediscotheque/firetable-user/actions/workflows/social.yml/dispatches");
  assert.equal(c.opts.method, "POST");
  assert.equal(c.opts.headers.Authorization, "Bearer tok");
  assert.deepEqual(c.body, { ref: "master", inputs: { kind: "auto", force: "false", dry_run: "false" } }, "posts for real: a manual run's default is a dry run");
  assert.equal(s.status().lastOk, at(11, 50));
});

test("a refused start is explained once, and tried again the next hour", async () => {
  let t = at(10, 20);
  const logs = [];
  const gh = fakeGitHub([{ status: 403, json: { message: "Resource not accessible by personal access token" } }, { status: 204 }]);
  const s = createSocialTrigger({ http: gh.http, token: "tok", now: () => t, log: (m) => logs.push(m) });
  assert.equal(await s.tick(), false);
  assert.match(s.status().lastError, /403.*may not start workflows/);
  assert.equal(logs.length, 1);
  t = at(11, 20);
  assert.equal(await s.tick(), true);
  assert.equal(s.status().lastError, null);
  assert.equal(s.status().failures, 0);
});

test("no answer at all (network down) doesn't stop it", async () => {
  const t = at(10, 20);
  const s = createSocialTrigger({ http: async () => { throw new Error("fetch failed"); }, token: "tok", now: () => t });
  assert.equal(await s.tick(), false);
  assert.match(s.status().lastError, /fetch failed/);
});

test("another repository, workflow and minute", async () => {
  const gh = fakeGitHub([]);
  const s = createSocialTrigger({ http: gh.http, token: "tok", repo: "me/site", workflow: "post.yml", minute: 0, now: () => at(9, 0) });
  await s.tick();
  assert.match(gh.calls[0].url, /repos\/me\/site\/actions\/workflows\/post\.yml\/dispatches$/);
});
