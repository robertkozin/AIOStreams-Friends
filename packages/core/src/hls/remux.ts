import { createHash } from 'node:crypto';
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
} from '@rimjoeh/mkv-remuxer';
import { config as appConfig } from '../config/index.js';
import { createLogger } from '../logging/logger.js';
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

const logger = createLogger('hls');

const remuxLogger: Logger = {
  debug: (message, fields) => logger.debug(fields ?? {}, message),
  info: (message, fields) => logger.info(fields ?? {}, message),
  warn: (message, fields) => logger.warn(fields ?? {}, message),
  error: (message, fields) => logger.error(fields ?? {}, message),
};

interface Reader {
  token: UsenetStreamToken;
  clientIp?: string;
  seenAt: number;
}

/** Files asked for within this long are in use, and their indexes stay. */
const ACTIVE_MS = 30 * 60_000;
const MAX_READERS = 1000;

/**
 * Who reads each file, by `sourceId/fileId`: the latest request's token, so
 * reads count as that user's streams from that address. Rebuilt from the URL
 * of every request, as each one carries its token.
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
    const { token, clientIp } = readerOf(sourceId, fileId);
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
            signal,
            clientIp,
            priority,
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

let service: { key: string; started: Promise<HlsService> } | undefined;

function hlsService(): Promise<HlsService> {
  const settings = appConfig.usenet.hls;
  const key = JSON.stringify([
    settings.ffmpegPath,
    settings.segmentDuration,
    settings.cacheBytes,
  ]);
  if (service?.key !== key) {
    const previous = service?.started;
    void previous?.then((s) => s.close()).catch(() => undefined);
    const started = createHlsService({
      cacheDir: join(getCacheFolder(), 'remux'),
      provider,
      ffmpegPath: settings.ffmpegPath,
      segmentDuration: settings.segmentDuration,
      segmentCacheBytes: settings.cacheBytes,
      metadataCacheBytes: Math.max(64 * 1024 * 1024, settings.cacheBytes / 20),
      logger: remuxLogger,
    });
    // A failed start (ffmpeg missing) is tried again on the next request.
    started.catch(() => {
      if (service?.started === started) service = undefined;
    });
    service = { key, started };
  }
  return service.started;
}

/**
 * One HLS path of a usenet stream: `master.m3u8`, a media playlist, an init
 * segment or a segment, rendered on demand. The token is the stream URL's, and
 * the only credential.
 */
export async function serveHls(
  token: string,
  parts: string[],
  opts: { clientIp?: string; signal?: AbortSignal }
): Promise<ServedFile> {
  const decoded = decodeUsenetStreamToken(token);
  if (!decoded) throw new NotFoundError('invalid or tampered token');
  const { sourceId, fileId } = idsOf(decoded);
  const key = `${sourceId}/${fileId}`;
  // Re-inserted, so the map runs oldest first.
  readers.delete(key);
  readers.set(key, {
    token: decoded,
    clientIp: opts.clientIp,
    seenAt: Date.now(),
  });
  if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value!);
  const hls = await hlsService();
  return hls.resolve(sourceId, fileId, parts, opts.signal);
}

export async function closeHls(): Promise<void> {
  const started = service?.started;
  service = undefined;
  (await started?.catch(() => undefined))?.close();
}
