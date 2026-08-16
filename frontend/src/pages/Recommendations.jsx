import React, { useState, useEffect } from 'react';
import { api } from '../hooks/useApi';

export default function Recommendations() {
  const [recs, setRecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      setRecs(await api.getRecommendations());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddToLidarr(id) {
    try {
      const result = await api.addToLidarr(id);
      setSuccess(result.message);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDismiss(id) {
    try {
      await api.dismissRecommendation(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="loading">Loading recommendations...</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">💡 Recommendations</h1>
      </div>

      {error && <div className="alert alert-error">❌ {error}</div>}
      {success && <div className="alert alert-success">✅ {success}</div>}

      {!recs.length ? (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <div className="empty-title">No recommendations yet</div>
          <p>Build or rebuild a playlist to generate similar artist recommendations.</p>
        </div>
      ) : (
        <div>
          <p style={{ fontSize: 14, color: '#888', marginBottom: 20 }}>
            {recs.length} similar artist{recs.length !== 1 ? 's' : ''} found across your playlists.
            Artists already in your Plex library get added to their playlist automatically — these need
            Lidarr to get the music, or weren't a close enough match to auto-include.
          </p>
          <div className="card">
            {recs.map(rec => (
              <div key={rec.id} className="rec-item">
                <div className="rec-info">
                  <div className="rec-name">{rec.artist_name}</div>
                  <div className="rec-meta">
                    {rec.playlist_name} · {Math.round((rec.similarity_score || 0) * 100)}% match ·{' '}
                    {rec.source === 'plex' ? 'already in your library' : 'not in your library'}
                  </div>
                </div>
                <div className="rec-actions">
                  {rec.in_lidarr ? (
                    <span style={{ fontSize: 12, color: '#1db954' }}>✓ In Lidarr</span>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleAddToLidarr(rec.id)}
                    >+ Lidarr</button>
                  )}
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleDismiss(rec.id)}
                  >✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
