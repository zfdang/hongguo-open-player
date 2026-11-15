// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CookieJar } = require('tough-cookie');
const { createJar, applyCookies, PLAYBACK_URL } = require('../../src/server/native/device-session');
const { createPlaybackDeviceRegistrar, getPlaybackDevice } = require('../../src/server/native/playback-device');
const appSource = require('../../src/server/native/app-source');
const logger = require('../../src/server/services/logger');
const axios = require('axios');
const registration = { code: 0, device_id_str: '987654321012345', install_id_str: '123456789012345' };

test('cookie store respects domain, path, deletion, expiry and Max-Age precedence', () => {
  const jar = new CookieJar();
  const update = applyCookies(jar, PLAYBACK_URL, { 'set-cookie': [
    'sid=private; Domain=fqnovel.com; Path=/novel; Secure; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'hostonly=secret; Path=/',
    'wrong=secret; Domain=snssdk.com; Path=/',
    'ttreq=single-use; Path=/',
    'past=expired; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
  ] });
  assert.deepEqual(update, { received: 5, accepted: 3, rejected: 2 });
  assert.match(jar.getCookieStringSync(PLAYBACK_URL), /sid=private/);
  assert.doesNotMatch(jar.getCookieStringSync(PLAYBACK_URL), /wrong|ttreq|past/);
  assert.equal(jar.getCookieStringSync('https://reading.snssdk.com/novel/'), '');
  assert.equal(jar.getCookieStringSync('https://other.fqnovel.com/unrelated'), '');
  assert.equal(jar.getCookieStringSync('https://other.fqnovel.com/novel/test'), 'sid=private');
  applyCookies(jar, PLAYBACK_URL, { 'set-cookie': 'sid=gone; Domain=fqnovel.com; Path=/novel; Max-Age=0' });
  assert.doesNotMatch(jar.getCookieStringSync(PLAYBACK_URL), /sid=/);
  // Cookies still expire after serialization/restart; no unknown legacy tokens are broadcast.
  const saved = jar.serializeSync();
  for (const cookie of saved.cookies) cookie.expires = '1970-01-01T00:00:00.000Z';
  assert.equal(createJar({ cookie_jar: saved }).getCookieStringSync(PLAYBACK_URL), '');
  const migrated = createJar({ cookie: 'install_id=123; store-region=cn-bj; sid=unscoped-secret' });
  assert.equal(migrated.getCookieStringSync('https://reading.snssdk.com/'), 'install_id=123; store-region=cn-bj');
});

test('session updates persist immediately on empty responses and old generations cannot overwrite a rotated device', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-session-'));
  try {
    const registrar = createPlaybackDeviceRegistrar({ persist: true, dataDir: dir });
    const device = await registrar(async () => registration);
    const url = `${PLAYBACK_URL}?device_id=${device.device_id}&iid=${device.iid}`;
    registrar.beginRequest(device, url);
    const state = registrar.recordResponse(device, url, { 'set-cookie': ['sid=refreshed; Path=/; Max-Age=3600'] }, 'EMPTY_RESPONSE');
    assert.equal(state.cookie_changed, true);
    assert.equal(state.request_count, 1);
    assert.equal(state.consecutive_failures, 1);
    assert.ok(state.last_failure_at && state.cookie_updated_at && state.last_used_at);
    assert.ok(state.cookie_expiry_remaining_ms > 0);
    const restored = createPlaybackDeviceRegistrar({ persist: true, dataDir: dir });
    const loaded = await restored(() => { throw new Error('must reuse device'); });
    assert.match(restored.beginRequest(loaded, url).cookie, /sid=refreshed/);
    registrar.recordResponse(device, url, {}, 'ok');
    assert.equal(registrar.diagnostics(device, url).consecutive_failures, 0);
    assert.ok(registrar.diagnostics(device, url).last_success_at);
    const replacement = await registrar.rotateDevice(async () => ({ ...registration, device_id_str: '999999999999999' }));
    const saved = fs.readFileSync(path.join(dir, 'device.json'), 'utf8');
    assert.deepEqual(registrar.recordResponse(device, url, { 'set-cookie': ['sid=old-device; Path=/'] }, 'ok'), { stale_device: true });
    assert.equal(fs.readFileSync(path.join(dir, 'device.json'), 'utf8'), saved);
    assert.equal(registrar.getCurrentDevice().device_id, replacement.device_id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real transport refreshes cookies on HTTP 200 empty bodies and sends them on fallback without logging secrets', async () => {
  const adapter = axios.defaults.adapter;
  const info = logger.info, warn = logger.warn;
  const logs = [], sent = [];
  getPlaybackDevice.reset();
  await getPlaybackDevice(async () => registration);
  logger.info = logger.warn = (...args) => logs.push(args);
  let calls = 0;
  axios.defaults.adapter = async config => {
    sent.push(config.headers.Cookie || '');
    calls++;
    return { status: 200, statusText: 'OK', config,
      headers: { 'x-tt-logid': `trace-${calls}`, 'set-cookie': calls === 1
        ? ['primary=PRIVATE_PRIMARY; Domain=snssdk.com; Path=/']
        : calls === 2 ? ['sid=TOP_SECRET; Domain=fqnovel.com; Path=/; Max-Age=3600'] : [] },
      data: calls <= 2 ? '' : JSON.stringify({ code: 0, data: { '123456': { video_model: { video_list: [{
        codec_type: 'h264', definition: '1080p', vwidth: 1080, vheight: 1920,
        main_url: 'https://qznovelvod.com/test.mp4', encrypt_info: { encrypt: false },
      }] } } } }),
    };
  };
  try {
    const result = await appSource.fetchAppPlayUrl('123456', { refresh: true });
    assert.equal(result.codec, 'h264');
    assert.equal(calls, 3);
    assert.doesNotMatch(sent[0], /TOP_SECRET/);
    assert.doesNotMatch(sent[1], /PRIVATE_PRIMARY/);
    assert.match(sent[2], /sid=TOP_SECRET/);
    const diagnostics = logs.filter(row => row[0] === 'AppRequest').map(row => row[2]);
    assert.equal(diagnostics.length, 3);
    assert.equal(diagnostics[0].outcome, 'EMPTY_RESPONSE');
    assert.equal(diagnostics[0].response_bytes, 0);
    assert.equal(diagnostics[0].logid, 'trace-1');
    assert.equal(diagnostics[0].cookie_changed, true);
    assert.equal(diagnostics[1].outcome, 'EMPTY_RESPONSE');
    assert.equal(diagnostics[2].outcome, 'ok');
    assert.ok(diagnostics[2].sent_cookie_names.includes('sid'));
    assert.equal(diagnostics[2].has_requested_video, true);
    assert.equal(diagnostics[0].has_requested_video, false);
    assert.equal(diagnostics[0].playback_id, diagnostics[1].playback_id);
    assert.notEqual(diagnostics[0].request_id, diagnostics[1].request_id);
    assert.equal(diagnostics[0].device_key, diagnostics[1].device_key);
    assert.equal(diagnostics[2].consecutive_failures, 0);
    assert.doesNotMatch(JSON.stringify(logs), /TOP_SECRET|PRIVATE_PRIMARY|x-argus|x-ladon|device_id=|install_id=/);
  } finally {
    axios.defaults.adapter = adapter;
    logger.info = info; logger.warn = warn;
    appSource.clearEntryCache(); getPlaybackDevice.reset();
  }
});

test('transport processes cookie deletion on HTTP errors and distinguishes business rejection and cancellation', async () => {
  const adapter = axios.defaults.adapter;
  const info = logger.info, warn = logger.warn;
  const logs = [];
  getPlaybackDevice.reset();
  const device = await getPlaybackDevice(async () => registration);
  const url = `${PLAYBACK_URL}?device_id=${device.device_id}&iid=${device.iid}`;
  logger.info = logger.warn = (...args) => logs.push(args);
  try {
    getPlaybackDevice.recordResponse(device, url, { 'set-cookie': ['sid=old; Path=/'] }, 'ok');
    axios.defaults.adapter = async config => ({ status: 403, config, headers: { 'set-cookie': ['sid=; Max-Age=0; Path=/'] }, data: '' });
    await assert.rejects(appSource.requestJson(url, {}, Date.now() + 1000), { status: 403 });
    assert.doesNotMatch(getPlaybackDevice.beginRequest(device, url).cookie, /sid=/);
    axios.defaults.adapter = async config => ({ status: 200, config, headers: {}, data: '{"code":123}' });
    await appSource.requestJson(url, {}, Date.now() + 1000);
    assert.equal(logs.at(-1)[2].outcome, 'BUSINESS_REJECTED');
    assert.equal(logs.at(-1)[2].business_code, 123);
    const failures = getPlaybackDevice.diagnostics(device, url).consecutive_failures;
    const controller = new AbortController();
    axios.defaults.adapter = async () => { controller.abort(new Error('episode changed')); throw new Error('cancelled'); };
    await assert.rejects(appSource.requestJson(url, {}, Date.now() + 1000, controller.signal), { code: 'ERR_CANCELED' });
    assert.equal(getPlaybackDevice.diagnostics(device, url).consecutive_failures, failures);
    assert.equal(logs.at(-1)[2].outcome, 'ERR_CANCELED');
  } finally {
    axios.defaults.adapter = adapter; logger.info = info; logger.warn = warn; getPlaybackDevice.reset();
  }
});

test('relative cookie lifetime is fixed at receipt and does not slide on reads or restart', () => {
  const jar = new CookieJar();
  applyCookies(jar, PLAYBACK_URL, { 'set-cookie': 'sid=short-lived; Path=/; Max-Age=3600' });
  const saved = jar.serializeSync();
  const deadline = Date.parse(saved.cookies[0].expires);
  assert.ok(deadline > Date.now() + 3590000 && deadline <= Date.now() + 3600000);
  assert.equal(saved.cookies[0].maxAge, undefined);
  jar.getCookieStringSync(PLAYBACK_URL);
  const restored = createJar({ cookie_jar: jar.serializeSync() });
  assert.equal(restored.getCookiesSync(PLAYBACK_URL)[0].expiryTime(), deadline);
  const expired = restored.serializeSync();
  expired.cookies[0].expires = new Date(0).toISOString();
  assert.equal(createJar({ cookie_jar: expired }).getCookieStringSync(PLAYBACK_URL), '');
});
