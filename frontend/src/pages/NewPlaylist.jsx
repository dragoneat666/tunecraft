import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../hooks/useApi';

export default function NewPlaylist() {
  const navigate = useNavigate();
  const [seedType, setSeedType] = useState('artist');
  const [genre, setGenre] = useState('');
  const [artistInput, setArtistInput] = useState('');
  const [seeds, setSeeds] = useState([]); // { artist_name, weight }
  const [trackCount, setTrackCount] = useState(100);
  const [poolSize, setPoolSize] = useState(30);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  function addArtist() {
    const name = artistInput.trim();
    if (!name || seeds.find(s => s.artist_name.toLowerCase() === name.toLowerCase())) return;
    setSeeds(prev => [...prev, { artist_name: name, weight: 5 }]);
    setArtistInput('');
  }

  function removeArtist(name) {
    setSeeds(prev => prev.filter(s => s.artist_name !== name));
  }

  function updateWeight(name, weight) {
    setSeeds(prev => prev.map(s => s.artist_name === name ? { ...s, weight: parseInt(weight) } : s));
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (seedType === 'artist' && !seeds.length) {
      return setError('Add at least one artist');
    }
    if (seedType === 'genre' && !genre.trim()) {
      return setError('Enter a genre');
    }
    try {
      setCreating(true);
      setError(null);
      const playlist = await api.createPlaylist({
        seed_type: seedType,
        seeds: seedType === 'artist' ? seeds : [],
        genre: seedType === 'genre' ? genre.trim() : null,
        track_count: parseInt(trackCount),
        track_pool_size: parseInt(poolSize),
      });
      navigate(`/playlists/${playlist.id}`);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  }

  const previewName = seedType === 'genre'
    ? (genre ? `Radio: ${genre}` : 'Radio: ...')
    : seeds.length === 0 ? 'Radio: ...'
    : seeds.length === 1 ? `Radio: ${seeds[0].artist_name}`
    : `Radio: ${seeds[0].artist_name} and ${seeds[1].artist_name}${seeds.length > 2 ? ` (+${seeds.length - 2} more)` : ''}`;

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="page-header">
        <div>
          <Link to="/" style={{ color: '#888', fontSize: 14, textDecoration: 'none' }}>← Back</Link>
          <h1 className="page-title" style={{ marginTop: 8 }}>➕ New Playlist</h1>
        </div>
      </div>

      {error && <div className="alert alert-error">❌ {error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: '#888' }}>Preview name:</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#1db954', marginTop: 4 }}>{previewName}</div>
      </div>

      <form onSubmit={handleCreate}>
        <div className="card">
          <div className="card-title">Playlist Type</div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <button
              type="button"
              className={`btn ${seedType === 'artist' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSeedType('artist')}
            >🎤 Artist-based</button>
            <button
              type="button"
              className={`btn ${seedType === 'genre' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSeedType('genre')}
            >🎭 Genre-based</button>
          </div>

          {seedType === 'artist' && (
            <>
              <div className="form-group">
                <label className="form-label">Add seed artists</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input
                    className="form-input"
                    placeholder="Artist name..."
                    value={artistInput}
                    onChange={e => setArtistInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addArtist())}
                  />
                  <button type="button" className="btn btn-secondary" onClick={addArtist}>Add</button>
                </div>
              </div>

              {seeds.length > 0 && (
                <div>
                  <div className="section-title">Artists & Weights</div>
                  <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
                    Adjust weights: 5 = default, 10 = 50% more songs, 1 = 50% fewer, 0 = exclude
                  </p>
                  {seeds.map(seed => (
                    <div key={seed.artist_name} className="seed-item">
                      <div className="seed-name">{seed.artist_name}</div>
                      <div className="weight-control" style={{ width: 200 }}>
                        <input
                          type="range" min="0" max="10"
                          value={seed.weight}
                          className="weight-slider"
                          onChange={e => updateWeight(seed.artist_name, e.target.value)}
                        />
                        <span className="weight-value">{seed.weight}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => removeArtist(seed.artist_name)}
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {seedType === 'genre' && (
            <div className="form-group">
              <label className="form-label">Genre</label>
              <input
                className="form-input"
                placeholder="e.g. Metal, Rock, Hip-Hop..."
                value={genre}
                onChange={e => setGenre(e.target.value)}
              />
              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                Uses Last.fm's genre tags to find top artists in this genre
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">Settings</div>
          <div className="form-group">
            <label className="form-label">Total tracks: {trackCount}</label>
            <input type="range" min="20" max="300" step="10"
              value={trackCount} onChange={e => setTrackCount(e.target.value)}
              className="weight-slider" style={{ width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#666' }}>
              <span>20</span><span>300</span>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Top songs pool per artist: {poolSize}</label>
            <input type="range" min="10" max="100" step="5"
              value={poolSize} onChange={e => setPoolSize(e.target.value)}
              className="weight-slider" style={{ width: '100%' }} />
            <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
              Last.fm top {poolSize} songs are fetched per artist; tracks are randomly sampled from this pool each refresh
            </div>
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={creating || (seedType === 'artist' && !seeds.length) || (seedType === 'genre' && !genre.trim())}
          style={{ width: '100%', justifyContent: 'center', padding: 14 }}
        >
          {creating ? '⏳ Building playlist...' : '🎵 Create Playlist'}
        </button>
      </form>
    </div>
  );
}
