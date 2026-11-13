import { AbandonedError } from '../errors.js';
import type { Logger } from '../logger.js';

export const Priority = { Foreground: 0, Background: 1 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

// Waiting improves a task's score by one point per interval, so an old
// task eventually beats a fresher one that scores better.
const SCORE_AGING_MS = 5000;

export type TaskContext = {
  signal: AbortSignal;
  waitedMs: number;
  promoted: Promise<void>;
};

/** key groups tasks for promote() and abandon(). */
type TaskSpec = {
  key: string;
  priority: Priority;
  stopIfNotPromoted?: boolean;
};

type Entry = TaskSpec & {
  seq: number;
  queuedAt: number;
  start: () => void;
  cancel: (reason: Error) => void;
  abandonTimer?: NodeJS.Timeout;
};

type RunningTask = {
  key: string;
  priority: Priority;
  stopIfNotPromoted: boolean;
  abort: AbortController;
  promotion: PromiseWithResolvers<void>;
};

type KeyGroups<T> = Map<string, Set<T>>;

export function createTaskQueue(
  concurrency: number,
  mustPromoteInS: number,
  logger: Logger,
) {
  const waiting = new Set<Entry>();
  const runningTasks = new Set<RunningTask>();
  const waitingByKey: KeyGroups<Entry> = new Map();
  const runningByKey: KeyGroups<RunningTask> = new Map();
  // Background work never holds more than a third of the slots, so background jobs
  // cannot starve playback.
  const backgroundLimit = Math.max(1, Math.floor(concurrency / 3));
  let seq = 0;
  let backgroundRunning = 0;
  let abortedRunning = 0;

  const needPromotion = new Map<string, NodeJS.Timeout>();

  const run = <T>(
    spec: TaskSpec,
    task: (context: TaskContext) => Promise<T>,
  ): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        ...spec,
        seq: seq++,
        queuedAt: Date.now(),
        // Cancelling a task that has not started rejects the caller's
        // promise; the task function never runs.
        cancel: reject,
        start: () => {
          const running: RunningTask = {
            key: entry.key,
            priority: entry.priority,
            stopIfNotPromoted: entry.stopIfNotPromoted ?? false,
            abort: new AbortController(),
            promotion: Promise.withResolvers<void>(),
          };
          if (running.priority === Priority.Foreground) {
            running.promotion.resolve();
          } else {
            backgroundRunning++;
          }
          runningTasks.add(running);
          addToKey(runningByKey, running.key, running);
          running.abort.signal.addEventListener(
            'abort',
            () => {
              reject(running.abort.signal.reason);
            },
            { once: true },
          );

          Promise.resolve()
            .then(() =>
              task({
                signal: running.abort.signal,
                waitedMs: Date.now() - entry.queuedAt,
                promoted: running.promotion.promise,
              }),
            )
            .then(resolve, reject)
            .finally(() => {
              runningTasks.delete(running);
              removeFromKey(runningByKey, running.key, running);
              if (running.priority === Priority.Background) {
                backgroundRunning--;
              }
              if (running.abort.signal.aborted) {
                abortedRunning--;
              }
              if (needPromotion.get(entry.key) === entry.abandonTimer) {
                stopAbandonTimer(entry.key);
              }
              drain();
            });
        },
      };
      if (entry.priority === Priority.Background && entry.stopIfNotPromoted) {
        entry.abandonTimer = abandonNotPromoted(entry.key);
      }
      waiting.add(entry);
      addToKey(waitingByKey, entry.key, entry);
      drain();
    });
  };

  const abandonNotPromoted = (key: string): NodeJS.Timeout => {
    stopAbandonTimer(key);
    const timer = setTimeout(() => {
      needPromotion.delete(key);
      logger.debug(
        `Abandoning ${key} after ${mustPromoteInS * 1000} - not promoted`,
      );
      abandon(key);
    }, mustPromoteInS * 1000);
    needPromotion.set(key, timer);

    return timer;
  };

  const refreshAbandonTimer = (key: string) => {
    needPromotion.get(key)?.refresh();
  };

  const stopAbandonTimer = (key: string) => {
    needPromotion.get(key)?.close();
    needPromotion.delete(key);
  };

  /**
   * Raises every task under key to foreground. A task already in foreground
   * keeps the better of the two scores, so promotion never demotes it.
   */
  const promote = (key: string): void => {
    for (const entry of waitingByKey.get(key) ?? []) {
      entry.priority = Priority.Foreground;
    }
    for (const task of runningByKey.get(key) ?? []) {
      if (task.priority === Priority.Background) {
        backgroundRunning--;
      }
      task.priority = Priority.Foreground;
      task.promotion.resolve();
    }
    stopAbandonTimer(key);
    drain();
  };

  /**
   * Drops queued tasks under key and aborts running ones. keepWarmOnly limits
   * this to background tasks queued with stopIfNotPromoted, leaving foreground
   * work and other background jobs untouched.
   */
  const abandon = (key: string, keepWarmOnly = false, reason?: Error): void => {
    if (
      abandonWaiting(key, keepWarmOnly, reason) +
      abandonRunning(key, keepWarmOnly, reason)
    ) {
      stopAbandonTimer(key);
      drain();
    }
  };

  const abandonWaiting = (
    key: string,
    keepWarmOnly = false,
    reason?: Error,
  ) => {
    let abandonedTasks = 0;
    const group = [...(waitingByKey.get(key) ?? [])];
    for (let i = group.length - 1; i >= 0; i--) {
      const entry = group[i]!;
      if (shouldAbandon(entry, keepWarmOnly)) {
        ++abandonedTasks;
        waiting.delete(entry);
        removeFromKey(waitingByKey, key, entry);
        entry.cancel(
          reason ?? new AbandonedError(`Nobody is waiting for ${key}`),
        );
      }
    }

    return abandonedTasks;
  };

  const abandonRunning = (
    key: string,
    keepWarmOnly = false,
    reason?: Error,
  ) => {
    let abandonedTasks = 0;
    for (const task of runningByKey.get(key) ?? []) {
      if (shouldAbandon(task, keepWarmOnly) && !task.abort.signal.aborted) {
        ++abandonedTasks;
        abortedRunning++;
        task.abort.abort(
          reason ?? new AbandonedError(`Nobody is waiting for ${key}`),
        );
      }
    }

    return abandonedTasks;
  };

  const drain = (): void => {
    while (runningTasks.size < concurrency) {
      const next = pickNext();
      if (!next) {
        break;
      }
      waiting.delete(next);
      removeFromKey(waitingByKey, next.key, next);
      next.start();
    }
    preempt();
  };

  // Slots that are already draining count against waiting demand, so two
  // foreground tasks never abort three runners between them.
  const preempt = (): void => {
    let stoppingAnywhere = abortedRunning;

    for (const entry of waiting) {
      if (entry.priority !== Priority.Foreground) {
        continue;
      }
      if (runningTasks.size < concurrency) {
        continue;
      }

      if (stoppingAnywhere > 0) {
        stoppingAnywhere--;
        continue;
      }

      const victim = pickVictim();
      if (victim) {
        abortedRunning++;
        victim.abort.abort(
          new AbandonedError(`Nobody is waiting for ${victim.key}`),
        );
      }
    }
  };

  // Background runners go first. Among foreground runners only one that scores
  // worse than the newcomer is taken, so equal scores do not thrash.
  const pickVictim = (): RunningTask | undefined => {
    for (const task of runningTasks) {
      if (task.abort.signal.aborted) {
        continue;
      }
      if (task.priority === Priority.Background) {
        return task;
      }
    }
  };

  const pickNext = (): Entry | undefined => {
    // Order: foreground first, then arrival.
    const backgroundAllowed = backgroundRunning < backgroundLimit;
    const now = Date.now();
    const score = (entry: Entry) =>
      Math.floor((now - entry.queuedAt) / SCORE_AGING_MS);
    let best: Entry | undefined;
    let bestScore = 0;

    for (const entry of waiting) {
      if (entry.priority === Priority.Background && !backgroundAllowed) {
        continue;
      }
      const entryScore = score(entry);
      if (
        !best ||
        entry.priority < best.priority ||
        (entry.priority === best.priority &&
          (entryScore < bestScore ||
            (entryScore === bestScore && entry.seq < best.seq)))
      ) {
        best = entry;
        bestScore = entryScore;
      }
    }

    return best;
  };

  return {
    get stats() {
      return {
        running: runningTasks.size,
        runningBackground: backgroundRunning,
        queued: waiting.size,
      };
    },
    run,
    refreshAbandonTimer,
    promote,
    abandon,
  };
}

export type TaskQueue = ReturnType<typeof createTaskQueue>;

function addToKey<T>(groups: KeyGroups<T>, key: string, item: T): void {
  const group = groups.get(key);
  if (group) {
    group.add(item);
  } else {
    groups.set(key, new Set([item]));
  }
}

function removeFromKey<T>(groups: KeyGroups<T>, key: string, item: T): void {
  const group = groups.get(key)!;
  group.delete(item);
  if (group.size === 0) {
    groups.delete(key);
  }
}

function shouldAbandon(task: Entry | RunningTask, keepWarmOnly: boolean) {
  return (
    !keepWarmOnly ||
    (task.priority === Priority.Background && task.stopIfNotPromoted)
  );
}
