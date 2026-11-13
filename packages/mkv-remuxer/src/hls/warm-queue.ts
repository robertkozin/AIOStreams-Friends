import { errorMessage, type Logger } from '../logger.js';

// Warming is speculative, so the backlog is bounded and further requests
// are refused rather than held.
const MAX_BACKLOG = 256;

type WarmRequest = {
  sourceId: string;
  fileId: string | undefined;
};

type WarmQueueOptions = {
  concurrency: number;
  warm: (sourceId: string, fileId: string | undefined) => Promise<void>;
  logger: Logger;
};

export function createWarmQueue(options: WarmQueueOptions) {
  const backlog: WarmRequest[] = [];
  const queued = new Set<string>();
  const running = new Set<string>();

  const knows = (sourceId: string, fileId: string | undefined): boolean => {
    const key = warmKey(sourceId, fileId);

    return running.has(key) || queued.has(key);
  };

  const isFull = (): boolean => {
    return backlog.length >= MAX_BACKLOG;
  };

  const request = (sourceId: string, fileId: string | undefined): boolean => {
    if (knows(sourceId, fileId)) {
      return false;
    }
    if (isFull()) {
      options.logger.debug('Warm backlog is full; refused a title', {
        sourceId,
      });

      return false;
    }
    backlog.push({ sourceId, fileId });
    queued.add(warmKey(sourceId, fileId));
    pump();

    return true;
  };

  const pump = (): void => {
    while (running.size < options.concurrency && backlog.length > 0) {
      const next = backlog.shift()!;
      const key = warmKey(next.sourceId, next.fileId);
      queued.delete(key);
      running.add(key);
      options
        .warm(next.sourceId, next.fileId)
        .catch((err: unknown) => {
          // A warm failure costs a cold first play and nothing else.
          options.logger.warn('Could not warm a title', {
            sourceId: next.sourceId,
            error: errorMessage(err),
          });
        })
        .finally(() => {
          running.delete(key);
          pump();
        });
    }
  };

  return {
    get pending(): number {
      return backlog.length;
    },
    knows,
    get full(): boolean {
      return isFull();
    },
    request,
  };
}

// An undefined fileId means the default file of the source. A colon never
// appears in an id, so the key cannot clash with a real file.
function warmKey(sourceId: string, fileId: string | undefined): string {
  return `${sourceId}/${fileId ?? ':default'}`;
}
