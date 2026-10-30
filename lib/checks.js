// Can a track play in the room? The same rules (and flag codes) as the site's
// playlist checker (firetable-user js/playlist.js), so a track the bot flags
// stays flagged when the site re-checks it, and the other way round.
//   2 gone or private (YouTube)      5 unavailable on SoundCloud, or only a preview
//   3 blocked in the room's country  6 can't be embedded (YouTube)
//   4 gone (SoundCloud)              7 age restricted (YouTube)
"use strict";

var ROOM_COUNTRY = "US";

/**
 * Why a YouTube video (an item from videos.list with snippet, contentDetails
 * and status) can't play here: a flag code, or 0 when it's fine.
 */
function youtubeProblem(item) {
  if (!item) return 2;
  var st = item.status || {};
  var cd = item.contentDetails || {};
  var sn = item.snippet || {};
  if (st.privacyStatus === "private" || /^(deleted|failed|rejected)$/.test(st.uploadStatus || "")) return 2;
  if (st.embeddable === false) return 6;
  var rr = cd.regionRestriction;
  if (rr && ((Array.isArray(rr.allowed) && rr.allowed.length && rr.allowed.indexOf(ROOM_COUNTRY) === -1) ||
             (Array.isArray(rr.blocked) && rr.blocked.indexOf(ROOM_COUNTRY) !== -1))) return 3;
  if (cd.contentRating && cd.contentRating.ytRating === "ytAgeRestricted") return 7;
  // a premiere or stream that hasn't started yet: nothing to play
  if (sn.liveBroadcastContent === "upcoming") return 5;
  return 0;
}

/**
 * Why a SoundCloud track (found, from either API) can't play here: a flag
 * code, or 0. Preview-only tracks (SoundCloud Go+) would play 30 seconds.
 */
function soundcloudProblem(t) {
  if (!t) return 4;
  if (t.access === "blocked" || t.policy === "BLOCK" || t.streamable === false || t.sharing === "private") return 5;
  // only a promo snippet (SoundCloud Go+): never played. Marked as a preview,
  // or snipped, or simply shorter than the full track
  if (t.access === "preview" || t.policy === "SNIP") return 5;
  if (Number(t.full_duration) > Number(t.duration) + 1000) return 5;
  return 0;
}

/** What the bot tells the DJ when it flags their track (code → message). */
function problemMessage(code, djName, link) {
  var dj = "@" + djName;
  switch (code) {
    case 3: return "Hey " + dj + ", looks like " + link + " is blocked in the " + ROOM_COUNTRY + ". Letting you play whatever is next in your queue instead.";
    case 5: return "Hey " + dj + ", " + link + " can't be played in full here (unavailable or only a preview). Letting you play whatever is next in your queue instead.";
    case 6: return "Hey " + dj + ", " + link + " can't be played outside of its own site (embedding is off). Letting you play whatever is next in your queue instead.";
    case 7: return "Hey " + dj + ", looks like " + link + " is age restricted and can't be played outside of Youtube.com. Letting you play whatever is next in your queue instead.";
    default: return dj + " you tried to play a broken song. Letting you play whatever is next in your queue instead... Clean up your queue please thanks.";
  }
}

/**
 * Does a play count as a last.fm scrobble? The track must be longer than 30
 * seconds and have played for half its length or 4 minutes, whichever comes
 * first (a song that ran to its end always counts).
 */
function scrobbles(duration, played, ranToEnd) {
  duration = Number(duration) || 0;
  if (duration <= 30) return false;
  return !!ranToEnd || played >= Math.min(duration / 2, 240);
}

module.exports = { youtubeProblem: youtubeProblem, soundcloudProblem: soundcloudProblem, problemMessage: problemMessage, scrobbles: scrobbles, ROOM_COUNTRY: ROOM_COUNTRY };
