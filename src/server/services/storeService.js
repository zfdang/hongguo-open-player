// SPDX-License-Identifier: GPL-3.0-only
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

class StoreService {
  constructor(dataDir = process.env.HONGGUO_DATA_DIR || path.join(__dirname, '../../../data')) {
    this.dataDir = dataDir;
    this.dataFile = path.join(this.dataDir, 'user_data.json');
    this.state = {
      history: Object.create(null), // series_id -> { series_id, series_title, cover, episode_index, vid, position_sec, duration_sec, updated_at }
      searchHistory: [],
      preferences: {},
      favorites: Object.create(null) // series_id -> { series_id, series_title, cover, updated_at }
    };
    this.pending = Promise.resolve();
    this.lastLoadedMtime = 0;
    this.init();
  }

  readDiskState() {
    for (const file of [this.dataFile, `${this.dataFile}.bak`]) {
      if (!fs.existsSync(file)) continue;
      try {
        const stats = fs.statSync(file);
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && ['history', 'favorites'].every(field => parsed[field] && typeof parsed[field] === 'object' && !Array.isArray(parsed[field]))) {
          return {
            history: Object.assign(Object.create(null), parsed.history),
            favorites: Object.assign(Object.create(null), parsed.favorites),
            searchHistory: Array.isArray(parsed.searchHistory) ? parsed.searchHistory.filter(x => typeof x === 'string').slice(0, 10) : [],
            preferences: this.validPreferences(parsed.preferences),
            mtimeMs: stats.mtimeMs
          };
        }
      } catch {}
    }
    return null;
  }

  reloadDiskStateIfNeeded() {
    try {
      if (!fs.existsSync(this.dataFile)) return;
      const stat = fs.statSync(this.dataFile);
      if (stat.mtimeMs !== this.lastLoadedMtime) {
        const disk = this.readDiskState();
        if (disk) {
          this.state = { history: disk.history, favorites: disk.favorites, searchHistory: disk.searchHistory, preferences: disk.preferences };
          this.lastLoadedMtime = disk.mtimeMs;
          this.loadError = null;
        }
      }
    } catch {}
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const file of [this.dataFile, `${this.dataFile}.bak`]) {
      if (!fs.existsSync(file)) continue;
      try {
        const stats = fs.statSync(file);
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || ['history', 'favorites'].some(field => !parsed[field] || typeof parsed[field] !== 'object' || Array.isArray(parsed[field]))) throw new Error('Invalid user data');
        for (const field of ['history', 'favorites']) this.state[field] = Object.assign(Object.create(null), parsed[field]);
        this.state.searchHistory = Array.isArray(parsed.searchHistory) ? parsed.searchHistory.filter(x => typeof x === 'string').slice(0, 10) : [];
        this.state.preferences = this.validPreferences(parsed.preferences);
        this.lastLoadedMtime = stats.mtimeMs;
        this.loadError = null;
        return;
      } catch (error) {
        this.loadError = error;
      }
    }
  }

  async rename(source, destination) {
    for (let attempt = 0; ; attempt++) {
      try { return await fs.promises.rename(source, destination); }
      catch (error) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (2 ** attempt)));
      }
    }
  }

  async save(nextState) {
    if (this.loadError) throw new Error('用户数据损坏且无可用备份，请备份数据文件后修复');
    await fs.promises.mkdir(this.dataDir, { recursive: true });
    const tempFile = `${this.dataFile}.${randomUUID()}.tmp`;
    const backupTemp = `${tempFile}.bak`;
    try {
      await fs.promises.writeFile(tempFile, JSON.stringify(nextState, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.promises.writeFile(backupTemp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
      await this.rename(backupTemp, `${this.dataFile}.bak`);
      await this.rename(tempFile, this.dataFile);
      this.state = nextState;
      try {
        const stat = await fs.promises.stat(this.dataFile);
        this.lastLoadedMtime = stat.mtimeMs;
      } catch {}
    } finally {
      await Promise.allSettled([tempFile, backupTemp].map(file => fs.promises.rm(file, { force: true })));
    }
  }

  mutate(update) {
    const task = this.pending.catch(() => {}).then(async () => {
      this.reloadDiskStateIfNeeded();
      const { state, result } = update(this.state);
      await this.save(state);
      return result;
    });
    this.pending = task;
    return task;
  }

  validateSeries(item) {
    if (!item || typeof item.series_id !== 'string' || !/^\d{1,30}$/.test(item.series_id)) {
      throw Object.assign(new Error('无效的 series_id'), { status: 400 });
    }
  }

  validPreferences(value) {
    const valid = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return valid;
    if (typeof value.danmakuEnabled === 'boolean') valid.danmakuEnabled = value.danmakuEnabled;
    if ([1, 3, 5].includes(value.danmakuRows)) valid.danmakuRows = value.danmakuRows;
    if (typeof value.danmakuOpacity === 'number' && Number.isFinite(value.danmakuOpacity) && value.danmakuOpacity >= 0.1 && value.danmakuOpacity <= 1) valid.danmakuOpacity = value.danmakuOpacity;
    if (typeof value.volume === 'number' && Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 1) valid.volume = value.volume;
    if (typeof value.isMuted === 'boolean') valid.isMuted = value.isMuted;
    if (['0.75', '1.0', '1.25', '1.5', '2.0'].includes(value.playbackRate)) valid.playbackRate = value.playbackRate;
    if (['contain', 'cover'].includes(value.fitMode)) valid.fitMode = value.fitMode;
    return valid;
  }

  getPreferences() {
    this.reloadDiskStateIfNeeded();
    return { ...this.state.preferences };
  }

  updatePreferences(value) {
    const valid = this.validPreferences(value);
    if (!Object.keys(valid).length || Object.keys(valid).length !== Object.keys(value || {}).length) {
      throw Object.assign(new Error('无效的播放器设置'), { status: 400 });
    }
    return this.mutate(state => {
      const preferences = { ...state.preferences, ...valid };
      return { state: { ...state, preferences }, result: preferences };
    });
  }

  getSearchHistory() {
    this.reloadDiskStateIfNeeded();
    return [...this.state.searchHistory];
  }

  updateSearchHistory(action, value) {
    if (!['add', 'remove', 'clear'].includes(action) ||
        (action !== 'clear' && (typeof value !== 'string' || !value.trim() || value.trim().length > 200))) {
      throw Object.assign(new Error('无效的搜索历史'), { status: 400 });
    }
    const keyword = action === 'clear' ? '' : value.trim();
    return this.mutate(state => {
      const remaining = state.searchHistory.filter(item => item !== keyword);
      const searchHistory = action === 'clear' ? [] : action === 'add' ? [keyword, ...remaining].slice(0, 10) : remaining;
      return { state: { ...state, searchHistory }, result: searchHistory };
    });
  }

  /**
   * 记录/更新播放进度
   */
  updateProgress(item) {
    this.validateSeries(item);
    for (const field of ['episode_index', 'position_sec', 'duration_sec']) {
      const value = item[field];
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || (field === 'episode_index' && (!Number.isInteger(value) || value < 1)))) {
        throw Object.assign(new Error(`无效的 ${field}`), { status: 400 });
      }
    }
    const sid = String(item.series_id);
    const progress = {
      series_id: sid,
      series_title: item.series_title || '',
      cover: item.cover || '',
      episode_index: Number(item.episode_index) || 1,
      vid: String(item.vid || ''),
      position_sec: Number(item.position_sec) || 0,
      duration_sec: Number(item.duration_sec) || 0,
      watched_indexes: Array.isArray(item.watched_indexes) ? [...new Set(item.watched_indexes.filter(index => Number.isInteger(index) && index > 0))].slice(0, 10000) : [],
      updated_at: Date.now()
    };
    return this.mutate(state => ({ state: { ...state, history: { ...state.history, [sid]: progress } }, result: progress }));
  }

  /**
   * 获取观影历史（按更新时间倒序）
   */
  getHistory() {
    this.reloadDiskStateIfNeeded();
    return Object.values(this.state.history).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }

  /**
   * 获取单部剧集存储的历史进度
   */
  getSeriesProgress(seriesId) {
    if (!seriesId) return null;
    this.reloadDiskStateIfNeeded();
    return Object.hasOwn(this.state.history, String(seriesId)) ? this.state.history[String(seriesId)] : null;
  }

  /**
   * 切换收藏状态
   */
  toggleFavorite(series) {
    this.validateSeries(series);
    const sid = String(series.series_id);
    return this.mutate(state => {
      const favorites = { ...state.favorites };
      const exists = Object.hasOwn(favorites, sid);
      if (exists) delete favorites[sid];
      else favorites[sid] = {
        series_id: sid, series_title: series.series_title || '', cover: series.cover || '',
        episode_count: series.episode_count || series.total || 0, updated_at: Date.now()
      };
      return { state: { ...state, favorites }, result: !exists };
    });
  }

  /**
   * 获取所有收藏
   */
  getFavorites() {
    this.reloadDiskStateIfNeeded();
    return Object.values(this.state.favorites).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }

  /**
   * 判断单剧是否已收藏
   */
  isFavorite(seriesId) {
    this.reloadDiskStateIfNeeded();
    return Object.hasOwn(this.state.favorites, String(seriesId));
  }
}

module.exports = new StoreService();
