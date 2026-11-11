const { test } = require('node:test');
const assert = require('node:assert/strict');
const StreamService = require('../../src/server/services/streamService').constructor;

test('progressive ByteVC2 streams fragments and reuses completed conversions', async () => {
  const http = require('node:http');
  const appSource = require('../../src/server/native/app-source');
  const original = appSource.fetchAppPlayUrl;
  let conversions = 0;
  const key = '0123456789abcdef0123456789abcdef';
  const service = new StreamService({ progressiveTranscode: async function* (input, actualKey) {
    conversions++;
    assert.equal(input.toString(), 'encrypted');
    assert.equal(actualKey.toString('hex'), key);
    yield Buffer.from('first');
    yield Buffer.from('second');
  } });
  appSource.fetchAppPlayUrl = async () => ({ codec: 'bytevc2', duration: 46, url: 'https://example.com/video', contentKey: key });
  service.downloadFastestMedia = async (_variants, variant) => ({ buffer: Buffer.from('encrypted'), variant });
  const server = http.createServer((req, res) => {
    req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    service.handleStream(req, res, '123');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    let response = await fetch(`${base}?mse=1`);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: 'BYTEVC2_PROGRESSIVE', duration: 46 });
    response = await fetch(`${base}?mse=stream`);
    assert.equal(await response.text(), 'firstsecond');
    response = await fetch(`${base}?mse=1`);
    assert.equal((await response.json()).duration, 46);
    response = await fetch(`${base}?mse=stream`);
    assert.equal(await response.text(), 'firstsecond');
    assert.equal(conversions, 1);
  } finally {
    service.shutdown();
    appSource.fetchAppPlayUrl = original;
    await new Promise(resolve => server.close(resolve));
  }
});

test('disconnecting a progressive stream cancels the active conversion', async () => {
  const http = require('node:http');
  const appSource = require('../../src/server/native/app-source');
  const original = appSource.fetchAppPlayUrl;
  let cancelled;
  const cancelledPromise = new Promise(resolve => { cancelled = resolve; });
  const service = new StreamService({ progressiveTranscode: async function* (_input, _key, signal) {
    try {
      yield Buffer.from('fragment');
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } finally { cancelled(); }
  } });
  appSource.fetchAppPlayUrl = async () => ({ codec: 'bytevc2', duration: 46, url: 'https://example.com/video', contentKey: null });
  service.downloadFastestMedia = async (_variants, variant) => ({ buffer: Buffer.from('encrypted'), variant });
  const server = http.createServer((req, res) => { req.query = { mse: 'stream' }; service.handleStream(req, res, '123'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: controller.signal });
    await response.body.getReader().read();
    controller.abort();
    await cancelledPromise;
    assert.equal(service.fragmentCache.size, 0);
  } finally {
    service.shutdown();
    appSource.fetchAppPlayUrl = original;
    await new Promise(resolve => server.close(resolve));
  }
});

test('ByteVC2 uses buffered transcoding and caches the resulting playable video', async () => {
  const appSource = require('../../src/server/native/app-source');
  const original = appSource.fetchAppPlayUrl;
  const key = '0123456789abcdef0123456789abcdef';
  let conversions = 0;
  const service = new StreamService({ transcode: async (buffer, actualKey, signal) => {
    conversions++;
    assert.equal(buffer.toString(), 'encrypted');
    assert.equal(actualKey.toString('hex'), key);
    assert.equal(signal.aborted, false);
    return Buffer.from('playable');
  } });
  appSource.fetchAppPlayUrl = async (_vid, options) => {
    assert.equal(options.allowBytevc2, true);
    return { codec: 'bytevc2', url: 'https://example.com/video', contentKey: key };
  };
  service.downloadFastestMedia = async (_variants, variant) => ({ buffer: Buffer.from('encrypted'), variant });
  try {
    const signal = new AbortController().signal;
    assert.equal(await service.getStreamingPlan('123', 'auto', signal), null);
    assert.equal((await service.getDecryptedBuffer('123', 'auto', { signal })).toString(), 'playable');
    assert.equal((await service.getDecryptedBuffer('123', 'auto', { signal })).toString(), 'playable');
    assert.equal(conversions, 1);
  } finally {
    service.shutdown();
    appSource.fetchAppPlayUrl = original;
  }
});

test('ByteVC2 without a usable duration falls back to buffered playback', async () => {
  const appSource = require('../../src/server/native/app-source');
  const original = appSource.fetchAppPlayUrl;
  const service = new StreamService();
  appSource.fetchAppPlayUrl = async () => ({ codec: 'bytevc2', duration: 0 });
  try {
    assert.equal(await service.getStreamingPlan('123', 'auto', new AbortController().signal, 0, [], true), null);
  } finally {
    service.shutdown();
    appSource.fetchAppPlayUrl = original;
  }
});

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

test('rapid seek disconnections keep the same streaming plan', async () => {
  const { Writable } = require('node:stream');
  const service = new StreamService();
  const appSource = require('../../src/server/native/app-source');
  let clearedVid = null;
  const originalClear = appSource.clearEntryCache;
  appSource.clearEntryCache = (vid) => { clearedVid = vid; };

  const mockPlan = {
    size: 100,
    bytes: 100,
    read: async function* () {
      yield Buffer.from('chunk1');
      throw Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    }
  };
  service.plans.set('vid-rapid:auto', { plan: mockPlan, expires: Date.now() + 90000 });

  try {
    // First abort (<300ms)
    const res1 = new Writable({ write(chunk, enc, cb) { cb(); } });
    res1.writeHead = () => {};
    await service.handleStream({ headers: { range: 'bytes=0-50' } }, res1, 'vid-rapid');
    assert.ok(service.plans.has('vid-rapid:auto'), 'Single abort should keep plan');
    assert.equal(clearedVid, null);

    // Repeated seeks must not change the entity behind the original MP4 header.
    for (let i = 0; i < 3; i++) {
      const res = new Writable({ write(chunk, enc, cb) { cb(); } });
      res.writeHead = () => {};
      await service.handleStream({ headers: { range: 'bytes=25-50' } }, res, 'vid-rapid');
      assert.equal(service.plans.get('vid-rapid:auto').plan, mockPlan);
      assert.equal(clearedVid, null);
    }
    service.plans.get('vid-rapid:auto').expires = Date.now() - 1;
    assert.equal(await service.getStreamingPlan('vid-rapid', 'auto', new AbortController().signal), mockPlan);
  } finally {
    appSource.clearEntryCache = originalClear;
  }
});

test('refresh token is consumable once across multiple Range requests', async () => {
  const { Writable } = require('node:stream');
  const service = new StreamService();
  const appSource = require('../../src/server/native/app-source');
  const rangeMedia = require('../../src/server/services/rangeMedia');
  let clearCount = 0;
  let fetchCount = 0;
  const originalClear = appSource.clearEntryCache;
  const originalFetch = appSource.fetchAppPlayUrl;
  const originalPrepare = rangeMedia.prepareRangeMedia;

  appSource.clearEntryCache = () => { clearCount++; };
  appSource.fetchAppPlayUrl = async () => {
    fetchCount++;
    return { url: 'https://v3-reading-video.douyinvod.com/video.mp4', variants: [{ url: 'https://v3-reading-video.douyinvod.com/video.mp4' }] };
  };
  rangeMedia.prepareRangeMedia = async () => ({
    size: 10,
    bytes: 10,
    read: async function* () { yield Buffer.from('0123456789'); }
  });

  function createWritable() {
    const res = new Writable({ write(chunk, enc, cb) { cb(); } });
    res.writeHead = (code, headers) => { res.status = code; res.headers = headers; };
    return res;
  }

  try {
    service.plans.set('vid-refresh:auto', { plan: { bytes: 100, size: 100, read: async function* () {} }, expires: Date.now() + 90000 });

    // First Range request with token 1: consumes token, clears cache, builds fresh plan
    const res1 = createWritable();
    await service.handleStream({ headers: { range: 'bytes=0-4' }, query: { refresh: '1' } }, res1, 'vid-refresh');
    assert.equal(clearCount, 1);
    assert.equal(fetchCount, 1);

    // Second Range request with same token 1 (e.g. browser seeking or range chunking): token already consumed, reuses plan without clearing
    const res2 = createWritable();
    await service.handleStream({ headers: { range: 'bytes=5-9' }, query: { refresh: '1' } }, res2, 'vid-refresh');
    assert.equal(clearCount, 1, 'Same refresh token should not trigger cache clearing again');
    assert.equal(fetchCount, 1, 'Same refresh token should reuse the active plan without re-fetching');

    // Third Range request with new token 2 (user clicked retry again): consumes new token, clears and rebuilds
    const res3 = createWritable();
    await service.handleStream({ headers: { range: 'bytes=0-4' }, query: { refresh: '2' } }, res3, 'vid-refresh');
    assert.equal(clearCount, 2);
    assert.equal(fetchCount, 2);
  } finally {
    appSource.clearEntryCache = originalClear;
    appSource.fetchAppPlayUrl = originalFetch;
    rangeMedia.prepareRangeMedia = originalPrepare;
  }
});

test('sortVariantsByCdnPriority preserves codec and resolution tier precedence while deprioritizing v9 within each tier', () => {
  const service = new StreamService();
  const v1 = { codec: 'h264', quality: '1080p', width: 1080, height: 1920, url: 'http://v9-reading-video.fqnovelvod.com/v1.mp4' };
  const v2 = { codec: 'h264', quality: '1080p', width: 1080, height: 1920, url: 'http://v3-reading-video.douyinvod.com/v2.mp4' };
  const v3 = { codec: 'hevc', quality: '1080p', width: 1080, height: 1920, url: 'http://v3-reading-video.douyinvod.com/v3.mp4' };
  const v4 = { codec: 'h264', quality: '720p', width: 720, height: 1280, url: 'http://v3-reading-video.douyinvod.com/v4.mp4' };

  const sorted = service.sortVariantsByCdnPriority([v1, v2, v3, v4]);
  // Within H.264 1080p, v2 (v3 CDN) is prioritized over v1 (v9 CDN)
  assert.equal(sorted[0], v2);
  assert.equal(sorted[1], v1);
  // H.264 1080p v9 (v1) is NOT displaced behind HEVC (v3) or 720p (v4)
  assert.equal(sorted[2], v3);
  assert.equal(sorted[3], v4);
});

test('prefetch forwards nextVids to getStreamingPlan and handleStream passes followVids', async () => {
  const service = new StreamService();
  const prefetchCalls = [];
  const planCalls = [];

  service.getStreamingPlan = async (vid, quality, signal, minValidityMs, nextVids) => {
    planCalls.push({ vid, quality, minValidityMs, nextVids });
    return {
      size: 10,
      bytes: 10,
      read: async function* () { yield Buffer.from('1234567890'); }
    };
  };

  const originalSetTimeout = global.setTimeout;
  try {
    global.setTimeout = fn => {
      fn();
      return { unref() {} };
    };

    service.prefetch('102', 'auto', true, 45000, ['103', '104']);
    assert.equal(planCalls.length, 1);
    assert.deepEqual(planCalls[0], {
      vid: '102',
      quality: 'auto',
      minValidityMs: 45000,
      nextVids: ['103', '104']
    });

    service.prefetch = (...args) => prefetchCalls.push(args);

    const { Writable } = require('node:stream');
    const res = new Writable({ write(chunk, encoding, cb) { cb(); } });
    res.writeHead = (code, headers) => { res.status = code; res.headers = headers; };
    await service.handleStream({
      headers: { range: 'bytes=0-4' },
      query: { next_vid: '102', next_vids: '102,103,104' }
    }, res, '101');

    assert.equal(prefetchCalls.length, 1);
    assert.deepEqual(prefetchCalls[0], ['102', 'auto', true, 0, ['103', '104']]);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
