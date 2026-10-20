import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileTemplate, type CompileHooks } from './engine/index.js';
import type { ParsedStream } from '../db/schemas.js';
import { friendlyLabel, streamWarnings } from './friendly.js';

const hooks: CompileHooks<Record<string, any>> = {
  resolveVariable: () => undefined,
  resolveValues: () => undefined,
  comparators: {},
};

const render = (template: string, stream: Record<string, unknown>) =>
  compileTemplate(template, hooks)({ stream });

describe('friendlyLabel', () => {
  it('translates known tags, ignoring case', () => {
    assert.equal(friendlyLabel('WEB-DL'), 'Streaming (original)');
    assert.equal(friendlyLabel('dv'), 'Dolby Vision');
    assert.equal(friendlyLabel('5.1'), '5.1 Surround');
  });

  it('leaves unknown tags alone', () => {
    assert.equal(friendlyLabel('Something New'), 'Something New');
  });
});

describe('::friendly', () => {
  it('works on strings and lists', () => {
    assert.equal(
      render('{stream.quality::friendly}', { quality: 'BluRay REMUX' }),
      'Blu-ray (exact copy)'
    );
    assert.equal(
      render("{stream.audioTags::friendly::join(' · ')}", {
        audioTags: ['Atmos', 'TrueHD'],
      }),
      'Dolby Atmos · Dolby TrueHD (lossless)'
    );
  });
});

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
      'Dolby Vision only (colours may look wrong without DV)',
    ]);
    assert.deepEqual(
      streamWarnings(stream({ visualTags: ['DV', 'HDR10'] })),
      []
    );
  });

  it('warns about DTS/TrueHD only when there is no other audio', () => {
    assert.deepEqual(
      streamWarnings(stream({ audioTags: ['Atmos', 'TrueHD'] })),
      ['DTS/TrueHD audio only (some TVs and browsers have no sound)']
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
        'Recorded in a cinema (poor picture and sound)',
        'Upscaled (not true resolution)',
        '3D (needs a 3D display)',
        'Disc image (may not play)',
        'Not cached (has to download before playing)',
        'No seeders (may never start)',
      ]
    );
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
