require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');
const { startScheduler } = require('./services/scheduler');
const { startBot } = require('./services/discord');

// Validate required env vars
const required = ['PLEX_URL', 'PLEX_TOKEN', 'LASTFM_API_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[Startup] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[Startup] Please set these in your .env file');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/settings', require('./routes/settings'));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, version: '0.1.0' }));

// Serve frontend in production
const frontendDist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

async function start() {
  // Init database
  initDb();

  // Start background services
  startScheduler();

  // Start Discord bot if configured
  if (process.env.DISCORD_BOT_TOKEN) {
    startBot().catch(err => console.error('[Discord] Failed to start bot:', err.message));
  }

  app.listen(PORT, () => {
    console.log(`[Tunecraft] Server running on port ${PORT}`);
    console.log(`[Tunecraft] Plex: ${process.env.PLEX_URL}`);
    console.log(`[Tunecraft] AudioMuse: ${process.env.AUDIOMUSE_URL || 'not configured'}`);
    console.log(`[Tunecraft] Discord: ${process.env.DISCORD_BOT_TOKEN ? 'enabled' : 'disabled'}`);
  });
}

start().catch(err => {
  console.error('[Startup] Fatal error:', err);
  process.exit(1);
});
