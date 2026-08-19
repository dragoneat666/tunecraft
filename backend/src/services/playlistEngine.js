const { db, getSetting } = require('../db');
const plex = require('./plex');
const lastfm = require('./lastfm');
const audiomuse = require('./audiomuse');
const lidarr = require('./lidarr');
const similarityRanking = require('./similarityRanking');

// Calculate how many tracks each seed artist gets based on weight
// Default weight 5 = equal share
// Weight 10 = 1.5x share, weight 1 = 0.5x share, weight 0 = excluded
function calculateAllocations(seeds, totalTracks) {
  const active = seeds.filter(s => s.weight > 0);
  if (!active.length) return [];
  // Normalize weights: weight 5 = 1.0x, weight 10 = 1.5x, weight 1 = 0.5x
  const normalized = active.map(s => ({
    ...s,
    multiplier: s.weight <= 5
      ? 0.5 + (s.weight - 1) * (0.5 / 4)  // 1→0.5x, 5→1.0x
      : 1.0 + (s.weight - 5) * (0.5 / 5),  // 5→1.0x, 10→1.5x
  }));
  const totalMultiplier = normalized.reduce((sum, s) => sum + s.multiplier, 0);
  return normalized.map(s => ({
    ...s,
    allocation: Math.max(1, Math.round((s.multiplier / totalMultiplier) * totalTracks)),
  }));
}

// Generic proportional allocator, used to split the "similar artist" track
// budget across whichever similar artists turned out to be in Plex,
// weighted by their Last.fm similarity score rather than a fixed weight scale.
function allocateProportionally(items, totalTracks, getWeight) {
  if (!items.length || totalTracks <= 0) return [];
  const weights = items.map(item => Math.max(getWeight(item), 0.0001));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  return items.map((item, idx) => ({
    ...item,
    allocation: Math.max(1, Math.round((weights[idx] / totalWeight) * totalTracks)),
  }));
}

// Shuffle an array (Fisher-Yates)
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Normalize a track title for matching: trim, lowercase, collapse
// whitespace, and drop common parenthetical/bracketed tags that don't
// change what the song actually is ("(Remastered 2019)", "[Live]",
// "(feat. Someone)", "(Radio Edit)", etc.) — so Last.fm's "Come Original"
// still lines up with a Plex track titled "Come Original (Album Version)".
function normalizeTrackTitle(title) {
  return (title || '')
    .trim()
    .toLowerCase()
    .replace(/[\(\[][^)\]]*\)?[\)\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Find tracks in Plex for a given artist + track list from Last.fm.
// If plexTracksOverride is provided, it's reused instead of re-querying
// Plex (callers that already fetched the artist's Plex tracks to check
// whether the artist exists should pass them in here).
async function findTracksInPlex(artistName, lastfmTracks, plexTracksOverride = null) {
  const plexTracks = plexTracksOverride || await plex.searchTracksByArtist(artistName);
  if (!plexTracks.length) return [];

  const toTrackShape = (plexTrack, lastfmPlaycount = 0) => ({
    ratingKey: plexTrack.ratingKey,
    title: plexTrack.title,
    artist: artistName,
    album: plexTrack.parentTitle,
    duration: plexTrack.duration,
    lastfmPlaycount,
    audiomuseScore: 0,
  });

  // Build a map of Plex tracks by normalized title for matching against
  // Last.fm's reported track names.
  const plexMap = new Map(
    plexTracks.map(t => [normalizeTrackTitle(t.title), t])
  );
  const matched = [];
  const usedRatingKeys = new Set();
  for (const lfmTrack of lastfmTracks) {
    const plexTrack = plexMap.get(normalizeTrackTitle(lfmTrack.name));
    if (plexTrack && !usedRatingKeys.has(plexTrack.ratingKey)) {
      matched.push(toTrackShape(plexTrack, lfmTrack.playcount));
      usedRatingKeys.add(plexTrack.ratingKey);
    }
  }

  // If none of Last.fm's specific "top tracks" for this artist line up
  // with any track title actually in Plex (different titling/editions, or
  // you just own different songs by them than what's globally popular on
  // Last.fm), don't come back empty-handed when the artist genuinely has
  // music in the library. Without this, an artist that legitimately
  // exists in Plex — confirmed by the artist-level lookup that got us
  // here — could still contribute zero tracks and vanish from both the
  // playlist AND the recommendations list with no visible trace.
  if (!matched.length) {
    return plexTracks.map(t => toTrackShape(t));
  }

  return matched;
}

// Look up a Plex playlist by exact title before falling back to creating
// a brand new one. This is the guard against duplicate playlists: if the
// DB's stored key is missing or stale (e.g. the user made the playlist
// manually, or an earlier bug created it and it got cleaned up), we
// reuse whatever playlist already exists in Plex with this name rather
// than spawning another one every rebuild.
async function findOrCreatePlaylistByName(name, ratingKeys) {
  const existing = await plex.findPlaylistByTitle(name);
  if (existing) {
    console.log(`[Engine] Found existing Plex playlist "${name}" (key ${existing.key}), updating it`);
    await plex.updatePlaylistItems(existing.key, ratingKeys);
    return { key: existing.key, ratingKey: existing.ratingKey };
  }
  console.log(`[Engine] No existing Plex playlist named "${name}" found, creating a new one`);
  return plex.createPlaylist(name, ratingKeys);
}

// If the playlist already exists in Plex, check its current items for any
// artist that's genuinely new — i.e. actually added by hand — and add them
// as a seed. This is what catches a song dragged into the playlist by hand
// directly in Plex — without it, the artist is invisible to Tunecraft and
// the rebuild below (which deletes and replaces every item in the Plex
// playlist) would just silently wipe the manual addition instead of
// folding it in. Returns how many new seeds were added.
//
// "Genuinely new" has to be checked against more than just the current
// seed list: buildPlaylist's Phase 2 auto-includes similar artists as
// TRACKS without ever making them seeds, so their names show up in the
// Plex playlist's items too. If this only compared against seeds, every
// auto-included similar artist would look "manually added" on the very
// next scan/rebuild and get promoted to a full seed — which then pulls in
// its own similar artists, which get promoted the time after that, and so
// on, snowballing into dozens of seeds from a single manual edit. So the
// comparison set is seeds PLUS every artist Tunecraft itself wrote into
// this playlist on the last build (playlist_tracks, which still holds the
// previous build's output at this point — it isn't cleared until later in
// buildPlaylist). Only an artist in neither set is truly new.
//
// The FIRST and most important check is by Plex ratingKey, not by artist
// name at all: a track's ratingKey uniquely identifies that exact file in
// Plex's library, and playlist_tracks records the ratingKey of every track
// Tunecraft itself wrote into this playlist on the last build (it still
// holds the previous build's output at this point — it isn't cleared until
// later in buildPlaylist). If a live item's ratingKey is in that set,
// Tunecraft put it there itself and it can never be a manual addition —
// full stop — no matter what artist name is attached to it live in Plex.
// This matters because a similar artist's Plex library entry can contain
// misfiled/mistagged audio (a bad Lidarr import, a wrongly-tagged file):
// Tunecraft picks a track believing it belongs to similar artist X and
// records X in playlist_tracks, but the file's own embedded tag — what
// Plex reports as "grandparentTitle" for that same track — says artist Y.
// Only comparing by name would see an unrecognized artist Y show up in the
// live playlist and "promote" it as if someone had dragged a Y song in by
// hand, even though nothing external happened at all. Keying off ratingKey
// first sidesteps that entirely: identity of the exact file, not whatever
// name happens to be embedded in it, is what decides whether Tunecraft put
// it there. (This exact check was accidentally dropped once already, in
// the commit that added seed_percentage — a stale local copy of this file
// got edited instead of the version with this check already in it, and the
// revert wasn't caught until it silently let the mistagged-track bug back
// in. Please don't let anything strip this block again without replacing
// it with an equivalent identity check.)
//
// Only tracks whose ratingKey Tunecraft never touched last build are even
// considered for the name-based check below, which is still needed for the
// real "artist dragged into Plex by hand" case (a genuinely new file, never
// part of any Tunecraft build, so it has no ratingKey to match against).
// That comparison is forgiving, not a raw case-only string match: the
// artist name Tunecraft wrote to playlist_tracks came from Last.fm, while
// Plex's own "grandparentTitle" for the same track comes from its own
// metadata — and those two sources don't always agree on formatting (a
// leading "The ", or a stylized punctuation character like the
// non-breaking hyphen in "Blink-182" vs. a plain one). A mismatch there
// makes an artist Tunecraft itself just added look "manually added" on the
// very next build, which re-triggers the exact snowball above — this
// happened in practice once real playlists exercised it, so it's matched
// to the same normalize/alnum-only comparison plex.js's own artist lookup
// uses, rather than a plain toLowerCase().
async function reconcileManualAdditions(playlist, seeds) {
  if (!playlist.plex_playlist_key) return 0;

  let existingItems;
  try {
    existingItems = await plex.getPlaylistItems(playlist.plex_playlist_key);
  } catch (err) {
    console.warn(`[Engine] Couldn't check "${playlist.name}" for manually added artists:`, err.message);
    return 0;
  }

  // Tracks Tunecraft itself wrote into this playlist on the last build,
  // keyed by ratingKey. String()'d on both sides because better-sqlite3
  // reads plex_rating_key back as a string (TEXT column affinity), while
  // Plex's own API returns ratingKey as a number — without coercion every
  // lookup below would silently miss.
  const lastBuildRatingKeys = new Set(
    db.prepare('SELECT DISTINCT plex_rating_key FROM playlist_tracks WHERE playlist_id = ?')
      .all(playlist.id)
      .map(row => String(row.plex_rating_key))
  );

  const knownNormalized = new Set();
  const knownAlnum = new Set();
  const addKnown = (name) => {
    knownNormalized.add(plex.normalizeArtistName(name));
    const a = plex.alnumOnly(name);
    if (a) knownAlnum.add(a);
  };
  for (const s of seeds) addKnown(s.artist_name);
  const lastBuildArtists = db.prepare(
    'SELECT DISTINCT artist_name FROM playlist_tracks WHERE playlist_id = ?'
  ).all(playlist.id);
  for (const row of lastBuildArtists) addKnown(row.artist_name);

  const isKnown = (name) =>
    knownNormalized.has(plex.normalizeArtistName(name)) ||
    (plex.alnumOnly(name) && knownAlnum.has(plex.alnumOnly(name)));

  const insertSeed = db.prepare(`
    INSERT OR IGNORE INTO playlist_seeds (playlist_id, artist_name, weight)
    VALUES (?, ?, 5)
  `);

  // Drop anything Tunecraft itself added last build before even looking at
  // names — see the ratingKey comment above for why this has to come first.
  const newItems = existingItems.filter(i => !lastBuildRatingKeys.has(String(i.ratingKey)));
  const newArtists = [...new Set(newItems.map(i => i.grandparentTitle).filter(Boolean))];

  const addedNames = [];
  // Keep the specific track(s) that triggered each promotion, not just the
  // artist name — the rebuild that immediately follows a promotion adds a
  // whole batch of that artist's tracks as a normal, legitimate seed
  // allocation, which buries the one original track among a dozen others
  // within seconds. If this needs investigating later (what actually put
  // that track in the playlist — a real manual drag, a Plex metadata
  // re-match, something else), the specific title/album is the only thing
  // that can point at the actual file; the artist name alone can't once
  // it's surrounded by a batch of legitimately-added tracks by the same
  // artist.
  const addedDetails = [];
  for (const artist of newArtists) {
    if (!isKnown(artist)) {
      insertSeed.run(playlist.id, artist);
      addKnown(artist);
      addedNames.push(artist);
      const examples = newItems
        .filter(i => i.grandparentTitle === artist)
        .slice(0, 5)
        .map(i => `"${i.title}"${i.parentTitle ? ` (${i.parentTitle})` : ''}${i.ratingKey ? ` [ratingKey ${i.ratingKey}]` : ''}`)
        .join(', ');
      addedDetails.push(`${artist}: ${examples}`);
    }
  }
  const added = addedNames.length;

  if (added) {
    console.log(`[Engine] Found ${added} artist(s) added by hand in Plex for "${playlist.name}", promoted to seed(s): ${addedNames.join(', ')}`);
    console.log(`[Engine] Triggering track(s) — ${addedDetails.join(' | ')}`);
  }
  return added;
}

async function buildPlaylist(playlistId) {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist) throw new Error(`Playlist ${playlistId} not found`);

  let seeds = db.prepare(
    'SELECT * FROM playlist_seeds WHERE playlist_id = ? ORDER BY weight DESC'
  ).all(playlistId);
  if (!seeds.length) throw new Error(`Playlist ${playlistId} has no seeds`);

  // Pick up any artist added by hand directly in Plex before we rebuild —
  // see reconcileManualAdditions for why this has to happen first.
  const manuallyAdded = await reconcileManualAdditions(playlist, seeds);
  if (manuallyAdded > 0) {
    seeds = db.prepare(
      'SELECT * FROM playlist_seeds WHERE playlist_id = ? ORDER BY weight DESC'
    ).all(playlistId);
  }

  console.log(`[Engine] Building playlist "${playlist.name}" with ${seeds.length} seed(s)`);

  const allTracks = [];
  const similarArtistsFound = new Map(); // artists NOT in Plex → recommendations
  const includedArtists = new Set(seeds.map(s => s.artist_name.toLowerCase()));

  // --- Phase 1: Seed artists ---
  // Reserve seed_percentage% of tracks for seeds, the rest for similar
  // artists found in Plex. (Used to be a flat 60/40, then 30/70 seed/
  // similar — each change skewed less toward repeating the seed artist
  // itself and more toward exploring the similar artists that's the whole
  // point of "radio.") This is now configurable rather than hardcoded:
  // playlist.seed_percentage is snapshotted at creation/adoption time from
  // the settings.default_seed_percentage system default (see routes/
  // playlists.js and scanForNewRadioPlaylists), and can be overridden per
  // playlist afterward via PUT /api/playlists/:id. NULL means this
  // playlist predates the seed_percentage column entirely (the DB
  // migration in db/index.js deliberately leaves existing rows NULL rather
  // than backfilling them to the new default) -- 30 keeps those playlists
  // building exactly as they always have, unaffected by a system-wide
  // default change.
  const seedPercentage = playlist.seed_percentage != null ? playlist.seed_percentage : 30;
  const seedTrackTarget = Math.floor(playlist.track_count * (seedPercentage / 100));
  const similarTrackTarget = playlist.track_count - seedTrackTarget;

  const seedAllocations = calculateAllocations(seeds, seedTrackTarget);
  for (const seed of seedAllocations) {
    console.log(`[Engine] Processing seed "${seed.artist_name}" (weight ${seed.weight}, allocation ${seed.allocation})`);
    const poolTracks = await lastfm.getArtistTopTracks(
      seed.artist_name,
      playlist.track_pool_size
    );
    const plexMatched = await findTracksInPlex(seed.artist_name, poolTracks);
    if (!plexMatched.length) {
      console.warn(`[Engine] No Plex matches found for seed "${seed.artist_name}"`);
      continue;
    }
    const sampled = shuffle(plexMatched).slice(0, seed.allocation);
    allTracks.push(...sampled);
  }

  // --- Phase 2: Similar artists ---
  // How similar an artist has to be (0–1 scale, i.e. combined-score % / 100)
  // before it gets auto-added to the playlist just because it's already in
  // Plex. Anything found in Plex but below this bar is NOT auto-added —
  // it's surfaced instead (with its percentage) so it can be added by hand,
  // same as an out-of-Plex recommendation. This used to be checked against
  // Last.fm's own 0–1 "match" score; it's now checked against the combined
  // Last.fm + ListenBrainz + genre score instead (see similarityRanking.js),
  // kept at the same 60% value the Last.fm-only version had been running at.
  const AUTO_ADD_SIMILARITY_THRESHOLD = 0.6;

  // Below this bar, an artist isn't similar enough to be worth surfacing at
  // all — not auto-added, not even shown as a recommendation. If something
  // this different is wanted in the playlist anyway, the way in is adding it
  // as its own seed: it'll get checked against Plex on its own merits in
  // Phase 1, AND contribute its own similar-artist candidates here in
  // Phase 2.
  const MIN_SIMILARITY_TO_SHOW = 0.4;

  // Artists banned from this specific playlist (via the Artists tab's ban
  // button) — excluded from both auto-add and recommendations below.
  // Banning doesn't retroactively touch Plex on its own; this filter is what
  // actually keeps a banned artist from coming back on the NEXT rebuild.
  const bannedArtists = new Set(
    db.prepare('SELECT artist_name FROM playlist_banned_artists WHERE playlist_id = ?')
      .all(playlistId)
      .map(row => row.artist_name.toLowerCase())
  );

  // Combined Last.fm + ListenBrainz + MusicBrainz-genre score for every
  // candidate similar to any seed (see similarityRanking.js — this is the
  // same pipeline the "Combined" comparison tab used, now driving real
  // auto-add/recommendation decisions instead of just being eyeballed).
  const combined = await similarityRanking.computeCombinedSimilarity(seeds);
  if (combined.warnings.length) {
    console.log(`[Engine] Combined similarity warning(s) for "${playlist.name}": ${combined.warnings.join(' | ')}`);
  }

  // Drop anything already a seed, already banned, or below the "worth
  // showing" floor — no point spending a Plex lookup, or a slot in the
  // recommendations list, on an artist that will never be surfaced no
  // matter what. Filtered-out-by-floor candidates are tracked separately
  // purely for the diagnostic log below.
  const sortedSimilar = [];
  const filteredBelowFloor = [];
  for (const c of combined.candidates) {
    const key = c.name.toLowerCase();
    if (includedArtists.has(key) || bannedArtists.has(key)) continue;
    const scoreFrac = c.finalScore / 100;
    if (scoreFrac < MIN_SIMILARITY_TO_SHOW) {
      filteredBelowFloor.push(c);
      continue;
    }
    sortedSimilar.push({ ...c, score: scoreFrac });
  }
  console.log(`[Engine] Found ${sortedSimilar.length} similar artist(s) at or above ${Math.round(MIN_SIMILARITY_TO_SHOW * 100)}% combined similarity, checking Plex library...`);
  if (filteredBelowFloor.length) {
    const topFiltered = filteredBelowFloor
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 15)
      .map(c => `${c.name} (${Math.round(c.finalScore)}%)`)
      .join(', ');
    console.log(`[Engine] ${filteredBelowFloor.length} artist(s) below the ${Math.round(MIN_SIMILARITY_TO_SHOW * 100)}% floor, not shown at all — highest-scoring of those: ${topFiltered}`);
  }

  // Already sorted best-first by computeCombinedSimilarity, and the filter
  // loop above preserved that order — no need to re-sort.

  // Check EVERY candidate against Plex up front — this is what lets
  // recommendations get collected fully instead of stopping early once the
  // auto-add track quota is met. Each candidate lands in one of two buckets:
  //   - inPlexSimilar: in Plex AND >= the similarity threshold → gets its
  //     tracks auto-added to the playlist.
  //   - similarArtistsFound: everything else (in Plex but below the
  //     threshold, or not in Plex at all) → surfaced with its percentage
  //     instead of being silently included or dropped. source is 'plex' for
  //     the former (already own it, just add it) and 'combined' for the
  //     latter (needs Lidarr).
  // Every candidate also carries its combined-score breakdown, so it can be
  // persisted for the UI's friendly match-breakdown line either way.
  const inPlexSimilar = [];
  for (const similar of sortedSimilar) {
    const plexTracks = await plex.searchTracksByArtist(similar.name);
    const inPlex = plexTracks.length > 0;
    const breakdown = {
      lastfmPct: similar.lastfmPct,
      lbPct: similar.lbPct,
      bonus: similar.bonus,
      corroboratingSeeds: similar.corroboratingSeeds,
      genreChecked: similar.genreChecked,
      genreMatched: similar.genreMatched,
      genreSkipReason: similar.genreSkipReason || null,
      viaSeeds: similar.perSeed.map(p => p.seedName),
    };
    if (inPlex && similar.score >= AUTO_ADD_SIMILARITY_THRESHOLD) {
      inPlexSimilar.push({ name: similar.name, mbid: similar.mbid, score: similar.score, plexTracks, breakdown });
    } else {
      similarArtistsFound.set(similar.name.toLowerCase(), {
        name: similar.name,
        mbid: similar.mbid,
        score: similar.score,
        source: inPlex ? 'plex' : 'combined',
        breakdown,
      });
    }
  }

  console.log(`[Engine] ${inPlexSimilar.length} similar artist(s) >= ${Math.round(AUTO_ADD_SIMILARITY_THRESHOLD * 100)}% and in Plex (auto-including), ${similarArtistsFound.size} shown as recommendations (in-Plex-but-below-threshold + not-in-Plex)`);

  // Split the similar-artist budget across the in-Plex similar artists,
  // weighted by their combined similarity score against the seed(s).
  const similarAllocations = allocateProportionally(inPlexSimilar, similarTrackTarget, s => s.score);

  let similarTracksAdded = 0;
  for (const similar of similarAllocations) {
    if (similarTracksAdded >= similarTrackTarget) break;
    console.log(`[Engine] Similar artist "${similar.name}" found in Plex, adding up to ${similar.allocation} track(s)`);
    const topTracks = await lastfm.getArtistTopTracks(similar.name, playlist.track_pool_size);
    // Reuse the Plex tracks fetched during the existence check above
    // instead of hitting Plex a second time for the same artist.
    const matched = await findTracksInPlex(similar.name, topTracks, similar.plexTracks);
    if (!matched.length) continue;
    const remaining = similarTrackTarget - similarTracksAdded;
    const toAdd = shuffle(matched).slice(0, Math.min(similar.allocation, remaining));
    allTracks.push(...toAdd);
    similarTracksAdded += toAdd.length;
    includedArtists.add(similar.name.toLowerCase());
  }

  console.log(`[Engine] Total: ${allTracks.length} tracks (${allTracks.length - similarTracksAdded} from seeds, ${similarTracksAdded} from similar artists in Plex)`);

  if (!allTracks.length) {
    throw new Error(`No tracks found in Plex for playlist "${playlist.name}"`);
  }

  // Optional: AudioMuse re-ranking
  let finalTracks = allTracks;
  if (audiomuse.isEnabled() && seeds.length > 0) {
    console.log('[Engine] Re-ranking with AudioMuse...');
    finalTracks = await audiomuse.reRankTracks(seeds[0].artist_name, allTracks);
  }

  // Shuffle final tracks so it feels like radio
  finalTracks = shuffle(finalTracks);

  // Get rating keys for Plex API
  const ratingKeys = finalTracks.map(t => t.ratingKey);

  // Create or update playlist in Plex.
  // Before ever creating a new playlist, try to find one that already
  // exists in Plex with this exact name — either via the stored key, or
  // (if that key is missing/stale) by looking it up by title. This is
  // what keeps Tunecraft from spawning a duplicate "Radio: X" playlist
  // every time the stored key goes bad; it always prefers updating the
  // playlist you already created in Plex over making a new one.
  let plexPlaylist;
  if (playlist.plex_playlist_key) {
    try {
      await plex.updatePlaylistItems(playlist.plex_playlist_key, ratingKeys);
      plexPlaylist = { key: playlist.plex_playlist_key, ratingKey: playlist.plex_playlist_id };
    } catch (err) {
      // The full error (not just its message) matters here: this is the
      // exact moment a stored key going stale forces Tunecraft to fall
      // back to a by-title lookup — which is also the exact mechanism that
      // could land on the wrong playlist if more than one shares the same
      // title. Knowing WHY the stored key failed (404? something else?)
      // is what would tell us whether Plex is the one invalidating these
      // keys, versus some other cause.
      console.warn(`[Engine] Stored Plex key for "${playlist.name}" didn't work (${err.message}), looking it up by name instead...`);
      console.warn(err.stack);
      plexPlaylist = await findOrCreatePlaylistByName(playlist.name, ratingKeys);
    }
  } else {
    plexPlaylist = await findOrCreatePlaylistByName(playlist.name, ratingKeys);
  }

  // If the Plex playlist object this build ended up writing to isn't the
  // same one the DB had on file, that's exactly the kind of silent
  // identity change that can lead to stale/duplicate content getting
  // picked up later (see reconcileManualAdditions) — surface it loudly
  // rather than letting the key just quietly update underneath everything.
  if (plexPlaylist?.key && playlist.plex_playlist_key && plexPlaylist.key !== playlist.plex_playlist_key) {
    console.warn(`[Engine] Plex playlist key for "${playlist.name}" CHANGED: ${playlist.plex_playlist_key} -> ${plexPlaylist.key}. The old Plex playlist object is now orphaned (if it still exists).`);
  }

  // Update DB with Plex playlist info
  db.prepare(`
    UPDATE playlists SET
      plex_playlist_id = ?,
      plex_playlist_key = ?,
      last_refreshed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    plexPlaylist?.ratingKey || playlist.plex_playlist_id,
    plexPlaylist?.key || playlist.plex_playlist_key,
    playlistId
  );

  // Store track history
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
  const insertTrack = db.prepare(`
    INSERT INTO playlist_tracks
      (playlist_id, plex_rating_key, track_title, artist_name, album_name, duration_ms, lastfm_playcount, audiomuse_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of finalTracks) {
    insertTrack.run(
      playlistId, t.ratingKey, t.title, t.artist,
      t.album, t.duration, t.lastfmPlaycount, t.audiomuseScore || 0
    );
  }

  // Store similar artist recommendations
  const seedNames = new Set(seeds.map(s => s.artist_name.toLowerCase()));

  // Clean up stale recommendations: an artist that's now a seed, or that we
  // just confirmed is in Plex this build (and therefore got auto-included
  // into the playlist instead of recommended), should not linger in the
  // recommendations table. Without this, an artist that got added to Plex
  // or Lidarr after an earlier build would keep showing an "Add to
  // Playlist" / "Add to Lidarr" option in the UI forever, since the upsert
  // below only ever adds or updates rows — it never removes them.
  const staleRecNames = new Set([
    ...seedNames,
    ...inPlexSimilar.map(s => s.name.toLowerCase()),
  ]);
  if (staleRecNames.size) {
    const deleteStaleRec = db.prepare(
      'DELETE FROM recommendations WHERE playlist_id = ? AND LOWER(artist_name) = ?'
    );
    for (const name of staleRecNames) {
      deleteStaleRec.run(playlistId, name);
    }
  }

  // Filter out artists already in seeds and already recommended
  const existingRecs = db.prepare(
    'SELECT artist_name FROM recommendations WHERE playlist_id = ?'
  ).all(playlistId).map(r => r.artist_name.toLowerCase());
  const existingRecSet = new Set(existingRecs);
  const upsertRec = db.prepare(`
    INSERT INTO recommendations (
      playlist_id, artist_name, artist_mbid, similarity_score, source,
      lastfm_pct, lb_pct, corroboration_bonus, corroborating_seeds,
      genre_checked, genre_matched, genre_skip_reason, via_seeds
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(playlist_id, artist_name) DO UPDATE SET
      similarity_score = excluded.similarity_score,
      lastfm_pct = excluded.lastfm_pct,
      lb_pct = excluded.lb_pct,
      corroboration_bonus = excluded.corroboration_bonus,
      corroborating_seeds = excluded.corroborating_seeds,
      genre_checked = excluded.genre_checked,
      genre_matched = excluded.genre_matched,
      genre_skip_reason = excluded.genre_skip_reason,
      via_seeds = excluded.via_seeds,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const [, artist] of similarArtistsFound) {
    if (!seedNames.has(artist.name.toLowerCase()) && !existingRecSet.has(artist.name.toLowerCase())) {
      upsertRec.run(
        playlistId, artist.name, artist.mbid, artist.score, artist.source,
        artist.breakdown.lastfmPct, artist.breakdown.lbPct, artist.breakdown.bonus,
        artist.breakdown.corroboratingSeeds,
        artist.breakdown.genreChecked ? 1 : 0,
        artist.breakdown.genreMatched == null ? null : (artist.breakdown.genreMatched ? 1 : 0),
        artist.breakdown.genreSkipReason,
        artist.breakdown.viaSeeds.join(', ')
      );
    }
  }

  // Rewrite playlist_artist_stats from scratch with exactly who's
  // contributing tracks to this build — seed artists (no similarity
  // breakdown, they're the source) plus every auto-included similar artist
  // (with its combined-score breakdown). This is what feeds the Artists
  // tab's match-breakdown column; unlike recommendations above, it's fully
  // replaced every build rather than upserted-and-left, since it's meant to
  // reflect "why is this artist in the playlist right now," not a
  // persistent suggestion queue.
  db.prepare('DELETE FROM playlist_artist_stats WHERE playlist_id = ?').run(playlistId);
  const insertStat = db.prepare(`
    INSERT INTO playlist_artist_stats (
      playlist_id, artist_name, is_seed, similarity_score,
      lastfm_pct, lb_pct, corroboration_bonus, corroborating_seeds,
      genre_checked, genre_matched, genre_skip_reason, via_seeds
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const seed of seeds) {
    insertStat.run(playlistId, seed.artist_name, 1, null, null, null, 0, 0, 0, null, null, null);
  }
  for (const similar of inPlexSimilar) {
    insertStat.run(
      playlistId, similar.name, 0, similar.score,
      similar.breakdown.lastfmPct, similar.breakdown.lbPct, similar.breakdown.bonus,
      similar.breakdown.corroboratingSeeds,
      similar.breakdown.genreChecked ? 1 : 0,
      similar.breakdown.genreMatched == null ? null : (similar.breakdown.genreMatched ? 1 : 0),
      similar.breakdown.genreSkipReason,
      similar.breakdown.viaSeeds.join(', ')
    );
  }

  console.log(`[Engine] Playlist "${playlist.name}" built: ${finalTracks.length} tracks, ${similarArtistsFound.size} similar artists found`);

  return {
    trackCount: finalTracks.length,
    similarArtistsFound: similarArtistsFound.size,
  };
}

// Parse a Radio: playlist name from Plex into seed info
// "Radio: Metallica" → { type: 'artist', seeds: ['Metallica'] }
// "Radio: Metallica and Avenged Sevenfold" → { type: 'artist', seeds: ['Metallica', 'Avenged Sevenfold'] }
// "Radio: Metal" → needs genre check
function parseRadioPlaylistName(name) {
  const prefix = 'Radio:';
  if (!name.startsWith(prefix)) return null;
  const content = name.slice(prefix.length).trim();
  // Check if it's "Artist and Artist" format
  if (content.includes(' and ')) {
    const parts = content.split(' and ').map(s => s.trim()).filter(Boolean);
    return { type: 'artist', seeds: parts };
  }
  // Single artist or genre - we'll try it as an artist first
  return { type: 'artist', seeds: [content] };
}

// Generate playlist name from seeds (max 2 artists in name)
function generatePlaylistName(seeds, genre = null) {
  if (genre) return `Radio: ${genre}`;
  const names = seeds.slice(0, 2).map(s => s.artist_name || s);
  if (names.length === 1) return `Radio: ${names[0]}`;
  return `Radio: ${names[0]} and ${names[1]}`;
}

// Scan Plex for new Radio: playlists, and check already-managed playlists
// for artists added by hand directly in Plex since the last build.
async function scanForNewRadioPlaylists() {
  console.log('[Engine] Scanning Plex for new Radio: playlists...');
  const plexPlaylists = await plex.getRadioPlaylists();
  const managed = db.prepare('SELECT id, plex_playlist_key, name FROM playlists').all();
  // A one-line snapshot of what Tunecraft currently believes each managed
  // playlist's Plex key is, on every single scan cycle. On its own this
  // looks unnecessary, but it's what turns "the Plex key changed at some
  // point" into "the Plex key changed between the 12:00 and 12:15 scan" —
  // traceable directly from Tunecraft's own logs, without needing to go
  // spelunking through Plex's server logs to reconstruct when an object's
  // identity shifted underneath it.
  console.log(`[Engine] Currently tracking ${managed.length} playlist(s): ${managed.map(p => `"${p.name}" (key=${p.plex_playlist_key || 'none'})`).join(', ') || '(none)'}`);
  const managedKeys = new Set(managed.map(p => p.plex_playlist_key));
  const managedNames = new Set(managed.map(p => p.name.toLowerCase()));

  const newPlaylists = plexPlaylists.filter(p =>
    !managedKeys.has(p.key) && !managedNames.has(p.title.toLowerCase())
  );

  const results = [];

  // Brand new "Radio:" playlists Tunecraft hasn't seen before.
  if (newPlaylists.length) {
    console.log(`[Engine] Found ${newPlaylists.length} new Radio: playlist(s)`);

    // Plex doesn't enforce unique playlist titles, so it's possible to end
    // up with two distinct Plex playlist objects sharing the exact same
    // "Radio: X" title — e.g. an old one that was deleted from Tunecraft
    // but left behind in Plex, or simply two made by hand with the same
    // name. Nothing above filters that out: the "already managed" check
    // above only excludes names Tunecraft is CURRENTLY tracking, so two
    // untracked playlists with identical titles both pass it and would
    // otherwise both get inserted as separate DB rows here. Whichever one
    // has stale/pre-existing tracks in it would then look, to
    // reconcileManualAdditions on its very next build, like a playlist
    // full of "manually added" artists — none of them known, because this
    // "new" DB row starts with zero seed/track history — and promote all
    // of them to seeds at once. Guarding against claiming the same name
    // twice in one pass keeps Tunecraft from ever adopting a duplicate.
    const claimedNames = new Set();

    for (const plexPlaylist of newPlaylists) {
      try {
        const parsed = parseRadioPlaylistName(plexPlaylist.title);
        if (!parsed) continue;

        const nameLower = plexPlaylist.title.toLowerCase();
        if (claimedNames.has(nameLower)) {
          console.warn(`[Engine] Skipping "${plexPlaylist.title}" (key ${plexPlaylist.key}) — another Plex playlist with this exact name was already adopted this scan. If this one is a leftover duplicate, delete it directly in Plex.`);
          continue;
        }
        claimedNames.add(nameLower);

        // Create playlist record in DB. All four of these are snapshotted
        // from the system defaults at adoption time (see buildPlaylist for
        // why on seed_percentage specifically), so a playlist keeps
        // whatever settings were in effect when Plex first showed it to
        // Tunecraft, even if the system defaults are changed later. Before
        // this, track_count/track_pool_size/refresh_schedule weren't
        // specified here at all -- they silently fell through to this
        // table's fixed CREATE TABLE defaults (100/30/'weekly'), ignoring
        // settings.default_track_count etc. entirely. This is the path
        // that actually matters day to day: it's what runs every time a
        // "Radio: X" playlist gets named directly in Plex, which is how
        // playlists normally get created (POST /api/playlists, the "New
        // Playlist" form, is the other, less-used path).
        const defaultSeedPercentage = parseInt(getSetting('default_seed_percentage') || '20', 10);
        const defaultTrackCount = parseInt(getSetting('default_track_count') || '100', 10);
        const defaultTrackPoolSize = parseInt(getSetting('default_track_pool_size') || '30', 10);
        const defaultRefreshSchedule = getSetting('default_refresh_schedule') || 'weekly';
        const info = db.prepare(`
          INSERT INTO playlists (name, plex_playlist_key, plex_playlist_id, seed_type, seed_percentage, track_count, track_pool_size, refresh_schedule)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(plexPlaylist.title, plexPlaylist.key, plexPlaylist.ratingKey, parsed.type, defaultSeedPercentage, defaultTrackCount, defaultTrackPoolSize, defaultRefreshSchedule);
        const playlistId = info.lastInsertRowid;

        // Add seeds
        const insertSeed = db.prepare(`
          INSERT OR IGNORE INTO playlist_seeds (playlist_id, artist_name, weight)
          VALUES (?, ?, 5)
        `);
        for (const seed of parsed.seeds) {
          insertSeed.run(playlistId, seed);
        }

        // Build the playlist — buildPlaylist itself picks up any artists
        // already sitting in the Plex playlist (e.g. this one, if it had
        // tracks in it before Tunecraft found it) as extra seeds.
        await buildPlaylist(playlistId);
        results.push({ playlistId, name: plexPlaylist.title });
      } catch (err) {
        console.error(`[Engine] Failed to process playlist "${plexPlaylist.title}":`, err.message);
      }
    }
  } else {
    console.log('[Engine] No new Radio: playlists found');
  }

  // Already-managed playlists: check each for artists added by hand
  // directly in Plex since the last build (e.g. dragging a track into the
  // playlist), and rebuild only the ones where something actually changed.
  // This is what makes "Scan" catch drift on an existing playlist instead
  // of only ever finding brand-new ones.
  const alreadyHandled = new Set(results.map(r => r.playlistId));
  for (const p of managed) {
    if (alreadyHandled.has(p.id) || !p.plex_playlist_key) continue;
    try {
      const seeds = db.prepare('SELECT * FROM playlist_seeds WHERE playlist_id = ?').all(p.id);
      const added = await reconcileManualAdditions(p, seeds);
      if (added > 0) {
        console.log(`[Engine] "${p.name}" has ${added} manually-added artist(s) in Plex, rebuilding...`);
        const result = await buildPlaylist(p.id);
        results.push({ playlistId: p.id, name: p.name, manuallyAddedArtists: added, ...result });
      }
    } catch (err) {
      console.error(`[Engine] Failed to check "${p.name}" for manual additions:`, err.message);
    }
  }

  if (!results.length) {
    console.log('[Engine] No new Radio: playlists or manual additions found');
  }

  return results;
}

// Refresh all playlists due for weekly refresh (runs Monday morning)
async function refreshDuePlaylists() {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const due = db.prepare(`
    SELECT id, name FROM playlists
    WHERE refresh_schedule = 'weekly'
      AND (last_refreshed_at IS NULL OR last_refreshed_at < ?)
  `).all(oneWeekAgo);

  console.log(`[Engine] ${due.length} playlist(s) due for refresh`);
  const results = [];

  for (const playlist of due) {
    try {
      console.log(`[Engine] Refreshing "${playlist.name}"...`);
      const result = await buildPlaylist(playlist.id);
      results.push({ playlistId: playlist.id, name: playlist.name, ...result });
    } catch (err) {
      console.error(`[Engine] Failed to refresh "${playlist.name}":`, err.message);
      results.push({ playlistId: playlist.id, name: playlist.name, error: err.message });
    }
  }

  return results;
}

module.exports = {
  buildPlaylist,
  scanForNewRadioPlaylists,
  refreshDuePlaylists,
  parseRadioPlaylistName,
  generatePlaylistName,
  calculateAllocations,
  allocateProportionally,
};
