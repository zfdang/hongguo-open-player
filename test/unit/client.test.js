const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function client(fetch, overrides = {}) {
  let state;
  const mounted = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/client/js/app.js'), 'utf8'), {
    Vue: { ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }),
      nextTick: async fn => { if (fn) fn(); }, onMounted(fn) { mounted.push(fn); }, onUnmounted() {},
      createApp: options => ({ mount() { state = options.setup(); } }) },
    navigator: { userAgent: '' }, document: { documentElement: { classList: { add() {} } } },
    fetch, console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, window: { addEventListener() {}, removeEventListener() {} }, ...overrides
  });
  state.mountForTest = () => mounted.forEach(fn => fn());
  return state;
}
const response = data => ({ ok: true, json: async () => data });

test('late catalog responses cannot replace the active tab; search pagination keeps keyword', async () => {
  const requests = [];
  const state = client(url => new Promise(resolve => requests.push({ url, resolve })));
  const first = state.loadCatalog();
  state.switchTab('favorites');
  requests[1].resolve(response([{ series_id: '2' }]));
  await new Promise(resolve => setImmediate(resolve));
  requests[0].resolve(response({ results: [{ series_id: '1' }] }));
  await first;
  assert.equal(state.currentDramas.value[0].series_id, '2');
  state.searchKeyword.value = '离婚';
  const search = state.handleSearch();
  requests[2].resolve(response({ results: [], hasMore: true }));
  await search;
  state.changePage(1);
  assert.match(requests[3].url, /keyword=.*&page=2$/);
  requests[3].resolve(response({ results: [], hasMore: false }));
});

module.exports = { client, response };

test('search from saved lists enters search mode and keeps paging independent of draft input', async () => {
  for (const tab of ['history', 'favorites']) {
    const requests = [];
    const state = client(async url => {
      requests.push(url);
      return response(url.startsWith('/api/search')
        ? { results: [{ series_id: '123' }], hasMore: true }
        : []);
    });
    state.switchTab(tab);
    state.searchKeyword.value = '离婚';
    await state.handleSearch();
    assert.equal(state.currentTab.value, 'search');
    assert.equal(state.hasMore.value, true);
    state.searchKeyword.value = '';
    state.changePage(1);
    assert.equal(requests.at(-1), '/api/search?keyword=%E7%A6%BB%E5%A9%9A&page=2');
    state.switchTab(tab);
    assert.equal(state.currentPage.value, 1);
    assert.equal(requests.at(-1), `/api/${tab}`);
  }
});

test('switching series and episodes resets progress and canplay preserves a user pause', async () => {
  const saved = [];
  const series = id => ({ series_id: id, episodes: [{ vid: `${id}1`, vid_index: 1 }, { vid: `${id}2`, vid_index: 2 }] });
  const state = client(async (url, options) => {
    if (url === '/api/progress') { saved.push(JSON.parse(options.body)); return response({}); }
    return response(series(url.split('/').pop()));
  });
  await state.openTheater({ series_id: '1' });
  let plays = 0;
  const video = { duration: 100, currentTime: 42, buffered: { length: 0 }, paused: true,
    pause() {}, play() { plays++; return Promise.resolve(); } };
  state.videoEl.value = video;
  state.onLoadedMetadata();
  state.onTimeUpdate();
  state.switchEpisode({ vid_index: 2 });
  assert.equal(saved[0].episode_index, 1);
  assert.equal(saved[0].position_sec, 42);
  state.onPause(); // metadata is not ready for the new episode
  assert.equal(saved.length, 1);
  assert.equal(state.duration.value, 0);
  const before = plays;
  state.onCanPlay();
  assert.equal(plays, before);
  await state.openTheater({ series_id: '2' });
  assert.equal(state.currentTime.value, 0);
  assert.equal(saved.length, 1);
});

test('a pending drama detail cannot reopen theater after navigating away', async () => {
  let resolveDetail;
  const state = client(url => url.startsWith('/api/series/')
    ? new Promise(resolve => { resolveDetail = resolve; }) : Promise.resolve(response([])));
  const opening = state.openTheater({ series_id: '1' });
  state.switchTab('history');
  resolveDetail(response({ series_id: '1', episodes: [{ vid: '1', vid_index: 1 }] }));
  await opening;
  assert.equal(state.viewMode.value, 'catalog');
});

test('favoriting a long series sends metadata without its full episode list', async () => {
  let body;
  const state = client(async (url, options) => { body = JSON.parse(options.body); return response({ is_favorite: true }); });
  state.activeSeries.value = { series_id: '123', total: 1000, episodes: Array(1000).fill({ title: 'x'.repeat(1000) }) };
  await state.toggleFavCurrent();
  assert.equal(body.episode_count, 1000);
  assert.equal(body.episodes, undefined);
  assert.ok(JSON.stringify(body).length < 1024);
});

test('fullscreen Escape preserves theater and select keys do not switch episodes', () => {
  const listeners = {};
  let exits = 0;
  const doc = { documentElement: { classList: { add() {} } }, fullscreenElement: {}, exitFullscreen: async () => { exits++; } };
  const state = client(async () => response([]), { document: doc, window: { addEventListener: (name, fn) => { listeners[name] = fn; } } });
  state.mountForTest(); state.viewMode.value = 'theater';
  listeners.keydown({ target: { tagName: 'DIV' }, code: 'Escape', key: 'Escape' });
  assert.equal(exits, 1); assert.equal(state.viewMode.value, 'theater');
  state.activeEpisodeIndex.value = 1;
  state.activeEpisodes.value = [{ vid_index: 1 }, { vid_index: 2 }];
  listeners.keydown({ target: { tagName: 'SELECT' }, code: 'ArrowDown', key: 'ArrowDown' });
  assert.equal(state.activeEpisodeIndex.value, 1);
});

test('volume adjustment clears mute and resume hydrates only recorded watched episodes', async () => {
  const state = client(async () => response({ series_id: '1', episodes: [{ vid: '1', vid_index: 1 }], saved_progress: { watched_indexes: [1, 3], episode_index: 1 } }));
  await state.openTheater({ series_id: '1' });
  assert.equal(state.isEpisodeWatched(1), true); assert.equal(state.isEpisodeWatched(2), false);
  state.videoEl.value = { volume: 0, muted: true };
  state.volume.value = 0.5;
  state.changeVolume();
  assert.equal(state.videoEl.value.muted, false);
  assert.equal(state.isMuted.value, false);
  assert.equal(state.isBuffering.value, true);
});

test('scrubbing clamps positions and ignores playback time updates while dragging', () => {
  const state = client(async () => response([]));
  state.duration.value = 100;
  state.videoEl.value = { currentTime: 10 };
  state.startScrubbing({ target: {} });
  state.seekFromSlider({ target: { value: 150 } });
  assert.equal(state.videoEl.value.currentTime, 100);
  state.videoEl.value.currentTime = 30;
  state.onTimeUpdate();
  assert.equal(state.currentTime.value, 100);
  state.finishScrubbing();
  assert.equal(state.isScrubbing.value, false);
});

test('shortcuts work when focus is on buttons and range inputs, and ignore text inputs', () => {
  const listeners = {};
  let paused = true;
  let blurred = 0;
  let prevented = 0;
  const prevent = () => { prevented++; };
  const blur = () => { blurred++; };
  const video = {
    get paused() { return paused; },
    play: async () => { paused = false; },
    pause: () => { paused = true; },
    currentTime: 20
  };
  const state = client(async () => response([]), { window: { addEventListener: (name, fn) => { listeners[name] = fn; } } });
  state.mountForTest();
  state.viewMode.value = 'theater';
  state.videoEl.value = video;
  state.duration.value = 100;
  state.activeEpisodeIndex.value = 1;
  state.activeEpisodes.value = [{ vid_index: 1 }, { vid_index: 2 }, { vid_index: 3 }];

  // 1. When focus is on a button (e.g. Pause, Fullscreen), Space toggles play and prevents button activation
  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'Space', key: ' ', preventDefault: prevent });
  assert.equal(paused, false);
  assert.equal(prevented, 1);
  assert.equal(blurred, 1);

  // 2. ArrowDown / PageDown switches episode even if button is focused
  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'ArrowDown', key: 'ArrowDown', preventDefault: prevent });
  assert.equal(state.activeEpisodeIndex.value, 2);

  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'PageDown', key: 'PageDown', preventDefault: prevent });
  assert.equal(state.activeEpisodeIndex.value, 3);

  // 3. ArrowUp / PageUp switches to previous episode
  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'PageUp', key: 'PageUp', preventDefault: prevent });
  assert.equal(state.activeEpisodeIndex.value, 2);

  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'ArrowUp', key: 'ArrowUp', preventDefault: prevent });
  assert.equal(state.activeEpisodeIndex.value, 1);

  // 4. ArrowLeft / ArrowRight seeks video (+5s from 0 after episode switch)
  state.duration.value = 100;
  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'ArrowRight', key: 'ArrowRight', preventDefault: prevent });
  assert.equal(video.currentTime, 5);

  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'ArrowLeft', key: 'ArrowLeft', preventDefault: prevent });
  assert.equal(video.currentTime, 0);

  // 5. When focus is on a range slider (progress bar), Space toggles play
  listeners.keydown({ target: { tagName: 'INPUT', type: 'range', blur }, code: 'Space', key: ' ', preventDefault: prevent });
  assert.equal(paused, true);

  // 6. When typing in a text input (e.g. search box), shortcuts are ignored
  listeners.keydown({ target: { tagName: 'INPUT', type: 'text' }, code: 'Space', key: ' ', preventDefault: prevent });
  assert.equal(paused, true); // not toggled
});

test('clicking controls blurs them and maintains focus on .player-container', () => {
  let focused = null;
  const container = {
    focus() { focused = container; }
  };
  const docListeners = {};
  const doc = {
    documentElement: { classList: { add() {} } },
    querySelector(selector) {
      if (selector === '.player-container') return container;
      return null;
    },
    addEventListener(name, fn) { docListeners[name] = fn; },
    removeEventListener() {}
  };
  const state = client(async () => response([]), {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {} }
  });
  state.mountForTest();
  state.viewMode.value = 'theater';

  // Initially keep focus on player container
  state.keepPlayerFocus();
  assert.equal(focused, container);

  // When a button gets focusin, it should blur and restore container focus
  let buttonBlurred = false;
  const button = {
    tagName: 'BUTTON',
    blur() { buttonBlurred = true; },
    closest(sel) { return sel === 'button' ? button : null; }
  };
  focused = null;
  docListeners.focusin?.({ target: button });
  assert.equal(buttonBlurred, true);
  assert.equal(focused, container);

  // When a range slider gets focusin, it should blur and restore container focus
  let rangeBlurred = false;
  const range = {
    tagName: 'INPUT',
    type: 'range',
    blur() { rangeBlurred = true; }
  };
  focused = null;
  docListeners.focusin?.({ target: range });
  assert.equal(rangeBlurred, true);
  assert.equal(focused, container);
});

test('actor tab navigation, paging, profile modal and opening drama works', async () => {
  const requests = [];
  const state = client(async (url) => {
    requests.push(url);
    if (url.startsWith('/api/actors/ranking')) {
      return response({
        success: true,
        rank_date: '2026-10-29',
        has_more: true,
        actors: [
          { actor_id: '7123456789', name: '张三', rank: 1, score: '1000万人气' },
          { actor_id: '7123456790', name: '李四', rank: 2, score: '800万人气' }
        ]
      });
    }
    if (url.startsWith('/api/actors/7123456789/works')) {
      return response({
        success: true,
        works: [
          { series_id: 'series-101', series_title: '热血短剧', cover: 'https://img.test/cover.jpg' }
        ]
      });
    }
    if (url.startsWith('/api/actors/7123456789')) {
      return response({
        success: true,
        actor: {
          actor_id: '7123456789',
          name: '张三',
          intro: '青年演员',
          related_actors: [{ actor_id: '7123456799', name: '王五' }]
        }
      });
    }
    if (url.startsWith('/api/series/series-101')) {
      return response({
        series_id: 'series-101',
        series_title: '热血短剧',
        episodes: [{ vid: 'v101', vid_index: 1, title: '第1集' }]
      });
    }
    return response({ results: [], hasMore: false });
  });

  // 1. switchTab('actors')
  state.switchTab('actors');
  assert.equal(state.currentTab.value, 'actors');
  assert.equal(state.actorPage.value, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0], '/api/actors/ranking?page=1');
  assert.equal(state.actors.value.length, 2);
  assert.equal(state.actorRankDate.value, '2026-10-29');
  assert.equal(state.actorHasMore.value, true);

  // 2. changeActorPage(1)
  state.changeActorPage(1);
  assert.equal(state.actorPage.value, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1], '/api/actors/ranking?page=2');

  // 3. openActorDetail
  const openPromise = state.openActorDetail(state.actors.value[0]);
  assert.equal(state.activeActor.value.name, '张三');
  assert.equal(state.loadingActorWorks.value, true);
  await openPromise;
  assert.equal(state.loadingActorWorks.value, false);
  assert.equal(state.activeActorDetail.value.intro, '青年演员');
  assert.equal(state.actorWorks.value.length, 1);
  assert.equal(state.actorWorks.value[0].series_title, '热血短剧');

  // 4. playActorWork transitions into theater and closes modal
  await state.playActorWork(state.actorWorks.value[0]);
  assert.equal(state.activeActor.value, null);
  assert.equal(state.viewMode.value, 'theater');
  assert.equal(state.activeSeries.value.series_id, 'series-101');

  // 5. Escape closes actor detail if open
  const listeners = {};
  const doc = { documentElement: { classList: { add() {} } } };
  const stateWithKeys = client(async () => response([]), {
    document: doc,
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } }
  });
  stateWithKeys.mountForTest();
  stateWithKeys.activeActor.value = { actor_id: '7123456799', name: '王五' };
  let prevented = false;
  listeners.keydown({
    target: { tagName: 'DIV' },
    code: 'Escape',
    key: 'Escape',
    preventDefault: () => { prevented = true; }
  });
  assert.equal(prevented, true);
  assert.equal(stateWithKeys.activeActor.value, null);
});

test('switching actors discards stale responses to prevent overwriting active actor', async () => {
  const pendingRequests = new Map(); // url -> resolve
  const state = client(url => new Promise(resolve => {
    pendingRequests.set(url, resolve);
  }));

  // 1. Open Actor A
  const promiseA = state.openActorDetail({ actor_id: '1001', name: '演员A' });
  assert.equal(state.activeActor.value.name, '演员A');

  // 2. Immediately switch to Actor B before A responds
  const promiseB = state.openActorDetail({ actor_id: '1002', name: '演员B' });
  assert.equal(state.activeActor.value.name, '演员B');

  // 3. Resolve B's requests first
  pendingRequests.get('/api/actors/1002')(response({
    success: true,
    actor: { actor_id: '1002', name: '演员B', intro: 'B的真实简介' }
  }));
  pendingRequests.get('/api/actors/1002/works?count=20&offset=0')(response({
    success: true,
    works: [{ series_id: 'b-series', series_title: 'B的作品' }],
    total_count: 1
  }));
  await promiseB;

  assert.equal(state.activeActor.value.name, '演员B');
  assert.equal(state.activeActorDetail.value.name, '演员B');
  assert.equal(state.activeActorDetail.value.intro, 'B的真实简介');
  assert.equal(state.actorWorks.value[0].series_title, 'B的作品');

  // 4. Now let A's slow requests arrive late
  pendingRequests.get('/api/actors/1001')(response({
    success: true,
    actor: { actor_id: '1001', name: '演员A', intro: 'A的迟到简介' }
  }));
  pendingRequests.get('/api/actors/1001/works?count=20&offset=0')(response({
    success: true,
    works: [{ series_id: 'a-series', series_title: 'A的作品' }],
    total_count: 1
  }));
  await promiseA;

  // 5. Must NOT be overwritten by A!
  assert.equal(state.activeActor.value.name, '演员B');
  assert.equal(state.activeActorDetail.value.name, '演员B');
  assert.equal(state.activeActorDetail.value.intro, 'B的真实简介');
  assert.equal(state.actorWorks.value[0].series_title, 'B的作品');
});

test('actor works pagination loads batches and appends without duplicates', async () => {
  const state = client(async (url) => {
    if (url.includes('/api/actors/8888/works?count=20&offset=0')) {
      return response({
        success: true,
        total_count: 3,
        has_more: true,
        works: [
          { series_id: 's1', series_title: '作品1' },
          { series_id: 's2', series_title: '作品2' }
        ]
      });
    }
    if (url.includes('/api/actors/8888/works?count=20&offset=2')) {
      return response({
        success: true,
        total_count: 3,
        has_more: false,
        works: [
          { series_id: 's3', series_title: '作品3' }
        ]
      });
    }
    if (url.startsWith('/api/actors/8888')) {
      return response({
        success: true,
        actor: { actor_id: '8888', name: '多产演员' }
      });
    }
    return response({ results: [] });
  });

  await state.openActorDetail({ actor_id: '8888', name: '多产演员' });
  assert.equal(state.actorWorks.value.length, 2);
  assert.equal(state.actorWorksTotal.value, 3);
  assert.equal(state.actorWorksHasMore.value, true);

  // Load next batch
  await state.loadMoreActorWorks();
  assert.equal(state.actorWorks.value.length, 3);
  assert.equal(state.actorWorks.value[2].series_title, '作品3');
  assert.equal(state.actorWorksHasMore.value, false);
});

test('actor works failure displays error and retry recovers state', async () => {
  let shouldFail = true;
  const state = client(async (url) => {
    if (url.startsWith('/api/actors/9999/works')) {
      if (shouldFail) {
        return { ok: false, status: 502, json: async () => ({ success: false, error: '网络连接超时' }) };
      }
      return response({
        success: true,
        total_count: 1,
        has_more: false,
        works: [{ series_id: 's9', series_title: '重试成功的作品' }]
      });
    }
    return response({
      success: true,
      actor: { actor_id: '9999', name: '重试演员' }
    });
  });

  await state.openActorDetail({ actor_id: '9999', name: '重试演员' });
  assert.equal(state.loadingActorWorks.value, false);
  assert.ok(state.actorWorksError.value.includes('网络连接超时') || state.actorWorksError.value.includes('失败'));
  assert.equal(state.actorWorks.value.length, 0);

  // Retry loading works
  shouldFail = false;
  await state.retryLoadActorWorks();
  assert.equal(state.actorWorksError.value, '');
  assert.equal(state.actorWorks.value.length, 1);
  assert.equal(state.actorWorks.value[0].series_title, '重试成功的作品');
});

test('stale actor ranking responses do not overwrite current page after switching tabs or pages', async () => {
  const pendingRequests = new Map();
  const state = client(url => new Promise(resolve => {
    pendingRequests.set(url, resolve);
  }));

  // 1. Enter actors tab
  state.switchTab('actors');
  assert.equal(state.currentTab.value, 'actors');
  assert.equal(state.actorPage.value, 1);

  // Resolve page 1
  pendingRequests.get('/api/actors/ranking?page=1')(response({
    success: true,
    rank_date: '2026-10-29',
    has_more: true,
    actors: [{ actor_id: '1', name: '第1页演员1', rank: 1 }]
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.actors.value[0].name, '第1页演员1');

  // 2. Request page 2
  state.changeActorPage(1);
  assert.equal(state.actorPage.value, 2);
  const p2Resolve = pendingRequests.get('/api/actors/ranking?page=2');
  assert.ok(p2Resolve);

  // 3. While page 2 is pending, switch to 'hot-drama', then return to 'actors'
  state.switchTab('hot-drama');
  assert.equal(state.currentTab.value, 'hot-drama');
  state.switchTab('actors');
  assert.equal(state.currentTab.value, 'actors');
  assert.equal(state.actorPage.value, 1);

  // 4. Resolve the new page 1 request
  const newP1Resolve = pendingRequests.get('/api/actors/ranking?page=1');
  newP1Resolve(response({
    success: true,
    rank_date: '2026-10-29',
    has_more: true,
    actors: [{ actor_id: '1', name: '最新第1页演员', rank: 1 }]
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.actors.value[0].name, '最新第1页演员');

  // 5. Now the stale page 2 request finally arrives late!
  p2Resolve(response({
    success: true,
    rank_date: '2026-10-29',
    has_more: true,
    actors: [{ actor_id: '21', name: '迟到的第2页演员', rank: 21 }]
  }));
  await new Promise(resolve => setImmediate(resolve));

  // Must NOT overwrite page 1!
  assert.equal(state.actorPage.value, 1);
  assert.equal(state.actors.value[0].name, '最新第1页演员');
  assert.equal(state.actors.value[0].rank, 1);
});

test('switching actor gender reloads rankings with gender query and discards stale gender responses', async () => {
  const pendingRequests = new Map();
  const state = client(url => new Promise(resolve => {
    pendingRequests.set(url, resolve);
  }));

  state.switchTab('actors');
  assert.equal(state.actorGender.value, 'all');

  // Resolve initial 'all' request
  pendingRequests.get('/api/actors/ranking?page=1')(response({
    success: true,
    rank_date: '2026-10-29',
    has_more: true,
    actors: [{ actor_id: '1', name: '全部演员', rank: 1 }]
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.actors.value[0].name, '全部演员');

  // 1. Advance to page 2 of 'all'
  state.changeActorPage(1);
  assert.equal(state.actorPage.value, 2);

  // 2. Switch to 'male' -> must reset actorPage to 1 and request gender=male
  state.switchActorGender('male');
  assert.equal(state.actorGender.value, 'male');
  assert.equal(state.actorPage.value, 1);

  const maleReqKey = '/api/actors/ranking?page=1&limit=20&gender=male';
  const maleResolve = pendingRequests.get(maleReqKey);
  assert.ok(maleResolve, `Should have requested ${maleReqKey}`);

  // 3. While male request is in flight, switch to 'female'
  state.switchActorGender('female');
  assert.equal(state.actorGender.value, 'female');
  assert.equal(state.actorPage.value, 1);

  const femaleReqKey = '/api/actors/ranking?page=1&limit=20&gender=female';
  const femaleResolve = pendingRequests.get(femaleReqKey);
  assert.ok(femaleResolve, `Should have requested ${femaleReqKey}`);

  // 4. Male request finally arrives late!
  maleResolve(response({
    success: true,
    actors: [{ actor_id: 'm1', name: '男演员1', rank: 4 }]
  }));
  await new Promise(resolve => setImmediate(resolve));

  // Must NOT overwrite with male data!
  assert.notEqual(state.actors.value[0]?.name, '男演员1');

  // 5. Female response arrives
  femaleResolve(response({
    success: true,
    actors: [{ actor_id: 'f1', name: '女演员1', rank: 1 }]
  }));
  await new Promise(resolve => setImmediate(resolve));

  // Now active data is female
  assert.equal(state.actors.value[0].name, '女演员1');
  assert.equal(state.actorGender.value, 'female');
});

test('catalog loading failure sets catalogError and retrying clears it', async () => {
  let shouldFail = true;
  const state = client(async () => {
    if (shouldFail) return { ok: false, status: 503, json: async () => ({ error: '服务暂时不可用' }) };
    return response({ results: [{ series_id: '100', series_title: '成功剧目' }], hasMore: false });
  });

  await state.loadCatalog();
  assert.equal(state.currentDramas.value.length, 0);
  assert.match(state.catalogError.value, /加载失败 \(503\)/);

  // Now retry
  shouldFail = false;
  await state.loadCatalog();
  assert.equal(state.catalogError.value, null);
  assert.equal(state.currentDramas.value.length, 1);
  assert.equal(state.currentDramas.value[0].series_id, '100');
});

test('fullscreen auto-hide: controls hide when idle while playing, awaken on interaction, and stay visible when paused or scrubbing', async () => {
  let timerFn = null;
  let timerMs = 0;
  let timerCleared = false;

  const mockSetTimeout = (fn, ms) => {
    timerFn = fn;
    timerMs = ms;
    timerCleared = false;
    return 123;
  };
  const mockClearTimeout = () => {
    timerCleared = true;
    timerFn = null;
  };

  const bodyClasses = new Set();
  const state = client(async () => response([]), {
    setTimeout: mockSetTimeout,
    clearTimeout: mockClearTimeout,
    document: {
      fullscreenElement: null,
      documentElement: { classList: { add() {} } },
      body: {
        classList: {
          add: cls => bodyClasses.add(cls),
          remove: cls => bodyClasses.delete(cls),
          toggle: (cls, val) => {
            if (val) bodyClasses.add(cls);
            else bodyClasses.delete(cls);
          },
          contains: cls => bodyClasses.has(cls)
        }
      },
      addEventListener() {},
      removeEventListener() {}
    }
  });

  // Initially not fullscreen, not playing
  assert.equal(state.isFullscreen.value, false);
  assert.equal(state.isControlsHidden.value, false);
  assert.equal(bodyClasses.has('hide-cursor'), false);

  // 1. Enter fullscreen while playing
  state.isFullscreen.value = true;
  state.isPlaying.value = true;
  state.resetControlsTimer();

  assert.equal(timerMs, 2500, 'Controls timer should be set to 2.5s');
  assert.ok(typeof timerFn === 'function');
  assert.equal(state.isControlsHidden.value, false);
  assert.equal(bodyClasses.has('hide-cursor'), false);

  // Fire the timer -> controls should hide and hide-cursor class added
  timerFn();
  assert.equal(state.isControlsHidden.value, true, 'Controls should hide after timer fires');
  assert.equal(bodyClasses.has('hide-cursor'), true, 'Body must have hide-cursor class');

  // 2. User moves mouse / interacts -> resetControlsTimer awakens controls and restores cursor immediately
  state.resetControlsTimer();
  assert.equal(state.isControlsHidden.value, false, 'Controls should awaken on user interaction');
  assert.equal(bodyClasses.has('hide-cursor'), false, 'hide-cursor must be removed on user interaction');

  // Fire timer again
  state.resetControlsTimer();
  timerFn();
  assert.equal(bodyClasses.has('hide-cursor'), true);

  // Window mouse move also awakens controls
  state.handleWindowMouseMove();
  assert.equal(state.isControlsHidden.value, false);
  assert.equal(bodyClasses.has('hide-cursor'), false);

  // 3. User pauses video -> controls must not hide
  state.onPause();
  assert.equal(state.isControlsHidden.value, false);
  assert.equal(bodyClasses.has('hide-cursor'), false);
  assert.ok(timerCleared, 'Timer should be cleared when paused');

  // Calling resetControlsTimer while paused should not set a timer
  timerFn = null;
  state.resetControlsTimer();
  assert.equal(timerFn, null, 'Should not set hide timer while paused');

  // 4. User starts scrubbing -> controls must not hide
  state.isPlaying.value = true;
  state.startScrubbing({ target: {} });
  assert.equal(state.isScrubbing.value, true);
  state.resetControlsTimer();
  assert.equal(timerFn, null, 'Should not set hide timer while scrubbing');

  // Finish scrubbing -> resets timer
  state.finishScrubbing({});
  assert.equal(state.isScrubbing.value, false);
  assert.equal(timerMs, 2500);

  // 5. Exiting fullscreen clears timer and shows controls
  state.isFullscreen.value = false;
  state.clearControlsTimer();
  assert.ok(timerCleared);
  assert.equal(state.isControlsHidden.value, false);
  assert.equal(bodyClasses.has('hide-cursor'), false);
});

test('theater sidebar toggle button toggles state and updates responsive button UI', () => {
  const state = client(async () => response([]));
  state.mountForTest();
  assert.equal(state.sidebarOpen.value, true);

  // Toggle sidebar
  state.sidebarOpen.value = !state.sidebarOpen.value;
  assert.equal(state.sidebarOpen.value, false);

  // Toggle back
  state.sidebarOpen.value = !state.sidebarOpen.value;
  assert.equal(state.sidebarOpen.value, true);
});

test('index.html layout places favorite button to the left of sidebar-toggle-btn with state icons', () => {
  const path = require('node:path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/client/index.html'), 'utf-8');
  assert.ok(html.includes('class="player-actions"'));
  
  const favIndex = html.indexOf('class="fav-action-btn"');
  const toggleIndex = html.indexOf('class="sidebar-toggle-btn"');
  assert.ok(favIndex !== -1 && toggleIndex !== -1, 'Both buttons must exist');
  assert.ok(favIndex < toggleIndex, 'Favorite button must be on the left, sidebar toggle on the right');
  
  assert.ok(html.includes('sidebar-toggle-icon'));
  assert.ok(html.includes("sidebarOpen ? '收起选集' : '展开选集'"));
});

test('drama detail modal state opens on openDramaDetail and closes on Escape/closeDramaDetail', () => {
  const state = client(async () => response([]));
  state.mountForTest();
  assert.equal(state.showDramaDetailModal.value, false);

  state.activeSeries.value = {
    series_id: '123',
    series_title: '测试短剧',
    intro: '这是一部精彩短剧的简介',
    tags: ['都市', '逆袭']
  };

  // Open drama detail
  state.openDramaDetail();
  assert.equal(state.showDramaDetailModal.value, true);

  // Close via onDramaModalKeydown with Escape
  let stopped = false, prevented = false;
  state.onDramaModalKeydown({
    key: 'Escape',
    stopPropagation: () => { stopped = true; },
    preventDefault: () => { prevented = true; }
  });
  assert.equal(state.showDramaDetailModal.value, false);
  assert.ok(stopped && prevented);

  // Reopen and close via closeDramaDetail
  state.openDramaDetail();
  assert.equal(state.showDramaDetailModal.value, true);
  state.closeDramaDetail();
  assert.equal(state.showDramaDetailModal.value, false);
});

test('index.html includes sidebar drama header with fav heart icon button and drama detail modal with cast section', () => {
  const path = require('node:path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/client/index.html'), 'utf-8');
  assert.ok(html.includes('class="sidebar-fav-icon-btn"'), 'Heart icon button in top right must exist');
  assert.ok(html.includes('class="fav-heart-icon"'), 'Heart icon must exist');
  assert.ok(html.includes('class="sidebar-intro-preview"'), 'Intro preview in sidebar header must exist');
  assert.ok(html.includes('class="drama-modal-overlay"'), 'Drama detail modal overlay must exist');
  assert.ok(html.includes('class="drama-modal"'), 'Drama modal dialog must exist');
  assert.ok(html.includes('class="drama-cast-section"'), 'Cast section in drama modal must exist');
  assert.ok(html.includes('openActorFromDrama'), 'Clicking cast card must trigger openActorFromDrama');
});

test('openActorFromDrama closes drama detail modal and opens actor detail', async () => {
  let actorDetailRequested = null;
  const state = client(async (url) => {
    if (url.includes('/api/actors/')) {
      actorDetailRequested = url;
      return response({
        success: true,
        actor: {
          actor_id: '7602119348190205246',
          name: '王妈',
          avatar: 'https://example.com/avatar.jpg'
        },
        works: []
      });
    }
    return response([]);
  });
  state.mountForTest();

  state.activeSeries.value = {
    series_id: '123',
    series_title: '测试短剧',
    celebrities: [
      { actor_id: '7602119348190205246', name: '王妈', role: '饰 王妈', avatar: 'https://example.com/avatar.jpg' }
    ]
  };

  // 1. Open drama detail modal
  state.openDramaDetail();
  assert.equal(state.showDramaDetailModal.value, true);

  // 2. Click actor in drama
  state.openActorFromDrama(state.activeSeries.value.celebrities[0]);
  assert.equal(state.showDramaDetailModal.value, false, 'Drama detail modal should close');
  assert.ok(state.activeActor.value, 'Actor modal should open with activeActor set');
  assert.equal(state.activeActor.value.actor_id, '7602119348190205246');
  assert.equal(state.activeActor.value.name, '王妈');
});

test('index.html layout includes header hamburger menu button, dropdown menu, and modals', () => {
  const html = fs.readFileSync(require.resolve('../../src/client/index.html'), 'utf8');
  assert.ok(html.includes('class="header-menu-container"'), 'Header menu container must exist');
  assert.ok(html.includes('class="header-menu-btn"'), 'Header hamburger menu button must exist');
  assert.ok(html.includes('class="header-dropdown-menu"'), 'Dropdown menu must exist');
  assert.ok(html.includes('openShortcutsModal'), 'Shortcuts item must exist');
  assert.ok(html.includes('openLogDir'), 'Open log dir item must exist');
  assert.ok(html.includes('openLogFile'), 'Open log file item must exist');
  assert.ok(html.includes('openAboutModal'), 'About modal item must exist');
  assert.ok(html.includes('class="shortcuts-modal"'), 'Shortcuts modal dialog must exist');
  assert.ok(html.includes('class="about-modal"'), 'About modal dialog must exist');
});

test('app menu toggles and modals open and close correctly', async () => {
  let fetchPostUrl = null;
  const state = client(async (url, opts) => {
    if (opts?.method === 'POST') {
      fetchPostUrl = url;
      return response({ success: true });
    }
    return response([]);
  });

  // 1. Menu toggle
  assert.equal(state.showAppMenu.value, false);
  state.toggleAppMenu();
  assert.equal(state.showAppMenu.value, true);
  state.closeAppMenu();
  assert.equal(state.showAppMenu.value, false);

  // 2. About modal
  state.openAboutModal();
  assert.equal(state.showAboutModal.value, true);
  assert.equal(state.showAppMenu.value, false);
  state.closeAboutModal();
  assert.equal(state.showAboutModal.value, false);

  // 3. Shortcuts modal
  state.openShortcutsModal();
  assert.equal(state.showShortcutsModal.value, true);
  assert.equal(state.showAppMenu.value, false);
  state.closeShortcutsModal();
  assert.equal(state.showShortcutsModal.value, false);

  // 4. Log actions
  await state.openLogDir();
  assert.equal(fetchPostUrl, '/api/system/open-log-dir');
  assert.equal(state.showAppMenu.value, false);

  await state.openLogFile();
  assert.equal(fetchPostUrl, '/api/system/open-log-file');
  assert.equal(state.showAppMenu.value, false);
});






