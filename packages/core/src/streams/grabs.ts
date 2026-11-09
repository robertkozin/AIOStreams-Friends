import type { ParsedStream } from '../db/schemas.js';

/** Grabs at which the evidence factor halves a stream's popularity. */
const GRAB_EVIDENCE = 3;
const HOURS_PER_DAY = 24;

/** Grabs per square root of age in days, the age floored at a day. */
const grabRate = (grabs: number, ageHours: number) =>
  grabs / Math.sqrt(Math.max(ageHours / HOURS_PER_DAY, 1));

/**
 * Score each stream from 0 to 1 by its grab rate against the highest rate on
 * its indexer, since raw counts aren't comparable between indexers of
 * different sizes, then discount results with few grabs behind them. Runs on
 * each fetched batch (a group of addons, or one addon under dynamic fetching)
 * before filtering and deduplication, so those don't shift the scale and
 * expressions can use the score. Needs both grabs and an age; other streams
 * get no score.
 */
export function applyGrabPopularity(streams: ParsedStream[]): void {
  const scored = streams.flatMap((stream) =>
    stream.grabs !== undefined && stream.age !== undefined
      ? [
          {
            stream,
            grabs: stream.grabs,
            indexer: stream.indexer ?? stream.addon.instanceId ?? '',
            rate: grabRate(stream.grabs, stream.age),
          },
        ]
      : []
  );
  const maxByIndexer = new Map<string, number>();
  for (const { indexer, rate } of scored) {
    maxByIndexer.set(indexer, Math.max(maxByIndexer.get(indexer) ?? 0, rate));
  }
  for (const { stream, grabs, indexer, rate } of scored) {
    const max = maxByIndexer.get(indexer) ?? 0;
    stream.grabPopularity =
      max > 0 ? (rate / max) * (grabs / (grabs + GRAB_EVIDENCE)) : 0;
  }
}

/**
 * The `grabs` / `grabPopularity` stream expression functions. A stream whose
 * indexer reports no grabs lies in no range, rather than counting as zero.
 */
export function grabsInRange(field: 'grabs' | 'grabPopularity') {
  return function (streams: ParsedStream[], min?: number, max?: number) {
    if (!Array.isArray(streams) || streams.some((stream) => !stream.type)) {
      throw new Error('Your streams input must be an array of streams');
    } else if (typeof min !== 'number' && typeof max !== 'number') {
      throw new Error(`Min and max ${field} must be a number`);
    } else if (
      typeof min === 'number' &&
      typeof max === 'number' &&
      max < min
    ) {
      throw new Error(`Max ${field} cannot be less than min ${field}`);
    }
    return streams.filter((stream) => {
      const value = stream[field];
      if (value === undefined) return false;
      if (typeof min === 'number' && value < min) return false;
      if (typeof max === 'number' && value > max) return false;
      return true;
    });
  };
}
