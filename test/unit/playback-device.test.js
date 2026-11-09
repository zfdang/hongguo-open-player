const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createPlaybackDeviceRegistrar,
  isValidDevice,
  loadDeviceFile,
  saveDeviceFile,
  removeDeviceFile,
} = require('../../src/server/native/playback-device');
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

test('persists device to file and reloads without network request', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-device-test-'));
  const deviceFile = path.join(tmpDir, 'device.json');
  try {
    let calls = 0;
    const request = async () => {
      calls++;
      return { device_id_str: '987654321', install_id_str: '123456789', code: 0 };
    };

    const registrar1 = createPlaybackDeviceRegistrar({ deviceFile });
    const device1 = await registrar1(request);
    assert.equal(calls, 1);
    assert.equal(device1.device_id, '987654321');
    assert.ok(fs.existsSync(deviceFile));

    const saved = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
    assert.equal(saved.device_id, '987654321');
    assert.equal(saved.iid, '123456789');
    assert.equal(saved.cdid, device1.cdid);

    // Second registrar with same deviceFile should load immediately from file without calling request
    const registrar2 = createPlaybackDeviceRegistrar({ deviceFile });
    const device2 = await registrar2(request);
    assert.equal(calls, 1, 'Should NOT invoke network request if file has valid device');
    assert.equal(device2.device_id, '987654321');
    assert.equal(device2.cdid, device1.cdid);

    // Resetting should delete the file
    assert.equal(registrar2.reset(device2), true);
    assert.equal(fs.existsSync(deviceFile), false);

    // Subsequent request registers again
    const device3 = await registrar2(request);
    assert.equal(calls, 2);
    assert.ok(fs.existsSync(deviceFile));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('respects reset cooldown period to avoid upstream abuse', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return { device_id_str: String(100 + calls), install_id_str: String(200 + calls), code: 0 };
  };

  const getDevice = createPlaybackDeviceRegistrar({ cooldownMs: 5000 });
  const d1 = await getDevice(request);
  assert.equal(calls, 1);

  // First reset succeeds
  assert.equal(getDevice.reset(d1), true);

  // Re-registers
  const d2 = await getDevice(request);
  assert.equal(calls, 2);

  // Immediate second reset is blocked by cooldown (returns false)
  assert.equal(getDevice.reset(d2), false);
  const d2Again = await getDevice(request);
  assert.equal(calls, 2, 'Should not re-register because reset was blocked by cooldown');
  assert.equal(d2Again, d2);

  // Force reset bypasses cooldown
  assert.equal(getDevice.reset(d2, true), true);
  const d3 = await getDevice(request);
  assert.equal(calls, 3);
  assert.notEqual(d3.device_id, d2.device_id);
});

test('ignores expired or corrupted device file and registers new device', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-device-corrupt-'));
  const deviceFile = path.join(tmpDir, 'device.json');
  try {
    let calls = 0;
    const request = async () => {
      calls++;
      return { device_id_str: '888888', install_id_str: '999999', code: 0 };
    };

    // Corrupted file
    fs.writeFileSync(deviceFile, 'not-json');
    const r1 = createPlaybackDeviceRegistrar({ deviceFile });
    const d1 = await r1(request);
    assert.equal(calls, 1);
    assert.equal(d1.device_id, '888888');

    // Expired file
    const expiredData = {
      device_id: '777777',
      iid: '666666',
      cdid: '00000000-0000-0000-0000-000000000000',
      registered_at: Date.now() - 100000,
    };
    fs.writeFileSync(deviceFile, JSON.stringify(expiredData));
    const r2 = createPlaybackDeviceRegistrar({ deviceFile, maxAgeMs: 5000 });
    const d2 = await r2(request);
    assert.equal(calls, 2, 'Expired device should trigger re-registration');
    assert.equal(d2.device_id, '888888');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
