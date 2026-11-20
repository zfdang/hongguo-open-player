const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function client(fetch, overrides = {}) {
  let state;
  const mounted = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/client/js/app.js'), 'utf8'), {
    Vue: { ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }),
      nextTick: async fn => { if (fn) fn(); }, watch() {}, onMounted(fn) { mounted.push(fn); }, onUnmounted() {},
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
  const state = client(url => url === '/api/search-history' ? Promise.resolve(response([])) : new Promise(resolve => requests.push({ url, resolve })));
  const first = state.loadCatalog();
  state.switchTab('history');
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

test('recommend previews in catalog; theater wheel switches to next recommendation', async () => {
  const requests = [];
  let n = 0;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const state = client(async url => {
    requests.push(url);
    if (url === '/api/recommend/next') return response({ success: true, item: { series_id: String(++n), series_title: '剧' + n } });
    if (url.startsWith('/api/series/')) return response({ series_id: url.split('/').pop(), total: 1, episodes: [{ vid: 'v1', vid_index: 1 }] });
    return response([]);
  });
  await state.loadRecommend();
  assert.equal(state.recommendItem.value.series_id, '1');
  assert.equal(state.viewMode.value, 'catalog', '推荐页内嵌预览播放，不直接进剧场');
  assert.equal(state.recommendDetail.value.series_id, '1');
  assert.equal(state.recommendStreamUrl.value, '/api/stream/v1');
  // 剧场滚轮 = 换一部推荐并直接播放
  state.viewMode.value = 'theater';
  state.handlePlayerWheel({ deltaY: 120 });
  await tick(); await tick();
  assert.equal(state.recommendItem.value.series_id, '2');
  assert.equal(state.activeSeries.value.series_id, '2');
  const count = requests.filter(u => u === '/api/recommend/next').length;
  // 节流内的第二次滚动不再发请求
  state.handlePlayerWheel({ deltaY: 120 });
  await tick();
  assert.equal(requests.filter(u => u === '/api/recommend/next').length, count);
});

test('switchTab recommend routes to the recommend endpoint with in-page preview, not catalog or theater', async () => {
  const requests = [];
  const state = client(async url => {
    requests.push(url);
    if (url === '/api/recommend/next') return response({ success: true, item: { series_id: '9', series_title: '剧' } });
    if (url.startsWith('/api/series/')) return response({ series_id: '9', total: 1, episodes: [{ vid: 'v1', vid_index: 1 }] });
    return response([]);
  });
  state.switchTab('recommend');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.currentTab.value, 'recommend');
  assert.ok(requests.includes('/api/recommend/next'));
  assert.ok(!requests.some(u => u.startsWith('/api/catalog')));
  assert.equal(state.viewMode.value, 'catalog', '推荐 tab 页内预览播放，不进剧场');
  assert.equal(state.recommendStreamUrl.value, '/api/stream/v1');
});

module.exports = { client, response };

test('search from saved lists enters search mode and keeps paging independent of draft input', async () => {
  for (const tab of ['history']) {
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

  // 6. Pressing J toggles sidebarOpen
  assert.equal(state.sidebarOpen.value, true);
  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'KeyJ', key: 'j', preventDefault: prevent });
  assert.equal(state.sidebarOpen.value, false);
  listeners.keydown({ target: { tagName: 'BUTTON', blur }, code: 'KeyJ', key: 'J', preventDefault: prevent });
  assert.equal(state.sidebarOpen.value, true);

  // 7. When typing in a text input (e.g. search box), shortcuts are ignored
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

test('index.html layout places sidebar-toggle-btn in player actions without local favorite', () => {
  const path = require('node:path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/client/index.html'), 'utf-8');
  assert.ok(html.includes('class="player-actions"'));
  assert.ok(html.includes('class="sidebar-toggle-btn"'));
  assert.ok(!html.includes('fav-action-btn'), 'Local favorite button must be removed');
  assert.ok(!html.includes('toggleFavCurrent'), 'Local favorite handler must be removed');

  assert.ok(html.includes('sidebar-toggle-icon'));
  assert.ok(html.includes("sidebarOpen ? '隐藏侧边栏' : '显示侧边栏'"));
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

test('index.html includes sidebar drama header and drama detail modal without heart favorite', () => {
  const path = require('node:path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/client/index.html'), 'utf-8');
  assert.ok(!html.includes('sidebar-fav-icon-btn'), 'Heart icon button must be removed');
  assert.ok(!html.includes('fav-heart-icon'), 'Heart icon must be removed');
  assert.ok(html.includes('class="sidebar-intro-preview"'), 'Intro preview in sidebar header must exist');
  assert.ok(html.includes('class="drama-modal-overlay"'), 'Drama detail modal overlay must exist');
  assert.ok(html.includes('class="drama-modal"'), 'Drama modal dialog must exist');
});

test('index.html layout includes header hamburger menu button, dropdown menu, and modals', () => {
  const html = fs.readFileSync(require.resolve('../../src/client/index.html'), 'utf8');
  assert.ok(html.includes('class="header-menu-container"'), 'Header menu container must exist');
  assert.ok(html.includes('class="header-menu-btn"'), 'Header hamburger menu button must exist');
  assert.ok(html.includes('class="header-dropdown-menu"'), 'Dropdown menu must exist');
  assert.ok(html.includes('resetDevice'), 'Reset device menu item must exist');
  assert.ok(html.includes('openShortcutsModal'), 'Shortcuts item must exist');
  assert.ok(html.includes('openLogDir'), 'Open log dir item must exist');
  assert.ok(html.includes('openLogFile'), 'Open log file item must exist');
  assert.ok(html.includes('openAboutModal'), 'About modal item must exist');
  assert.ok(html.includes('class="shortcuts-modal"'), 'Shortcuts modal dialog must exist');
  assert.ok(html.includes('class="about-modal"'), 'About modal dialog must exist');
});

test('index.html has recommend nav and single-drama view, and no AI drama tab', () => {
  const html = fs.readFileSync(require.resolve('../../src/client/index.html'), 'utf8');
  assert.ok(html.includes("switchTab('recommend')"), 'Recommend nav button must exist');
  assert.ok(html.includes('class="recommend-container"'), 'Recommend view container must exist');
  assert.ok(html.includes('onRecommendWheel'), 'Recommend wheel handler must be bound');
  assert.ok(html.includes('recommend-next-btn'), 'Recommend next button must exist');
  assert.ok(!html.includes('ai-drama'), 'AI drama tab must be removed');
  assert.ok(!html.includes('AI 短剧'), 'AI drama label must be removed');
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

test('resetDevice triggers POST /api/device/reset and updates currentDeviceId', async () => {
  let requestedUrl = null;
  const state = client(async (url, opts) => {
    requestedUrl = url;
    if (url === '/api/device/reset') {
      return response({ success: true, device: { device_id: '999888777' } });
    }
    if (url === '/api/device') {
      return response({ success: true, device_id: '123456789' });
    }
    return response([]);
  });

  state.showAppMenu.value = true;
  await state.resetDevice();
  assert.equal(requestedUrl, '/api/device/reset');
  assert.equal(state.currentDeviceId.value, '999888777');
  assert.equal(state.showAppMenu.value, false);
});

test('onVideoError probes stream endpoint on code 4 and auto-regenerates device on registration failure', async () => {
  const requests = [];
  const state = client(async (url, options) => {
    requests.push({ url, options, method: options?.method || 'GET' });
    if (url.startsWith('/api/stream/')) {
      return {
        ok: false,
        status: 500,
        json: async () => ({
          code: 'DEVICE_REGISTRATION_FAILED',
          error: '匿名播放设备注册失败（ERR_NETWORK），请稍后重试'
        })
      };
    }
    return response({ success: false });
  });

  state.activeSeries.value = { series_id: '1', series_title: '测试短剧' };
  state.activeEpisodes.value = [{ vid: 'vid-123', vid_index: 1 }];
  state.activeEpisodeIndex.value = 1;
  state.videoEl.value = {
    error: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' }
  };

  await state.onVideoError();

  const probe = requests.find(r => r.url.startsWith('/api/stream/'));
  assert.equal(requests.filter(r => r.url.startsWith('/api/stream/')).length, 1);
  assert.match(probe.url, /\/api\/stream\/vid-123/);
  assert.equal(probe.options?.headers?.Range, 'bytes=0-0');
  assert.match(state.videoErrorMessage.value, /播放设备注册受阻（ERR_NETWORK）/);
  // 设备注册受阻：自动生成新设备ID（重置失败时给出手动指引）
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests.some(r => r.url === '/api/device/reset' && r.method === 'POST'), '应自动调用设备重置');
  assert.match(state.videoErrorMessage.value, /自动生成新设备ID失败/);
});

test('onVideoError auto-regenerates device ID and retries once when upstream returns EMPTY_RESPONSE', async () => {
  const requests = [];
  const state = client(async (url, options) => {
    requests.push({ url, method: options?.method || 'GET' });
    if (url.startsWith('/api/stream/')) {
      return { ok: false, status: 500, json: async () => ({ code: 'EMPTY_RESPONSE', error: 'App 接口返回空响应，可能是签名或设备鉴权问题' }) };
    }
    if (url === '/api/device/reset') return response({ success: true, device: { device_id: 'new-dev-1' } });
    return response({});
  });
  state.activeSeries.value = { series_id: '1', series_title: '测试短剧' };
  state.activeEpisodes.value = [{ vid: '123', vid_index: 1 }, { vid: '456', vid_index: 2 }];
  state.activeEpisodeIndex.value = 1;
  state.videoEl.value = { error: { code: 4, message: 'Format error' }, load() {}, play: async () => {} };
  await state.onVideoError();
  assert.match(state.videoErrorMessage.value, /返回空响应/);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  // 自动重置成功：调用重置接口、更新设备ID、重试本集（清空错误提示）
  assert.ok(requests.some(r => r.url === '/api/device/reset' && r.method === 'POST'));
  assert.equal(state.currentDeviceId.value, 'new-dev-1');
  assert.equal(state.videoErrorMessage.value, '');
  // 同一集只自动重置一次：再次出错不再调重置接口
  const resetCalls = requests.filter(r => r.url === '/api/device/reset').length;
  state.videoEl.value.error = { code: 4, message: 'Format error' };
  await state.onVideoError();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(r => r.url === '/api/device/reset').length, resetCalls);
});

test('onVideoError displays an unsupported ByteVC2 message', async () => {
  const state = client(async url => url.startsWith('/api/stream/')
    ? { ok: false, json: async () => ({ code: 'UNSUPPORTED_BYTEVC2' }) }
    : response({}));
  state.activeSeries.value = { series_id: '1', series_title: '测试短剧' };
  state.activeEpisodes.value = [{ vid: '123', vid_index: 1 }];
  state.activeEpisodeIndex.value = 1;
  state.videoEl.value = { error: { code: 4, message: 'Format error' } };
  await state.onVideoError();
  assert.equal(state.videoErrorMessage.value, '本集使用 ByteVC2 编码，当前播放器暂不支持');
});

test('ByteVC2 progressive playback starts on detection and stops on switching episodes', async () => {
  let started, stopped = 0;
  const state = client(async url => url.startsWith('/api/stream/')
    ? { ok: false, json: async () => ({ code: 'BYTEVC2_PROGRESSIVE', duration: 46 }) }
    : response({}), {
    window: { addEventListener() {}, removeEventListener() {}, Bytevc2Stream: {
      supported: () => true,
      start(video, url, duration) { started = { video, url, duration }; return { stop() { stopped++; } }; }
    } }
  });
  state.activeSeries.value = { series_id: '1', series_title: '测试短剧' };
  state.activeEpisodes.value = [{ vid: '123', vid_index: 1 }, { vid: '456', vid_index: 2 }];
  state.activeEpisodeIndex.value = 1;
  state.videoEl.value = { error: { code: 4 }, play: async () => {}, pause() {} };
  await state.onVideoError();
  assert.match(started.url, /mse=stream/);
  assert.equal(started.duration, 46);
  state.switchEpisode({ vid_index: 2 });
  assert.equal(stopped, 1);
});

test('progressive playback failure falls back to buffered conversion', async () => {
  let fail;
  const state = client(async url => url.startsWith('/api/stream/')
    ? { ok: false, json: async () => ({ code: 'BYTEVC2_PROGRESSIVE', duration: 46 }) }
    : response({}), {
    window: { addEventListener() {}, removeEventListener() {}, Bytevc2Stream: {
      supported: () => true,
      start(_video, _url, _duration, onError) { fail = onError; return { stop() {} }; }
    } }
  });
  state.activeSeries.value = { series_id: '1', series_title: '测试短剧' };
  state.activeEpisodes.value = [{ vid: '123', vid_index: 1 }];
  state.activeEpisodeIndex.value = 1;
  let loaded = 0;
  state.videoEl.value = { error: { code: 4 }, currentTime: 12, load() { loaded++; }, play: async () => {} };
  await state.onVideoError();
  fail(new Error('failed'));
  assert.match(state.videoEl.value.src, /mse=buffered/);
  assert.equal(loaded, 1);
  state.videoEl.value.duration = 46;
  state.onLoadedMetadata();
  assert.equal(state.videoEl.value.currentTime, 12);
  await state.onVideoError();
  assert.match(state.videoErrorMessage.value, /ByteVC2 视频转换或播放失败/);
  assert.equal(loaded, 1, 'a failed fallback must not restart progressive playback');
});

test('onVideoError displays custom stream error when probe reports other server error, and handles code 3', async () => {
  const state = client(async (url) => {
    if (url.startsWith('/api/stream/')) {
      return {
        ok: false,
        status: 500,
        json: async () => ({
          code: 'OTHER_ERROR',
          error: '自定义片源解析失败'
        })
      };
    }
    return response({});
  });

  state.activeSeries.value = { series_id: '1', series_title: '测试短剧' };
  state.activeEpisodes.value = [{ vid: 'vid-456', vid_index: 1 }];
  state.activeEpisodeIndex.value = 1;
  state.videoEl.value = {
    error: { code: 4, message: 'Format error' }
  };

  await state.onVideoError();
  assert.equal(state.videoErrorMessage.value, '自定义片源解析失败；请检查网络或重试切换分集');

  // Code 3 HEVC test
  state.videoEl.value = { error: { code: 3, message: 'Decode error' } };
  await state.onVideoError();
  assert.match(state.videoErrorMessage.value, /HEVC 视频扩展/);
});







test('enabled danmaku loads for each episode and retains display settings', async () => {
  const calls = [];
  const state = client(async url => {
    calls.push(url);
    if (url.startsWith('/api/danmaku/')) return response({ success: true, items: [], total: 0 });
    return response({ series_id: '123456', episodes: [{ vid: '111111', vid_index: 1 }, { vid: '222222', vid_index: 2 }] });
  });
  await state.openTheater({ series_id: '123456' });
  assert.equal(state.danmakuEnabled.value, true);
  assert.equal(state.danmakuRows.value, 3);
  assert.equal(state.danmakuSpeed.value, 'medium');
  state.danmakuRows.value = 5;
  state.danmakuOpacity.value = 0.4;
  state.switchEpisode({ vid_index: 2 });
  assert.ok(calls.some(url => url.startsWith('/api/danmaku/123456/111111')));
  assert.ok(calls.some(url => url.startsWith('/api/danmaku/123456/222222')));
  assert.equal(state.danmakuEnabled.value, true);
  assert.equal(state.danmakuRows.value, 5);
  assert.equal(state.danmakuOpacity.value, 0.4);
});

test('danmaku heat colors use fixed like thresholds', async () => {
  const state = client(async url => url.startsWith('/api/danmaku/')
    ? response({ success: true, items: [{ time: 0, text: 'a', likes: 10 }, { time: 0, text: 'b', likes: 100 }, { time: 0, text: 'c', likes: 500 }] })
    : response({ series_id: '123456', episodes: [{ vid: '111111', vid_index: 1 }] }));
  await state.openTheater({ series_id: '123456' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(new Set([10, 100, 500].map(likes => state.danmakuColor({ likes }))).size, 3);
});

test('danmaku prioritize items accounts for physical length and duration, prioritizing high-likes over blockers', () => {
  const state = client(async () => response([]));
  const { prioritizeDanmakuItems, estimateDanmakuWidth, calculateRequiredGap } = state;

  // 1. 物理长度计算：长文本所需的阻挡时间明显长于短文本
  const shortWidth = estimateDanmakuWidth('短');
  const longWidth = estimateDanmakuWidth('这是一条非常非常长的大段文字用来阻挡屏幕');
  assert.ok(longWidth > shortWidth);

  const shortGap = calculateRequiredGap(shortWidth, shortWidth, 800, 16);
  const longGap = calculateRequiredGap(longWidth, longWidth, 800, 16);
  assert.ok(shortGap < 1.5, `shortGap should be ~1s, got ${shortGap}`);
  assert.ok(longGap > 3.0, `longGap should be >3s, got ${longGap}`);

  // 2. 跨秒时空阻挡测试：
  // 1条长弹幕在 10.0s 进入，因为文本长，需要阻挡该轨道约 3.5s（直到 13.5s 才能容纳新弹幕）。
  // 即使高赞弹幕在 12.0s（不同秒！）才进入，长弹幕的物理长度仍然阻挡了它；
  // 开启高赞优先时，应舍弃 0 赞的长弹幕，保留 12.0s 的高赞弹幕上屏。
  const crossSecondBlock = [
    { time: 10.0, text: '这是一条非常非常长的大段文字用来阻挡屏幕整个轨道三四秒之久', likes: 0 },
    { time: 12.0, text: '高赞核心弹幕', likes: 888 }
  ];
  // 只有 1 行轨道时
  const res1 = prioritizeDanmakuItems(crossSecondBlock, { rows: 1, likesPriority: true });
  assert.equal(res1.length, 1);
  assert.equal(res1[0].text, '高赞核心弹幕');
  assert.equal(res1[0].time, 12.0);

  // 3. 多轨道并发与冲突淘汰测试：
  // 3 条轨道在 10.0s、10.4s、10.8s 分别被 3 条 0 赞长弹幕占满；
  // 随后的 12.0s、12.5s、13.0s 来了 3 条高赞弹幕（点赞分别为 900, 600, 300）；
  // 3 条高赞弹幕均应成功替换 0 赞阻挡弹幕并上屏！
  const multiTrackDense = [
    { time: 10.0, text: '低赞长弹幕一号阻挡', likes: 0 },
    { time: 10.4, text: '低赞长弹幕二号阻挡', likes: 0 },
    { time: 10.8, text: '低赞长弹幕三号阻挡', likes: 0 },
    { time: 12.0, text: '热评第一', likes: 900 },
    { time: 12.5, text: '热评第二', likes: 600 },
    { time: 13.0, text: '热评第三', likes: 300 }
  ];
  const res3 = prioritizeDanmakuItems(multiTrackDense, { rows: 3, likesPriority: true });
  assert.equal(res3.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(res3.map(x => x.text))), ['热评第一', '热评第二', '热评第三']);

  // 4. 无冲突时：多条弹幕（即使 0 赞）完全保留
  const spacedOut = [
    { time: 0.0, text: '短一', likes: 0 },
    { time: 5.0, text: '短二', likes: 0 },
    { time: 10.0, text: '短三', likes: 0 }
  ];
  const resSpaced = prioritizeDanmakuItems(spacedOut, { rows: 1, likesPriority: true });
  assert.equal(resSpaced.length, 3);

  // 5. 关闭高赞优先开关时：保留全量原始弹幕
  const disabled = prioritizeDanmakuItems(crossSecondBlock, { rows: 1, likesPriority: false });
  assert.equal(disabled.length, 2);
});

test('danmaku likes priority toggle updates preference and state', async () => {
  const preferencesSaved = [];
  const state = client(async (url, options) => {
    if (url === '/api/preferences' && options?.method === 'POST') {
      preferencesSaved.push(JSON.parse(options.body));
      return response({});
    }
    return response({});
  });
  assert.equal(state.danmakuLikesPriority.value, true);
  state.toggleLikesPriority();
  assert.equal(state.danmakuLikesPriority.value, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(preferencesSaved.at(-1), { danmakuLikesPriority: false });
});

test('danmaku engine receives episode comments and is replaced when switching episodes', async () => {
  const instances = [];
  class FakeDanmaku {
    constructor(options) { this.options = options; instances.push(this); }
    destroy() { this.destroyed = true; }
    resize() {}
    play() { this.playing = true; }
    pause() { this.playing = false; }
    seek() { this.seeked = true; }
  }
  const state = client(async url => url.startsWith('/api/danmaku/')
    ? response({ success: true, items: [{ time: 2, text: url.includes('111111') ? 'first' : 'second', likes: 0 }] })
    : response({ series_id: '123456', episodes: [{ vid: '111111', vid_index: 1 }, { vid: '222222', vid_index: 2 }] }),
  { Danmaku: FakeDanmaku });
  state.videoEl.value = { pause() {}, play() { return Promise.resolve(); } };
  state.danmakuLayer.value = { offsetWidth: 800, offsetHeight: 96 };
  await state.openTheater({ series_id: '123456' });
  await new Promise(resolve => setImmediate(resolve));
  const first = instances.at(-1);
  assert.equal(first.options.comments[0].time, 2);
  assert.equal(first.options.speed, 50);
  state.switchEpisode({ vid_index: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.destroyed, true);
  assert.notEqual(instances.at(-1), first);
  assert.equal(instances.at(-1).options.comments.length, 1);
});

test('seekFromSlider and finishScrubbing invoke danmakuEngine seek', async () => {
  let seekCalled = 0;
  class FakeDanmaku {
    constructor(options) { this.options = options; }
    destroy() {}
    resize() {}
    seek() { seekCalled++; }
    play() {}
    pause() {}
  }
  const state = client(async url => url.startsWith('/api/danmaku/')
    ? response({ success: true, items: [{ time: 10, text: 'danmaku', likes: 1 }] })
    : response({ series_id: '123456', episodes: [{ vid: '111111', vid_index: 1 }] }),
  { Danmaku: FakeDanmaku });
  state.danmakuLayer.value = { offsetWidth: 800, offsetHeight: 96 };
  await state.openTheater({ series_id: '123456' });
  state.videoEl.value = { pause() {}, play() { return Promise.resolve(); }, currentTime: 0 };
  state.duration.value = 100;
  await new Promise(resolve => setImmediate(resolve));
  state.seekFromSlider({ target: { value: 25 } });
  assert.equal(state.videoEl.value.currentTime, 25);
  assert.ok(seekCalled >= 1);
  const beforeScrub = seekCalled;
  state.finishScrubbing();
  assert.ok(seekCalled > beforeScrub);
});

test('search history selection searches again and supports removal', async () => {
  const calls = [];
  let stored = [];
  const state = client(async (url, options) => {
    calls.push(url);
    if (url === '/api/search-history' && options?.method === 'POST') {
      const { action, keyword } = JSON.parse(options.body);
      stored = action === 'clear' ? [] : action === 'add' ? [keyword, ...stored.filter(x => x !== keyword)].slice(0, 10) : stored.filter(x => x !== keyword);
      return response(stored);
    }
    return response({ results: [], hasMore: false });
  });
  state.searchKeyword.value = '  月亮  ';
  await state.handleSearch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.searchHistory.value[0], '月亮');
  state.selectSearchHistory('月亮');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(url => url.startsWith('/api/search?keyword=')).length, 2);
  assert.equal(state.showSearchHistory.value, false);
  state.updateSearchHistory('remove', '月亮');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.searchHistory.value.length, 0);
  assert.equal(stored.length, 0);
});

test('search history controls retain focus in theater without changing player controls', () => {
  const listeners = {};
  let playerFocuses = 0;
  let blurs = 0;
  const player = { focus() { playerFocuses++; } };
  const doc = {
    documentElement: { classList: { add() {} } },
    addEventListener(name, fn) { listeners[name] = fn; },
    querySelector(selector) { return selector === '.player-container' ? player : null; }
  };
  const state = client(async () => response([]), {
    document: doc,
    window: { addEventListener(name, fn) { listeners[name] = fn; } }
  });
  state.mountForTest();
  state.viewMode.value = 'theater';
  const button = inSearch => ({
    tagName: 'BUTTON',
    blur() { blurs++; },
    closest(selector) { return selector === '.search-box' ? (inSearch ? this : null) : selector === 'button' ? this : null; }
  });
  const historyButton = button(true);
  for (const name of ['pointerdown', 'focusin', 'click']) listeners[name]({ target: historyButton });
  assert.equal(blurs, 0);
  assert.equal(playerFocuses, 0);

  const playerButton = button(false);
  for (const name of ['pointerdown', 'focusin', 'click']) listeners[name]({ target: playerButton });
  assert.equal(blurs, 3);
  assert.equal(playerFocuses, 2);
});

test('late preference loading preserves changes made by the user', async () => {
  let finishPreferences;
  const updates = [];
  const state = client((url, options) => {
    if (url === '/api/preferences' && !options) return new Promise(resolve => { finishPreferences = resolve; });
    if (url === '/api/preferences') { updates.push(JSON.parse(options.body)); return Promise.resolve(response({})); }
    return Promise.resolve(response(url === '/api/search-history' ? [] : { results: [] }));
  }, { document: { documentElement: { classList: { add() {} } }, addEventListener() {}, querySelector() { return null; } } });
  state.mountForTest();
  state.selectSpeed('2.0');
  finishPreferences(response({ playbackRate: '0.75', volume: 0.5, danmakuRows: 5 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.playbackRate.value, '2.0');
  assert.equal(state.volume.value, 0.5);
  assert.equal(state.danmakuRows.value, 5);
  assert.equal(updates[0].playbackRate, '2.0');
});

test('prefetch is requested near the end using remaining playback time and includes next_vids', async () => {
  const calls = [];
  const state = client(async (url, options) => {
    calls.push([url, options]);
    if (url.startsWith('/api/series/')) return response({
      series_id: '123',
      episodes: [
        { vid: '111', vid_index: 1 },
        { vid: '222', vid_index: 2 },
        { vid: '333', vid_index: 3 },
        { vid: '444', vid_index: 4 },
        { vid: '555', vid_index: 5 }
      ]
    });
    return response({ success: true, items: [] });
  });
  await state.openTheater({ series_id: '123' });
  state.videoEl.value = { currentTime: 100, playbackRate: 2, buffered: { length: 0 } };
  state.duration.value = 200;
  state.isPlaying.value = true;
  state.onTimeUpdate();
  assert.equal(calls.filter(([url]) => url.startsWith('/api/prefetch/222')).length, 0);
  state.videoEl.value.currentTime = 112;
  state.onTimeUpdate(); state.onTimeUpdate();
  assert.equal(calls.filter(([url, options]) => url === '/api/prefetch/222?next_vids=333%2C444%2C555' && options.method === 'POST').length, 1);
});

test('danmaku settings close on outside pointer interactions but remain open inside', () => {
  const listeners = {};
  const state = client(async () => response([]), {
    document: { documentElement: { classList: { add() {} } }, addEventListener(name, fn) { listeners[name] = fn; }, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} }
  });
  state.mountForTest();
  state.viewMode.value = 'theater';
  state.showDanmakuSettings.value = true;
  listeners.pointerdown({ target: { tagName: 'INPUT', type: 'range', closest: selector => selector === '.danmaku-control' ? {} : null } });
  assert.equal(state.showDanmakuSettings.value, true);
  listeners.pointerdown({ target: { tagName: 'INPUT', type: 'text', closest: () => null } });
  assert.equal(state.showDanmakuSettings.value, false);
  state.showDanmakuSettings.value = true;
  listeners.pointerdown({ target: { tagName: 'BUTTON', closest: () => null } });
  assert.equal(state.showDanmakuSettings.value, false);
});

test('currentStreamUrl includes next_vid and next_vids from upcoming episodes', async () => {
  const state = client(async () => response({}));
  state.activeEpisodes.value = [
    { vid: '101', vid_index: 1 },
    { vid: '102', vid_index: 2 },
    { vid: '103', vid_index: 3 },
    { vid: '104', vid_index: 4 }
  ];
  state.activeEpisodeIndex.value = 1;
  assert.equal(state.currentStreamUrl.value, '/api/stream/101?next_vid=102&next_vids=102%2C103%2C104');

  state.activeEpisodeIndex.value = 2;
  assert.equal(state.currentStreamUrl.value, '/api/stream/102?next_vid=103&next_vids=103%2C104');

  state.activeEpisodeIndex.value = 3;
  assert.equal(state.currentStreamUrl.value, '/api/stream/103?next_vid=104');

  state.activeEpisodeIndex.value = 4;
  assert.equal(state.currentStreamUrl.value, '/api/stream/104');
});

test('retryCurrentEpisode increments streamRefreshTick and attaches refresh=1, switchEpisode resets it', async () => {
  const state = client(async () => response({}));
  state.activeEpisodes.value = [
    { vid: '101', vid_index: 1 },
    { vid: '102', vid_index: 2 }
  ];
  state.activeEpisodeIndex.value = 1;
  assert.equal(state.currentStreamUrl.value, '/api/stream/101?next_vid=102');

  state.retryCurrentEpisode();
  assert.match(state.currentStreamUrl.value, /refresh=1/);

  state.switchEpisode(state.activeEpisodes.value[1]);
  assert.equal(state.currentStreamUrl.value, '/api/stream/102');
  assert.ok(!state.currentStreamUrl.value.includes('refresh=1'));
});

test('video error handler provides specific guidance for MediaError code 2 stream read failures', () => {
  const state = client(async () => response({}));
  state.videoEl.value = {
    error: {
      code: 2,
      message: 'MEDIA_ELEMENT_ERROR: Format error'
    }
  };
  state.onVideoError();
  assert.equal(state.videoErrorMessage.value, '视频流读取中断（网络或取流异常）；请点击“重试本集”或切换分集');
});

test('parseSeasonInfo correctly parses Chinese, Arabic numbers, suffixes and brackets', () => {
  const state = client(async () => response({}));
  const p1 = state.parseSeasonInfo('万妖图录传第一季');
  assert.equal(p1.baseTitle, '万妖图录传');
  assert.equal(p1.seasonNum, 1);
  assert.equal(p1.seasonLabel, '第1季');
  assert.equal(p1.isExplicit, true);

  const p14 = state.parseSeasonInfo('万妖图录传第十四季');
  assert.equal(p14.baseTitle, '万妖图录传');
  assert.equal(p14.seasonNum, 14);
  assert.equal(p14.seasonLabel, '第14季');

  const p2 = state.parseSeasonInfo('全球死考：刚下刑场你让我去考试二季');
  assert.equal(p2.baseTitle, '全球死考：刚下刑场你让我去考试');
  assert.equal(p2.seasonNum, 2);

  const p3 = state.parseSeasonInfo('持械入宋 第3部');
  assert.equal(p3.baseTitle, '持械入宋');
  assert.equal(p3.seasonNum, 3);

  const pPlain = state.parseSeasonInfo('万妖图录传');
  assert.equal(pPlain.baseTitle, '万妖图录传');
  assert.equal(pPlain.seasonNum, 1);
  assert.equal(pPlain.isExplicit, false);

  const pSeason = state.parseSeasonInfo('大唐荣耀 (Season 5)');
  assert.equal(pSeason.baseTitle, '大唐荣耀');
  assert.equal(pSeason.seasonNum, 5);

  const pColon = state.parseSeasonInfo('持械入宋：第四季');
  assert.equal(pColon.baseTitle, '持械入宋');
  assert.equal(pColon.seasonNum, 4);

  const pAsciiColon = state.parseSeasonInfo('持械入宋: 第四季');
  assert.equal(pAsciiColon.baseTitle, '持械入宋');
  assert.equal(pAsciiColon.seasonNum, 4);
});

test('fetchRelatedSeasons retrieves all seasons, deduplicates and sorts ascending 1 to N', async () => {
  const searchResultsPage1 = [
    { series_id: '10', series_title: '万妖图录传第十季', total: 80 },
    { series_id: '1', series_title: '万妖图录传第一季', total: 80 },
    { series_id: '14', series_title: '万妖图录传第十四季', total: 80 },
    { series_id: '2', series_title: '万妖图录传第二季', total: 80 },
    { series_id: '3', series_title: '万妖图录传第三季', total: 80 },
    { series_id: '4', series_title: '万妖图录传第四季', total: 80 },
    { series_id: '5', series_title: '万妖图录传第五季', total: 80 },
    { series_id: '6', series_title: '万妖图录传第六季', total: 80 },
    { series_id: '7', series_title: '万妖图录传第七季', total: 80 },
    { series_id: '8', series_title: '万妖图录传第八季', total: 80 }
  ];
  const searchResultsPage2 = [
    { series_id: '8', series_title: '万妖图录传第八季', total: 80 }, // Duplicate from upstream
    { series_id: '9', series_title: '万妖图录传第九季', total: 80 },
    { series_id: '11', series_title: '万妖图录传第十一季', total: 80 },
    { series_id: '12', series_title: '万妖图录传第十二季', total: 80 },
    { series_id: '13', series_title: '万妖图录传第十三季', total: 80 },
    { series_id: '999', series_title: '无关的短剧', total: 50 } // Should be filtered out
  ];

  const state = client(async (url) => {
    if (url.includes('page=1')) return response({ results: searchResultsPage1, hasMore: true });
    if (url.includes('page=2')) return response({ results: searchResultsPage2, hasMore: false });
    if (url.startsWith('/api/series/')) {
      const id = url.split('/').pop();
      return response({
        series_id: id,
        series_title: '万妖图录传第' + id + '季',
        episodes: [{ vid: id + '_1', vid_index: 1 }]
      });
    }
    return response({});
  });

  await state.openTheater({ series_id: '1', series_title: '万妖图录传第一季' });
  await state.fetchRelatedSeasons(state.activeSeries.value);

  assert.equal(state.seriesBaseTitle.value, '万妖图录传');
  assert.equal(state.relatedSeasons.value.length, 14);

  // Assert strictly ascending sorted order: Season 1 to Season 14
  for (let i = 0; i < 14; i++) {
    assert.equal(state.relatedSeasons.value[i].seasonNum, i + 1);
  }
});

test('selectSeason switches active drama in theater, closes modal and resets sidebar tab', async () => {
  let theaterOpenedWith = null;
  const state = client(async (url) => {
    if (url.startsWith('/api/series/')) {
      const id = url.split('/').pop();
      theaterOpenedWith = id;
      return response({
        series_id: id,
        series_title: '剧集第' + id + '季',
        episodes: [{ vid: id + '_1', vid_index: 1 }]
      });
    }
    return response({ results: [] });
  });

  state.activeSeries.value = { series_id: '1' };
  state.showSeasonsModal.value = true;
  state.sidebarTab.value = 'seasons';

  await state.selectSeason({ series_id: '2', series_title: '剧集第二季' });

  assert.equal(theaterOpenedWith, '2');
  assert.equal(state.showSeasonsModal.value, false);
  assert.equal(state.sidebarTab.value, 'episodes');
});

test('searchSeriesGlobally closes modal, exits theater and initiates search', async () => {
  let searchHandled = false;
  const state = client(async (url) => {
    if (url.startsWith('/api/search')) {
      searchHandled = true;
      return response({ results: [] });
    }
    return response({});
  });

  state.viewMode.value = 'theater';
  state.showSeasonsModal.value = true;
  state.seriesBaseTitle.value = '万妖图录传';

  state.searchSeriesGlobally('万妖图录传');

  assert.equal(state.showSeasonsModal.value, false);
  assert.equal(state.viewMode.value, 'catalog');
  assert.equal(state.searchKeyword.value, '万妖图录传');
  assert.equal(state.currentTab.value, 'search');
});

test('copyDramaTitle copies title to clipboard and gives feedback', async () => {
  let clipboardText = '';
  const state = client(async () => response({}), {
    navigator: {
      userAgent: '',
      clipboard: {
        writeText: async (t) => { clipboardText = t; }
      }
    }
  });

  state.activeSeries.value = { series_title: '万妖图录传第一季' };
  await state.copyDramaTitle();

  assert.equal(clipboardText, '万妖图录传第一季');
  assert.equal(state.titleCopied.value, true);
});

test('index.html and app.css include multi-season navigation and text selection styles', () => {
  const path = require('node:path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/client/index.html'), 'utf-8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../src/client/css/app.css'), 'utf-8');

  // Verify series seasons button and icon in sidebar header
  assert.ok(html.includes('sidebar-seasons-btn'), 'sidebar-seasons-btn must be present in index.html');
  assert.ok(html.includes('📚'), 'Book icon must be used');
  assert.ok(html.includes('系列全季'), 'Label must include 系列全季');

  // Verify sidebar view tabs and seasons panel
  assert.ok(html.includes('sidebar-view-tabs'), 'sidebar-view-tabs must be present');
  assert.ok(html.includes('sidebar-seasons-panel'), 'sidebar-seasons-panel must be present');

  // Verify copy title button in drama modal
  assert.ok(html.includes('modal-copy-btn'), 'modal-copy-btn must be present');
  assert.ok(html.includes('copyDramaTitle'), 'copyDramaTitle method must be bound');

  // Verify full seasons modal dialog and elegant playing tag
  assert.ok(html.includes('seasons-modal'), 'seasons-modal must be present');
  assert.ok(html.includes('showSeasonsModal'), 'showSeasonsModal state must control modal');
  assert.ok(html.includes('season-playing-tag'), 'season-playing-tag badge must be present');
  assert.ok(html.includes('playing-bars'), 'Audio equalizer playing bars must be present');

  // Verify CSS enables text selection for modals and descriptions
  assert.ok(css.includes('user-select: text'), 'app.css must allow text selection');
  assert.ok(css.includes('.drama-modal'), 'drama-modal must be styled for selectable text');
  assert.ok(css.includes('.seasons-modal'), 'seasons-modal styles must exist');
  assert.ok(css.includes('.season-playing-tag'), 'season-playing-tag styling must exist');
});

test('video resolution badge reflects loaded metadata dimensions and keyboard-hints are removed', () => {
  const path = require('node:path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/client/index.html'), 'utf-8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../src/client/css/app.css'), 'utf-8');

  // Verify keyboard-hints bar is removed
  assert.ok(!html.includes('class="keyboard-hints"'), 'keyboard-hints bar should be removed from index.html');

  // Verify resolution badge is in index.html and app.css
  assert.ok(html.includes('class="resolution-badge"'), 'resolution-badge should be present in index.html');
  assert.ok(css.includes('.resolution-badge'), '.resolution-badge styling should be in app.css');

  // Verify client resolution logic
  const state = client(async () => response({}));
  assert.equal(state.videoResolution.value.width, 0);
  assert.equal(state.resolutionText.value, '');

  state.videoEl.value = { videoWidth: 1080, videoHeight: 1920, duration: 100, volume: 1, pause() {} };
  state.onLoadedMetadata();
  assert.equal(state.videoResolution.value.width, 1080);
  assert.equal(state.videoResolution.value.height, 1920);
  assert.equal(state.resolutionText.value, '1080p');
  assert.ok(state.resolutionTitle.value.includes('1080 × 1920 (1080p)'));

  // Test horizontal 720p
  state.videoEl.value = { videoWidth: 1280, videoHeight: 720, pause() {} };
  state.onCanPlay();
  assert.equal(state.resolutionText.value, '720p');

  // Test 4K
  state.videoEl.value = { videoWidth: 3840, videoHeight: 2160, pause() {} };
  state.onCanPlay();
  assert.equal(state.resolutionText.value, '4K');

  // Test leaving theater resets resolution
  state.closeTheater();
  assert.equal(state.videoResolution.value.width, 0);
  assert.equal(state.resolutionText.value, '');
});

test('client detects unsupported HEVC pre-flight and appends hevc=0 to stream and prefetch URLs', async () => {
  const requests = [];
  const state = client(async url => {
    requests.push(url);
    return response({});
  }, {
    document: {
      documentElement: { classList: { add() {} } },
      createElement: tag => tag === 'video' ? { canPlayType: () => '' } : {}
    }
  });
  assert.equal(state.hevcSupported.value, false);
  state.activeEpisodes.value = [
    { vid: '101', vid_index: 1 },
    { vid: '102', vid_index: 2 },
    { vid: '103', vid_index: 3 }
  ];
  state.activeEpisodeIndex.value = 1;
  assert.match(state.currentStreamUrl.value, /[?&]hevc=0(?:&|$)/);

  state.isPlaying.value = true;
  state.duration.value = 60;
  state.videoEl.value = { currentTime: 40, playbackRate: 1, buffered: { length: 0 } };
  state.onTimeUpdate();
  assert.ok(requests.some(u => u.includes('/api/prefetch/102') && u.includes('hevc=0')));
});

test('client falls back to hevc=0 when runtime onCanPlay reports 0x0 video dimensions', () => {
  const state = client(async () => response({}), {
    document: {
      documentElement: { classList: { add() {} } },
      createElement: tag => tag === 'video' ? { canPlayType: () => 'probably' } : {}
    }
  });
  assert.equal(state.hevcSupported.value, true);
  state.activeEpisodes.value = [{ vid: '7705413806972734488', vid_index: 3 }];
  state.activeEpisodeIndex.value = 3;
  assert.doesNotMatch(state.currentStreamUrl.value, /hevc=0/);

  let playCalls = 0;
  state.videoEl.value = {
    videoWidth: 0,
    videoHeight: 0,
    duration: 82.45,
    currentTime: 1.5,
    play: async () => { playCalls++; },
    pause() {}
  };
  state.onCanPlay();
  assert.equal(state.hevcSupported.value, false);
  assert.match(state.currentStreamUrl.value, /hevc=0/);
  assert.equal(playCalls, 1);

  // Calling onCanPlay again with 0x0 after fallback must not loop or re-trigger play
  state.onCanPlay();
  assert.equal(playCalls, 1);
});
