import { constants } from '../utils/index.js';
import { parsePlaybackUrl } from '../debrid/utils.js';
import { decodeStoreAuth } from '../main/failover.js';
import { unwrapProxyUrl } from '../proxy/token.js';
import {
  decodeUsenetStreamToken,
  decodeUsenetStreamUrl,
} from '../usenet/integration/tokens.js';

const STREAM_TOKEN = /\/api\/v1\/usenet\/stream\/([^/?#]+)/;

/** Played from this server's own usenet engine, by its URL alone. */
export function isUsenetHlsCandidate(url: string): boolean {
  const unwrapped = unwrapProxyUrl(url);
  if (decodeUsenetStreamUrl(unwrapped)) return true;
  const owned = parsePlaybackUrl(unwrapped);
  return !!owned && decodeStoreAuth(owned)?.id === constants.AIOSTREAMS_SERVICE;
}

/**
 * The engine token of a stream URL of this server's usenet engine, proxied or
 * not, as a playback link resolves to.
 */
export function usenetStreamToken(url: string): string | undefined {
  const unwrapped = unwrapProxyUrl(url);
  return decodeUsenetStreamUrl(unwrapped)
    ? STREAM_TOKEN.exec(unwrapped)?.[1]
    : undefined;
}

/** The remuxer reads Matroska, which WebM also is. */
const REMUXABLE = /\.(mkv|webm)$/i;

/**
 * The engine token of a stream URL whose file the remuxer can read, as a
 * release the failover chain moves on to may be another container.
 */
export function remuxableUsenetToken(url: string): string | undefined {
  const token = usenetStreamToken(url);
  const decoded = token ? decodeUsenetStreamToken(token) : undefined;
  return decoded && REMUXABLE.test(decoded.innerPath ?? decoded.filename)
    ? token
    : undefined;
}
