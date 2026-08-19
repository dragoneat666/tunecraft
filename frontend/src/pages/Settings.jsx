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
  const [health, setHealth] = useState(null);
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
      // getHealth() is fetched alongside settings/status rather than
      // hardcoded in the JSX below (which is what this page used to do --
      // a separate "Version 0.1.0" string that had no connection to what
      // was actually running). Reading it live from the backend means this
      // page always reflects the version the server itself reports, which
      // is what makes it useful for confirming a deploy actually took.
      const [s, st, h] = await Promise.all([api.getSettings(), api.getStatus(), api.getHealth()]);
      setSettings(s);
      setStatus(st);
      setHealth(h);
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
            <label className="form-label">Default seed artist share (%)</label>
            <input type="number" min="0" max="100" className="form-input"
              value={settings.default_seed_percentage ?? 20}
              onChange={e => setSettings(s => ({ ...s, default_seed_percentage: e.target.value }))} />
            <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
              % of each playlist's tracks reserved for the seed artist(s) themselves; the rest goes to similar artists.
              Only applies to playlists created or re-adopted after this is changed — existing playlists keep whatever
              split they were built with. Override an individual playlist's split from its own page.
            </div>
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

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">How the Match Score Works</div>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6, marginBottom: 12 }}>
          Every similar-artist match you see in Recommendations or the Artists tab is built from two independent
          sources plus a genre sanity check, combined like this:
        </p>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6, marginBottom: 12 }}>
          <strong style={{ color: '#ccc' }}>Last.fm + ListenBrainz blend.</strong> Last.fm contributes a
          tag/listener-based similarity percentage; ListenBrainz contributes a session co-occurrence score,
          converted to a percentage of that seed's own strongest ListenBrainz match (raw ListenBrainz scores
          aren't otherwise comparable between artists). When both sources have an opinion on a candidate, the
          blended score is their <em>average</em> — not a sum, so two strong scores land in the middle rather
          than stacking past 100%. When only one source has data, that source is used on its own. A source
          simply not returning a result for an artist is treated as "no opinion" (shown as N/A) — never as a 0%.
        </p>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6, marginBottom: 12 }}>
          <strong style={{ color: '#ccc' }}>Multi-seed corroboration.</strong> If more than one of a playlist's
          seed artists independently turns up the same candidate, that agreement adds a bonus of +5 percentage
          points per additional agreeing seed, capped at +15 total.
        </p>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6, marginBottom: 12 }}>
          <strong style={{ color: '#ccc' }}>Genre check.</strong> On top of the blended-plus-bonus score,
          Tunecraft compares the candidate's MusicBrainz genre tags against the seeds' own tags. A shared tag
          means no penalty. No shared tag — when both sides actually had genre data to compare — applies a
          soft ×0.9 penalty (a 10% reduction, not a hard cutoff, so a strong match survives being "wrong" about
          genre once). If genre couldn't be checked at all (no MusicBrainz genre data on either side, no
          MusicBrainz match found for the candidate, or the candidate fell outside the top 30 by score — genre
          checking is capped there to keep builds from taking forever), no penalty is applied either, and the
          match line says exactly why it wasn't checked.
        </p>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>
          <strong style={{ color: '#ccc' }}>Auto-add.</strong> Artists already in your Plex library who score
          60% or higher after all of the above get added to the playlist automatically. Everything else —
          lower-scoring library matches, or good matches you don't own yet — shows up under Recommendations
          instead, where you can add them by hand or send them to Lidarr.
        </p>
      </div>

      <div className="card">
        <div className="card-title">About Tunecraft</div>
        <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>
          Tunecraft generates Pandora-style radio playlists in Plex using Last.fm popularity data and optional AudioMuse sonic analysis.
          Create a playlist in Plex named <code>Radio: Artist Name</code> and Tunecraft automatically builds it.
          Playlists refresh every Monday morning with newly downloaded music included.
        </p>
        <div style={{ marginTop: 12, fontSize: 12, color: '#666' }}>
          Version {health?.version || '(unknown)'} · <a href="https://github.com/dragoneat666/tunecraft" style={{ color: '#1db954' }}>GitHub</a>
        </div>
      </div>
    </div>
  );
}
