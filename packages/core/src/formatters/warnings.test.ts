import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ParsedStream } from '../db/schemas.js';
import { streamWarnings } from './warnings.js';

const stream = (
  parsedFile: Partial<NonNullable<ParsedStream['parsedFile']>>,
  extra: Partial<ParsedStream> = {}
) =>
  ({
    type: 'debrid',
    parsedFile: {
      visualTags: [],
      audioTags: [],
      audioChannels: [],
      languages: [],
      ...parsedFile,
    },
    ...extra,
  }) as ParsedStream;

describe('streamWarnings', () => {
  it('warns about Dolby Vision without an HDR fallback', () => {
    assert.deepEqual(streamWarnings(stream({ visualTags: ['DV'] })), [
      'DV: No HDR fallback, colours may look wrong without Dolby Vision',
    ]);
    assert.deepEqual(
      streamWarnings(stream({ visualTags: ['DV', 'HDR10'] })),
      []
    );
  });

  it('warns about DTS/TrueHD only when there is no other audio', () => {
    assert.deepEqual(
      streamWarnings(stream({ audioTags: ['Atmos', 'TrueHD'] })),
      ['TrueHD: Some TVs and browsers have no sound']
    );
    assert.deepEqual(
      streamWarnings(stream({ audioTags: ['TrueHD', 'DD+'] })),
      []
    );
  });

  it('collects every applicable warning', () => {
    assert.deepEqual(
      streamWarnings(
        stream(
          {
            quality: 'CAM',
            visualTags: ['3D'],
            upscaled: true,
            extension: 'iso',
          },
          {
            service: { id: 'realdebrid', cached: false },
            torrent: { seeders: 0 },
          } as Partial<ParsedStream>
        )
      ),
      [
        'CAM: Recorded in a cinema, poor picture and sound',
        'Upscaled: Not true resolution',
        '3D: Needs a 3D display',
        'ISO: Disc image, may not play',
        'Uncached: Has to download before playing',
        '0 Seeders: May never start',
      ]
    );
  });

  it('warns when the file is far shorter than the runtime', () => {
    assert.deepEqual(
      streamWarnings(stream({}, { duration: 22 * 60_000 }), 130),
      ['Duration: Only 22m of 2h 10m, may be a sample or incomplete']
    );
    // an hour-long network show runs ~43 minutes without ads
    assert.deepEqual(
      streamWarnings(stream({}, { duration: 43 * 60_000 }), 60),
      []
    );
    assert.deepEqual(streamWarnings(stream({}, { duration: 60_000 })), []);
  });

  it('is empty for a clean release', () => {
    assert.deepEqual(
      streamWarnings(
        stream({
          quality: 'WEB-DL',
          encode: 'HEVC',
          visualTags: ['HDR10', '10bit'],
          audioTags: ['DD+'],
        })
      ),
      []
    );
  });
});
