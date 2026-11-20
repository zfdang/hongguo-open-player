// SPDX-License-Identifier: GPL-3.0-only
// 红果账号服务：官网扫码登录 + 登录态下的播放/点赞/预约记录、相关作品与预约提交。
// 协议证据（均为公开仓库源码，非官方授权接口，随时可能变更）：
//   - 扫码登录流程：jackotom/hongguo-player src/native/account-session.js（Web passport，
//     hongguoduanju.com，无 x-argus 签名，Cookie jar + CSRF 由官网自身下发）；
//   - 账号接口签名：jackotom signedAccountRequest（GET 72232）+ N3urda/hongguoTV
//     CloudAccount.kt（写请求 73932/7.3.9.32、gzip、x-ss-stub）；
//   - 记录端点与解析：N3urda CloudAccount.kt / HGTV Account.kt（read_progress 为主，
//     read_history 对短剧可能恒空，仅作回退）；
//   - 相关作品：N3urda ContentRepository.kt related()（/reading/bookapi/plan/v:version/，
//     content_type 1007=待上线可预约）+ RelatedWorks.kt（show_type 547 cell）。
// 纪律：任何失败都转成中文 notice，不向路由抛原始异常；日志与错误文本不得携带
// sessionid / sid_tt / CSRF 等凭据。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const logger = require('../services/logger');
const { signedAccountRequest } = require('./app-source');
const { getPlaybackDevice } = require('./playback-device');

const WEB_BASE = 'https://hongguoduanju.com';
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WEB_QUERY = {
  aid: '513755', passport_jssdk_version: '3.4.10', passport_jssdk_type: 'normal',
  account_sdk_source: 'web', is_from_ttaccountsdk: '1', language: 'zh',
};
const API_HOST = 'api5-normal-sinfonlinea.fqnovel.com';
const RELATED_HOSTS = ['api5-normal-sinfonlinec.fqnovel.com', 'api5-normal-hl.fqnovel.com', 'api5-normal-lf.fqnovel.com'];
const REQUEST_TIMEOUT = 15000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// 大整数字段（vid/series_id 等 19 位）必须在 JSON.parse 前转为字符串，否则丢精度。
const BIG_INT_FIELD = /("(?:vid|video_id|item_id|book_id|series_id|group_id|user_id|biz_user_id)"\s*:\s*)(\d{16,})/g;

const str = value => (value === null || value === undefined ? '' : String(value)).trim();
const digits = value => str(value).replace(/[^\d]/g, '');

function parseApiJson(raw) {
  return JSON.parse(String(raw).replace(BIG_INT_FIELD, '$1"$2"'));
}

/** 秒/毫秒自适应：小于 1e12 视为秒。仅用于 epoch 时间戳，不用于播放进度。 */
function toMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
}

/** 播放进度/时长字段上游恒为毫秒，直接取整，不做秒/毫秒猜测。 */
const plainMs = value => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
};

/**
 * 封面归一：账号接口（预约/点赞/收藏/multi-detail）下发的封面是 fqnovelpic 的
 * HEIC 格式，浏览器/Chromium 无法解码（实测 naturalWidth=0）。同一图片在 byteimg
 * 公共 CDN 上有无需签名的 JPEG 版本（剧场封面即用此格式）。提取图片 hash 重建为
 * byteimg 地址即可正常显示；已是 byteimg 或其它格式则原样保留。
 */
function normalizeCover(url) {
  const text = str(url);
  if (!text) return '';
  const match = text.match(/\/novel-pic\/([0-9a-f]{32})/i);
  if (match && /fqnovelpic\.com|\.heic/i.test(text)) {
    return `https://p3-novel.byteimg.com/novel-pic/${match[1]}~tplv-shrink:640:0.image`;
  }
  return text;
}

function isWebHost(hostname) {
  return hostname === 'hongguoduanju.com' || hostname.endsWith('.hongguoduanju.com');
}

/** 脱敏：错误/日志文本中不得出现凭据与完整签名 URL。 */
function safeMessage(error) {
  const text = str(error?.message || error);
  return text
    .replace(/https?:\/\/[^\s"']+/g, '[url]')
    .replace(/(sessionid(?:_ss)?|sid_tt|sid_guard|uid_tt(?:_ss)?|passport_csrf_token|d_ticket)=[^;\s"']+/gi, '$1=[redacted]')
    .slice(0, 200);
}

// ── Cookie jar（登录态唯一载体；官网与 App 接口共用同一份凭据） ──────────────
class CookieJar {
  constructor(now = Date.now) { this.map = new Map(); this.now = now; }
  absorb(setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
    for (const raw of list) {
      const parts = String(raw).split(';');
      const pair = parts[0].trim();
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expiresAt = null;
      for (const attr of parts.slice(1)) {
        const [key, ...rest] = attr.trim().split('=');
        const val = rest.join('=').trim();
        if (/^max-age$/i.test(key)) {
          const seconds = Number(val);
          if (Number.isFinite(seconds)) expiresAt = seconds <= 0 ? -1 : this.now() + seconds * 1000;
        }
      }
      if (expiresAt === -1 || !value) { this.map.delete(name); continue; }
      this.map.set(name, { value, expiresAt });
    }
  }
  prune() {
    const now = this.now();
    for (const [name, entry] of this.map) if (entry.expiresAt && entry.expiresAt <= now) this.map.delete(name);
  }
  cookieString() {
    this.prune();
    return [...this.map.entries()].map(([name, entry]) => `${name}=${entry.value}`).join('; ');
  }
  get(name) { this.prune(); return this.map.get(name)?.value || ''; }
  hasSession() { return Boolean(this.get('sessionid') || this.get('sessionid_ss')); }
  snapshot() { this.prune(); return Object.fromEntries([...this.map.entries()].map(([name, entry]) => [name, entry.value])); }
  restore(cookies) {
    this.map.clear();
    if (cookies && typeof cookies === 'object') {
      for (const [name, value] of Object.entries(cookies)) if (str(value)) this.map.set(name, { value: str(value), expiresAt: null });
    }
  }
  clear() { this.map.clear(); }
  /** sid_guard = "sessionid|签发秒|max-age秒|…"（可能 URL 编码），过期=签发+max-age。 */
  sessionExpiresAt() {
    const guard = this.get('sid_guard');
    if (!guard) return 0;
    const parts = decodeURIComponent(guard).split('|');
    const issued = Number(parts[1]);
    const maxAge = Number(parts[2]);
    if (!Number.isFinite(issued) || !Number.isFinite(maxAge) || issued <= 0 || maxAge <= 0) return 0;
    return (issued + maxAge) * 1000;
  }
}

// ── 凭据存储（0o600 原子写；Electron 下可选 safeStorage 加密） ────────────────
function resolveSafeStorage() {
  // 必须在 Electron 主进程内才尝试：普通 Node 下 require('electron') 会触发
  // 二进制下载（spawnSync install.js），离线/被墙环境会长时间挂起。
  if (!process.versions.electron) return null;
  try {
    const electron = require('electron');
    if (electron && typeof electron.safeStorage?.isEncryptionAvailable === 'function' && electron.safeStorage.isEncryptionAvailable()) {
      return electron.safeStorage;
    }
  } catch (_) { /* 服务器模式无 Electron */ }
  return null;
}

function createCredentialStore(dataDir, now = Date.now) {
  const file = path.join(dataDir, 'account_session.json');
  const safeStorage = resolveSafeStorage();
  return {
    file,
    encrypted: Boolean(safeStorage),
    load() {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      const envelope = JSON.parse(raw);
      let json;
      if (envelope?.encrypted) {
        if (!safeStorage) throw Object.assign(new Error('凭据已加密但当前环境无法解密'), { code: 'CREDENTIAL_LOCKED' });
        json = safeStorage.decryptString(Buffer.from(envelope.data, 'base64')).toString('utf8');
      } else {
        json = envelope?.data;
      }
      const payload = typeof json === 'string' ? JSON.parse(json) : json;
      if (!payload || typeof payload !== 'object' || !payload.cookies) return null;
      return payload;
    },
    save(payload) {
      fs.mkdirSync(dataDir, { recursive: true });
      const json = JSON.stringify({ ...payload, saved_at: now() });
      const envelope = safeStorage
        ? { version: 1, encrypted: true, data: safeStorage.encryptString(json).toString('base64') }
        : { version: 1, encrypted: false, data: json };
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      try { fs.copyFileSync(file, `${file}.bak`); fs.chmodSync(`${file}.bak`, 0o600); } catch (_) { /* 首次无备份 */ }
      fs.renameSync(temp, file);
    },
    remove() {
      for (const target of [file, `${file}.bak`, `${file}.tmp`]) {
        try { fs.rmSync(target, { force: true }); } catch (_) { /* 忽略 */ }
      }
    },
  };
}

// ── 服务工厂 ────────────────────────────────────────────────────────────────
function createAccountService(options = {}) {
  const now = options.now || Date.now;
  const dataDir = options.dataDir || require('../services/storeService').dataDir;
  const store = options.store || createCredentialStore(dataDir, now);
  const webTransport = options.webTransport || axios;
  const apiTransport = options.apiTransport || axios;
  const identityProvider = options.identityProvider || (async () => {
    const device = await getPlaybackDevice(require('./app-source').requestJson);
    return { device_id: str(device.device_id), iid: str(device.iid), cdid: str(device.cdid), cookie: str(device.cookie) };
  });

  const jar = new CookieJar(now);
  let credentials = null; // {cookies, user:{user_id,name}, device?, expires_at}
  let pendingLogin = null; // {token, expireAt}
  let restored = false;

  function restore() {
    if (restored) return;
    restored = true;
    try {
      const payload = store.load();
      if (payload?.cookies) {
        jar.restore(payload.cookies);
        credentials = payload;
      }
    } catch (error) {
      logger.warn('Account', `登录凭据读取失败: ${safeMessage(error)}`);
      credentials = null;
    }
  }

  function persist() {
    if (!credentials) return;
    credentials = { ...credentials, cookies: jar.snapshot(), expires_at: jar.sessionExpiresAt() || credentials.expires_at || 0 };
    try { store.save(credentials); } catch (error) {
      logger.warn('Account', `登录凭据保存失败: ${safeMessage(error)}`);
    }
  }

  // ── 官网 Web 传输（手动重定向 + host 白名单 + Cookie 吸收） ──
  async function webRequest(url, { maxHops = 5 } = {}) {
    let current = url;
    for (let hop = 0; hop <= maxHops; hop++) {
      const target = new URL(current);
      if (target.protocol !== 'https:' || !isWebHost(target.hostname)) {
        throw Object.assign(new Error('登录跳转指向了不受信任的站点'), { code: 'SECURITY_BLOCKED' });
      }
      const response = await webTransport({
        url: current, method: 'GET',
        headers: {
          'User-Agent': WEB_UA, Accept: 'application/json, text/plain, */*',
          Referer: `${WEB_BASE}/`, Origin: WEB_BASE, Cookie: jar.cookieString(),
        },
        timeout: REQUEST_TIMEOUT, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        maxRedirects: 0, responseType: 'text', transformResponse: [data => data],
        validateStatus: () => true, maxContentLength: MAX_RESPONSE_BYTES,
      });
      jar.absorb(response.headers?.['set-cookie']);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.location;
        if (!location) throw Object.assign(new Error('登录跳转缺少目标地址'), { code: 'INVALID_RESPONSE' });
        current = new URL(location, current).href;
        continue;
      }
      return { status: response.status, data: response.data, url: current };
    }
    throw Object.assign(new Error('登录跳转次数过多'), { code: 'SECURITY_BLOCKED' });
  }

  async function webJson(apiPath, params = {}) {
    const query = new URLSearchParams({ ...WEB_QUERY, ...params }).toString();
    const response = await webRequest(`${WEB_BASE}${apiPath}?${query}`);
    if (response.status !== 200) throw Object.assign(new Error(`官网接口返回 HTTP ${response.status}`), { code: 'INVALID_RESPONSE' });
    let payload;
    try { payload = JSON.parse(response.data); } catch (_) {
      throw Object.assign(new Error('官网接口返回了非 JSON 内容'), { code: 'INVALID_RESPONSE' });
    }
    return payload;
  }

  // ── App 接口传输（登录 Cookie 显式携带，不复用 requestJson 的匿名注入） ──
  async function apiRequest(apiPath, values = {}, { payload = null, gzip = false, host = API_HOST } = {}) {
    restore();
    const identity = credentials?.device && /^\d{1,30}$/.test(str(credentials.device.device_id))
      ? credentials.device
      : await identityProvider();
    const signed = signedAccountRequest(apiPath, values, identity, { payload, gzip, host });
    const cookieParts = [str(identity.cookie), jar.cookieString()].filter(Boolean);
    const response = await apiTransport({
      url: signed.url, method: payload !== null ? 'POST' : 'GET',
      headers: { ...signed.headers, Cookie: cookieParts.join('; ') },
      data: signed.body || undefined,
      timeout: REQUEST_TIMEOUT, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      maxRedirects: 0, responseType: 'text', transformResponse: [data => data],
      validateStatus: () => true, maxContentLength: MAX_RESPONSE_BYTES, maxBodyLength: MAX_RESPONSE_BYTES,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      throw Object.assign(new Error('账号接口发生不支持的跳转'), { code: 'SECURITY_BLOCKED' });
    }
    if (response.status !== 200) throw Object.assign(new Error(`账号接口返回 HTTP ${response.status}`), { code: 'INVALID_RESPONSE', status: response.status });
    const raw = typeof response.data === 'string' ? response.data : '';
    if (!raw.trim()) throw Object.assign(new Error('账号接口返回空响应（可能登录态或签名失效）'), { code: 'EMPTY_RESPONSE' });
    let parsed;
    try { parsed = parseApiJson(raw); } catch (_) {
      throw Object.assign(new Error('账号接口返回了非 JSON 内容'), { code: 'INVALID_RESPONSE' });
    }
    const code = Number(parsed?.code ?? parsed?.Code ?? parsed?.status_code ?? 0);
    if (code !== 0) {
      throw Object.assign(new Error(`账号接口拒绝请求（code=${code}）`), { code: 'BUSINESS_REJECTED', businessCode: code });
    }
    return parsed;
  }

  const needLogin = () => ({ success: false, need_login: true, items: [], notice: '请先扫码登录红果账号', error: '' });
  const fail = notice => ({ success: false, items: [], notice, error: notice });

  function loggedIn() { restore(); return jar.hasSession(); }

  // ── 扫码登录 ──
  async function startLogin() {
    restore();
    try {
      const payload = await webJson('/passport/web/get_qrcode/', { next: `${WEB_BASE}/` });
      const data = payload?.data || payload || {};
      const token = str(data.token);
      let qrcode = str(data.qrcode || data.qrcode_url);
      if (!token || !qrcode) return fail('官网未返回有效二维码，请稍后重试');
      if (!qrcode.startsWith('data:') && !qrcode.startsWith('http')) qrcode = `data:image/png;base64,${qrcode}`;
      const rawExpire = Number(data.expire_time);
      let expireAt;
      if (Number.isFinite(rawExpire) && rawExpire > 1e12) expireAt = rawExpire;
      else if (Number.isFinite(rawExpire) && rawExpire > 1e9) expireAt = rawExpire * 1000;
      else expireAt = now() + Math.min(Math.max(rawExpire || 180, 30), 600) * 1000;
      pendingLogin = { token, expireAt };
      return { success: true, token, qrcode, expire_at: expireAt, notice: '' };
    } catch (error) {
      logger.warn('Account', `获取登录二维码失败: ${safeMessage(error)}`);
      return fail('获取登录二维码失败，请检查网络后重试');
    }
  }

  async function finishRedirect(redirectUrl) {
    if (!str(redirectUrl)) throw Object.assign(new Error('扫码确认缺少跳转地址'), { code: 'INVALID_RESPONSE' });
    await webRequest(redirectUrl, { maxHops: 5 });
  }

  async function pollLogin(token) {
    restore();
    if (!pendingLogin || str(token) !== pendingLogin.token) return fail('二维码会话无效，请刷新二维码');
    if (now() > pendingLogin.expireAt) { pendingLogin = null; return { success: true, status: 'expired', notice: '二维码已过期，请刷新' }; }
    try {
      const payload = await webJson('/passport/web/check_qrconnect/', { next: `${WEB_BASE}/`, token: pendingLogin.token });
      const data = payload?.data || payload || {};
      // 官网返回文字状态：new / scanned / confirmed / expired / canceled（也兼容数字 1/2/3/5）。
      const status = str(data.status ?? payload?.status).toLowerCase();
      if (status === '5' || status === 'expired') { pendingLogin = null; return { success: true, status: 'expired', notice: '二维码已过期，请刷新' }; }
      if (status === '4' || status === 'canceled') { pendingLogin = null; return { success: true, status: 'expired', notice: '扫码已取消，请刷新二维码' }; }
      if (status !== '3' && status !== 'confirmed') {
        return { success: true, status: 'pending', scanned: status === '2' || status === 'scanned', notice: '' };
      }
      await finishRedirect(str(data.redirect_url));
      if (!jar.hasSession()) return fail('扫码已确认，但未获得登录凭据，请重试');
      let user = { user_id: '', name: '' };
      try {
        const info = await webJson('/passport/account/info/v2/', {});
        const infoData = info?.data || info || {};
        user = { user_id: str(infoData.user_id_str || infoData.user_id), name: str(infoData.name || infoData.screen_name || infoData.username) };
      } catch (error) {
        logger.warn('Account', `登录态验证失败（凭据已保存）: ${safeMessage(error)}`);
      }
      credentials = { cookies: jar.snapshot(), user, expires_at: jar.sessionExpiresAt(), saved_at: now() };
      persist();
      pendingLogin = null;
      logger.info('Account', `扫码登录成功: user_id=${user.user_id || '(未知)'}`);
      return { success: true, status: 'confirmed', user, notice: '' };
    } catch (error) {
      // 登录未成功：回滚 jar，避免失败流程吸收的 Cookie 污染登录态判定。
      jar.restore(credentials?.cookies || {});
      logger.warn('Account', `扫码登录轮询失败: ${safeMessage(error)}`);
      return fail('登录确认失败，请刷新二维码后重试');
    }
  }

  function logout() {
    restore();
    jar.clear();
    credentials = null;
    pendingLogin = null;
    try { store.remove(); } catch (error) { logger.warn('Account', `清除凭据失败: ${safeMessage(error)}`); }
    return { success: true, notice: '已退出登录' };
  }

  function status() {
    restore();
    const expiresAt = jar.sessionExpiresAt() || credentials?.expires_at || 0;
    const expired = Boolean(expiresAt && now() > expiresAt);
    return {
      success: true,
      logged_in: jar.hasSession(),
      user: credentials?.user || null,
      expires_at: expiresAt,
      expired,
      storage_encrypted: store.encrypted,
      notice: !jar.hasSession() ? '' : expired ? '登录态已过期，请重新扫码登录' : '',
    };
  }

  // ── 账号资料（含匿名降级判定） ──
  async function profile() {
    if (!loggedIn()) return needLogin();
    try {
      const payload = await apiRequest('/reading/user/info/v1/', {});
      const data = payload?.data || {};
      const bizUserId = str(data.biz_user_id);
      const userName = str(data.user_name || data.name);
      // 无效 sessionid 不报错而是降级为匿名账号：biz_user_id 空 / 未设置用户名 / 默认"用户xxxxxx"
      const anonymous = !bizUserId || data.has_set_username === false || /^用户\d{6,}$/.test(userName);
      return {
        success: true, anonymous,
        user: { user_id: bizUserId || str(data.user_id), name: userName, avatar: str(data.avatar_url || data.avatar) },
        notice: anonymous ? '当前登录态被服务端视为匿名账号，请先在官方红果 App 登录一次后再试' : '',
      };
    } catch (error) {
      logger.warn('Account', `账号资料获取失败: ${safeMessage(error)}`);
      return fail('账号资料获取失败，请稍后重试');
    }
  }

  // ── 记录解析（导出供单测） ──
  function mapProgressRow(row) {
    if (!row || typeof row !== 'object') return null;
    const seriesId = digits(row.series_id || row.book_id || row.book_id_str);
    if (!seriesId) return null;
    // 点赞/收藏的 video_data 只有分集 title（宣传文案），剧名在 video_detail.series_title。
    const detail = row.video_detail && typeof row.video_detail === 'object' ? row.video_detail : {};
    return {
      series_id: seriesId,
      vid: digits(row.vid),
      title: str(row.series_title || detail.series_title || row.book_name),
      cover: normalizeCover(row.series_cover_url || row.cover || row.thumb_url || detail.series_cover_url),
      episode_index: Math.max(1, Number(row.vid_index) || 1),
      episode_count: Math.max(0, Number(row.episode_count || row.episode_cnt || detail.episode_cnt) || 0),
      position_ms: plainMs(row.current_play_time ?? row.current_play_position),
      duration_ms: plainMs(row.current_total_time ?? row.duration),
      watched_at: toMs(row.last_watch_time ?? row.read_timestamp_ms ?? row.last_min_read_timestamp_ms),
    };
  }

  function extractMultiDetail(payload) {
    const data = payload?.data;
    const rows = Array.isArray(data) ? data
      : Array.isArray(data?.book_data) ? data.book_data
      : data && typeof data === 'object' ? Object.values(data).filter(v => v && typeof v === 'object' && !Array.isArray(v)) : [];
    const map = new Map();
    for (const row of rows) {
      const id = digits(row?.book_id || row?.series_id);
      if (id) map.set(id, { title: str(row.book_name || row.series_title), cover: normalizeCover(row.thumb_url || row.series_cover_url || row.cover), episode_count: Number(row.episode_cnt) || 0, abstract: str(row.abstract) });
    }
    return map;
  }

  async function enrichTitles(items) {
    const missing = [...new Set(items.filter(item => !item.title && item.series_id).map(item => item.series_id))].slice(0, 50);
    if (!missing.length) return items;
    try {
      const payload = await apiRequest('/reading/bookapi/multi-detail/v1/', { book_id: missing.join(','), book_type: '2' });
      const map = extractMultiDetail(payload);
      for (const item of items) {
        const extra = map.get(item.series_id);
        if (!extra) continue;
        if (!item.title) item.title = extra.title;
        if (!item.cover) item.cover = extra.cover;
        if (!item.episode_count) item.episode_count = extra.episode_count;
      }
    } catch (error) {
      logger.warn('Account', `剧集元数据补充失败: ${safeMessage(error)}`);
    }
    return items;
  }

  async function history() {
    if (!loggedIn()) return needLogin();
    try {
      let items = [];
      let source = 'read_progress';
      const payload = await apiRequest('/reading/bookapi/read_progress/list/v1/', { book_types: '2', limit: '50' });
      const data = payload?.data || {};
      // read_progress/list 的 video_data 实测在响应顶层（亦兼容 data / data.data 嵌套）。
      const rows = Array.isArray(payload?.video_data) ? payload.video_data
        : Array.isArray(data.video_data) ? data.video_data
        : Array.isArray(data.data?.video_data) ? data.data.video_data : [];
      items = rows.map(mapProgressRow).filter(Boolean);
      if (!items.length) {
        // 回退：jackotom 的 read_history 端点（HGTV 实测其对短剧可能恒空，故仅作回退）
        source = 'read_history';
        const fallback = await apiRequest('/reading/bookapi/read_history/list/v1/', {
          book_type: '2', limit: '0', offset: '0', last_min_read_timestamp_ms: '0',
          full_field: 'true', is_first_load: 'true', query_soft_deleted: 'false',
        });
        const list = Array.isArray(fallback?.data?.data_list) ? fallback.data.data_list : [];
        items = list.filter(row => row && !row.is_delete).map(mapProgressRow).filter(Boolean);
      }
      await enrichTitles(items);
      items.sort((a, b) => b.watched_at - a.watched_at);
      return { success: true, items, source, notice: items.length ? '' : '暂无云端播放记录', error: '' };
    } catch (error) {
      logger.warn('Account', `播放记录获取失败: ${safeMessage(error)}`);
      return fail('播放记录获取失败，请稍后重试');
    }
  }

  async function likes() {
    if (!loggedIn()) return needLogin();
    try {
      const payload = await apiRequest('/reading/ugc/action/mget/v1/', { action_type: '3', object_type_list: '6,15,10', count: '50', offset: '0' });
      const rows = Array.isArray(payload?.data?.mixed_data_list) ? payload.data.mixed_data_list : [];
      const items = [];
      for (const row of rows) {
        const video = row?.video_data || row?.book_data;
        const mapped = mapProgressRow(video);
        if (!mapped) continue;
        mapped.liked_at = toMs(video?.user_digg_timestamp_ms ?? row.user_digg_timestamp_ms ?? row.create_time);
        mapped.position_ms = 0;
        mapped.duration_ms = 0;
        items.push(mapped);
      }
      await enrichTitles(items);
      items.sort((a, b) => b.liked_at - a.liked_at);
      return { success: true, items, notice: items.length ? '' : '暂无点赞记录', error: '' };
    } catch (error) {
      logger.warn('Account', `点赞记录获取失败: ${safeMessage(error)}`);
      return fail('点赞记录获取失败，请稍后重试');
    }
  }

  // 收藏记录：App「我的收藏」真实走视频书架 bookshelf/video/info/v1/（data.video_shelf_info，
  // 剧集级条目）；ugc action mget 是互动流水，与 App 书架不一致。协议证据：
  // N3urda/hongguoTV CloudAccount.kt favorites/parseFavorites（源 HGTV AccountParser.favorites）。
  async function favorites() {
    if (!loggedIn()) return needLogin();
    try {
      const payload = await apiRequest('/reading/bookapi/bookshelf/video/info/v1/', {});
      const rows = Array.isArray(payload?.data?.video_shelf_info) ? payload.data.video_shelf_info : [];
      const items = [];
      const seen = new Set();
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const video = row.video_data && typeof row.video_data === 'object' ? row.video_data : row;
        const seriesId = digits(video.series_id || row.series_id || row.book_id);
        const title = str(row.series_title || video.title || row.book_name);
        if (!seriesId || !title || seen.has(seriesId)) continue;
        seen.add(seriesId);
        items.push({
          series_id: seriesId,
          vid: '',
          title,
          cover: normalizeCover(row.series_cover_url || video.cover || video.cover_url || video.thumb_url || row.thumb_url),
          episode_index: 1,
          episode_count: Math.max(0, Number(video.episode_cnt || video.episode_count || row.episode_cnt) || 0),
          position_ms: 0,
          duration_ms: 0,
          favorited_at: toMs(row.collect_time),
        });
      }
      await enrichTitles(items);
      items.sort((a, b) => b.favorited_at - a.favorited_at);
      return { success: true, items, notice: items.length ? '' : '暂无收藏记录', error: '' };
    } catch (error) {
      logger.warn('Account', `收藏记录获取失败: ${safeMessage(error)}`);
      return fail('收藏记录获取失败，请稍后重试');
    }
  }

  function mapSubscribeItem(item, upcoming) {
    if (!item || typeof item !== 'object') return null;
    // 已上线：嵌套在 subscribe_data（含 vid/series_id/video_detail）；未上线：扁平字段（name/cover/item_desc）。
    const nested = (item.subscribe_data && typeof item.subscribe_data === 'object') ? item.subscribe_data
      : (item.video_data && typeof item.video_data === 'object') ? item.video_data : null;
    const video = nested || item;
    const detail = video.video_detail && typeof video.video_detail === 'object' ? video.video_detail : {};
    const seriesId = digits(video.series_id || video.book_id || detail.series_id || item.item_id);
    const title = str(detail.series_title || video.series_title || video.title || video.book_name || video.name || item.name || item.title);
    const cover = normalizeCover(video.cover || video.series_cover_url || video.thumb_url || detail.series_cover_url || item.cover);
    return {
      series_id: seriesId,
      reservation_id: seriesId ? `reservation:${seriesId}` : '',
      title: title || '预约内容',
      cover,
      abstract: str(video.video_desc || detail.series_intro || video.series_intro || item.item_desc || item.abstract),
      episode_count: Number(video.episode_cnt || video.episode_count || detail.episode_cnt) || 0,
      upcoming,
      content_type: Number(video.content_type) || (upcoming ? 1007 : 1004),
      publish_at: toMs(item.schedule_publish_time || item.expected_publish_time || video.schedule_publish_time),
      reserved_at: toMs(item.subscribe_time || item.create_time),
    };
  }

  async function reserves() {
    if (!loggedIn()) return needLogin();
    try {
      const items = [];
      for (const isOnline of ['true', 'false']) {
        // 上游分页契约（实测 2026-11-18）：has_more=true 时以 next_offset 续拉，
        // 每页 limit=20；2000 条封顶防异常死循环
        let offset = 0;
        for (let page = 0; page < 100; page++) {
          const payload = await apiRequest('/reading/user/subscribe/list/v0/', {
            offset: String(offset), limit: '20', is_online: isOnline, tab_type: '13', subscribe_order_type: '0',
            swipe_type: '0', need_calendar_schema: 'false', subscribe_offset: '0',
          });
          const data = payload?.data || {};
          const rows = data.subscribe_items;
          // null 表示该类别为空，不是错误
          if (!Array.isArray(rows)) break;
          for (const row of rows) {
            const mapped = mapSubscribeItem(row, isOnline === 'false');
            if (mapped && (mapped.series_id || mapped.title)) items.push(mapped);
          }
          if (!data.has_more || rows.length === 0) break;
          offset = Number(data.next_offset) || (offset + rows.length);
        }
      }
      items.sort((a, b) => (a.upcoming === b.upcoming ? b.reserved_at - a.reserved_at : a.upcoming ? -1 : 1));
      return { success: true, items, notice: items.length ? '' : '暂无预约记录', error: '' };
    } catch (error) {
      logger.warn('Account', `预约记录获取失败: ${safeMessage(error)}`);
      return fail('预约记录获取失败，请稍后重试');
    }
  }

  // ── 相关作品（下一季来源；匿名也可调用） ──
  async function related(seriesId) {
    const id = digits(seriesId);
    if (!/^\d{6,30}$/.test(id)) return fail('剧集编号无效');
    const values = {
      scene: '10', from: 'detail_page_more_related', book_id: id, new_search_middle_page: 'false',
      bookstore_tab_type: '0', query_history_removed: 'false', user_is_login: '0', bookstore_tab: '0',
      search_middle_page_version: '0', pad_column_detail: '0', hot_word_exchange: 'false', device_level: '3',
      limit: '0', offset: '0', is_horizontal_screen: 'false', reader_single_col_from_ip_strategy: 'false',
    };
    let lastError = null;
    for (const host of RELATED_HOSTS) {
      try {
        const payload = await apiRequest('/reading/bookapi/plan/v:version/', values, { host });
        const data = payload?.data;
        const cells = Array.isArray(data) ? data : Array.isArray(data?.cells) ? data.cells : Array.isArray(data?.data) ? data.data : [];
        const items = [];
        const seen = new Set();
        for (const cell of cells) {
          if (!cell || typeof cell !== 'object') continue;
          if (Number(cell.show_type) !== 547 && !str(cell.cell_name).includes('相关作品')) continue;
          const rows = Array.isArray(cell.video_data) ? cell.video_data : Array.isArray(cell.data?.video_data) ? cell.data.video_data : [];
          for (const row of rows) {
            const rowId = digits(row?.series_id || row?.book_id);
            if (!rowId || seen.has(rowId) || rowId === id) continue;
            seen.add(rowId);
            const contentType = Number(row.content_type);
            items.push({
              series_id: rowId,
              title: str(row.series_title || row.video_detail?.series_title || row.title || row.book_name),
              cover: normalizeCover(row.cover || row.series_cover_url || row.thumb_url),
              abstract: str(row.video_desc || row.abstract),
              episode_count: Number(row.episode_cnt) || 0,
              content_type: Number.isFinite(contentType) ? contentType : 0,
              upcoming: contentType === 1007,
              season_label: str(row.tag_info?.text) || (row.season_index ? `第${row.season_index}季` : ''),
              disable_play: Boolean(row.disable_play),
            });
          }
        }
        return { success: true, items, notice: items.length ? '' : '暂无相关作品', error: '' };
      } catch (error) {
        lastError = error;
        logger.warn('Account', `相关作品获取失败(host=${host}): ${safeMessage(error)}`);
      }
    }
    return fail('相关作品获取失败，请稍后重试');
  }

  // ── 预约提交（写操作，仅由用户 UI 主动触发） ──
  async function reserve(seriesId) {
    if (!loggedIn()) return needLogin();
    const id = digits(seriesId);
    if (!/^\d{6,30}$/.test(id)) return fail('剧集编号无效');
    try {
      // item_id 为 19 位大整数：手工拼 JSON 保留精确数字，不能经 Number 序列化。
      const rawBody = `{"item_id":${id},"item_type":3,"op_type":1,"subscribe_source":0}`;
      await apiRequest('/reading/bookapi/search/uncover_subscribe/v1/', {}, { payload: rawBody, gzip: true });
      // code=0 只是回执，回读预约列表确认才算成功（N3urda CloudAccount 实测纪律）。
      let confirmed = false;
      try {
        const list = await reserves();
        confirmed = Boolean(list.success && list.items.some(item => item.series_id === id));
      } catch (_) { /* 回读失败不影响提交回执 */ }
      logger.info('Account', `预约提交: series_id=${id}, confirmed=${confirmed}`);
      return {
        success: true, confirmed, series_id: id,
        notice: confirmed ? '预约成功，上线后将收到提醒' : '预约已提交，但列表中暂未确认，请稍后在预约记录中查看',
        error: '',
      };
    } catch (error) {
      logger.warn('Account', `预约提交失败: ${safeMessage(error)}`);
      return fail('预约提交失败，请稍后重试');
    }
  }

  // 点赞写入：ugc/action/set/v1/（action_type 3/4，object_id 为分集 vid），与 App「点赞」mget 数据源一致。
  // 收藏写入：App「我的收藏」是视频书架，必须走 bookshelf/video/update/v1/（剧集级 book_id）；
  // 写 ugc action 1/2 只进互动流水、不进 App 书架。协议证据：N3urda/hongguoTV
  // CloudAccount.kt setFavorite / CloudFavoriteActionsTest（shark_extra 仅加、group_name 仅消）。
  async function setSocialAction({ vid, seriesId, actionType }) {
    if (!loggedIn()) return { success: false, need_login: true, error: '请先扫码登录红果账号' };
    const type = Number(actionType);
    if (![1, 2, 3, 4].includes(type)) return { success: false, error: '互动请求参数无效' };
    if (type === 1 || type === 2) {
      const bookId = digits(seriesId);
      if (!/^\d{6,30}$/.test(bookId)) return { success: false, error: '互动请求参数无效' };
      const add = type === 1;
      const entry = { book_id: bookId, book_type: 2, modify_time: Date.now(), video_shelf_operate_type: add ? 0 : 1 };
      if (!add) entry.group_name = '';
      const body = { is_cancelled: false, update_bookshelf_video_list: [entry] };
      if (add) {
        body.shark_extra = {
          enter_from: 'MainFragmentActivity', previous_page: '', page_list: 'MainFragmentActivity',
          is_active_behavior: 'true', inactive_type: '0',
        };
      }
      try {
        await apiRequest('/reading/bookapi/bookshelf/video/update/v1/', {}, { payload: JSON.stringify(body), gzip: false });
        // code=0 只是回执，回读书架确认才算成功（与预约同一纪律）。
        let confirmed = false;
        try {
          const list = await favorites();
          confirmed = Boolean(list.success && list.items.some(item => item.series_id === bookId)) === add;
        } catch (_) { /* 回读失败不影响提交回执 */ }
        logger.info('Account', `收藏写入: series_id=${bookId}, add=${add}, confirmed=${confirmed}`);
        return {
          success: true, confirmed, series_id: bookId, error: '',
          notice: confirmed ? '' : '操作已提交，但书架暂未确认，请稍后在收藏记录中查看',
        };
      } catch (error) {
        if (error?.businessCode === 101045) return { success: true, error: '', notice: '该操作已生效' };
        logger.warn('Account', `收藏写入失败(at=${type}): ${safeMessage(error)}`);
        return { success: false, error: '操作失败，请稍后重试' };
      }
    }
    const id = digits(vid);
    if (!/^\d{6,30}$/.test(id)) return { success: false, error: '互动请求参数无效' };
    try {
      await apiRequest('/reading/ugc/action/set/v1/', {}, {
        payload: JSON.stringify({ action_type: type, object_type: 6, object_id: id }),
        gzip: false,
      });
      return { success: true, error: '' };
    } catch (error) {
      // 重复添加（101045）视为已生效，幂等处理不当作失败。
      if (error?.businessCode === 101045) return { success: true, error: '', notice: '该操作已生效' };
      logger.warn('Account', `互动写入失败(at=${type}): ${safeMessage(error)}`);
      return { success: false, error: '操作失败，请稍后重试' };
    }
  }

  // 播放进度云端上报：read_progress/upload/v1/，write_mode=1 同时写进度与历史（官方 App 播放记录可见）。
  // 字段名与单位必须精确：毫秒、vid_index 从 1 起、book_id/item_id 用字符串防 19 位精度丢失；
  // 用 series_id/vid 等错误键名会假成功 code=0 但实际不写。
  async function reportProgress({ seriesId, vid, episodeIndex, positionSec, durationSec, episodeCount }) {
    if (!loggedIn()) return { success: false, need_login: true, error: '请先扫码登录红果账号' };
    const bookId = digits(seriesId);
    const itemId = digits(vid);
    const index = Number(episodeIndex);
    if (!/^\d{6,30}$/.test(bookId) || !/^\d{6,30}$/.test(itemId) || !Number.isInteger(index) || index < 1) {
      return { success: false, error: '播放上报参数无效' };
    }
    const posMs = Math.max(0, Math.round((Number(positionSec) || 0) * 1000));
    const totalMs = Math.max(0, Math.round((Number(durationSec) || 0) * 1000));
    const rate = totalMs > 0 ? Math.min(1, posMs / totalMs).toFixed(4) : '0';
    const book = {
      book_id: bookId,
      item_id: itemId,
      vid_index: index,
      current_play_time: posMs,
      current_total_time: totalMs,
      read_timestamp_ms: Date.now(),
      book_type: 2,
      progress_rate: rate,
      player_cumulative_total_duration: posMs,
    };
    const count = Number(episodeCount);
    if (Number.isInteger(count) && count > 0) book.episode_count = count;
    try {
      await apiRequest('/reading/bookapi/read_progress/upload/v1/', {}, {
        payload: JSON.stringify({ books: [book], write_mode: 1 }),
        gzip: false,
      });
      return { success: true, error: '' };
    } catch (error) {
      logger.warn('Account', `播放进度上报失败: ${safeMessage(error)}`);
      return { success: false, error: '播放记录同步失败，请稍后重试' };
    }
  }

  return {
    startLogin, pollLogin, logout, status, profile,
    history, likes, favorites, reserves, related, reserve, setSocialAction, reportProgress,
    loggedIn,
    // 测试与复用需要的内部件
    _jar: jar, _apiRequest: apiRequest, _webJson: webJson,
    mapProgressRow, mapSubscribeItem, extractMultiDetail, normalizeCover,
  };
}

let singleton = null;
function getAccountService() {
  if (!singleton) singleton = createAccountService();
  return singleton;
}
/** 仅供测试：重置单例。 */
function resetAccountService() { singleton = null; }

module.exports = {
  createAccountService, getAccountService, resetAccountService,
  CookieJar, parseApiJson, toMs, safeMessage, isWebHost, normalizeCover,
  WEB_BASE, WEB_QUERY, API_HOST, RELATED_HOSTS,
};