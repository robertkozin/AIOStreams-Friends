import { spawn, type ChildProcess } from 'node:child_process';
import type { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { errorMessage } from '../logger.js';

export class FfmpegError extends Error {
  override name = 'FfmpegError';

  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(stderr ? `${message}: ${stderr.trim().split('\n').at(-1)}` : message);
  }
}

export type FfmpegOutput = Writable | [Transform, Writable];

type FfmpegRun = {
  args: string[];
  input?: AsyncIterable<Buffer> | Iterable<Buffer> | undefined;
  /** Where stdout goes: a destination, or a transform feeding one. */
  output?: FfmpegOutput | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
};

// Only the tail of stderr is kept. A failing run can log per frame, and
// the last lines are the ones that name the cause.
const STDERR_LIMIT = 16 * 1024;
// ffmpeg closing stdin early is normal once it has the frames it needs;
// the exit code decides whether the run failed.
const BROKEN_PIPE_CODES = new Set([
  'EPIPE',
  'EOF',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

export function createFfmpegSupervisor(ffmpegPath: string) {
  const running = new Set<ChildProcess>();

  const killAll = (): void => {
    for (const child of running) {
      child.kill('SIGKILL');
    }
  };

  const execute = async (run: FfmpegRun): Promise<void> => {
    run.signal?.throwIfAborted();

    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-nostats', '-loglevel', 'error', ...run.args],
      {
        stdio: [
          run.input ? 'pipe' : 'ignore',
          run.output ? 'pipe' : 'ignore',
          'pipe',
        ],
        windowsHide: true,
      },
    );
    running.add(child);

    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => {
      stderr = (stderr + text).slice(-STDERR_LIMIT);
    });

    let failure: unknown;
    let outputError: unknown;
    // The first reason recorded wins: the kill it triggers makes the child
    // exit non-zero, and that exit must not replace the real cause.
    const kill = (reason: unknown) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };

    const closed = new Promise<number | null>((resolve) => {
      child.once('error', (err) => {
        failure ??= err;
        running.delete(child);
        resolve(null);
      });
      child.once('close', (code) => {
        running.delete(child);
        resolve(code);
      });
    });

    const onAbort = () => {
      kill(run.signal!.reason);
    };
    run.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = run.timeoutMs
      ? setTimeout(() => {
          kill(
            new FfmpegError(
              `ffmpeg timed out after ${run.timeoutMs} ms`,
              stderr,
            ),
          );
        }, run.timeoutMs)
      : undefined;

    if (run.input) {
      pipeline(run.input, child.stdin!).catch((err: NodeJS.ErrnoException) => {
        if (!BROKEN_PIPE_CODES.has(err.code ?? '')) {
          kill(err);
        }
      });
    }

    const { output } = run;
    const writing = output
      ? (Array.isArray(output)
          ? pipeline(child.stdout!, ...output)
          : pipeline(child.stdout!, output)
        ).catch((err: unknown) => {
          outputError = err;
          child.kill('SIGKILL');
        })
      : Promise.resolve();

    try {
      const [code] = await Promise.all([closed, writing]);

      if (failure) {
        throw failure;
      }
      if (outputError) {
        throw outputError;
      }
      if (code !== 0 && code !== null) {
        throw new FfmpegError(`ffmpeg exited with code ${code}`, stderr);
      }
    } finally {
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
    }
  };

  return { killAll, run: execute };
}

export async function checkFfmpeg(ffmpegPath: string): Promise<void> {
  try {
    await createFfmpegSupervisor(ffmpegPath).run({ args: ['-version'] });
  } catch (err) {
    throw err instanceof FfmpegError
      ? err
      : new FfmpegError(errorMessage(err), '');
  }
}
