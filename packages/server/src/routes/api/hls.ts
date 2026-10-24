import { Request, Response, Router } from 'express';
import {
  config as appConfig,
  constants,
  createLogger,
  DebridError,
  HlsAbandonedError,
  HlsFfmpegError,
  HlsMatroskaError,
  HlsNotFoundError,
  HlsRefusedError,
  HlsTimeoutError,
  HlsUnsupportedError,
  serveHls,
} from '@aiostreams/core';
import { corsMiddleware } from '../../middlewares/cors.js';
import { hlsRateLimiter } from '../../middlewares/ratelimit.js';

const logger = createLogger('server:hls');
const router: Router = Router();

router.use(corsMiddleware);
router.use(hlsRateLimiter);

/**
 * Where a usenet stream token's HLS starts; every other path is relative to
 * it. `audio` makes that audio track, by its place among the file's audio
 * tracks, the one players start with.
 */
export function hlsMasterUrl(token: string, audio?: number): string {
  const url = `${appConfig.bootstrap.baseUrl}/api/v${constants.API_VERSION}/hls/${token}/master.m3u8`;
  return audio === undefined ? url : `${url}?audio=${audio}`;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof HlsRefusedError) return err.status;
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
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished)
      abort.abort(new HlsAbandonedError('the player went away'));
  });
  const parts = (req.params.parts as unknown as string[] | undefined) ?? [];
  const audio = Number(req.query.audio);
  try {
    const served = await serveHls(String(req.params.token), parts, {
      clientIp: req.requestIp || req.ip || req.socket.remoteAddress,
      signal: abort.signal,
      audio: Number.isInteger(audio) && audio >= 0 ? audio : undefined,
    });
    const { file } = served;
    res.on('finish', () =>
      served.sent(Number(res.getHeader('Content-Length')) || 0)
    );
    res.setHeader('Content-Type', file.contentType);
    if (served.body !== undefined) {
      res.setHeader('Cache-Control', 'no-cache');
      res.send(served.body);
      return;
    }
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
