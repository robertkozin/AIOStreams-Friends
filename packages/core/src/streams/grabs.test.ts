import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../index.js';
import { NEWZNAB_PROFILE } from '../builtins/base/nab/api.js';
import { NabScanner } from '../builtins/base/nab/scan.js';
import StreamParser from '../parser/streams.js';
import { applyGrabPopularity, grabsInRange } from './grabs.js';
import StreamUtils from './utils.js';
import type { ParsedStream, Stream } from '../db/schemas.js';

const DAY = 24;

const stream = (indexer: string | undefined, grabs?: number, age?: number) =>
  ({
    type: 'usenet',
    indexer,
    grabs,
    age,
    addon: { instanceId: 'addon' },
  }) as unknown as ParsedStream;

const near = (actual: number | undefined, expected: number) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 0.001,
    `${actual} is not near ${expected}`
  );

describe('applyGrabPopularity', () => {
  it('divides grabs by the square root of age in days', () => {
    // Rates of 1000 / 10 = 100 and 200 / 2 = 100.
    const streams = [stream('a', 1000, 100 * DAY), stream('a', 200, 4 * DAY)];
    applyGrabPopularity(streams);
    near(streams[0].grabPopularity, 1000 / 1003);
    near(streams[1].grabPopularity, 200 / 203);
  });

  it('scales each indexer against its own best rate', () => {
    const streams = [
      stream('big', 10000, DAY),
      stream('big', 5000, DAY),
      stream('small', 100, DAY),
    ];
    applyGrabPopularity(streams);
    near(streams[0].grabPopularity, 10000 / 10003);
    near(streams[1].grabPopularity, 0.5 * (5000 / 5003));
    near(streams[2].grabPopularity, 100 / 103);
  });

  it('discounts results with few grabs', () => {
    const streams = [stream('a', 3, DAY)];
    applyGrabPopularity(streams);
    near(streams[0].grabPopularity, 0.5);
  });

  it('floors age at a day', () => {
    const streams = [stream('a', 100, 1), stream('a', 100, DAY)];
    applyGrabPopularity(streams);
    assert.equal(streams[0].grabPopularity, streams[1].grabPopularity);
  });

  it('leaves streams without grabs or age unset', () => {
    const streams = [stream('a', undefined, DAY), stream('a', 10)];
    applyGrabPopularity(streams);
    assert.deepEqual(
      streams.map((s) => s.grabPopularity),
      [undefined, undefined]
    );
  });

  it('scores an all-zero indexer as zero', () => {
    const streams = [stream('a', 0, DAY), stream('a', 0, 2 * DAY)];
    applyGrabPopularity(streams);
    assert.deepEqual(
      streams.map((s) => s.grabPopularity),
      [0, 0]
    );
  });

  it('groups streams with no indexer by addon', () => {
    const fromAddon = (instanceId: string, grabs: number) =>
      ({
        ...stream(undefined, grabs, DAY),
        addon: { instanceId },
      }) as ParsedStream;
    const streams = [
      fromAddon('one', 300),
      fromAddon('one', 150),
      fromAddon('two', 30),
    ];
    applyGrabPopularity(streams);
    near(streams[0].grabPopularity, 300 / 303);
    near(streams[1].grabPopularity, 0.5 * (150 / 153));
    near(streams[2].grabPopularity, 30 / 33);
  });
});

describe('grabsInRange', () => {
  const unknown = stream('a');
  const low = { ...stream('a', 5), grabPopularity: 0.1 } as ParsedStream;
  const high = { ...stream('a', 50), grabPopularity: 1 } as ParsedStream;
  const zero = { ...stream('a', 0), grabPopularity: 0 } as ParsedStream;
  const all = [unknown, low, high];

  it('selects by minimum and maximum, including a maximum of zero', () => {
    assert.deepEqual(grabsInRange('grabs')(all, 10), [high]);
    assert.deepEqual(grabsInRange('grabPopularity')(all, 0, 0.5), [low]);
    assert.deepEqual(grabsInRange('grabs')(all, 0, 0), []);
  });

  it('selects a stream whose value is zero', () => {
    assert.deepEqual(grabsInRange('grabs')([zero, low], 0, 0), [zero]);
    assert.deepEqual(grabsInRange('grabPopularity')([zero, low], 0, 0.05), [
      zero,
    ]);
  });

  it('never selects a stream with unknown grabs', () => {
    assert.ok(!grabsInRange('grabs')(all, 0).includes(unknown));
  });

  it('rejects a missing or inverted range', () => {
    assert.throws(() => grabsInRange('grabs')(all));
    assert.throws(() => grabsInRange('grabs')(all, 5, 1));
  });
});

describe('grabs wiring', () => {
  it('reads the grabs attribute from a newznab item as a number', async () => {
    const item = (attr: string) => `<item><title>Release</title>${attr}</item>`;
    const scanned = await new NabScanner(
      Buffer.from(
        `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>${item(
          '<newznab:attr name="grabs" value="1109"/>'
        )}${item('<newznab:attr name="grabs" value="many"/>')}${item(
          ''
        )}</channel></rss>`
      )
    ).scanSearch(NEWZNAB_PROFILE);
    assert.equal(scanned.kind, 'search');
    if (scanned.kind !== 'search') return;
    assert.deepEqual(
      scanned.results.map((result) => result.attrs?.grabs),
      [1109, undefined, undefined]
    );
  });

  it('accepts only non-negative numbers when parsing a stream', () => {
    const getGrabs = (grabs: unknown) =>
      (
        StreamParser.prototype as unknown as {
          getGrabs(stream: Stream): number | undefined;
        }
      ).getGrabs({ grabs } as unknown as Stream);
    assert.equal(getGrabs(0), 0);
    assert.equal(getGrabs(42), 42);
    assert.equal(getGrabs(-1), undefined);
    assert.equal(getGrabs('42'), undefined);
    assert.equal(getGrabs(undefined), undefined);
  });

  it('drops grabs from the external download copy', () => {
    const original = {
      ...stream('a', 10, DAY),
      grabPopularity: 0.5,
    } as ParsedStream;
    const copy = StreamUtils.createDownloadableStream(original);
    assert.equal(copy.grabs, undefined);
    assert.equal(copy.grabPopularity, undefined);
    assert.equal(original.grabs, 10);
  });
});
