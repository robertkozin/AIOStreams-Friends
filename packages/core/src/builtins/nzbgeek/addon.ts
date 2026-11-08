import { z } from 'zod';
import type { Manifest, MetaPreview } from '../../db/index.js';
import { config as appConfig } from '../../config/index.js';
import {
  Cache,
  createLogger,
  getSimpleTextHash,
  makeRequest,
} from '../../utils/index.js';
import { parseXmlCompat } from '../../utils/xml.js';
import { IdMappingDataset } from '../../metadata/id-mappings.js';

const logger = createLogger('nzbgeek');

/** NZBgeek's RSS lists, by their `t=` name. It has no feed of new shows. */
export const NZBGEEK_FEEDS = {
  new_movies: { type: 'movie', name: 'New Movies' },
  trending_movies: { type: 'movie', name: 'Trending Movies' },
  geek_rated_movies: { type: 'movie', name: 'Geek Rated Movies' },
  endorsed_movies: { type: 'movie', name: 'Endorsed Movies' },
  trending_shows: { type: 'series', name: 'Trending Shows' },
  geek_rated_tv: { type: 'series', name: 'Geek Rated Shows' },
  endorsed_shows: { type: 'series', name: 'Endorsed Shows' },
} as const;
export type NzbgeekFeed = keyof typeof NZBGEEK_FEEDS;
export const NZBGEEK_MAX_SIZE = 500;

export const NzbgeekConfigSchema = z.object({
  apiKey: z.string().min(1),
  feeds: z
    .array(z.enum(Object.keys(NZBGEEK_FEEDS) as [NzbgeekFeed]))
    .default(Object.keys(NZBGEEK_FEEDS) as NzbgeekFeed[]),
  size: z.number().int().min(1).max(NZBGEEK_MAX_SIZE).default(100),
  cacheHours: z.number().positive().default(24),
});
export type NzbgeekConfig = z.infer<typeof NzbgeekConfigSchema>;

export interface FeedItem {
  title: string;
  /** IMDb number for movies, TVDB id for shows. */
  id: string;
  poster?: string;
}

const CATALOG_PREFIX = 'nzbgeek.';
const feedCache = Cache.getInstance<string, FeedItem[]>('nzbgeek:feed');

const first = (value: unknown): string | undefined =>
  Array.isArray(value) && typeof value[0] === 'string'
    ? value[0].trim() || undefined
    : undefined;

async function fetchFeed(
  apiKey: string,
  feed: NzbgeekFeed,
  size: number
): Promise<FeedItem[]> {
  const url = new URL('https://api.nzbgeek.info/rss');
  url.searchParams.set('t', feed);
  url.searchParams.set('limit', String(size));
  url.searchParams.set('r', apiKey);
  const res = await makeRequest(url.toString(), {
    timeout: appConfig.presets.defaultTimeout,
    headers: { 'User-Agent': appConfig.http.defaultUserAgent },
  });
  if (!res.ok) throw new Error(`NZBgeek answered ${res.status}`);
  return parseFeed(await res.text(), feed);
}

export function parseFeed(xml: string, feed: NzbgeekFeed): FeedItem[] {
  const doc = parseXmlCompat(xml);
  // Errors come back as 200s: <error code="102" description="Invalid API Key"/>
  if (doc.error)
    throw new Error(
      `NZBgeek: ${doc.error.$?.description ?? `error ${doc.error.$?.code}`}`
    );
  const idField = NZBGEEK_FEEDS[feed].type === 'movie' ? 'imdbid' : 'tvdbid';
  const items: FeedItem[] = [];
  for (const item of doc.rss?.channel?.[0]?.item ?? []) {
    // Untitled releases read `Savage Prey ()`.
    const title = first(item.title)?.replace(/\s*\(\s*\)$/, '');
    const id = first(item[idField]);
    // Unknown ids come as `00000000`, or empty.
    if (title && id && /^\d+$/.test(id) && Number(id) > 0)
      items.push({ title, id, poster: first(item.coverurl) });
  }
  return items;
}

/**
 * Movie titles end in their year, as `Dune (2021)` or `The Odyssey 2026`, and
 * a show's in the year that tells it from another, as `Doctor Who 2005`.
 */
export function splitYear(title: string): { name: string; year?: string } {
  const match = /^(.+?)\s+\(?((?:19|20)\d{2})\)?$/.exec(title);
  return match ? { name: match[1], year: match[2] } : { name: title };
}

export function metaOf(type: 'movie' | 'series', item: FeedItem): MetaPreview {
  const numeric = Number(item.id);
  const { name, year } = splitYear(item.title);
  // IMDb ids where there is one, so every meta and stream addon knows them.
  const id =
    type === 'movie'
      ? `tt${String(numeric).padStart(7, '0')}`
      : (IdMappingDataset.getInstance().imdbIdFor('series', 'tvdb', numeric) ??
        `tvdb:${numeric}`);
  return {
    id,
    type,
    name,
    poster: item.poster,
    posterShape: 'poster',
    ...(year ? { releaseInfo: year } : {}),
  };
}

export class NzbgeekAddon {
  private readonly config: NzbgeekConfig;

  constructor(config: unknown) {
    this.config = NzbgeekConfigSchema.parse(config);
  }

  getManifest(): Manifest {
    const feeds = this.config.feeds;
    return {
      id: `aiostreams.nzbgeek.${getSimpleTextHash(this.config.apiKey).slice(0, 8)}`,
      version: '1.0.0',
      name: 'NZBgeek',
      description: "NZBgeek's trending, rated and endorsed lists",
      types: [...new Set(feeds.map((feed) => NZBGEEK_FEEDS[feed].type))],
      catalogs: feeds.map((feed) => ({
        type: NZBGEEK_FEEDS[feed].type,
        id: `${CATALOG_PREFIX}${feed}`,
        name: NZBGEEK_FEEDS[feed].name,
      })),
      resources: ['catalog'],
      behaviorHints: { configurable: false },
    };
  }

  async getCatalog(
    type: string,
    id: string,
    extras?: string
  ): Promise<{ metas: MetaPreview[] }> {
    const feed = id.slice(CATALOG_PREFIX.length) as NzbgeekFeed;
    if (
      !id.startsWith(CATALOG_PREFIX) ||
      !this.config.feeds.includes(feed) ||
      NZBGEEK_FEEDS[feed].type !== type
    )
      throw new Error(`Unknown catalog ${type}/${id}`);
    // One page only: the size option is the whole list.
    if (/(?:^|&)skip=[1-9]/.test(extras ?? '')) return { metas: [] };

    const { apiKey, size, cacheHours } = this.config;
    const key = `${getSimpleTextHash(apiKey)}:${feed}:${size}`;
    // Not `wrap`, which never caches an empty list.
    let items = await feedCache.get(key);
    if (!items) {
      items = await fetchFeed(apiKey, feed, size);
      await feedCache.set(key, items, Math.round(cacheHours * 3600));
    }
    logger.debug(`Serving ${items.length} items from ${feed}`);
    const seen = new Set<string>();
    const metas: MetaPreview[] = [];
    for (const item of items) {
      const meta = metaOf(type as 'movie' | 'series', item);
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      metas.push(meta);
    }
    return { metas };
  }
}
