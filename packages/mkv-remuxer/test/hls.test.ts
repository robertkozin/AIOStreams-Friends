import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createHlsService, type HlsService } from '../src/index.js';
import {
  ffmpeg,
  FFMPEG,
  fileProvider,
  hasFfmpeg,
  probeSegment,
  tempDir,
} from './helpers.js';

// Eight seconds of 320x180 H.264 with a keyframe every two, and audio in
// each way the remuxer handles it: transcoded (E-AC-3, AC-3) or copied (AAC,
// MP3, Opus). Tracks are numbered in this order, video first.
const AUDIO = [
  { codec: 'eac3', channels: 6, language: 'eng', title: 'English DD+' },
  { codec: 'ac3', channels: 6, language: 'rus', title: 'Russian DD' },
  { codec: 'aac', channels: 2, language: 'jpn', title: 'Japanese' },
  { codec: 'libmp3lame', channels: 2, language: 'fre', title: 'French' },
  { codec: 'libopus', channels: 2, language: 'ger', title: 'German' },
];
const SUBTITLE_TRACK = AUDIO.length + 2;
const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello from the test\n';

async function makeFixture(dir: string): Promise<string> {
  const srt = path.join(dir, 'subs.srt');
  await writeFile(srt, SRT);
  const file = path.join(dir, 'fixture.mkv');
  await ffmpeg([
    ...['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=8'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8'],
    ...['-i', srt],
    ...['-map', '0:v'],
    ...AUDIO.flatMap(() => ['-map', '1:a']),
    ...['-map', '2:s'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
    ...['-g', '48', '-keyint_min', '48', '-sc_threshold', '0'],
    ...AUDIO.flatMap((a, i) => [
      `-c:a:${i}`,
      a.codec,
      `-ac:a:${i}`,
      String(a.channels),
      `-metadata:s:a:${i}`,
      `language=${a.language}`,
      `-metadata:s:a:${i}`,
      `title=${a.title}`,
      `-disposition:a:${i}`,
      i === 0 ? 'default' : '0',
    ]),
    ...['-c:s', 'srt', '-metadata:s:s:0', 'language=eng'],
    file,
  ]);
  return file;
}

describe.skipIf(!hasFfmpeg)('HLS remux of a generated file', () => {
  let tmp: Awaited<ReturnType<typeof tempDir>>;
  let hls: HlsService;
  let master: string;
  const resolve = async (...parts: string[]) =>
    (await hls.resolve('s', 'f', parts)).path;

  beforeAll(async () => {
    tmp = await tempDir();
    const file = await makeFixture(tmp.dir);
    hls = await createHlsService({
      ffmpegPath: FFMPEG,
      cacheDir: path.join(tmp.dir, 'cache'),
      provider: fileProvider(file),
      segmentDuration: 2,
      keepWarmS: 0,
    });
    master = await readFile(await resolve('master.m3u8'), 'utf8');
  }, 60_000);

  afterAll(async () => {
    hls?.close();
    await tmp?.remove();
  });

  const lines = (type: string) =>
    master.split('\n').filter((l) => l.startsWith(`#EXT-X-${type}`));

  test('lists every audio track in one group, in file order', () => {
    const audio = lines('MEDIA:TYPE=AUDIO');
    expect(audio).toHaveLength(AUDIO.length);
    expect(audio.every((l) => l.includes('GROUP-ID="audio"'))).toBe(true);
    expect(audio.map((l) => /LANGUAGE="([^"]*)"/.exec(l)?.[1])).toEqual([
      'en',
      'ru',
      'ja',
      'fr',
      'de',
    ]);
    expect(audio.map((l) => /URI="([^"]*)"/.exec(l)?.[1])).toEqual(
      AUDIO.map((_, i) => `audio/${i + 2}/index.m3u8`),
    );
  });

  test("makes the file's default audio the playlist's default", () => {
    expect(
      lines('MEDIA:TYPE=AUDIO').map((l) => /DEFAULT=(\w+)/.exec(l)?.[1]),
    ).toEqual(['YES', 'NO', 'NO', 'NO', 'NO']);
  });

  test('has one variant, naming AC-3 and E-AC-3 as AAC', () => {
    const variants = lines('STREAM-INF');
    expect(variants).toHaveLength(1);
    const codecs = /CODECS="([^"]*)"/.exec(variants[0]!)?.[1]?.split(',');
    expect(codecs?.[0]).toMatch(/^avc1\./);
    expect(codecs?.slice(1)).toEqual(['mp4a.40.2', 'mp4a.40.34', 'opus']);
    expect(variants[0]).toContain('SUBTITLES="subs"');
    expect(variants[0]).toContain('RESOLUTION=320x180');
  });

  test('cuts media playlists at the keyframes', async () => {
    const playlist = await readFile(
      await resolve('video', 'index.m3u8'),
      'utf8',
    );
    expect(playlist.match(/^#EXTINF:/gm)).toHaveLength(4);
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(playlist.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  test('renders video segments', async () => {
    const streams = await probeSegment(
      tmp.dir,
      await resolve('video', 'init.mp4'),
      await resolve('video', '1.m4s'),
    );
    expect(streams.map((s) => s.codec_name)).toEqual(['h264']);
  });

  test.each([
    [2, 'aac', 6],
    [3, 'aac', 6],
    [4, 'aac', 2],
    [5, 'mp3', 2],
    [6, 'opus', 2],
  ])('renders audio track %i as %s', async (number, codec, channels) => {
    const streams = await probeSegment(
      tmp.dir,
      await resolve('audio', String(number), 'init.mp4'),
      await resolve('audio', String(number), '1.m4s'),
    );
    expect(streams).toMatchObject([{ codec_name: codec, channels }]);
  });

  test('converts subtitles to WebVTT', async () => {
    const vtt = await readFile(
      await resolve('subtitles', String(SUBTITLE_TRACK), '0.vtt'),
      'utf8',
    );
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('Hello from the test');
  });
});
