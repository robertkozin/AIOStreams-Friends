import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { masterPlaylist } from '../src/hls/playlists.js';
import { Remuxer } from '../src/hls/remux.js';
import { silentLogger } from '../src/logger.js';
import {
  encodeElement,
  encodeUint,
  readElementHeader,
} from '../src/matroska/ebml.js';
import { Id } from '../src/matroska/ids.js';
import { parseTracks, type MkvTrack } from '../src/matroska/tracks.js';
import { getRenditions } from '../src/media/codecs.js';
import { buildMediaIndex, type MediaIndex } from '../src/media/media-index.js';
import {
  ffmpeg,
  FFMPEG,
  fileSource,
  hasFfmpeg,
  probeSegment,
  tempDir,
} from './helpers.js';

/**
 * A Dolby Vision decoder configuration record (24 bytes): version 1.0, then
 * 7 bits of profile, 6 of level, the RPU, EL and BL presence flags, and 4
 * bits of base layer compatibility.
 */
function dvConfig(profile: number, level: number, compatibility: number) {
  const record = Buffer.alloc(24);
  record[0] = 1;
  record.writeUInt16BE((profile << 9) | (level << 3) | 0b101, 2);
  record[4] = compatibility << 4;
  return record;
}

/** The track with a BlockAdditionMapping added, as mkvmerge writes one. */
function withDolbyVision(
  track: MkvTrack,
  profile: number,
  level: number,
  compatibility: number,
): MkvTrack {
  const entry = Buffer.from(track.entry, 'base64');
  const header = readElementHeader(entry, 0)!;
  const fourcc = profile > 7 ? 'dvvC' : 'dvcC';
  const mapping = encodeElement(
    Id.BlockAdditionMapping,
    Buffer.concat([
      encodeElement(
        Id.BlockAddIDType,
        encodeUint(Buffer.from(fourcc).readUInt32BE(0)),
      ),
      encodeElement(
        Id.BlockAddIDExtraData,
        dvConfig(profile, level, compatibility),
      ),
    ]),
  );
  const tracks = encodeElement(
    Id.Tracks,
    encodeElement(
      Id.TrackEntry,
      Buffer.concat([entry.subarray(header.headerLength), mapping]),
    ),
  );
  const tracksHeader = readElementHeader(tracks, 0)!;
  const [parsed] = parseTracks(tracks, {
    id: Id.Tracks,
    start: 0,
    dataStart: tracksHeader.headerLength,
    dataEnd: tracks.length,
  });
  return parsed!;
}

const withVideo = (index: MediaIndex, video: MkvTrack): MediaIndex => ({
  ...index,
  tracks: index.tracks.map((t) => (t.number === video.number ? video : t)),
});

describe.skipIf(!hasFfmpeg)('Dolby Vision on a generated HDR10 file', () => {
  let tmp: Awaited<ReturnType<typeof tempDir>>;
  let file: string;
  let index: MediaIndex;
  let hdr10: MkvTrack;
  const remuxer = new Remuxer({
    ffmpegPath: FFMPEG,
    timeoutMs: 30_000,
    audioReadFromKeyframe: false,
    logger: silentLogger,
  });

  beforeAll(async () => {
    tmp = await tempDir();
    file = path.join(tmp.dir, 'hdr10.mkv');
    await ffmpeg([
      ...['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4'],
      ...['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le'],
      '-x265-params',
      'log-level=error:keyint=48:min-keyint=48:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
      file,
    ]);
    index = await buildMediaIndex(fileSource(file), 'hdr10.mkv', 2);
    hdr10 = index.tracks.find((t) => t.number === index.videoTrack)!;
  }, 60_000);

  afterAll(async () => {
    remuxer.killAll();
    await tmp?.remove();
  });

  const variants = (index: MediaIndex) =>
    masterPlaylist(index, getRenditions(index), '')
      .split('\n')
      .filter((l) => l.startsWith('#EXT-X-STREAM-INF'));

  /** The init segment ffmpeg writes for the index's video. */
  async function init(index: MediaIndex, name: string): Promise<Buffer> {
    const out = path.join(tmp.dir, `${name}-init.mp4`);
    await remuxer.writeInit(index, getRenditions(index).video, out);
    return readFile(out);
  }

  test('reads the configuration record', () => {
    expect(withDolbyVision(hdr10, 8, 6, 1).dolbyVision).toEqual({
      profile: 8,
      level: 6,
      compatibility: 1,
    });
    expect(withDolbyVision(hdr10, 5, 9, 0).dolbyVision).toEqual({
      profile: 5,
      level: 9,
      compatibility: 0,
    });
  });

  test('plain HDR10 offers PQ and an SDR fallback', () => {
    expect(hdr10.dolbyVision).toBeUndefined();
    const [pq, sdr] = variants(index);
    expect(pq).toContain('VIDEO-RANGE=PQ');
    expect(pq).not.toContain('SUPPLEMENTAL-CODECS');
    expect(sdr).toContain('VIDEO-RANGE=SDR');
  });

  test('profile 8.1 keeps hvc1 and names Dolby Vision as supplemental', async () => {
    const dv = withVideo(index, withDolbyVision(hdr10, 8, 6, 1));
    const [pq, sdr] = variants(dv);
    expect(pq).toMatch(/CODECS="hvc1\./);
    expect(pq).toContain('SUPPLEMENTAL-CODECS="dvh1.08.06/db1p"');
    expect(pq).toContain('VIDEO-RANGE=PQ');
    expect(sdr).toContain('VIDEO-RANGE=SDR');

    const box = await init(dv, 'p8');
    expect(box.includes('hvc1')).toBe(true);
    expect(box.includes('dvvC')).toBe(true);
  });

  test('profile 5 is dvh1 and PQ only', async () => {
    const dv = withVideo(index, withDolbyVision(hdr10, 5, 6, 0));
    expect(variants(dv)).toEqual([
      expect.stringMatching(/CODECS="dvh1\.05\.06".*VIDEO-RANGE=PQ/),
    ]);

    const box = await init(dv, 'p5');
    expect(box.includes('dvh1')).toBe(true);
    expect(box.includes('dvcC') || box.includes('dvvC')).toBe(true);
  });

  test('renders Dolby Vision segments', async () => {
    const dv = withVideo(index, withDolbyVision(hdr10, 8, 6, 1));
    const rendition = getRenditions(dv).video;
    const initPath = path.join(tmp.dir, 'seg-init.mp4');
    const segment = path.join(tmp.dir, 'seg-1.m4s');
    await remuxer.writeInit(dv, rendition, initPath);
    await remuxer.writeSegment(
      { index: dv, source: fileSource(file), rendition },
      1,
      segment,
    );
    const streams = await probeSegment(tmp.dir, initPath, segment);
    expect(streams).toMatchObject([{ codec_name: 'hevc' }]);
  });
});
