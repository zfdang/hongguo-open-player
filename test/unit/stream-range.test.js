const { test } = require('node:test');
const assert = require('node:assert/strict');
const StreamService = require('../../src/server/services/streamService').constructor;

test('HTTP ranges support suffix/open end and reject malformed or unsafe offsets', async () => {
  const service = new StreamService();
  service.getStreamingPlan = async () => null;
  service.getDecryptedBuffer = async () => Buffer.from('0123456789');
  for (const [range, status, data] of [
    ['bytes=2-4', 206, '234'], ['bytes=7-', 206, '789'], ['bytes=-3', 206, '789'],
    ['bytes=-20', 206, '0123456789'], ['bytes=8-99', 206, '89'],
    ['bytes=-0', 416], ['bytes=10-', 416], ['bytes=4-2', 416],
    ['bytes=0-1,4-5', 416], ['cats=0-1', 416], ['bytes=2junk-4', 416],
    ['bytes=9007199254740992-', 416], ['bytes=-', 416]
  ]) {
    const res = { writeHead(code, headers) { this.status = code; this.headers = headers; }, end(body) { this.body = body; } };
    await service.handleStream({ headers: { range } }, res, '1');
    assert.equal(res.status, status, range);
    if (data) assert.equal(res.body.toString(), data, range);
    else assert.equal(res.headers['Content-Range'], 'bytes */10');
  }
});

test('handleStream directly serves from cache without invoking getStreamingPlan when buffer is cached', async () => {
  const service = new StreamService();
  service.cache.set('vid-cached:auto', { buffer: Buffer.from('hello cached world') });
  let planCalled = false;
  service.getStreamingPlan = async () => {
    planCalled = true;
    throw new Error('should not be called when cached');
  };
  const res = { writeHead(code, headers) { this.status = code; this.headers = headers; }, end(body) { this.body = body; } };
  await service.handleStream({ headers: { range: 'bytes=0-4' }, query: { quality: 'auto' } }, res, 'vid-cached');
  assert.equal(planCalled, false);
  assert.equal(res.status, 206);
  assert.equal(res.body.toString(), 'hello');
});

test('client disconnection during streaming does not delete valid cached streaming plan', async () => {
  const { Writable } = require('node:stream');
  const service = new StreamService();
  const mockPlan = {
    size: 100,
    bytes: 100,
    read: async function* () {
      yield Buffer.from('chunk1');
      throw Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    }
  };
  service.plans.set('vid-disconnect:auto', { plan: mockPlan, expires: Date.now() + 90000 });
  const res = new Writable({
    write(chunk, enc, cb) { cb(); }
  });
  res.writeHead = () => {};
  await service.handleStream({ headers: { range: 'bytes=0-50' } }, res, 'vid-disconnect');
  assert.ok(service.plans.has('vid-disconnect:auto'));
});

test('getStreamingPlan falls back to next candidate when first candidate returns RANGE_UNSUPPORTED', async () => {
  const service = new StreamService();
  const appSource = require('../../src/server/native/app-source');
  const rangeMedia = require('../../src/server/services/rangeMedia');
  const originalFetch = appSource.fetchAppPlayUrl;
  const originalPrepare = rangeMedia.prepareRangeMedia;

  const triedUrls = [];
  appSource.fetchAppPlayUrl = async () => ({
    variants: [
      { url: 'http://cdn1.example/unsupported.mp4', contentKey: 'key1' },
      { url: 'http://cdn2.example/working.mp4', contentKey: 'key2' }
    ]
  });
  rangeMedia.prepareRangeMedia = async (variant) => {
    triedUrls.push(variant.url);
    if (variant.url.includes('unsupported')) {
      throw Object.assign(new Error('Range unsupported'), { code: 'RANGE_UNSUPPORTED' });
    }
    return { size: 1234, bytes: 1234, read: async function* () {} };
  };

  try {
    const plan = await service.getStreamingPlan('vid-multi-cdn', 'auto', new AbortController().signal);
    assert.equal(plan.size, 1234);
    assert.deepEqual(triedUrls, ['http://cdn1.example/unsupported.mp4', 'http://cdn2.example/working.mp4']);
  } finally {
    appSource.fetchAppPlayUrl = originalFetch;
    rangeMedia.prepareRangeMedia = originalPrepare;
  }
});

test('near-end prefetch can refresh a plan that expires before playback', async () => {
  const service = new StreamService();
  const appSource = require('../../src/server/native/app-source');
  const rangeMedia = require('../../src/server/services/rangeMedia');
  const originalFetch = appSource.fetchAppPlayUrl, originalPrepare = rangeMedia.prepareRangeMedia;
  const oldPlan = { bytes: 5 }, newPlan = { bytes: 5 };
  let calls = 0;
  service.plans.set('123:auto', { plan: oldPlan, expires: Date.now() + 30000 });
  appSource.fetchAppPlayUrl = async () => { calls++; return { url: 'https://example.com/video' }; };
  rangeMedia.prepareRangeMedia = async () => newPlan;
  try {
    assert.equal(await service.getStreamingPlan('123', 'auto', new AbortController().signal), oldPlan);
    assert.equal(await service.getStreamingPlan('123', 'auto', new AbortController().signal, 45000), newPlan);
    assert.equal(calls, 1);
    assert.equal(await service.getStreamingPlan('123', 'auto', new AbortController().signal, 45000), newPlan);
    assert.equal(calls, 1);
  } finally {
    appSource.fetchAppPlayUrl = originalFetch;
    rangeMedia.prepareRangeMedia = originalPrepare;
  }
});

test('rapid episode changes let the latest request wait for cancelled streams', async () => {
  const { EventEmitter } = require('node:events');
  const service = new StreamService();
  service.getStreamingPlan = (vid, _quality, signal) => {
    if (vid === '4') return Promise.resolve(null);
    return new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  service.handleBufferedStream = async (_req, res) => { res.writeHead(200); res.end(); };
  function response() {
    const res = new EventEmitter();
    res.writeHead = status => { res.status = status; };
    res.end = () => { res.writableEnded = true; };
    return res;
  }
  const previous = Array.from({ length: 3 }, () => response());
  const tasks = previous.map((res, i) => service.handleStream({ headers: {}, query: {} }, res, String(i + 1)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.activeStreams, 3);
  for (const res of previous) { res.destroyed = true; res.emit('close'); }
  const latest = response();
  const newest = service.handleStream({ headers: {}, query: {} }, latest, '4');
  await Promise.all([...tasks, newest]);
  assert.equal(latest.status, 200);
  assert.equal(service.activeStreams, 0);
  assert.equal(service.waitingStreams.length, 0);
});

test('a disconnected waiting stream leaves the bounded queue', async () => {
  const { EventEmitter } = require('node:events');
  const service = new StreamService();
  service.activeStreams = 3;
  const res = new EventEmitter();
  res.writeHead = () => { throw new Error('closed request must not receive a response'); };
  res.end = () => {};
  const pending = service.handleStream({ headers: {}, query: {} }, res, '4');
  assert.equal(service.waitingStreams.length, 1);
  res.destroyed = true;
  res.emit('close');
  await pending;
  assert.equal(service.waitingStreams.length, 0);
  assert.equal(service.activeStreams, 3);
});

test('stream admission limits the number of waiting requests', async () => {
  const { EventEmitter } = require('node:events');
  const service = new StreamService();
  service.activeStreams = 3;
  const responses = Array.from({ length: 6 }, () => new EventEmitter());
  const waiting = responses.map(res => service.acquireStreamSlot(res));
  assert.equal(service.waitingStreams.length, 6);
  assert.equal(service.acquireStreamSlot(new EventEmitter()), false);
  for (const res of responses) res.emit('close');
  assert.deepEqual(await Promise.all(waiting), [false, false, false, false, false, false]);
  assert.equal(service.waitingStreams.length, 0);
});
