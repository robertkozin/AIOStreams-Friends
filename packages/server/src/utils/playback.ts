import {
  constants,
  createLogger,
  createProxy,
  DebridError,
  decodeFallbackKey,
  decodeFileInfo,
  describeChainItem,
  getPlayChain,
  parsePlaybackUrl,
  resolvePlaybackTarget,
  resolveExternalTarget,
  runPlayChain,
  getSimpleTextHash,
  DistributedLock,
  type FailoverAttempt,
  type FailoverContentType,
  type PlayChainItem,
  type PlaybackTarget,
  maskSensitiveInfo,
  onPlay,
} from '@aiostreams/core';
import { StaticFiles, mapDebridErrorToStaticFile } from './static-errors.js';

const logger = createLogger('server');

/** An owned playback link's parts, as its path carries them. */
export interface PlaybackParams {
  encryptedStoreAuth: string;
  fallbackKey?: string;
  fileInfo: string;
  metadataId: string;
  filename: string;
}

export interface PlaybackRequest extends PlaybackParams {
  clientIp?: string;
  /** Came through our own proxy, so a resolved URL isn't proxied again. */
  arrivedViaOurProxy: boolean;
  playPath: 'jellyfin' | 'stremio';
  /**
   * Whether a resolved URL will do; one that won't counts as a failed
   * attempt, so the chain moves on, as for HLS, which needs Matroska.
   */
  accept?: (url: string) => boolean;
}

/**
 * Where a playback link leads: the URL that won its failover chain, a static
 * video in place of one, or a malformed link.
 */
export type PlaybackOutcome =
  | {
      url: string;
      /** Won by a fallback rather than the clicked item. */
      failedOver: boolean;
      /** Tells the media info probe what played, once it is sent. */
      played(): void;
    }
  | { staticFile: string }
  | { badRequest: string };

/** The parts of an owned playback link, the same as the playback route's. */
export function playbackParamsOf(url: string): PlaybackParams | undefined {
  const target = parsePlaybackUrl(url);
  if (!target) return undefined;
  const fallbackKey = url
    .slice(url.indexOf(target.encryptedStoreAuth))
    .split('/')[1];
  return {
    encryptedStoreAuth: target.encryptedStoreAuth,
    fallbackKey,
    fileInfo: target.fileInfoRaw,
    metadataId: target.metadataId,
    filename: target.filename,
  };
}

/**
 * Resolves a playback link through its failover chain: the clicked item, then
 * every fallback the chain holds, in parallel where the user configured it.
 */
export async function resolvePlaybackChain(
  req: PlaybackRequest
): Promise<PlaybackOutcome> {
  const {
    encryptedStoreAuth,
    fallbackKey,
    fileInfo: fileInfoRaw,
    metadataId,
    filename,
    clientIp,
    arrivedViaOurProxy,
    playPath,
    accept,
  } = req;

  // Validate the clicked item decodes (preserves the 400 contract) and tells
  // us which kind it is for cross-type filtering.
  const fileInfo = await decodeFileInfo(fileInfoRaw);
  if (!fileInfo) {
    return { badRequest: 'Failed to parse file info and not found in store.' };
  }
  const clickedType: FailoverContentType =
    fileInfo.type === 'usenet' ? 'usenet' : 'debrid';

  const decodedFbk = decodeFallbackKey(fallbackKey);
  const chain = decodedFbk
    ? await getPlayChain(decodedFbk, clickedType)
    : undefined;
  const fallbacks = chain?.fallbacks ?? [];
  const hasFailover = fallbacks.length > 0;

  if (!hasFailover && !decodedFbk) {
    logger.debug(
      { clickedType, hasFallbackKey: !!fallbackKey },
      'clicked item has no failover chain reference'
    );
  }

  const proxyConfig = chain?.proxyConfig;

  // Wrap a resolved (CDN) URL in a proxy URL when the source item should be
  // proxied and we didn't arrive via our proxy. Fail-open to the raw URL.
  const maybeProxy = async (
    resolvedUrl: string | undefined,
    itemProxied: boolean | undefined
  ): Promise<string | undefined> => {
    if (!resolvedUrl) return resolvedUrl; // still downloading
    if (arrivedViaOurProxy || !itemProxied || !proxyConfig?.enabled) {
      return resolvedUrl;
    }
    if (resolvedUrl.includes(constants.BUILTIN_PROXY_PATH_PREFIX)) {
      return resolvedUrl;
    }
    try {
      const out = await createProxy(proxyConfig).generateUrls([
        { url: resolvedUrl, filename, type: 'stream' },
      ]);
      if (Array.isArray(out) && out[0]) return out[0];
      logger.warn(
        { err: out && 'error' in out ? out.error : 'no url returned' },
        'failed to proxy failover-resolved url; serving raw url'
      );
    } catch (err: any) {
      logger.warn(
        { err: err?.message ?? String(err) },
        'error proxying failover-resolved url; serving raw url'
      );
    }
    return resolvedUrl; // fail-open
  };

  // Served URL -> what it resolved from, for the media info probe.
  const resolvedFrom = new Map<
    string,
    { target: PlaybackTarget; url: string }
  >();
  const resolveOwned = async (
    target: PlaybackTarget,
    proxied: boolean | undefined,
    signal?: AbortSignal
  ): Promise<string | undefined> => {
    const url = await resolvePlaybackTarget(target, { clientIp }, signal);
    const served = await maybeProxy(url, proxied);
    if (served && accept && !accept(served))
      throw new Error(`${target.filename} can't be played this way`);
    if (url && served) resolvedFrom.set(served, { target, url });
    return served;
  };

  // Resolve a chain item (or variant), branching on owned vs external, then
  // proxying the result when configured.
  const resolveTarget =
    (item: PlayChainItem) =>
    async (signal?: AbortSignal): Promise<string | undefined> => {
      if (item.kind === 'external') {
        const url = await resolveExternalTarget(item.url, { clientIp }, signal);
        const served = await maybeProxy(url, item.proxied);
        if (served && accept && !accept(served))
          throw new Error(`${item.filename} can't be played this way`);
        return served;
      }
      const target = parsePlaybackUrl(item.url);
      return target
        ? resolveOwned(target, item.proxied, signal)
        : Promise.reject(new Error('unparseable fallback url'));
    };

  const attempts: FailoverAttempt[] = [
    {
      label: chain?.clicked
        ? describeChainItem(chain.clicked, 'clicked')
        : describeChainItem({ type: clickedType, filename }, 'clicked'),
      rank: 0,
      resolve: (signal) =>
        resolveOwned(
          { encryptedStoreAuth, fileInfoRaw, metadataId, filename },
          chain?.clickedProxied,
          signal
        ),
    },
    ...fallbacks.map((f): FailoverAttempt => ({
      label: describeChainItem(f),
      rank: f.rank,
      resolve: resolveTarget(f),
    })),
  ];

  const runCfg = {
    parallel: chain?.parallel ?? 1,
    staggerMs: chain?.staggerMs ?? 0,
    preferredGraceMs: chain?.preferredGraceMs ?? 0,
    maxWaitMs: chain?.maxWaitMs ?? 60_000,
    duplicateStaggerMs: chain?.duplicateStaggerMs ?? 0,
  };

  if (hasFailover) {
    logger.info(
      {
        attempts: attempts.length,
        parallel: runCfg.parallel,
        clickedType,
        chain: attempts.map((a, i) => {
          const label = a.label ?? 'unknown';
          // Index 0 is the clicked item, the fallbacks follow in order.
          // Variants are indented under the release they belong to.
          return i > 0 && fallbacks[i - 1]?.isVariant ? `  ↳ ${label}` : label;
        }),
      },
      'resolving failover chain'
    );
  } else {
    logger.debug(
      { clickedType, attempt: attempts[0].label },
      'no failover targets; resolving the clicked item only'
    );
  }

  const run = () => runPlayChain(attempts, runCfg);

  // Share one running chain across concurrent requests for the same click.
  const result = hasFailover
    ? (
        await DistributedLock.getInstance().withLock(
          `failover:${getSimpleTextHash(
            encryptedStoreAuth + metadataId + filename + fallbackKey
          )}:${clientIp ?? '-'}`,
          run,
          {
            timeout: Math.max(runCfg.maxWaitMs, 180_000),
            ttl: Math.max(runCfg.maxWaitMs, 185_000),
          }
        )
      ).result
    : await run();

  if (result.error) {
    const err = result.error;
    if (err instanceof DebridError) {
      // A malformed clicked item with no chain to fall back to is a 400,
      // not a static video.
      if (err.code === 'BAD_REQUEST' && !hasFailover) {
        return { badRequest: err.message };
      }
      logger.error({ err }, `error during debrid resolve: ${err.message}`);
      return { staticFile: mapDebridErrorToStaticFile(err.code) };
    }
    logger.error(
      { err },
      `got unknown error during debrid resolve: ${err.message}`
    );
    return { staticFile: StaticFiles.INTERNAL_SERVER_ERROR };
  }

  if (!result.url) return { staticFile: StaticFiles.DOWNLOADING };

  logger.debug(
    {
      url: maskSensitiveInfo(result.url),
      label: result.label,
      failedOver: result.failedOver,
    },
    'Debrid resolve succeeded, redirecting'
  );

  const url = result.url;
  return {
    url,
    failedOver: result.failedOver,
    played() {
      const played = resolvedFrom.get(url);
      if (!played) return;
      void onPlay({
        path: playPath,
        target: played.target,
        resolvedUrl: played.url,
        viaProxy:
          arrivedViaOurProxy ||
          url.includes(constants.BUILTIN_PROXY_PATH_PREFIX),
      });
    },
  };
}
