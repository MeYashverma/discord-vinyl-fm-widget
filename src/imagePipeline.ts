import axios from "axios";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import FormData from "form-data";
import sharp from "sharp";
import { config } from "./config";
import { logger, shortenAlbumSourceUrl } from "./utils";

const DISCORD_USER_AGENT =
  "DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)";

const REF_SIZE = 512;
const STRIP_BASE = 17;
const RADIUS_BASE = 36;
const STRIP_EXP = Math.log(54 / 17) / Math.log(Math.sqrt(1844 * 853) / REF_SIZE);
const RADIUS_EXP = Math.log(172 / 36) / Math.log(Math.sqrt(1844 * 853) / REF_SIZE);
const TARGET_SIZE = 512;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type CachedImage = {
  cdnUrl: string;
  uploadedAt: number;
};

function auto(base: number, exponent: number, size: number): number {
  return Math.max(0, Math.round(base * (size / REF_SIZE) ** exponent));
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Discord Widget Image Fixer, ported from the LaunchPad repo's D.W.I.F flow.
 *
 * Album art is downloaded, center-cropped to a 512×512 square PNG, shifted down
 * to create a transparent top strip, clipped at the top-right corner, uploaded
 * to a Discord channel, then the widget receives the resulting CDN URL.
 */
export class WidgetImagePipeline {
  private memoryCache = new Map<string, CachedImage>();
  private warnedMissingChannel = false;

  async prepareHeroImage(sourceUrl: string): Promise<string> {
    if (!config.widgetImageFix) return sourceUrl;

    const normalized = shortenAlbumSourceUrl(sourceUrl);
    if (!normalized || !isHttpsUrl(normalized)) return "";

    if (!config.discordTargetChannelId) {
      if (!this.warnedMissingChannel) {
        logger.warn(
          "WIDGET_IMAGE_FIX is enabled but DISCORD_TARGET_CHANNEL_ID is not set; using direct album art URL",
        );
        this.warnedMissingChannel = true;
      }
      return sourceUrl;
    }

    const cached = this.memoryCache.get(normalized);
    if (cached) return cached.cdnUrl;

    try {
      await fs.mkdir(config.imageCacheDir, { recursive: true });
      const key = hash(normalized);
      const rawPath = path.join(config.imageCacheDir, `${key}.img`);
      const fixedPath = path.join(config.imageCacheDir, `${key}-dwif.png`);

      await this.downloadImage(normalized, rawPath);
      await this.processImage(rawPath, fixedPath);
      const cdnUrl = await this.uploadToDiscord(fixedPath, `statsfm-${key}-dwif.png`);

      this.memoryCache.set(normalized, { cdnUrl, uploadedAt: Date.now() });
      logger.info("Prepared widget hero image through D.W.I.F pipeline", {
        source: normalized,
        cdn: cdnUrl,
      });
      return cdnUrl;
    } catch (error) {
      logger.warn("Widget image correction failed; using direct album art URL", {
        message: error instanceof Error ? error.message : String(error),
      });
      return sourceUrl;
    }
  }

  private async downloadImage(url: string, outputPath: string): Promise<void> {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 20_000,
      maxContentLength: MAX_IMAGE_BYTES,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": "statsfm-widget/1.0",
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const bytes = Buffer.from(response.data);
    if (bytes.length <= 0) throw new Error("Downloaded image is empty");
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Downloaded image is over 5 MB");
    await fs.writeFile(outputPath, bytes);
  }

  private async processImage(inputPath: string, outputPath: string): Promise<void> {
    const topStrip = auto(STRIP_BASE, STRIP_EXP, TARGET_SIZE);
    const radius = auto(RADIUS_BASE, RADIUS_EXP, TARGET_SIZE);

    const base = await sharp(inputPath)
      .rotate()
      .resize(TARGET_SIZE, TARGET_SIZE, { fit: "cover", position: "centre" })
      .ensureAlpha()
      .png()
      .toBuffer();

    const alpha = Buffer.alloc(TARGET_SIZE * TARGET_SIZE, 255);
    // Transparent title strip.
    for (let y = 0; y < Math.min(topStrip, TARGET_SIZE); y += 1) {
      alpha.fill(0, y * TARGET_SIZE, (y + 1) * TARGET_SIZE);
    }
    // Rounded top-right corner: clear the corner box, then keep the quarter circle.
    const cx = TARGET_SIZE - radius;
    const cy = topStrip + radius;
    for (let y = topStrip; y < Math.min(topStrip + radius, TARGET_SIZE); y += 1) {
      for (let x = Math.max(TARGET_SIZE - radius, 0); x < TARGET_SIZE; x += 1) {
        const insideCircle = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
        if (!insideCircle) alpha[y * TARGET_SIZE + x] = 0;
      }
    }

    await sharp({
      create: {
        width: TARGET_SIZE,
        height: TARGET_SIZE,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: base, left: 0, top: topStrip }])
      .removeAlpha()
      .joinChannel(alpha, {
        raw: { width: TARGET_SIZE, height: TARGET_SIZE, channels: 1 },
      })
      .png({ compressionLevel: 9 })
      .toFile(outputPath);
  }

  private async uploadToDiscord(localPath: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append("files[0]", await fs.readFile(localPath), {
      filename,
      contentType: "image/png",
    });

    const response = await axios.post(
      `https://discord.com/api/v9/channels/${config.discordTargetChannelId}/messages`,
      form,
      {
        timeout: 30_000,
        headers: {
          ...form.getHeaders(),
          Authorization: `Bot ${config.discordBotToken}`,
          "User-Agent": DISCORD_USER_AGENT,
        },
        validateStatus: (status) => status >= 200 && status < 300,
      },
    );

    const url = response.data?.attachments?.[0]?.url;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error("Discord upload response did not include an attachment URL");
    }
    return url;
  }
}
