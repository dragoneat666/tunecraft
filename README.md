# 🎵 Tunecraft

Pandora-style radio playlist generator for Plex, powered by Last.fm popularity data and optional AudioMuse sonic analysis.

## How It Works

1. Create a playlist in Plex (or PlexAmp) named `Radio: Artist Name`
2. Tunecraft detects it automatically (checks every 15 minutes)
3. Fetches the artist's top songs from Last.fm
4. Finds similar artists and their top songs
5. Filters to only songs you actually have in your library
6. Creates a shuffled playlist in Plex
7. Refreshes every Monday morning with newly downloaded music

## Features

- **Auto-detection** — Create `Radio: Artist Name` in Plex and Tunecraft does the rest
- **Artist radio** — Seeds from one or more artists with adjustable weights per artist
- **Genre radio** — `Radio: Metal` pulls top artists from Last.fm for that genre
- **Weight system** — Control how many songs each artist contributes (0=exclude, 5=default, 10=50% more)
- **Pool sampling** — Fetches top 30 songs per artist, randomly samples from that pool so playlists vary on each refresh
- **Similar artist recommendations** — Discover new artists to add to Lidarr
- **Discord bot** — `/tunecraft scan` and `/tunecraft rebuild` commands
- **Weekly refresh** — Auto-refreshes every Monday at 6am
- **AudioMuse integration** — Optional sonic similarity re-ranking (requires separate AudioMuse stack)

## Quick Start

### Docker (recommended)

```yaml
services:
  tunecraft:
    image: ghcr.io/dragoneat666/tunecraft:latest
    container_name: tunecraft
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - tunecraft_data:/app/data
    environment:
      - PLEX_URL=http://your-plex-server:32400
      - PLEX_TOKEN=your_plex_token
      - LASTFM_API_KEY=your_lastfm_api_key
      # Optional:
      - LIDARR_URL=http://your-lidarr:8686
      - LIDARR_API_KEY=your_lidarr_api_key
      - AUDIOMUSE_URL=http://your-audiomuse:8000
      - AUDIOMUSE_TOKEN=your_audiomuse_token
      - DISCORD_BOT_TOKEN=your_discord_bot_token
      - DISCORD_GUILD_ID=your_discord_guild_id

volumes:
  tunecraft_data:
```

### Getting Your Plex Token

1. Sign in to Plex web app
2. Open any media item and click ···
3. Click "Get Info" → "View XML"
4. Copy the `X-Plex-Token` value from the URL

### Getting a Last.fm API Key

1. Go to https://www.last.fm/api/account/create
2. Fill in the form (free)
3. Copy the API key

## Playlist Naming

| Plex Playlist Name | Result |
|---|---|
| `Radio: Metallica` | Radio based on Metallica |
| `Radio: Metallica and Slayer` | Combined radio, equal weight |
| `Radio: Metal` | Genre radio (Last.fm Metal top artists) |

Names with 3+ artists show only the first two: `Radio: Metallica and Slayer` even if 5 artists are seeded.

## Weight System

In the Tunecraft UI, each seed artist has a weight (0-10):
- **0** — Excluded from playlist
- **1** — Gets ~50% fewer songs than default
- **5** — Default, equal share
- **10** — Gets ~50% more songs than default

Weights only apply in the Tunecraft UI. Playlists created via Plex `Radio:` trigger start with all artists at weight 5.

## Discord Bot Commands

- `/tunecraft scan` — Check Plex for new `Radio:` playlists
- `/tunecraft rebuild` — Pick a playlist to rebuild immediately

## GitHub Actions (CI/CD)

Push to `main` → builds and pushes to `ghcr.io/dragoneat666/tunecraft:latest`
