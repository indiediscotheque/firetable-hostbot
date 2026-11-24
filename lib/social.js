// The room's social posting runs as a GitHub Actions workflow in
// firetable-user (.github/workflows/social.yml). GitHub's own schedules run
// late or not at all, so the bot, which is always on, starts that workflow
// itself once an hour. The workflow then decides what's due and posts it.
//
// Needs a GitHub token that may start workflows in that repository
// (SOCIAL_GITHUB_TOKEN; README "social posting"). Off without one.
"use strict";

var HOUR = 60 * 60 * 1000;

/**
 * @param {Object} o
 * @param {Function} o.http - lib/http.js
 * @param {string} o.token - a GitHub token with Actions: read and write on the repository
 * @param {string} [o.repo] - owner/name (default indiediscotheque/firetable-user)
 * @param {string} [o.workflow] - the workflow's file name (default social.yml)
 * @param {string} [o.ref] - the branch to run it on (default master)
 * @param {number} [o.minute] - the minute of each hour to start it (default 17)
 * @param {Function} [o.now] - the time in ms (tests)
 * @param {Function} [o.log]
 */
function createSocialTrigger(o) {
  var repo = o.repo || "indiediscotheque/firetable-user";
  var workflow = o.workflow || "social.yml";
  var minute = o.minute >= 0 && o.minute <= 59 ? o.minute : 17;
  var now = o.now || Date.now;
  var log = o.log || function() {};
  var state = { lastHour: null, lastOk: null, lastError: null, running: false, failures: 0 };

  /** Start the workflow now. Resolves true when GitHub took it. */
  function dispatch() {
    var url = "https://api.github.com/repos/" + repo + "/actions/workflows/" + encodeURIComponent(workflow) + "/dispatches";
    return o.http(url, {
      method: "POST",
      timeout: 20000,
      headers: {
        Authorization: "Bearer " + o.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "firetable-hostbot"
      },
      // the workflow's manual-run settings: whatever is due, posted for real
      body: JSON.stringify({ ref: o.ref || "master", inputs: { kind: "auto", force: "false", dry_run: "false" } })
    }).then(function(res) {
      if (res.status === 204) {
        state.lastOk = now();
        state.lastError = null;
        state.failures = 0;
        return true;
      }
      var why = (res.json && res.json.message) || String(res.body || "").slice(0, 200);
      var hint = res.status === 401 ? " (the token is wrong or has expired)"
        : res.status === 403 ? " (the token may not start workflows in " + repo + ")"
          : res.status === 404 ? " (no workflow " + workflow + " in " + repo + ", or the token can't see the repository)"
            : res.status === 422 ? " (the workflow doesn't take these settings, or the branch is wrong)" : "";
      throw new Error("GitHub answered " + res.status + ": " + why + hint);
    }).catch(function(err) {
      state.failures++;
      state.lastError = err.message;
      // say it the first time and then once a day, not every hour
      if (state.failures === 1 || state.failures % 24 === 0) log("social posting: couldn't start the workflow: " + err.message);
      return false;
    });
  }

  /** Called every minute or so: starts the workflow once each hour, at `minute` past or the first chance after. */
  function tick() {
    var t = now();
    var hour = Math.floor(t / HOUR);
    if (state.running || state.lastHour === hour || new Date(t).getMinutes() < minute) return Promise.resolve(false);
    state.lastHour = hour;
    state.running = true;
    return dispatch().then(function(ok) {
      state.running = false;
      return ok;
    });
  }

  return {
    tick: tick,
    dispatch: dispatch,
    status: function() {
      return { repo: repo, workflow: workflow, minute: minute, lastOk: state.lastOk, lastError: state.lastError, failures: state.failures };
    }
  };
}

module.exports = { createSocialTrigger: createSocialTrigger };
