import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createCacheLayout, type CacheLayout } from '../cache/cache-layout.js';
import {
  createDiskGuard,
  type CacheUsage,
  type DiskGuard,
  type HostStore,
} from '../cache/disk-guard.js';
import { createInterleavingNotes } from '../cache/interleaving-notes.js';
import {
  createMetadataCache,
  type MetadataCache,
} from '../cache/metadata-cache.js';
import {
  createSegmentCache,
  type SegmentCache,
} from '../cache/segment-cache.js';
import { AbandonedError, MediaTimeoutError, NotFoundError } from '../errors.js';
import type {
  SourceFile,
  SourceListing,
  SourceProvider,
} from '../io/byte-source.js';
import { errorMessage, silentLogger, type Logger } from '../logger.js';
import { withTimeout } from '../util/async.js';
import { exists } from '../util/fs.js';
import { createSingleFlight } from '../util/single-flight.js';
import {
  createTaskQueue,
  Priority,
  type TaskQueue,
} from '../util/task-queue.js';
import type { Asset, MasterUriPrefix } from './asset.js';
import { createAssetRegistry, MEDIA_FILE } from './asset-registry.js';
import { checkFfmpeg } from './ffmpeg.js';
import { renditionPath, segmentFileName } from './playlists.js';
import { createRemuxer, type AacCoder, type Remuxer } from './remux.js';
import { createWarmQueue } from './warm-queue.js';

export type HlsServiceOptions = {
  cacheDir: string;
  provider: SourceProvider;
  ffmpegPath?: string;
  segmentDuration?: number;
  keepWarmS?: number;
  warmSegments?: number;
  warmConcurrency?: number;
  requestTimeoutMs?: number;
  maxConcurrentJobs?: number;
  jobTimeoutMs?: number;
  audioReadFromKeyframe?: boolean;
  /** Ignored here: audio browsers can't play is always served as AAC. */
  aacFallback?: boolean;
  aacCoder?: AacCoder;
  segmentCacheBytes?: number;
  metadataCacheBytes?: number;
  cacheTotalBytes?: number;
  cacheSweepMs?: number;
  /**
   * Directories the host keeps under its own budget but wants counted toward
   * `cacheTotalBytes`, keyed by a name used in `CacheUsage.stores`.
   */
  hostStores?: Record<string, HostStore>;
  /**
   * A host directory with one subdirectory per source id. Each subdirectory
   * counts as that source's metadata and is deleted when the source is evicted.
   */
  hostDataDir?: string;
  /**
   * Prepended to the rendition URIs in a master playlist. The default, `''`,
   * resolves them against the master's own URL, which suits a master served
   * through `resolve(sourceId, fileId, ['master.m3u8'])`. Set it when the
   * master is served from somewhere else.
   */
  masterUriPrefix?: MasterUriPrefix;
  logger?: Logger;
};

export type ServedFile = {
  path: string;
  contentType: string;
  cacheControl: string;
  dropped?: AbortSignal | undefined;
};

export type WarmStatus = {
  ready: boolean;
  queued: boolean;
  warming: boolean;
  pending: number;
  full: boolean;
};

export type PlayableFile = SourceFile & {
  playable: boolean;
};

export type FileListing = {
  files: PlayableFile[];
};

export type JobStats = {
  running: number;
  runningBackground: number;
  queued: number;
};

export type HlsStatus = {
  jobs: JobStats;
  segmentCacheBytes: number;
  cache: CacheUsage;
};

/**
 * HLS over the media files of the sources a `SourceProvider` serves. Every
 * media URL has the shape `<sourceId>/<fileId>/<parts...>`; route it to
 * `resolve`.
 */
export type HlsService = {
  /**
   * The master playlist of `fileId`, or of the source's first media file
   * when it is omitted. Builds the index and playlists on first use.
   */
  master(
    sourceId: string,
    fileId?: string,
    signal?: AbortSignal,
  ): Promise<ServedFile>;
  /** Starts rendering the opening of a file in the background. */
  warm(sourceId: string, fileId?: string): Promise<WarmStatus>;
  files(sourceId: string, signal?: AbortSignal): Promise<FileListing>;
  /** Maps one media URL path to a file on disk, rendering it if needed. */
  resolve(
    sourceId: string,
    fileId: string,
    parts: string[],
    signal?: AbortSignal,
  ): Promise<ServedFile>;
  status(): HlsStatus;
  /** Stops the cache sweep and kills running ffmpeg processes. */
  close(): void;
};

type HlsServiceDeps = {
  layout: CacheLayout;
  provider: SourceProvider;
  segments: SegmentCache;
  metadata: MetadataCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  guard: DiskGuard;
  segmentDuration: number;
  keepWarm: boolean;
  warmSegments: number;
  warmConcurrency: number;
  requestTimeoutMs: number;
  aacFallback: boolean;
  masterUriPrefix: MasterUriPrefix;
  logger: Logger;
};

const MIB = 1024 * 1024;

// Bump when the renditions or playlists made from the same index change. A
// cache written under another version is cleared on start, since its master
// playlists are served without reading the index again.
const CACHE_VERSION = 5;

const ID = /^[A-Za-z0-9_-]{1,128}$/u;

const SEGMENT_NAME = /^(\d+)\.(m4s|vtt)$/u;

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
// Files under a source id cannot change, so they cache indefinitely.
const PLAYLIST_CACHE = 'public, max-age=86400, immutable';
const MEDIA_CACHE = 'public, max-age=86400, immutable';

/** Creates the service: checks ffmpeg, loads the caches and starts sweeping. */
export async function createHlsService(
  options: HlsServiceOptions,
): Promise<HlsService> {
  const {
    cacheDir,
    provider,
    ffmpegPath = 'ffmpeg',
    segmentDuration = 2,
    keepWarmS = 5,
    warmSegments = 2,
    warmConcurrency = 4,
    requestTimeoutMs = 120_000,
    maxConcurrentJobs = 64,
    jobTimeoutMs = 180_000,
    audioReadFromKeyframe = true,
    aacFallback = false,
    aacCoder = 'fast',
    segmentCacheBytes = 15_360 * MIB,
    metadataCacheBytes = 2048 * MIB,
    cacheTotalBytes = segmentCacheBytes + metadataCacheBytes,
    cacheSweepMs = 300_000,
    hostStores = {},
    hostDataDir,
    masterUriPrefix = () => '',
    logger = silentLogger,
  } = options;

  await checkFfmpeg(ffmpegPath);

  const layout = createCacheLayout(cacheDir);
  await clearIfStale(layout, logger);
  await mkdir(layout.hlsDir, { recursive: true });

  const segments = createSegmentCache(
    layout.hlsDir,
    segmentCacheBytes,
    logger,
  );
  await segments.load();
  const remuxer = createRemuxer({
    ffmpegPath,
    timeoutMs: jobTimeoutMs,
    audioReadFromKeyframe,
    aacCoder,
    notes: createInterleavingNotes(layout, logger),
    logger,
  });
  await remuxer.restoreNotes();
  const metadata = createMetadataCache(layout, metadataCacheBytes, {
    logger,
    hostDataDir,
  });
  const queue = createTaskQueue(
    maxConcurrentJobs,
    keepWarmS ? Math.max(segmentDuration + 1, keepWarmS) : 0,
    logger,
  );
  const guard = createDiskGuard({
    layout,
    stores: hostStores,
    hostDataDir,
    segments,
    metadata,
    totalBytes: cacheTotalBytes,
    intervalMs: cacheSweepMs,
    inUse: () => provider.active?.() ?? new Set(),
    logger,
  });

  const service = createService({
    layout,
    provider,
    segments,
    metadata,
    remuxer,
    queue,
    guard,
    segmentDuration,
    keepWarm: !!keepWarmS,
    warmSegments,
    warmConcurrency,
    requestTimeoutMs,
    aacFallback,
    masterUriPrefix,
    logger,
  });
  guard.start();

  return service;
}

function createService(deps: HlsServiceDeps): HlsService {
  const flights = createSingleFlight();
  const registry = createAssetRegistry({
    layout: deps.layout,
    provider: deps.provider,
    segments: deps.segments,
    remuxer: deps.remuxer,
    queue: deps.queue,
    segmentDuration: deps.segmentDuration,
    warmSegments: deps.warmSegments,
    aacFallback: deps.aacFallback,
    masterUriPrefix: deps.masterUriPrefix,
    logger: deps.logger,
  });
  const warmQueue = createWarmQueue({
    concurrency: deps.warmConcurrency,
    warm: (sourceId, fileId) => warmUp(sourceId, fileId),
    logger: deps.logger,
  });

  const master = async (
    sourceId: string,
    fileParam?: string,
    signal?: AbortSignal,
  ): Promise<ServedFile> => {
    checkId(sourceId, 'source');
    deps.metadata.touch(sourceId);

    const fileId = await fileOrDefault(sourceId, fileParam);

    return servedMaster(sourceId, fileId, signal);
  };

  const warm = async (
    sourceId: string,
    fileId?: string,
  ): Promise<WarmStatus> => {
    checkId(sourceId, 'source');
    if (fileId !== undefined) {
      checkId(fileId, 'file');
    }
    deps.metadata.touch(sourceId);

    const ready = await alreadyWarm(sourceId, fileId);
    const queued = ready ? false : warmQueue.request(sourceId, fileId);
    const warming = queued || warmQueue.knows(sourceId, fileId);

    return {
      ready,
      queued,
      warming,
      pending: warmQueue.pending,
      full: !ready && !warming && warmQueue.full,
    };
  };

  const files = async (
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<FileListing> => {
    checkId(sourceId, 'source');
    const { metadata, provider } = deps;
    metadata.touch(sourceId);

    const key = `info:${sourceId}`;
    const info: SourceListing = await orTimeout(
      flights.run(key, signal, () => provider.list(sourceId)),
      `the file list of ${sourceId}`,
    );

    return {
      ...info,
      files: info.files.map((file) => ({
        id: file.id,
        name: file.name,
        length: file.length,
        playable: MEDIA_FILE.test(file.name),
      })),
    };
  };

  const resolve = async (
    sourceId: string,
    fileId: string,
    parts: string[],
    signal?: AbortSignal,
  ): Promise<ServedFile> => {
    checkId(sourceId, 'source');
    checkId(fileId, 'file');
    deps.provider.touch?.(sourceId);
    deps.metadata.touch(sourceId);

    if (parts.length === 1 && parts[0] === 'master.m3u8') {
      return servedMaster(sourceId, fileId, signal);
    }

    // Every part of the path comes from the client. The shape is checked here
    // and the names are checked against the asset before any file is opened.
    const [kind, ...rest] = parts;
    const [trackParam, name] =
      kind === 'video' && rest.length === 1
        ? [undefined, rest[0]]
        : (kind === 'audio' || kind === 'aac' || kind === 'subtitles') &&
            rest.length === 2
          ? rest
          : [];
    if (!kind || !name) {
      throw new NotFoundError(`Unsupported path "${parts.join('/')}"`);
    }
    const asset = await registry.get(sourceId, fileId);
    if (trackParam !== undefined && !/^\d+$/u.test(trackParam)) {
      throw new NotFoundError(`Invalid track "${trackParam}"`);
    }
    const rendition = asset.rendition(
      kind,
      trackParam === undefined ? undefined : Number(trackParam),
    );
    const file = path.join(asset.dirOf(rendition), name);
    const mediaType = rendition.type === 'audio' ? 'audio/mp4' : 'video/mp4';

    if (name === 'index.m3u8') {
      if (!(await exists(file))) {
        await orTimeout(
          asset.writePlaylists(),
          `the playlists for ${sourceId}/${fileId}`,
        );
      }

      return {
        path: file,
        contentType: PLAYLIST_TYPE,
        cacheControl: PLAYLIST_CACHE,
      };
    }

    if (name === 'init.mp4' && rendition.type !== 'subtitle') {
      await orTimeout(
        asset.ensureInit(rendition, file, Priority.Foreground, signal),
        `the init section of ${renditionPath(rendition)}`,
      );

      return {
        path: file,
        contentType: mediaType,
        cacheControl: MEDIA_CACHE,
      };
    }

    const segment = SEGMENT_NAME.exec(name);
    const n = Number(segment?.[1]);
    // Comparing against the name this rendition would generate rejects a vtt
    // asked of video, a padded number, and anything with extra characters.
    if (!segment || name !== segmentFileName(rendition, n)) {
      throw new NotFoundError(
        `Unexpected segment name "${name}" for ${renditionPath(rendition)}`,
      );
    }
    if (n >= asset.segmentCount) {
      throw new NotFoundError(
        `Segment ${n} is past the end of ${asset.index.fileName} (${asset.segmentCount} segments)`,
      );
    }

    if (!signal?.aborted) {
      const mainSegment = orTimeout(
        asset.ensureSegment(rendition, n, Priority.Foreground, signal),
        `segment ${n} of ${renditionPath(rendition)}`,
      );

      // Keep the source warm by quietly prefetching the next segment
      // Dropped after keepWarmS unless is promoted (requested)
      if (deps.keepWarm && n < asset.segmentCount - 1) {
        for (
          let i = n + 1;
          i < Math.min(n + 1 + deps.warmSegments, asset.segmentCount);
          i++
        ) {
          asset
            .ensureSegment(rendition, i, Priority.Background, signal, true)
            .catch((err) => {
              if (!(err instanceof AbandonedError)) {
                deps.logger.warn('Keep-warm render failed', {
                  rendition: renditionPath(rendition),
                  n: i,
                  error: errorMessage(err),
                });
              }
            });
        }
      }

      await mainSegment;
    }

    return {
      path: file,
      contentType:
        rendition.type === 'subtitle' ? 'text/vtt; charset=utf-8' : mediaType,
      cacheControl: MEDIA_CACHE,
    };
  };

  const status = (): HlsStatus => ({
    jobs: deps.queue.stats,
    segmentCacheBytes: deps.segments.usedBytes,
    cache: deps.guard.lastUsage,
  });

  const close = (): void => {
    deps.guard.stop();
    deps.remuxer.killAll();
  };

  const servedMaster = async (
    sourceId: string,
    fileId: string,
    signal: AbortSignal | undefined,
  ): Promise<ServedFile> => {
    const file = deps.layout.masterFile(sourceId, fileId);

    if (!(await exists(file))) {
      await orTimeout(
        publish(sourceId, fileId, Priority.Foreground, signal),
        `the playlists for ${sourceId}/${fileId}`,
      );
    }
    startEagerly(sourceId, fileId);

    return { path: file, contentType: PLAYLIST_TYPE, cacheControl: 'no-cache' };
  };

  const fileOrDefault = async (
    sourceId: string,
    fileId: string | undefined,
  ): Promise<string> => {
    const id = fileId ?? (await registry.defaultFileId(sourceId));
    checkId(id, 'file');

    return id;
  };

  const publish = async (
    sourceId: string,
    fileId: string,
    priority: Priority = Priority.Foreground,
    signal?: AbortSignal,
  ): Promise<Asset> => {
    const asset = await registry.get(sourceId, fileId, priority, signal);
    await asset.writePlaylists();

    return asset;
  };

  const startEagerly = (sourceId: string, fileId: string): void => {
    registry
      .get(sourceId, fileId)
      .then((asset) => {
        asset.eagerStart();
      })
      .catch(() => {});
  };

  const alreadyWarm = async (
    sourceId: string,
    fileId: string | undefined,
  ): Promise<boolean> => {
    const id = await fileOrDefault(sourceId, fileId);

    return exists(deps.layout.masterFile(sourceId, id));
  };

  // Renders the opening of the default tracks so a later play starts without
  // waiting for indexing and remux.
  const warmUp = async (
    sourceId: string,
    fileParam: string | undefined,
  ): Promise<void> => {
    const started = Date.now();
    deps.provider.warm?.(sourceId);
    const fileId = await fileOrDefault(sourceId, fileParam);
    const asset = await publish(sourceId, fileId, Priority.Background);

    const tracks = asset.openingTracks;
    for (const rendition of tracks) {
      await asset.ensureInit(
        rendition,
        path.join(asset.dirOf(rendition), 'init.mp4'),
        Priority.Background,
        undefined,
      );
    }
    const last = Math.min(deps.warmSegments, asset.segmentCount);
    for (let n = 0; n < last; n++) {
      for (const rendition of tracks) {
        await asset
          .ensureSegment(rendition, n, Priority.Background, undefined)
          .catch(() => {});
      }
    }
    deps.logger.info('Warmed a title', {
      sourceId,
      fileId,
      name: asset.index.fileName,
      segments: last,
      ms: Date.now() - started,
    });
  };

  // Bounds how long a client is held. The work behind it keeps running for
  // whoever asks next.
  const orTimeout = <T>(work: Promise<T>, what: string): Promise<T> =>
    withTimeout(work, deps.requestTimeoutMs, () => {
      const seconds = Math.round(deps.requestTimeoutMs / 1000);
      deps.logger.warn('Gave up waiting', {
        what,
        seconds,
        jobs: deps.queue.stats,
      });

      return new MediaTimeoutError(
        `Timed out after ${seconds}s producing ${what}`,
      );
    });

  return { master, warm, files, resolve, status, close };
}

async function clearIfStale(layout: CacheLayout, logger: Logger) {
  const version = await readFile(layout.versionFile(), 'utf8').catch(() => '');
  if (version.trim() === String(CACHE_VERSION)) {
    return;
  }
  if (version) {
    logger.info('Clearing media rendered by another cache version', {
      from: version.trim(),
      to: CACHE_VERSION,
    });
  }
  await rm(layout.hlsDir, { recursive: true, force: true });
  await mkdir(layout.root, { recursive: true });
  await writeFile(layout.versionFile(), String(CACHE_VERSION));
}

function checkId(id: string, what: 'source' | 'file'): void {
  if (!ID.test(id)) {
    throw new NotFoundError(`Invalid ${what} id "${id}"`);
  }
}
