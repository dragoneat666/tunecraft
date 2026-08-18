import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../hooks/useApi';
import LidarrMatchPicker from '../components/LidarrMatchPicker';

function WeightLabel({ weight }) {
  if (weight === 0) return <span style={{ color: '#e05252', fontSize: 12 }}>Excluded</span>;
  if (weight <= 2) return <span style={{ color: '#e0a052', fontSize: 12 }}>Low</span>;
  if (weight >= 8) return <span style={{ color: '#1db954', fontSize: 12 }}>High</span>;
  return <span style={{ color: '#888', fontSize: 12 }}>Normal</span>;
}

export default function PlaylistDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [playlist, setPlaylist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [tab, setTab] = useState('seeds');
  const [newArtist, setNewArtist] = useState('');
  const [addingArtist, setAddingArtist] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [pickerRec, setPickerRec] = useState(null); // rec currently being matched against MusicBrainz
  const [recSource, setRecSource] = useState('lastfm'); // 'lastfm' | 'listenbrainz' sub-tab under Recommendations
  const [lbData, setLbData] = useState(null); // { results, warnings } | null (not fetched yet this visit)
  const [lbLoading, setLbLoading] = useState(false);

  useEffect(() => {
    load();
    setRecSource('lastfm');
    setLbData(null);
  }, [id]);

  async function load() {
    try {
      setLoading(true);
      setPlaylist(await api.getPlaylist(id));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRebuild() {
    try {
      setRebuilding(true);
      setError(null);
      const result = await api.rebuildPlaylist(id);
      setSuccess(`Rebuilt: ${result.trackCount} tracks added`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRebuilding(false);
    }
  }

  async function handleWeightChange(seedId, weight) {
    try {
      await api.updateSeed(id, seedId, { weight: parseInt(weight) });
      setPlaylist(prev => ({
        ...prev,
        seeds: prev.seeds.map(s => s.id === seedId ? { ...s, weight: parseInt(weight) } : s),
      }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRemoveSeed(seedId) {
    if (!confirm('Remove this artist from the playlist?')) return;
    try {
      await api.removeSeed(id, seedId);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleAddArtist(e) {
    e.preventDefault();
    if (!newArtist.trim()) return;
    try {
      setAddingArtist(true);
      await api.addSeed(id, { artist_name: newArtist.trim() });
      setNewArtist('');
      setSuccess(`Added "${newArtist.trim()}" to playlist`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingArtist(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete playlist "${playlist.name}"?`)) return;
    const deleteFromPlex = confirm('Also delete from Plex?');
    try {
      await api.deletePlaylist(id, deleteFromPlex);
      navigate('/');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleAddToLidarr(recId) {
    try {
      const result = await api.addToLidarr(recId);
      setSuccess(result.message);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDismissRec(recId) {
    try {
      await api.dismissRecommendation(recId);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleAddRecToPlaylist(recId) {
    try {
      await api.addRecToPlaylist(recId, { playlist_id: parseInt(id) });
      setSuccess('Artist added to playlist seeds');
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

  // Fetches fresh ListenBrainz similar-artist data for this playlist's
  // current seeds. Only ever runs when the Refresh button below is clicked —
  // there's no auto-fetch on tab open and no persistence, same on-demand
  // pattern as Last.fm's recommendations only refreshing on Rebuild.
  async function handleFetchListenBrainz() {
    try {
      setLbLoading(true);
      setError(null);
      const data = await api.getListenBrainzSimilar(id);
      setLbData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLbLoading(false);
    }
  }

  // Distinct artists actually present in the current track list, with how
  // many tracks each one contributes. Derived from playlist.tracks rather
  // than a separate API call since that data's already fetched.
  const artistCounts = useMemo(() => {
    if (!playlist?.tracks?.length) return [];
    const counts = new Map();
    for (const t of playlist.tracks) {
      counts.set(t.artist_name, (counts.get(t.artist_name) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [playlist?.tracks]);

  if (loading) return <div className="loading">Loading...</div>;
  if (!playlist) return <div className="alert alert-error">Playlist not found</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <Link to="/" style={{ color: '#888', fontSize: 14, textDecoration: 'none' }}>← Back</Link>
          <h1 className="page-title" style={{ marginTop: 8 }}>{playlist.name}</h1>
          <div style={{ fontSize: 13, color: '#888', marginTop: 4, display: 'flex', gap: 16 }}>
            <span>🎵 {playlist.tracks?.length || 0} tracks</span>
            <span>🌱 {playlist.seeds?.length || 0} seed artists</span>
            <span>🔄 {playlist.refresh_schedule}</span>
            {playlist.last_refreshed_at && (
              <span>Last: {new Date(playlist.last_refreshed_at).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={handleRebuild} disabled={rebuilding}>
            {rebuilding ? '⏳ Rebuilding...' : '🔄 Rebuild'}
          </button>
          <button className="btn btn-danger btn-sm" onClick={handleDelete}>🗑️ Delete</button>
        </div>
      </div>

      {error && <div className="alert alert-error">❌ {error} <button onClick={() => setError(null)} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button></div>}
      {success && <div className="alert alert-success">✅ {success} <button onClick={() => setSuccess(null)} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button></div>}

      <div className="tabs">
        {['seeds', 'recommendations', 'tracks', 'artists', 'settings'].map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'seeds' && `🌱 Seeds (${playlist.seeds?.length || 0})`}
            {t === 'recommendations' && `💡 Recommendations (${playlist.recommendations?.length || 0})`}
            {t === 'tracks' && `🎵 Tracks (${playlist.tracks?.length || 0})`}
            {t === 'artists' && `🎤 Artists (${artistCounts.length})`}
            {t === 'settings' && '⚙️ Settings'}
          </button>
        ))}
      </div>

      {tab === 'seeds' && (
        <div className="card">
          <div className="card-title">Seed Artists</div>
          <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
            Adjust weights to control how many songs each artist contributes. Weight 5 is default, 10 gets 50% more songs, 1 gets 50% fewer, 0 excludes the artist.
          </p>

          {playlist.seeds?.map(seed => (
            <div key={seed.id} className="seed-item">
              <div className="seed-name">{seed.artist_name}</div>
              <div className="weight-control" style={{ width: 200 }}>
                <input
                  type="range" min="0" max="10"
                  value={seed.weight}
                  className="weight-slider"
                  onChange={e => handleWeightChange(seed.id, e.target.value)}
                />
                <span className="weight-value">{seed.weight}</span>
                <WeightLabel weight={seed.weight} />
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => handleRemoveSeed(seed.id)}
              >✕</button>
            </div>
          ))}

          <form onSubmit={handleAddArtist} style={{ marginTop: 20, display: 'flex', gap: 10 }}>
            <input
              className="form-input"
              placeholder="Add artist..."
              value={newArtist}
              onChange={e => setNewArtist(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={addingArtist || !newArtist.trim()}>
              {addingArtist ? 'Adding...' : 'Add'}
            </button>
          </form>
        </div>
      )}

      {tab === 'recommendations' && (
        <div className="card">
          <div className="card-title">Similar Artist Recommendations</div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              className={`btn btn-sm ${recSource === 'lastfm' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRecSource('lastfm')}
            >Last.fm</button>
            <button
              className={`btn btn-sm ${recSource === 'listenbrainz' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRecSource('listenbrainz')}
            >ListenBrainz</button>
          </div>

          {recSource === 'lastfm' && (
            <>
              <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
                Artists similar to your seeds that are already in your Plex library and matched closely enough
                get added to this playlist automatically. These didn't — add them as a seed to include them
                anyway, or send them to Lidarr to get the music.
              </p>
              {!playlist.recommendations?.length ? (
                <p style={{ color: '#888', fontSize: 14 }}>No recommendations yet. Rebuild the playlist to generate them.</p>
              ) : (
                playlist.recommendations.map(rec => (
                  <div key={rec.id} className="rec-item">
                    <div className="rec-info">
                      <div className="rec-name">{rec.artist_name}</div>
                      <div className="rec-meta">
                        Similarity: {Math.round((rec.similarity_score || 0) * 100)}%
                        {' · '}
                        {rec.source === 'plex' ? 'already in your library' : 'not in your library'}
                      </div>
                    </div>
                    <div className="rec-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleAddRecToPlaylist(rec.id)}
                        title="Add as seed to this playlist"
                      >+ Playlist</button>
                      {rec.source === 'plex' ? (
                        // Already sitting in your Plex library — just below the
                        // similarity threshold to auto-add. There's nothing to
                        // fetch from Lidarr for music you already own, so only
                        // offer the manual "+ Playlist" add above.
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
                        onClick={() => handleDismissRec(rec.id)}
                      >✕</button>
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {recSource === 'listenbrainz' && (
            <>
              <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
                Comparison only — nothing here gets added to the playlist, Lidarr, or Plex. Looks up each
                seed artist's similar artists via MusicBrainz + ListenBrainz on demand. Scores are raw
                co-occurrence counts, not percentages, so they aren't directly comparable to Last.fm's
                match scores above.
              </p>
              <button className="btn btn-secondary" onClick={handleFetchListenBrainz} disabled={lbLoading}>
                {lbLoading ? '⏳ Fetching...' : '🔄 Refresh ListenBrainz data'}
              </button>

              {lbData?.warnings?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {lbData.warnings.map((w, i) => (
                    <p key={i} style={{ fontSize: 12, color: '#e0a052' }}>⚠️ {w}</p>
                  ))}
                </div>
              )}

              {!lbData && !lbLoading && (
                <p style={{ color: '#888', fontSize: 14, marginTop: 12 }}>
                  Click Refresh to fetch ListenBrainz's similar artists for this playlist's seeds.
                </p>
              )}

              {lbData && !lbData.results.length && !lbData.warnings.length && (
                <p style={{ color: '#888', fontSize: 14, marginTop: 12 }}>No results.</p>
              )}

              {lbData?.results?.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  {lbData.results.map((r, i) => (
                    <div key={`${r.name}-${i}`} className="rec-item">
                      <div className="rec-info">
                        <div className="rec-name">{r.name}</div>
                        <div className="rec-meta">Score: {r.score} (raw, not a %) · via {r.viaSeed}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
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

      {tab === 'tracks' && (
        <div className="card">
          <div className="card-title">Current Tracks</div>
          {!playlist.tracks?.length ? (
            <p style={{ color: '#888', fontSize: 14 }}>No tracks yet. Rebuild the playlist to populate it.</p>
          ) : (
            <div style={{ maxHeight: 500, overflowY: 'auto' }}>
              {playlist.tracks.map((track, i) => (
                <div key={track.id} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #222' }}>
                  <span style={{ color: '#555', width: 28, flexShrink: 0, textAlign: 'right' }}>{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{track.track_title}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>{track.artist_name} · {track.album_name}</div>
                  </div>
                  {track.lastfm_playcount > 0 && (
                    <div style={{ fontSize: 12, color: '#666' }}>
                      {(track.lastfm_playcount / 1000).toFixed(0)}k plays
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'artists' && (
        <div className="card">
          <div className="card-title">Artists in This Playlist</div>
          <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
            Every artist currently contributing tracks to this playlist (seed artists plus auto-included similar artists).
          </p>
          {!artistCounts.length ? (
            <p style={{ color: '#888', fontSize: 14 }}>No tracks yet. Rebuild the playlist to populate it.</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {artistCounts.map(a => (
                <div
                  key={a.name}
                  style={{ padding: '8px 14px', background: '#1a1a1a', borderRadius: 8, fontSize: 14 }}
                >
                  <span style={{ fontWeight: 500 }}>{a.name}</span>
                  <span style={{ color: '#888', marginLeft: 8, fontSize: 12 }}>
                    {a.count} track{a.count !== 1 ? 's' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <PlaylistSettings playlist={playlist} onUpdate={load} />
      )}
    </div>
  );
}

function PlaylistSettings({ playlist, onUpdate }) {
  const [trackCount, setTrackCount] = useState(playlist.track_count);
  const [poolSize, setPoolSize] = useState(playlist.track_pool_size);
  const [schedule, setSchedule] = useState(playlist.refresh_schedule);
  // Falls back to 30 when this playlist predates the seed_percentage column
  // (NULL in the DB) -- matches the same fallback buildPlaylist itself uses,
  // so what's shown here is always what the playlist is actually building
  // with, never a misleading blank/zero.
  const [seedPercentage, setSeedPercentage] = useState(playlist.seed_percentage ?? 30);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(null);

  async function handleSave(e) {
    e.preventDefault();
    try {
      setSaving(true);
      await api.updatePlaylist(playlist.id, {
        track_count: parseInt(trackCount),
        track_pool_size: parseInt(poolSize),
        refresh_schedule: schedule,
        seed_percentage: parseInt(seedPercentage),
      });
      setSuccess('Settings saved');
      await onUpdate();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-title">Playlist Settings</div>
      {success && <div className="alert alert-success">✅ {success}</div>}
      <form onSubmit={handleSave}>
        <div className="form-group">
          <label className="form-label">Total tracks in playlist</label>
          <input type="number" min="10" max="500" className="form-input"
            value={trackCount} onChange={e => setTrackCount(e.target.value)} />
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            How many total songs the playlist will contain
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Top songs pool size per artist</label>
          <input type="number" min="5" max="100" className="form-input"
            value={poolSize} onChange={e => setPoolSize(e.target.value)} />
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            Top N songs from Last.fm to sample from per artist (songs are randomly sampled from this pool so the playlist varies on each refresh)
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Seed artist share (%)</label>
          <input type="number" min="0" max="100" className="form-input"
            value={seedPercentage} onChange={e => setSeedPercentage(e.target.value)} />
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            % of this playlist's tracks reserved for the seed artist(s) themselves; the rest goes to similar
            artists. Overrides the global default for this playlist only — change the global default under
            Settings to affect other playlists created from now on.
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Refresh schedule</label>
          <select className="form-select" value={schedule} onChange={e => setSchedule(e.target.value)}>
            <option value="weekly">Weekly (Monday morning)</option>
            <option value="manual">Manual only</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </form>
    </div>
  );
}
