const fetch = require('node-fetch');

const PLEX_URL = () => process.env.PLEX_URL?.replace(/\/$/, '');
const PLEX_TOKEN = () => process.env.PLEX_TOKEN;

function plexHeaders() {
  return {
    'X-Plex-Token': PLEX_TOKEN(),
    'Accept': 'application/json',
    'X-Plex-Client-Identifier': 'tunecraft',
    'X-Plex-Product': 'Tunecraft',
    'X-Plex-Version': '0.1.0',
  };
}

async function plexGet(path) {
  const url = `${PLEX_URL()}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${PLEX_TOKEN()}`;
  const res = await fetch(url, { headers: plexHeaders() });
  if (!res.ok) throw new Error(`Plex API error ${res.status}: ${path}`);
  return res.json();
}

async function plexPost(path, body = null) {
  const url = `${PLEX_URL()}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${PLEX_TOKEN()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...plexHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) throw new Error(`Plex API error ${res.status}: ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function plexPut(path, body = null) {
  const url = `${PLEX_URL()}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${PLEX_TOKEN()}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...plexHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) throw new Error(`Plex API error ${res.status}: ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function plexDelete(path) {
  const url = `${PLEX_URL()}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${PLEX_TOKEN()}`;
  const res = await fetch(url, { method: 'DELETE', headers: plexHeaders() });
  if (!res.ok) throw new Error(`Plex API error ${res.status}: ${path}`);
}

// Get all music libraries
async function getMusicLibraries() {
  const data = await plexGet('/library/sections');
  const sections = data?.MediaContainer?.Directory || [];
  return sections.filter(s => s.type === 'artist');
}

// Search for tracks by artist name in Plex library
async function searchTracksByArtist(artistName) {
  const libraries = await getMusicLibraries();
  const tracks = [];

  for (const lib of libraries) {
    try {
      const encoded = encodeURIComponent(artistName);
      const data = await plexGet(
        `/library/sections/${lib.key}/search?query=${encoded}&type=10`
      );
      const items = data?.MediaContainer?.Metadata || [];
      tracks.push(...items);
    } catch (err) {
      console.warn(`[Plex] Search failed in library ${lib.key}:`, err.message);
    }
  }

  return tracks;
}

// Search for a specific track by artist + title
async function searchTrack(artistName, trackTitle) {
  const tracks = await searchTracksByArtist(artistName);
  const titleLower = trackTitle.toLowerCase();
  return tracks.find(t =>
    t.title?.toLowerCase().includes(titleLower) ||
    titleLower.includes(t.title?.toLowerCase())
  ) || null;
}

// Get all playlists from Plex
async function getAllPlaylists() {
  const data = await plexGet('/playlists?playlistType=audio');
  return data?.MediaContainer?.Metadata || [];
}

// Get playlists matching Radio: pattern
async function getRadioPlaylists() {
  const all = await getAllPlaylists();
  return all.filter(p => p.title?.startsWith('Radio:'));
}

// Get items in a playlist
async function getPlaylistItems(playlistKey) {
  const data = await plexGet(`${playlistKey}/items`);
  return data?.MediaContainer?.Metadata || [];
}

// Get machine identifier for server
async function getMachineId() {
  const data = await plexGet('/');
  return data?.MediaContainer?.machineIdentifier;
}

// Create a new playlist in Plex
async function createPlaylist(title, trackRatingKeys) {
  const machineId = await getMachineId();
  const uri = `server://${machineId}/com.plexapp.plugins.library`;
  const items = trackRatingKeys.map(k => `${uri}/library/metadata/${k}`).join(',');

  const data = await plexPost(
    `/playlists?type=audio&title=${encodeURIComponent(title)}&smart=0&uri=${encodeURIComponent(items)}`
  );
  return data?.MediaContainer?.Metadata?.[0] || null;
}

// Replace all items in an existing playlist
async function updatePlaylistItems(playlistKey, trackRatingKeys) {
  const machineId = await getMachineId();
  const uri = `server://${machineId}/com.plexapp.plugins.library`;
  const items = trackRatingKeys.map(k => `${uri}/library/metadata/${k}`).join(',');

  // Clear existing items
  await plexDelete(`${playlistKey}/items`);

  // Add new items
  await plexPut(`${playlistKey}/items?uri=${encodeURIComponent(items)}`);
}

// Delete a playlist
async function deletePlaylist(playlistKey) {
  await plexDelete(playlistKey);
}

// Test connection
async function testConnection() {
  try {
    const data = await plexGet('/');
    return {
      ok: true,
      serverName: data?.MediaContainer?.friendlyName,
      version: data?.MediaContainer?.version,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getMusicLibraries,
  searchTracksByArtist,
  searchTrack,
  getAllPlaylists,
  getRadioPlaylists,
  getPlaylistItems,
  createPlaylist,
  updatePlaylistItems,
  deletePlaylist,
  testConnection,
};
