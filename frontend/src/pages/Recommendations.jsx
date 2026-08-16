import React, { useState, useEffect } from 'react';
import { api } from '../hooks/useApi';
import LidarrMatchPicker from '../components/LidarrMatchPicker';

export default function Recommendations() {
  const [recs, setRecs] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [pickerRec, setPickerRec] = useState(null); // rec currently being matched against MusicBrainz

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const [recsData, playlistsData] = await Promise.all([
        api.getRecommendations(),
        api.getPlaylists(),
      ]);
      setRecs(recsData);
      setPlaylists(playlistsData);
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

  async function handleAddToPlaylist(recId, playlistId) {
    try {
      await api.addRecToPlaylist(recId, { playlist_id: parseInt(playlistId) });
      setSuccess('Artist added to playlist');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleLidarrPicked(result) {
    setPickerRec(null);
    setSuccess(result.message);
    load();
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
            Artists already in your Plex library and matched closely enough get added to their playlist
            automatically — these didn't, so add them to a playlist by hand, or send them to Lidarr to get
            the music.
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
                  {playlists.length > 0 && (
                    <select
                      className="form-select"
                      style={{ width: 'auto', fontSize: 12, padding: '4px 8px' }}
                      defaultValue=""
                      onChange={e => e.target.value && handleAddToPlaylist(rec.id, e.target.value)}
                    >
                      <option value="" disabled>+ Add to playlist</option>
                      {playlists.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  )}
                  {rec.source === 'plex' ? (
                    // Already sitting in your Plex library — just below the
                    // similarity threshold to auto-add. There's nothing to
                    // fetch from Lidarr for music you already own, so only
                    // offer the manual "+ Add to playlist" dropdown above.
                    <span style={{ fontSize: 12, color: '#888' }}>Already in your library</span>
                  ) : rec.in_lidarr ? (
                    <span style={{ fontSize: 12, color: '#1db954' }}>✓ In Lidarr</span>
                  ) : (
                    <>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleAddToLidarr(rec.id)}
                      >+ Lidarr</button>
                      <button
                        className="btn btn-secondary btn-sm"
                        title="Multiple artists can share this name — pick the right MusicBrainz match before adding"
                        onClick={() => setPickerRec(rec)}
                      >🔍 Pick match</button>
                    </>
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

      {pickerRec && (
        <LidarrMatchPicker
          recId={pickerRec.id}
          artistName={pickerRec.artist_name}
          onClose={() => setPickerRec(null)}
          onAdded={handleLidarrPicked}
        />
      )}
    </div>
  );
}
