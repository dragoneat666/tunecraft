const fetch = require('node-fetch');
const { normalizeArtistName, alnumOnly } = require('./plex');

const LIDARR_URL = () => process.env.LIDARR_URL?.replace(/\/$/, '');
const LIDARR_API_KEY = () => process.env.LIDARR_API_KEY;

function lidarrHeaders() {
  return {
    'X-Api-Key': LIDARR_API_KEY(),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function lidarrGet(path) {
  const res = await fetch(`${LIDARR_URL()}/api/v1${path}`, {
    headers: lidarrHeaders(),
  });
  if (!res.ok) throw new Error(`Lidarr API error ${res.status}: ${path}`);
  return res.json();
}

async function lidarrPost(path, body) {
  const res = await fetch(`${LIDARR_URL()}/api/v1${path}`, {
    method: 'POST',
    headers: lidarrHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lidarr API error ${res.status}: ${text}`);
  }
  return res.json();
}

// Search for an artist in Lidarr's lookup (MusicBrainz)
async function searchArtist(artistName) {
  try {
    const results = await lidarrGet(`/artist/lookup?term=${encodeURIComponent(artistName)}`);
    return results || [];
  } catch (err) {
    console.warn(`[Lidarr] Search failed for "${artistName}":`, err.message);
    return [];
  }
}

// Get all artists already in Lidarr.
//
// This gets called on every playlist-detail and recommendations page load
// (to flag which recs are already in Lidarr), which was making those pages
// noticeably slower once that check was added — every page view meant a
// fresh round trip to Lidarr. A short in-memory cache fixes that: the
// artist list doesn't change often enough to need a live fetch every time,
// and 60 seconds of staleness here is harmless (nothing safety-critical
// depends on it being instant, and add-to-lidarr invalidates the cache
// immediately after adding, below).
let artistsCache = { data: null, expiresAt: 0 };
const ARTISTS_CACHE_TTL_MS = 60 * 1000;

async function getAllArtists() {
  if (artistsCache.data && Date.now() < artistsCache.expiresAt) {
    return artistsCache.data;
  }
  try {
    const data = await lidarrGet('/artist');
    artistsCache = { data, expiresAt: Date.now() + ARTISTS_CACHE_TTL_MS };
    return data;
  } catch (err) {
    console.warn('[Lidarr] Failed to get artists:', err.message);
    // Prefer serving stale data over nothing if Lidarr is temporarily down.
    return artistsCache.data || [];
  }
}

// Check if an artist is already in Lidarr
// Same forgiving comparison plex.js uses for its own artist lookups,
// rather than a raw toLowerCase() equality check — Lidarr's stored
// artistName (pulled from MusicBrainz) and whatever name Tunecraft is
// checking against (from Last.fm) don't always agree on formatting (a
// leading "The ", a stylized punctuation character), and a mismatch there
// meant an artist genuinely already in Lidarr could still show up with an
// active "+ Lidarr" button in the UI.
async function isArtistInLibrary(artistName) {
  const artists = await getAllArtists();
  const target = normalizeArtistName(artistName);
  const targetAlnum = alnumOnly(artistName);
  return artists.some(a => {
    if (!a.artistName) return false;
    if (normalizeArtistName(a.artistName) === target) return true;
    return targetAlnum && alnumOnly(a.artistName) === targetAlnum;
  });
}

// Add an artist to Lidarr
async function addArtist(artistName, mbid = null) {
  // First search to get the full artist object from MusicBrainz
  const results = await searchArtist(mbid ? `mbid:${mbid}` : artistName);
  if (!results.length) throw new Error(`Artist not found in MusicBrainz: ${artistName}`);

  const artist = results[0];

  // Get root folder from Lidarr config
  const rootFolders = await lidarrGet('/rootFolder');
  if (!rootFolders.length) throw new Error('No root folders configured in Lidarr');
  const rootFolderPath = rootFolders[0].path;

  // Get quality profile
  const qualityProfiles = await lidarrGet('/qualityprofile');
  if (!qualityProfiles.length) throw new Error('No quality profiles in Lidarr');
  const qualityProfileId = qualityProfiles[0].id;

  // Get metadata profile
  const metadataProfiles = await lidarrGet('/metadataprofile');
  if (!metadataProfiles.length) throw new Error('No metadata profiles in Lidarr');
  const metadataProfileId = metadataProfiles[0].id;

  const payload = {
    ...artist,
    qualityProfileId,
    metadataProfileId,
    rootFolderPath,
    monitored: true,
    albumFolder: true,
    addOptions: {
      monitor: 'all',
      searchForMissingAlbums: true,
    },
  };

  const created = await lidarrPost('/artist', payload);
  // Invalidate the cache so the next getAllArtists() call reflects this
  // add immediately instead of waiting out the TTL.
  artistsCache = { data: null, expiresAt: 0 };
  return created;
}

// Test connection
async function testConnection() {
  try {
    await lidarrGet('/system/status');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  searchArtist,
  getAllArtists,
  isArtistInLibrary,
  addArtist,
  testConnection,
};
