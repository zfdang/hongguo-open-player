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
