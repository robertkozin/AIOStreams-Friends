import { errorMessage, type Logger } from '../logger.js';
import { readJson, writeFileAtomic } from '../util/fs.js';
import type { CacheLayout } from './cache-layout.js';

// Notes are a hint, not state worth keeping forever.
const MAX_FILES = 4096;
const SAVE_DELAY_MS = 2000;

/**
 * Remembers which files turned out to be loosely interleaved, so a later run
 * takes the wider read path without rediscovering it.
 */
export function createInterleavingNotes(layout: CacheLayout, logger: Logger) {
  let notedFiles: string[] = [];
  let timer: NodeJS.Timeout | undefined;

  const load = async (): Promise<string[]> => {
    notedFiles = (await readJson<string[]>(layout.interleavingFile())) ?? [];

    return [...notedFiles];
  };

  const save = (files: string[]): void => {
    notedFiles = files.slice(-MAX_FILES);
    clearTimeout(timer);
    timer = setTimeout(() => {
      void writeFileAtomic(
        layout.interleavingFile(),
        JSON.stringify(notedFiles),
      ).catch((err: unknown) => {
        logger.warn('Could not save interleaving notes', {
          error: errorMessage(err),
        });
      });
    }, SAVE_DELAY_MS);
    // Debounced and unref'd: a note lost at shutdown costs one rediscovery.
    timer.unref();
  };

  return { load, save };
}
