const fetch = require('node-fetch');

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

// Get all artists already in Lidarr
async function getAllArtists() {
  try {
    return await lidarrGet('/artist');
  } catch (err) {
    console.warn('[Lidarr] Failed to get artists:', err.message);
    return [];
  }
}

// Check if an artist is already in Lidarr
async function isArtistInLibrary(artistName) {
  const artists = await getAllArtists();
  const nameLower = artistName.toLowerCase();
  return artists.some(a => a.artistName?.toLowerCase() === nameLower);
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

  return lidarrPost('/artist', payload);
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
