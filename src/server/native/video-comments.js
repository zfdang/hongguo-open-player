// SPDX-License-Identifier: GPL-3.0-only
// 视频评论列表（只读）。与弹幕共用 comment/list 端点与签名族（danmaku-sign.js，73532），
// 区别只在业务参数成套切换：comment_source=4 / server_channel=18 / comment_type=4，
// 请求头 Comment-Source / Server-Channel 必须同步为 4 / 18（601/1000 是弹幕专用通道）。
// 参数与字段路径经本机实证（参考 N3urda/hongguoTV AppCommentPages.kt）。
'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const sign = require('./danmaku-sign');
const { resolveDeviceIdentity } = require('./danmaku');

const BASE_URL = 'https://api5-normal-sinfonlineb.fqnovel.com';
const COMMENT_PATH = vid => `/novel/commentapi/comment/list/${encodeURIComponent(vid)}/v1/`;
// 写接口：点赞走 do_action（action_type 8/9，object_type=2 评论/回复通用）。
// 回复列表走 reply/list。端点路由按 (comment_source, aid) 匹配 handler——
// 经实扫（2026-11-18，扫描 source 0..3000）短剧评论回复页 source=504 才有 handler
// 并能返回真实回复（与 reply_count 一致，分页正常）；参考实现的 501 是书评通道，在
// aid=8662 上返回「cannot found handler」。
// 写请求依据 naiyQAQ/fanqie-assistant 抓包实证：登录态 Cookie 必带，body 参与 X-Argus 哈希。
const DO_ACTION_PATH = '/novel/commentapi/comment/do_action/v1/';
const REPLY_LIST_PATH = commentId => `/novel/commentapi/reply/list/${encodeURIComponent(commentId)}/v1/`;
const REPLY_LIST_SOURCE = 504;
const USER_AGENT =
  'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; ' +
  'Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';

const PAGE_COUNT = 20;
const REQUEST_TIMEOUT = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const str = value => (value === null || value === undefined ? '' : String(value)).trim();
const toMs = value => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
};

// comment_id / user_id 等 19 位大整数先转字符串，避免 JSON.parse 丢精度。
function parseCommentJson(raw) {
  const guarded = String(raw).replace(/("(?:comment_id|user_id|id|reply_id|parent_id)"\s*:\s*)(\d{16,})/g, '$1"$2"');
  return JSON.parse(guarded);
}

function buildCommentBody(vid, seriesId, cursor = '') {
  return {
    comment_source: 4,
    server_channel: 18,
    group_id: vid,
    group_type: 30,
    comment_type: 4,
    sort: 1,
    need_count: true,
    count: PAGE_COUNT,
    cursor: typeof cursor === 'string' ? cursor : '',
    aid: 8662,
    compliance_status: 0,
    business_param: { book_id: seriesId, req_type: 0 },
  };
}

function mapComment(raw) {
  const comment = raw?.comment;
  if (!comment || typeof comment !== 'object') return null;
  const common = comment.common && typeof comment.common === 'object' ? comment.common : {};
  if (Number(common.status) !== 1) return null; // 仅展示正常状态的评论
  const content = common.content && typeof common.content === 'object' ? common.content : {};
  const baseInfo = common.user_info?.base_info || {};
  const stat = comment.stat && typeof comment.stat === 'object' ? comment.stat : {};
  const action = comment.user_action && typeof comment.user_action === 'object' ? comment.user_action : {};
  const text = str(content.text);
  if (!text) return null;
  return {
    comment_id: str(comment.comment_id),
    text,
    user_name: str(baseInfo.user_name) || '红果用户',
    user_avatar: str(baseInfo.user_avatar),
    digg_count: Number(stat.digg_count) || 0,
    reply_count: Number(stat.reply_count) || 0,
    liked: Boolean(action.user_digg),
    created_at: toMs(common.create_timestamp),
  };
}

/**
 * 拉取一页视频评论。
 * @returns {Promise<{success:boolean, items:Array, total:number, has_more:boolean, cursor:string, notice:string, error:string}>}
 */
async function fetchVideoComments(options = {}) {
  const base = { success: false, items: [], total: 0, has_more: false, cursor: '', notice: '', error: '' };
  const vid = str(options.vid);
  const seriesId = str(options.seriesId);
  if (!/^\d{6,30}$/.test(vid) || !/^\d{6,30}$/.test(seriesId)) {
    return { ...base, notice: '仅红果来源的剧集支持查看评论' };
  }
  const transport = options.transport || axios.post;
  const now = options.now || Date.now;
  const random = options.random || crypto.randomBytes;
  try {
    const stampMs = now();
    const stamp = Math.floor(stampMs / 1000);
    const nonce = random(sign.NONCE_BYTES);
    const { deviceId, installId } = options.device || await resolveDeviceIdentity();
    const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
    const url = `${BASE_URL}${COMMENT_PATH(vid)}?${rawQuery}`;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'X-XS-From-Web': '0',
      'Sdk-Version': '2',
      'Content-Type': 'application/json; charset=utf-8',
      'Comment-Source': '4',
      'Server-Channel': '18',
      ...sign.signCommentHeaders({ rawQuery, stamp, nonce }),
    };
    const response = await transport(url, JSON.stringify(buildCommentBody(vid, seriesId, options.cursor)), {
      headers,
      timeout: REQUEST_TIMEOUT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      maxRedirects: 0,
      responseType: 'text',
      maxContentLength: MAX_RESPONSE_BYTES,
    });
    const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
    let payload;
    try { payload = parseCommentJson(raw); } catch (_) {
      return { ...base, notice: '评论接口返回了非 JSON 内容' };
    }
    const code = Number(payload?.code ?? payload?.Code ?? -1);
    if (code !== 0) return { ...base, notice: `评论接口拒绝请求（code=${code}）` };
    const data = payload?.data || {};
    const list = Array.isArray(data.data_list) ? data.data_list : [];
    const items = list.map(mapComment).filter(Boolean);
    const info = data.common_list_info && typeof data.common_list_info === 'object' ? data.common_list_info : {};
    const total = Number(info.total) || 0;
    const hasMore = Boolean(info.has_more);
    const cursor = typeof info.cursor === 'string' ? info.cursor : (info.cursor ? JSON.stringify(info.cursor) : '');
    return { success: true, items, total, has_more: hasMore, cursor, notice: items.length || total ? '' : '暂无评论', error: '' };
  } catch (error) {
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError' || error?.code === 'ERR_CANCELED'
      ? '评论加载超时，请稍后重试'
      : '评论加载失败，请检查网络后重试';
    return { ...base, notice, error: notice };
  }
}

// ── 写操作（点赞 / 回复）：登录态 Cookie 必带，body 参与 X-Argus 哈希 ──────────

/**
 * 已签名的 commentapi 写请求。与列表共用签名族；区别：
 *   - body 必须传入 signCommentHeaders（X-Argus 字段 13 = sm3(body)）；
 *   - X-SS-STUB 填 body 的 MD5（TTNet 对带 body 的 POST 的标准校验）；
 *   - 携带账号登录态 Cookie（sessionid），缺了上游回 code=103006 未登录。
 */
async function postCommentWrite(path, body, { cookie, transport, now, random, device } = {}) {
  const transportFn = transport || axios.post;
  const stampMs = (now || Date.now)();
  const stamp = Math.floor(stampMs / 1000);
  const nonce = (random || crypto.randomBytes)(sign.NONCE_BYTES);
  const { deviceId, installId } = device || await resolveDeviceIdentity();
  const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
  const rawBody = JSON.stringify(body);
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'X-XS-From-Web': '0',
    'Sdk-Version': '2',
    'Content-Type': 'application/json; charset=utf-8',
    'Comment-Source': '4',
    'Server-Channel': '18',
    ...sign.signCommentHeaders({ rawQuery, stamp, nonce, body: rawBody }),
    // signCommentHeaders 恒置空 X-SS-STUB，写请求需覆写为 body 的 MD5
    'X-SS-STUB': sign.md5(Buffer.from(rawBody, 'utf8')).toString('hex'),
    ...(cookie ? { Cookie: cookie } : {}),
  };
  const response = await transportFn(`${BASE_URL}${path}?${rawQuery}`, rawBody, {
    headers,
    timeout: REQUEST_TIMEOUT,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    maxRedirects: 0,
    responseType: 'text',
    maxContentLength: MAX_RESPONSE_BYTES,
  });
  const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
  let payload;
  try { payload = parseCommentJson(raw); } catch (_) {
    throw Object.assign(new Error('评论接口返回了非 JSON 内容'), { businessCode: -1 });
  }
  const code = Number(payload?.code ?? payload?.Code ?? -1);
  if (code !== 0) {
    throw Object.assign(new Error(`评论接口拒绝请求（code=${code}）`), { businessCode: code });
  }
  return payload?.data || {};
}

function commentWriteGuard({ vid, seriesId, commentId, cookie }) {
  if (!/^\d{6,30}$/.test(str(vid)) || !/^\d{6,30}$/.test(str(seriesId))) return '仅红果来源的剧集支持评论互动';
  if (!/^\d{6,30}$/.test(str(commentId))) return '评论编号无效';
  if (!str(cookie)) return '请先扫码登录红果账号';
  return '';
}

/**
 * 评论点赞 / 取消点赞（object_type=2 评论与回复通用）。
 * @returns {Promise<{success:boolean, digg_count?:number, notice:string, error:string}>}
 */
async function likeVideoComment(options = {}) {
  const base = { success: false, notice: '', error: '' };
  const guard = commentWriteGuard(options);
  if (guard) return { ...base, notice: guard };
  const liked = Boolean(options.liked);
  try {
    await postCommentWrite(DO_ACTION_PATH, {
      action_type: liked ? 8 : 9,
      business_param: {},
      comment_type: 4,
      object_id: str(options.commentId),
      object_type: 2,
    }, { cookie: str(options.cookie), transport: options.transport, now: options.now, random: options.random, device: options.device });
    return { success: true, notice: liked ? '' : '已取消点赞', error: '' };
  } catch (error) {
    const business = Number(error?.businessCode);
    if (business === 103006) return { ...base, notice: '登录态已失效，请重新扫码登录' };
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError'
      ? '点赞请求超时，请稍后重试'
      : '点赞失败，请稍后重试';
    return { ...base, notice, error: notice };
  }
}

/**
 * 某条评论下的回复列表（只读，匿名可调用）。
 * @returns {Promise<{success:boolean, items:Array, total:number, has_more:boolean, cursor:string, notice:string, error:string}>}
 */
async function fetchCommentReplies(options = {}) {
  const base = { success: false, items: [], total: 0, has_more: false, cursor: '', notice: '', error: '' };
  const vid = str(options.vid);
  const seriesId = str(options.seriesId);
  const commentId = str(options.commentId);
  const cursor = str(options.cursor);
  if (!/^\d{6,30}$/.test(vid) || !/^\d{6,30}$/.test(seriesId) || !/^\d{6,30}$/.test(commentId)) {
    return { ...base, notice: '仅红果来源的评论支持查看回复' };
  }
  const transport = options.transport || axios.post;
  const now = options.now || Date.now;
  const random = options.random || crypto.randomBytes;
  try {
    const stampMs = now();
    const stamp = Math.floor(stampMs / 1000);
    const nonce = random(sign.NONCE_BYTES);
    const { deviceId, installId } = options.device || await resolveDeviceIdentity();
    const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
    const url = `${BASE_URL}${REPLY_LIST_PATH(commentId)}?${rawQuery}`;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'X-XS-From-Web': '0',
      'Sdk-Version': '2',
      'Content-Type': 'application/json; charset=utf-8',
      ...sign.signCommentHeaders({ rawQuery, stamp, nonce }),
    };
    const response = await transport(url, JSON.stringify({
      business_param: { book_id: seriesId, need_count: true },
      comment_id: commentId,
      comment_source: REPLY_LIST_SOURCE,
      comment_type: 4,
      count: PAGE_COUNT,
      group_id: vid,
      group_type: 30,
      ...(cursor ? { cursor } : {}),
    }), {
      headers,
      timeout: REQUEST_TIMEOUT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      maxRedirects: 0,
      responseType: 'text',
      maxContentLength: MAX_RESPONSE_BYTES,
    });
    const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
    let payload;
    try { payload = parseCommentJson(raw); } catch (_) {
      return { ...base, notice: '回复接口返回了非 JSON 内容' };
    }
    const code = Number(payload?.code ?? payload?.Code ?? -1);
    if (code !== 0) return { ...base, notice: `回复接口拒绝请求（code=${code}）` };
    const data = payload?.data || {};
    const list = Array.isArray(data.reply_list) ? data.reply_list : [];
    const items = list.map(mapReply).filter(Boolean);
    const info = data.comment_list_info && typeof data.comment_list_info === 'object' ? data.comment_list_info : {};
    return {
      success: true,
      items,
      total: Number(info.total) || items.length,
      has_more: Boolean(info.has_more),
      cursor: str(info.cursor),
      notice: items.length ? '' : '暂无回复',
      error: '',
    };
  } catch (error) {
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError' || error?.code === 'ERR_CANCELED'
      ? '回复加载超时，请稍后重试'
      : '回复加载失败，请检查网络后重试';
    return { ...base, notice, error: notice };
  }
}

function mapReply(raw) {
  // 一级评论的 common 键为小写，回复为大写 Common（服务端历史不一致），两边都试
  const common = raw?.common && typeof raw.common === 'object' ? raw.common
    : (raw?.Common && typeof raw.Common === 'object' ? raw.Common : {});
  const content = common.content && typeof common.content === 'object' ? common.content : {};
  const baseInfo = common.user_info?.base_info || {};
  const stat = raw?.stat && typeof raw.stat === 'object' ? raw.stat : {};
  const replyToUser = raw?.reply_to_user_info?.base_info || {};
  const replyId = str(raw?.reply_id);
  const text = str(content.text);
  if (!replyId || !text) return null;
  // 楼中楼：回复目标是另一条回复时，补「回复 @某人」前缀
  const toReplyId = str(raw?.reply_to_reply_id);
  const toUserName = str(replyToUser.user_name);
  const displayText = toReplyId && toReplyId !== '0' && toUserName
    ? `回复 @${toUserName}：${text}`
    : text;
  return {
    reply_id: replyId,
    text: displayText,
    user_name: str(baseInfo.user_name) || '红果用户',
    user_avatar: str(baseInfo.user_avatar),
    digg_count: Number(stat.digg_count) || 0,
    created_at: toMs(common.create_timestamp),
  };
}

module.exports = {
  fetchVideoComments, fetchCommentReplies, likeVideoComment,
  buildCommentBody, mapComment, mapReply, parseCommentJson, postCommentWrite,
  BASE_URL, COMMENT_PATH, DO_ACTION_PATH, REPLY_LIST_PATH, REPLY_LIST_SOURCE, USER_AGENT, PAGE_COUNT,
};