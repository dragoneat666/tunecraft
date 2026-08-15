import React, { useState, useEffect } from 'react';
import { api } from '../hooks/useApi';

function StatusBadge({ ok }) {
  if (ok === undefined) return <span style={{ color: '#888' }}>Unknown</span>;
  return ok
    ? <span style={{ color: '#1db954' }}>✅ Connected</span>
    : <span style={{ color: '#e05252' }}>❌ Error</span>;
}

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const [s, st] = await Promise.all([api.getSettings(), api.getStatus()]);
      setSettings(s);
      setStatus(st);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    try {
      setSaving(true);
      await api.updateSettings(settings);
      setSuccess('Settings saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTestAll() {
    try {
      setTesting(true);
      setStatus(await api.getStatus());
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <div className="loading">Loading settings...</div>;

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="page-header">
        <h1 className="page-title">⚙️ Settings</h1>
      </div>

      {error && <div className="alert alert-error">❌ {error}</div>}
      {success && <div className="alert alert-success">✅ {success}</div>}

      {/* Connection Status */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>Connection Status</div>
          <button className="btn btn-secondary btn-sm" onClick={handleTestAll} disabled={testing}>
            {testing ? 'Testing...' : '🔄 Test All'}
          </button>
        </div>

        {status && (
          <>
            <div className="status-row">
              <div>
                <div className="status-service">Plex</div>
                {status.plex?.serverName && (
                  <div className="status-detail">{status.plex.serverName}</div>
                )}
                {status.plex?.error && (
                  <div className="status-detail" style={{ color: '#e05252' }}>{status.plex.error}</div>
                )}
              </div>
              <StatusBadge ok={status.plex?.ok} />
            </div>
            <div className="status-row">
              <div>
                <div className="status-service">Last.fm</div>
                {status.lastfm?.error && (
                  <div className="status-detail" style={{ color: '#e05252' }}>{status.lastfm.error}</div>
                )}
              </div>
              <StatusBadge ok={status.lastfm?.ok} />
            </div>
            <div className="status-row">
              <div>
                <div className="status-service">Lidarr</div>
                {status.lidarr?.error && (
                  <div className="status-detail" style={{ color: '#e05252' }}>{status.lidarr.error}</div>
                )}
              </div>
              <StatusBadge ok={status.lidarr?.ok} />
            </div>
            <div className="status-row">
              <div>
                <div className="status-service">AudioMuse <span style={{ fontSize: 11, color: '#666' }}>(optional)</span></div>
                {!status.env?.audiomuse && (
                  <div className="status-detail">Not configured in .env</div>
                )}
                {status.audiomuse?.error && status.env?.audiomuse && (
                  <div className="status-detail" style={{ color: '#e05252' }}>{status.audiomuse.error}</div>
                )}
              </div>
              <StatusBadge ok={status.env?.audiomuse ? status.audiomuse?.ok : undefined} />
            </div>
            <div className="status-row">
              <div>
                <div className="status-service">Discord Bot <span style={{ fontSize: 11, color: '#666' }}>(optional)</span></div>
                {!status.env?.discord && (
                  <div className="status-detail">Not configured in .env</div>
                )}
              </div>
              <StatusBadge ok={status.env?.discord ? true : undefined} />
            </div>
          </>
        )}
      </div>

      {/* Environment Variables Info */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Environment Variables (.env)</div>
        <p style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
          Sensitive credentials are configured in your <code>.env</code> file, not here. Required:
        </p>
        <div style={{ fontFamily: 'monospace', fontSize: 12, background: '#0f0f0f', padding: 16, borderRadius: 8, lineHeight: 1.8 }}>
          <div style={{ color: status?.env?.plex ? '#1db954' : '#e05252' }}>
            {status?.env?.plex ? '✓' : '✗'} PLEX_URL, PLEX_TOKEN
          </div>
          <div style={{ color: status?.env?.lastfm ? '#1db954' : '#e05252' }}>
            {status?.env?.lastfm ? '✓' : '✗'} LASTFM_API_KEY
          </div>
          <div style={{ color: status?.env?.lidarr ? '#1db954' : '#888' }}>
            {status?.env?.lidarr ? '✓' : '○'} LIDARR_URL, LIDARR_API_KEY (optional)
          </div>
          <div style={{ color: status?.env?.audiomuse ? '#1db954' : '#888' }}>
            {status?.env?.audiomuse ? '✓' : '○'} AUDIOMUSE_URL, AUDIOMUSE_TOKEN (optional)
          </div>
          <div style={{ color: status?.env?.discord ? '#1db954' : '#888' }}>
            {status?.env?.discord ? '✓' : '○'} DISCORD_BOT_TOKEN, DISCORD_GUILD_ID (optional)
          </div>
        </div>
      </div>

      {/* App Config */}
      <form onSubmit={handleSave}>
        <div className="card">
          <div className="card-title">Default Settings</div>

          <div className="form-group">
            <label className="form-label">Default track count per playlist</label>
            <input type="number" min="20" max="500" className="form-input"
              value={settings.default_track_count || 100}
              onChange={e => setSettings(s => ({ ...s, default_track_count: e.target.value }))} />
          </div>

          <div className="form-group">
            <label className="form-label">Default top songs pool size per artist</label>
            <input type="number" min="5" max="100" className="form-input"
              value={settings.default_track_pool_size || 30}
              onChange={e => setSettings(s => ({ ...s, default_track_pool_size: e.target.value }))} />
          </div>

          <div className="form-group">
            <label className="form-label">Plex scan interval (minutes)</label>
            <input type="number" min="5" max="60" className="form-input"
              value={settings.plex_scan_interval_minutes || 15}
              onChange={e => setSettings(s => ({ ...s, plex_scan_interval_minutes: e.target.value }))} />
            <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
              How often to check Plex for new Radio: playlists
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>

      <div className="card">
        <div className="card-title">About Tunecraft</div>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>
          Tunecraft generates Pandora-style radio playlists in Plex using Last.fm popularity data and optional AudioMuse sonic analysis.
          Create a playlist in Plex named <code>Radio: Artist Name</code> and Tunecraft automatically builds it.
          Playlists refresh every Monday morning with newly downloaded music included.
        </p>
        <div style={{ marginTop: 12, fontSize: 12, color: '#666' }}>
          Version 0.1.0 · <a href="https://github.com/dragoneat666/tunecraft" style={{ color: '#1db954' }}>GitHub</a>
        </div>
      </div>
    </div>
  );
}
