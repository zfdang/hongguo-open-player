const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const appSource = require('../../src/server/native/app-source');

function mockEntry(vid) {
  return {
    video_model: JSON.stringify({
      video_list: [
        {
          definition: '1080p',
          quality: '1080p',
          vtype: 'mp4',
          codec_type: 'bytevc1',
          main_url: `https://qznovelvod.com/video_${vid}.mp4`,
          size: 1000,
          vwidth: 1080,
          vheight: 1920,
          encrypt_info: { encrypt: false }
        }
      ]
    })
  };
}

test('accepts absent encryption metadata but rejects declared encryption without a key', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const model = JSON.parse(mockEntry('30002').video_model);
  delete model.video_list[0].encrypt_info;
  appSource.requestJson = async url => url.includes('register')
    ? { code: 0, device_id_str: '999', install_id_str: '888' }
    : { code: 0, data: { '30002': { video_model: JSON.stringify(model) } } };
  try {
    const result = await appSource.fetchAppPlayUrl('30002');
    assert.equal(result.codec, 'hevc');
    assert.equal(result.contentKey, null);
    for (const encrypt_info of [{ encrypt: true }, {}]) {
      model.video_list[0].encrypt_info = encrypt_info;
      await assert.rejects(appSource.fetchAppPlayUrl('30002', { refresh: true }), { code: 'INVALID_RESPONSE' });
    }
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});

test('reports ByteVC2 only when no compatible source is available', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const entry = mockEntry('30001');
  const model = JSON.parse(entry.video_model);
  model.video_duration = 46.069;
  const compatible = model.video_list[0];
  compatible.vwidth = 640;
  compatible.vheight = 360;
  const bytevc2 = { ...compatible, codec_type: undefined, video_meta: { codec_type: 'bytevc2' } };
  model.video_list = [bytevc2];
  let requests = 0;
  appSource.requestJson = async url => {
    if (url.includes('register')) return { code: 0, device_id_str: '999', install_id_str: '888' };
    requests++;
    return { code: 0, data: { '30001': { video_model: JSON.stringify(model) } } };
  };
  try {
    await assert.rejects(appSource.fetchAppPlayUrl('30001'), { code: 'UNSUPPORTED_BYTEVC2', message: /ByteVC2/ });
    await assert.rejects(appSource.fetchAppPlayUrl('30001'), { code: 'UNSUPPORTED_BYTEVC2' });
    assert.equal(requests, 1, 'repeated probes reuse the unsupported model');
    const bvc = await appSource.fetchAppPlayUrl('30001', { allowBytevc2: true });
    assert.equal(bvc.codec, 'bytevc2');
    assert.equal(bvc.duration, 46.069);
    assert.equal(requests, 1);
    model.video_list.push(compatible);
    const result = await appSource.fetchAppPlayUrl('30001', { refresh: true, allowBytevc2: true });
    assert.equal(result.codec, 'hevc');
    assert.ok(result.variants.every(variant => variant.codec === 'hevc'));
    await assert.rejects(appSource.fetchAppPlayUrl('30001', { refresh: true, quality: '1080p' }), /满足 1080p/);
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});

test('fetchAppPlayUrl batches nextVids and caches returned models in entryCache', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const requests = [];

  appSource.requestJson = async (url, options) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999', install_id_str: '888' };
    }
    assert.equal(options.headers['Content-Encoding'], 'gzip');
    assert.equal(options.headers['x-ss-stub'], createHash('md5').update(options.data).digest('hex').toUpperCase());
    assert.equal(options.headers['x-ss-req-ticket'], new URL(url).searchParams.get('_rticket'));
    assert.equal(new URL(url).searchParams.get('version_name'), '7.4.3.32');
    requests.push({ url, body: JSON.parse(gunzipSync(options.data)) });
    return {
      code: 0,
      data: {
        '10001': mockEntry('10001'),
        '10002': mockEntry('10002'),
        '10003': mockEntry('10003'),
      }
    };
  };

  try {
    const play1 = await appSource.fetchAppPlayUrl('10001', { nextVids: ['10002', '10003', '10004', '10005'] });
    assert.equal(play1.url, 'https://qznovelvod.com/video_10001.mp4');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.mixed_video_id_map['1004'], ['10001', '10002', '10003', '10004']);

    // Calling for 10002 should hit entryCache directly without network request
    const play2 = await appSource.fetchAppPlayUrl('10002');
    assert.equal(play2.url, 'https://qznovelvod.com/video_10002.mp4');
    assert.equal(requests.length, 1, 'Should hit entryCache, no new network request');

    // Calling clearEntryCache for 10002 should evict it
    appSource.clearEntryCache('10002');
    await appSource.fetchAppPlayUrl('10002');
    assert.equal(requests.length, 2, 'Should make request after cache eviction');

    // Calling with refresh=true should bypass cache
    await appSource.fetchAppPlayUrl('10001', { refresh: true });
    assert.equal(requests.length, 3, 'refresh=true should bypass entryCache');
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});

test('fetchAppPlayUrl retries on EMPTY_RESPONSE from upstream API', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  let calls = 0;

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999', install_id_str: '888' };
    }
    calls++;
    if (calls === 1) {
      throw Object.assign(new Error('App upstream returned empty response'), { code: 'EMPTY_RESPONSE' });
    }
    return {
      code: 0,
      data: {
        '20001': mockEntry('20001')
      }
    };
  };

  try {
    const play = await appSource.fetchAppPlayUrl('20001');
    assert.equal(play.url, 'https://qznovelvod.com/video_20001.mp4');
    assert.equal(calls, 2);
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});
