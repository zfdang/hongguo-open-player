const { test } = require('node:test');
const assert = require('node:assert/strict');
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

test('fetchAppPlayUrl batches nextVids and caches returned models in entryCache', async () => {
  const originalRequest = appSource.requestJson;
  appSource.clearEntryCache();
  const requests = [];

  appSource.requestJson = async (url, options) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999', install_id_str: '888' };
    }
    requests.push({ url, body: JSON.parse(options.data) });
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
