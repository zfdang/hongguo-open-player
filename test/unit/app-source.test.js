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
    // v04.10.03 mobile playback signing: only khronos/helios/medusa are sent.
    assert.ok(options.headers['x-khronos']);
    assert.ok(options.headers['x-helios']);
    assert.ok(options.headers['x-medusa']);
    assert.equal(options.headers['x-ss-stub'], createHash('md5').update(options.data).digest('hex').toUpperCase());
    assert.equal(new URL(url).searchParams.get('aid'), '8662');
    assert.equal(new URL(url).searchParams.get('version_name'), '7.4.3.32');
    assert.equal(new URL(url).searchParams.get('device_type'), 'PGT-AN10');
    assert.equal(new URL(url).searchParams.has('ts'), false);
    assert.ok(options.headers['User-Agent'].includes('PGT-AN10'));
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


test('fetchAppPlayUrl falls back across multi_video_model clusters before falling back to shortplay channel with same device', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const urls = [];

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999', install_id_str: '888' };
    }
    urls.push(url);
    if (urls.length <= 5) {
      // All multi_video_model clusters fail with EMPTY_RESPONSE for device 999
      throw Object.assign(new Error('App upstream returned empty response'), { code: 'EMPTY_RESPONSE' });
    }
    // Succeeded on shortplay fallback with the same registered device
    return {
      code: 0,
      data: {
        '20002': mockEntry('20002')
      }
    };
  };

  try {
    const play = await appSource.fetchAppPlayUrl('20002');
    assert.equal(play.url, 'https://qznovelvod.com/video_20002.mp4');
    assert.equal(urls.length, 6);
    assert.ok(urls[0].includes('reading.snssdk.com'));
    assert.ok(urls[1].includes('api5-normal-sinfonlinea.fqnovel.com'));
    assert.ok(urls[2].includes('api5-normal-lq.fqnovel.com'));
    assert.ok(urls[3].includes('is.snssdk.com'));
    assert.ok(urls[4].includes('api5-normal-hl.fqnovel.com'));
    assert.ok(urls[5].includes('api3-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/'));
    assert.ok(urls[5].includes('device_id=999'), 'Fallback request should use the same active device');
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});


test('fetchAppPlayUrl selects highest resolution when multiple streams of different definitions exist', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const entry = {
    video_model: JSON.stringify({
      video_list: [
        {
          definition: '720p',
          vtype: 'mp4',
          codec_type: 'h264',
          main_url: 'https://qznovelvod.com/video_720.mp4',
          vwidth: 720,
          vheight: 1280,
          encrypt_info: { encrypt: false }
        },
        {
          definition: '1080p',
          vtype: 'mp4',
          codec_type: 'bytevc1',
          main_url: 'https://qznovelvod.com/video_1080.mp4',
          vwidth: 1080,
          vheight: 1920,
          encrypt_info: { encrypt: false }
        },
        {
          definition: '540p',
          vtype: 'mp4',
          codec_type: 'h264',
          main_url: 'https://qznovelvod.com/video_540.mp4',
          vwidth: 540,
          vheight: 960,
          encrypt_info: { encrypt: false }
        }
      ]
    })
  };

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999', install_id_str: '888' };
    }
    return { code: 0, data: { '40001': entry } };
  };

  try {
    const play = await appSource.fetchAppPlayUrl('40001', { quality: 'auto' });
    assert.equal(play.quality, '1080p');
    assert.equal(play.url, 'https://qznovelvod.com/video_1080.mp4');
    assert.equal(play.codec, 'hevc');
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});


test('fetchAppPlayUrl falls back from HEVC to H.264, ByteVC2, or HEVC transcode when allowHevc is false', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const model = {
    video_duration: 60,
    video_list: [
      {
        definition: '1080p',
        vtype: 'mp4',
        codec_type: 'bytevc1',
        main_url: 'https://qznovelvod.com/video_1080_hevc.mp4',
        vwidth: 1080,
        vheight: 1920,
        encrypt_info: { encrypt: false }
      },
      {
        definition: '720p',
        vtype: 'mp4',
        codec_type: 'h264',
        main_url: 'https://qznovelvod.com/video_720_h264.mp4',
        vwidth: 720,
        vheight: 1280,
        encrypt_info: { encrypt: false }
      },
      {
        definition: '720p',
        vtype: 'mp4',
        codec_type: 'bytevc2',
        main_url: 'https://qznovelvod.com/video_720_bvc2.mp4',
        vwidth: 720,
        vheight: 1280,
        encrypt_info: { encrypt: false }
      }
    ]
  };
  appSource.requestJson = async (url) => url.includes('register')
    ? { code: 0, device_id_str: '999', install_id_str: '888' }
    : { code: 0, data: { '40002': { video_model: JSON.stringify(model) } } };

  try {
    // H.264 is preferred directly over HEVC and ByteVC2 when allowHevc=false
    const h264 = await appSource.fetchAppPlayUrl('40002', { allowBytevc2: true, allowHevc: false });
    assert.equal(h264.codec, 'h264');
    assert.equal(h264.url, 'https://qznovelvod.com/video_720_h264.mp4');

    // When no H.264 exists, ByteVC2 is preferred over HEVC when allowHevc=false
    model.video_list = model.video_list.filter(item => item.codec_type !== 'h264');
    const bvc2 = await appSource.fetchAppPlayUrl('40002', { refresh: true, allowBytevc2: true, allowHevc: false });
    assert.equal(bvc2.codec, 'bytevc2');
    assert.equal(bvc2.url, 'https://qznovelvod.com/video_720_bvc2.mp4');

    // When only HEVC exists, UNSUPPORTED_HEVC is thrown unless allowHevcTranscode is true
    model.video_list = model.video_list.filter(item => item.codec_type === 'bytevc1');
    await assert.rejects(
      appSource.fetchAppPlayUrl('40002', { refresh: true, allowBytevc2: true, allowHevc: false, allowHevcTranscode: false }),
      { code: 'UNSUPPORTED_HEVC' }
    );
    const hevcTranscode = await appSource.fetchAppPlayUrl('40002', { allowBytevc2: true, allowHevc: false, allowHevcTranscode: true });
    assert.equal(hevcTranscode.codec, 'hevc');
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});



test('fetchAppPlayUrl remembers working cluster per device and falls back across shortplay hosts', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const urls = [];
  let currentVid = '40003';

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999', install_id_str: '888' };
    }
    urls.push(url);
    if (url.includes('api5-normal-lq.fqnovel.com/novel/player/multi_video_model/')) {
      return { code: 0, data: { [currentVid]: mockEntry(currentVid) } };
    }
    throw Object.assign(new Error('App upstream returned empty response'), { code: 'EMPTY_RESPONSE' });
  };

  try {
    const first = await appSource.fetchAppPlayUrl('40003');
    assert.equal(first.url, 'https://qznovelvod.com/video_40003.mp4');
    assert.equal(urls.length, 3);
    assert.ok(urls[2].includes('api5-normal-lq.fqnovel.com'));

    // Next episode for same device should prioritize the sticky working cluster first
    urls.length = 0;
    currentVid = '40004';
    const second = await appSource.fetchAppPlayUrl('40004');
    assert.equal(second.url, 'https://qznovelvod.com/video_40004.mp4');
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('api5-normal-lq.fqnovel.com'));
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});

test('fetchAppPlayUrl retries across alternative shortplay cluster hosts when primary shortplay host returns EMPTY_RESPONSE', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const urls = [];

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999', install_id_str: '888' };
    }
    urls.push(url);
    if (url.includes('api5-normal-lq.fqnovel.com/novel/player/video_model/v1/')) {
      return { code: 0, data: { '40005': mockEntry('40005') } };
    }
    throw Object.assign(new Error('App upstream returned empty response'), { code: 'EMPTY_RESPONSE' });
  };

  try {
    const play = await appSource.fetchAppPlayUrl('40005');
    assert.equal(play.url, 'https://qznovelvod.com/video_40005.mp4');
    assert.equal(urls.length, 7);
    assert.ok(urls[5].includes('api3-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/'));
    assert.ok(urls[6].includes('api5-normal-lq.fqnovel.com/novel/player/video_model/v1/'));
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});

test('fetchAppPlayUrl deduplicates concurrent in-flight requests for the same vid', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  let upstreamCalls = 0;
  let releaseUpstream;
  const gate = new Promise(resolve => { releaseUpstream = resolve; });

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999', install_id_str: '888' };
    }
    upstreamCalls++;
    await gate;
    return { code: 0, data: { '40006': mockEntry('40006') } };
  };

  try {
    const controller1 = new AbortController();
    const p1 = appSource.fetchAppPlayUrl('40006', { signal: controller1.signal });
    const p2 = appSource.fetchAppPlayUrl('40006', { quality: 'auto' });

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(upstreamCalls, 1, 'Concurrent calls for the same vid should share a single upstream request');

    // Aborting one caller must not cancel the shared upstream request for the other caller
    controller1.abort(new Error('caller 1 aborted'));
    await assert.rejects(p1, /caller 1 aborted/);

    releaseUpstream();
    const res2 = await p2;
    assert.equal(res2.url, 'https://qznovelvod.com/video_40006.mp4');
    assert.equal(upstreamCalls, 1);
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
  }
});

test('fetchAppPlayUrl retries once after brief sync delay when a freshly registered device fails all clusters with EMPTY_RESPONSE', async () => {
  const { getPlaybackDevice } = require('../../src/server/native/playback-device');
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  getPlaybackDevice.reset();
  let playCalls = 0;

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999001', install_id_str: '888001' };
    }
    playCalls++;
    // First 8 calls cover 5 multi_video_model + 3 shortplay; succeed on the 9th call (post-sync retry)
    if (playCalls <= 8) {
      throw Object.assign(new Error('App upstream returned empty response'), { code: 'EMPTY_RESPONSE' });
    }
    return { code: 0, data: { '40007': mockEntry('40007') } };
  };

  try {
    const play = await appSource.fetchAppPlayUrl('40007');
    assert.equal(play.url, 'https://qznovelvod.com/video_40007.mp4');
    assert.equal(playCalls, 9);
  } finally {
    appSource.requestJson = originalRequest;
    appSource.clearEntryCache();
    getPlaybackDevice.reset();
  }
});