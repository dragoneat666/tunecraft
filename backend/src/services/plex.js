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

// Plex's playlist "key" field (as returned by /playlists, and by playlist
// creation) points at ".../items", not the playlist itself — e.g.
// "/playlists/448012/items". Anything that needs the item-list endpoint
// can use the key as-is; anything that appends its own "/items" (or wants
// the playlist's own endpoint, e.g. to delete it) needs the suffix
// stripped first, or it ends up double-appending ("/items/items") and
// Plex 404s. Normalize in one place so every caller agrees.
function playlistBasePath(playlistKey) {
  return playlistKey.replace(/\/items$/, '');
}

// Build the "provider" URI Plex expects when adding multiple items to a
// playlist in one call: ONE uri with all the rating keys comma-joined at
// the end of a single metadata path, e.g.
//   server://<machineId>/com.plexapp.plugins.library/library/metadata/100,101,102
// The previous code built a *separate* full "server://.../metadata/<key>"
// URI per track and then joined those whole URIs together with commas.
// Plex's multi-add endpoint doesn't accept a comma-separated list of full
// URIs — it just doesn't add any items, which is why playlists were
// coming out completely empty even after the /items path bug was fixed.
function buildItemsUri(machineId, trackRatingKeys) {
  return `server://${machineId}/com.plexapp.plugins.library/library/metadata/${trackRatingKeys.join(',')}`;
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
      // First find the artist
      const encoded = encodeURIComponent(artistName);
      const artistData = await plexGet(
        `/library/sections/${lib.key}/search?query=${encoded}&type=8`
      );
      const artists = artistData?.MediaContainer?.Metadata || [];
      // For each matching artist, get their tracks
      for (const artist of artists) {
        try {
          const trackData = await plexGet(
            `/library/sections/${lib.key}/all?type=10&artist.id=${artist.ratingKey}`
          );
          const artistTracks = trackData?.MediaContainer?.Metadata || [];
          tracks.push(...artistTracks);
        } catch (err) {
          console.warn(`[Plex] Failed to get tracks for artist ${artist.title}:`, err.message);
        }
      }
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

// Find an existing playlist by exact title match (case-insensitive).
// Used as a fallback when a playlist's stored key has gone stale (e.g.
// the user deleted/recreated the playlist in Plex, or an earlier bug
// created it) so we reuse the playlist that already exists instead of
// spawning a duplicate.
async function findPlaylistByTitle(title) {
  const all = await getAllPlaylists();
  const match = all.find(p => p.title?.toLowerCase() === title.toLowerCase());
  return match || null;
}

// Get items in a playlist
async function getPlaylistItems(playlistKey) {
  const basePath = playlistBasePath(playlistKey);
  const data = await plexGet(`${basePath}/items`);
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
  const items = buildItemsUri(machineId, trackRatingKeys);
  const data = await plexPost(
    `/playlists?type=audio&title=${encodeURIComponent(title)}&smart=0&uri=${encodeURIComponent(items)}`
  );
  const created = data?.MediaContainer?.Metadata?.[0] || null;
  // Diagnostic: Plex's create-playlist response includes leafCount (item
  // count) for the new playlist. Logging it here means a mismatch against
  // the number of tracks we asked for shows up immediately in the logs
  // instead of only being discovered by looking at an empty playlist.
  console.log(`[Plex] Created playlist "${title}": ${created?.leafCount ?? 'unknown'} item(s) added (requested ${trackRatingKeys.length})`);
  return created;
}

// Replace all items in an existing playlist
async function updatePlaylistItems(playlistKey, trackRatingKeys) {
  const machineId = await getMachineId();
  const items = buildItemsUri(machineId, trackRatingKeys);
  // playlistKey (as stored from Plex's own "key" field) already ends in
  // "/items" — strip it before appending our own, or the request 404s on
  // a doubled path like "/playlists/448012/items/items".
  const basePath = playlistBasePath(playlistKey);
  // Clear existing items
  await plexDelete(`${basePath}/items`);
  // Add new items
  await plexPut(`${basePath}/items?uri=${encodeURIComponent(items)}`);
}

// Delete a playlist
async function deletePlaylist(playlistKey) {
  // Same "key" quirk as above: deleting ".../items" would only clear the
  // playlist's contents, not the playlist itself, so normalize first.
  await plexDelete(playlistBasePath(playlistKey));
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
  findPlaylistByTitle,
  getPlaylistItems,
  createPlaylist,
  updatePlaylistItems,
  deletePlaylist,
  testConnection,
};
