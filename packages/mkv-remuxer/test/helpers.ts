import { execFile } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LeasedSource, SourceProvider } from '../src/io/byte-source.js';
import type { MkvTrack } from '../src/matroska/tracks.js';
import type { MediaIndex } from '../src/media/media-index.js';

const run = promisify(execFile);

export const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

/** Whether ffmpeg and ffprobe run here; the media tests skip without them. */
export const hasFfmpeg = await Promise.all([
  run(FFMPEG, ['-version']),
  run(FFPROBE, ['-version']),
]).then(
  () => true,
  () => false,
);

export async function tempDir(): Promise<{
  dir: string;
  remove: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mkv-remuxer-test-'));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

export async function ffmpeg(args: string[]): Promise<void> {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

export type ProbedStream = {
  codec_name: string;
  codec_type: string;
  codec_tag_string?: string;
  channels?: number;
  sample_rate?: string;
};

/** The streams of an init segment followed by one media segment. */
export async function probeSegment(
  dir: string,
  init: string,
  segment: string,
): Promise<ProbedStream[]> {
  const joined = path.join(
    dir,
    `probe-${path.basename(path.dirname(segment))}.mp4`,
  );
  await writeFile(
    joined,
    Buffer.concat([await readFile(init), await readFile(segment)]),
  );
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
    '-show_streams',
    '-of',
    'json',
    joined,
  ]);
  return (JSON.parse(stdout) as { streams: ProbedStream[] }).streams;
}

/** A local file as a byte source, as the host's providers are. */
export function fileSource(file: string): LeasedSource {
  const length = statSync(file).size;
  return {
    length,
    name: path.basename(file),
    stream: (start, end) => createReadStream(file, { start, end: end - 1 }),
  };
}

/** Serves one local file as file `f` of every source. */
export function fileProvider(file: string): SourceProvider {
  const source = fileSource(file);
  return {
    list: async () => ({
      files: [{ id: 'f', name: source.name, length: source.length }],
    }),
    lease: async (_sourceId, _fileId, _hint, work) => work(source),
  };
}

/** A track with Matroska's defaults, for tests that need no real file. */
export function track(fields: Partial<MkvTrack>): MkvTrack {
  return {
    number: 1,
    uid: '1',
    kind: 'video',
    codecId: 'V_MPEG4/ISO/AVC',
    language: 'eng',
    isDefault: false,
    isForced: false,
    isEnabled: true,
    entry: '',
    ...fields,
  };
}

/** An index over `tracks` with no media, for codec and playlist rules. */
export function index(tracks: MkvTrack[]): MediaIndex {
  return {
    version: 0,
    fileName: 'test.mkv',
    fileLength: 1_000_000,
    docType: 'matroska',
    timestampScale: 1_000_000,
    duration: 10,
    firstClusterOffset: 0,
    mediaEnd: 0,
    ebmlHeader: '',
    info: '',
    tracks,
    videoTrack: tracks.find((t) => t.kind === 'video')?.number ?? 0,
    keyframes: [],
    segmentStarts: [0],
    targetDuration: 6,
  };
}
