import React, { useState, useEffect } from 'react';
import { api } from '../hooks/useApi';

// Modal for picking exactly which MusicBrainz artist to add to Lidarr.
//
// Why this exists: Lidarr's "add artist" flow searches MusicBrainz by name,
// and name searches are ambiguous — a common or short artist name (e.g.
// "Dorothy") can match several unrelated MusicBrainz entries, some with no
// releases at all. The one-click "+ Lidarr" button picks whichever match
// Last.fm's stored mbid points to, or failing that just the first search
// result, which is sometimes wrong. This picker shows every candidate so
// the user can check each one (via the MusicBrainz link, which shows its
// actual discography) before committing, instead of finding out after the
// fact that Lidarr added an artist with no albums.
export default function LidarrMatchPicker({ recId, artistName, onClose, onAdded }) {
  const [candidates, setCandidates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [addingId, setAddingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const result = await api.getLidarrCandidates(recId);
        if (!cancelled) setCandidates(result.candidates || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [recId]);

  async function handlePick(candidate) {
    const mbid = candidate.foreignArtistId || candidate.mbid;
    if (!mbid) {
      setError('This match is missing a MusicBrainz ID and can\'t be added.');
      return;
    }
    try {
      setAddingId(mbid);
      const result = await api.addToLidarr(recId, mbid);
      onAdded(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="card"
        style={{ width: 520, maxHeight: '80vh', overflowY: 'auto', margin: 0 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>Pick the right "{artistName}"</div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >✕</button>
        </div>
        <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
          Multiple MusicBrainz artists can share a name. Check the MusicBrainz link for each candidate
          (it shows their actual discography) before adding — that's the best way to confirm you're
          getting the right one and not an empty duplicate.
        </p>

        {loading && <p style={{ color: '#888', fontSize: 14 }}>Searching MusicBrainz...</p>}
        {error && <div className="alert alert-error">❌ {error}</div>}

        {!loading && candidates && !candidates.length && (
          <p style={{ color: '#888', fontSize: 14 }}>No MusicBrainz matches found for "{artistName}".</p>
        )}

        {!loading && candidates && candidates.length > 0 && (
          <div>
            {candidates.map((c, i) => {
              const mbid = c.foreignArtistId || c.mbid;
              const overview = (c.overview || '').trim();
              return (
                <div
                  key={mbid || i}
                  style={{
                    padding: '12px 0',
                    borderBottom: i < candidates.length - 1 ? '1px solid #2a2a2a' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {c.artistName}
                        {c.disambiguation && (
                          <span style={{ color: '#888', fontWeight: 400 }}> — {c.disambiguation}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                        {[c.artistType, c.status, c.genres?.length ? c.genres.slice(0, 3).join(', ') : null]
                          .filter(Boolean).join(' · ') || 'No extra metadata'}
                      </div>
                      {overview && (
                        <div style={{ fontSize: 12, color: '#888', marginTop: 6, maxHeight: 54, overflow: 'hidden' }}>
                          {overview.length > 200 ? overview.slice(0, 200) + '…' : overview}
                        </div>
                      )}
                      {mbid && (
                        <a
                          href={`https://musicbrainz.org/artist/${mbid}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 12, color: '#1db954', display: 'inline-block', marginTop: 6 }}
                        >
                          View on MusicBrainz (check albums) ↗
                        </a>
                      )}
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      style={{ flexShrink: 0 }}
                      disabled={!mbid || addingId === mbid}
                      onClick={() => handlePick(c)}
                    >
                      {addingId === mbid ? 'Adding...' : 'Add this one'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
