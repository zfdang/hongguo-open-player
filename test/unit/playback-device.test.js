const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPlaybackDeviceRegistrar } = require('../../src/server/native/playback-device');
const success = { device_id_str: '123', install_id_str: '456', code: 0 };

test('concurrent registration retries share one payload and cache success', async () => {
  const getDevice = createPlaybackDeviceRegistrar();
  const requests = [];
  const request = async (url, options, deadline, signal) => {
    requests.push(options);
    assert.ok(deadline > Date.now() && deadline <= Date.now() + 8000);
    assert.equal(signal.aborted, false);
    if (requests.length === 1) throw Object.assign(new Error('empty'), { code: 'EMPTY_RESPONSE' });
    return success;
  };
  const first = getDevice(request), concurrent = getDevice(request);
  assert.equal(first, concurrent);
  const device = await first;
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.equal(device.device_id, '123');
  assert.equal(await getDevice(request), device);
  assert.equal(requests.length, 2);
});

test('an exhausted registration can recover without a new identity or payload', async () => {
  const getDevice = createPlaybackDeviceRegistrar();
  const bodies = [];
  const request = async (_, options) => {
    bodies.push(options.data);
    if (bodies.length <= 3) throw Object.assign(new Error('unavailable'), { status: 503 });
    return success;
  };
  await assert.rejects(getDevice(request), /HTTP 503/);
  assert.equal(bodies.length, 3);
  assert.equal((await getDevice(request)).iid, '456');
  assert.ok(bodies.every(body => body === bodies[0]));
});

test('registration never retries explicit business or security rejection', async () => {
  for (const result of [{ code: 1 }, Object.assign(new Error('blocked'), { code: 'SECURITY_BLOCKED' })]) {
    let calls = 0;
    await assert.rejects(createPlaybackDeviceRegistrar()(async () => {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    }), error => error.code === 'DEVICE_REGISTRATION_FAILED');
    assert.equal(calls, 1);
  }
});

test('resetting playback device clears cached registration and creates a new identity', async () => {
  const getDevice = createPlaybackDeviceRegistrar();
  const cdidList = [];
  const request = async (url, options) => {
    return { device_id_str: '999', install_id_str: '888', code: 0 };
  };
  const first = await getDevice(request);
  assert.equal(first.device_id, '999');
  const second = await getDevice(request);
  assert.equal(first, second);

  getDevice.reset();
  const third = await getDevice(request);
  assert.notEqual(first.cdid, third.cdid);
});


test('stale failures cannot reset a replacement device or its pending registration', async () => {
  const getDevice = createPlaybackDeviceRegistrar();
  const first = await getDevice(async () => success);
  assert.equal(getDevice.reset(first), true);
  let finish;
  const pending = getDevice(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  assert.equal(getDevice.reset(first), false);
  assert.equal(getDevice(() => { throw new Error('duplicate registration'); }), pending);
  finish(success);
  const next = await pending;
  assert.notEqual(next.cdid, first.cdid);
  assert.equal(getDevice.reset(first), false);
  assert.equal(await getDevice(() => { throw new Error('unexpected registration'); }), next);
});

test('aborting one registration waiter does not cancel a shared registration', async () => {
  const getDevice = createPlaybackDeviceRegistrar();
  let finish, calls = 0;
  const request = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const controller = new AbortController();
  const cancelled = getDevice(request, controller.signal);
  const remaining = getDevice(request);
  await Promise.resolve();
  controller.abort(new Error('episode changed'));
  await assert.rejects(cancelled, /episode changed/);
  assert.equal(calls, 1);
  finish(success);
  assert.equal((await remaining).device_id, '123');
  assert.equal((await getDevice(request)).device_id, '123');
  assert.equal(calls, 1);
});

test('persisted device is loaded from disk and avoids network requests', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-dev-test-'));
  try {
    const existing = {
      device_id: '987654321012345',
      iid: '123456789012345',
      cdid: '00000000-0000-0000-0000-000000000001',
      cookie: 'store-region=cn-bj; store-region-src=did; install_id=123456789012345',
      created_at: 1700000000000
    };
    fs.writeFileSync(path.join(tmpDir, 'device.json'), JSON.stringify(existing), 'utf8');

    let calls = 0;
    const request = async () => { calls++; return success; };
    const getDevice = createPlaybackDeviceRegistrar({ persist: true, dataDir: tmpDir });
    const loaded = await getDevice(request);

    assert.equal(calls, 0, 'Should not make any network requests when valid device exists on disk');
    assert.equal(loaded.device_id, '987654321012345');
    assert.equal(loaded.iid, '123456789012345');
    assert.equal(loaded.cdid, '00000000-0000-0000-0000-000000000001');
    assert.equal(loaded.cookie, existing.cookie);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('new registration saves device and cookie to disk and reset removes it', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-dev-test2-'));
  try {
    let calls = 0;
    const request = async () => {
      calls++;
      const res = { device_id_str: '555', install_id_str: '666', code: 0 };
      Object.defineProperty(res, '_headers', {
        value: { 'set-cookie': ['store-region=cn-bj; Path=/', 'install_id=666; Path=/'] },
        enumerable: false
      });
      return res;
    };
    const getDevice = createPlaybackDeviceRegistrar({ persist: true, dataDir: tmpDir });
    const registered = await getDevice(request);

    assert.equal(calls, 1);
    assert.equal(registered.device_id, '555');
    assert.equal(registered.iid, '666');
    assert.equal(registered.cookie, 'store-region=cn-bj; install_id=666');

    const filePath = path.join(tmpDir, 'device.json');
    assert.ok(fs.existsSync(filePath), 'device.json should be created');
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.device_id, '555');
    assert.equal(onDisk.iid, '666');

    // Reset should delete persisted disk file
    getDevice.reset(registered);
    assert.equal(fs.existsSync(filePath), false, 'device.json should be removed on explicit reset');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('persisted device sanitizes ttreq from cookies', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-dev-sanitize-'));
  try {
    const existing = {
      device_id: '987654321012345',
      iid: '123456789012345',
      cdid: '00000000-0000-0000-0000-000000000001',
      cookie: 'store-region=cn-bj; ttreq=1$expiredtoken; store-region-src=did; install_id=123456789012345',
      created_at: 1700000000000
    };
    fs.writeFileSync(path.join(tmpDir, 'device.json'), JSON.stringify(existing), 'utf8');

    const getDevice = createPlaybackDeviceRegistrar({ persist: true, dataDir: tmpDir });
    const loaded = await getDevice(async () => { throw new Error('should not call network'); });

    assert.equal(loaded.cookie.includes('ttreq='), false, 'Cookie should not contain single-use ttreq');
    assert.ok(loaded.cookie.includes('store-region=cn-bj'));
    assert.ok(loaded.cookie.includes('install_id=123456789012345'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fallbackToDefault switches to DEFAULT_VERIFIED_DEVICE and updates disk', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-dev-fallback-'));
  try {
    const existing = {
      device_id: '987654321012345',
      iid: '123456789012345',
      cdid: '00000000-0000-0000-0000-000000000001',
      cookie: 'store-region=cn-bj; install_id=123456789012345',
      created_at: 1700000000000
    };
    fs.writeFileSync(path.join(tmpDir, 'device.json'), JSON.stringify(existing), 'utf8');

    const getDevice = createPlaybackDeviceRegistrar({ persist: true, dataDir: tmpDir });
    const loaded = await getDevice(async () => { throw new Error('should not call network'); });
    assert.equal(loaded.device_id, '987654321012345');

    const fallback = getDevice.fallbackToDefault();
    assert.equal(fallback.device_id, '1624456208323876');

    const current = await getDevice(async () => { throw new Error('should return fallback device'); });
    assert.equal(current.device_id, '1624456208323876');

    const filePath = path.join(tmpDir, 'device.json');
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.device_id, '1624456208323876');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
