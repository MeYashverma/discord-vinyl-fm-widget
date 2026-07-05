# stats.fm widget

Single-user Discord bot that keeps your custom **Profile Widget** in sync with live [stats.fm](https://stats.fm) data and Spotify now-playing from Discord presence.

**Top section** — song title, artist, album, and cover art update in real time.

**Bottom 6 cards** — rotate through 4 stat pages every 30 seconds: Top Music, Listening Stats, Last Streamed, and Lifetime.

> **Note:** This is built for one Discord account + one stats.fm profile. The Discord profile widget API is experimental and may change.

## Features

- Live now-playing from Discord Spotify presence
- stats.fm tops, listening stats, and lifetime data
- Rotating stat pages with matching header + value fields
- Payload caching — only PATCHes Discord when something changes
- `/ping` and `/status` slash commands

## Requirements

- Node.js 18+
- A Discord application with a bot token
- A public [stats.fm](https://stats.fm) profile
- Spotify connected to Discord (for now-playing)
- The bot invited to a server you are in (for presence)

## Quick start

```bash
git clone https://github.com/MeYashverma/discord-stats.fm-widget.git
cd discord-stats.fm-widget
npm install
cp .env.example .env
```

Edit `.env` in the project root with your values:

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token from [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_APP_ID` | Your Discord application ID |
| `DISCORD_USER_ID` | Your Discord user ID (the account whose widget gets updated) |
| `STATSM_USERNAME` | Your stats.fm username |

All other options are in `.env.example` with safe defaults.

> If you run `npm start` without these values, the app will stop with `Invalid configuration`. That is expected locally. In GitHub Actions, repository secrets must be mapped into the workflow `env:` block.

### Discord setup

1. Create an application in the Developer Portal
2. Add a bot and copy the token into `.env`
3. Enable **Presence Intent** and **Server Members Intent** under Bot settings
4. Invite the bot to a server you are in
5. Authorize the app once with the `sdk.social_layer` OAuth scope (required for widget PATCH)
6. Configure your profile widget in Discord — see **[Widget setup guide](docs/widget-setup.md)**

### Run

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

## Widget setup

The hardest part is binding fields in the Discord widget editor. Every field the bot updates must be set to **User Data** with the matching **Data Field** name.

See the full guide: **[docs/widget-setup.md](docs/widget-setup.md)**

## Rotating stat pages

When `ROTATING_STATS=true`, the bottom six cards cycle every `ROTATION_INTERVAL_SECONDS` (default 30s). Each card needs **two** User Data bindings — small text → `hdr_*`, large text → `top_*`. The field names are six fixed slots; the text inside them changes per page. If headers stay frozen, they're probably set to Custom String instead of User Data.

Pages:

1. **Top Music** — 4w / 6m artist, album, song
2. **Listening Stats** — today / week / month minutes, streams, uniques
3. **Discovery** — last streamed artist/album/song, monthly library counts
4. **Lifetime** — lifetime minutes/streams, avg daily, genre, library size, account age

To add a page, append to `STAT_PAGES` in `src/rotatingStats.ts`.

## How now-playing works

Now-playing comes from **Discord Spotify presence** (same source as the green Listening block), so track changes are near-instant via `presenceUpdate`.

Top stats and rotation data come from **stats.fm**, refreshed every `TOPS_POLL_SECONDS` (default 60s).

When Spotify is not in your presence, the widget falls back to idle — `hero_image` is omitted so Discord shows the Application Asset gif you configured in the editor.

## Slash commands

Registered automatically on startup:

| Command | Response |
| --- | --- |
| `/ping` | Bot online check |
| `/status` | Bot / widget / stats.fm status |

By default commands are **guild-scoped** (instant). Set `COMMANDS_GUILD_ID` to your server ID, or leave empty to use the first mutual guild.

```env
COMMANDS_GLOBAL=true   # switch to global commands (slow to propagate)
```

## Hosting

### GitHub Actions

This repo includes `.github/workflows/update.yml`, which runs the widget as a long-lived GitHub Actions daemon.

Add these **Repository secrets** in **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Description |
| --- | --- |
| `DISCORD_APP_ID` | Discord Developer Portal → Application ID |
| `DISCORD_USER_ID` | Your Discord user ID |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → Bot token |
| `STATSM_USERNAME` | Your stats.fm username |

Then open **Actions → Update stats.fm Discord Widget → Run workflow**.

The workflow also runs every 6 hours as a safety net. It sets `MAX_RUNTIME_SECONDS=21000` by default so the daemon exits cleanly before GitHub's 6-hour job limit and queues the next run.

Optional settings can be added as **Repository variables**: `POLL_SECONDS`, `TOPS_POLL_SECONDS`, `ROTATING_STATS`, `ROTATION_INTERVAL_SECONDS`, `COMMANDS_GLOBAL`, `COMMANDS_GUILD_ID`, `STATSM_PROFILE_URL`, `IDLE_IMAGE_URL`, and `MAX_RUNTIME_SECONDS`.

### VPS / local process manager

For VPS uptime, run with a process manager like `pm2`:

```bash
npm run build
pm2 start dist/index.js --name statsfm-widget
pm2 save && pm2 startup
```

## Project layout

```
src/
  index.ts           # entrypoint, poll loop
  config.ts          # env loading (zod)
  discordClient.ts   # discord.js login + Spotify presence
  statsfm.ts         # stats.fm API
  rotatingStats.ts   # stat page definitions
  widgetUpdater.ts   # Discord widget PATCH + payload cache
  commands.ts        # slash commands
  deployCommands.ts  # command registration
  runtimeStatus.ts   # live status for /status
  types.ts           # shared types
  utils.ts           # logging, helpers
docs/
  widget-setup.md    # Discord widget editor guide
```

## License

MIT — see [LICENSE](LICENSE).
