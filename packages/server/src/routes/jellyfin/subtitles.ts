import { Router, type Request, type Response } from 'express';
import {
  Cache,
  convertSubtitle,
  createLogger,
  externalSubtitleFor,
  readBodyCapped,
  subtitleExtensionOf,
  subtitlePlaylist,
  type SubtitleFormat,
} from '@aiostreams/core';
import { jfOptional, param } from './context.js';
import { ensureMemo, locate, pickSource } from './playback.js';

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

const bodyCache = Cache.getInstance<
  string,
  { body: string; contentType: string }
>('jellyfin-subtitle-body', 1000);
const BODY_TTL = 3600;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CACHED_BYTES = 512 * 1024;

function formatOf(raw: string): SubtitleFormat {
  const f = raw.toLowerCase();
  if (f === 'js' || f === 'json') return 'json';
  if (f === 'srt' || f === 'subrip') return 'srt';
  if (f === 'ass' || f === 'ssa') return 'ass';
  return 'vtt';
}

async function fetchSubtitle(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;

    return (await readBodyCapped(res, MAX_BYTES)).toString('utf8');
  } catch (error) {
    logger.debug(
      { url, err: error instanceof Error ? error.message : String(error) },
      'subtitle fetch failed'
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function subtitleHandler(req: Request, res: Response) {
  const msid = param(req, 'mediaSourceId').replace(/-/g, '').toLowerCase();
  const loc = await locate(req, param(req, 'itemId'), {
    hintMsid: msid,
    bySession: true,
  });
  if (!loc) {
    res.status(404).end();
    return;
  }
  const memo = await ensureMemo(loc);
  if (!memo) {
    res.status(404).end();
    return;
  }
  const source = pickSource(memo, loc.requestedMsid);
  const track = source
    ? externalSubtitleFor(source, Number(param(req, 'index')))
    : undefined;
  if (!track) {
    res.status(404).end();
    return;
  }
  const to = formatOf(param(req, 'format'));
  const key = `${track.url}|${to}`;
  let converted = await bodyCache.get(key).catch(() => undefined);
  if (!converted) {
    const raw = await fetchSubtitle(track.url);
    if (raw === null) {
      res.status(502).end();
      return;
    }
    converted = convertSubtitle(raw, subtitleExtensionOf(track.url), to);
    if (Buffer.byteLength(converted.body, 'utf8') <= MAX_CACHED_BYTES) {
      void bodyCache.set(key, converted, BODY_TTL).catch(() => undefined);
    }
  }
  res.setHeader('Content-Type', converted.contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(converted.body);
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

router.get(
  '/Videos/:itemId/:mediaSourceId/Subtitles/:index/subtitles.m3u8',
  jfOptional(subtitlePlaylistHandler)
);

router.get(
  [
    '/Videos/:itemId/:mediaSourceId/Subtitles/:index/Stream.:format',
    '/Videos/:itemId/:mediaSourceId/Subtitles/:index/:start/Stream.:format',
  ],
  jfOptional(subtitleHandler)
);

export default router;
