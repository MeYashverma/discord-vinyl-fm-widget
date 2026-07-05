import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// Load settings from .env in the project root.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const emptyStringToUndefined = (value: unknown) => {
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  return value;
};

const optionalUrl = z
  .preprocess(emptyStringToUndefined, z.string().url().optional());

const positiveIntWithDefault = (defaultValue: number) =>
  z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().positive().default(defaultValue),
  );

const nonNegativeIntWithDefault = (defaultValue: number) =>
  z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().nonnegative().default(defaultValue),
  );

const configSchema = z.object({
  DISCORD_APP_ID: z.string().min(1, "DISCORD_APP_ID is required"),
  DISCORD_USER_ID: z.string().min(1, "DISCORD_USER_ID is required"),
  // Bot token lives only in .env as DISCORD_BOT_TOKEN. Never hardcode it.
  DISCORD_BOT_TOKEN: z
    .string()
    .min(1, "DISCORD_BOT_TOKEN is required — set it in your .env file"),
  STATSM_USERNAME: z.string().min(1, "STATSM_USERNAME is required"),
  // Optional channel used to upload D.W.I.F-corrected album art and get a Discord CDN URL.
  DISCORD_TARGET_CHANNEL_ID: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  STATSM_PROFILE_URL: optionalUrl,
  IDLE_IMAGE_URL: optionalUrl,
  // Recent streams — keep low for near-live now-playing (stats.fm records after a song ends).
  POLL_SECONDS: positiveIntWithDefault(5),
  // Tops change slowly; refresh less often so we can poll recent streams hard.
  TOPS_POLL_SECONDS: positiveIntWithDefault(60),
  CURRENT_TRACK_WINDOW_SECONDS: positiveIntWithDefault(300),
  ROTATING_STATS: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
  ROTATION_INTERVAL_SECONDS: positiveIntWithDefault(30),
  // Slash commands: guild (instant, default) or global (set COMMANDS_GLOBAL=true).
  COMMANDS_GLOBAL: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
  COMMANDS_GUILD_ID: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  STATSM_RECENT_URL: optionalUrl,
  STATSM_TOP_ARTISTS_4W_URL: optionalUrl,
  STATSM_TOP_ALBUMS_4W_URL: optionalUrl,
  STATSM_TOP_TRACKS_4W_URL: optionalUrl,
  STATSM_TOP_ARTISTS_6M_URL: optionalUrl,
  STATSM_TOP_ALBUMS_6M_URL: optionalUrl,
  STATSM_TOP_TRACKS_6M_URL: optionalUrl,
  // GitHub Actions daemon mode: 0 disables auto-exit for local/VPS use.
  MAX_RUNTIME_SECONDS: nonNegativeIntWithDefault(0),
  WIDGET_IMAGE_FIX: z
    .string()
    .optional()
    .transform((value) => value !== "false" && value !== "0"),
  IMAGE_CACHE_DIR: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed.length > 0 ? trimmed : ".cache/images";
    }),
});

export type AppConfig = {
  discordAppId: string;
  discordUserId: string;
  /** Discord bot token — never log this value. */
  discordBotToken: string;
  statsmUsername: string;
  /** Optional channel for uploading corrected album art to Discord CDN. */
  discordTargetChannelId?: string;
  statsmProfileUrl: string;
  idleImageUrl?: string;
  pollSeconds: number;
  topsPollSeconds: number;
  currentTrackWindowSeconds: number;
  rotatingStats: boolean;
  rotationIntervalSeconds: number;
  /** Exit cleanly after this many seconds. 0 means run forever. */
  maxRuntimeSeconds: number;
  /** Process album art with the D.W.I.F-style image correction before sending it. */
  widgetImageFix: boolean;
  /** Local cache directory for downloaded/processed images. */
  imageCacheDir: string;
  /** When true, register global slash commands (slow to propagate). */
  commandsGlobal: boolean;
  /** Guild for instant slash command registration in development. */
  commandsGuildId?: string;
  statsmUrls: {
    recent: string;
    topArtists4w: string;
    topAlbums4w: string;
    topTracks4w: string;
    topArtists6m: string;
    topAlbums6m: string;
    topTracks6m: string;
  };
};

function defaultStatsmUrls(username: string) {
  const base = `https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}`;
  return {
    recent: `${base}/streams/recent`,
    // stats.fm: range=weeks ≈ last 4 weeks, range=months ≈ last 6 months
    topArtists4w: `${base}/top/artists?range=weeks&limit=1`,
    topAlbums4w: `${base}/top/albums?range=weeks&limit=1`,
    topTracks4w: `${base}/top/tracks?range=weeks&limit=1`,
    topArtists6m: `${base}/top/artists?range=months&limit=1`,
    topAlbums6m: `${base}/top/albums?range=months&limit=1`,
    topTracks6m: `${base}/top/tracks?range=months&limit=1`,
  };
}

function loadConfig(): AppConfig {
  const parsed = configSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  const env = parsed.data;
  const defaults = defaultStatsmUrls(env.STATSM_USERNAME);

  return {
    discordAppId: env.DISCORD_APP_ID,
    discordUserId: env.DISCORD_USER_ID,
    discordBotToken: env.DISCORD_BOT_TOKEN,
    statsmUsername: env.STATSM_USERNAME,
    discordTargetChannelId: env.DISCORD_TARGET_CHANNEL_ID,
    statsmProfileUrl:
      env.STATSM_PROFILE_URL ??
      `https://stats.fm/${encodeURIComponent(env.STATSM_USERNAME)}`,
    idleImageUrl: env.IDLE_IMAGE_URL,
    pollSeconds: env.POLL_SECONDS,
    topsPollSeconds: env.TOPS_POLL_SECONDS,
    currentTrackWindowSeconds: env.CURRENT_TRACK_WINDOW_SECONDS,
    rotatingStats: Boolean(env.ROTATING_STATS),
    rotationIntervalSeconds: env.ROTATION_INTERVAL_SECONDS,
    maxRuntimeSeconds: env.MAX_RUNTIME_SECONDS,
    widgetImageFix: Boolean(env.WIDGET_IMAGE_FIX),
    imageCacheDir: env.IMAGE_CACHE_DIR,
    commandsGlobal: Boolean(env.COMMANDS_GLOBAL),
    commandsGuildId: env.COMMANDS_GUILD_ID,
    statsmUrls: {
      recent: env.STATSM_RECENT_URL ?? defaults.recent,
      topArtists4w: env.STATSM_TOP_ARTISTS_4W_URL ?? defaults.topArtists4w,
      topAlbums4w: env.STATSM_TOP_ALBUMS_4W_URL ?? defaults.topAlbums4w,
      topTracks4w: env.STATSM_TOP_TRACKS_4W_URL ?? defaults.topTracks4w,
      topArtists6m: env.STATSM_TOP_ARTISTS_6M_URL ?? defaults.topArtists6m,
      topAlbums6m: env.STATSM_TOP_ALBUMS_6M_URL ?? defaults.topAlbums6m,
      topTracks6m: env.STATSM_TOP_TRACKS_6M_URL ?? defaults.topTracks6m,
    },
  };
}

export const config = loadConfig();
