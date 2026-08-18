require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');
const { startScheduler } = require('./services/scheduler');
const { startBot } = require('./services/discord');
// Single source of truth for the running version: backend/package.json.
// Reading it here (instead of a hardcoded string, which is what this used
// to be, and which frontend/src/pages/Settings.jsx separately hardcoded
// AGAIN as its own copy) means bumping the version in exactly one place --
// package.json -- on every push is enough to make /api/health, and the
// Settings page that reads it, reflect what's actually running. This is
// what "did the new image actually deploy" should have been checkable
// with, well before it took a container-exec grep to find out for sure.
const { version: APP_VERSION } = require('../package.json');

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

// Log every incoming API request (method, path, source IP). Tunecraft had no
// request-level logging at all before this — only the business-logic
// [Engine]/[Plex]/[Lidarr] lines further down the stack — which made it
// impossible to tell whether something unexpected (a stray API call, a
// mutation nobody remembers triggering) came from the web UI, a script, or
// somewhere else entirely. This is intentionally just method/path/IP, not
// headers or bodies, to stay useful without becoming noise.
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl} from ${req.ip}`);
  next();
});

// API routes
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/settings', require('./routes/settings'));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, version: APP_VERSION }));

// Serve frontend in production
const frontendDist = path.join(__dirname, '../frontend/dist');
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
    console.log(`[Tunecraft] Server running on port ${PORT} (version ${APP_VERSION})`);
    console.log(`[Tunecraft] Plex: ${process.env.PLEX_URL}`);
    console.log(`[Tunecraft] AudioMuse: ${process.env.AUDIOMUSE_URL || 'not configured'}`);
    console.log(`[Tunecraft] Discord: ${process.env.DISCORD_BOT_TOKEN ? 'enabled' : 'disabled'}`);
  });
}

start().catch(err => {
  console.error('[Startup] Fatal error:', err);
  process.exit(1);
});
