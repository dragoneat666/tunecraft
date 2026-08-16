const fetch = require('node-fetch');

const AUDIOMUSE_URL = () => process.env.AUDIOMUSE_URL?.replace(/\/$/, '');
const AUDIOMUSE_TOKEN = () => process.env.AUDIOMUSE_TOKEN;
const AUDIOMUSE_SERVER = () => process.env.AUDIOMUSE_SERVER_NAME || null;

function isEnabled() {
  return !!(AUDIOMUSE_URL() && AUDIOMUSE_TOKEN());
}

function audiomuseHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const token = AUDIOMUSE_TOKEN();
  if (token && token !== 'disabled') {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function audiomuseGet(path) {
  const res = await fetch(`${AUDIOMUSE_URL()}${path}`, {
    headers: audiomuseHeaders(),
  });
  if (!res.ok) throw new Error(`AudioMuse API error ${res.status}: ${path}`);
  return res.json();
}

// Build query string, optionally including server name
function buildQuery(params) {
  const server = AUDIOMUSE_SERVER();
  if (server) params.server_name = server;
  return new URLSearchParams(params).toString();
}

// Get similar tracks to a given track (by title + artist)
// Returns array of { title, artist, score }
async function getSimilarTracks(artistName, trackTitle, limit = 20) {
  if (!isEnabled()) return [];
  try {
    const query = buildQuery({ artist_name: artistName, track_name: trackTitle, limit });
    const data = await audiomuseGet(`/api/similar_tracks?${query}`);
    return (data?.results || data?.tracks || []).map(t => ({
      title: t.title || t.track_name,
      artist: t.artist || t.artist_name,
      score: t.score || t.similarity || 0,
    }));
  } catch (err) {
    console.warn(`[AudioMuse] Failed to get similar tracks for "${trackTitle}":`, err.message);
    return [];
  }
}

// Get similar artists (by artist name)
// Returns array of { name, score }
async function getSimilarArtists(artistName, limit = 20) {
  if (!isEnabled()) return [];
  try {
    const query = buildQuery({ artist_name: artistName, limit });
    const data = await audiomuseGet(`/api/similar_tracks?${query}`);
    // Deduplicate by artist name from similar tracks results
    const seen = new Set();
    const artists = [];
    for (const t of (data?.results || data?.tracks || [])) {
      const name = t.artist || t.artist_name;
      if (name && !seen.has(name.toLowerCase()) && name.toLowerCase() !== artistName.toLowerCase()) {
        seen.add(name.toLowerCase());
        artists.push({ name, score: t.score || t.similarity || 0 });
      }
    }
    return artists.slice(0, limit);
  } catch (err) {
    console.warn(`[AudioMuse] Failed to get similar artists for "${artistName}":`, err.message);
    return [];
  }
}

// Re-rank a list of tracks by sonic similarity to a seed artist
async function reRankTracks(seedArtistName, tracks) {
  if (!isEnabled() || !tracks.length) return tracks;
  try {
    const seedTrack = tracks.find(t =>
      t.artist?.toLowerCase() === seedArtistName.toLowerCase()
    );
    if (!seedTrack) return tracks;

    const similar = await getSimilarTracks(seedArtistName, seedTrack.title, 100);
    const scoreMap = new Map(
      similar.map(s => [`${s.artist?.toLowerCase()}::${s.title?.toLowerCase()}`, s.score])
    );

    const scored = tracks.map(t => ({
      ...t,
      audiomuseScore: scoreMap.get(`${t.artist?.toLowerCase()}::${t.title?.toLowerCase()}`) || 0,
    }));

    return scored.sort((a, b) => b.audiomuseScore - a.audiomuseScore);
  } catch (err) {
    console.warn('[AudioMuse] Re-ranking failed, using original order:', err.message);
    return tracks;
  }
}

// Test connection — tries a few likely paths, succeeds if any work
async function testConnection() {
  if (!isEnabled()) return { ok: false, error: 'AudioMuse not configured' };

  const candidates = ['/api/status', '/api/health', '/apidocs/'];

  for (const path of candidates) {
    try {
      const res = await fetch(`${AUDIOMUSE_URL()}${path}`, {
        headers: audiomuseHeaders(),
      });
      if (res.ok || res.status === 400 || res.status === 422) {
        return { ok: true };
      }
    } catch (err) {
      // try next
    }
  }

  return { ok: false, error: 'Could not reach AudioMuse on any known endpoint' };
}

module.exports = {
  isEnabled,
  getSimilarTracks,
  getSimilarArtists,
  reRankTracks,
  testConnection,
};
