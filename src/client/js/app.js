// SPDX-License-Identifier: GPL-3.0-only
const { createApp, ref, computed, onMounted, onUnmounted, nextTick, watch } = Vue;

// 自动识别 macOS / Windows / Linux 宿主平台并注入 root class
const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.userAgentData && navigator.userAgentData.platform === 'macOS');
const isDesktop = /Electron\//.test(navigator.userAgent);
document.documentElement.classList.add(isDesktop ? (isMac ? 'platform-mac' : /Windows/i.test(navigator.userAgent) ? 'platform-win' : 'platform-linux') : 'platform-browser');

createApp({
  setup() {
    // 视图模式与导航状态
    const viewMode = ref('catalog'); // 'catalog' | 'theater'
    const currentTab = ref('hot-drama'); // 'hot-drama' | 'real-drama' | 'comic-drama' | 'ai-drama' | 'history' | 'favorites' | 'search'
    const searchKeyword = ref('');
    const searchHistory = ref([]);
    const showSearchHistory = ref(false);
    let searchHistoryRevision = 0;
    let searchHistoryQueue = Promise.resolve();
    const hotTags = ref(['离婚', '战神', '重生', '逆袭', '神医', '千金', '豪门', '甜宠']);

    // 目录与短剧列表
    const currentDramas = ref([]);
    const currentPage = ref(1);
    const loadingCatalog = ref(false);
    const catalogError = ref(null);
    const hasMore = ref(false);
    let catalogRequest = 0;
    let submittedKeyword = '';

    // 剧星榜（演员排行榜）状态
    const actors = ref([]);
    const actorPage = ref(1);
    const actorGender = ref('all'); // 'all' | 'male' | 'female'
    const actorHasMore = ref(false);
    const actorRankDate = ref('');
    const loadingActors = ref(false);
    const activeActor = ref(null);
    const activeActorDetail = ref(null);
    const actorWorks = ref([]);
    const actorWorksOffset = ref(0);
    const actorWorksTotal = ref(0);
    const actorWorksHasMore = ref(false);
    const loadingActorWorks = ref(false);
    const loadingMoreWorks = ref(false);
    const actorWorksError = ref('');
    let currentActorRequestId = 0;
    let actorRankingRequestId = 0;

    // 剧场模式与播放器
    const videoEl = ref(null);
    const activeSeries = ref(null);
    const activeEpisodes = ref([]);
    const activeEpisodeIndex = ref(1);
    const isFavorited = ref(false);
    const isPlaying = ref(false);
    const isBuffering = ref(false);
    const videoErrorMessage = ref('');
    const currentTime = ref(0);
    const duration = ref(0);
    const bufferedPercent = ref(0);
    const playbackRate = ref('1.0');
    const showSpeedMenu = ref(false);
    function selectSpeed(rate) {
      playbackRate.value = rate;
      savePreferences({ playbackRate: rate });
      showSpeedMenu.value = false;
      changeSpeed();
    }
    const volume = ref(1.0);
    const isMuted = ref(false);
    const videoResolution = ref({ width: 0, height: 0 });

    const resolutionText = computed(() => {
      const w = videoResolution.value.width;
      const h = videoResolution.value.height;
      if (!w || !h) return '';
      const minDim = Math.min(w, h);
      if (minDim >= 2160) return '4K';
      if (minDim >= 1440) return '2K';
      if (minDim >= 1080) return '1080p';
      if (minDim >= 720) return '720p';
      if (minDim >= 540) return '540p';
      if (minDim >= 480) return '480p';
      if (minDim >= 360) return '360p';
      return `${minDim}p`;
    });

    const resolutionTitle = computed(() => {
      const w = videoResolution.value.width;
      const h = videoResolution.value.height;
      if (!w || !h) return '分辨率加载中';
      return `当前视频分辨率：${w} × ${h} (${resolutionText.value})`;
    });
    const watchedMap = ref(new Map()); // seriesId -> Set(epIndexes)
    let progressTimer = null;
    let pendingResumeSec = 0;
    let progressReady = false;
    let lastNearEndPrefetch = 0;
    let theaterRequest = 0;
    let catalogScrollTop = 0;
    let fullscreenExitAt = 0;
    const toastText = ref('');
    const osdMessage = ref('');
    let toastTimer, osdTimer;
    const sidebarOpen = ref(true);
    const isScrubbing = ref(false);
    const isFullscreen = ref(false);
    const isControlsHidden = ref(false);
    let controlsHideTimer = null;
    const previewTime = ref(0);
    const previewPercent = ref(0);
    const showPreview = ref(false);
    const showDramaDetailModal = ref(false);
    const relatedSeasons = ref([]);
    const isCheckingSeasons = ref(false);
    const seriesBaseTitle = ref('');
    const showSeasonsModal = ref(false);
    const sidebarTab = ref('episodes'); // 'episodes' | 'seasons'
    const titleCopied = ref(false);
    let titleCopiedTimer = null;
    const seasonsCache = new Map();
    let currentSeasonsRequest = 0;
    const showAppMenu = ref(false);
    const danmakuEnabled = ref(true);
    const showDanmakuSettings = ref(false);
    const danmakuLayer = ref(null);
    let danmakuEngine = null;
    let danmakuResizeObserver = null;
    function stopDanmakuAnimation() {
      danmakuResizeObserver?.disconnect();
      danmakuResizeObserver = null;
      danmakuEngine?.destroy();
      danmakuEngine = null;
    }

    // 根据文本长度和点赞标识预估弹幕的物理渲染像素宽度
    function estimateDanmakuWidth(text, likes = 0) {
      let width = 12; // 基础边距
      const str = String(text || '');
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        // ASCII 半角字符约 10px，全角/中文约 20px (对应 font-size: 20px)
        width += (code >= 0x20 && code <= 0x7e) ? 10 : 20;
      }
      if (likes > 0) {
        const likeStr = '+' + likes;
        width += 6 + likeStr.length * 8;
      }
      return width;
    }

    // 计算两相邻弹幕在同一轨道上不发生碰撞（间距 >= 8px）所需的最小时间差（秒）
    function calculateRequiredGap(wPrev, wNext, screenWidth, duration) {
      const gapPrev = duration * (wPrev + 8) / (screenWidth + wPrev);
      const gapNext = duration * (wNext + 8) / (screenWidth + wNext);
      return Math.max(gapPrev, gapNext);
    }

    // 基于真实物理时空长度与多轨道连续调度的弹幕“高赞优先”优选算法
    function prioritizeDanmakuItems(items, options = {}) {
      if (!Array.isArray(items) || !items.length) return [];
      const likesPriority = options.likesPriority !== false;
      if (!likesPriority) return [...items];

      const rows = Math.max(1, Number(options.rows) || 3);
      const screenWidth = Math.max(320, Number(options.screenWidth) || 800);
      const speedOption = options.speed || 'medium';
      const speedFactor = { fast: 12, medium: 16, slow: 20 }[speedOption] || 16;
      const duration = speedFactor;

      // 提取并预估每条弹幕的物理属性
      const candidates = items.map((item, index) => {
        const likes = Number.isSafeInteger(item.likes) && item.likes > 0 ? item.likes : 0;
        const time = Number(item.time) || 0;
        const width = estimateDanmakuWidth(item.text, likes);
        return {
          raw: item,
          time,
          likes,
          width,
          index
        };
      });

      // 严格按时间先后排序；同时间点按点赞数降序优先
      candidates.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        if (b.likes !== a.likes) return b.likes - a.likes;
        return a.index - b.index;
      });

      // 初始化每一条轨道的排期列表
      const tracks = Array.from({ length: rows }, () => ({ items: [] }));

      for (const c of candidates) {
        let freeTrackIndex = -1;
        let minGapToLast = Infinity;

        // 1. 查找是否存在无需发生阻挡冲突即可容纳 c 的空闲轨道
        for (let k = 0; k < rows; k++) {
          const trackItems = tracks[k].items;
          if (trackItems.length === 0) {
            freeTrackIndex = k;
            break;
          }
          const prev = trackItems[trackItems.length - 1];
          const reqGap = calculateRequiredGap(prev.width, c.width, screenWidth, duration);
          if (c.time >= prev.time + reqGap) {
            const gap = c.time - (prev.time + reqGap);
            if (gap < minGapToLast) {
              minGapToLast = gap;
              freeTrackIndex = k;
            }
          }
        }

        if (freeTrackIndex !== -1) {
          tracks[freeTrackIndex].items.push(c);
          continue;
        }

        // 2. 所有轨道均处于阻挡期（发生同屏碰撞冲突！）
        // 若当前弹幕拥有更高的点赞数，则淘汰正在阻挡它的低赞/0赞弹幕
        if (c.likes > 0) {
          let bestReplaceTrack = -1;
          let minIncumbentLikes = c.likes; // 必须严格低于 c 的点赞数
          let maxRemainingBlock = -Infinity;

          for (let k = 0; k < rows; k++) {
            const trackItems = tracks[k].items;
            const incumbent = trackItems[trackItems.length - 1];
            if (incumbent.likes >= c.likes) continue; // 现有弹幕点赞数不低于 c，不能替代

            // 检查剔除现有弹幕后，c 与该轨道倒数第二条弹幕是否无冲突
            let canReplace = true;
            if (trackItems.length >= 2) {
              const prevBefore = trackItems[trackItems.length - 2];
              const reqGapWithPrev = calculateRequiredGap(prevBefore.width, c.width, screenWidth, duration);
              if (c.time < prevBefore.time + reqGapWithPrev) {
                canReplace = false;
              }
            }

            if (canReplace) {
              const reqGap = calculateRequiredGap(incumbent.width, c.width, screenWidth, duration);
              const remainingBlock = (incumbent.time + reqGap) - c.time;

              // 优选原则：优先淘汰点赞最低的；若同为 0 赞，淘汰阻挡时间最长的
              if (incumbent.likes < minIncumbentLikes ||
                  (incumbent.likes === minIncumbentLikes && remainingBlock > maxRemainingBlock)) {
                minIncumbentLikes = incumbent.likes;
                maxRemainingBlock = remainingBlock;
                bestReplaceTrack = k;
              }
            }
          }

          if (bestReplaceTrack !== -1) {
            // 舍弃并替换该轨道上的低赞/0赞弹幕，让高赞弹幕上屏
            tracks[bestReplaceTrack].items.pop();
            tracks[bestReplaceTrack].items.push(c);
          }
        }
      }

      // 收集所有成功上轨的弹幕并恢复严格的时间戳顺序
      const result = [];
      for (let k = 0; k < rows; k++) {
        for (const entry of tracks[k].items) {
          result.push(entry.raw);
        }
      }

      result.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
      return result;
    }

    function startDanmakuAnimation() {
      if (!danmakuEnabled.value || !videoEl.value || !danmakuLayer.value || typeof Danmaku === 'undefined') return;
      if (danmakuEngine) {
        if (videoEl.value && !videoEl.value.paused) {
          danmakuEngine.play?.();
        }
        return;
      }
      const layer = danmakuLayer.value;
      const prioritized = prioritizeDanmakuItems(danmakuItems.value, {
        rows: danmakuRows.value,
        speed: danmakuSpeed.value,
        screenWidth: layer.offsetWidth || 800,
        likesPriority: danmakuLikesPriority.value
      });
      const comments = prioritized.map(item => ({
        time: item.time,
        likes: Number(item.likes) || 0,
        render() {
          const text = document.createElement('span');
          text.className = 'danmaku-item';
          text.style.color = danmakuColor(item);
          text.textContent = item.text;
          if (item.likes > 0) {
            const likes = document.createElement('sup');
            likes.className = 'danmaku-likes';
            likes.textContent = '+' + item.likes;
            text.appendChild(likes);
          }
          return text;
        }
      }));
      danmakuEngine = new Danmaku({ container: layer, media: videoEl.value, comments, speed: danmakuSpeedForWidth(layer.offsetWidth) });
      if (videoEl.value && !videoEl.value.paused) {
        danmakuEngine.seek?.();
        danmakuEngine.play?.();
      }
      const resize = () => {
        if (!danmakuEngine || !layer.offsetWidth || !layer.offsetHeight) return;
        danmakuEngine.speed = danmakuSpeedForWidth(layer.offsetWidth);
        danmakuEngine.resize();
      };
      if (typeof ResizeObserver !== 'undefined') {
        danmakuResizeObserver = new ResizeObserver(resize);
        danmakuResizeObserver.observe(layer);
      }
    }
    function refreshDanmakuEngine() {
      stopDanmakuAnimation();
      nextTick(startDanmakuAnimation);
    }
    const changedPreferences = new Set();
    let preferencesQueue = Promise.resolve();
    function savePreferences(values) {
      Object.keys(values).forEach(key => changedPreferences.add(key));
      preferencesQueue = preferencesQueue.then(async () => {
        const response = await fetch('/api/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
        if (!response.ok) throw new Error('保存失败');
      }).catch(() => notify('播放器设置保存失败'));
    }
    async function loadPreferences() {
      try {
        const response = await fetch('/api/preferences');
        if (!response.ok) throw new Error('读取失败');
        const prefs = await response.json();
        const refs = { danmakuEnabled, danmakuRows, danmakuOpacity, danmakuSpeed, danmakuLikesPriority, volume, isMuted, playbackRate, fitMode };
        for (const [key, value] of Object.entries(prefs)) {
          if (refs[key] && !changedPreferences.has(key)) refs[key].value = value;
        }
        if (!danmakuEnabled.value) stopDanmakuAnimation();
        if (videoEl.value) {
          videoEl.value.volume = Number(volume.value);
          videoEl.value.muted = isMuted.value;
          videoEl.value.playbackRate = Number(playbackRate.value);
        }
      } catch (_) { /* Keep defaults when stored preferences cannot be read. */ }
    }
    const danmakuSpeed = ref('medium');
    function danmakuSpeedForWidth(width) {
      return Math.max(1, width / ({ fast: 12, medium: 16, slow: 20 }[danmakuSpeed.value] || 16));
    }
    watch(danmakuSpeed, () => {
      if (danmakuEngine && danmakuLayer.value?.offsetWidth) danmakuEngine.speed = danmakuSpeedForWidth(danmakuLayer.value.offsetWidth);
    });
    const danmakuRows = ref(3);
    const danmakuLikesPriority = ref(true);
    function toggleLikesPriority() {
      danmakuLikesPriority.value = !danmakuLikesPriority.value;
      savePreferences({ danmakuLikesPriority: danmakuLikesPriority.value });
      refreshDanmakuEngine();
    }
    const danmakuOpacity = ref(0.8);
    const danmakuItems = ref([]);
    const danmakuStatus = ref('');
    let danmakuKey = '';
    let danmakuRequest = 0;
    async function loadDanmaku(force = false) {
      const vid = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value)?.vid;
      const seriesId = activeSeries.value?.series_id;
      const key = `${seriesId}:${vid}`;
      if (!danmakuEnabled.value || !vid || !seriesId || (!force && key === danmakuKey)) return;
      danmakuKey = key;
      const request = ++danmakuRequest;
      danmakuItems.value = [];
      refreshDanmakuEngine();
      danmakuStatus.value = '弹幕加载中';
      try {
        const response = await fetch(`/api/danmaku/${encodeURIComponent(seriesId)}/${encodeURIComponent(vid)}${force ? '?fresh=1' : ''}`);
        if (!response.ok) throw new Error('请求失败');
        const data = await response.json();
        if (request !== danmakuRequest) return;
        danmakuItems.value = Array.isArray(data.items) ? data.items : [];
        refreshDanmakuEngine();
        danmakuStatus.value = data.notice || (data.success ? `弹幕 ${danmakuItems.value.length} 条` : '弹幕加载失败');
      } catch (_) {
        if (request === danmakuRequest) danmakuStatus.value = '弹幕加载失败';
      }
    }
    function toggleDanmaku() {
      danmakuEnabled.value = !danmakuEnabled.value;
      savePreferences({ danmakuEnabled: danmakuEnabled.value });
      if (danmakuEnabled.value) { loadDanmaku(true); nextTick(startDanmakuAnimation); }
      else { stopDanmakuAnimation(); danmakuRequest++; danmakuKey = ''; danmakuItems.value = []; }
    }
    // 全剧统一点赞数档位，500 赞及以上使用最高热度颜色。
    function danmakuColor(item) {
      const likes = Number.isSafeInteger(item.likes) && item.likes > 0 ? item.likes : 0;
      if (likes >= 500) return '#ff7777';
      if (likes >= 100) return '#ffad72';
      if (likes >= 20) return '#ffd87a';
      if (likes >= 1) return '#a8dcff';
      return '#ffffff';
    }
    watch([danmakuLayer, videoEl, danmakuRows, danmakuSpeed, danmakuLikesPriority], refreshDanmakuEngine, { flush: 'post' });
    const showAboutModal = ref(false);
    const appVersion = ref('');
    const showShortcutsModal = ref(false);

    function toggleAppMenu() {
      showAppMenu.value = !showAppMenu.value;
    }

    function closeAppMenu() {
      showAppMenu.value = false;
    }

    function openAboutModal() {
      showAppMenu.value = false;
      showAboutModal.value = true;
      fetch('/api/system/version').then(res => {
        if (!res.ok) throw new Error('version unavailable');
        return res.json();
      }).then(data => { appVersion.value = typeof data.version === 'string' ? data.version : ''; }).catch(() => { appVersion.value = ''; });
    }

    function closeAboutModal() {
      showAboutModal.value = false;
    }

    function openShortcutsModal() {
      showAppMenu.value = false;
      showShortcutsModal.value = true;
    }

    function closeShortcutsModal() {
      showShortcutsModal.value = false;
    }

    async function openLogDir() {
      showAppMenu.value = false;
      try {
        const response = await fetch('/api/system/open-log-dir', { method: 'POST' });
        const res = await response.json();
        if (res?.success) {
          notify('已打开系统日志目录');
        } else {
          notify(res?.error || '未能打开日志目录');
        }
      } catch (e) {
        notify('打开日志目录失败');
      }
    }

    async function openLogFile() {
      showAppMenu.value = false;
      try {
        const response = await fetch('/api/system/open-log-file', { method: 'POST' });
        const res = await response.json();
        if (res?.success) {
          notify('已打开当前运行日志');
        } else {
          notify(res?.error || '未能打开运行日志');
        }
      } catch (e) {
        notify('打开运行日志失败');
      }
    }

    function openGithubRepo() {
      showAppMenu.value = false;
      window.open('https://github.com/zfdang/hongguo-open-player', '_blank');
    }

    function setControlsHidden(hidden) {
      isControlsHidden.value = hidden;
      if (typeof document !== 'undefined' && document.body?.classList) {
        document.body.classList.toggle('hide-cursor', Boolean(hidden && isFullscreen.value));
      }
    }

    function handleWindowMouseMove() {
      if (isFullscreen.value && isControlsHidden.value) {
        resetControlsTimer();
      }
    }

    function clearControlsTimer() {
      clearTimeout(controlsHideTimer);
    }

    function resetControlsTimer() {
      if (isControlsHidden.value) {
        setControlsHidden(false);
      }
      clearTimeout(controlsHideTimer);
      if (isFullscreen.value && isPlaying.value && !isScrubbing.value) {
        controlsHideTimer = setTimeout(() => {
          if (isFullscreen.value && isPlaying.value && !isScrubbing.value) {
            setControlsHidden(true);
          }
        }, 2500);
      }
    }
    function previewSeek(event) {
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
      previewPercent.value = fraction * 100;
      previewTime.value = fraction * duration.value;
      showPreview.value = true;
    }
    function seekFromSlider(event) {
      if (!videoEl.value || !Number.isFinite(duration.value) || duration.value <= 0) return;
      const target = Math.max(0, Math.min(duration.value, Number(event.target.value)));
      videoEl.value.currentTime = target;
      currentTime.value = target;
      danmakuEngine?.seek?.();
    }
    function startScrubbing(event) {
      isScrubbing.value = true;
      setControlsHidden(false);
      clearTimeout(controlsHideTimer);
      event.target.setPointerCapture?.(event.pointerId);
    }
    function finishScrubbing(event) {
      isScrubbing.value = false;
      showPreview.value = false;
      saveProgressNow();
      event?.target?.blur?.();
      keepPlayerFocus();
      danmakuEngine?.seek?.();
      resetControlsTimer();
    }
    function notify(message) {
      toastText.value = message;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastText.value = ''; }, 4000);
    }
    function showOSD(message) {
      osdMessage.value = message;
      clearTimeout(osdTimer);
      osdTimer = setTimeout(() => { osdMessage.value = ''; }, 1000);
    }
    function fullscreenChanged() {
      const active = Boolean(typeof document !== 'undefined' && document.fullscreenElement);
      isFullscreen.value = active;
      if (!active) {
        fullscreenExitAt = Date.now();
        setControlsHidden(false);
        clearTimeout(controlsHideTimer);
      } else {
        resetControlsTimer();
      }
    }
    function reportClientLog(level, message, extra) {
      try {
        fetch('/api/client-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level, tag: 'ClientPlayer', message, extra })
        }).catch(() => {});
      } catch (_) {}
    }

    // 当前选集分组
    const currentGroup = ref({ start: 1, end: 30 });
    const streamRefreshTick = ref(0);
    let bytevc2Session = null;
    let bytevc2Fallback = null;
    let bytevc2FallbackActive = false;

    // 当前播放直链 (通过本地边下边解代理)
    const currentStreamUrl = computed(() => {
      const ep = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value);
      if (!ep || !ep.vid) return '';
      // 计算后续分集便于服务端批量拉取与无感预加载
      const nextEp1 = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value + 1);
      const nextEp2 = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value + 2);
      const nextEp3 = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value + 3);
      const nextList = [nextEp1?.vid, nextEp2?.vid, nextEp3?.vid].filter(Boolean);
      const params = [];
      if (window.Bytevc2Stream?.supported()) params.push('mse=1');
      if (nextEp1?.vid) params.push(`next_vid=${encodeURIComponent(nextEp1.vid)}`);
      if (nextList.length > 1) params.push(`next_vids=${encodeURIComponent(nextList.join(','))}`);
      if (streamRefreshTick.value > 0) params.push(`refresh=${streamRefreshTick.value}`);
      return `/api/stream/${ep.vid}${params.length ? '?' + params.join('&') : ''}`;
    });

    const playedPercent = computed(() => {
      if (!duration.value || duration.value <= 0) return 0;
      return Math.min(100, (currentTime.value / duration.value) * 100);
    });

    // 分集按 30 集一组分组
    const episodeGroups = computed(() => {
      const total = activeEpisodes.value.length;
      if (total === 0) return [];
      const groups = [];
      const size = 30;
      for (let i = 1; i <= total; i += size) {
        groups.push({
          start: i,
          end: Math.min(i + size - 1, total)
        });
      }
      return groups;
    });

    // 当前分组下的集数列表
    const currentGroupEpisodes = computed(() => {
      const { start, end } = currentGroup.value;
      return activeEpisodes.value.filter(e => e.vid_index >= start && e.vid_index <= end);
    });

    // ================= 目录与数据获取 =================

    async function loadCatalog() {
      const request = ++catalogRequest;
      loadingCatalog.value = true;
      catalogError.value = null;
      try {
        const tab = currentTab.value;
        let url;
        if (submittedKeyword) {
          url = `/api/search?keyword=${encodeURIComponent(submittedKeyword)}&page=${currentPage.value}`;
        } else if (tab === 'history' || tab === 'favorites') {
          url = `/api/${tab}`;
        } else {
          url = `/api/catalog?category=${tab}&page=${currentPage.value}`;
        }
        const response = await fetch(url);
        if (!response.ok) throw new Error(`加载失败 (${response.status})`);
        const data = await response.json();
        if (request !== catalogRequest) return;
        if (Array.isArray(data)) {
          currentDramas.value = data.map(item => ({ ...item, watched_index: item.episode_index }));
          hasMore.value = false;
        } else {
          if (data.error || data.success === false) throw new Error(data.error || '加载失败');
          currentDramas.value = data.results || [];
          hasMore.value = !!data.hasMore;
        }
      } catch (err) {
        if (request !== catalogRequest) return;
        console.error('加载短剧列表失败:', err);
        catalogError.value = err.message || '加载短剧列表失败，请重试';
        currentDramas.value = [];
        hasMore.value = false;
      } finally {
        if (request === catalogRequest) loadingCatalog.value = false;
      }
    }

    function loadSearchHistory() {
      const revision = searchHistoryRevision;
      searchHistoryQueue = searchHistoryQueue.then(async () => {
        const response = await fetch('/api/search-history');
        if (!response.ok) throw new Error('搜索历史读取失败');
        const data = await response.json();
        if (revision === searchHistoryRevision && Array.isArray(data)) searchHistory.value = data;
      }).catch(() => {});
    }

    function updateSearchHistory(action, keyword = '') {
      if (action !== 'clear' && (!keyword || keyword.length > 200)) return;
      const revision = ++searchHistoryRevision;
      const rest = searchHistory.value.filter(item => item !== keyword);
      searchHistory.value = action === 'clear' ? [] : action === 'add' ? [keyword, ...rest].slice(0, 10) : rest;
      searchHistoryQueue = searchHistoryQueue.then(async () => {
        const response = await fetch('/api/search-history', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, keyword })
        });
        if (!response.ok) throw new Error('搜索历史保存失败');
        const data = await response.json();
        if (revision === searchHistoryRevision && Array.isArray(data)) searchHistory.value = data;
      }).catch(() => { notify('搜索历史保存失败'); });
    }

    function selectSearchHistory(keyword) {
      searchKeyword.value = keyword;
      handleSearch();
    }

    function onSearchFocusOut(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) showSearchHistory.value = false;
    }

    async function handleSearch() {
      if (!searchKeyword.value.trim()) return;
      submittedKeyword = searchKeyword.value.trim();
      showSearchHistory.value = false;
      updateSearchHistory('add', submittedKeyword);
      currentTab.value = 'search';
      currentPage.value = 1;
      catalogError.value = null;
      leaveTheater();
      return loadCatalog();
    }

    function quickSearch(tag) {
      searchKeyword.value = tag;
      handleSearch();
    }

    function switchTab(tab) {
      currentTab.value = tab;
      catalogError.value = null;
      leaveTheater();
      closeActorDetail();
      searchKeyword.value = '';
      submittedKeyword = '';
      if (tab === 'actors') {
        actorPage.value = 1;
        loadActorRankings();
      } else {
        // 切出剧星榜时立即使进行中的榜单请求失效，避免晚到数据污染
        actorRankingRequestId++;
        loadingActors.value = false;
        currentPage.value = 1;
        loadCatalog();
      }
    }

    function changePage(delta) {
      currentPage.value = Math.max(1, currentPage.value + delta);
      loadCatalog();
    }

    function goHome() {
      switchTab('hot-drama');
    }

    // ================= 剧星榜（演员排行榜）逻辑 =================

    async function loadActorRankings() {
      const requestId = ++actorRankingRequestId;
      const targetPage = actorPage.value;
      const targetGender = actorGender.value;
      loadingActors.value = true;
      try {
        const query = targetGender && targetGender !== 'all'
          ? `/api/actors/ranking?page=${targetPage}&limit=20&gender=${targetGender}`
          : `/api/actors/ranking?page=${targetPage}`;
        const response = await fetch(query);
        const data = await response.json();

        // 校验请求新鲜度：若已被新请求取代、已切出剧星榜、当前展示页码或筛选性别已变更，丢弃旧响应
        if (requestId !== actorRankingRequestId || currentTab.value !== 'actors' || actorPage.value !== targetPage || actorGender.value !== targetGender) {
          return;
        }

        if (!response.ok || !data.success || !Array.isArray(data.actors)) {
          throw new Error(data.error || `加载剧星榜失败 (${response.status})`);
        }
        actors.value = data.actors;
        actorRankDate.value = data.rank_date || '';
        actorHasMore.value = !!data.has_more;
      } catch (err) {
        if (requestId !== actorRankingRequestId || currentTab.value !== 'actors' || actorPage.value !== targetPage || actorGender.value !== targetGender) {
          return;
        }
        console.error('加载剧星榜失败:', err);
        notify(err.message || '剧星榜加载失败，请重试');
        if (actorPage.value > 1) {
          // 若跨页或会话失效失败，安全返回第 1 页并刷新
          actorPage.value = 1;
          await loadActorRankings();
          return;
        }
        actors.value = [];
        actorHasMore.value = false;
      } finally {
        if (requestId === actorRankingRequestId) {
          loadingActors.value = false;
        }
      }
    }

    function switchActorGender(gender) {
      if (actorGender.value === gender) return;
      actorGender.value = gender;
      actorPage.value = 1;
      loadActorRankings();
    }

    function changeActorPage(delta) {
      actorPage.value = Math.max(1, actorPage.value + delta);
      loadActorRankings();
      window.scrollTo?.({ top: 0, behavior: 'smooth' });
    }

    let lastFocusedBeforeActorModal = null;

    async function openActorDetail(actor) {
      if (!actor || !actor.actor_id) return;
      lastFocusedBeforeActorModal = typeof document !== 'undefined' ? document.activeElement : null;
      const requestId = ++currentActorRequestId;
      const targetActorId = String(actor.actor_id);

      activeActor.value = actor;
      activeActorDetail.value = null;
      actorWorks.value = [];
      actorWorksOffset.value = 0;
      actorWorksTotal.value = 0;
      actorWorksHasMore.value = false;
      loadingActorWorks.value = true;
      loadingMoreWorks.value = false;
      actorWorksError.value = '';
      reportClientLog('INFO', `打开演员主页: ${actor.name} (actorId=${targetActorId})`);

      nextTick(() => {
        if (typeof document?.querySelector === 'function') {
          const modal = document.querySelector('.actor-modal');
          const closeBtn = document.querySelector('.modal-close-btn');
          (closeBtn || modal)?.focus?.();
        }
      });

      try {
        const [detailRes, worksRes] = await Promise.allSettled([
          fetch(`/api/actors/${encodeURIComponent(targetActorId)}`).then(async r => {
            const json = await r.json();
            if (!r.ok || !json.success) throw new Error(json.error || `获取演员详情失败 (${r.status})`);
            return json;
          }),
          fetch(`/api/actors/${encodeURIComponent(targetActorId)}/works?count=20&offset=0`).then(async r => {
            const json = await r.json();
            if (!r.ok || !json.success) throw new Error(json.error || `获取演员作品失败 (${r.status})`);
            return json;
          })
        ]);

        // 校验请求是否仍有效且仍属于当前打开的演员
        if (requestId !== currentActorRequestId || !activeActor.value || String(activeActor.value.actor_id) !== targetActorId) {
          return;
        }

        if (detailRes.status === 'fulfilled' && detailRes.value?.success) {
          activeActorDetail.value = detailRes.value.actor;
          if (detailRes.value.actor?.avatar && activeActor.value) {
            activeActor.value.avatar = detailRes.value.actor.avatar;
          }
        }

        if (worksRes.status === 'fulfilled' && worksRes.value?.success) {
          const worksData = worksRes.value;
          actorWorks.value = worksData.works || [];
          actorWorksTotal.value = Number(worksData.total_count) || actorWorks.value.length;
          actorWorksOffset.value = actorWorks.value.length;
          actorWorksHasMore.value = !!worksData.has_more && actorWorks.value.length < actorWorksTotal.value;
          actorWorksError.value = '';
        } else {
          const errReason = worksRes.status === 'rejected' ? worksRes.reason?.message : (worksRes.value?.error || '作品列表加载失败');
          actorWorksError.value = errReason || '获取演员作品失败';
          actorWorks.value = [];
          actorWorksHasMore.value = false;
        }
      } catch (err) {
        if (requestId === currentActorRequestId) {
          console.error('获取演员详情失败:', err);
          actorWorksError.value = err.message || '获取演员数据失败';
        }
      } finally {
        if (requestId === currentActorRequestId) {
          loadingActorWorks.value = false;
        }
      }
    }

    async function loadMoreActorWorks() {
      if (!activeActor.value || loadingMoreWorks.value || !actorWorksHasMore.value) return;
      const requestId = currentActorRequestId;
      const targetActorId = String(activeActor.value.actor_id);
      const currentOffset = actorWorks.value.length;
      loadingMoreWorks.value = true;
      actorWorksError.value = '';

      try {
        const response = await fetch(`/api/actors/${encodeURIComponent(targetActorId)}/works?count=20&offset=${currentOffset}`);
        const data = await response.json();
        if (requestId !== currentActorRequestId || !activeActor.value || String(activeActor.value.actor_id) !== targetActorId) {
          return;
        }
        if (response.ok && data.success && Array.isArray(data.works)) {
          const existingIds = new Set(actorWorks.value.map(w => w.series_id));
          const newWorks = data.works.filter(w => !existingIds.has(w.series_id));
          actorWorks.value = [...actorWorks.value, ...newWorks];
          actorWorksTotal.value = Number(data.total_count) || actorWorks.value.length;
          actorWorksOffset.value = actorWorks.value.length;
          actorWorksHasMore.value = !!data.has_more && actorWorks.value.length < actorWorksTotal.value;
        } else {
          throw new Error(data.error || '加载更多作品失败');
        }
      } catch (err) {
        if (requestId === currentActorRequestId) {
          console.error('加载更多作品失败:', err);
          notify(err.message || '加载更多作品失败，请重试');
        }
      } finally {
        if (requestId === currentActorRequestId) {
          loadingMoreWorks.value = false;
        }
      }
    }

    async function retryLoadActorWorks() {
      if (!activeActor.value) return;
      const requestId = ++currentActorRequestId;
      const targetActorId = String(activeActor.value.actor_id);
      loadingActorWorks.value = true;
      actorWorksError.value = '';

      try {
        const response = await fetch(`/api/actors/${encodeURIComponent(targetActorId)}/works?count=20&offset=0`);
        const data = await response.json();
        if (requestId !== currentActorRequestId || !activeActor.value || String(activeActor.value.actor_id) !== targetActorId) {
          return;
        }
        if (response.ok && data.success && Array.isArray(data.works)) {
          actorWorks.value = data.works;
          actorWorksTotal.value = Number(data.total_count) || actorWorks.value.length;
          actorWorksOffset.value = actorWorks.value.length;
          actorWorksHasMore.value = !!data.has_more && actorWorks.value.length < actorWorksTotal.value;
          actorWorksError.value = '';
        } else {
          throw new Error(data.error || '获取演员作品失败');
        }
      } catch (err) {
        if (requestId === currentActorRequestId) {
          actorWorksError.value = err.message || '获取演员作品失败，请重试';
        }
      } finally {
        if (requestId === currentActorRequestId) {
          loadingActorWorks.value = false;
        }
      }
    }

    function closeActorDetail() {
      currentActorRequestId++;
      activeActor.value = null;
      activeActorDetail.value = null;
      actorWorks.value = [];
      actorWorksOffset.value = 0;
      actorWorksTotal.value = 0;
      actorWorksHasMore.value = false;
      actorWorksError.value = '';
      loadingActorWorks.value = false;
      loadingMoreWorks.value = false;
      if (lastFocusedBeforeActorModal && typeof lastFocusedBeforeActorModal.focus === 'function') {
        try { lastFocusedBeforeActorModal.focus(); } catch (_) {}
      }
      lastFocusedBeforeActorModal = null;
    }

    function onActorModalKeydown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeActorDetail();
        return;
      }
      if (e.key === 'Tab' && typeof document?.querySelector === 'function') {
        const modal = document.querySelector('.actor-modal');
        if (!modal) return;
        const focusables = Array.from(modal.querySelectorAll(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href], input:not([disabled])'
        )).filter(el => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !modal.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !modal.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    let lastFocusedBeforeDramaModal = null;

    function openDramaDetail() {
      if (!activeSeries.value) return;
      if (typeof document !== 'undefined') {
        lastFocusedBeforeDramaModal = document.activeElement;
      }
      showDramaDetailModal.value = true;
      if (typeof nextTick === 'function') {
        nextTick(() => {
          const closeBtn = document?.querySelector?.('.drama-modal .modal-close-btn');
          closeBtn?.focus?.();
        });
      }
    }

    function closeDramaDetail() {
      showDramaDetailModal.value = false;
      if (lastFocusedBeforeDramaModal && typeof lastFocusedBeforeDramaModal.focus === 'function') {
        try { lastFocusedBeforeDramaModal.focus(); } catch (_) {}
      }
      lastFocusedBeforeDramaModal = null;
    }

    function openActorFromDrama(actor) {
      if (!actor || !actor.actor_id) return;
      closeDramaDetail();
      openActorDetail({
        actor_id: actor.actor_id,
        name: actor.name,
        avatar: actor.avatar,
        score: ''
      });
    }

    function onDramaModalKeydown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeDramaDetail();
        return;
      }
      if (e.key === 'Tab' && typeof document?.querySelector === 'function') {
        const modal = document.querySelector('.drama-modal');
        if (!modal) return;
        const focusables = Array.from(modal.querySelectorAll(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href], input:not([disabled])'
        )).filter(el => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !modal.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !modal.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    function switchToRelatedActor(rel) {
      if (!rel || !rel.actor_id) return;
      openActorDetail({
        actor_id: rel.actor_id,
        name: rel.name,
        avatar: rel.avatar,
        intro: rel.intro,
        score: ''
      });
    }

    function playActorWork(work) {
      closeActorDetail();
      return openTheater(work);
    }

    function getRankChangeClass(change) {
      if (!change) return 'same';
      if (change.type === 1) return 'up';
      if (change.type === 2) return 'down';
      return 'same';
    }

    function onAvatarError(e) {
      e.target.src = '/assets/app-icon.png';
    }

    async function copyToClipboard(text, successMsg) {
      if (!text) return false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
        } else if (typeof document !== 'undefined' && typeof document.createElement === 'function' && document.body) {
          const el = document.createElement('textarea');
          el.value = text;
          el.style.position = 'fixed';
          el.style.opacity = '0';
          document.body.appendChild(el);
          el.select();
          if (typeof document.execCommand === 'function') {
            document.execCommand('copy');
          }
          document.body.removeChild(el);
        }
        notify(successMsg || '已复制到剪贴板');
        return true;
      } catch (err) {
        console.warn('复制失败:', err);
        notify('复制失败，请手动选中文本复制');
        return false;
      }
    }

    async function copyDramaTitle() {
      const title = activeSeries.value?.series_title || '';
      if (!title) return;
      const ok = await copyToClipboard(title, `已复制剧名: 《${title}》`);
      if (ok) {
        titleCopied.value = true;
        clearTimeout(titleCopiedTimer);
        titleCopiedTimer = setTimeout(() => { titleCopied.value = false; }, 2000);
      }
    }

    const CHINESE_NUMS = {
      '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
    };

    function parseChineseNumber(str) {
      if (!str) return null;
      str = String(str).trim();
      if (/^\d+$/.test(str)) return parseInt(str, 10);
      if (str.length === 1 && CHINESE_NUMS[str] !== undefined) return CHINESE_NUMS[str];
      if (str === '十') return 10;
      if (str.length === 2) {
        if (str[0] === '十' && CHINESE_NUMS[str[1]] !== undefined) return 10 + CHINESE_NUMS[str[1]];
        if (CHINESE_NUMS[str[0]] !== undefined && str[1] === '十') return CHINESE_NUMS[str[0]] * 10;
      }
      if (str.length === 3 && CHINESE_NUMS[str[0]] !== undefined && str[1] === '十' && CHINESE_NUMS[str[2]] !== undefined) {
        return CHINESE_NUMS[str[0]] * 10 + CHINESE_NUMS[str[2]];
      }
      return null;
    }

    const SEASON_PATTERNS = [
      /[（(【\s]*第\s*([0-9零一二两三四五六七八九十]+)\s*(?:季|部|期|辑)[）)】\s]*$/i,
      /[（(【\s]*([0-9零一二两三四五六七八九十]+)\s*(?:季|部|期|辑)[）)】\s]*$/i,
      /[（(【\s]*(?:Season|S)\s*([0-9]+)[）)】\s]*$/i,
      /[（(【]\s*([0-9]+)\s*[）)】]$/i
    ];

    function parseSeasonInfo(rawTitle) {
      if (!rawTitle || typeof rawTitle !== 'string') {
        return { baseTitle: '', seasonNum: 1, seasonLabel: '第1季', isExplicit: false };
      }
      const title = rawTitle.trim();
      for (const pattern of SEASON_PATTERNS) {
        const match = title.match(pattern);
        if (match) {
          const num = parseChineseNumber(match[1]);
          if (num && num > 0 && num <= 100) {
            const rawBase = title.slice(0, match.index).trim();
            const baseTitle = rawBase.replace(/[\s:：·_—\-]+$/, '').trim() || rawBase;
            if (baseTitle) {
              return { baseTitle, seasonNum: num, seasonLabel: `第${num}季`, isExplicit: true };
            }
          }
        }
      }
      const cleaned = title.replace(/[\s:：·_—\-]+$/, '').trim() || title;
      return { baseTitle: cleaned, seasonNum: 1, seasonLabel: '第1季', isExplicit: false };
    }

    function normalizeBaseTitle(title) {
      return (title || '')
        .trim()
        .toLowerCase()
        .replace(/[：:]/g, ':')
        .replace(/[，,]/g, ',')
        .replace(/[！!]/g, '!')
        .replace(/[？?]/g, '')
        .replace(/[“”"']/g, '')
        .replace(/\s+/g, '');
    }

    async function fetchRelatedSeasons(series) {
      if (!series || !series.series_title) {
        relatedSeasons.value = [];
        seriesBaseTitle.value = '';
        return;
      }
      const requestId = ++currentSeasonsRequest;
      const { baseTitle, seasonNum, seasonLabel, isExplicit } = parseSeasonInfo(series.series_title);
      seriesBaseTitle.value = baseTitle;

      const currentItem = {
        series_id: series.series_id,
        series_title: series.series_title,
        cover: series.cover,
        total: series.episodes?.length || series.total,
        social_info: series.social_info,
        tags: series.tags,
        seasonNum,
        seasonLabel,
        isExplicit
      };

      const cached = seasonsCache.get(baseTitle);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        relatedSeasons.value = cached;
        return;
      }

      isCheckingSeasons.value = true;
      try {
        const res1 = await fetch(`/api/search?keyword=${encodeURIComponent(baseTitle)}&page=1`).then(r => r.json());
        if (requestId !== currentSeasonsRequest) return;
        let list = Array.isArray(res1?.results) ? [...res1.results] : [];

        if (res1?.hasMore && list.length >= 5) {
          try {
            const res2 = await fetch(`/api/search?keyword=${encodeURIComponent(baseTitle)}&page=2`).then(r => r.json());
            if (requestId === currentSeasonsRequest && Array.isArray(res2?.results)) {
              list = list.concat(res2.results);
            }
          } catch (_) {}
        }
        if (requestId !== currentSeasonsRequest) return;

        const normBase = normalizeBaseTitle(baseTitle);
        const seenIds = new Set();
        const result = [];

        seenIds.add(currentItem.series_id);
        result.push(currentItem);

        for (const item of list) {
          if (!item || !item.series_id || seenIds.has(item.series_id)) continue;
          const parsed = parseSeasonInfo(item.series_title);
          const itemNormBase = normalizeBaseTitle(parsed.baseTitle);

          if (itemNormBase === normBase || (normBase.length >= 4 && itemNormBase.includes(normBase))) {
            seenIds.add(item.series_id);
            result.push({
              series_id: item.series_id,
              series_title: item.series_title,
              cover: item.cover,
              total: item.total,
              social_info: item.social_info,
              tags: item.tags,
              seasonNum: parsed.seasonNum,
              seasonLabel: parsed.seasonLabel,
              isExplicit: parsed.isExplicit
            });
          }
        }

        // 必须严格按季升序排好序: 1, 2, 3, ..., N
        result.sort((a, b) => {
          if (a.seasonNum !== b.seasonNum) return a.seasonNum - b.seasonNum;
          if (a.isExplicit && !b.isExplicit) return -1;
          if (!a.isExplicit && b.isExplicit) return 1;
          return (b.total || 0) - (a.total || 0);
        });

        seasonsCache.set(baseTitle, result);
        relatedSeasons.value = result;
      } catch (err) {
        if (requestId !== currentSeasonsRequest) return;
        console.warn('获取系列各季失败:', err);
        relatedSeasons.value = [currentItem];
      } finally {
        if (requestId === currentSeasonsRequest) {
          isCheckingSeasons.value = false;
        }
      }
    }

    function selectSeason(season) {
      if (!season || !season.series_id) return;
      if (season.series_id === activeSeries.value?.series_id) {
        closeSeasonsModal();
        return;
      }
      closeSeasonsModal();
      closeDramaDetail();
      sidebarTab.value = 'episodes';
      return openTheater(season);
    }

    function openSeasonsModal() {
      showSeasonsModal.value = true;
      if (typeof nextTick === 'function') {
        nextTick(() => {
          const modal = document?.querySelector?.('.seasons-modal');
          modal?.focus?.();
        });
      }
    }

    function closeSeasonsModal() {
      showSeasonsModal.value = false;
      keepPlayerFocus();
    }

    function onSeasonsModalKeydown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeSeasonsModal();
      }
    }

    function searchSeriesGlobally(keyword) {
      closeSeasonsModal();
      closeDramaDetail();
      leaveTheater();
      searchKeyword.value = keyword || seriesBaseTitle.value;
      handleSearch();
    }

    function openSeasonsModalFromDetail() {
      closeDramaDetail();
      openSeasonsModal();
    }

    // ================= 沉浸式剧场与播放逻辑 =================

    function resetPlayback() {
      bytevc2Session?.stop();
      bytevc2Session = null;
      bytevc2Fallback = null;
      bytevc2FallbackActive = false;
      lastNearEndPrefetch = 0;
      stopDanmakuAnimation();
      danmakuKey = '';
      progressReady = false;
      pendingResumeSec = 0;
      currentTime.value = 0;
      duration.value = 0;
      bufferedPercent.value = 0;
      isPlaying.value = false;
    }

    function leaveTheater() {
      theaterRequest++;
      saveProgressNow();
      if (videoEl.value && typeof videoEl.value.pause === 'function') videoEl.value.pause();
      resetPlayback();
      videoResolution.value = { width: 0, height: 0 };
      setControlsHidden(false);
      clearTimeout(controlsHideTimer);
      showDramaDetailModal.value = false;
      showSeasonsModal.value = false;
      sidebarTab.value = 'episodes';
      viewMode.value = 'catalog';
      if (navigator.mediaSession) { navigator.mediaSession.playbackState = 'none'; navigator.mediaSession.metadata = null; }
    }

    async function openTheater(drama) {
      const request = ++theaterRequest;
      videoErrorMessage.value = '';
      isBuffering.value = true;
      reportClientLog('INFO', `打开短剧剧场: 《${drama.series_title || ''}》(seriesId=${drama.series_id})`);
      try {
        const detail = await fetch(`/api/series/${encodeURIComponent(drama.series_id)}`).then(r => r.json());
        if (request !== theaterRequest) return;
        if (!detail || !detail.episodes || detail.episodes.length === 0) {
          throw new Error(detail?.error || '获取该短剧分集失败，请重试');
        }

        saveProgressNow();
        if (videoEl.value) videoEl.value.pause();
        resetPlayback();
        catalogScrollTop = window.scrollY || 0;
        if (!detail.intro && drama?.description) {
          detail.intro = drama.description;
        }
        if ((!detail.tags || detail.tags.length === 0) && Array.isArray(drama?.tags)) {
          detail.tags = drama.tags;
        }
        activeSeries.value = detail;
        fetchRelatedSeasons(detail);
        const watched = detail.saved_progress?.watched_indexes || [detail.saved_progress?.episode_index];
        watchedMap.value.set(detail.series_id, new Set(watched.filter(index => Number.isInteger(index) && index > 0)));
        activeEpisodes.value = detail.episodes;
        isFavorited.value = !!detail.is_favorite;

        // 计算初始选集分组
        const groups = episodeGroups.value;
        currentGroup.value = groups[0] || { start: 1, end: 30 };

        // 默认恢复上次观看进度或第一集
        let targetIndex = detail.episodes[0].vid_index;
        let resumeSec = 0;
        if (detail.saved_progress) {
          targetIndex = Number(detail.saved_progress.episode_index) || 1;
          resumeSec = Number(detail.saved_progress.position_sec) || 0;
        }

        if (!detail.episodes.some(ep => ep.vid_index === targetIndex)) {
          targetIndex = detail.episodes[0].vid_index;
          resumeSec = 0;
        }
        activeEpisodeIndex.value = targetIndex;
        loadDanmaku();
        // 定位所属分组
        const matchedGroup = groups.find(g => targetIndex >= g.start && targetIndex <= g.end);
        if (matchedGroup) currentGroup.value = matchedGroup;

        pendingResumeSec = resumeSec;
        viewMode.value = 'theater';

        await nextTick();
        keepPlayerFocus();
        if (videoEl.value) {
          videoEl.value.play().catch(e => {
            console.log('自动播放需要用户交互唤醒:', e.message);
            isBuffering.value = false;
          });
        }
      } catch (err) {
        if (request !== theaterRequest) return;
        console.error('打开剧场失败:', err);
        notify('加载剧集失败: ' + err.message);
        isBuffering.value = false;
      }
    }

    function closeTheater() {
      leaveTheater();
      if (['history', 'favorites'].includes(currentTab.value)) loadCatalog();
      nextTick(() => window.scrollTo?.(0, catalogScrollTop));
    }

    function switchEpisode(ep) {
      if (activeEpisodeIndex.value === ep.vid_index) return;
      saveProgressNow();
      resetPlayback();
      videoErrorMessage.value = '';
      streamRefreshTick.value = 0;
      isBuffering.value = true;
      activeEpisodeIndex.value = ep.vid_index;
      loadDanmaku();
      currentTime.value = 0;



      nextTick(() => {
        if (videoEl.value) {
          videoEl.value.currentTime = 0;
          videoEl.value.play().catch(e => {
            console.log('播放被策略拦截，等待用户交互:', e.message);
            isBuffering.value = false;
          });
        }
        keepPlayerFocus();
      });
    }

    function playPrevEpisode() {
      if (activeEpisodeIndex.value <= 1) return;
      const prev = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value - 1);
      if (prev) {
        // 同步分组
        const group = episodeGroups.value.find(g => prev.vid_index >= g.start && prev.vid_index <= g.end);
        if (group) currentGroup.value = group;
        switchEpisode(prev);
      }
    }

    function playNextEpisode() {
      if (activeEpisodeIndex.value >= activeEpisodes.value.length) return;
      const next = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value + 1);
      if (next) {
        // 同步分组
        const group = episodeGroups.value.find(g => next.vid_index >= g.start && next.vid_index <= g.end);
        if (group) currentGroup.value = group;
        switchEpisode(next);
      }
    }

    function togglePlay() {
      if (!videoEl.value) return;
      if (videoEl.value.paused) {
        videoEl.value.play().catch(console.error);
      } else {
        videoEl.value.pause();
      }
      keepPlayerFocus();
    }

    function seekByClick(e) {
      if (!videoEl.value || !duration.value) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const targetPercent = Math.max(0, Math.min(1, clickX / rect.width));
      videoEl.value.currentTime = targetPercent * duration.value;
      keepPlayerFocus();
    }

    function changeSpeed(event) {
      if (videoEl.value) {
        videoEl.value.playbackRate = parseFloat(playbackRate.value);
      }
      event?.target?.blur?.();
      keepPlayerFocus();
    }

    function changeVolume(event) {
      if (videoEl.value) {
        videoEl.value.volume = parseFloat(volume.value);
        isMuted.value = (videoEl.value.volume === 0);
        videoEl.value.muted = isMuted.value;
      }
      event?.target?.blur?.();
      keepPlayerFocus();
    }

    function toggleMute() {
      if (!videoEl.value) return;
      isMuted.value = !isMuted.value;
      savePreferences({ isMuted: isMuted.value });
      videoEl.value.muted = isMuted.value;
      keepPlayerFocus();
    }

    // 画面自适应模式: 'contain' (完整居中) | 'cover' (铺满视口)
    const fitMode = ref('contain');
    function toggleFitMode() {
      fitMode.value = fitMode.value === 'contain' ? 'cover' : 'contain';
      savePreferences({ fitMode: fitMode.value });
      keepPlayerFocus();
    }

    // 单击播放/暂停，双击切换全屏 (250ms 消抖防冲突)
    let videoClickTimer = null;
    function handleVideoClick() {
      if (videoClickTimer) {
        clearTimeout(videoClickTimer);
        videoClickTimer = null;
        toggleFullscreen();
      } else {
        videoClickTimer = setTimeout(() => {
          videoClickTimer = null;
          togglePlay();
        }, 250);
      }
    }

    function toggleFullscreen() {
      if (!videoEl.value) return;
      if (!document.fullscreenElement) {
        const target = videoEl.value.closest?.('.player-container') || videoEl.value;
        target.requestFullscreen().catch(err => {
          notify('全屏模式调用失败: ' + err.message);
        });
      } else {
        document.exitFullscreen().catch(console.error);
      }
      keepPlayerFocus();
    }

    async function toggleFavCurrent() {
      if (!activeSeries.value) return;
      try {
        const res = await fetch('/api/favorites/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            series_id: activeSeries.value.series_id,
            series_title: activeSeries.value.series_title,
            cover: activeSeries.value.cover,
            episode_count: activeSeries.value.total
          })
        }).then(r => r.json());
        if (res.error) throw new Error(res.error);
        isFavorited.value = !!res.is_favorite;
      } catch (err) {
        console.error('收藏切换失败:', err);
        notify('收藏保存失败，请稍后重试');
      } finally {
        keepPlayerFocus();
      }
    }

    // ================= 播放器事件回调 =================

    function onPlay(event) {
      if (event && event.target !== videoEl.value) return;
      isPlaying.value = true;
      loadDanmaku();
      startDanmakuAnimation();
      danmakuEngine?.play?.();
      markWatched(activeEpisodeIndex.value);
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
      isBuffering.value = false;
      reportClientLog('INFO', `播放器起播: 《${activeSeries.value?.series_title || ''}》 第 ${activeEpisodeIndex.value} 集`);
      resetControlsTimer();
    }

    function onCanPlay(event) {
      if (event && event.target !== videoEl.value) return;
      isBuffering.value = false;
      if (videoEl.value?.videoWidth && videoEl.value?.videoHeight) {
        videoResolution.value = {
          width: videoEl.value.videoWidth,
          height: videoEl.value.videoHeight
        };
      }
    }

    function onPause(event) {
      if (event && event.target !== videoEl.value) return;
      isPlaying.value = false;
      danmakuEngine?.pause?.();
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
      saveProgressNow();
      setControlsHidden(false);
      clearTimeout(controlsHideTimer);
    }

    function onLoadedMetadata(event) {
      if (event && event.target !== videoEl.value) return;
      if (videoEl.value) {
        progressReady = true;
        duration.value = videoEl.value.duration || 0;
        if (videoEl.value.videoWidth && videoEl.value.videoHeight) {
          videoResolution.value = {
            width: videoEl.value.videoWidth,
            height: videoEl.value.videoHeight
          };
        }
        videoEl.value.volume = Number(volume.value);
        videoEl.value.muted = isMuted.value;
        if (navigator.mediaSession && typeof MediaMetadata !== 'undefined') {
          navigator.mediaSession.metadata = new MediaMetadata({ title: `${activeSeries.value?.series_title || ''} · 第 ${activeEpisodeIndex.value} 集`, artist: '红果开源播放器' });
        }
        reportClientLog('INFO', `视频元数据解析就绪: 《${activeSeries.value?.series_title || ''}》 第 ${activeEpisodeIndex.value} 集, 时长=${formatTime(duration.value)}, 画面=${videoEl.value.videoWidth || 0}x${videoEl.value.videoHeight || 0}`);
        videoEl.value.playbackRate = parseFloat(playbackRate.value);
        if (pendingResumeSec > 0 && pendingResumeSec < duration.value) {
          try {
            videoEl.value.currentTime = pendingResumeSec;
            danmakuEngine?.seek?.();
          } catch (e) {
            console.warn('恢复历史播放位置失败:', e);
          }
        }
        pendingResumeSec = 0;
      }
    }

    function onTimeUpdate(event) {
      if (isScrubbing.value) return;
      if (event && event.target !== videoEl.value) return;
      if (videoEl.value) {
        currentTime.value = videoEl.value.currentTime || 0;
        const rate = Number(videoEl.value.playbackRate) || 1;
        const remaining = (duration.value - currentTime.value) / rate;
        if (isPlaying.value && Number.isFinite(remaining) && remaining > 0 && remaining <= 45 && Date.now() - lastNearEndPrefetch >= 20000) {
          const next = activeEpisodes.value.find(ep => ep.vid_index === activeEpisodeIndex.value + 1);
          if (next?.vid) {
            lastNearEndPrefetch = Date.now();
            const next2 = activeEpisodes.value.find(ep => ep.vid_index === activeEpisodeIndex.value + 2);
            const next3 = activeEpisodes.value.find(ep => ep.vid_index === activeEpisodeIndex.value + 3);
            const next4 = activeEpisodes.value.find(ep => ep.vid_index === activeEpisodeIndex.value + 4);
            const followVids = [next2?.vid, next3?.vid, next4?.vid].filter(Boolean);
            const query = followVids.length ? `?next_vids=${encodeURIComponent(followVids.join(','))}` : '';
            fetch(`/api/prefetch/${encodeURIComponent(next.vid)}${query}`, { method: 'POST' }).catch(() => {});
          }
        }
        // 计算缓冲进度
        if (videoEl.value.buffered.length > 0 && duration.value > 0) {
          const bufferedEnd = videoEl.value.buffered.end(videoEl.value.buffered.length - 1);
          bufferedPercent.value = Math.min(100, (bufferedEnd / duration.value) * 100);
        }
      }
    }

    function onEnded(event) {
      if (event && event.target !== videoEl.value) return;
      console.log('[Player] 本集播放完成，正在无感自动切入下一集...');
      playNextEpisode();
    }

    async function onVideoError(e) {
      isBuffering.value = false;
      if (e?.target && e.target !== videoEl.value) return;
      if (bytevc2Session && bytevc2Fallback) { bytevc2Fallback(); return; }
      const code = videoEl.value?.error?.code;
      const message = videoEl.value?.error?.message || '';
      if (bytevc2FallbackActive) {
        reportClientLog('ERROR', `ByteVC2 完整转换播放失败: code=${code}, message=${message}`);
        videoErrorMessage.value = 'ByteVC2 视频转换或播放失败，请重试本集';
        return;
      }
      if (code !== 4) reportClientLog('ERROR', `播放器解码/渲染报错: code=${code}, message=${message}`);
      if (code === 3) {
        videoErrorMessage.value = '视频解码失败；请重试或更换分集，Windows 用户请确认已安装 HEVC 视频扩展';
      } else if (code === 4) {
        videoErrorMessage.value = '视频源加载或格式异常；请检查网络/代理设置，或重试切换分集';
        const streamUrl = currentStreamUrl.value;
        const currentEpIndex = activeEpisodeIndex.value;
        if (streamUrl) {
          try {
            const probeRes = await fetch(streamUrl, {
              method: 'GET',
              headers: { Range: 'bytes=0-0' }
            });
            if (!probeRes.ok && activeEpisodeIndex.value === currentEpIndex) {
              const errData = await probeRes.json().catch(() => null);
              if (activeEpisodeIndex.value !== currentEpIndex || currentStreamUrl.value !== streamUrl) return;
              if (errData?.code !== 'BYTEVC2_PROGRESSIVE') reportClientLog('ERROR', `播放器解码/渲染报错: code=${code}, message=${message}`);
              if (errData?.code === 'BYTEVC2_PROGRESSIVE' && window.Bytevc2Stream?.supported() && Number(errData.duration) > 0) {
                videoErrorMessage.value = '';
                isBuffering.value = true;
                const video = videoEl.value;
                const progressiveUrl = streamUrl.replace(/([?&])mse=1(?=&|$)/, '$1mse=stream');
                bytevc2Session?.stop();
                bytevc2Fallback = () => {
                  if (video !== videoEl.value || currentStreamUrl.value !== streamUrl) return;
                  reportClientLog('WARN', 'ByteVC2 分片播放失败，回退至完整转换');
                  const position = video.currentTime || 0;
                  pendingResumeSec = position;
                  bytevc2Session?.stop();
                  bytevc2Session = null;
                  bytevc2Fallback = null;
                  bytevc2FallbackActive = true;
                  video.src = streamUrl.replace(/([?&])mse=1(?=&|$)/, '$1mse=buffered');
                  video.load();
                  video.play().catch(() => {});
                };
                try {
                  bytevc2Session = window.Bytevc2Stream.start(video, progressiveUrl, Number(errData.duration), bytevc2Fallback);
                } catch (_) { bytevc2Fallback(); return; }
                video.play().catch(() => {});
              } else if (errData?.code === 'DEVICE_REGISTRATION_FAILED' || /匿名播放设备注册失败|ERR_NETWORK/i.test(errData?.error || '')) {
                videoErrorMessage.value = '播放设备注册受阻（ERR_NETWORK）；请检查网络连接、代理软件（Clash/去广告规则）或 DNS 设置';
                reportClientLog('WARN', '播放器源探测提示: 设备注册受阻（ERR_NETWORK），已展示网络/代理排查指引');
              } else if (errData?.code === 'SECURITY_BLOCKED') {
                videoErrorMessage.value = '视频源地址未通过安全检查；请切换分集重试';
              } else if (errData?.code === 'UNSUPPORTED_BYTEVC2') {
                videoErrorMessage.value = '本集使用 ByteVC2 编码，当前播放器暂不支持';
              } else if (errData?.code === 'BYTEVC2_TRANSCODER_UNAVAILABLE' || errData?.code === 'BYTEVC2_TRANSCODE_FAILED') {
                videoErrorMessage.value = errData.error || 'ByteVC2 视频转换失败，请重试';
              } else if (errData?.error) {
                videoErrorMessage.value = `${errData.error}；请检查网络或重试切换分集`;
              }
            } else if (probeRes.ok && activeEpisodeIndex.value === currentEpIndex) {
              reportClientLog('ERROR', `播放器解码/渲染报错: code=${code}, message=${message}`);
            }
          } catch (_) {
            if (activeEpisodeIndex.value === currentEpIndex && typeof navigator !== 'undefined' && navigator.onLine === false) {
              videoErrorMessage.value = '网络连接已断开，请检查网络设置后重试';
            }
          }
        }
      } else if (code === 2) {
        videoErrorMessage.value = '视频流读取中断（网络或取流异常）；请点击“重试本集”或切换分集';
      } else {
        videoErrorMessage.value = '视频加载失败，请检查网络后重试';
      }
    }

    function retryCurrentEpisode() {
      bytevc2Session?.stop();
      bytevc2Session = null;
      bytevc2Fallback = null;
      bytevc2FallbackActive = false;
      videoErrorMessage.value = '';
      streamRefreshTick.value++;
      if (videoEl.value) {
        videoEl.value.load();
        videoEl.value.play().catch(console.error);
      }
    }

    // ================= 辅助工具方法 =================

    function formatTime(seconds) {
      const s = Math.floor(seconds || 0);
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    }

    function markWatched(index) {
      if (!activeSeries.value) return;
      const sid = activeSeries.value.series_id;
      if (!watchedMap.value.has(sid)) {
        watchedMap.value.set(sid, new Set());
      }
      watchedMap.value.get(sid).add(index);
    }

    function isEpisodeWatched(index) {
      if (!activeSeries.value) return false;
      const set = watchedMap.value.get(activeSeries.value.series_id);
      return set ? set.has(index) : false;
    }

    function saveProgressNow() {
      if (!activeSeries.value || !progressReady || viewMode.value !== 'theater') return;
      const curEp = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value);
      fetch('/api/progress', {
        keepalive: true,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          series_id: activeSeries.value.series_id,
          series_title: activeSeries.value.series_title,
          cover: activeSeries.value.cover,
          episode_index: activeEpisodeIndex.value,
          vid: curEp?.vid || '',
          position_sec: currentTime.value,
          duration_sec: duration.value,
          watched_indexes: [...(watchedMap.value.get(activeSeries.value.series_id) || [])]
        })
      }).then(response => { if (!response.ok) throw new Error('保存失败'); }).catch(() => notify('观看进度保存失败，请检查数据目录是否可写'));
    }

    function onImageError(e) {
      e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400"><rect fill="%23222" width="100%" height="100%"/><text fill="%23777" font-size="20" font-family="sans-serif" x="50%" y="50%" text-anchor="middle">暂无封面</text></svg>';
    }

    // ================= 键盘快捷键监听与焦点管理 =================

    function keepPlayerFocus() {
      if (viewMode.value !== 'theater') return;
      const container = document.querySelector?.('.player-container');
      if (container && document.activeElement !== container) {
        container.focus?.({ preventScroll: true });
      }
    }

    function isTextEditingTarget(target) {
      if (!target) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      if (tag === 'TEXTAREA') return true;
      if (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(target.type)) return true;
      return false;
    }

    function handleKeyDown(e) {
      if (isTextEditingTarget(e.target)) return;
      if (e.target?.tagName === 'SELECT') return;

      if ((e.code === 'Escape' || e.key === 'Escape') && showSpeedMenu.value) { showSpeedMenu.value = false; e.preventDefault(); return; }
      if (e.code === 'Escape' || e.key === 'Escape') {
        if (showAppMenu.value) {
          e.preventDefault();
          closeAppMenu();
          return;
        }
        if (showShortcutsModal.value) {
          e.preventDefault();
          closeShortcutsModal();
          return;
        }
        if (showAboutModal.value) {
          e.preventDefault();
          closeAboutModal();
          return;
        }
        if (showDramaDetailModal.value) {
          e.preventDefault();
          closeDramaDetail();
          return;
        }
        if (showSeasonsModal.value) {
          e.preventDefault();
          closeSeasonsModal();
          return;
        }
        if (activeActor.value) {
          e.preventDefault();
          closeActorDetail();
          return;
        }
      }

      if (viewMode.value === 'theater') {
        resetControlsTimer();
        const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar' || e.key?.toLowerCase() === 'k';
        if (isSpace) {
          e.preventDefault();
          e.target?.blur?.();
          togglePlay();
          showOSD(videoEl.value?.paused ? '已暂停' : '继续播放');
        } else if (e.code === 'ArrowUp' || e.code === 'PageUp' || e.key === 'ArrowUp' || e.key === 'PageUp') {
          e.preventDefault();
          e.target?.blur?.();
          playPrevEpisode();
        } else if (e.code === 'ArrowDown' || e.code === 'PageDown' || e.key === 'ArrowDown' || e.key === 'PageDown') {
          e.preventDefault();
          e.target?.blur?.();
          playNextEpisode();
        } else if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') {
          e.preventDefault();
          if (videoEl.value) videoEl.value.currentTime = Math.max(0, videoEl.value.currentTime - 5);
          showOSD('快退 5 秒');
        } else if (e.code === 'ArrowRight' || e.key === 'ArrowRight') {
          e.preventDefault();
          if (videoEl.value) videoEl.value.currentTime = Math.min(duration.value, videoEl.value.currentTime + 5);
          showOSD('快进 5 秒');
        } else if (e.key?.toLowerCase() === 'm') {
          e.preventDefault();
          toggleMute();
          showOSD(isMuted.value ? '静音' : '开启声音');
        } else if (e.key?.toLowerCase() === 'j') {
          e.preventDefault();
          e.target?.blur?.();
          sidebarOpen.value = !sidebarOpen.value;
          showOSD(sidebarOpen.value ? '显示选集侧栏' : '隐藏选集侧栏');
        } else if (e.key?.toLowerCase() === 'f') {
          e.preventDefault();
          e.target?.blur?.();
          toggleFullscreen();
        } else if (e.code === 'Escape' || e.key === 'Escape') {
          if (document.fullscreenElement) { document.exitFullscreen().catch(console.error); return; }
          if (Date.now() - fullscreenExitAt < 300) return;
          closeTheater();
        }
      }
    }

    function handleGlobalPointerDown(e) {
      if (showDanmakuSettings.value && !e.target?.closest?.('.danmaku-control')) showDanmakuSettings.value = false;
      if (viewMode.value !== 'theater') return;
      if (isTextEditingTarget(e.target) || e.target?.closest?.('.search-box')) return;
      const btn = e.target?.closest?.('button');
      if (btn) {
        btn.blur?.();
      }
    }

    function handleGlobalFocusIn(e) {
      if (viewMode.value !== 'theater') return;
      if (isTextEditingTarget(e.target) || e.target?.closest?.('.search-box')) return;
      // 避免控制按钮、全屏按钮、选集方块或滑块截留焦点，保持焦点常驻在播放器主体上
      if (e.target?.tagName === 'BUTTON' || (e.target?.tagName === 'INPUT' && e.target.type === 'range') || e.target?.tagName === 'SELECT') {
        e.target.blur?.();
        keepPlayerFocus();
      }
    }

    function handleGlobalClick(e) {
      if (showSpeedMenu.value && !e.target?.closest?.('.speed-selector')) showSpeedMenu.value = false;
      if (showAppMenu.value && !e.target?.closest?.('.header-menu-container')) {
        showAppMenu.value = false;
      }
      if (viewMode.value !== 'theater') return;
      if (isTextEditingTarget(e.target) || e.target?.closest?.('.search-box')) return;
      const btn = e.target?.closest?.('button');
      if (btn) {
        btn.blur?.();
      }
      keepPlayerFocus();
    }

    onMounted(() => {
      loadPreferences();
      loadSearchHistory();
      loadCatalog();
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('click', handleGlobalClick);
      window.addEventListener('mousemove', handleWindowMouseMove);
      document.addEventListener?.('pointerdown', handleGlobalPointerDown, true);
      document.addEventListener?.('focusin', handleGlobalFocusIn);
      window.addEventListener('pagehide', saveProgressNow);
      document.addEventListener?.('fullscreenchange', fullscreenChanged);
      if (navigator.mediaSession) {
        const actions = { play: () => videoEl.value?.play(), pause: () => videoEl.value?.pause(), previoustrack: playPrevEpisode, nexttrack: playNextEpisode };
        for (const [name, handler] of Object.entries(actions)) {
          try { navigator.mediaSession.setActionHandler(name, handler); } catch (_) {}
        }
      }
      // 定时每 4 秒静默上报进度
      progressTimer = setInterval(() => {
        if (viewMode.value === 'theater' && isPlaying.value) {
          saveProgressNow();
        }
      }, 4000);
    });

    onUnmounted(() => {
      bytevc2Session?.stop();
      stopDanmakuAnimation();
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('mousemove', handleWindowMouseMove);
      document.removeEventListener?.('pointerdown', handleGlobalPointerDown, true);
      document.removeEventListener?.('focusin', handleGlobalFocusIn);
      window.removeEventListener('pagehide', saveProgressNow);
      document.removeEventListener?.('fullscreenchange', fullscreenChanged);
      clearTimeout(toastTimer); clearTimeout(osdTimer);
      setControlsHidden(false);
      clearTimeout(controlsHideTimer);
      if (navigator.mediaSession) for (const name of ['play', 'pause', 'previoustrack', 'nexttrack']) {
        try { navigator.mediaSession.setActionHandler(name, null); } catch (_) {}
      }
      if (progressTimer) clearInterval(progressTimer);
    });

    return {
      savePreferences, danmakuEnabled, showDanmakuSettings, danmakuRows, danmakuOpacity, danmakuSpeed, danmakuLikesPriority, toggleLikesPriority, prioritizeDanmakuItems, estimateDanmakuWidth, calculateRequiredGap, danmakuStatus, danmakuLayer, danmakuColor, toggleDanmaku, loadDanmaku,
      toastText, osdMessage, sidebarOpen, isScrubbing, previewTime, previewPercent, showPreview,
      isFullscreen, isControlsHidden, resetControlsTimer, clearControlsTimer, setControlsHidden, handleWindowMouseMove,
      previewSeek, seekFromSlider, startScrubbing, finishScrubbing,
      viewMode,
      currentTab,
      searchKeyword, searchHistory, showSearchHistory, updateSearchHistory, selectSearchHistory, onSearchFocusOut,
      hotTags,
      currentDramas,
      currentPage,
      loadingCatalog,
      hasMore,
      videoEl,
      activeSeries,
      activeEpisodes,
      activeEpisodeIndex,
      isFavorited,
      isPlaying,
      isBuffering,
      videoErrorMessage,
      currentTime,
      duration,
      bufferedPercent,
      playedPercent,
      playbackRate, showSpeedMenu, selectSpeed,
      volume,
      isMuted,
      videoResolution, resolutionText, resolutionTitle,
      currentGroup,
      currentStreamUrl,
      episodeGroups,
      currentGroupEpisodes,
      loadCatalog,
      handleSearch,
      quickSearch,
      switchTab,
      changePage,
      goHome,
      openTheater,
      closeTheater,
      switchEpisode,
      playPrevEpisode,
      playNextEpisode,
      togglePlay,
      seekByClick,
      changeSpeed,
      changeVolume,
      toggleMute,
      toggleFullscreen,
      fitMode,
      toggleFitMode,
      handleVideoClick,
      toggleFavCurrent,
      onPlay,
      onPause,
      onCanPlay,
      onLoadedMetadata,
      onTimeUpdate,
      onEnded,
      onVideoError,
      retryCurrentEpisode,
      formatTime,
      isEpisodeWatched,
      onImageError,
      keepPlayerFocus,
      actors,
      actorPage,
      actorGender,
      actorHasMore,
      actorRankDate,
      loadingActors,
      activeActor,
      activeActorDetail,
      actorWorks,
      actorWorksOffset,
      actorWorksTotal,
      actorWorksHasMore,
      loadingActorWorks,
      loadingMoreWorks,
      actorWorksError,
      loadActorRankings,
      changeActorPage,
      switchActorGender,
      openActorDetail,
      closeActorDetail,
      loadMoreActorWorks,
      retryLoadActorWorks,
      switchToRelatedActor,
      playActorWork,
      getRankChangeClass,
      onAvatarError,
      catalogError,
      onActorModalKeydown,
      showDramaDetailModal,
      openDramaDetail,
      closeDramaDetail,
      openActorFromDrama,
      onDramaModalKeydown,
      relatedSeasons,
      isCheckingSeasons,
      seriesBaseTitle,
      showSeasonsModal,
      sidebarTab,
      titleCopied,
      copyDramaTitle,
      openSeasonsModal,
      closeSeasonsModal,
      onSeasonsModalKeydown,
      selectSeason,
      searchSeriesGlobally,
      openSeasonsModalFromDetail,
      parseSeasonInfo,
      fetchRelatedSeasons,
      showAppMenu,
      showAboutModal, appVersion,
      showShortcutsModal,
      toggleAppMenu,
      closeAppMenu,
      openAboutModal,
      closeAboutModal,
      openShortcutsModal,
      closeShortcutsModal,
      openLogDir,
      openLogFile,
      openGithubRepo
    };
  }
}).mount('#app');
