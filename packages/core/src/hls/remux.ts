import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, pipeline, type Readable } from 'node:stream';
import {
  createHlsService,
  NotFoundError,
  type HlsService,
  type LeasedSource,
  type Logger,
  type ServedFile,
  type SourceProvider,
} from '@aiostreams/mkv-remuxer';
import { createLogger } from '../logging/logger.js';
import { withDefaultAudio } from './master.js';
import { getCacheFolder } from '../utils/general.js';
import { CommandPriority } from '../usenet/types.js';
import {
  onUsenetStreamFailed,
  openUsenetFile,
  openUsenetStream,
} from '../usenet/integration/stream-session.js';
import {
  decodeUsenetStreamToken,
  type UsenetStreamToken,
} from '../usenet/integration/tokens.js';
import {
  streamRegistry,
  usenetTargetKey,
  type StreamHandle,
} from '../stream-sessions/index.js';

const logger = createLogger('hls');

const FFMPEG_PATH = 'ffmpeg';
/** Apple's recommendation; shorter starts and seeks faster but runs ffmpeg more. */
const SEGMENT_SECONDS = 6;
const SEGMENT_CACHE_BYTES = 10 * 1000 ** 3;
const METADATA_CACHE_BYTES = 500 * 1000 ** 2;
/**
 * How long a segment rendered ahead may stay unfinished before it is given
 * up, unless a player asks for it. The library's 5 s (raised to a segment
 * plus one) leaves a slow read or a queued job little room.
 */
const KEEP_WARM_SECONDS = 15;
/** A viewer that asks for nothing this long has stopped, or paused. */
const VIEWER_IDLE_MS = 60_000;
/** Files asked for within this long are in use, and their indexes stay. */
const ACTIVE_MS = 30 * 60_000;
const MAX_READERS = 1000;

const remuxLogger: Logger = {
  debug: (message, fields) => logger.debug(fields ?? {}, message),
  info: (message, fields) => logger.info(fields ?? {}, message),
  warn: (message, fields) => logger.warn(fields ?? {}, message),
  error: (message, fields) => logger.error(fields ?? {}, message),
};

/** HLS refused by the stream limits or a ban, as a direct stream would be. */
export class HlsRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/**
 * One user's HLS of one file: a single stream in the registry for as long as
 * anyone keeps asking, however many reads and cached segments serve it. Every
 * player of the file shares its segments, so a party watching together, from
 * however many places, is one stream, as the reads behind it are.
 */
interface Viewer {
  key: string;
  handle: StreamHandle;
  /** Aborted when the stream is killed from the dashboard or for a ban. */
  abort: AbortController;
  timer?: NodeJS.Timeout;
}

const viewers = new Map<string, Viewer>();

function closeViewer(viewer: Viewer): void {
  clearTimeout(viewer.timer);
  if (viewers.get(viewer.key) === viewer) viewers.delete(viewer.key);
  viewer.handle.close();
}

function viewerFor(token: UsenetStreamToken, clientIp?: string): Viewer {
  const username = token.owner ?? '';
  const targetKey = usenetTargetKey(
    token.hash,
    token.fileIndex,
    token.innerPath
  );
  const key = JSON.stringify([username, targetKey]);
  let viewer = viewers.get(key);
  if (!viewer) {
    const admitted = streamRegistry.open({
      transport: 'usenet',
      username,
      clientIp,
      targetKey,
      filename: token.filename,
    });
    if (!admitted.ok) {
      const { reason, message } = admitted.verdict;
      logger.info({ username, hash: token.hash, reason }, 'hls refused');
      throw new HlsRefusedError(
        message ?? 'stream not permitted',
        reason === 'banned' || reason === 'blocked' ? 403 : 429
      );
    }
    const created: Viewer = {
      key,
      handle: admitted.handle,
      abort: new AbortController(),
    };
    admitted.handle.onKill(() => {
      created.abort.abort(new Error('stream stopped'));
      closeViewer(created);
    });
    viewers.set(key, created);
    viewer = created;
  }
  const live = viewer;
  clearTimeout(live.timer);
  live.timer = setTimeout(() => closeViewer(live), VIEWER_IDLE_MS);
  live.timer.unref?.();
  return live;
}

interface Reader {
  token: UsenetStreamToken;
  clientIp?: string;
  viewer: Viewer;
  seenAt: number;
}

/**
 * Who reads each file, by `sourceId/fileId`: the latest request's viewer, so
 * reads count toward that player's stream. Rebuilt from the URL of every
 * request, as each one carries its token.
 */
const readers = new Map<string, Reader>();

const digest = (value: string, length: number) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

/**
 * The remuxer's names for a file: the release, then the file inside it. They
 * name its cache, so every viewer of one file shares one.
 */
function idsOf(token: UsenetStreamToken): { sourceId: string; fileId: string } {
  return {
    sourceId: digest(`usenet:${token.hash}`, 32),
    fileId: digest(`${token.fileIndex ?? 'auto'}:${token.innerPath ?? ''}`, 16),
  };
}

function readerOf(sourceId: string, fileId: string): Reader {
  const reader = readers.get(`${sourceId}/${fileId}`);
  if (!reader) throw new NotFoundError(`No reader for ${sourceId}/${fileId}`);
  return reader;
}

/** A range read the remuxer can take at once, opened as the engine allows. */
function lazyStream(
  open: (signal: AbortSignal) => Promise<Readable>
): Readable {
  const out = new PassThrough();
  const abort = new AbortController();
  out.once('close', () => abort.abort());
  open(abort.signal)
    .then((stream) => pipeline(stream, out, () => undefined))
    .catch((err: Error) => out.destroy(err));
  return out;
}

const provider: SourceProvider = {
  async list(sourceId) {
    const files = [];
    for (const [key, { token }] of readers) {
      const [source, id] = key.split('/');
      if (source !== sourceId) continue;
      const { size } = await openUsenetFile(token);
      files.push({ id, name: token.filename, length: size });
    }
    return { files };
  },

  async lease(sourceId, fileId, hint, work) {
    const { token, clientIp, viewer } = readerOf(sourceId, fileId);
    const { size } = await openUsenetFile(token);
    let priority =
      hint.purpose === 'media' && !hint.foreground
        ? CommandPriority.Low
        : CommandPriority.High;
    // Listeners taken while the work runs go with it; one taken after, the
    // asset's own, stays for as long as the process does.
    let leased = true;
    const unsubscribe: (() => void)[] = [];
    const source: LeasedSource = {
      length: size,
      name: token.filename,
      stream: (start, end) =>
        lazyStream(async (signal) => {
          const opened = await openUsenetStream(token, {
            start,
            end,
            signal: AbortSignal.any([signal, viewer.abort.signal]),
            clientIp,
            priority,
            viewer: viewer.handle,
          });
          return opened.stream;
        }),
      promote() {
        priority = CommandPriority.High;
      },
      onCorrupt(listener) {
        const off = onUsenetStreamFailed(token, () =>
          listener(new Error(`${token.filename} failed the damage policy`))
        );
        if (leased) unsubscribe.push(off);
      },
    };
    try {
      return await work(source);
    } finally {
      leased = false;
      for (const off of unsubscribe) off();
    }
  },

  active() {
    const since = Date.now() - ACTIVE_MS;
    return new Set(
      [...readers]
        .filter(([, reader]) => reader.seenAt > since)
        .map(([key]) => key.split('/')[0])
    );
  },
};

let service: Promise<HlsService> | undefined;

function hlsService(): Promise<HlsService> {
  if (!service) {
    const started = createHlsService({
      cacheDir: join(getCacheFolder(), 'remux'),
      provider,
      ffmpegPath: FFMPEG_PATH,
      segmentDuration: SEGMENT_SECONDS,
      keepWarmS: KEEP_WARM_SECONDS,
      segmentCacheBytes: SEGMENT_CACHE_BYTES,
      metadataCacheBytes: METADATA_CACHE_BYTES,
      logger: remuxLogger,
    });
    // A failed start (ffmpeg missing) is tried again on the next request.
    started.catch(() => {
      if (service === started) service = undefined;
    });
    service = started;
  }
  return service;
}

export interface HlsResponse {
  file: ServedFile;
  /** Sent in place of the file: a master playlist rewritten for this request. */
  body?: string;
  /** Count what reached the player toward its stream. */
  sent(bytes: number): void;
}

/**
 * One HLS path of a usenet stream: `master.m3u8`, a media playlist, an init
 * segment or a segment, rendered on demand. The token is the stream URL's, and
 * the only credential. `audio` picks the default audio track of a master by
 * its place among the file's audio tracks.
 */
export async function serveHls(
  token: string,
  parts: string[],
  opts: { clientIp?: string; signal?: AbortSignal; audio?: number }
): Promise<HlsResponse> {
  const decoded = decodeUsenetStreamToken(token);
  if (!decoded) throw new NotFoundError('invalid or tampered token');
  const viewer = viewerFor(decoded, opts.clientIp);
  const { sourceId, fileId } = idsOf(decoded);
  const key = `${sourceId}/${fileId}`;
  // Re-inserted, so the map runs oldest first.
  readers.delete(key);
  readers.set(key, {
    token: decoded,
    clientIp: opts.clientIp,
    viewer,
    seenAt: Date.now(),
  });
  if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value!);

  const hls = await hlsService();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, viewer.abort.signal])
    : viewer.abort.signal;
  const file = await hls.resolve(sourceId, fileId, parts, signal);
  const sent = (bytes: number) => viewer.handle.addBytes(bytes);
  if (parts.join('/') === 'master.m3u8' && opts.audio !== undefined) {
    const master = await readFile(file.path, 'utf8');
    return { file, body: withDefaultAudio(master, opts.audio), sent };
  }
  return { file, sent };
}

export async function closeHls(): Promise<void> {
  for (const viewer of [...viewers.values()]) closeViewer(viewer);
  const started = service;
  service = undefined;
  (await started?.catch(() => undefined))?.close();
}
