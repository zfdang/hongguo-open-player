// SPDX-License-Identifier: GPL-3.0-only
const { createApp, ref, computed, onMounted, onUnmounted, nextTick } = Vue;

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
    const hotTags = ref(['离婚', '战神', '重生', '逆袭', '神医', '千金', '豪门', '甜宠']);

    // 目录与短剧列表
    const currentDramas = ref([]);
    const currentPage = ref(1);
    const loadingCatalog = ref(false);
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
    const volume = ref(1.0);
    const isMuted = ref(false);
    const watchedMap = ref(new Map()); // seriesId -> Set(epIndexes)
    let progressTimer = null;
    let pendingResumeSec = 0;
    let progressReady = false;
    let theaterRequest = 0;
    let catalogScrollTop = 0;
    let fullscreenExitAt = 0;
    const toastText = ref('');
    const osdMessage = ref('');
    let toastTimer, osdTimer;
    const sidebarOpen = ref(true);
    const isScrubbing = ref(false);
    const previewTime = ref(0);
    const previewPercent = ref(0);
    const showPreview = ref(false);
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
    }
    function startScrubbing(event) {
      isScrubbing.value = true;
      event.target.setPointerCapture?.(event.pointerId);
    }
    function finishScrubbing(event) {
      isScrubbing.value = false;
      showPreview.value = false;
      saveProgressNow();
      event?.target?.blur?.();
      keepPlayerFocus();
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
      if (!document.fullscreenElement) fullscreenExitAt = Date.now();
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

    // 当前播放直链 (通过本地边下边解代理)
    const currentStreamUrl = computed(() => {
      const ep = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value);
      if (!ep || !ep.vid) return '';
      // 计算下一集的 vid 便于代理服务无感预加载
      const nextEp = activeEpisodes.value.find(e => e.vid_index === activeEpisodeIndex.value + 1);
      const nextParam = nextEp?.vid ? `?next_vid=${nextEp.vid}` : '';
      return `/api/stream/${ep.vid}${nextParam}`;
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
        currentDramas.value = [];
        hasMore.value = false;
      } finally {
        if (request === catalogRequest) loadingCatalog.value = false;
      }
    }

    async function handleSearch() {
      if (!searchKeyword.value.trim()) return;
      submittedKeyword = searchKeyword.value.trim();
      currentTab.value = 'search';
      currentPage.value = 1;
      leaveTheater();
      return loadCatalog();
    }

    function quickSearch(tag) {
      searchKeyword.value = tag;
      handleSearch();
    }

    function switchTab(tab) {
      currentTab.value = tab;
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

    async function openActorDetail(actor) {
      if (!actor || !actor.actor_id) return;
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

    // ================= 沉浸式剧场与播放逻辑 =================

    function resetPlayback() {
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
      if (videoEl.value) videoEl.value.pause();
      resetPlayback();
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
        activeSeries.value = detail;
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
      isBuffering.value = true;
      activeEpisodeIndex.value = ep.vid_index;
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
      videoEl.value.muted = isMuted.value;
      keepPlayerFocus();
    }

    // 画面自适应模式: 'contain' (完整居中) | 'cover' (铺满视口)
    const fitMode = ref('contain');
    function toggleFitMode() {
      fitMode.value = fitMode.value === 'contain' ? 'cover' : 'contain';
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
      markWatched(activeEpisodeIndex.value);
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
      isBuffering.value = false;
      reportClientLog('INFO', `播放器起播: 《${activeSeries.value?.series_title || ''}》 第 ${activeEpisodeIndex.value} 集`);
    }

    function onCanPlay(event) {
      if (event && event.target !== videoEl.value) return;
      isBuffering.value = false;
    }

    function onPause(event) {
      if (event && event.target !== videoEl.value) return;
      isPlaying.value = false;
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
      saveProgressNow();
    }

    function onLoadedMetadata(event) {
      if (event && event.target !== videoEl.value) return;
      if (videoEl.value) {
        progressReady = true;
        duration.value = videoEl.value.duration || 0;
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

    function onVideoError(e) {
      console.error('[Player] 视频播放器报错:', e);
      isBuffering.value = false;
      if (e?.target && e.target !== videoEl.value) return;
      const code = videoEl.value?.error?.code;
      const message = videoEl.value?.error?.message || '';
      reportClientLog('ERROR', `播放器解码/渲染报错: code=${code}, message=${message}`);
      videoErrorMessage.value = code === 3 || code === 4
        ? '视频格式无法解码；请重试或选择其他分集，并检查系统解码器'
        : '视频加载失败，请检查网络后重试';
    }

    function retryCurrentEpisode() {
      videoErrorMessage.value = '';
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

      if (e.code === 'Escape' || e.key === 'Escape') {
        if (activeActor.value) {
          e.preventDefault();
          closeActorDetail();
          return;
        }
      }

      if (viewMode.value === 'theater') {
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
      if (viewMode.value !== 'theater') return;
      if (isTextEditingTarget(e.target)) return;
      const btn = e.target?.closest?.('button');
      if (btn) {
        btn.blur?.();
      }
    }

    function handleGlobalFocusIn(e) {
      if (viewMode.value !== 'theater') return;
      if (isTextEditingTarget(e.target)) return;
      // 避免控制按钮、全屏按钮、选集方块或滑块截留焦点，保持焦点常驻在播放器主体上
      if (e.target?.tagName === 'BUTTON' || (e.target?.tagName === 'INPUT' && e.target.type === 'range') || e.target?.tagName === 'SELECT') {
        e.target.blur?.();
        keepPlayerFocus();
      }
    }

    function handleGlobalClick(e) {
      if (viewMode.value !== 'theater') return;
      if (isTextEditingTarget(e.target)) return;
      const btn = e.target?.closest?.('button');
      if (btn) {
        btn.blur?.();
      }
      keepPlayerFocus();
    }

    onMounted(() => {
      loadCatalog();
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('click', handleGlobalClick);
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
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('click', handleGlobalClick);
      document.removeEventListener?.('pointerdown', handleGlobalPointerDown, true);
      document.removeEventListener?.('focusin', handleGlobalFocusIn);
      window.removeEventListener('pagehide', saveProgressNow);
      document.removeEventListener?.('fullscreenchange', fullscreenChanged);
      clearTimeout(toastTimer); clearTimeout(osdTimer);
      if (navigator.mediaSession) for (const name of ['play', 'pause', 'previoustrack', 'nexttrack']) {
        try { navigator.mediaSession.setActionHandler(name, null); } catch (_) {}
      }
      if (progressTimer) clearInterval(progressTimer);
    });

    return {
      toastText, osdMessage, sidebarOpen, isScrubbing, previewTime, previewPercent, showPreview,
      previewSeek, seekFromSlider, startScrubbing, finishScrubbing,
      viewMode,
      currentTab,
      searchKeyword,
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
      playbackRate,
      volume,
      isMuted,
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
      onAvatarError
    };
  }
}).mount('#app');
