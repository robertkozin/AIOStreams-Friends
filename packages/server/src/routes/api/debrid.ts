import { Router, Request, Response, NextFunction } from 'express';
import {
  APIError,
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
import { ZodError } from 'zod';
import {
  StaticFiles,
  mapDebridErrorToStaticFile,
} from '../../utils/static-errors.js';
import { corsMiddleware } from '../../middlewares/cors.js';
const router: Router = Router();
const logger = createLogger('server');

router.use(corsMiddleware);

// block HEAD requests
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'HEAD') {
    res.status(405).send('Method not allowed');
  } else {
    next();
  }
});

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
  /** Whether a resolved URL will do, as HLS needs Matroska. */
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
      /** Tells the media info probe what played, once the response is sent. */
      played(): void;
    }
  | { staticFile: string }
  | { badRequest: string };

/** Runs the failover chain of a playback link; the route and HLS share it. */
export async function resolvePlaybackChain(
  params: PlaybackRequest
): Promise<PlaybackOutcome> {
  const {
    encryptedStoreAuth,
    fallbackKey,
    fileInfo: fileInfoRaw,
    metadataId,
    filename,
  } = params;

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

  const { clientIp, arrivedViaOurProxy, playPath, accept } = params;
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
    if (url && served) resolvedFrom.set(served, { target, url });
    return served;
  };

  // Resolve a chain item (or variant), branching on owned vs external, then
  // proxying the result when configured.
  const resolveTarget =
    (item: PlayChainItem) =>
    async (signal?: AbortSignal): Promise<string | undefined> => {
      if (item.kind === 'external') {
        return resolveExternalTarget(item.url, { clientIp }, signal).then(
          (url) => maybeProxy(url, item.proxied)
        );
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

  // A URL that won't do counts as a failed attempt, so the chain moves on.
  if (accept)
    for (const attempt of attempts) {
      const resolve = attempt.resolve;
      attempt.resolve = async (signal) => {
        const url = await resolve(signal);
        if (url && !accept(url))
          throw new Error(`${attempt.label} can't be played this way`);
        return url;
      };
    }

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

  if (!result.url) {
    return { staticFile: StaticFiles.DOWNLOADING };
  }

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
    // Once the response is sent, so the media info probe sees what played.
    played() {
      const played = resolvedFrom.get(url);
      if (played) {
        void onPlay({
          path: playPath,
          target: played.target,
          resolvedUrl: played.url,
          viaProxy:
            arrivedViaOurProxy ||
            url.includes(constants.BUILTIN_PROXY_PATH_PREFIX),
        });
      }
    },
  };
}

router.get(
  [
    '/playback/:encryptedStoreAuth/:fallbackKey/:fileInfo/:metadataId/:filename',
    // Legacy
    '/playback/:encryptedStoreAuth/:fileInfo/:metadataId/:filename',
  ],
  async (req: Request<PlaybackParams>, res: Response, next: NextFunction) => {
    try {
      const outcome = await resolvePlaybackChain({
        ...req.params,
        clientIp: req.userIp,
        arrivedViaOurProxy: !!req.query[constants.INTERNAL_PROXY_MARKER],
        playPath:
          req.query[constants.PLAY_PATH_MARKER] === 'jellyfin'
            ? 'jellyfin'
            : 'stremio',
      });
      if ('badRequest' in outcome) {
        next(
          new APIError(
            constants.ErrorCode.BAD_REQUEST,
            undefined,
            outcome.badRequest
          )
        );
        return;
      }
      if ('staticFile' in outcome) {
        res.redirect(307, `/static/${outcome.staticFile}`);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(307, outcome.url);
      outcome.played();
    } catch (error: any) {
      if (error instanceof APIError || error instanceof ZodError) {
        next(error);
      } else {
        logger.error(
          { err: error },
          `got unexpected error during debrid resolve: ${error.message}`
        );
        next(
          new APIError(
            constants.ErrorCode.INTERNAL_SERVER_ERROR,
            undefined,
            error.message
          )
        );
      }
    }
  }
);

export default router;
