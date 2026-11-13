import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, type Logger } from '../logger.js';
import { markUsed } from '../util/fs.js';
import { createSizeLru, type KeyPredicate } from '../util/lru.js';
import { isSegmentFile, type CacheLayout } from './cache-layout.js';

// The used marker's mtime carries use order across restarts. Bump it at most
// this often: every touch costs a syscall.
const MARK_INTERVAL_MS = 60_000;

type MetadataCacheOptions = {
  logger: Logger;
  hostDataDir?: string | undefined;
};

/**
 * LRU over everything cached for a title except its segments: host data,
 * index and playlists. Dropping a title makes the next request rebuild them,
 * not the media.
 */
export function createMetadataCache(
  layout: CacheLayout,
  budgetBytes: number,
  options: MetadataCacheOptions,
) {
  const lru = createSizeLru<string>(budgetBytes);
  const marked = new Map<string, number>();

  const note = (sourceId: string, bytes: number, writtenAt: number): void => {
    // A title that grows keeps its place in the order; only a new one enters at
    // the time it was written.
    if (lru.has(sourceId)) {
      lru.resize(sourceId, bytes);
    } else {
      lru.set(sourceId, bytes, writtenAt);
    }
  };

  const touch = (sourceId: string): void => {
    lru.touch(sourceId);
    const now = Date.now();
    if (now - (marked.get(sourceId) ?? 0) < MARK_INTERVAL_MS) {
      return;
    }
    marked.set(sourceId, now);
    markUsed(layout.usedMarker(sourceId));
  };

  const keepOnly = (present: Set<string>): void => {
    for (const sourceId of lru.keys()) {
      if (!present.has(sourceId)) {
        lru.delete(sourceId);
        marked.delete(sourceId);
      }
    }
  };

  const oldestUsedAt = (isPinned: KeyPredicate<string>): number | undefined => {
    return lru.oldest(isPinned)?.usedAt;
  };

  const trimToBudget = (isPinned: KeyPredicate<string>): Promise<number> => {
    const before = lru.size;

    return remove(lru.trim(isPinned), before);
  };

  const evictOldest = (
    bytes: number,
    isPinned: KeyPredicate<string>,
  ): Promise<number> => {
    const before = lru.size;
    const target = Math.max(0, before - bytes);

    return remove(lru.trimTo(target, isPinned), before);
  };

  const remove = async (
    sourceIds: string[],
    before: number,
  ): Promise<number> => {
    for (const sourceId of sourceIds) {
      await deleteMetadata(sourceId);
      options.logger.info('Dropped the least recently used title', {
        sourceId,
      });
    }

    return before - lru.size;
  };

  // Leaves numbered segments behind for SegmentCache to account for and evict.
  const deleteMetadata = async (sourceId: string): Promise<void> => {
    const drop = async (file: string): Promise<void> => {
      await rm(file, { force: true, recursive: true }).catch((err: unknown) => {
        options.logger.warn('Could not delete cached metadata', {
          file,
          error: errorMessage(err),
        });
      });
    };

    if (options.hostDataDir) {
      await drop(path.join(options.hostDataDir, sourceId));
    }
    const media = path.join(layout.hlsDir, sourceId);
    const entries = await readdir(media, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && !isSegmentFile(entry.name)) {
        await drop(path.join(entry.parentPath, entry.name));
      }
    }
  };

  return {
    get usedBytes(): number {
      return lru.size;
    },
    note,
    touch,
    keepOnly,
    oldestUsedAt,
    trimToBudget,
    evictOldest,
  };
}

export type MetadataCache = ReturnType<typeof createMetadataCache>;
