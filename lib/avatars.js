// The room's avatar styles, the same six the site offers (firetable-user
// js/helpers.js AVATAR_STYLES), and a member's saved Bouletmaton
// (users/<uid>/boulet, made in the site's avatar builder, js/bouletmaton.js).
"use strict";

/** The styles a supermod can pick for everyone, robots first (the default). */
var STYLES = [
  "robohash:set1",      // Robohash robots
  "robohash:set2",      // Robohash monsters
  "robohash:set4",      // Robohash cats
  "dicebear:notionists",
  "dicebear:pixel-art",
  "bouletmaton"
];
var DEFAULT_STYLE = STYLES[0];

/**
 * A config or database value as one of STYLES, or null when it's empty or a
 * style the room no longer offers. A bare Robohash set ("set2") is accepted,
 * as config.js and the seasons write it.
 * @param {*} val
 * @returns {string|null}
 */
function normalizeAvatarStyle(val) {
  val = String(val == null ? "" : val).trim();
  if (!val) return null;
  if (/^set\d+$/.test(val)) val = "robohash:" + val;
  return STYLES.indexOf(val) === -1 ? null : val;
}

/**
 * A saved Bouletmaton: 18 numbers, skin tone (1-4), hair colour (1-12), then
 * the 16 parts (0 = none). The site checks each part's range; this is the
 * shape the database rules allow.
 */
var BOULET_RE = /^[1-4]\.([1-9]|1[0-2])(\.\d{1,2}){16}$/;
function isBoulet(v) { return typeof v === "string" && BOULET_RE.test(v); }

// The parts in a code, in order, as the site's js/bouletmaton.js PARTS: file
// numbers min-max, and how often a made-up one has a part you can leave off.
var PARTS = [
  { min: 1, max: 62 }, { min: 1, max: 54 }, { min: 1, max: 18 }, { min: 2, max: 17, p: 0.85 },
  { min: 1, max: 93 }, { min: 1, max: 32 }, { min: 1, max: 96 }, { min: 1, max: 42 },
  { min: 1, max: 17, p: 0.25 }, { min: 1, max: 24, p: 0.3 }, { min: 1, max: 12, p: 0.2 }, { min: 1, max: 71, p: 0.9 },
  { min: 1, max: 20, p: 0.25 }, { min: 1, max: 24, p: 0.15 }, { min: 1, max: 32, p: 0.2 }, { min: 1, max: 19, p: 0.08 }
];

function hash(s) {
  var h = 0x811c9dc5;
  s = String(s);
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function rng(seed) {
  var a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The Bouletmaton everyone has until they make their own, from their uid:
 * the site's js/bouletmaton.js random(), number for number (a test in each
 * repo checks the same uids give the same codes).
 * @param {string} seed
 * @returns {string}
 */
function randomBoulet(seed) {
  var r = rng(hash(seed));
  var nums = [1 + Math.floor(r() * 4), 1 + Math.floor(r() * 12)];
  PARTS.forEach(function(part) {
    var has = r(), which = r();
    nums.push(part.p !== undefined && has >= part.p ? 0 : part.min + Math.floor(which * (part.max - part.min + 1)));
  });
  return nums.join(".");
}

module.exports = { STYLES: STYLES, DEFAULT_STYLE: DEFAULT_STYLE, normalizeAvatarStyle: normalizeAvatarStyle, BOULET_RE: BOULET_RE, isBoulet: isBoulet, randomBoulet: randomBoulet };
