const lastfm = require('./lastfm');
const listenbrainz = require('./listenbrainz');

// Combined Last.fm + ListenBrainz + MusicBrainz-genre similarity scoring.
// This is comparison-only for now, same as the standalone ListenBrainz tab
// -- see routes/playlists.js's GET /:id/similar/combined. Nothing here
// writes to the database or feeds buildPlaylist; it exists so the result
// can be eyeballed against the existing Last.fm-only recommendations before
// it's ever trusted to actually drive what gets added to a real playlist.
//
// The scoring, in order:
//   1. Per seed, pull Last.fm's similar-artist % and ListenBrainz's score
//      (converted to a % of that seed's own top ListenBrainz match, since
//      raw ListenBrainz scores aren't comparable across different artists).
//   2. Blend the two into one number per (seed, candidate) pair: average
//      when both sources have data, use whichever one exists when only one
//      does. A source simply not returning a result is "no opinion," not
//      "0% similar," so it's never treated as a penalty.
//   3. When a candidate is surfaced by more than one seed, take the best of
//      its per-seed blended scores as the base, then add a small bonus for
//      each additional seed that also independently surfaced it -- multiple
//      seeds agreeing on a candidate is its own confidence signal, on top
//      of whatever the strongest individual match was.
//   4. Check the candidate's MusicBrainz genre tags against the union of
//      all the seeds' genre tags (not just the one seed that surfaced this
//      candidate -- multiple seeds are meant to expand discovery, so any
//      seed's genre counts). One shared tag is enough to pass; missing
//      genre data on either side is "can't check," not a mismatch, and is
//      never penalized. No overlap multiplies the score by 0.9.

// How much the combined score bumps per additional seed that also
// independently surfaced a given candidate, and the cap on that bonus
// (so agreement from many seeds can't run the score away unbounded).
// Starting points per discussion -- easy to retune once this has been
// compared against real playlists.
const CORROBORATION_BONUS_PER_SEED = 5;
const CORROBORATION_BONUS_CAP = 15;

// Multiplier applied when a candidate shares no genre tag with any seed
// (and genre data was actually available to check). A soft penalty rather
// than a veto: a weak match barely changes, a strong match survives being
// wrong about genre once.
const GENRE_MISMATCH_MULTIPLIER = 0.9;

// The genre check needs 1-2 extra MusicBrainz lookups per candidate on top
// of what similarity already costs, and MusicBrainz asks for ~1 req/sec --
// running it against every candidate from a multi-seed playlist (which can
// easily be 100+) would make this endpoint take several minutes. Genre is a
// refinement on top of the numeric score, most useful near the top of the
// list, so it only runs on the top N candidates by pre-genre score; anyone
// past that just keeps their pre-genre score, clearly marked as not checked
// rather than silently treated as a genre match.
const GENRE_CHECK_TOP_N = 30;

function sleep(ms) {
  return listenbrainz.sleep(ms);
}

// Runs the full combined-scoring pipeline for a playlist's seeds.
// `seeds` is an array of { artist_name } (playlist_seeds rows work fine).
// Returns { candidates, seedGenres, warnings }.
async function computeCombinedSimilarity(seeds) {
  const warnings = [];
  const seedGenrePool = new Set();

  // candidateKey (lowercased name) -> { name, mbid, perSeed: [{seedName, lastfmPct, lbPct, blended}] }
  const candidates = new Map();

  // Paces every MusicBrainz-hitting call across the whole run (seed
  // resolution, seed genre lookups, and later candidate resolution/genre
  // lookups) so nothing outruns MusicBrainz's ~1 req/sec ask, regardless of
  // which step is making the call.
  let mbCallCount = 0;
  async function paceMb() {
    if (mbCallCount > 0) await sleep(listenbrainz.MB_RATE_LIMIT_MS);
    mbCallCount++;
  }

  for (const seed of seeds) {
    const lastfmResults = await lastfm.getSimilarArtists(seed.artist_name, 25);

    await paceMb();
    const lbOutcome = await listenbrainz.getSimilarArtists(seed.artist_name);
    if (!lbOutcome) {
      warnings.push(`Couldn't resolve "${seed.artist_name}" on MusicBrainz for ListenBrainz lookup — skipped for this seed.`);
    } else if (lbOutcome.algorithmFailed) {
      warnings.push(`ListenBrainz had no similar-artist data for "${lbOutcome.name}".`);
    }
    const lbResults = lbOutcome?.results || [];
    const lbTop = lbResults[0]?.score || 0;

    // Seed's own genre tags, folded into the pool every candidate gets
    // checked against. Reuses the mbid we already resolved above instead
    // of a separate name lookup.
    if (lbOutcome?.mbid) {
      await paceMb();
      const genres = await listenbrainz.getGenres(lbOutcome.mbid);
      if (genres) genres.forEach(g => seedGenrePool.add(g));
    }

    // Merge this seed's Last.fm + ListenBrainz results by name before
    // blending, so a candidate both sources found for this seed gets one
    // blended number, not two separate entries.
    const bySeedCandidate = new Map();
    for (const r of lastfmResults) {
      const key = r.name.toLowerCase();
      bySeedCandidate.set(key, { name: r.name, mbid: r.mbid || null, lastfmPct: r.match * 100, lbPct: null });
    }
    for (const r of lbResults) {
      const key = r.name.toLowerCase();
      const existing = bySeedCandidate.get(key) || { name: r.name, mbid: null, lastfmPct: null, lbPct: null };
      existing.lbPct = lbTop ? (r.score / lbTop) * 100 : 0;
      existing.mbid = existing.mbid || r.mbid || null;
      bySeedCandidate.set(key, existing);
    }

    for (const [key, entry] of bySeedCandidate) {
      const blended = entry.lastfmPct != null && entry.lbPct != null
        ? (entry.lastfmPct + entry.lbPct) / 2
        : (entry.lastfmPct != null ? entry.lastfmPct : entry.lbPct);

      const candidate = candidates.get(key) || { name: entry.name, mbid: entry.mbid, perSeed: [] };
      candidate.mbid = candidate.mbid || entry.mbid;
      candidate.perSeed.push({
        seedName: seed.artist_name,
        lastfmPct: entry.lastfmPct,
        lbPct: entry.lbPct,
        blended,
      });
      candidates.set(key, candidate);
    }
  }

  // Base score + multi-seed corroboration bonus, before genre.
  const scored = [];
  for (const candidate of candidates.values()) {
    const best = candidate.perSeed.reduce((a, b) => (b.blended > a.blended ? b : a));
    const corroboratingSeeds = candidate.perSeed.length;
    const bonus = Math.min(CORROBORATION_BONUS_CAP, CORROBORATION_BONUS_PER_SEED * (corroboratingSeeds - 1));
    const preGenreScore = Math.min(100, best.blended + bonus);
    scored.push({
      name: candidate.name,
      mbid: candidate.mbid,
      perSeed: candidate.perSeed,
      // Top-level convenience copies of the best-scoring seed's per-source
      // percentages, so callers that just want "what did last.fm/ListenBrainz
      // say" for a friendly display don't have to dig into perSeed
      // themselves (e.g. playlistEngine.js persisting these into
      // recommendations/playlist_artist_stats for the UI's match-breakdown
      // line). Can still be null if that source had no data for the best seed.
      lastfmPct: best.lastfmPct,
      lbPct: best.lbPct,
      corroboratingSeeds,
      bonus,
      preGenreScore,
    });
  }
  scored.sort((a, b) => b.preGenreScore - a.preGenreScore);

  // Genre check, capped to the top N by pre-genre score to keep this from
  // taking forever on a large, multi-seed candidate pool.
  const toCheck = scored.slice(0, GENRE_CHECK_TOP_N);
  const skipped = scored.slice(GENRE_CHECK_TOP_N);

  for (const candidate of toCheck) {
    let mbid = candidate.mbid;
    if (!mbid) {
      await paceMb();
      const resolved = await listenbrainz.resolveMusicBrainzId(candidate.name);
      mbid = resolved?.mbid || null;
    }
    if (!mbid || seedGenrePool.size === 0) {
      candidate.genreChecked = false;
      candidate.genreMatched = null;
      candidate.finalScore = candidate.preGenreScore;
      continue;
    }
    await paceMb();
    const candidateGenres = await listenbrainz.getGenres(mbid);
    if (!candidateGenres || candidateGenres.length === 0) {
      candidate.genreChecked = false;
      candidate.genreMatched = null;
      candidate.finalScore = candidate.preGenreScore;
      continue;
    }
    const overlap = candidateGenres.some(g => seedGenrePool.has(g));
    candidate.genreChecked = true;
    candidate.genreMatched = overlap;
    candidate.finalScore = overlap ? candidate.preGenreScore : candidate.preGenreScore * GENRE_MISMATCH_MULTIPLIER;
  }
  for (const candidate of skipped) {
    candidate.genreChecked = false;
    candidate.genreMatched = null;
    candidate.finalScore = candidate.preGenreScore;
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);

  if (skipped.length > 0) {
    warnings.push(`Genre check only ran on the top ${GENRE_CHECK_TOP_N} candidates by score — ${skipped.length} more weren't checked, to keep this from taking forever.`);
  }
  if (seedGenrePool.size === 0) {
    warnings.push(`No MusicBrainz genre data found for any seed artist — genre check was skipped for everyone.`);
  }

  return { candidates: scored, seedGenres: [...seedGenrePool], warnings };
}

module.exports = {
  computeCombinedSimilarity,
  CORROBORATION_BONUS_PER_SEED,
  CORROBORATION_BONUS_CAP,
  GENRE_MISMATCH_MULTIPLIER,
  GENRE_CHECK_TOP_N,
};
