const fetch = require('node-fetch');

// This service is comparison-only right now: it looks up similar artists via
// MusicBrainz + ListenBrainz on demand for the ListenBrainz tab in the
// Recommendations UI. Nothing here writes to the database, touches Plex, or
// touches Lidarr -- see routes/playlists.js's GET /:id/similar/listenbrainz.

// MusicBrainz asks every client to send a real User-Agent identifying the
// app + a contact -- unauthenticated requests without one get rate-limited
// much more aggressively.
const MB_HEADERS = {
  'User-Agent': 'Tunecraft/0.1 ( https://github.com/dragoneat666/tunecraft )',
};

// ListenBrainz labs' similar-artists dataset needs a POST with a JSON array
// body (their own docs recommend POST over GET). The valid "algorithm"
// value is generated dynamically server-side from whatever similarity data
// currently exists and isn't published as a fixed list anywhere -- these are
// known-working candidates from ListenBrainz's own docs/community examples,
// tried in order until one actually returns results.
const CANDIDATE_ALGORITHMS = [
  'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30',
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_1825_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30',
];

// MusicBrainz asks unauthenticated clients to stay near ~1 request/second.
// The route that drives this service calls resolveMusicBrainzId once per
// seed artist in a loop, so it awaits this between calls to avoid getting
// rate-limited partway through a multi-seed playlist.
const MB_RATE_LIMIT_MS = 1100;
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Resolve an artist name to a MusicBrainz ID. Returns null (not a throw) on
// no match / request failure -- same "fail soft, let the caller decide"
// pattern lastfm.js uses, so one bad seed artist doesn't blow up the tab.
async function resolveMusicBrainzId(artistName) {
  try {
    const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(artistName)}&fmt=json&limit=1`;
    const res = await fetch(url, { headers: MB_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const match = data.artists?.[0];
    if (!match) return null;
    return { name: match.name, mbid: match.id, score: match.score };
  } catch (err) {
    console.warn(`[ListenBrainz] Failed to resolve MusicBrainz ID for "${artistName}":`, err.message);
    return null;
  }
}

// Remembered per-process once a candidate algorithm succeeds, so later
// calls in the same server run try the known-good one first instead of
// re-testing all three every time.
let workingAlgorithm = null;

// Returns an array of { name, mbid, score } on success, or null if every
// candidate algorithm failed/returned nothing (distinct from an empty
// array, which means the request worked but ListenBrainz has no data for
// this artist).
async function getSimilarArtistsByMbid(mbid) {
  const algorithms = workingAlgorithm
    ? [workingAlgorithm, ...CANDIDATE_ALGORITHMS.filter(a => a !== workingAlgorithm)]
    : CANDIDATE_ALGORITHMS;

  for (const algorithm of algorithms) {
    try {
      const res = await fetch('https://labs.api.listenbrainz.org/similar-artists/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ artist_mbids: [mbid], algorithm }]),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        workingAlgorithm = algorithm;
        return data.map(a => ({
          name: a.name,
          mbid: a.artist_mbid || a.reference_mbid || null,
          score: a.score,
        }));
      }
    } catch (err) {
      console.warn(`[ListenBrainz] similar-artists request failed for algorithm "${algorithm}":`, err.message);
    }
  }
  return null;
}

// Get similar artists for a seed artist by name (resolve -> lookup).
// Returns { name, mbid, results, algorithmFailed } on a successful
// MusicBrainz resolution, or null if the artist couldn't be resolved at all.
async function getSimilarArtists(artistName) {
  const resolved = await resolveMusicBrainzId(artistName);
  if (!resolved) return null;

  const results = await getSimilarArtistsByMbid(resolved.mbid);
  if (results === null) {
    return { name: resolved.name, mbid: resolved.mbid, results: [], algorithmFailed: true };
  }
  return { name: resolved.name, mbid: resolved.mbid, results, algorithmFailed: false };
}

// Get MusicBrainz's community-voted genre tags for an artist by mbid, for
// the combined-score genre check (see services/similarityRanking.js).
// Returns a lowercased array of genre names on success (possibly empty, if
// the artist genuinely has no genre tags in MusicBrainz), or null if the
// lookup itself failed -- callers should treat both "no data" cases (null
// and []) as "can't check," not as a mismatch.
async function getGenres(mbid) {
  try {
    const url = `https://musicbrainz.org/ws/2/artist/${mbid}?fmt=json&inc=genres`;
    const res = await fetch(url, { headers: MB_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const genres = (data.genres || []).map(g => g.name.toLowerCase());
    return genres;
  } catch (err) {
    console.warn(`[ListenBrainz] Failed to get genres for mbid ${mbid}:`, err.message);
    return null;
  }
}

module.exports = {
  resolveMusicBrainzId,
  getSimilarArtistsByMbid,
  getSimilarArtists,
  getGenres,
  MB_RATE_LIMIT_MS,
  sleep,
};
