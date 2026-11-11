#!/usr/bin/env node
// Connect the bot to the room's YouTube account, once, so it can keep the
// genre playlists on YouTube Music (lib/ytplaylists.js). Run it on your own
// computer, with a browser:
//
//   node tools/youtube-auth.js <client id> <client secret>
//
// It opens Google's sign-in page; sign in as the account that should own the
// playlists and allow access. It then prints the three lines to add to the
// bot's .env. Nothing is sent anywhere but Google.
"use strict";
var http = require("http");
var { execFile } = require("child_process");

var clientId = process.argv[2];
var clientSecret = process.argv[3];
if (!clientId || !clientSecret) {
  console.log("usage: node tools/youtube-auth.js <client id> <client secret>\n(see the README, \"genre playlists on YouTube Music\")");
  process.exit(1);
}

var server = http.createServer(function(req, res) {
  var url = new URL(req.url, "http://127.0.0.1");
  var code = url.searchParams.get("code");
  var error = url.searchParams.get("error");
  if (!code && !error) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  if (error) {
    res.end("Not connected (" + error + "). You can close this tab.");
    console.log("Google said: " + error);
    server.close();
    process.exitCode = 1;
    return;
  }
  res.end("Connected. You can close this tab and go back to the terminal.");
  fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }).toString()
  }).then(function(r) { return r.json(); }).then(function(json) {
    server.close();
    if (!json.refresh_token) {
      console.log("Google gave no refresh token (" + (json.error_description || json.error || "no reason given") + "). Run this again.");
      process.exitCode = 1;
      return;
    }
    console.log("\nAdd these to the bot's .env, then restart it:\n");
    console.log("YOUTUBE_CLIENT_ID=" + clientId);
    console.log("YOUTUBE_CLIENT_SECRET=" + clientSecret);
    console.log("YOUTUBE_REFRESH_TOKEN=" + json.refresh_token + "\n");
  }, function(err) {
    server.close();
    console.log("Couldn't reach Google: " + err.message);
    process.exitCode = 1;
  });
});

var redirect;
server.listen(0, "127.0.0.1", function() {
  redirect = "http://127.0.0.1:" + server.address().port;
  var auth = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube", access_type: "offline", prompt: "consent"
  }).toString();
  console.log("Opening Google's sign-in page. If it doesn't open, paste this into your browser:\n\n" + auth + "\n");
  var opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [auth], function() { /* the link above works too */ });
});
