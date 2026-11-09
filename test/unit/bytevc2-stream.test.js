const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createPlayer(fetch) {
  let media;
  const revoked = [];
  class Source extends EventTarget {
    constructor() { super(); this.chunks = []; }
    appendBuffer(data) { this.chunks.push([...data]); queueMicrotask(() => this.dispatchEvent(new Event('updateend'))); }
  }
  class Media extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); media = this; this.readyState = 'open'; }
    addSourceBuffer() { this.source = new Source(); return this.source; }
    endOfStream() { this.ended = true; }
  }
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/client/js/bytevc2-stream.js'), 'utf8'), {
    window, MediaSource: Media, ReadableStream, AbortController, DOMException, fetch,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: value => revoked.push(value) }
  });
  return { player: window.Bytevc2Stream, media: () => media, revoked };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('appends media chunks with the episode duration and completes', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(1, 2)); c.enqueue(Uint8Array.of(3)); c.close(); } });
  const fixture = createPlayer(async () => ({ ok: true, body }));
  const video = {};
  let error;
  const session = fixture.player.start(video, '/stream', 46, e => { error = e; });
  fixture.media().dispatchEvent(new Event('sourceopen'));
  for (let i = 0; i < 10 && !fixture.media().ended; i++) await tick();
  assert.equal(video.src, 'blob:test');
  assert.equal(fixture.media().duration, 46);
  assert.deepEqual(fixture.media().source.chunks, [[1, 2], [3]]);
  assert.equal(fixture.media().ended, true);
  assert.equal(error, undefined);
  session.stop();
  assert.deepEqual(fixture.revoked, ['blob:test']);
});

test('stopping a pending stream cancels it without triggering fallback', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const fixture = createPlayer(async () => ({ ok: true, body }));
  let fallback = false;
  const session = fixture.player.start({}, '/stream', 46, () => { fallback = true; });
  fixture.media().dispatchEvent(new Event('sourceopen'));
  await tick();
  session.stop();
  await tick();
  assert.equal(cancelled, true);
  assert.equal(fallback, false);
  assert.deepEqual(fixture.revoked, ['blob:test']);
});
