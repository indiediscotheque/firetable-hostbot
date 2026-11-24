// The room's seasons, as the site decides them (firetable-user js/seasons.js
// holds the defaults; config.js can override them): the trading-card
// avatars' seasonal style and the string-lights months. With SITE_URL set,
// the bot reads both files from the live site at startup and every 10
// minutes, so a change there reaches the bot on its own. Without SITE_URL (or
// if the site can't be reached) it uses the last values it read, or these
// defaults, which match the site's. AVATARSET / LIGHTS_MONTHS in .env still
// force a value, but leave them unset to follow the site.
"use strict";
var acorn = require("acorn");
var normalizeAvatarStyle = require("./avatars").normalizeAvatarStyle;

var SITE_SEASONS_REFRESH_MS = 10 * 60 * 1000;
var SITE_SEASON_DEFAULTS = {
  avatarset: "",
  avatarSeasons: [{ months: [10], style: "set2" }], // October: monsters
  lightsMonths: [12] // December
};
function fetchSiteFile(site, path) {
  var url = new URL(path, String(site).trim().replace(/\/?$/, "/"));
  url.searchParams.set("t", String(Date.now())); // skip any cached copy
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
    var left = /** @type {any} */ (expr.left); // acorn's node: an Identifier or a MemberExpression here
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

function inMonths(months, date) {
  return Array.isArray(months) && months.map(Number).indexOf(date.getMonth() + 1) !== -1;
}

/**
 * The seasons as last read from the site (refreshed every 10 minutes once started).
 * @param {Object<string, string|undefined>} env - process.env (SITE_URL, AVATARSET, LIGHTS_MONTHS)
 * @param {function(...*): void} [log]
 */
function createSiteSeasons(env, log) {
  log = log || console.log;
  var siteSeasons = JSON.parse(JSON.stringify(SITE_SEASON_DEFAULTS));
  var siteSeasonsRead = false;

  function refreshSiteSeasons() {
    if (!env.SITE_URL) {
      if (!siteSeasonsRead) log("site seasons: SITE_URL isn't set, using the defaults:", JSON.stringify(siteSeasons));
      siteSeasonsRead = true;
      return Promise.resolve();
    }
    return Promise.all([
      // An older site without js/seasons.js still works: its defaults are ours.
      fetchSiteFile(env.SITE_URL, "js/seasons.js").catch(function() { return ""; }),
      fetchSiteFile(env.SITE_URL, "config.js")
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
        log("site seasons:", JSON.stringify(next), "from", env.SITE_URL);
      }
      siteSeasons = next;
      siteSeasonsRead = true;
    }).catch(function(err) {
      log("couldn't read seasons from " + env.SITE_URL + " (keeping the last ones):", err.message);
    });
  }

  // The season's style that everyone wears, Bouletmatons too (October's
  // monsters), the way the site picks it: only while config.js has no avatarset.
  // AVATARSET in .env forces a style on cards all year.
  function forcedAvatarStyle() {
    var forced = normalizeAvatarStyle(env.AVATARSET);
    if (forced) return forced;
    if (normalizeAvatarStyle(siteSeasons.avatarset) || !Array.isArray(siteSeasons.avatarSeasons)) return null;
    var now = new Date();
    for (var i = 0; i < siteSeasons.avatarSeasons.length; i++) {
      var season = siteSeasons.avatarSeasons[i];
      if (season && inMonths(season.months, now)) return normalizeAvatarStyle(season.style);
    }
    return null;
  }

  // The months the string lights stay on by themselves.
  function currentLightsMonths() {
    if (env.LIGHTS_MONTHS) return env.LIGHTS_MONTHS.split(",").map(Number);
    return siteSeasons.lightsMonths;
  }

  function isLightsSeason(date) {
    return inMonths(currentLightsMonths(), date || new Date());
  }

  return {
    refresh: refreshSiteSeasons,
    /** Read now, then every 10 minutes. */
    start: function() {
      refreshSiteSeasons();
      setInterval(refreshSiteSeasons, SITE_SEASONS_REFRESH_MS);
    },
    /** The room-wide avatar set config.js names ("" for none). */
    avatarset: function() { return siteSeasons.avatarset; },
    forcedAvatarStyle: forcedAvatarStyle,
    lightsMonths: currentLightsMonths,
    isLightsSeason: isLightsSeason
  };
}

module.exports = { createSiteSeasons: createSiteSeasons, readPlainData: readPlainData, inMonths: inMonths, SITE_SEASON_DEFAULTS: SITE_SEASON_DEFAULTS };
