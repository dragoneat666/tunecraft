const express = require('express');
const router = express.Router();
const { db } = require('../db');
const lidarr = require('../services/lidarr');

// GET /api/recommendations - all pending recommendations across playlists
router.get('/', (req, res) => {
  const recs = db.prepare(`
    SELECT r.*, p.name as playlist_name
    FROM recommendations r
    JOIN playlists p ON p.id = r.playlist_id
    WHERE r.status = 'pending'
    ORDER BY r.similarity_score DESC
  `).all();
  res.json(recs);
});

// POST /api/recommendations/:id/add-to-lidarr
router.post('/:id/add-to-lidarr', async (req, res) => {
  const rec = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found' });

  try {
    // Check if already in Lidarr
    const inLibrary = await lidarr.isArtistInLibrary(rec.artist_name);
    if (inLibrary) {
      db.prepare(`
        UPDATE recommendations SET status = 'added_to_lidarr', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(req.params.id);
      return res.json({ ok: true, message: `${rec.artist_name} is already in Lidarr` });
    }

    await lidarr.addArtist(rec.artist_name, rec.artist_mbid);

    db.prepare(`
      UPDATE recommendations SET status = 'added_to_lidarr', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);

    res.json({ ok: true, message: `${rec.artist_name} added to Lidarr` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recommendations/:id/dismiss
router.post('/:id/dismiss', (req, res) => {
  db.prepare(`
    UPDATE recommendations SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);
  res.json({ ok: true });
});

// POST /api/recommendations/:id/add-to-playlist - add as seed to a playlist
router.post('/:id/add-to-playlist', async (req, res) => {
  const rec = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found' });

  const { playlist_id, weight = 5 } = req.body;
  if (!playlist_id) return res.status(400).json({ error: 'playlist_id required' });

  try {
    db.prepare(`
      INSERT OR IGNORE INTO playlist_seeds (playlist_id, artist_name, weight)
      VALUES (?, ?, ?)
    `).run(playlist_id, rec.artist_name, weight);

    db.prepare(`
      UPDATE recommendations SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
