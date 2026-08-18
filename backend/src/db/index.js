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

    -- Similar artist recommendations (shown in UI for Lidarr additions)
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      artist_name TEXT NOT NULL,
      artist_mbid TEXT,
      similarity_score REAL,
      source TEXT NOT NULL DEFAULT 'lastfm', -- 'lastfm' | 'audiomuse'
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'added_to_lidarr' | 'dismissed'
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
