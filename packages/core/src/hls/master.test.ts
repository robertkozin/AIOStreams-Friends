import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  subtitlePlaylist,
  withDefaultAudio,
  withExtraSubtitles,
} from './master.js';

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

const BASE = 'https://tv.example/api/v1/hls/token/';
const EXTRA = {
  name: 'English - OpenSubtitles',
  language: 'eng',
  uri: 'https://tv.example/jellyfin/Videos/1/2/Subtitles/1000/subtitles.m3u8?ApiKey=k',
};

test('makes the remux URIs absolute and adds subtitles to its group', () => {
  const out = withExtraSubtitles(MASTER, BASE, [EXTRA]).split('\n');
  assert.ok(out.includes(`${BASE}video/index.m3u8`));
  assert.match(
    out[1],
    /URI="https:\/\/tv\.example\/api\/v1\/hls\/token\/audio\/2\/index\.m3u8"/
  );
  const added = out.find((l) => l.includes('OpenSubtitles'))!;
  assert.match(added, /GROUP-ID="subs"/);
  assert.match(added, /LANGUAGE="eng"/);
  assert.ok(added.includes(`URI="${EXTRA.uri}"`));
  assert.ok(
    out.indexOf(added) < out.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'))
  );
});

test('makes a subtitle group where the master has none', () => {
  const bare = MASTER.split('\n')
    .filter((l) => !l.includes('TYPE=SUBTITLES'))
    .join('\n')
    .replace(',SUBTITLES="subs"', '');
  const out = withExtraSubtitles(bare, BASE, [EXTRA]);
  assert.match(
    out,
    /#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="audio",SUBTITLES="subs"/
  );
  assert.match(
    out,
    /TYPE=SUBTITLES,GROUP-ID="subs",NAME="English - OpenSubtitles"/
  );
});

test('serves one WebVTT file as a single segment', () => {
  const playlist = subtitlePlaylist('0/Stream.vtt?ApiKey=k', 1334.6);
  assert.match(playlist, /#EXT-X-TARGETDURATION:1335/);
  assert.match(playlist, /#EXTINF:1334\.600,\n0\/Stream\.vtt\?ApiKey=k/);
  assert.match(playlist, /#EXT-X-ENDLIST/);
});
