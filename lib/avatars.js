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

module.exports = { STYLES: STYLES, DEFAULT_STYLE: DEFAULT_STYLE, normalizeAvatarStyle: normalizeAvatarStyle, BOULET_RE: BOULET_RE, isBoulet: isBoulet };
