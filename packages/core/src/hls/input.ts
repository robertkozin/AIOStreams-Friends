import { constants } from '../utils/index.js';
import { parsePlaybackUrl } from '../debrid/utils.js';
import { decodeStoreAuth, resolvePlaybackTarget } from '../main/failover.js';
import { unwrapProxyUrl } from '../proxy/token.js';
import { decodeUsenetStreamUrl } from '../usenet/integration/tokens.js';

const STREAM_TOKEN = /\/api\/v1\/usenet\/stream\/([^/?#]+)/;

/** Played from this server's own usenet engine, by its URL alone. */
export function isUsenetHlsCandidate(url: string): boolean {
  const unwrapped = unwrapProxyUrl(url);
  if (decodeUsenetStreamUrl(unwrapped)) return true;
  const owned = parsePlaybackUrl(unwrapped);
  return !!owned && decodeStoreAuth(owned)?.id === constants.AIOSTREAMS_SERVICE;
}

/**
 * The engine token behind a version's URL, as the stream URL carries it: the
 * URL's own, or a playback link to this server's usenet service, which this
 * resolves (grabbing the NZB) as a player's request to it would.
 */
export async function usenetTokenFor(
  url: string,
  clientIp?: string
): Promise<string | undefined> {
  const unwrapped = unwrapProxyUrl(url);
  const own = (target: string) =>
    decodeUsenetStreamUrl(target) ? STREAM_TOKEN.exec(target)?.[1] : undefined;
  const direct = own(unwrapped);
  if (direct) return direct;
  const owned = parsePlaybackUrl(unwrapped);
  if (!owned || decodeStoreAuth(owned)?.id !== constants.AIOSTREAMS_SERVICE)
    return undefined;
  const resolved = await resolvePlaybackTarget(owned, { clientIp });
  return resolved ? own(resolved) : undefined;
}
