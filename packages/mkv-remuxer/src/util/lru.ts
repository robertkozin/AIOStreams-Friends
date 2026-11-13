type Entry = {
  bytes: number;
  usedAt: number;
};

export type KeyPredicate<K> = (key: K) => boolean;

/**
 * Byte-budgeted LRU. Map iteration order is insertion order, so the head is
 * the least recently used entry and touch() re-inserts to move a key to the tail.
 */
export function createSizeLru<K>(budgetBytes: number) {
  const entries = new Map<K, Entry>();
  let totalBytes = 0;

  const set = (key: K, bytes: number, usedAt = Date.now()): void => {
    remove(key);
    entries.set(key, { bytes, usedAt });
    totalBytes += bytes;
  };

  const resize = (key: K, bytes: number): void => {
    const entry = entries.get(key)!;
    totalBytes += bytes - entry.bytes;
    entry.bytes = bytes;
  };

  const touch = (key: K): void => {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    entries.delete(key);
    entry.usedAt = Date.now();
    entries.set(key, entry);
  };

  const has = (key: K): boolean => {
    return entries.has(key);
  };

  const keys = (): K[] => {
    return [...entries.keys()];
  };

  const remove = (key: K): boolean => {
    const entry = entries.get(key);
    if (!entry) {
      return false;
    }
    entries.delete(key);
    totalBytes -= entry.bytes;

    return true;
  };

  const oldest = (
    isPinned: KeyPredicate<K> = () => false,
  ): { key: K; bytes: number; usedAt: number } | undefined => {
    for (const [key, entry] of entries) {
      if (!isPinned(key)) {
        return { key, bytes: entry.bytes, usedAt: entry.usedAt };
      }
    }

    return undefined;
  };

  /**
   * Evicts from the head until the byte budget holds and returns the evicted
   * keys. Pinned keys are skipped, so the total can stay above budget.
   */
  const trim = (isPinned: KeyPredicate<K> = () => false): K[] => {
    return trimTo(budgetBytes, isPinned);
  };

  const trimTo = (
    limit: number,
    isPinned: KeyPredicate<K> = () => false,
  ): K[] => {
    const removed: K[] = [];
    for (const [key, entry] of entries) {
      if (totalBytes <= limit) {
        break;
      }
      if (isPinned(key)) {
        continue;
      }
      entries.delete(key);
      totalBytes -= entry.bytes;
      removed.push(key);
    }

    return removed;
  };

  return {
    get size(): number {
      return totalBytes;
    },
    set,
    resize,
    touch,
    has,
    keys,
    delete: remove,
    oldest,
    trim,
    trimTo,
  };
}
