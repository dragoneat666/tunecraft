const BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Playlists
  getPlaylists: () => apiFetch('/playlists'),
  getPlaylist: (id) => apiFetch(`/playlists/${id}`),
  createPlaylist: (body) => apiFetch('/playlists', { method: 'POST', body }),
  updatePlaylist: (id, body) => apiFetch(`/playlists/${id}`, { method: 'PUT', body }),
  deletePlaylist: (id, deleteFromPlex = false) =>
    apiFetch(`/playlists/${id}?deleteFromPlex=${deleteFromPlex}`, { method: 'DELETE' }),
  rebuildPlaylist: (id) => apiFetch(`/playlists/${id}/rebuild`, { method: 'POST' }),
  scanPlaylists: () => apiFetch('/playlists/scan', { method: 'POST' }),

  // Seeds
  addSeed: (playlistId, body) => apiFetch(`/playlists/${playlistId}/seeds`, { method: 'POST', body }),
  updateSeed: (playlistId, seedId, body) =>
    apiFetch(`/playlists/${playlistId}/seeds/${seedId}`, { method: 'PUT', body }),
  removeSeed: (playlistId, seedId) =>
    apiFetch(`/playlists/${playlistId}/seeds/${seedId}`, { method: 'DELETE' }),

  // Recommendations
  getRecommendations: () => apiFetch('/recommendations'),
  // Pass an mbid to add a specific MusicBrainz match the user picked from
  // getLidarrCandidates, instead of trusting the stored/auto-picked one.
  addToLidarr: (id, mbid) => apiFetch(`/recommendations/${id}/add-to-lidarr`, { method: 'POST', body: mbid ? { mbid } : undefined }),
  getLidarrCandidates: (id) => apiFetch(`/recommendations/${id}/lidarr-candidates`),
  dismissRecommendation: (id) => apiFetch(`/recommendations/${id}/dismiss`, { method: 'POST' }),
  addRecToPlaylist: (id, body) => apiFetch(`/recommendations/${id}/add-to-playlist`, { method: 'POST', body }),

  // ListenBrainz similar-artist comparison (on-demand, comparison-only — see
  // GET /playlists/:id/similar/listenbrainz)
  getListenBrainzSimilar: (playlistId) => apiFetch(`/playlists/${playlistId}/similar/listenbrainz`),

  // Combined Last.fm + ListenBrainz + genre comparison (on-demand,
  // comparison-only — see GET /playlists/:id/similar/combined). Can take a
  // minute or two on a multi-seed playlist.
  getCombinedSimilar: (playlistId) => apiFetch(`/playlists/${playlistId}/similar/combined`),

  // Settings
  getSettings: () => apiFetch('/settings'),
  updateSettings: (body) => apiFetch('/settings', { method: 'PUT', body }),
  getStatus: () => apiFetch('/settings/status'),
  testService: (service) => apiFetch(`/settings/test/${service}`, { method: 'POST' }),

  // Health / version
  getHealth: () => apiFetch('/health'),
};
