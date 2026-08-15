const cron = require('node-cron');
const { scanForNewRadioPlaylists, refreshDuePlaylists } = require('./playlistEngine');
const { getSetting } = require('../db');

let scanJob = null;
let refreshJob = null;

function startScheduler() {
  // Scan Plex for new Radio: playlists every N minutes (default 15)
  const scanIntervalMinutes = parseInt(getSetting('plex_scan_interval_minutes') || '15');
  const scanExpression = `*/${scanIntervalMinutes} * * * *`;

  scanJob = cron.schedule(scanExpression, async () => {
    try {
      await scanForNewRadioPlaylists();
    } catch (err) {
      console.error('[Scheduler] Scan error:', err.message);
    }
  });

  // Refresh due playlists every Monday at 6am
  refreshJob = cron.schedule('0 6 * * 1', async () => {
    console.log('[Scheduler] Monday refresh starting...');
    try {
      const results = await refreshDuePlaylists();
      console.log(`[Scheduler] Monday refresh complete: ${results.length} playlists refreshed`);
    } catch (err) {
      console.error('[Scheduler] Monday refresh error:', err.message);
    }
  });

  console.log(`[Scheduler] Plex scan every ${scanIntervalMinutes} minutes, refresh every Monday at 6am`);
}

function stopScheduler() {
  if (scanJob) { scanJob.stop(); scanJob = null; }
  if (refreshJob) { refreshJob.stop(); refreshJob = null; }
}

module.exports = { startScheduler, stopScheduler };
