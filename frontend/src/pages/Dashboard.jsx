import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../hooks/useApi';

export default function Dashboard() {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      setPlaylists(await api.getPlaylists());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleScan() {
    try {
      setScanning(true);
      setScanResult(null);
      const result = await api.scanPlaylists();
      setScanResult(result);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }

  if (loading) return <div className="loading">Loading playlists...</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">📻 Playlists</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={handleScan} disabled={scanning}>
            {scanning ? '⏳ Scanning...' : '🔄 Scan Plex'}
          </button>
          <Link to="/new" className="btn btn-primary">➕ New Playlist</Link>
        </div>
      </div>

      {error && <div className="alert alert-error">❌ {error}</div>}

      {scanResult && (
        <div className="alert alert-success">
          {scanResult.processed?.length
            ? `✅ Found ${scanResult.processed.length} new playlist(s): ${scanResult.processed.map(p => p.name).join(', ')}`
            : '✅ No new Radio: playlists found in Plex'
          }
        </div>
      )}

      <div className="alert" style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', fontSize: 13, color: '#888', marginBottom: 24 }}>
        💡 <strong>Tip:</strong> Create a playlist in Plex named <code>Radio: Artist Name</code> and Tunecraft will automatically build it for you.
      </div>

      {!playlists.length ? (
        <div className="empty-state">
          <div className="empty-icon">🎵</div>
          <div className="empty-title">No playlists yet</div>
          <p>Create a playlist named <strong>Radio: Artist Name</strong> in Plex, then click "Scan Plex" above. Or create one manually using the button above.</p>
        </div>
      ) : (
        <div className="grid">
          {playlists.map(p => (
            <Link key={p.id} to={`/playlists/${p.id}`} className="playlist-card">
              <div className="playlist-badge">{p.seed_type === 'genre' ? '🎭 Genre' : '🎤 Artist'}</div>
              <div className="playlist-name">{p.name}</div>
              <div className="playlist-meta">
                <span>🎵 {p.track_count} tracks</span>
                <span>🌱 {p.seed_count} seeds</span>
                {p.recommendation_count > 0 && (
                  <span style={{ color: '#e0a052' }}>💡 {p.recommendation_count} new</span>
                )}
              </div>
              {p.last_refreshed_at && (
                <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>
                  Last refreshed: {new Date(p.last_refreshed_at).toLocaleDateString()}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
