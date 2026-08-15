const express = require('express');
const router = express.Router();
const { getAllSettings, setSetting } = require('../db');
const plex = require('../services/plex');
const lastfm = require('../services/lastfm');
const lidarr = require('../services/lidarr');
const audiomuse = require('../services/audiomuse');

// GET /api/settings
router.get('/', (req, res) => {
  res.json(getAllSettings());
});

// PUT /api/settings
router.put('/', (req, res) => {
  const allowed = [
    'default_track_count',
    'default_track_pool_size',
    'default_refresh_schedule',
    'default_weight',
    'audiomuse_enabled',
    'discord_enabled',
    'plex_scan_interval_minutes',
  ];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) setSetting(key, value);
  }
  res.json(getAllSettings());
});

// GET /api/settings/status - connection status for all services
router.get('/status', async (req, res) => {
  const [plexStatus, lastfmStatus, lidarrStatus, audiomuseStatus] = await Promise.allSettled([
    plex.testConnection(),
    lastfm.testConnection(),
    lidarr.testConnection(),
    audiomuse.testConnection(),
  ]);

  res.json({
    plex: plexStatus.status === 'fulfilled' ? plexStatus.value : { ok: false, error: plexStatus.reason?.message },
    lastfm: lastfmStatus.status === 'fulfilled' ? lastfmStatus.value : { ok: false, error: lastfmStatus.reason?.message },
    lidarr: lidarrStatus.status === 'fulfilled' ? lidarrStatus.value : { ok: false, error: lidarrStatus.reason?.message },
    audiomuse: audiomuseStatus.status === 'fulfilled' ? audiomuseStatus.value : { ok: false, error: audiomuseStatus.reason?.message },
    env: {
      plex: !!(process.env.PLEX_URL && process.env.PLEX_TOKEN),
      lastfm: !!process.env.LASTFM_API_KEY,
      lidarr: !!(process.env.LIDARR_URL && process.env.LIDARR_API_KEY),
      audiomuse: !!(process.env.AUDIOMUSE_URL && process.env.AUDIOMUSE_TOKEN),
      discord: !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID),
    },
  });
});

// POST /api/settings/test/:service
router.post('/test/:service', async (req, res) => {
  try {
    let result;
    switch (req.params.service) {
      case 'plex': result = await plex.testConnection(); break;
      case 'lastfm': result = await lastfm.testConnection(); break;
      case 'lidarr': result = await lidarr.testConnection(); break;
      case 'audiomuse': result = await audiomuse.testConnection(); break;
      default: return res.status(400).json({ error: 'Unknown service' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
