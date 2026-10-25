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

/** Where a usenet stream token's HLS lives; its paths are relative to it. */
export function hlsBaseUrl(token: string): string {
  return `${appConfig.bootstrap.baseUrl}/api/v${constants.API_VERSION}/hls/${token}/`;
}

/**
 * The name a playlist is served under: the file's, so players that title a
 * stream by its address, as VLC does, show it.
 */
export function playlistName(filename: string | undefined): string {
  const name = (filename ?? '').replace(/\.[a-z0-9]{2,4}$/i, '').trim();
  return `${encodeURIComponent(name || 'master')}.m3u8`;
}

/**
 * Where a usenet stream token's HLS starts, under `name` or `master.m3u8`.
 * `audio` makes that audio track, by its place among the file's audio tracks,
 * the one players start with.
 */
export function hlsMasterUrl(
  token: string,
  audio?: number,
  name = 'master.m3u8'
): string {
  const url = `${hlsBaseUrl(token)}${name}`;
  return audio === undefined ? url : `${url}?audio=${audio}`;
}

/** Any playlist named beside the master is the master, under the file's name. */
const asMaster = (parts: string[]) =>
  parts.length === 1 && parts[0].toLowerCase().endsWith('.m3u8')
    ? ['master.m3u8']
    : parts;

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
  const parts = asMaster(
    (req.params.parts as unknown as string[] | undefined) ?? []
  );
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
