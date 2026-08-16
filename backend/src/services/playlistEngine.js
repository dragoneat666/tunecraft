const { db } = require('../db');
const plex = require('./plex');
const lastfm = require('./lastfm');
const audiomuse = require('./audiomuse');
const lidarr = require('./lidarr');

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

// Find tracks in Plex for a given artist + track list from Last.fm.
// If plexTracksOverride is provided, it's reused instead of re-querying
// Plex (callers that already fetched the artist's Plex tracks to check
// whether the artist exists should pass them in here).
async function findTracksInPlex(artistName, lastfmTracks, plexTracksOverride = null) {
  const plexTracks = plexTracksOverride || await plex.searchTracksByArtist(artistName);
  if (!plexTracks.length) return [];
  // Build a map of plex tracks by lowercase title for matching
  const plexMap = new Map(
    plexTracks.map(t => [t.title?.toLowerCase(), t])
  );
  const matched = [];
  for (const lfmTrack of lastfmTracks) {
    const titleLower = lfmTrack.name?.toLowerCase();
    const plexTrack = plexMap.get(titleLower);
    if (plexTrack) {
      matched.push({
        ratingKey: plexTrack.ratingKey,
        title: plexTrack.title,
        artist: artistName,
        album: plexTrack.parentTitle,
        duration: plexTrack.duration,
        lastfmPlaycount: lfmTrack.playcount,
        audiomuseScore: 0,
      });
    }
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
async function reconcileManualAdditions(playlist, seeds) {
  if (!playlist.plex_playlist_key) return 0;

  let existingItems;
  try {
    existingItems = await plex.getPlaylistItems(playlist.plex_playlist_key);
  } catch (err) {
    console.warn(`[Engine] Couldn't check "${playlist.name}" for manually added artists:`, err.message);
    return 0;
  }

  const existingArtists = new Set(existingItems.map(i => i.grandparentTitle).filter(Boolean));

  const knownArtists = new Set(seeds.map(s => s.artist_name.toLowerCase()));
  const lastBuildArtists = db.prepare(
    'SELECT DISTINCT artist_name FROM playlist_tracks WHERE playlist_id = ?'
  ).all(playlist.id);
  for (const row of lastBuildArtists) {
    knownArtists.add(row.artist_name.toLowerCase());
  }

  const insertSeed = db.prepare(`
    INSERT OR IGNORE INTO playlist_seeds (playlist_id, artist_name, weight)
    VALUES (?, ?, 5)
  `);

  const addedNames = [];
  for (const artist of existingArtists) {
    if (!knownArtists.has(artist.toLowerCase())) {
      insertSeed.run(playlist.id, artist);
      knownArtists.add(artist.toLowerCase());
      addedNames.push(artist);
    }
  }
  const added = addedNames.length;

  if (added) {
    console.log(`[Engine] Found ${added} artist(s) added by hand in Plex for "${playlist.name}", promoted to seed(s): ${addedNames.join(', ')}`);
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
  // Reserve 60% of tracks for seeds, 40% for similar artists found in Plex
  const seedTrackTarget = Math.floor(playlist.track_count * 0.6);
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
  // How similar (per Last.fm's 0–1 "match" score) an artist has to be
  // before it gets auto-added to the playlist just because it's already
  // in Plex. Anything found in Plex but below this bar is NOT auto-added
  // — it's surfaced instead (with its percentage) so it can be added by
  // hand, same as an out-of-Plex recommendation.
  const AUTO_ADD_SIMILARITY_THRESHOLD = 0.6;

  // Get similar artists from Last.fm for all seeds
  const allSimilar = new Map();
  for (const seed of seeds) {
    const similar = await lastfm.getSimilarArtists(seed.artist_name, 50);
    for (const s of similar) {
      if (!allSimilar.has(s.name.toLowerCase()) && !includedArtists.has(s.name.toLowerCase())) {
        allSimilar.set(s.name.toLowerCase(), { name: s.name, mbid: s.mbid, score: s.match });
      }
    }
  }
  console.log(`[Engine] Found ${allSimilar.size} similar artists, checking Plex library...`);

  // Sort by similarity score, and cap how many candidates we bother
  // checking against Plex/Last.fm to keep this from ballooning when a
  // playlist has several seeds (each contributing up to 50 candidates).
  const MAX_SIMILAR_TO_CHECK = 100;
  const sortedSimilar = [...allSimilar.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SIMILAR_TO_CHECK);

  // Check EVERY candidate against Plex up front — this is what lets
  // recommendations get collected fully instead of stopping early once
  // the auto-add track quota is met. Each candidate lands in one of two
  // buckets:
  //   - inPlexSimilar: in Plex AND >= the similarity threshold → gets its
  //     tracks auto-added to the playlist.
  //   - similarArtistsFound: everything else (in Plex but below the
  //     threshold, or not in Plex at all) → surfaced with its percentage
  //     instead of being silently included or dropped. source is 'plex'
  //     for the former (already own it, just add it) and 'lastfm' for
  //     the latter (needs Lidarr).
  const inPlexSimilar = [];
  for (const similar of sortedSimilar) {
    const plexTracks = await plex.searchTracksByArtist(similar.name);
    const inPlex = plexTracks.length > 0;
    if (inPlex && similar.score >= AUTO_ADD_SIMILARITY_THRESHOLD) {
      inPlexSimilar.push({ ...similar, plexTracks });
    } else {
      similarArtistsFound.set(similar.name.toLowerCase(), {
        name: similar.name,
        mbid: similar.mbid,
        score: similar.score,
        source: inPlex ? 'plex' : 'lastfm',
      });
    }
  }

  console.log(`[Engine] ${inPlexSimilar.length} similar artist(s) >= ${Math.round(AUTO_ADD_SIMILARITY_THRESHOLD * 100)}% and in Plex (auto-including), ${similarArtistsFound.size} shown as recommendations (in-Plex-but-below-threshold + not-in-Plex)`);

  // Split the 40% similar-artist budget across the in-Plex similar artists,
  // weighted by how similar Last.fm says they are to the seed(s).
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
      console.warn(`[Engine] Stored Plex key for "${playlist.name}" didn't work (${err.message}), looking it up by name instead...`);
      plexPlaylist = await findOrCreatePlaylistByName(playlist.name, ratingKeys);
    }
  } else {
    plexPlaylist = await findOrCreatePlaylistByName(playlist.name, ratingKeys);
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
    INSERT INTO recommendations (playlist_id, artist_name, artist_mbid, similarity_score, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(playlist_id, artist_name) DO UPDATE SET
      similarity_score = excluded.similarity_score,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const [, artist] of similarArtistsFound) {
    if (!seedNames.has(artist.name.toLowerCase()) && !existingRecSet.has(artist.name.toLowerCase())) {
      upsertRec.run(playlistId, artist.name, artist.mbid, artist.score, artist.source);
    }
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
  const managedKeys = new Set(managed.map(p => p.plex_playlist_key));
  const managedNames = new Set(managed.map(p => p.name.toLowerCase()));

  const newPlaylists = plexPlaylists.filter(p =>
    !managedKeys.has(p.key) && !managedNames.has(p.title.toLowerCase())
  );

  const results = [];

  // Brand new "Radio:" playlists Tunecraft hasn't seen before.
  if (newPlaylists.length) {
    console.log(`[Engine] Found ${newPlaylists.length} new Radio: playlist(s)`);

    for (const plexPlaylist of newPlaylists) {
      try {
        const parsed = parseRadioPlaylistName(plexPlaylist.title);
        if (!parsed) continue;

        // Create playlist record in DB
        const info = db.prepare(`
          INSERT INTO playlists (name, plex_playlist_key, plex_playlist_id, seed_type)
          VALUES (?, ?, ?, ?)
        `).run(plexPlaylist.title, plexPlaylist.key, plexPlaylist.ratingKey, parsed.type);
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
