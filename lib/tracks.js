// Playlist tracks as they're saved. Every member's site downloads their whole
// open playlist on every visit, and the database bills every byte it sends, so
// a track keeps nothing that can be worked out from it: a YouTube track's
// thumbnail (https://i.ytimg.com/vi/<id>/...) and its watch page
// (https://www.youtube.com/watch?v=<id>) follow from its id, and everything
// that shows them builds them from the id when they're missing. Anything else
// (a SoundCloud track's artwork and page, a link with a start time) is kept.
"use strict";

var YT_THUMB = /^https?:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/([\w-]{6,64})\/[\w-]+\.(?:jpg|webp)$/i;
var YT_WATCH = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]{6,64})$/i;
var YT_SHORT = /^https?:\/\/youtu\.be\/([\w-]{6,64})$/i;

/** Is `img` just the YouTube thumbnail of video `cid`? */
function derivedImg(img, cid) {
  var m = YT_THUMB.exec(String(img || ""));
  return !!m && m[1] === String(cid);
}

/** Is `url` just the YouTube watch page of video `cid`? */
function derivedUrl(url, cid) {
  var m = YT_WATCH.exec(String(url || "")) || YT_SHORT.exec(String(url || ""));
  return !!m && m[1] === String(cid);
}

/**
 * The track without what follows from it (a copy; the original is untouched).
 * @param {object} track - {type, cid, name, img?, url?, ...}
 * @returns {object}
 */
function lean(track) {
  if (!track || typeof track !== "object") return track;
  var out = Object.assign({}, track);
  if (Number(out.type) === 1 && out.cid != null) {
    if (derivedImg(out.img, out.cid)) delete out.img;
    if (derivedUrl(out.url, out.cid)) delete out.url;
  }
  return out;
}

module.exports = { lean: lean, derivedImg: derivedImg, derivedUrl: derivedUrl };
