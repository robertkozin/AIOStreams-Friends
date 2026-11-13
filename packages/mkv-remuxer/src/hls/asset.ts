import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { CacheLayout } from '../cache/cache-layout.js';
import type { SegmentCache } from '../cache/segment-cache.js';
import { AbandonedError, NotFoundError } from '../errors.js';
import type { SourceProvider } from '../io/byte-source.js';
import type { Logger } from '../logger.js';
import { getRenditions, isPlayable, type Rendition } from '../media/codecs.js';
import { segmentCount, type MediaIndex } from '../media/media-index.js';
import { exists, writeFileAtomic } from '../util/fs.js';
import { createSingleFlight } from '../util/single-flight.js';
import {
  Priority,
  type TaskContext,
  type TaskQueue,
} from '../util/task-queue.js';
import {
  masterPlaylist,
  mediaPlaylist,
  renditionPath,
  segmentFileName,
} from './playlists.js';
import { initNeedsPacket, type Remuxer } from './remux.js';

// Past this, a player is waiting on job slots rather than on download
// speed. It is logged, never enforced.
const SLOW_QUEUE_WAIT_MS = 5000;

export type MasterUriPrefix = (sourceId: string, fileId: string) => string;

type AssetOptions = {
  sourceId: string;
  fileId: string;
  index: MediaIndex;
  layout: CacheLayout;
  provider: SourceProvider;
  segments: SegmentCache;
  remuxer: Remuxer;
  queue: TaskQueue;
  warmSegments: number;
  aacFallback: boolean;
  masterUriPrefix: MasterUriPrefix;
  logger: Logger;
};

export type Asset = ReturnType<typeof createAsset>;

/**
 * One (sourceId, fileId) pair: its media index, renditions, cache
 * directories, and the work that fills them.
 */
export function createAsset(options: AssetOptions) {
  const { index, sourceId, fileId } = options;
  const flights = createSingleFlight();
  const byPath = new Map<string, Rendition>();
  const sampleDir = options.layout.sampleDir(sourceId, fileId);
  const renditions = getRenditions(index);
  const all: Rendition[] = [
    renditions.video,
    ...renditions.audio,
    ...renditions.subtitles,
  ];
  const count = segmentCount(index);
  const openingAudio =
    renditions.audio.find(
      (track) => track.track.isDefault && isPlayable(track),
    ) ??
    renditions.audio.find((track) => isPlayable(track)) ??
    renditions.audio.find((track) => track.track.isDefault) ??
    renditions.audio[0];
  const openingTracks: Rendition[] = openingAudio
    ? [openingAudio, renditions.video]
    : [renditions.video];

  for (const rendition of all) {
    byPath.set(renditionPath(rendition), rendition);
  }

  const drop = (reason: Error): void => {
    for (const key of flights.keys()) {
      options.queue.abandon(key, false, reason);
    }
  };

  const dirOf = (rendition: Rendition): string =>
    options.layout.mediaFile(sourceId, fileId, renditionPath(rendition));

  const segmentPath = (rendition: Rendition, n: number): string =>
    path.join(dirOf(rendition), segmentFileName(rendition, n));

  const renditionOf = (kind: string, track: number | undefined): Rendition => {
    const found = byPath.get(track === undefined ? kind : `${kind}/${track}`);
    if (!found) {
      throw new NotFoundError(
        `${index.fileName} has no ${kind} rendition for track ${track}`,
      );
    }

    return found;
  };

  const writePlaylists = (): Promise<void> => {
    const { layout, masterUriPrefix } = options;

    return flights.run('playlists', undefined, async () => {
      for (const rendition of all) {
        const dir = dirOf(rendition);
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(
          path.join(dir, 'index.m3u8'),
          mediaPlaylist(index, rendition),
        );
      }

      await writeFileAtomic(
        layout.masterFile(sourceId, fileId),
        masterPlaylist(index, renditions, masterUriPrefix(sourceId, fileId)),
      );
    });
  };

  const ensureInit = async (
    rendition: Rendition,
    file: string,
    priority: Priority,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    if (signal?.aborted) {
      throw new AbandonedError(`Client is no more waiting for ${file}`);
    }

    if (await exists(file)) {
      return;
    }

    await mkdir(path.dirname(file), { recursive: true });

    const { queue, remuxer } = options;

    if (priority === Priority.Foreground) {
      queue.promote(file);
    }

    return flights.run(
      file,
      signal,
      async () => {
        await queue.run(
          {
            key: file,
            priority,
          },
          ({ signal: running }) => {
            const target = {
              index,
              rendition,
              signal: running,
              sampleDir,
            };
            if (!initNeedsPacket(rendition)) {
              return remuxer.writeInit(target, file);
            }

            return options.provider.lease(
              sourceId,
              fileId,
              {
                purpose: 'media',
                foreground: priority === Priority.Foreground,
              },
              async (source) => {
                try {
                  await remuxer.writeInit({ ...target, source }, file);
                } catch (err) {
                  source.release?.();
                  throw err;
                }
              },
            );
          },
        );
      },
      () => {
        queue.abandon(file);
      },
    );
  };

  const loadRemoteSegment = (
    file: string,
    rendition: Rendition,
    n: number,
    isForeground: boolean,
    { signal, waitedMs, promoted }: TaskContext,
  ) => {
    const { provider, remuxer, queue, segments, logger } = options;

    return provider.lease(
      sourceId,
      fileId,
      { purpose: 'media', foreground: isForeground },
      async (source) => {
        if (signal.aborted) {
          return;
        }

        if (waitedMs > SLOW_QUEUE_WAIT_MS) {
          logger.warn('Player waited for a free job slot', {
            rendition: renditionPath(rendition),
            n,
            waitedMs,
            jobs: queue.stats,
          });
        }

        const started = Date.now();

        void promoted.then(() => {
          source.promote?.();
        });

        source.onCorrupt?.((error) => {
          void rm(file, { force: true }).catch(() => {});
          queue.abandon(file, false, error);
        });

        await mkdir(path.dirname(file), { recursive: true });

        try {
          await remuxer.writeSegment(
            {
              index,
              source,
              rendition,
              signal,
              sampleDir,
            },
            n,
            file,
          );
        } catch (err) {
          source.release?.();
          throw err;
        }

        await segments.added(file);

        logger.debug('Rendered segment', {
          sourceId,
          rendition: renditionPath(rendition),
          n,
          background: !isForeground,
          waitedMs,
          ms: Date.now() - started,
        });
      },
    );
  };

  const ensureSegment = async (
    rendition: Rendition,
    n: number,
    priority: Priority,
    signal: AbortSignal | undefined,
    stopIfNotPromoted = false,
  ): Promise<void> => {
    const { queue, segments } = options;
    const file = segmentPath(rendition, n);

    if (await exists(file)) {
      segments.touch(file);

      return;
    }

    if (signal?.aborted) {
      throw new AbandonedError(`Client is not more waiting for ${file}`);
    }

    const isForeground = priority === Priority.Foreground;
    if (isForeground) {
      queue.promote(file);
    }

    queue.refreshAbandonTimer(file);

    const render = () =>
      flights.run(
        file,
        signal,
        () =>
          queue.run({ key: file, priority, stopIfNotPromoted }, (state) =>
            loadRemoteSegment(file, rendition, n, isForeground, state),
          ),
        () => {
          queue.abandon(file);
        },
      );

    try {
      await render();
    } catch (err) {
      if (err instanceof AbandonedError) {
        for (
          let i = n + 1;
          i < Math.min(n + 1 + options.warmSegments, count);
          i++
        ) {
          queue.abandon(segmentPath(rendition, i), true);
        }
      }

      throw err;
    }
  };

  const eagerStart = (): void => {
    for (const rendition of openingTracks) {
      const init = path.join(dirOf(rendition), 'init.mp4');
      ensureInit(rendition, init, Priority.Background, undefined).catch(() => {});
      if (count > 0) {
        ensureSegment(rendition, 0, Priority.Background, undefined).catch(() => {});
      }
    }
  };

  return {
    index,
    segmentCount: count,
    openingTracks,
    drop,
    dirOf,
    rendition: renditionOf,
    writePlaylists,
    ensureInit,
    ensureSegment,
    eagerStart,
  };
}
