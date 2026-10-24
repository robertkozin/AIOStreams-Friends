import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDefaultAudio } from './master.js';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="audio/2/index.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",DEFAULT=NO,URI="audio/3/index.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=NO,URI="subtitles/4/index.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="audio",SUBTITLES="subs"',
  'video/index.m3u8',
].join('\n');

const defaults = (master: string) =>
  master
    .split('\n')
    .filter((l) => l.includes('TYPE=AUDIO'))
    .map((l) => /DEFAULT=(YES|NO)/.exec(l)?.[1]);

test('makes the picked audio rendition the only default', () => {
  assert.deepEqual(defaults(withDefaultAudio(MASTER, 1)), ['NO', 'YES']);
});

test('leaves subtitles and the variant alone', () => {
  const out = withDefaultAudio(MASTER, 1).split('\n');
  const before = MASTER.split('\n');
  assert.equal(out[3], before[3]);
  assert.equal(out.slice(4).join('\n'), before.slice(4).join('\n'));
});

test('a place past the last track leaves no default', () => {
  assert.deepEqual(defaults(withDefaultAudio(MASTER, 5)), ['NO', 'NO']);
});
