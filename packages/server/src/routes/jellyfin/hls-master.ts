import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  config as appConfig,
  createLogger,
  DebridError,
  externalSubtitleFor,
  HlsRefusedError,
  isUsenetHlsCandidate,
  remuxableUsenetToken,
  serveHls,
  subtitlePlaylist,
  unwrapProxyUrl,
  withExtraSubtitles,
} from '@aiostreams/core';
import { readFile } from 'node:fs/promises';
import { hlsBaseUrl, hlsMasterUrl, playlistName } from '../api/hls.js';
import { resolvePlaybackChain } from '../api/debrid.js';
import { playbackParamsOf, staticHlsPath } from '../../utils/playback.js';
import { jfOptional, param, qs } from './context.js';
import { externalHlsSubtitles, hlsAudioPlace } from './hls.js';
import { subtitleUrlFor } from './items.js';
import { ensureMemo, locate, pickSource } from './playback.js';

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

/**
 * The version remuxed to HLS, for a client that can't direct play it: opens
 * (or reuses) a session and sends the client to its playlist. A playback link
 * runs its failover chain as the file route does, so a release that fails,
 * or that the remuxer can't read, moves on to the next, and one that leaves
 * nothing to play sends the error video as HLS. A version with no HLS stream
 * is a 415, which tells the web app to play its file instead.
 */
async function hlsMaster(req: Request, res: Response) {
  const loc = await locate(req, param(req, 'itemId'), { bySession: true });
  const memo = loc ? await ensureMemo(loc) : null;
  const source = memo ? pickSource(memo, loc?.requestedMsid) : undefined;
  if (!source || source.notice) {
    res.status(404).json({ Message: 'No playable stream' });
    return;
  }
  const clientIp = req.requestIp || req.ip || req.socket.remoteAddress;
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isUsenetHlsCandidate(source.url)) {
      res.status(415).json({ Message: 'This version has no HLS stream' });
      return;
    }
    const link = playbackParamsOf(unwrapProxyUrl(source.url));
    const outcome = link
      ? await resolvePlaybackChain({
          ...link,
          clientIp,
          arrivedViaOurProxy: false,
          playPath: 'jellyfin',
          accept: (url) => !!remuxableUsenetToken(url),
        })
      : { url: source.url, failedOver: false, played: () => {} };
    if ('badRequest' in outcome) {
      res.status(400).json({ Message: outcome.badRequest });
      return;
    }
    if ('staticFile' in outcome) {
      res.redirect(302, staticHlsPath(outcome.staticFile));
      return;
    }
    const token = remuxableUsenetToken(outcome.url);
    if (!token) {
      res.status(415).json({ Message: 'This version has no HLS stream' });
      return;
    }
    // The client's track names a row of this version, which a release the
    // chain moved on to doesn't share.
    const audioIndex = Number(qs(req, 'AudioStreamIndex'));
    const audio =
      !outcome.failedOver && Number.isInteger(audioIndex) && audioIndex >= 0
        ? hlsAudioPlace(source, audioIndex)
        : undefined;
    const name = playlistName(source.filename);
    if (!/^(1|true|yes)$/i.test(qs(req, 'ExternalSubtitles') ?? '')) {
      res.redirect(302, hlsMasterUrl(token, audio, name));
      outcome.played();
      return;
    }
    // Served here rather than redirected, as the subtitles beside the file
    // join the playlist, for players that read nothing else, such as VLC.
    const served = await serveHls(token, ['master.m3u8'], { clientIp, audio });
    const master = served.body ?? (await readFile(served.file.path, 'utf8'));
    const body = withExtraSubtitles(
      master,
      hlsBaseUrl(token),
      externalHlsSubtitles(source, {
        itemId: memo!.itemId,
        playSessionId: memo!.psid,
        token: qs(req, 'api_key') ?? qs(req, 'ApiKey'),
        base: `${appConfig.bootstrap.baseUrl}${req.baseUrl}`,
        subtitleUrl: subtitleUrlFor(memo!.itemId, source.msid),
      })
    );
    res.type(served.file.contentType).send(body);
    served.sent(Buffer.byteLength(body));
    outcome.played();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, msid: source.msid },
      'could not resolve a version for hls'
    );
    const status =
      err instanceof DebridError
        ? err.statusCode || 502
        : err instanceof HlsRefusedError
          ? err.status
          : 502;
    res.status(status).json({ Message: (err as Error).message });
  }
}

/**
 * One external subtitle as an HLS media playlist of a single WebVTT segment,
 * for a master that lists the version's external subtitles.
 */
async function subtitlePlaylistHandler(req: Request, res: Response) {
  const msid = param(req, 'mediaSourceId').replace(/-/g, '').toLowerCase();
  const loc = await locate(req, param(req, 'itemId'), {
    hintMsid: msid,
    bySession: true,
  });
  const memo = loc ? await ensureMemo(loc) : null;
  const source = memo ? pickSource(memo, loc?.requestedMsid) : undefined;
  if (!source || !externalSubtitleFor(source, Number(param(req, 'index')))) {
    res.status(404).end();
    return;
  }
  const query = req.originalUrl.split('?')[1];
  // The file's own length where probed; the title's is rounded, or missing.
  const runtimeS =
    (source.durationMs ?? memo?.runtimeMs ?? 0) / 1000 || 4 * 3600;
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(
    subtitlePlaylist(`0/Stream.vtt${query ? `?${query}` : ''}`, runtimeS)
  );
}

// Mounted before the playback router, whose transcoding stubs these replace.
router.get('/Videos/:itemId/master.m3u8', jfOptional(hlsMaster));
// The master under the file's name, which players that title a stream by its
// address show. The stubs' main and live playlists stay theirs.
router.get(
  '/Videos/:itemId/:name.m3u8',
  (req: Request, res: Response, next: NextFunction) =>
    ['main', 'live'].includes(String(req.params.name))
      ? next()
      : jfOptional(hlsMaster)(req, res, next)
);
router.get(
  '/Videos/:itemId/:mediaSourceId/Subtitles/:index/subtitles.m3u8',
  jfOptional(subtitlePlaylistHandler)
);

export default router;
