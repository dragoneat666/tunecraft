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

// Shuffle an array (Fisher-Yates)
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Find tracks in Plex for a given artist + track list from Last.fm
async function findTracksInPlex(artistName, lastfmTracks) {
  const plexTracks = await plex.searchTracksByArtist(artistName);
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

async function buildPlaylist(playlistId) {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist) throw new Error(`Playlist ${playlistId} not found`);

  const seeds = db.prepare(
    'SELECT * FROM playlist_seeds WHERE playlist_id = ? ORDER BY weight DESC'
  ).all(playlistId);

  if (!seeds.length) throw new Error(`Playlist ${playlistId} has no seeds`);

  console.log(`[Engine] Building playlist "${playlist.name}" with ${seeds.length} seed(s)`);

  const allocations = calculateAllocations(seeds, playlist.track_count);
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
  // Get similar artists from Last.fm for all seeds
  const allSimilar = new Map();
  for (const seed of seeds) {
    const similar = await lastfm.getSimilarArtists(seed.artist_name, 20);
    for (const s of similar) {
      if (!allSimilar.has(s.name.toLowerCase()) && !includedArtists.has(s.name.toLowerCase())) {
        allSimilar.set(s.name.toLowerCase(), { name: s.name, mbid: s.mbid, score: s.match });
      }
    }
  }

  console.log(`[Engine] Found ${allSimilar.size} similar artists, checking Plex library...`);

  // Sort by similarity score, check each against Plex
  const sortedSimilar = [...allSimilar.values()].sort((a, b) => b.score - a.score);
  let similarTracksAdded = 0;
  const tracksPerSimilarArtist = Math.max(3, Math.floor(similarTrackTarget / Math.min(sortedSimilar.length, 10)));

  for (const similar of sortedSimilar) {
    const plexTracks = await plex.searchTracksByArtist(similar.name);

    if (plexTracks.length > 0) {
      // Artist is in Plex — get their top tracks from Last.fm and include them
      console.log(`[Engine] Similar artist "${similar.name}" found in Plex, adding tracks`);
      const topTracks = await lastfm.getArtistTopTracks(similar.name, playlist.track_pool_size);
      const matched = await findTracksInPlex(similar.name, topTracks);

      if (matched.length) {
        const toAdd = shuffle(matched).slice(0, tracksPerSimilarArtist);
        allTracks.push(...toAdd);
        similarTracksAdded += toAdd.length;
        includedArtists.add(similar.name.toLowerCase());
      }
    } else {
      // Artist not in Plex — add to recommendations for Lidarr
      similarArtistsFound.set(similar.name.toLowerCase(), {
        name: similar.name,
        mbid: similar.mbid,
        score: similar.score,
        source: 'lastfm',
      });
    }

    // Stop adding similar artist tracks once we hit the target
    if (similarTracksAdded >= similarTrackTarget) break;
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

  // Create or update playlist in Plex
  let plexPlaylist;
  if (playlist.plex_playlist_key) {
    try {
      await plex.updatePlaylistItems(playlist.plex_playlist_key, ratingKeys);
      plexPlaylist = { key: playlist.plex_playlist_key, ratingKey: playlist.plex_playlist_id };
    } catch (err) {
      console.warn('[Engine] Failed to update existing playlist, creating new one:', err.message);
      plexPlaylist = await plex.createPlaylist(playlist.name, ratingKeys);
    }
  } else {
    plexPlaylist = await plex.createPlaylist(playlist.name, ratingKeys);
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
  // Filter out artists already in seeds and already recommended
  const seedNames = new Set(seeds.map(s => s.artist_name.toLowerCase()));
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

// Scan Plex for new Radio: playlists and process them
async function scanForNewRadioPlaylists() {
  console.log('[Engine] Scanning Plex for new Radio: playlists...');

  const plexPlaylists = await plex.getRadioPlaylists();
  const managed = db.prepare('SELECT plex_playlist_key, name FROM playlists').all();
  const managedKeys = new Set(managed.map(p => p.plex_playlist_key));
  const managedNames = new Set(managed.map(p => p.name.toLowerCase()));

  const newPlaylists = plexPlaylists.filter(p =>
    !managedKeys.has(p.key) && !managedNames.has(p.title.toLowerCase())
  );

  if (!newPlaylists.length) {
    console.log('[Engine] No new Radio: playlists found');
    return [];
  }

  console.log(`[Engine] Found ${newPlaylists.length} new Radio: playlist(s)`);
  const results = [];

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

      // Check if the playlist already has songs — detect new artists added manually
      const existingItems = await plex.getPlaylistItems(plexPlaylist.key);
      const existingArtists = new Set(existingItems.map(i => i.grandparentTitle).filter(Boolean));
      for (const artist of existingArtists) {
        const seedNames = new Set(parsed.seeds.map(s => s.toLowerCase()));
        if (!seedNames.has(artist.toLowerCase())) {
          insertSeed.run(playlistId, artist);
        }
      }

      // Build the playlist
      await buildPlaylist(playlistId);
      results.push({ playlistId, name: plexPlaylist.title });

    } catch (err) {
      console.error(`[Engine] Failed to process playlist "${plexPlaylist.title}":`, err.message);
    }
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
};
