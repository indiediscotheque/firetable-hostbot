// YouTube Music search answers in the shape music.youtube.com sends them
// (trimmed to the parts lib/ytmusic.js reads), for the unit and bot tests.
"use strict";

const artistRun = (name) => ({ text: name, navigationEndpoint: { browseEndpoint: { browseId: "UC" + name.length,
  browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } });
const albumRun = (name) => ({ text: name, navigationEndpoint: { browseEndpoint: { browseId: "MPRE" + name.length,
  browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } } } } });
const dot = { text: " • " };
const time = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");

/**
 * One result row. kind: ATV (song), OMV (official video / "Official Audio"),
 * UGC (anyone's upload). label: "Song"/"Video" first, as the unfiltered search shows.
 */
function row({ cid, title, artists, album, dur, kind = "ATV", label, explicit }) {
  const sub = [];
  if (label) sub.push({ text: label }, dot);
  artists.forEach((a, i) => { if (i) sub.push({ text: " & " }); sub.push(artistRun(a)); });
  if (album) sub.push(dot, albumRun(album));
  if (dur) sub.push(dot, { text: time(dur) });
  const r = {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title, navigationEndpoint: { watchEndpoint: { videoId: cid,
          watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_" + kind } } } } }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: sub } } }
      ],
      playlistItemData: { videoId: cid }
    }
  };
  if (explicit) r.musicResponsiveListItemRenderer.badges = [{ musicInlineBadgeRenderer: { icon: { iconType: "MUSIC_EXPLICIT_BADGE" } } }];
  return r;
}

/** A whole search answer with these rows in one shelf. */
function answer(rows) {
  return {
    responseContext: { visitorData: "Cgt2aXNpdG9y" },
    contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: rows.length
      ? [{ musicShelfRenderer: { contents: rows.map(row) } }]
      : [{ itemSectionRenderer: { contents: [{ messageRenderer: { text: { runs: [{ text: "No results" }] } } }] } }] } } } }] } }
  };
}

module.exports = { row, answer };
