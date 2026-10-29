// SPDX-License-Identifier: GPL-3.0-only
const hg = require('../native/hongguo');
const hgSearch = require('../native/hongguo-search');
const hgAppSearch = require('../native/hongguo-app-search');
const hgCatalog = require('../native/hongguo-app-catalog');
const hgActor = require('../native/hongguo-actor');
const appSource = require('../native/app-source');
const logger = require('./logger');

class DramaService {
  constructor() {
    this.searchSessions = new Map();
  }

  /**
   * 搜索短剧
   */
  async search(keyword, page = 1) {
    if (keyword === undefined || keyword === '') {
      return { results: [], total: 0, page: 1, hasMore: false };
    }
    if (typeof keyword !== 'string' || keyword.trim().length > 80) {
      throw Object.assign(new Error('搜索词需为 1 至 80 字的文本'), { status: 400 });
    }
    page = Number(page);
    if (!Number.isInteger(page) || page < 1 || page > 50) {
      throw Object.assign(new Error('页码需为 1 至 50 的整数'), { status: 400 });
    }
    const cleanKw = keyword.trim();
    if (!cleanKw) return { results: [], total: 0, page, hasMore: false };
    const t0 = Date.now();
    logger.info('DramaService', `开始搜索短剧 keyword="${cleanKw}", page=${page}`);
    try {
      const res = await hgSearch.searchHongguo(cleanKw, { page });
      if (res && Array.isArray(res.results) && res.success !== false) {
        logger.info('DramaService', `Web端搜索成功 keyword="${cleanKw}": 返回 ${res.results.length} 部短剧, 耗时 ${Date.now() - t0}ms`);
        return res;
      }
    } catch (e) {
      logger.warn('DramaService', `Web端搜索失败，尝试回退至App端搜索: ${e.message}`);
    }

    // 回退到 App 端搜索
    try {
      let session = this.searchSessions.get(cleanKw);
      if (page === 1 || !session || session.expires <= Date.now()) {
        session = { expires: Date.now() + 120000, cursors: new Map() };
        this.searchSessions.delete(cleanKw);
        this.searchSessions.set(cleanKw, session);
        if (this.searchSessions.size > 30) this.searchSessions.delete(this.searchSessions.keys().next().value);
      }
      const appRes = await hgAppSearch.searchApp(cleanKw, { page, cursor: session.cursors.get(page) });
      if (appRes?.hasMore && appRes.cursor) session.cursors.set(page + 1, appRes.cursor);
      logger.info('DramaService', `App端搜索完成 keyword="${cleanKw}": 返回 ${appRes?.results?.length || 0} 部短剧, 耗时 ${Date.now() - t0}ms`);
      return appRes || { results: [], total: 0, page: 1, hasMore: false };
    } catch (e) {
      logger.error('DramaService', `App端搜索失败 keyword="${cleanKw}": ${e.message}`);
      return { results: [], total: 0, page: 1, hasMore: false, error: e.message };
    }
  }

  /**
   * 浏览剧场列表/分类
   */
  async catalog(options = {}) {
    const page = Number(options.page) || 1;
    const category = options.category || 'hot-drama';
    const genre = options.genre || '';
    const t0 = Date.now();
    logger.info('DramaService', `获取分类短剧列表 category=${category}, genre="${genre}", page=${page}`);
    try {
      const res = await hgCatalog.browseList({ page, category, genre });
      if (res && res.success !== false && Array.isArray(res.results)) {
        logger.info('DramaService', `成功获取分类短剧: 返回 ${res.results.length} 部短剧, total=${res.total}, 耗时 ${Date.now() - t0}ms`);
        return res;
      }
    } catch (e) {
      logger.warn('DramaService', `App端目录获取失败，尝试降级: ${e.message}`);
    }

    if (category !== 'hot-drama' || genre) {
      throw Object.assign(new Error('所选分类暂不可用，请稍后重试'), { status: 502 });
    }
    // Only the general hot chart can fall back to a general hot search.
    try {
      const fallback = await this.search('热播', page);
      if (fallback && Array.isArray(fallback.results) && fallback.results.length > 0) {
        logger.info('DramaService', `热播降级搜索成功: 返回 ${fallback.results.length} 条, 耗时 ${Date.now() - t0}ms`);
        return {
          results: fallback.results,
          page,
          total: fallback.total || fallback.results.length,
          hasMore: fallback.hasMore || false,
          fallback: true
        };
      }
    } catch (e) {
      logger.error('DramaService', `热播降级搜索亦失败: ${e.message}`);
    }

    return { results: [], page, total: 0, hasMore: false };
  }

  /**
   * 获取剧集详情及全部分集列表
   */
  async getSeriesDetail(seriesId) {
    if (!seriesId) throw new Error('缺少 series_id 参数');
    const sid = String(seriesId).trim();
    const t0 = Date.now();
    logger.info('DramaService', `正在获取短剧分集详情 seriesId=${sid}`);
    const data = await hg.fetchEpisodeList(sid);
    if (!data || !Array.isArray(data.episodes) || data.episodes.length === 0) {
      logger.error('DramaService', `未能获取到短剧分集列表 seriesId=${sid}`);
      throw new Error('未获取到该短剧的分集列表');
    }
    logger.info('DramaService', `成功获取短剧详情: 《${data.series_title || ''}》(seriesId=${sid}), 共 ${data.episodes.length} 集, 耗时 ${Date.now() - t0}ms`);
    return {
      series_id: sid,
      series_title: data.series_title || '',
      cover: data.cover || '',
      total: data.total || data.episodes.length,
      intro: data.intro || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      episode_label: data.episode_label || '',
      social_info: data.social_info || null,
      celebrities: Array.isArray(data.celebrities) ? data.celebrities : [],
      episodes: data.episodes.map(ep => ({
        vid: String(ep.vid),
        vid_index: Number(ep.vid_index),
        title: ep.title ? String(ep.title) : `第 ${ep.vid_index} 集`,
        series_id: sid,
        series_title: ep.series_title || data.series_title,
        cover: ep.cover || data.cover
      }))
    };
  }

  /**
   * 解析单集视频播放源和加密信息
   */
  async getPlayInfo(vid, quality = '1080p') {
    if (!vid) throw new Error('缺少 vid 参数');
    const t0 = Date.now();
    logger.info('DramaService', `解析单集播放元信息 vid=${vid}, quality=${quality}`);
    const playInfo = await appSource.fetchAppPlayUrl(String(vid), { quality, allowLowerQuality: true });
    if (!playInfo || !playInfo.url) {
      logger.error('DramaService', `未能解析到有效的播放地址 vid=${vid}`);
      throw new Error('未能解析到有效的播放地址');
    }
    const hasKey = !!playInfo.contentKey;
    const variantsCount = Array.isArray(playInfo.variants) ? playInfo.variants.length : 1;
    logger.info('DramaService', `播放元信息解析完成 vid=${vid}: 编码=${playInfo.codec || 'hevc'}, 清晰度=${playInfo.quality || quality}, 候选节点数=${variantsCount}, 解密Key=${hasKey ? '就绪' : '无'}, 耗时 ${Date.now() - t0}ms`);
    return {
      vid: String(vid),
      url: playInfo.url,
      codec: playInfo.codec || 'hevc',
      quality: playInfo.quality || quality,
      contentKeyHex: playInfo.contentKey ? (Buffer.isBuffer(playInfo.contentKey) ? playInfo.contentKey.toString('hex') : String(playInfo.contentKey)) : null,
      variants: Array.isArray(playInfo.variants) ? playInfo.variants.map(v => ({
        quality: v.quality,
        codec: v.codec,
        url: v.url
      })) : []
    };
  }

  /**
   * 获取剧星榜（演员排行榜）
   */
  async getActorRankings(options = {}) {
    return hgActor.fetchActorRankings(options);
  }

  /**
   * 获取演员主页详情
   */
  async getActorDetail(actorId) {
    return hgActor.fetchActorDetail(actorId);
  }

  /**
   * 获取演员参演短剧作品
   */
  async getActorWorks(actorId, options = {}) {
    return hgActor.fetchActorWorks(actorId, options);
  }
}

module.exports = new DramaService();
