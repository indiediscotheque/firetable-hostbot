// The history database: one SQLite file (Node's built-in node:sqlite) that
// every source is imported into and every result is written to. Open it with
// any SQLite browser (e.g. DB Browser for SQLite, Datasette) to dig around.
"use strict";
var fs = require("fs");
var path = require("path");
var { DatabaseSync } = require("node:sqlite");

var SCHEMA = `
-- Everything any source ever said about a song: a play, a first/last play
-- stamp, or just a tag (a playlist entry, the room's saved tags).
CREATE TABLE IF NOT EXISTS obs (
  id      INTEGER PRIMARY KEY,
  source  TEXT NOT NULL,   -- adam | lastfm:<user> | fb:globalTracks | fb:songHistory | fb:playlists | fb:playLog | ...
  ref     TEXT NOT NULL,   -- the row's id in its source (keeps re-imports from doubling up)
  artist  TEXT,
  title   TEXT,
  type    INTEGER,         -- 1 YouTube, 2 SoundCloud (when the upload is known)
  cid     TEXT,            -- the upload's id
  role    TEXT NOT NULL,   -- play | first | last | tag
  at      INTEGER,         -- ms since 1970 (UTC; see naive_tz)
  naive_tz INTEGER DEFAULT 0, -- 1: "at" was a local time with no zone (ADAM)
  dj      TEXT,            -- DJ name or id as the source gave it
  weight  REAL DEFAULT 1,  -- how much this tag counts when picking the best spelling
  extra   TEXT             -- JSON: adam ids, Last.fm mbids, ...
);
CREATE UNIQUE INDEX IF NOT EXISTS obs_source_ref ON obs(source, ref);
CREATE INDEX IF NOT EXISTS obs_upload ON obs(type, cid);

-- DJ ids -> names (Firebase uids, ADAM dj numbers)
CREATE TABLE IF NOT EXISTS dj_names (source TEXT, id TEXT, name TEXT, PRIMARY KEY (source, id));

-- Your answers to review.csv: keep these two apart, or merge them.
CREATE TABLE IF NOT EXISTS decisions (
  a TEXT NOT NULL, b TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('merge','separate')),
  note TEXT, decided_at INTEGER, PRIMARY KEY (a, b)
);

-- Answers from Last.fm lookups, so they're asked once
CREATE TABLE IF NOT EXISTS lookups (kind TEXT, query TEXT, result TEXT, fetched_at INTEGER, PRIMARY KEY (kind, query));

-- Progress of long downloads, so they pick up where they stopped
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);

-- ---------------- results (rebuilt by every reconcile) ----------------
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY, artist TEXT, title TEXT, track_key TEXT, song_key TEXT,
  track_id TEXT, seen INTEGER, plays INTEGER, scrobbles INTEGER, sources TEXT, weak INTEGER, suspect TEXT
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, song_id TEXT, artist TEXT, title TEXT, version TEXT,
  plays INTEGER, scrobbles INTEGER, djs INTEGER,
  first_play_at INTEGER, first_play_dj TEXT, first_dj TEXT, first_dj_at INTEGER,
  last_play_at INTEGER, last_play_dj TEXT,
  uploads INTEGER, spellings INTEGER, confidence REAL, keys TEXT,
  tidy_junk TEXT, tidy_rsn TEXT, protected INTEGER -- tidied tags (JSON {a, t}); 1 = a person chose these tags
);
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY, artist TEXT, title TEXT, versions INTEGER, plays INTEGER,
  first_play_at INTEGER, first_play_dj TEXT, last_play_at INTEGER, last_play_dj TEXT, keys TEXT
);
CREATE TABLE IF NOT EXISTS uploads (type INTEGER, cid TEXT, track_id TEXT, artist TEXT, title TEXT, PRIMARY KEY (type, cid));
CREATE TABLE IF NOT EXISTS plays (track_id TEXT, at INTEGER, dj TEXT, sources TEXT, type INTEGER, cid TEXT);
CREATE INDEX IF NOT EXISTS plays_track ON plays(track_id, at);
CREATE TABLE IF NOT EXISTS djs (name TEXT PRIMARY KEY, aliases TEXT, plays INTEGER, first_plays INTEGER, tracks INTEGER, first_seen INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS merges (track_id TEXT, a TEXT, b TEXT, reason TEXT, score REAL);
CREATE TABLE IF NOT EXISTS review (
  id INTEGER PRIMARY KEY, kind TEXT, a TEXT, b TEXT, a_label TEXT, b_label TEXT, score REAL, evidence TEXT
);
`;

function open(dir) {
  fs.mkdirSync(dir, { recursive: true });
  var db = new DatabaseSync(path.join(dir, "history.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -200000;");
  db.exec(SCHEMA);
  // columns added after a database was first made
  [["tracks", "tidy_junk TEXT"], ["tracks", "tidy_rsn TEXT"], ["tracks", "protected INTEGER"]].forEach(function(c) {
    try { db.exec("ALTER TABLE " + c[0] + " ADD COLUMN " + c[1]); } catch (e) { /* already there */ }
  });
  return db;
}

// Run fn inside one transaction (fast bulk writes; all or nothing).
function tx(db, fn) {
  db.exec("BEGIN");
  try {
    var out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// An "insert or replace" for obs rows, with defaults filled in.
function obsWriter(db) {
  var stmt = db.prepare(`INSERT INTO obs (source, ref, artist, title, type, cid, role, at, naive_tz, dj, weight, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, ref) DO UPDATE SET artist=excluded.artist, title=excluded.title, type=excluded.type,
      cid=excluded.cid, role=excluded.role, at=excluded.at, naive_tz=excluded.naive_tz, dj=excluded.dj,
      weight=excluded.weight, extra=excluded.extra`);
  var n = 0;
  return {
    add: function(o) {
      stmt.run(o.source, String(o.ref), str(o.artist), str(o.title), o.type == null ? null : Number(o.type) || null,
        o.cid == null || o.cid === "" ? null : String(o.cid), o.role || "tag", Number.isFinite(o.at) ? Math.round(o.at) : null,
        o.naive ? 1 : 0, str(o.dj), o.weight == null ? 1 : o.weight, o.extra ? JSON.stringify(o.extra) : null);
      n++;
    },
    count: function() { return n; }
  };
}

function str(v) {
  if (v == null) return null;
  v = String(v).trim();
  return v === "" ? null : v;
}

function getState(db, key) {
  var row = db.prepare("SELECT value FROM state WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}
function setState(db, key, value) {
  db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

module.exports = { open: open, tx: tx, obsWriter: obsWriter, getState: getState, setState: setState };
