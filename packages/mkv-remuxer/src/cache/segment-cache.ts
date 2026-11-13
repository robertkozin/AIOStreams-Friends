import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, type Logger } from '../logger.js';
import { TEMP_SUFFIX, touchFile } from '../util/fs.js';
import { createSizeLru } from '../util/lru.js';
import { isSegmentFile } from './cache-layout.js';

/**
 * LRU over finished segment files. Disk is the record: the index is rebuilt
 * from file mtimes at startup.
 */
export function createSegmentCache(
  root: string,
  budgetBytes: number,
  logger: Logger,
) {
  const lru = createSizeLru<string>(budgetBytes);

  const load = async (): Promise<void> => {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    const segments: { file: string; bytes: number; mtimeMs: number }[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const file = path.join(entry.parentPath, entry.name);
      if (entry.name.endsWith(TEMP_SUFFIX)) {
        await rm(file, { force: true });
      } else if (isSegmentFile(entry.name)) {
        const info = await stat(file).catch(() => {});
        if (info) {
          segments.push({ file, bytes: info.size, mtimeMs: info.mtimeMs });
        }
      }
    }

    // Only mtime survives a restart, so it gives the LRU its starting order.
    segments.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { file, bytes, mtimeMs } of segments) {
      lru.set(file, bytes, mtimeMs);
    }
    await trim();
    logger.info('Segment cache loaded', {
      segments: segments.length,
      bytes: lru.size,
    });
  };

  const added = async (file: string): Promise<void> => {
    const { size } = await stat(file);
    lru.set(file, size);
    await trim();
  };

  const touch = (file: string): void => {
    lru.touch(file);
    touchFile(file);
  };

  // Drops bookkeeping only. The caller deletes the directory.
  const forgetUnder = (dir: string): void => {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    for (const file of lru.keys()) {
      if (file.startsWith(prefix)) {
        lru.delete(file);
      }
    }
  };

  const oldestUsedAt = (): number | undefined => {
    return lru.oldest()?.usedAt;
  };

  const evictOldest = async (bytes: number): Promise<number> => {
    const before = lru.size;
    for (const file of lru.trimTo(Math.max(0, before - bytes))) {
      await rm(file, { force: true }).catch(() => {});
    }

    return before - lru.size;
  };

  const trim = async (): Promise<void> => {
    for (const file of lru.trim()) {
      await rm(file, { force: true }).catch((err: unknown) => {
        logger.warn('Could not delete evicted segment', {
          file,
          error: errorMessage(err),
        });
      });
    }
  };

  return {
    get usedBytes(): number {
      return lru.size;
    },
    load,
    added,
    touch,
    forgetUnder,
    oldestUsedAt,
    evictOldest,
  };
}

export type SegmentCache = ReturnType<typeof createSegmentCache>;
