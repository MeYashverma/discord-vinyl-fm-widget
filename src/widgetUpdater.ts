import axios, { AxiosError } from "axios";
import { config } from "./config";
import type {
  CurrentTrack,
  TopStats,
  WidgetField,
  WidgetPayload,
  WidgetSnapshot,
} from "./types";
import { WidgetImagePipeline } from "./imagePipeline";
import { recordWidgetUpdate } from "./runtimeStatus";
import {
  DEFAULT_TEXT_MAX,
  IMAGE_URL_MAX,
  fitAlbumCoverUrl,
  logger,
  retryAfterMs,
  sleep,
  stableStringify,
  truncate,
} from "./utils";

/** Discord rejects many bot REST calls without this User-Agent. */
const DISCORD_USER_AGENT =
  "DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)";

/**
 * Discord profile widget identity endpoint.
 * Authorization uses the bot token from .env (DISCORD_BOT_TOKEN) — never log it.
 */
function widgetEndpoint(): string {
  return `https://discord.com/api/v9/applications/${config.discordAppId}/users/${config.discordUserId}/identities/0/profile`;
}

function textField(name: string, value: string, max = DEFAULT_TEXT_MAX): WidgetField {
  return { type: 1, name, value: truncate(value, max) };
}

function imageField(name: string, url: string): WidgetField {
  // Never ellipsis-truncate image URLs — that breaks the crop proxy.
  const safe = url.length <= IMAGE_URL_MAX ? url : url.slice(0, IMAGE_URL_MAX);
  return { type: 3, name, value: { url: safe } };
}

/**
 * Values sent whenever nothing is currently playing.
 * hero_image is left empty on purpose — Discord then shows the Image field's
 * Application Asset fallback (animated idle gif) from the widget editor.
 */
function idleTrack(): CurrentTrack {
  return {
    title: "Not playing anything.",
    artist: "-",
    album: "-",
    heroImageUrl: "",
    endTime: "",
  };
}

function isIdleTrack(track: CurrentTrack): boolean {
  return track.title === "Not playing anything.";
}

/** Build the Discord widget PATCH body from a snapshot. */
export function buildWidgetPayload(snapshot: WidgetSnapshot): WidgetPayload {
  const track = snapshot.track ?? idleTrack();
  const tops = snapshot.tops;

  const subtitle = isIdleTrack(track)
    ? "-"
    : `${track.artist} • ${track.album}`;

  const dynamic: WidgetField[] = [
    textField("title", track.title),
    textField("artist", track.artist),
    textField("album", track.album),
    textField("subtitle", subtitle),
  ];

  // Only send hero_image while playing (album art URL, always 480×360 crop).
  // When idle, omit it so Discord uses the editor Application Asset fallback
  // (animated gif). User Data image URLs never animate.
  const heroUrl = fitAlbumCoverUrl(track.heroImageUrl);
  if (heroUrl.length > 0) {
    dynamic.push(imageField("hero_image", heroUrl));
  }

  dynamic.push(
    // Bottom six cards — headers (hdr_*) + values (top_*) from active page.
    // Widget editor: Stat "Value" = hdr_*, Stat "Label" = top_* (both User Data).
    textField("hdr_artist_4w", tops.hdrArtist4w),
    textField("hdr_album_4w", tops.hdrAlbum4w),
    textField("hdr_song_4w", tops.hdrSong4w),
    textField("hdr_artist_6m", tops.hdrArtist6m),
    textField("hdr_album_6m", tops.hdrAlbum6m),
    textField("hdr_song_6m", tops.hdrSong6m),
    textField("top_artist_4w", tops.topArtist4w),
    textField("top_album_4w", tops.topAlbum4w),
    textField("top_song_4w", tops.topSong4w),
    textField("top_artist_6m", tops.topArtist6m),
    textField("top_album_6m", tops.topAlbum6m),
    textField("top_song_6m", tops.topSong6m),
  );

  // Optional page indicator (ignored by Discord if the widget has no such field).
  if (snapshot.pageLabel?.trim()) {
    dynamic.push(textField("stats_page", snapshot.pageLabel));
    dynamic.push(textField("page", snapshot.pageLabel));
  }

  return {
    username: config.statsmUsername,
    data: { dynamic },
  };
}

export class WidgetUpdater {
  private lastPayloadJson: string | null = null;
  private readonly imagePipeline = new WidgetImagePipeline();

  /** PATCH the widget only when the payload differs from the last successful send. */
  async update(snapshot: WidgetSnapshot): Promise<boolean> {
    const preparedSnapshot = await this.prepareSnapshot(snapshot);
    const payload = buildWidgetPayload(preparedSnapshot);
    const serialized = stableStringify(payload);

    if (this.lastPayloadJson === serialized) {
      logger.info("Widget unchanged; skipping Discord PATCH");
      recordWidgetUpdate(true);
      return false;
    }

    const ok = await this.patch(payload);
    recordWidgetUpdate(ok);
    if (ok) {
      this.lastPayloadJson = serialized;
    }
    return ok;
  }

  private async prepareSnapshot(snapshot: WidgetSnapshot): Promise<WidgetSnapshot> {
    const track = snapshot.track;
    if (!track?.heroImageUrl) return snapshot;

    const correctedHeroImage = await this.imagePipeline.prepareHeroImage(track.heroImageUrl);
    if (correctedHeroImage === track.heroImageUrl) return snapshot;

    return {
      ...snapshot,
      track: {
        ...track,
        heroImageUrl: correctedHeroImage,
      },
    };
  }

  private async patch(payload: WidgetPayload): Promise<boolean> {
    const url = widgetEndpoint();
    const titleField = payload.data.dynamic.find((field) => field.name === "title");
    const title =
      titleField && titleField.type === 1 ? titleField.value : undefined;

    logger.info("Patching Discord profile widget", {
      url,
      username: payload.username,
      title,
    });

    try {
      const response = await axios.patch(url, payload, {
        timeout: 15_000,
        headers: {
          Authorization: `Bot ${config.discordBotToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": DISCORD_USER_AGENT,
        },
        validateStatus: (status) =>
          (status >= 200 && status < 300) || status === 204,
      });

      if (response.status === 204 || response.data == null || response.data === "") {
        logger.info("Discord widget updated (empty/204 response)", {
          status: response.status,
        });
        return true;
      }

      logger.info("Discord widget updated", { status: response.status });
      return true;
    } catch (error) {
      return this.handlePatchError(error, url);
    }
  }

  private async handlePatchError(error: unknown, url: string): Promise<boolean> {
    if (!axios.isAxiosError(error)) {
      logger.error("Discord widget PATCH failed", {
        url,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const headers = axiosError.response?.headers as Record<string, unknown> | undefined;
    const body = summarizeDiscordBody(axiosError.response?.data);

    if (status === 401 || status === 403) {
      logger.error(
        "Discord widget PATCH unauthorized — check DISCORD_BOT_TOKEN, app id, user id, and sdk.social_layer auth",
        { status, url, body },
      );
      return false;
    }

    if (status === 429) {
      const waitMs = retryAfterMs(headers, 5_000);
      logger.warn("Discord rate limited on widget PATCH; backing off", {
        status,
        url,
        waitMs,
        body,
      });
      await sleep(waitMs);
      return false;
    }

    logger.error("Discord widget PATCH failed", {
      status,
      url,
      message: axiosError.message,
      body,
    });
    return false;
  }
}

function summarizeDiscordBody(data: unknown): string | undefined {
  if (data == null || data === "") return undefined;
  try {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return text.slice(0, 500);
  } catch {
    return "[unserializable]";
  }
}

export function emptyTopStats(): TopStats {
  return {
    hdrArtist4w: "Top Artist(4w)",
    hdrAlbum4w: "Top Album(4w)",
    hdrSong4w: "Top Song(4w)",
    hdrArtist6m: "Top Artist(6m)",
    hdrAlbum6m: "Top Album(6m)",
    hdrSong6m: "Top Song(6m)",
    topArtist4w: "-",
    topAlbum4w: "-",
    topSong4w: "-",
    topArtist6m: "-",
    topAlbum6m: "-",
    topSong6m: "-",
  };
}
