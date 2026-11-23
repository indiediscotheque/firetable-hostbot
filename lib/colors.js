// The room's accent colour from a track's artwork. Built from node-vibrant's
// parts (the same setup as "node-vibrant/node"): the bot's auto-update checks
// each dependency loads with a plain require(), which node-vibrant 4 itself
// doesn't allow.
"use strict";
var core = require("@vibrant/core");
var NodeImage = require("@vibrant/image-node").NodeImage;
var MMCQ = require("@vibrant/quantizer-mmcq").MMCQ;
var DefaultGenerator = require("@vibrant/generator-default").DefaultGenerator;
var http = require("./http").http;

var Vibrant = core.Vibrant;
Vibrant.DefaultOpts.ImageClass = NodeImage;
Vibrant.DefaultOpts.quantizer = "mmcq";
Vibrant.DefaultOpts.generators = ["default"];
Vibrant.DefaultOpts.filters = ["default"];
Vibrant.use(new core.BasicPipeline()
  .filter.register("default", function(r, g, b, a) {
    return a >= 125 && !(r > 250 && g > 250 && b > 250);
  })
  .quantizer.register("mmcq", MMCQ)
  .generator.register("default", DefaultGenerator));

var MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// The answers for the last few hundred images, kept a day: a song played
// again (or its artwork shared by an album) isn't downloaded and decoded
// again. Images that couldn't be read aren't kept, so they're tried again.
var CACHE_MAX = 500;
var CACHE_MS = 24 * 60 * 60 * 1000;
var cache = new Map(); // url -> {found, at}

var copyOf = function(found) { return found ? { color: found.color, txt: found.txt } : null; };

/**
 * The artwork's vibrant colour and a readable text colour for it.
 * @param {string} imageUrl
 * @returns {Promise<{color: string, txt: string}|null>} null when the image
 *   has no vibrant colour; rejects when it can't be downloaded or read
 */
function artworkColors(imageUrl) {
  var hit = cache.get(imageUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(copyOf(hit.found));
  if (hit) cache.delete(imageUrl);
  return http(imageUrl, { binary: true, maxBytes: MAX_IMAGE_BYTES }).then(function(res) {
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    var type = String(res.headers.get("content-type") || "");
    if (!/^image\//i.test(type)) throw new Error("not an image (" + (type || "no type") + ")");
    return Vibrant.from(res.body).getPalette();
  }).then(function(palette) {
    var main = palette && palette.Vibrant;
    var found = main ? { color: main.hex, txt: main.bodyTextColor } : null;
    cache.delete(imageUrl);
    cache.set(imageUrl, { found: found, at: Date.now() });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // the oldest
    return copyOf(found);
  });
}

module.exports = { artworkColors: artworkColors };
