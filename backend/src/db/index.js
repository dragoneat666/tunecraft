const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/tunecraft.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    -- App settings (non-sensitive config)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Managed playlists
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      plex_playlist_id TEXT,
      plex_playlist_key TEXT,
      seed_type TEXT NOT NULL DEFAULT 'artist', -- 'artist' | 'genre'
      genre TEXT,
      track_count INTEGER NOT NULL DEFAULT 100,
      track_pool_size INTEGER NOT NULL DEFAULT 30,
      refresh_schedule TEXT NOT NULL DEFAULT 'weekly',
      last_refreshed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Seed artists per playlist
    CREATE TABLE IF NOT EXISTS playlist_seeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      artist_name TEXT NOT NULL,
      artist_mbid TEXT,
      lastfm_name TEXT,
      weight INTEGER NOT NULL DEFAULT 5, -- 0-10, 5 is neutral
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, artist_name)
    );

    -- Similar artist recommendations (shown in UI for Lidarr additions).
    -- The lastfm_pct/lb_pct/corroboration_bonus/corroborating_seeds/
    -- genre_checked/genre_matched/via_seeds columns hold the combined-score
    -- breakdown (see services/similarityRanking.js) so the UI can show a
    -- friendly "why is this the score it is" line -- added via the manual
    -- ALTER TABLE migration below for databases that predate them, left NULL
    -- on existing rows (same pattern as playlists.seed_percentage).
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      artist_name TEXT NOT NULL,
      artist_mbid TEXT,
      similarity_score REAL,
      source TEXT NOT NULL DEFAULT 'lastfm', -- 'combined' | 'plex' | 'audiomuse' (older rows may say 'lastfm')
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'added_to_lidarr' | 'dismissed'
      lastfm_pct REAL,
      lb_pct REAL,
      corroboration_bonus REAL DEFAULT 0,
      corroborating_seeds INTEGER DEFAULT 0,
      genre_checked INTEGER DEFAULT 0,
      genre_matched INTEGER,
      genre_skip_reason TEXT, -- why genre_checked=0: 'below_cap' | 'no_mbid' | 'no_candidate_genre_data' | 'no_seed_genre_data'
      via_seeds TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, artist_name)
    );

    -- Track history (which tracks were included in last refresh)
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      plex_rating_key TEXT NOT NULL,
      track_title TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      album_name TEXT,
      duration_ms INTEGER,
      lastfm_playcount INTEGER,
      audiomuse_score REAL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Why each artist CURRENTLY contributing tracks to a playlist is there --
    -- rewritten from scratch on every buildPlaylist() call, unlike
    -- recommendations (which intentionally drops an artist's row once it's
    -- auto-included, since it's no longer "just a suggestion"). Drives the
    -- Artists tab's match-breakdown column. is_seed=1 rows are seed artists
    -- (no similarity breakdown -- they're the source, not a match); is_seed=0
    -- rows are similar artists that were auto-added, with the same breakdown
    -- shape as recommendations above.
    CREATE TABLE IF NOT EXISTS playlist_artist_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      artist_name TEXT NOT NULL,
      is_seed INTEGER NOT NULL DEFAULT 0,
      similarity_score REAL,
      lastfm_pct REAL,
      lb_pct REAL,
      corroboration_bonus REAL DEFAULT 0,
      corroborating_seeds INTEGER DEFAULT 0,
      genre_checked INTEGER DEFAULT 0,
      genre_matched INTEGER,
      genre_skip_reason TEXT,
      via_seeds TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, artist_name)
    );

    -- Artists banned from a specific playlist (via the Artists tab's ban
    -- button). Checked by buildPlaylist to exclude them from future
    -- auto-add/recommendation; does NOT retroactively touch Plex on its own
    -- -- takes effect passively on the playlist's next rebuild (manual or
    -- weekly), never an immediate Plex write from the ban click itself.
    CREATE TABLE IF NOT EXISTS playlist_banned_artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      artist_name TEXT NOT NULL,
      banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, artist_name)
    );

    -- Insert default settings if not present
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('default_track_count', '100'),
      ('default_track_pool_size', '30'),
      ('default_refresh_schedule', 'weekly'),
      ('default_weight', '5'),
      ('default_seed_percentage', '20'),
      ('audiomuse_enabled', 'false'),
      ('discord_enabled', 'false'),
      ('plex_scan_interval_minutes', '15');
  `);

  // Migration: add playlists.seed_percentage to databases created before
  // this column existed. CREATE TABLE IF NOT EXISTS above only applies to
  // brand new databases -- an existing playlists table needs the column
  // added explicitly, and SQLite has no "ADD COLUMN IF NOT EXISTS", hence
  // the manual check. Deliberately left NULL (not backfilled to the new
  // default_seed_percentage) for every playlist that already exists: NULL
  // is treated by buildPlaylist as "use the pre-this-feature 30% split" so
  // existing playlists keep behaving exactly as they did before. Only
  // playlists inserted AFTER this migration (new ones, and ones adopted
  // fresh after being deleted+recreated in Plex) get a real value written
  // at insert time, snapshotting whatever default_seed_percentage was set
  // to at that moment.
  const playlistColumns = db.prepare('PRAGMA table_info(playlists)').all();
  if (!playlistColumns.some(c => c.name === 'seed_percentage')) {
    db.exec('ALTER TABLE playlists ADD COLUMN seed_percentage INTEGER');
    console.log('[DB] Migrated: added playlists.seed_percentage column');
  }

  // Migration: add the combined-score breakdown columns to recommendations
  // for databases created before this feature existed. Same reasoning as
  // seed_percentage above -- CREATE TABLE IF NOT EXISTS only helps brand new
  // databases, an existing recommendations table needs each column added by
  // hand. Left NULL/0 on every row that already exists; those rows just show
  // a plainer match line in the UI (no last.fm/ListenBrainz/bonus/genre
  // breakdown) until the playlist's next rebuild fills them in.
  const recommendationColumns = db.prepare('PRAGMA table_info(recommendations)').all();
  const addRecommendationColumn = (name, ddl) => {
    if (!recommendationColumns.some(c => c.name === name)) {
      db.exec(`ALTER TABLE recommendations ADD COLUMN ${ddl}`);
      console.log(`[DB] Migrated: added recommendations.${name} column`);
    }
  };
  addRecommendationColumn('lastfm_pct', 'lastfm_pct REAL');
  addRecommendationColumn('lb_pct', 'lb_pct REAL');
  addRecommendationColumn('corroboration_bonus', 'corroboration_bonus REAL DEFAULT 0');
  addRecommendationColumn('corroborating_seeds', 'corroborating_seeds INTEGER DEFAULT 0');
  addRecommendationColumn('genre_checked', 'genre_checked INTEGER DEFAULT 0');
  addRecommendationColumn('genre_matched', 'genre_matched INTEGER');
  addRecommendationColumn('genre_skip_reason', 'genre_skip_reason TEXT');
  addRecommendationColumn('via_seeds', 'via_seeds TEXT');

  // Migration: add genre_skip_reason to playlist_artist_stats. This table
  // itself is new enough (shipped alongside the columns above) that it
  // didn't need a migration at first -- CREATE TABLE IF NOT EXISTS handled
  // it for everyone on that update. But that means databases that already
  // ran that migration now have a playlist_artist_stats table missing this
  // one later column, same situation as recommendations above, so it needs
  // the exact same manual ALTER TABLE treatment.
  const artistStatsColumns = db.prepare('PRAGMA table_info(playlist_artist_stats)').all();
  if (!artistStatsColumns.some(c => c.name === 'genre_skip_reason')) {
    db.exec('ALTER TABLE playlist_artist_stats ADD COLUMN genre_skip_reason TEXT');
    console.log('[DB] Migrated: added playlist_artist_stats.genre_skip_reason column');
  }

  console.log('[DB] Database initialized');
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

module.exports = { db, initDb, getSetting, setSetting, getAllSettings };
