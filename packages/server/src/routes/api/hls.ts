import { Request, Response, Router } from 'express';
import {
  config as appConfig,
  constants,
  createLogger,
  DebridError,
  hlsEnabled,
  HlsAbandonedError,
  HlsFfmpegError,
  HlsMatroskaError,
  HlsNotFoundError,
  HlsTimeoutError,
  HlsUnsupportedError,
  serveHls,
} from '@aiostreams/core';
import { corsMiddleware } from '../../middlewares/cors.js';

const logger = createLogger('server:hls');
const router: Router = Router();

router.use(corsMiddleware);

/** Where a usenet stream token's HLS starts; every other path is relative to it. */
export function hlsMasterUrl(token: string): string {
  return `${appConfig.bootstrap.baseUrl}/api/v${constants.API_VERSION}/hls/${token}/master.m3u8`;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof HlsNotFoundError) return 404;
  if (err instanceof HlsUnsupportedError || err instanceof HlsMatroskaError)
    return 415;
  if (err instanceof HlsTimeoutError) return 504;
  if (err instanceof HlsFfmpegError) return 502;
  if (err instanceof DebridError) return err.statusCode || 502;
  return undefined;
}

/**
 * Every path of a usenet stream's HLS: the master playlist, media playlists,
 * init segments and segments, rendered on demand by the remuxer.
 */
router.get('/:token/{*parts}', async (req: Request, res: Response) => {
  if (!hlsEnabled()) {
    res.status(404).json({ success: false, detail: 'HLS is turned off' });
    return;
  }
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished)
      abort.abort(new HlsAbandonedError('the player went away'));
  });
  const parts = (req.params.parts as unknown as string[] | undefined) ?? [];
  try {
    const file = await serveHls(String(req.params.token), parts, {
      clientIp: req.requestIp || req.ip || req.socket.remoteAddress,
      signal: abort.signal,
    });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', file.cacheControl);
    res.sendFile(file.path, { headers: { 'Content-Type': file.contentType } });
  } catch (err) {
    if (err instanceof HlsAbandonedError || abort.signal.aborted) return;
    const status = statusOf(err);
    if (!status || status >= 500)
      logger.warn(
        { path: parts.join('/'), err: (err as Error).message },
        'hls request failed'
      );
    if (!res.headersSent)
      res
        .status(status ?? 500)
        .json({ success: false, detail: (err as Error).message });
  }
});

export default router;
