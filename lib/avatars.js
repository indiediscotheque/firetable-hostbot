// The room's avatar styles, the same six the site offers (firetable-user
// js/helpers.js AVATAR_STYLES), and a member's saved Bouletmaton
// (users/<uid>/boulet, made in the site's avatar builder, js/bouletmaton.js).
"use strict";

/**
 * The styles a supermod can pick for everyone, robot busts first (the
 * default). "bouletmaton": members' own Bouletmatons, robot busts for the
 * rest (members who switched theirs on show it whatever the style).
 */
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
 * A saved Bouletmaton (the site's js/bouletmaton.js): 19 numbers, skin tone
 * (1-4), hair colour (1-12), beard colour (1-12), then the 16 parts. The site
 * checks each part's range; this is the shape the database rules allow.
 */
var BOULET_RE = /^[1-4]\.([1-9]|1[0-2])\.([1-9]|1[0-2])(\.\d{1,2}){16}$/;
function isBoulet(v) { return typeof v === "string" && BOULET_RE.test(v); }

/** A member's Bouletmaton if they built one and switched it on (users/<uid>/boulet, bouletOn), else null. */
function activeBoulet(u) { return u && u.bouletOn === true && isBoulet(u.boulet) ? u.boulet : null; }

/**
 * How a member is drawn, the way the site draws them (its helpers.js
 * avatarURL): `forced` (October's monsters) for everyone; else their own
 * Bouletmaton when it's on; else the room's style, Bouletmaton meaning robot
 * busts for anyone without one.
 * @param {object} u - their users/<uid>
 * @param {string|null} room - the room's style (a supermod's choice, else config.js, else null)
 * @param {string|null} forced - the season's style that everyone wears, or null
 * @returns {{style: string, bm?: string}}
 */
function avatarFor(u, room, forced) {
  if (forced) return { style: forced };
  var bm = activeBoulet(u);
  if (bm) return { style: "bouletmaton", bm: bm };
  room = room || DEFAULT_STYLE;
  return { style: room === "bouletmaton" ? DEFAULT_STYLE : room };
}

module.exports = {
  STYLES: STYLES, DEFAULT_STYLE: DEFAULT_STYLE, normalizeAvatarStyle: normalizeAvatarStyle,
  BOULET_RE: BOULET_RE, isBoulet: isBoulet, activeBoulet: activeBoulet, avatarFor: avatarFor
};
