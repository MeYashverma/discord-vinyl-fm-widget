import axios from "axios";
import { isMissingOrPlaceholderArt } from "./utils";
import { logger } from "./utils";

const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";

/**
 * Final, always-available fallback if every other art source fails or the
 * track genuinely has no cover art anywhere. Served straight from this
 * public repo's raw GitHub content -- no webhook/upload needed for this
 * last-resort case, and it's always a valid https URL Discord's widget can
 * render as an image field.
 *
 * If you want to use your own fallback image, either replace
 * docs/default_album_art.png with your own file (same name/path) or change
 * this constant.
 */
export const DEFAULT_ALBUM_ART_URL =
  "https://raw.githubusercontent.com/MeYashverma/discord-vinyl-fm-widget/" +
  "main/docs/default_album_art.png";

const http = axios.create({
  timeout: 10_000,
  headers: {
    Accept: "application/json",
    "User-Agent": "vinyl-fm-widget/1.0 (album-art failover)",
  },
  validateStatus: (status) => status >= 200 && status < 300,
});

type ITunesSearchResult = {
  results?: Array<{ artworkUrl100?: string }>;
};

/**
 * Best-effort album art lookup via the iTunes Search API (free, no key, no
 * auth required). Returns the artwork URL upsized from its default 100x100
 * to 600x600 (documented trick: iTunes serves whatever square size is
 * requested in the filename), or "" on any failure -- callers should treat
 * an empty string as "try the next fallback", never throw.
 */
async function fetchItunesArt(artist: string, title: string): Promise<string> {
  const term = `${artist} ${title}`.trim();
  if (!term) return "";

  try {
    const response = await http.get<ITunesSearchResult>(ITUNES_SEARCH_URL, {
      params: { term, entity: "song", limit: 1 },
    });
    const artwork = response.data.results?.[0]?.artworkUrl100;
    if (!artwork) return "";
    return artwork.replace("100x100bb", "600x600bb");
  } catch (error) {
    logger.debug("iTunes album-art lookup failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

/**
 * Resolve the best available album-art URL for (artist, title), trying in
 * order:
 *   1. The now-playing source's own art, if it looks real (not empty, and
 *      not Last.fm's generic no-cover placeholder image).
 *   2. The iTunes Search API.
 *   3. A static default image bundled in this repo.
 *
 * Always returns a non-empty URL, so the widget's album_art/hero_image
 * fields are never left blank because a track happened to have no cover.
 *
 * Only runs its extra lookups when the source art is actually missing/a
 * placeholder -- tracks with real art return immediately with no added
 * latency or API calls.
 */
export async function resolveAlbumArt(
  sourceUrl: string,
  artist: string,
  title: string,
): Promise<string> {
  if (!isMissingOrPlaceholderArt(sourceUrl)) {
    return sourceUrl;
  }

  logger.info("No real album art from the now-playing source; trying iTunes…", {
    artist,
    title,
  });

  const itunesArt = await fetchItunesArt(artist, title);
  if (itunesArt) {
    logger.info("Found album art via iTunes Search API", { artist, title });
    return itunesArt;
  }

  logger.info("No album art found anywhere; using the default placeholder image", {
    artist,
    title,
  });
  return DEFAULT_ALBUM_ART_URL;
}
