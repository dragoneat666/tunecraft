const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { buildPlaylist, scanForNewRadioPlaylists, generatePlaylistName } = require('../services/playlistEngine');
const lastfm = require('../services/lastfm');
const lidarr = require('../services/lidarr');

// Fetch Lidarr's current artist list once and return a lowercase name set,
// so callers can flag recommendations that are already in Lidarr without
// making one Lidarr API call per recommendation. Lidarr being unreachable
// shouldn't break the page — just means nothing gets flagged.
async function getLidarrNameSet() {
  try {
    const artists = await lidarr.getAllArtists();
    return new Set(artists.map(a => a.artistName?.toLowerCase()).filter(Boolean));
  } catch (err) {
    console.warn('[Routes] Failed to check Lidarr library:', err.message);
    return new Set();
  }
}

// GET /api/playlists - list all managed playlists
router.get('/', (req, res) => {
  const playlists = db.prepare(`
    SELECT p.*,
      COUNT(DISTINCT ps.id) as seed_count,
      COUNT(DISTINCT pt.id) as track_count,
      COUNT(DISTINCT r.id) as recommendation_count
    FROM playlists p
    LEFT JOIN playlist_seeds ps ON ps.playlist_id = p.id
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    LEFT JOIN recommendations r ON r.playlist_id = p.id AND r.status = 'pending'
    GROUP BY p.id
    ORDER BY p.name
  `).all();
  res.json(playlists);
});

// GET /api/playlists/:id - get playlist details with seeds and recommendations
router.get('/:id', async (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const seeds = db.prepare(
    'SELECT * FROM playlist_seeds WHERE playlist_id = ? ORDER BY weight DESC, artist_name'
  ).all(req.params.id);

  const recommendations = db.prepare(`
    SELECT * FROM recommendations
    WHERE playlist_id = ? AND status = 'pending'
    ORDER BY similarity_score DESC
  `).all(req.params.id);

  // Flag which recommendations are already in Lidarr so the UI can hide
  // the "+ Lidarr" button for them instead of offering to re-add.
  const lidarrNames = await getLidarrNameSet();
  const recommendationsWithLidarrStatus = recommendations.map(r => ({
    ...r,
    in_lidarr: lidarrNames.has(r.artist_name.toLowerCase()),
  }));

  const tracks = db.prepare(`
    SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY added_at DESC
  `).all(req.params.id);

  res.json({ ...playlist, seeds, recommendations: recommendationsWithLidarrStatus, tracks });
});

// POST /api/playlists - create a new playlist
router.post('/', async (req, res) => {
  try {
    const {
      seeds, // array of { artist_name, weight? }
      genre,
      seed_type = 'artist',
      track_count = 100,
      track_pool_size = 30,
      refresh_schedule = 'weekly',
    } = req.body;

    if (!seeds?.length && !genre) {
      return res.status(400).json({ error: 'Must provide seeds or genre' });
    }

    // Generate name
    const name = generatePlaylistName(seeds || [], genre);

    // Check for duplicate name
    const existing = db.prepare('SELECT id FROM playlists WHERE name = ?').get(name);
    if (existing) return res.status(409).json({ error: 'Playlist with this name already exists' });

    // Insert playlist
    const info = db.prepare(`
      INSERT INTO playlists (name, seed_type, genre, track_count, track_pool_size, refresh_schedule)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, seed_type, genre || null, track_count, track_pool_size, refresh_schedule);

    const playlistId = info.lastInsertRowid;

    // Insert seeds
    const insertSeed = db.prepare(`
      INSERT OR IGNORE INTO playlist_seeds (playlist_id, artist_name, weight)
      VALUES (?, ?, ?)
    `);
    for (const seed of (seeds || [])) {
      insertSeed.run(playlistId, seed.artist_name, seed.weight ?? 5);
    }

    // Build immediately
    const result = await buildPlaylist(playlistId);

    res.status(201).json({
      id: playlistId,
      name,
      ...result,
    });
  } catch (err) {
    console.error('[Routes] Create playlist error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/playlists/:id - update playlist settings
router.put('/:id', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const { track_count, track_pool_size, refresh_schedule } = req.body;

  db.prepare(`
    UPDATE playlists SET
      track_count = COALESCE(?, track_count),
      track_pool_size = COALESCE(?, track_pool_size),
      refresh_schedule = COALESCE(?, refresh_schedule),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(track_count, track_pool_size, refresh_schedule, req.params.id);

  res.json(db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id));
});

// DELETE /api/playlists/:id - remove playlist (optionally from Plex too)
router.delete('/:id', async (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const { deleteFromPlex = false } = req.query;

  // This is the only route in the whole app that can delete a playlist out
  // of Plex entirely. Logging exactly what was requested, for which
  // playlist, and from where — before anything actually happens — is what
  // would let a future "why did this playlist disappear" question get
  // answered from Tunecraft's own logs instead of needing to go digging
  // through Plex's server logs after the fact.
  console.log(`[Routes] DELETE /api/playlists/${req.params.id} ("${playlist.name}", plex_playlist_key=${playlist.plex_playlist_key || 'none'}) — deleteFromPlex=${deleteFromPlex} — from ${req.ip}`);

  if (deleteFromPlex === 'true' && playlist.plex_playlist_key) {
    try {
      const plex = require('../services/plex');
      await plex.deletePlaylist(playlist.plex_playlist_key);
    } catch (err) {
      console.warn('[Routes] Failed to delete from Plex:', err.message);
    }
  }

  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/playlists/:id/rebuild - trigger immediate rebuild
router.post('/:id/rebuild', async (req, res) => {
  try {
    const result = await buildPlaylist(parseInt(req.params.id));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/playlists/scan - scan Plex for new Radio: playlists
router.post('/scan', async (req, res) => {
  try {
    const results = await scanForNewRadioPlaylists();
    res.json({ ok: true, processed: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/playlists/:id/seeds - list seeds
router.get('/:id/seeds', (req, res) => {
  const seeds = db.prepare(
    'SELECT * FROM playlist_seeds WHERE playlist_id = ? ORDER BY weight DESC, artist_name'
  ).all(req.params.id);
  res.json(seeds);
});

// POST /api/playlists/:id/seeds - add a seed artist
router.post('/:id/seeds', async (req, res) => {
  try {
    const { artist_name, weight = 5 } = req.body;
    if (!artist_name) return res.status(400).json({ error: 'artist_name required' });

    // Normalize artist name via Last.fm
    const info = await lastfm.getArtistInfo(artist_name);
    const normalizedName = info?.name || artist_name;

    db.prepare(`
      INSERT OR IGNORE INTO playlist_seeds (playlist_id, artist_name, weight)
      VALUES (?, ?, ?)
    `).run(req.params.id, normalizedName, weight);

    // Update playlist name if needed
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
    const seeds = db.prepare('SELECT * FROM playlist_seeds WHERE playlist_id = ?').all(req.params.id);
    const newName = require('../services/playlistEngine').generatePlaylistName(seeds);
    if (newName !== playlist.name) {
      db.prepare('UPDATE playlists SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(newName, req.params.id);
    }

    res.status(201).json({ ok: true, artist_name: normalizedName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/playlists/:id/seeds/:seedId - update weight
router.put('/:id/seeds/:seedId', (req, res) => {
  const { weight } = req.body;
  if (weight === undefined || weight < 0 || weight > 10) {
    return res.status(400).json({ error: 'weight must be 0-10' });
  }
  db.prepare('UPDATE playlist_seeds SET weight = ? WHERE id = ? AND playlist_id = ?')
    .run(weight, req.params.seedId, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/playlists/:id/seeds/:seedId - remove a seed
router.delete('/:id/seeds/:seedId', (req, res) => {
  db.prepare('DELETE FROM playlist_seeds WHERE id = ? AND playlist_id = ?')
    .run(req.params.seedId, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
