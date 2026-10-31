import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../index.js';
import { noteStreamViewer, viewersFor, type StreamViewer } from './viewers.js';

const viewer = (persona: string, device = 'tv'): StreamViewer => ({
  uuid: `uuid-${persona}`,
  persona,
  personaId: persona.toLowerCase(),
  device,
});

describe('viewersFor', () => {
  it('matches the target key over a shared filename', () => {
    noteStreamViewer(viewer('Ann'), {
      targetKey: 'usenet:aaa:0:',
      filename: 'Same.File.mkv',
    });
    noteStreamViewer(viewer('Bob'), { filename: 'same.file.mkv' });
    const found = viewersFor({
      targetKey: 'usenet:aaa:0:',
      filename: 'Same.File.mkv',
    });
    assert.deepEqual(
      found.map((v) => v.persona),
      ['Ann']
    );
  });

  it('matches a playback link by its NZB hash', () => {
    noteStreamViewer(viewer('Cat'), { hash: 'bbb' });
    const found = viewersFor({ targetKey: 'usenet:bbb:auto:' });
    assert.deepEqual(
      found.map((v) => v.persona),
      ['Cat']
    );
  });

  it("prefers viewers from the session's own address", () => {
    noteStreamViewer(viewer('Dan'), {
      targetKey: 'proxy:ccc',
      clientIp: '10.0.0.1',
    });
    noteStreamViewer(viewer('Eve'), {
      targetKey: 'proxy:ccc',
      clientIp: '10.0.0.2',
    });
    assert.deepEqual(
      viewersFor({ targetKey: 'proxy:ccc', clientIp: '10.0.0.2' }).map(
        (v) => v.persona
      ),
      ['Eve']
    );
    assert.equal(viewersFor({ targetKey: 'proxy:ccc' }).length, 2);
  });

  it('follows a viewer to what they play next', () => {
    noteStreamViewer(viewer('Fay'), { targetKey: 'proxy:ddd' });
    noteStreamViewer(viewer('Fay'), { targetKey: 'proxy:eee' });
    assert.equal(viewersFor({ targetKey: 'proxy:ddd' }).length, 0);
    assert.equal(viewersFor({ targetKey: 'proxy:eee' }).length, 1);
  });
});
