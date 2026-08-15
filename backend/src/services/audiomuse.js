const fetch = require('node-fetch');

const AUDIOMUSE_URL = () => process.env.AUDIOMUSE_URL?.replace(/\/$/, '');
const AUDIOMUSE_TOKEN = () => process.env.AUDIOMUSE_TOKEN;

function isEnabled() {
  return !!(AUDIOMUSE_URL() && AUDIOMUSE_TOKEN());
}

function audiomuseHeaders() {
  return {
    'Authorization': `Bearer ${AUDIOMUSE_TOKEN()}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function audiomuseGet(path) {
  const res = await fetch(`${AUDIOMUSE_URL()}${path}`, {
    headers: audiomuseHeaders(),
  });
  if (!res.ok) throw new Error(`AudioMuse API error ${res.status}: ${path}`);
  return res.json();
}

// Get similar tracks to a given track (by title + artist)
// Returns array of { title, artist, score }
async function getSimilarTracks(artistName, trackTitle, limit = 20) {
  if (!isEnabled()) return [];
  try {
    const data = await audiomuseGet(
      `/api/v1/similar/track?artist=${encodeURIComponent(artistName)}&title=${encodeURIComponent(trackTitle)}&limit=${limit}`
    );
    return (data?.results || []).map(t => ({
      title: t.title,
      artist: t.artist,
      score: t.score || 0,
    }));
  } catch (err) {
    console.warn(`[AudioMuse] Failed to get similar tracks for "${trackTitle}":`, err.message);
    return [];
  }
}

// Get similar artists (by artist name)
async function getSimilarArtists(artistName, limit = 20) {
  if (!isEnabled()) return [];
  try {
    const data = await audiomuseGet(
      `/api/v1/similar/artist?artist=${encodeURIComponent(artistName)}&limit=${limit}`
    );
    return (data?.results || []).map(a => ({
      name: a.artist,
      score: a.score || 0,
    }));
  } catch (err) {
    console.warn(`[AudioMuse] Failed to get similar artists for "${artistName}":`, err.message);
    return [];
  }
}

// Re-rank a list of tracks by sonic similarity to a seed artist
// Takes existing track list and returns them sorted by AudioMuse score
async function reRankTracks(seedArtistName, tracks) {
  if (!isEnabled() || !tracks.length) return tracks;

  try {
    // Get AudioMuse's similar tracks for the seed artist
    // Using a representative top track as the seed
    const seedTrack = tracks.find(t =>
      t.artist?.toLowerCase() === seedArtistName.toLowerCase()
    );
    if (!seedTrack) return tracks;

    const similar = await getSimilarTracks(seedArtistName, seedTrack.title, 100);
    const scoreMap = new Map(
      similar.map(s => [`${s.artist?.toLowerCase()}::${s.title?.toLowerCase()}`, s.score])
    );

    // Attach AudioMuse scores to tracks
    const scored = tracks.map(t => ({
      ...t,
      audiomuseScore: scoreMap.get(`${t.artist?.toLowerCase()}::${t.title?.toLowerCase()}`) || 0,
    }));

    // Sort by AudioMuse score descending, keeping 0-score tracks at end
    return scored.sort((a, b) => b.audiomuseScore - a.audiomuseScore);
  } catch (err) {
    console.warn('[AudioMuse] Re-ranking failed, using original order:', err.message);
    return tracks;
  }
}

// Test connection
async function testConnection() {
  if (!isEnabled()) return { ok: false, error: 'AudioMuse not configured' };
  try {
    await audiomuseGet('/api/v1/health');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isEnabled,
  getSimilarTracks,
  getSimilarArtists,
  reRankTracks,
  testConnection,
};
