// 首页「推荐」feed：App 首页单列推荐，首屏 bookmall/tab/v1/（tab_type=16），
// 服务端开启单列无限流（bottom_unlimited + client_template=7）后改走 cell/change/v1/ 续刷。
// 协议证据：N3urda/hongguoTV RecommendationFeed.kt（参数、cellFlow 提取、响应归一化与去重收敛）。
const { signedMetadataRequest, requestJson, parseSearchInteger } = require('./app-source');
const { catalogCover } = require('./hongguo-app-catalog');
const { cleanTitle } = require('./hongguo-app-search');

const TAB_API = '/reading/bookapi/bookmall/tab/v1/';
const CELL_API = '/reading/bookapi/bookmall/cell/change/v1/';
const SITE = 'https://hongguoduanju.com';
const TIMEOUT_MS = 12000;
const FEED_RESPONSE_LIMIT = 16 * 1024 * 1024;
const MAX_BATCH_TRIES = 3;   // 单轮内重复批最多尝试次数（has_more=false 仍可能下发新卡）
const MAX_ROUNDS = 3;        // 会话重置轮数上限，避免无限刷
const MAX_SEEN = 2000;
const FILTER_IDS_LIMIT = 200; // filter_ids 只带最近看过的 ID，避免查询串过长

const appError = (message, code = 'APP_SCHEMA') => Object.assign(new Error(message), { code });
const state = { session: '', offset: 0, cellFlow: null, seen: new Set(), queue: [] };
let pending = Promise.resolve();

function resetRecommend() {
  state.session = '';
  state.offset = 0;
  state.cellFlow = null;
  state.seen.clear();
  state.queue.length = 0;
}

function restartSession() {
  state.session = '';
  state.offset = 0;
  state.cellFlow = null;
}

function rememberSeen(id) {
  state.seen.add(id);
  if (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.values().next().value);
}

/** tab_type=16 的 tab 节点；续刷响应先归一化成同构再解析。 */
function feedTab(payload) {
  if (!payload || typeof payload !== 'object' || Number(payload.code) !== 0) {
    throw appError(`推荐暂不可用（错误码 ${Number(payload?.code ?? -1)}）`, 'APP_BUSINESS');
  }
  const tabs = payload?.data?.tab_item;
  const tab = Array.isArray(tabs) ? tabs.find(item => String(item?.tab_type) === '16') : null;
  if (!tab) throw appError('推荐数据格式已变化');
  return tab;
}

/** 只接受服务端明确启用且标识完整的单列续刷上下文。 */
function discoverCellFlow(tab) {
  if (tab.bottom_unlimited !== true || Number(tab.client_template) !== 7) return null;
  const firstCell = Array.isArray(tab.cell_data) ? tab.cell_data[0] : null;
  const cellId = String(firstCell?.cell_id_str || firstCell?.cell_id || '');
  const planId = String(tab.bookstore_id || '');
  const versionTag = String(tab.version_tag || '');
  if (!/^[1-9]\d{0,29}$/.test(cellId) || !/^[1-9]\d{0,29}$/.test(planId)
    || !versionTag || versionTag.length > 4096 || /[\r\n\0]/.test(versionTag)) return null;
  return { cellId, planId, versionTag };
}

/** 展平 cell_data→cell_data→video_data，归一化成目录卡片结构。 */
function parseFeed(payload) {
  let source = payload;
  // 续刷响应：data.cell_view 包一层，归一化成 tab 结构复用同一解析。
  if (payload?.data?.cell_view && !Array.isArray(payload?.data?.tab_item)) {
    const view = payload.data.cell_view;
    const cell = Array.isArray(view.cell_data) ? view : { cell_data: [view] };
    source = { code: 0, data: { tab_item: [{ tab_type: 16, session_id: payload.data.session_id, cell_data: [cell] }] } };
  }
  const tab = feedTab(source);
  const session = String(tab.session_id || '');
  if (session.length > 4096 || /[\r\n\0]/.test(session)) throw appError('推荐分页标记无效');
  const rows = (Array.isArray(tab.cell_data) ? tab.cell_data : []).flatMap(cell =>
    (Array.isArray(cell?.cell_data) ? cell.cell_data : []).flatMap(card =>
      (Array.isArray(card?.video_data) ? card.video_data : []).map(video => video?.video_detail || video)));
  const items = [];
  const seenHere = new Set();
  for (const row of rows) {
    const id = String(row?.series_id || row?.book_id || '');
    const title = cleanTitle(row?.series_title || row?.book_name || row?.title);
    if (!/^\d{1,24}$/.test(id) || !title || seenHere.has(id) || state.seen.has(id)) continue;
    seenHere.add(id);
    items.push({
      series_id: id, series_title: title,
      cover: catalogCover(String(row?.series_cover || row?.cover || '')),
      episode_count: parseSearchInteger(row?.episode_cnt) || 0,
      description: cleanTitle(row?.series_intro || row?.video_desc),
      tags: Array.isArray(row?.sub_title_list) ? row.sub_title_list.map(item => cleanTitle(item?.content)).filter(Boolean).slice(0, 4) : [],
      source: 'hongguo', url: `${SITE}/detail?series_id=${id}`
    });
  }
  return { items, session, rawCount: rows.length, cellFlow: discoverCellFlow(tab) };
}

async function fetchBatch() {
  const flow = state.cellFlow;
  const values = {
    tab_type: '16', bottom_tab_type: '7', landing_bottom_tab_type: '7',
    offset: String(state.offset), client_req_type: state.offset === 0 ? '1' : '2'
  };
  if (state.session) values.session_id = state.session;
  if (flow) {
    values.cell_id = flow.cellId;
    values.plan_id = flow.planId;
    values.version_tag = flow.versionTag;
    values.client_template = '7';
    values.change_type = '0';
    values.client_req_type = '2';
    values.filter_ids = [...state.seen].slice(-FILTER_IDS_LIMIT).join(',');
  }
  const signed = signedMetadataRequest(flow ? CELL_API : TAB_API, values);
  // feed 响应里 series_id/book_id/vid 是 19 位数字字面量，必须防精度丢失（丢精度会变成 ...000，查分集必 404）
  const payload = await requestJson(signed.url, {
    method: 'GET', headers: signed.headers, maxContentLength: FEED_RESPONSE_LIMIT,
    jsonGuardKeys: ['series_id', 'book_id', 'vid', 'item_id'],
  }, Date.now() + TIMEOUT_MS);
  const parsed = parseFeed(payload);
  state.session = parsed.session || state.session;
  state.offset += parsed.rawCount;
  // 续刷上下文只在首屏 tab 响应里发现一次；后续沿用。
  if (!flow && parsed.cellFlow) state.cellFlow = parsed.cellFlow;
  return parsed.items;
}

async function doGetNext() {
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      for (let attempt = 0; attempt < MAX_BATCH_TRIES; attempt += 1) {
        if (state.queue.length) {
          const item = state.queue.shift();
          return { success: true, item };
        }
        let items;
        try {
          items = await fetchBatch();
        } catch (error) {
          // 110 一类旧会话校验拒绝：丢掉 session/offset 从头拉一次（与参考实现一致）。
          if (state.session && (error.code === 'APP_BUSINESS' || error.code === 'APP_SCHEMA')) {
            restartSession();
            continue;
          }
          throw error;
        }
        for (const item of items) { rememberSeen(item.series_id); state.queue.push(item); }
        if (items.length) {
          const item = state.queue.shift();
          return { success: true, item };
        }
      }
      // 整轮都是重复卡：重置服务端会话再试（本地 seen 继续去重）。
      restartSession();
    }
    return { success: false, error: '推荐暂时刷不出新内容，请稍后再试' };
  } catch (error) {
    const message = /TIMEOUT|ETIMEDOUT|ECONNABORTED/.test(error.code || '') ? '推荐加载超时，请重试'
      : error.code?.startsWith('APP_') ? error.message : '推荐网络请求失败，请稍后重试';
    return { success: false, error: message };
  }
}

/** 每次返回一部未看过的推荐剧；并发请求串行化，避免游标竞态。 */
function nextRecommend() {
  const task = pending.then(doGetNext);
  pending = task.catch(() => {});
  return task;
}

module.exports = { nextRecommend, resetRecommend, parseFeed };