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

// Normalize an artist name for matching: trim, lowercase, collapse
// whitespace, and drop a leading "the " so e.g. "The Killers" and
// "Killers" line up. Used to compare Last.fm's artist names against
// whatever Plex has stored, without depending on exact casing/formatting
// matching between the two sources.
function normalizeArtistName(name) {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '');
}

// Index of every artist across every music library, keyed by normalized
// name. Cached briefly (5 min) since a playlist build can check upwards
// of 100 similar-artist candidates, and re-fetching the whole artist list
// for each one would be wasteful once it's already been fetched once.
//
// This replaced two earlier approaches that both turned out to miss real
// matches: Plex's generic "/search?query=" hub search (fuzzy/relevance
// ranked, and can return zero results for names with numbers or hyphens
// like "Blink-182"), and a "/all?type=8&title=" filtered query (still
// missed some artists — Plex's filter semantics there aren't reliable
// enough to depend on). Fetching every artist once and matching by
// normalized name ourselves removes the dependency on Plex's search/filter
// behavior entirely — we control the matching logic and can see exactly
// why an artist does or doesn't match.
let artistIndexCache = { data: null, expiresAt: 0 };
const ARTIST_INDEX_TTL_MS = 5 * 60 * 1000;

async function getArtistIndex() {
  if (artistIndexCache.data && Date.now() < artistIndexCache.expiresAt) {
    return artistIndexCache.data;
  }
  const libraries = await getMusicLibraries();
  const index = new Map();
  for (const lib of libraries) {
    try {
      const data = await plexGet(`/library/sections/${lib.key}/all?type=8`);
      const artists = data?.MediaContainer?.Metadata || [];
      for (const artist of artists) {
        const key = normalizeArtistName(artist.title);
        if (key && !index.has(key)) {
          index.set(key, { ratingKey: artist.ratingKey, sectionKey: lib.key, title: artist.title });
        }
      }
    } catch (err) {
      console.warn(`[Plex] Failed to list artists in library ${lib.key}:`, err.message);
    }
  }
  console.log(`[Plex] Indexed ${index.size} artist(s) across ${libraries.length} music librar${libraries.length === 1 ? 'y' : 'ies'}`);
  artistIndexCache = { data: index, expiresAt: Date.now() + ARTIST_INDEX_TTL_MS };
  return index;
}

// Search for tracks by artist name in Plex library
async function searchTracksByArtist(artistName) {
  const index = await getArtistIndex();
  let match = index.get(normalizeArtistName(artistName));

  // Fall back to a "contains" pass over every indexed artist name, in
  // case of stylization differences an exact normalized match won't catch
  // (e.g. Last.fm's "Fall Out Boy" vs. a Plex entry tagged
  // "Fall Out Boy (FOB)"). Only used when the exact match misses, and
  // only takes the result if it's unambiguous, so it can't silently
  // grab the wrong artist out of a large library.
  if (!match) {
    const needle = normalizeArtistName(artistName);
    const contains = needle ? [...index.values()].filter(a =>
      normalizeArtistName(a.title).includes(needle) || needle.includes(normalizeArtistName(a.title))
    ) : [];
    if (contains.length === 1) match = contains[0];
  }

  if (!match) return [];

  try {
    const trackData = await plexGet(
      `/library/sections/${match.sectionKey}/all?type=10&artist.id=${match.ratingKey}`
    );
    return trackData?.MediaContainer?.Metadata || [];
  } catch (err) {
    console.warn(`[Plex] Failed to get tracks for artist ${match.title}:`, err.message);
    return [];
  }
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
