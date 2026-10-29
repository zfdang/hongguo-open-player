// SPDX-License-Identifier: GPL-3.0-only
const { signedMetadataRequest, requestJson } = require('./app-source');
const { cleanTitle, appCover } = require('./hongguo-app-search');
const logger = require('../services/logger');

const RANK_CELL_ID = '7470092475068071998';
const RANK_SELECTED = 'ranklist_celebrity';
const RANK_SUB_SELECTED = 'ranklist_series_actor';
const CACHE_TTL_MS = 900000; // 15分钟会话缓存
const WORKS_CACHE_TTL_MS = 300000; // 5分钟作品缓存
const TIMEOUT_MS = 15000;

const sessionsByLimit = new Map(); // `${limit}_${gender}` -> session object
const worksCache = new Map();

const KNOWN_FEMALE_ACTORS = new Set([
  '王志欣', '王小亿', '何雅馨', '至春禾', '张晋宜', '余茵', '郭宇欣', '董薇', '丁磊', '郇依心',
  '孟娜', '林秋奈', '羽翎', '马乐婕', '马秋元', '谭盐盐', '韩雨彤', '黄宁馨', '高子怡', '梁雯晶',
  '袁祎晴', '黎晟萱', '刘念', '袁子晶', '翟一莹', '贾翼瑄', '钟熙', '岳冬峰', '斯佳丽', '柴慧琴',
  '滕泽文', '孙芊芊', '许梦圆', '白方文', '赵夕汐', '申浩男', '柯淳', '鹿单东', '徐艺真', '赵佳',
  '张楚萱', '侯呈玥', '黄云云', '刘美娜', '邓灵枢', '孙艺燃', '严子贤', '孙樾', '曾辉', '舒童',
  '张嘉妤', '陈淑云', '李偌菡', '琪梵', '索菲', '天儿', '姜熙饶', '何雨桐', '方梨', '苏曼', '董洁',
  '涂蕊', '杨泽琳', '冯艺然', '周洛伊', '裴颤'
]);

const KNOWN_MALE_ACTORS = new Set([
  '王凯沐', '梁思伟', '张翅', '李世鑫', '卡戎', '程宇峰', '沉思', '蔡欣洋', '时康', '王皓祯',
  '代高政', '姚冠宇', '李柯以', '刘安歌', '刘润铭', '魏尊', '尤洋', '王培延', '马瑞泽', '陈俊儒',
  '魏华', '赵振栋', '刘萧旭', '皮德胜', '杜培源', '鞠振涛', '郭勐', '诸葛迪迪', '李芮', '杨泠铸',
  '徐金海', '孙明文', '任飞跃', '张子唯', '胡冬晴', '黄旭高', '曾祥羽', '徐成刚', '林琦婷', '蒋昕妍',
  '徐云龙', '王猛', '刘国际', '赵慧楠', '钟世岩', '张振宇', '徐卫龙', '王永新', '宋敬伟', '孙启鑫',
  '宋金阳', '孙一平', '董勋辉', '张震', '王嘉皓', '郑国锋', '李军', '徐大宁', '张正', '李京雨',
  '乔狄', '张铭祥', '户元松', '何红华', '冷海铭', '楚晓龙', '晟铭', '商泽华', '吴昊', '罗大涛',
  '刘昱辰', '王嘉禾', '陈宇星', '李腾', '叶新龙', '祝贺', '王梓豪', '余嘉政', '李治源', '艺丰',
  '张辉', '张海峰', '朱诗妤', '潘俊', '廖峰', '汪奇', '杨灿', '易浩铭', '六子', '谭鑫', '范少雄'
]);

function inferActorGender(actor) {
  if (!actor) return 'all';
  const name = actor.name || '';
  if (KNOWN_FEMALE_ACTORS.has(name)) return 'female';
  if (KNOWN_MALE_ACTORS.has(name)) return 'male';

  const text = `${actor.intro || ''} ${actor.sub_titles?.join(' ') || ''}`;
  if (/女演员|女艺人|女歌手|女模|女主角|内地女|中国女|她|小姐|姑娘|王妈|何娜娜|小郇同学/.test(text)) {
    return 'female';
  }
  if (/男演员|男艺人|男歌手|男模|男主角|内地男|中国男|他|先生|小生|身高/.test(text)) {
    return 'male';
  }
  return 'all';
}

function learnActorGender(name, intro) {
  if (!name || !intro) return;
  if (/女演员|女艺人|女歌手|女主角|内地女|中国女|她|小姐|姑娘/.test(intro)) {
    KNOWN_FEMALE_ACTORS.add(name);
  } else if (/男演员|男艺人|男歌手|男主角|内地男|中国男|他|先生|小生/.test(intro)) {
    KNOWN_MALE_ACTORS.add(name);
  }
}

function actorError(message, code = 'ACTOR_SCHEMA', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function clearActorSession() {
  sessionsByLimit.clear();
}

function clearWorksCache() {
  worksCache.clear();
}

function catalogCover(value) {
  const compatible = appCover(value);
  try {
    if (!value) return '';
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) &&
        /(^|\.)(fqnovelpic\.com|byteimg\.com)$/i.test(url.hostname) &&
        url.pathname.startsWith('/novel-pic/')) {
      const basePath = url.pathname.split('~', 1)[0].replace(/\.(heic|jpeg|jpg|png|webp)$/i, '');
      return `https://p3-novel.byteimg.com${basePath}~tplv-shrink:640:0.image`;
    }
    return compatible;
  } catch (_) {
    return compatible;
  }
}

function extractEpisodeCount(subTitle) {
  if (!subTitle || typeof subTitle !== 'string') return 0;
  const match = subTitle.match(/(\d+)\s*集/);
  return match ? parseInt(match[1], 10) : 0;
}

async function defaultRequest(signed, deadline) {
  return requestJson(signed.url, { method: 'GET', headers: signed.headers }, deadline);
}

function parseRankingPayload(payload, { pageNum = 1, pageLimit = 20, activeSession = null } = {}) {
  if (!payload || payload.code !== 0) {
    throw actorError(payload?.message || '获取剧星榜失败', 'ACTOR_UPSTREAM_ERROR', 502);
  }

  const cellView = payload.data?.cell_view;
  if (!cellView || !Array.isArray(cellView.cell_data)) {
    logger.error('HongguoActor', `剧星榜结构异常 raw=${JSON.stringify(payload).slice(0, 500)}`);
    throw actorError('剧星榜返回结构异常', 'ACTOR_SCHEMA_ERROR', 502);
  }

  // 严格校验选择器：确认服务端确实返回了剧星榜 (ranklist_series_actor)
  const outerSelected = cellView.cell_selector?.outer_row?.items?.find(i => i.is_selected);
  const subSelected = outerSelected?.sub_cell_selector?.outer_row?.items?.find(i => i.is_selected);
  if (outerSelected && outerSelected.selector_item_id && outerSelected.selector_item_id !== RANK_SELECTED) {
    throw actorError(`服务端未选中演员榜: ${outerSelected.selector_item_id}`, 'ACTOR_SELECTOR_MISMATCH', 502);
  }
  if (subSelected && subSelected.selector_item_id && subSelected.selector_item_id !== RANK_SUB_SELECTED) {
    throw actorError(`服务端未选中剧星榜 (当前: ${subSelected.selector_item_id})，不可用星光榜冒充`, 'ACTOR_SUB_SELECTOR_MISMATCH', 502);
  }

  // 解析统计日期
  let rankDate = '';
  if (cellView.cell_data_json) {
    try {
      const parsedJson = JSON.parse(cellView.cell_data_json);
      rankDate = parsedJson.rank_list_date || '';
    } catch (_) {}
  }
  if (!rankDate && activeSession?.rankDate) {
    rankDate = activeSession.rankDate;
  }

  // 解析 ugc_user_data
  const rawList = cellView.cell_data.flatMap(cell => cell.ugc_user_data || []);
  const actors = rawList.map((item, idx) => {
    const baseInfo = item.user_info?.base_info || {};
    const actorIdStr = String(baseInfo.actor_id_str || '');
    const userIdStr = String(item.user_info?.user_id || '');
    const name = cleanTitle(baseInfo.user_name || '');
    const avatar = catalogCover(baseInfo.user_avatar);
    const score = item.rec_text_item?.RecommendText || '';
    const intro = cleanTitle(item.intro || '');
    const subTitles = (item.sub_title_list || []).map(s => cleanTitle(s.content)).filter(Boolean);
    const changeData = item.rank_change_data || {};
    const gender = inferActorGender({ name, intro, sub_titles: subTitles });

    return {
      rank: (pageNum - 1) * pageLimit + idx + 1,
      actor_id: actorIdStr,
      user_id: userIdStr,
      name,
      avatar,
      gender,
      score,
      intro,
      sub_titles: subTitles,
      rank_change: {
        type: changeData.rank_change_type || 3, // 1: 升, 2: 降, 3: 平/新上榜
        num: changeData.ChangeNum || 0
      }
    };
  }).filter(a => a.actor_id && a.name);

  const hasMore = !!payload.data?.has_more;
  const nextOffset = payload.data?.next_offset;
  const sessionId = payload.data?.session_id || '';

  return {
    actors,
    rankDate,
    hasMore,
    nextOffset,
    sessionId
  };
}

function parseDetailPayload(payload, cleanId) {
  if (!payload || payload.code !== 0) {
    throw actorError(payload?.message || '获取演员主页失败', 'ACTOR_UPSTREAM_ERROR', 502);
  }

  const info = payload.data?.celebrity_info;
  if (!info) {
    throw actorError('未查询到该演员信息', 'ACTOR_NOT_FOUND', 404);
  }

  learnActorGender(info.nickname, info.intro);

  const related = (info.related_celebrities || []).map(r => ({
    actor_id: String(r.celebrity_id || ''),
    name: cleanTitle(r.nickname || ''),
    avatar: catalogCover(r.avatar),
    intro: cleanTitle(r.intro || '')
  })).filter(r => r.actor_id && r.name);

  return {
    success: true,
    actor: {
      actor_id: cleanId,
      name: cleanTitle(info.nickname || ''),
      avatar: catalogCover(info.avatar),
      intro: cleanTitle(info.intro || ''),
      celebrity_type: info.celebrity_type || 1,
      related_celebrities: related
    }
  };
}

function mapVideoToWork(v) {
  const seriesId = String(v.series_id || '');
  const title = cleanTitle(v.title || '');
  const cover = catalogCover(v.cover);
  const episodeCount = Number(v.episode_cnt) || extractEpisodeCount(v.sub_title);
  const subTitle = cleanTitle(v.sub_title || '');
  const recText = v.rec_text || '';
  const score = v.score || '';
  const desc = cleanTitle(v.video_desc || '');
  const duration = Number(v.duration) || 0;

  return {
    series_id: seriesId,
    series_title: title,
    cover,
    episode_count: episodeCount,
    sub_title: subTitle,
    rec_text: recText,
    score,
    description: desc,
    duration,
    source: 'hongguo'
  };
}

function parseWorksPayload(payload, cleanId, { reqOffset = 0, reqCount = 20 } = {}) {
  if (!payload || payload.code !== 0) {
    throw actorError(payload?.message || '获取演员作品失败', 'ACTOR_UPSTREAM_ERROR', 502);
  }

  const worksMap = payload.data?.works || {};
  const actorWorkData = worksMap[cleanId] || {};
  const rawVideos = Array.isArray(actorWorkData.video_list) ? actorWorkData.video_list : [];
  const totalCount = Number(actorWorkData.total_count) || rawVideos.length;

  // 上游 GET 接口未推进 offset 时，由服务层根据 reqOffset 切片推进分页
  const pagedVideos = rawVideos.slice(reqOffset, reqOffset + reqCount);

  const works = pagedVideos.map(mapVideoToWork).filter(w => w.series_id && w.series_title);
  const hasMore = (reqOffset + works.length < totalCount);

  return {
    success: true,
    actor_id: cleanId,
    works,
    total_count: totalCount,
    has_more: hasMore,
    offset: reqOffset,
    count: reqCount
  };
}

/**
 * 获取剧星榜（演员排行榜）
 * 严格按照分页会话链条递增推进，过期自动从第 1 页顺序重构游标，杜绝乱序与跳页标号错误。
 * @param {Object} [options]
 * @param {number} [options.page=1] - 页码 (1..20)
 * @param {number} [options.limit=20] - 每页条数
 * @param {Function} [options.request] - 自定义请求处理函数
 * @returns {Promise<Object>}
 */
async function fetchActorRankings({ page = 1, limit = 20, gender = 'all', request = defaultRequest } = {}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
  const validGender = ['male', 'female'].includes(String(gender).toLowerCase())
    ? String(gender).toLowerCase()
    : 'all';
  const now = Date.now();

  // 清理过期会话
  for (const [k, sess] of sessionsByLimit.entries()) {
    if (sess.expiresAt <= now) {
      sessionsByLimit.delete(k);
    }
  }

  const sessionKey = `${pageLimit}_${validGender}`;

  // 1. 性别分类筛选 (male / female) 模式
  if (validGender !== 'all') {
    let genderSession = sessionsByLimit.get(sessionKey);
    if (!genderSession || genderSession.expiresAt <= now) {
      genderSession = {
        limit: pageLimit,
        gender: validGender,
        expiresAt: Date.now() + CACHE_TTL_MS,
        pool: [],
        upstreamPage: 0,
        upstreamHasMore: true,
        rankDate: ''
      };
      sessionsByLimit.set(sessionKey, genderSession);
    }

    const neededCount = pageNum * pageLimit;
    while (genderSession.pool.length < neededCount && genderSession.upstreamHasMore) {
      const nextUpstreamPage = genderSession.upstreamPage + 1;
      let upstreamRes;
      try {
        upstreamRes = await fetchActorRankings({ page: nextUpstreamPage, limit: 50, gender: 'all', request });
      } catch (err) {
        if (err.code === 'ACTOR_PAGE_OVERFLOW' || err.code === 'ACTOR_SCHEMA_ERROR') {
          genderSession.upstreamHasMore = false;
          break;
        }
        throw err;
      }
      genderSession.upstreamPage = nextUpstreamPage;
      if (!genderSession.rankDate && upstreamRes.rank_date) {
        genderSession.rankDate = upstreamRes.rank_date;
      }
      if (!upstreamRes.actors || upstreamRes.actors.length === 0 || !upstreamRes.has_more) {
        genderSession.upstreamHasMore = false;
      }
      for (const actor of upstreamRes.actors) {
        if (actor.gender === validGender && !genderSession.pool.some(a => a.actor_id === actor.actor_id)) {
          genderSession.pool.push(actor);
        }
      }
    }

    const startIndex = (pageNum - 1) * pageLimit;
    const pageActors = genderSession.pool.slice(startIndex, startIndex + pageLimit);
    const hasMore = (genderSession.pool.length > startIndex + pageLimit) || genderSession.upstreamHasMore;

    if (pageNum > 1 && pageActors.length === 0) {
      throw actorError('已到达榜单末尾，无更多演员数据', 'ACTOR_PAGE_OVERFLOW', 400);
    }

    logger.info('HongguoActor', `成功获取剧星榜 (${validGender}): 第 ${pageNum} 页 (limit=${pageLimit}), 共 ${pageActors.length} 位演员, 统计截至=${genderSession.rankDate || '最新'}`);
    return {
      success: true,
      actors: pageActors,
      rank_date: genderSession.rankDate,
      page: pageNum,
      limit: pageLimit,
      gender: validGender,
      has_more: hasMore,
      total: pageActors.length
    };
  }

  // 2. 全部 (all) 模式
  let session = sessionsByLimit.get(sessionKey);

  // 2.1 命中对应条数 limit 的内存缓存直接返回
  if (session && session.expiresAt > now && session.pages.has(pageNum)) {
    const cached = session.pages.get(pageNum);
    logger.debug('HongguoActor', `命中剧星榜内存缓存: page=${pageNum}, limit=${pageLimit}`);
    return {
      success: true,
      actors: cached.actors,
      rank_date: cached.rankDate,
      page: pageNum,
      limit: pageLimit,
      gender: 'all',
      has_more: cached.hasMore,
      total: cached.actors.length,
      from_cache: true
    };
  }

  // 2.2 若请求第 2 页及以上，但该 limit 下的会话已失效或游标未链式推进至 pageNum，顺序重构从第 1 页至 pageNum-1
  if (pageNum > 1 && (!session || session.expiresAt <= now || !session.pageOffsets?.has(pageNum))) {
    if (!session || session.expiresAt <= now) {
      sessionsByLimit.delete(sessionKey);
    }
    logger.info('HongguoActor', `剧星榜会话未就绪或未推进至第 ${pageNum} 页 (limit=${pageLimit})，从第 1 页顺序建立分页游标`);
    for (let p = 1; p < pageNum; p++) {
      const stepRes = await fetchActorRankings({ page: p, limit: pageLimit, gender: 'all', request });
      if (!stepRes.has_more) {
        throw actorError('已到达榜单末尾，无更多演员数据', 'ACTOR_PAGE_OVERFLOW', 400);
      }
    }
    session = sessionsByLimit.get(sessionKey);
  }

  // 2.3 构建当前页请求参数
  let values;
  if (pageNum === 1 || !session) {
    values = {
      tab_type: '26',
      client_req_type: '2',
      client_template: '2',
      cell_id: RANK_CELL_ID,
      cell_sub_id: '0',
      selected_items: RANK_SELECTED,
      sub_selected_items: RANK_SUB_SELECTED,
      category_id: '0',
      gender: '2',
      limit: String(pageLimit),
      offset: '0',
      session_id: '',
      background_selected_items: '',
      panel_selected_items: '',
      filter_ids: '',
      unlimited_selector_change_type: '0'
    };
  } else {
    const currentOffset = session.pageOffsets?.get(pageNum);
    values = {
      tab_type: '18',
      client_req_type: '2',
      client_template: '2',
      cell_id: RANK_CELL_ID,
      cell_sub_id: '0',
      selected_items: RANK_SELECTED,
      sub_selected_items: RANK_SUB_SELECTED,
      category_id: '0',
      gender: '2',
      limit: String(pageLimit),
      offset: String(currentOffset !== undefined ? currentOffset : (pageNum - 1) * pageLimit),
      session_id: session.sessionId || '',
      background_selected_items: '',
      panel_selected_items: '',
      filter_ids: '',
      unlimited_selector_change_type: '0'
    };
  }

  const signed = signedMetadataRequest('/reading/bookapi/bookmall/cell/change/v', values);
  const payload = await request(signed, Date.now() + TIMEOUT_MS);

  const parsed = parseRankingPayload(payload, { pageNum, pageLimit, activeSession: session });
  const { actors, rankDate, hasMore, nextOffset, sessionId } = parsed;

  // 2.4 更新该 limit 的会话与游标映射
  if (!session || pageNum === 1) {
    session = {
      limit: pageLimit,
      gender: 'all',
      sessionId,
      nextOffset,
      rankDate,
      expiresAt: Date.now() + CACHE_TTL_MS,
      pages: new Map(),
      pageOffsets: new Map([[1, 0]])
    };
    sessionsByLimit.set(sessionKey, session);
  } else {
    session.nextOffset = nextOffset;
    if (sessionId) session.sessionId = sessionId;
  }
  if (nextOffset !== undefined) {
    session.pageOffsets.set(pageNum + 1, nextOffset);
  }
  session.pages.set(pageNum, { actors, rankDate, hasMore });

  logger.info('HongguoActor', `成功获取剧星榜: 第 ${pageNum} 页 (limit=${pageLimit}), 共 ${actors.length} 位演员, 统计截至=${rankDate || '最新'}`);
  return {
    success: true,
    actors,
    rank_date: rankDate,
    page: pageNum,
    limit: pageLimit,
    gender: 'all',
    has_more: hasMore,
    total: actors.length
  };
}

/**
 * 获取演员个人主页信息
 * @param {string} actorId - 演员 ID 字符串
 * @param {Object} [options]
 * @param {Function} [options.request] - 自定义请求处理函数
 * @returns {Promise<Object>}
 */
async function fetchActorDetail(actorId, { request = defaultRequest } = {}) {
  const cleanId = String(actorId || '').trim();
  if (!/^\d{1,30}$/.test(cleanId)) {
    throw actorError('无效的演员 ID', 'ACTOR_ID_INVALID', 400);
  }

  const signed = signedMetadataRequest('/reading/user/celebrity/homepage/v1/', {
    encrypted_celebrity_id: cleanId
  });

  const payload = await request(signed, Date.now() + TIMEOUT_MS);
  return parseDetailPayload(payload, cleanId);
}

/**
 * 获取演员参演短剧作品列表 (带分页游标推进与内存切片支持)
 * @param {string} actorId - 演员 ID 字符串
 * @param {Object} [options]
 * @param {number} [options.count=20] - 单次拉取数量
 * @param {number} [options.offset=0] - 偏移量
 * @param {Function} [options.request] - 自定义请求处理函数
 * @returns {Promise<Object>}
 */
async function fetchActorWorks(actorId, { count = 20, offset = 0, request = defaultRequest } = {}) {
  const cleanId = String(actorId || '').trim();
  if (!/^\d{1,30}$/.test(cleanId)) {
    throw actorError('无效的演员 ID', 'ACTOR_ID_INVALID', 400);
  }

  const reqCount = Math.max(1, Math.min(50, parseInt(count, 10) || 20));
  const reqOffset = Math.max(0, parseInt(offset, 10) || 0);

  // 检查演员作品内存缓存
  const cached = worksCache.get(cleanId);
  const now = Date.now();
  if (cached && cached.expiresAt > now && (
    cached.rawVideos.length >= reqOffset + reqCount ||
    !cached.hasMore ||
    cached.rawVideos.length >= cached.totalCount
  )) {
    const rawVideos = cached.rawVideos;
    const totalCount = cached.totalCount;
    const pagedVideos = rawVideos.slice(reqOffset, reqOffset + reqCount);
    const works = pagedVideos.map(mapVideoToWork).filter(w => w.series_id && w.series_title);
    return {
      success: true,
      actor_id: cleanId,
      works,
      total_count: totalCount,
      has_more: (reqOffset + works.length < totalCount),
      offset: reqOffset,
      count: reqCount,
      from_cache: true
    };
  }

  // 上游请求所需抓取的最大条数 (最小抓 40 条以减少翻页请求频次)
  const targetCount = Math.min(300, Math.max(reqOffset + reqCount, 40));
  const signed = signedMetadataRequest('/reading/user/celebrity/works/v1/', {
    encrypted_celebrity_ids: cleanId,
    offset: String(reqOffset),
    count: String(targetCount),
    req_scene: '0'
  });

  const payload = await request(signed, Date.now() + TIMEOUT_MS);
  if (!payload || payload.code !== 0) {
    throw actorError(payload?.message || '获取演员作品失败', 'ACTOR_UPSTREAM_ERROR', 502);
  }

  const worksMap = payload.data?.works || {};
  const actorWorkData = worksMap[cleanId] || {};
  const rawVideos = Array.isArray(actorWorkData.video_list) ? actorWorkData.video_list : [];
  const totalCount = Number(actorWorkData.total_count) || rawVideos.length;
  const hasMore = !!actorWorkData.has_more && rawVideos.length < totalCount;

  // 写入作品内存缓存
  worksCache.set(cleanId, {
    rawVideos,
    totalCount,
    hasMore,
    expiresAt: now + WORKS_CACHE_TTL_MS
  });

  return parseWorksPayload(payload, cleanId, { reqOffset, reqCount });
}

module.exports = {
  fetchActorRankings,
  fetchActorDetail,
  fetchActorWorks,
  parseRankingPayload,
  parseDetailPayload,
  parseWorksPayload,
  clearActorSession,
  clearWorksCache,
  catalogCover,
  extractEpisodeCount
};
