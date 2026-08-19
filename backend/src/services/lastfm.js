const fetch = require('node-fetch');
const { fetchWithRetry } = require('./httpRetry');

const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const API_KEY = () => process.env.LASTFM_API_KEY;

async function lastfmGet(method, params = {}) {
  const url = new URL(BASE_URL);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', API_KEY());
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetchWithRetry(url.toString(), {}, { label: `Last.fm ${method}` });
  if (!res.ok) throw new Error(`Last.fm API error ${res.status}: ${method}`);
  const data = await res.json();

  if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  return data;
}

// Get top tracks for an artist
// Returns array of { name, playcount, mbid }
async function getArtistTopTracks(artistName, limit = 30) {
  try {
    const data = await lastfmGet('artist.getTopTracks', {
      artist: artistName,
      limit,
      autocorrect: 1,
    });
    const tracks = data?.toptracks?.track || [];
    return tracks.map(t => ({
      name: t.name,
      playcount: parseInt(t.playcount) || 0,
      mbid: t.mbid || null,
      artist: t.artist?.name || artistName,
    }));
  } catch (err) {
    console.warn(`[Last.fm] Failed to get top tracks for "${artistName}":`, err.message);
    return [];
  }
}

// Get similar artists for an artist
// Returns array of { name, match (0-1 similarity score), mbid }
async function getSimilarArtists(artistName, limit = 20) {
  try {
    const data = await lastfmGet('artist.getSimilar', {
      artist: artistName,
      limit,
      autocorrect: 1,
    });
    const artists = data?.similarartists?.artist || [];
    return artists.map(a => ({
      name: a.name,
      match: parseFloat(a.match) || 0,
      mbid: a.mbid || null,
    }));
  } catch (err) {
    console.warn(`[Last.fm] Failed to get similar artists for "${artistName}":`, err.message);
    return [];
  }
}

// Get top artists for a genre/tag
async function getGenreTopArtists(genre, limit = 20) {
  try {
    const data = await lastfmGet('tag.getTopArtists', {
      tag: genre,
      limit,
    });
    const artists = data?.topartists?.artist || [];
    return artists.map(a => ({
      name: a.name,
      mbid: a.mbid || null,
      rank: parseInt(a['@attr']?.rank) || 0,
    }));
  } catch (err) {
    console.warn(`[Last.fm] Failed to get top artists for genre "${genre}":`, err.message);
    return [];
  }
}

// Get track info (playcount, duration, etc.)
async function getTrackInfo(artistName, trackName) {
  try {
    const data = await lastfmGet('track.getInfo', {
      artist: artistName,
      track: trackName,
      autocorrect: 1,
    });
    const track = data?.track;
    if (!track) return null;
    return {
      name: track.name,
      artist: track.artist?.name,
      playcount: parseInt(track.playcount) || 0,
      duration: parseInt(track.duration) || 0,
      mbid: track.mbid || null,
    };
  } catch (err) {
    return null;
  }
}

// Get artist info (to normalize artist name)
async function getArtistInfo(artistName) {
  try {
    const data = await lastfmGet('artist.getInfo', {
      artist: artistName,
      autocorrect: 1,
    });
    const artist = data?.artist;
    if (!artist) return null;
    return {
      name: artist.name,
      mbid: artist.mbid || null,
      listeners: parseInt(artist.stats?.listeners) || 0,
      playcount: parseInt(artist.stats?.playcount) || 0,
    };
  } catch (err) {
    console.warn(`[Last.fm] Failed to get artist info for "${artistName}":`, err.message);
    return null;
  }
}

// Test API key
async function testConnection() {
  try {
    await lastfmGet('chart.getTopArtists', { limit: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getArtistTopTracks,
  getSimilarArtists,
  getGenreTopArtists,
  getTrackInfo,
  getArtistInfo,
  testConnection,
};
