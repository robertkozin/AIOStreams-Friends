import { describe, expect, test } from 'vitest';

import { UnsupportedMediaError } from '../src/errors.js';
import {
  codecString,
  dolbyVisionMode,
  getRenditions,
  supplementalCodecString,
  type VideoRendition,
} from '../src/media/codecs.js';
import { index, track } from './helpers.js';

const video = track({ number: 1 });
const audio = (number: number, codecId: string, language = 'eng') =>
  track({ number, kind: 'audio', codecId, language, channels: 6 });

describe('getRenditions', () => {
  test('keeps every audio language', () => {
    const { audio: renditions } = getRenditions(
      index([video, audio(2, 'A_AAC', 'eng'), audio(3, 'A_AAC', 'rus')]),
    );
    expect(renditions.map((r) => r.track.language)).toEqual(['eng', 'rus']);
  });

  test('copies AAC, MP3, Opus and FLAC, and transcodes the rest', () => {
    const renditions = getRenditions(
      index([
        video,
        audio(2, 'A_AAC/MPEG4/LC'),
        audio(3, 'A_MPEG/L3'),
        audio(4, 'A_OPUS'),
        audio(5, 'A_FLAC'),
        audio(6, 'A_AC3'),
        audio(7, 'A_AC3/BSID9'),
        audio(8, 'A_EAC3'),
        audio(9, 'A_DTS'),
        audio(10, 'A_TRUEHD'),
      ]),
    ).audio;
    expect(renditions.map((r) => [r.track.codecId, r.transcode])).toEqual([
      ['A_AAC/MPEG4/LC', false],
      ['A_MPEG/L3', false],
      ['A_OPUS', false],
      ['A_FLAC', false],
      ['A_AC3', true],
      ['A_AC3/BSID9', true],
      ['A_EAC3', true],
      ['A_DTS', true],
      ['A_TRUEHD', true],
    ]);
  });

  test('drops audio with no decode path and bitmap subtitles', () => {
    const renditions = getRenditions(
      index([
        video,
        audio(2, 'A_REAL/COOK'),
        audio(3, 'A_QUICKTIME'),
        track({ number: 4, kind: 'subtitle', codecId: 'S_HDMV/PGS' }),
        track({ number: 5, kind: 'subtitle', codecId: 'S_TEXT/UTF8' }),
        track({ number: 6, kind: 'subtitle', codecId: 'S_TEXT/ASS' }),
      ]),
    );
    expect(renditions.audio).toEqual([]);
    expect(renditions.subtitles.map((s) => s.track.number)).toEqual([5, 6]);
  });

  test('rejects video with no fMP4 mapping', () => {
    expect(() => getRenditions(index([track({ codecId: 'V_MPEG2' })]))).toThrow(
      UnsupportedMediaError,
    );
  });
});

describe('codecString', () => {
  const audioCodec = (codecId: string) =>
    codecString(getRenditions(index([video, audio(2, codecId)])).audio[0]!);

  test('names copied audio by its own codec', () => {
    expect(audioCodec('A_MPEG/L3')).toBe('mp4a.40.34');
    expect(audioCodec('A_OPUS')).toBe('opus');
    expect(audioCodec('A_FLAC')).toBe('fLaC');
    expect(audioCodec('A_AAC/MPEG4/LC/SBR')).toBe('mp4a.40.5');
  });

  test('names transcoded audio as AAC-LC', () => {
    expect(audioCodec('A_AC3')).toBe('mp4a.40.2');
    expect(audioCodec('A_EAC3')).toBe('mp4a.40.2');
    expect(audioCodec('A_DTS')).toBe('mp4a.40.2');
  });

  test('names WebVTT subtitles', () => {
    const sub = track({ number: 2, kind: 'subtitle', codecId: 'S_TEXT/UTF8' });
    expect(codecString(getRenditions(index([video, sub])).subtitles[0]!)).toBe(
      'wvtt',
    );
  });
});

describe('Dolby Vision', () => {
  const hevc = (profile: number, compatibility: number): VideoRendition => ({
    type: 'video',
    codec: 'hevc',
    track: track({
      codecId: 'V_MPEGH/ISO/HEVC',
      dolbyVision: { profile, level: 6, compatibility },
    }),
  });

  test('profile 8 rides on its base layer', () => {
    expect(dolbyVisionMode(hevc(8, 1))).toBe('compatible');
    expect(supplementalCodecString(hevc(8, 1))).toBe('dvh1.08.06/db1p');
    expect(supplementalCodecString(hevc(8, 2))).toBe('dvh1.08.06/db2g');
    expect(supplementalCodecString(hevc(8, 4))).toBe('dvh1.08.06/db4h');
  });

  test('profile 5 is Dolby Vision only', () => {
    expect(dolbyVisionMode(hevc(5, 0))).toBe('only');
    expect(codecString(hevc(5, 0))).toBe('dvh1.05.06');
    expect(supplementalCodecString(hevc(5, 0))).toBeUndefined();
  });

  test('profile 7 and unknown compatibility play as the base layer', () => {
    expect(dolbyVisionMode(hevc(7, 6))).toBeUndefined();
    expect(dolbyVisionMode(hevc(8, 0))).toBeUndefined();
  });

  test('only applies to HEVC', () => {
    const avc: VideoRendition = {
      type: 'video',
      codec: 'avc',
      track: track({ dolbyVision: { profile: 5, level: 6, compatibility: 0 } }),
    };
    expect(dolbyVisionMode(avc)).toBeUndefined();
  });
});
