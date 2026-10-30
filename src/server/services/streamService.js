// SPDX-License-Identifier: GPL-3.0-only
const axios = require('axios');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const rangeMedia = require('./rangeMedia');
const appSource = require('../native/app-source');
const { decryptMp4Buffer } = require('../native/hongguo');
const { normalizeDownloadQuality } = require('../native/download-quality');
const { webMediaRequestOptions } = require('../native/web-media-guard');
const logger = require('./logger');

class StreamService {
  constructor({ requestOptions = webMediaRequestOptions } = {}) {
    this.requestOptions = requestOptions;
    // 内存 LRU 缓存：vid -> { buffer, size, timestamp }
    this.cache = new Map();
    this.maxCacheBytes = 128 * 1024 * 1024;
    this.maxCacheCount = 15; // 保持最近播放的 15 集，约 100MB 内存占用
    // 正在下载解密中的 Promise 映射，避免并发 Range 请求重复下载
    this.inFlight = new Map();
    this.prefetchTimers = new Map();
    this.queue = [];
    this.activeJob = null;
    this.maxPending = 8;
    this.plans = new Map();
    this.maxPlanBytes = 32 * 1024 * 1024;
    this.activeStreams = 0;
    this.streamControllers = new Set();
  }

  /**
   * 并发分片加速拉取：突破字节 CDN 单连接 256KB/s 限速，多连接跑满本地带宽 (1~1.5秒拉取整集)
   */
  async downloadWithParallelRanges(url, userAgent, timeoutMs = 20000, signal = null) {
    const headers = {
      'User-Agent': userAgent || 'com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)',
      'Accept-Encoding': 'identity'
    };

    const guarded = { ...this.requestOptions(url), maxRedirects: 0 };
    const fragments = new AbortController();
    const transferSignal = signal ? AbortSignal.any([signal, fragments.signal]) : fragments.signal;
    const tasks = [];
    try {
      // 探测文件大小
      const probe = await axios.get(url, {
        ...guarded,
        headers: { ...headers, Range: 'bytes=0-0' },
        timeout: 4000,
        responseType: 'arraybuffer',
        maxContentLength: 64 * 1024 * 1024,
        signal
      });

      const rangeHeader = probe.headers['content-range'];
      if (!rangeHeader) {
        if (probe.status === 200) return Buffer.from(probe.data);
        throw new Error('Invalid range probe');
      }

      const total = parseInt(rangeHeader.split('/')[1], 10);
      if (!Number.isSafeInteger(total) || total <= 0 || total > 64 * 1024 * 1024) {
        if (probe.status === 200) return Buffer.from(probe.data);
        throw new Error('Invalid range probe');
      }

      // 并发 6~8 个连接分段下载
      const concurrency = Math.min(total, 8, Math.max(4, Math.ceil(total / (1024 * 1024))));
      const chunkSize = Math.ceil(total / concurrency);

      for (let i = 0; i < concurrency; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize - 1, total - 1);
        if (start > end) break;
        tasks.push(
          axios.get(url, {
            ...guarded,
            responseType: 'arraybuffer',
            headers: { ...headers, Range: `bytes=${start}-${end}` },
            maxContentLength: 64 * 1024 * 1024,
            timeout: timeoutMs,
            signal: transferSignal
          }).then(r => {
            const chunk = Buffer.from(r.data);
            if (r.status !== 206 || r.headers['content-range'] !== `bytes ${start}-${end}/${total}` || chunk.length !== end - start + 1) {
              throw new Error('Invalid media range response');
            }
            return chunk;
          })
        );
      }

      const chunks = await Promise.all(tasks);
      return Buffer.concat(chunks);
    } catch (e) {
      fragments.abort();
      await Promise.allSettled(tasks);
      if (signal && signal.aborted) throw e;
      // 兜底降级为普通全量下载
      const fallback = await axios.get(url, { ...guarded, responseType: 'arraybuffer', headers, timeout: timeoutMs, maxContentLength: 64 * 1024 * 1024, signal });
      return Buffer.from(fallback.data);
    }
  }

  /**
   * 智能下载：排序边缘 CDN 节点并支持 1.5s 备用节点竞速，解决个别主域名 (如 v9-reading-video) 限速 30 秒卡顿问题
   */
  async downloadFastestMedia(variants, defaultVariant, timeoutMs = 25000, signal) {
    const list = Array.isArray(variants) && variants.length > 0 ? variants : [defaultVariant];
    // 智能排序：优先排除受限速的主节点，优先选择边缘高速 CDN
    const sorted = [...list].sort((a, b) => {
      const aBad = a.url.includes('v9-reading-video') ? 1 : 0;
      const bBad = b.url.includes('v9-reading-video') ? 1 : 0;
      return aBad - bBad;
    });

    const abortControllers = sorted.map(() => new AbortController());

    const fetchOne = async (variant, index) => {
      const controller = abortControllers[index];
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const host = new URL(variant.url).hostname;
      const t0 = Date.now();
      const buffer = await this.downloadWithParallelRanges(variant.url, variant.userAgent, timeoutMs, combined);
      const duration = Date.now() - t0;
      const speed = (buffer.length / 1024 / 1024 / Math.max(0.001, duration / 1000)).toFixed(2);
      logger.info('StreamService', `⚡ 并发分片加速从 [${host}] 下载完毕: ${buffer.length} 字节, 耗时 ${duration}ms, 平均速率: ${speed} MB/s`);
      return { buffer, variant };
    };

    if (sorted.length === 1) {
      return await fetchOne(sorted[0], 0);
    }

    return await new Promise((resolve, reject) => {
      let settled = false;
      let next = 0;
      let failures = 0;
      let running = 0;
      let timer;
      const launch = () => {
        if (settled || next >= sorted.length || running >= 2) return;
        if (signal?.aborted) { settled = true; clearTimeout(timer); reject(signal.reason); return; }
        running++;
        const index = next++;
        clearTimeout(timer);
        if (next < sorted.length) timer = setTimeout(launch, 1200);
        fetchOne(sorted[index], index).then(result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          abortControllers.forEach((controller, i) => { if (i !== index) controller.abort(); });
          resolve(result);
        }).catch(error => {
          if (settled) return;
          failures++;
          running--;
          if (failures === sorted.length) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          } else {
            // A failed source should not delay the next available candidate.
            launch();
          }
        });
      };
      launch();
    });
  }

  /**
   * 获取或解密得到指定 vid 的明文 MP4 Buffer
   */
  getDecryptedBuffer(vid, quality = 'auto', { signal, background = false } = {}) {
    quality = normalizeDownloadQuality(quality);
    const key = `${vid}:${quality}`;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, entry);
      return Promise.resolve(entry.buffer);
    }
    let job = this.inFlight.get(key);
    if (job?.controller.signal.aborted) { this.inFlight.delete(key); job = null; }
    if (!job) {
      if (this.inFlight.size >= this.maxPending) return Promise.reject(Object.assign(new Error('播放请求过多，请稍后重试'), { status: 503 }));
      job = { key, vid: String(vid), quality, background, controller: new AbortController(), clients: new Set() };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      this.inFlight.set(key, job);
      this.queue.push(job);
    } else if (!background) job.background = false;
    const client = Symbol();
    job.clients.add(client);
    if (!background && this.activeJob?.background && this.activeJob !== job) this.activeJob.controller.abort(new Error('Prefetch superseded'));
    queueMicrotask(() => this.runNext());
    return new Promise((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener('abort', cancel);
        job.clients.delete(client);
      };
      const cancel = () => {
        release();
        if (!job.clients.size) job.controller.abort(signal.reason);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      job.promise.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
    });
  }

  runNext() {
    if (this.activeJob) return;
    this.queue.sort((a, b) => Number(a.background) - Number(b.background));
    const job = this.queue.shift();
    if (!job) return;
    if (job.controller.signal.aborted) {
      if (this.inFlight.get(job.key) === job) this.inFlight.delete(job.key);
      job.reject(job.controller.signal.reason);
      this.runNext();
      return;
    }
    this.activeJob = job;
    this.loadBuffer(job.vid, job.quality, job.controller.signal).then(job.resolve, job.reject).finally(() => {
      if (this.inFlight.get(job.key) === job) this.inFlight.delete(job.key);
      this.activeJob = null;
      this.runNext();
    });
  }

  async loadBuffer(vid, quality, signal) {
    const t0 = Date.now();
    logger.info('StreamService', `[Decrypt] 开始全量拉取并解密视频: vid=${vid}, quality=${quality}`);
    const playInfo = await appSource.fetchAppPlayUrl(vid, { quality, allowLowerQuality: true, signal });
    signal.throwIfAborted();
    if (!playInfo?.url) throw new Error('未获取到有效的视频流链接');
    const { buffer, variant } = await this.downloadFastestMedia(playInfo.variants, playInfo, 25000, signal);
    signal.throwIfAborted();
    const contentKey = variant.contentKey || playInfo.contentKey;
    const key = Buffer.isBuffer(contentKey) ? contentKey : Buffer.from(contentKey || '', 'hex');
    const tDecrypt = Date.now();
    const decrypted = decryptMp4Buffer(buffer, key);
    logger.info('StreamService', `[Decrypt] 全集视频解密完成: vid=${vid}, 输入=${buffer.length} 字节, 输出=${decrypted.length} 字节, 解密耗时=${Date.now() - tDecrypt}ms, 总耗时=${Date.now() - t0}ms`);
    this.cache.set(`${vid}:${quality}`, { buffer: decrypted, size: decrypted.length });
    this.pruneCache();
    return decrypted;
  }

  shutdown() {
    for (const timer of this.prefetchTimers.values()) clearTimeout(timer);
    this.prefetchTimers.clear();
    for (const job of this.inFlight.values()) job.controller.abort(new Error('Player stopped'));
    this.planPrefetch?.abort();
    for (const controller of this.streamControllers) controller.abort(new Error('Player stopped'));
    this.cache.clear();
    this.plans.clear();
  }

  /**
   * 预加载下一集 (Prefetch)
   */
  prefetch(vid, quality = 'auto', metadataOnly = false) {
    if (!vid || !/^\d{1,30}$/.test(String(vid))) return;
    const key = `${vid}:${quality}`;
    if (metadataOnly && this.plans.get(key)?.expires > Date.now()) return;
    if (this.cache.has(key) || this.inFlight.has(key) || this.prefetchTimers.has(key)) return;
    // Range and HEAD probes must not create a timer for every browser request.
    if (this.prefetchTimers.size >= 2) {
      const oldest = this.prefetchTimers.keys().next().value;
      clearTimeout(this.prefetchTimers.get(oldest));
      this.prefetchTimers.delete(oldest);
    }
    const timer = setTimeout(() => {
      this.prefetchTimers.delete(key);
      if (this.activeStreams || (this.activeJob && !this.activeJob.background)) return;
      if (metadataOnly) {
        const controller = new AbortController();
        this.planPrefetch = controller;
        this.getStreamingPlan(String(vid), quality, controller.signal).then(() => {
          logger.info('StreamService', `[Prefetch] 成功预热下一集流分片元数据: vid=${vid}`);
        }).catch(error => {
          if (!controller.signal.aborted) logger.warn('StreamService', `[Prefetch] 下一集元数据预热失败: ${error.message}`);
        }).finally(() => { if (this.planPrefetch === controller) this.planPrefetch = null; });
        return;
      }
      this.getDecryptedBuffer(vid, quality, { background: true }).then(() => {
        logger.info('StreamService', `[Prefetch] 成功后台预解密下一集视频: vid=${vid}`);
      }).catch(err => {
        logger.warn('StreamService', `[Prefetch] 预加载分集 ${vid} 失败: ${err.message}`);
      });
    }, 4000);
    timer.unref?.();
    this.prefetchTimers.set(key, timer);
  }

  /**
   * LRU 缓存修剪
   */
  pruneCache() {
    let bytes = [...this.cache.values()].reduce((sum, entry) => sum + entry.size, 0);
    while (this.cache.size > this.maxCacheCount || bytes > this.maxCacheBytes) {
      const oldestKey = this.cache.keys().next().value;
      bytes -= this.cache.get(oldestKey).size;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * 处理 HTTP Range 播放请求 (边下边解边播的核心接口)
   */
  async getStreamingPlan(vid, quality, signal) {
    const key = `${vid}:${quality}`;
    const cached = this.plans.get(key);
    if (cached?.expires > Date.now()) { this.plans.delete(key); this.plans.set(key, cached); return cached.plan; }
    const t0 = Date.now();
    logger.info('StreamService', `开始构建流式分片播放计划: vid=${vid}, quality=${quality}`);
    const info = await appSource.fetchAppPlayUrl(vid, { quality, allowLowerQuality: true, signal });
    let lastError;
    let hasRangeUnsupported = false;
    for (const variant of info.variants?.length ? info.variants : [info]) {
      signal.throwIfAborted();
      try {
        const plan = await rangeMedia.prepareRangeMedia({ ...variant, contentKey: variant.contentKey || info.contentKey }, this.requestOptions, signal);
        logger.info('StreamService', `流式分片计划构建完成: vid=${vid}, 大小=${plan.size} 字节, 耗时=${Date.now() - t0}ms`);
        this.plans.set(key, { plan, expires: Date.now() + 90000 });
        while (this.plans.size > 8 || [...this.plans.values()].reduce((sum, item) => sum + item.plan.bytes, 0) > this.maxPlanBytes) {
          this.plans.delete(this.plans.keys().next().value);
        }
        return plan;
      } catch (error) {
        if (error.code === 'RANGE_UNSUPPORTED') {
          hasRangeUnsupported = true;
          logger.warn('StreamService', `CDN节点不支持Range，尝试下一个候选: vid=${vid}`);
          continue;
        }
        lastError = error;
        logger.warn('StreamService', `候选CDN节点异常，尝试下一个候选: ${error.message}`);
      }
    }
    if (hasRangeUnsupported) {
      logger.warn('StreamService', `所有候选CDN节点均不支持Range，回退至内存缓冲模式: vid=${vid}`);
      return null;
    }
    throw lastError || new Error('视频源不可用');
  }

  async handleStream(req, res, vid) {
    if (this.activeStreams >= 3) { res.writeHead(503); res.end(); return; }
    this.activeStreams++;
    this.planPrefetch?.abort();
    const controller = new AbortController();
    this.streamControllers.add(controller);
    const disconnected = () => { if (!res.writableEnded) controller.abort(new Error('Playback disconnected')); };
    res.once?.('close', disconnected);
    const t0 = Date.now();
    const quality = normalizeDownloadQuality(req.query?.quality || 'auto');
    const planKey = `${vid}:${quality}`;
    try {
      logger.info('StreamService', `收到流媒体Range请求: vid=${vid}, Range=${req.headers.range || '全量'}, quality=${quality}`);
      if (this.cache.has(planKey) || this.cache.has(String(vid))) {
        logger.info('StreamService', `命中完整视频内存缓存，直接进入缓冲分片播放: vid=${vid}, quality=${quality}`);
        return await this.handleBufferedStream(req, res, vid);
      }
      const plan = await this.getStreamingPlan(vid, quality, controller.signal);
      if (!plan) return await this.handleBufferedStream(req, res, vid);
      const total = plan.size;
      let start = 0, end = total - 1;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return; }
        if (!match[1]) {
          const suffix = Number(match[2]);
          start = Number.isSafeInteger(suffix) && suffix > 0 ? Math.max(0, total - suffix) : NaN;
        } else { start = Number(match[1]); end = match[2] ? Number(match[2]) : total - 1; }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return;
        }
        end = Math.min(end, total - 1);
      }
      if (res.destroyed) return;
      res.writeHead(req.headers.range ? 206 : 200, {
        'Content-Type': 'video/mp4', 'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
        ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {})
      });
      if (req.method === 'HEAD') { res.end(); return; }
      await pipeline(Readable.from(plan.read(start, end, controller.signal), { objectMode: false, highWaterMark: 64 * 1024 }), res);
      logger.info('StreamService', `流式分片传输完成: vid=${vid}, 区间=${start}-${end}/${total}, 耗时=${Date.now() - t0}ms`);
      this.prefetch(req.query?.next_vid, quality, true);
    } catch (error) {
      const isClientAbort = controller.signal.aborted ||
        error.name === 'AbortError' ||
        error.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        error.code === 'ECONNRESET' ||
        error.message === 'Playback disconnected';

      if (!isClientAbort) {
        this.plans.delete(planKey);
        logger.error('StreamService', `流媒体播放异常 vid=${vid}: ${error.message}`);
        if (!res.destroyed) {
          if (!res.headersSent) {
            res.writeHead(500, {
              'Content-Type': 'application/json',
              'X-Stream-Error-Code': error.code || 'STREAM_ERROR',
            });
            res.end(JSON.stringify({
              code: error.code || 'STREAM_ERROR',
              error: error.message || '视频源加载失败，请稍后重试',
            }));
          }
          else res.destroy(error);
        }
      } else {
        logger.info('StreamService', `客户端断开连接 (Seek/切集): vid=${vid}`);
      }
    } finally {
      res.removeListener?.('close', disconnected);
      this.activeStreams--;
      this.streamControllers.delete(controller);
    }
  }

  async handleBufferedStream(req, res, vid) {
    try {
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(new Error('Playback disconnected')); };
      res.once?.('close', disconnected);
      let buffer;
      try {
        buffer = await this.getDecryptedBuffer(vid, req.query?.quality || 'auto', { signal: controller.signal });
      } finally {
        res.removeListener?.('close', disconnected);
      }
      if (res.destroyed) return;
      if (req.method === 'GET' && !res.destroyed) this.prefetch(req.query?.next_vid, req.query?.quality || 'auto');
      const total = buffer.length;
      const range = req.headers.range;

      if (!range) {
        // 无 Range 头，直接返回完整流
        res.writeHead(200, {
          'Content-Length': total,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store'
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(buffer);
      }

      // 解析 Range 头，例如 "bytes=0-1048575"
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = NaN, end = NaN;
      if (match && (match[1] || match[2])) {
        if (!match[1]) {
          const suffix = Number(match[2]);
          if (Number.isSafeInteger(suffix) && suffix > 0) {
            start = Math.max(0, total - suffix);
            end = total - 1;
          }
        } else {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : total - 1;
        }
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      end = Math.min(end, total - 1);
      const chunkSize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, no-store'
      });

      if (req.method === 'HEAD') return res.end();
      res.end(buffer.subarray(start, end + 1));
    } catch (err) {
      console.error(`[StreamService] 播放流服务异常 vid: ${vid}`, err);
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.writeHead(err.status || 500, {
          'Content-Type': 'application/json',
          'X-Stream-Error-Code': err.code || 'STREAM_ERROR',
        });
        res.end(JSON.stringify({
          code: err.code || 'STREAM_ERROR',
          error: err.message || '视频源加载失败，请稍后重试',
        }));
      }
    }
  }
}

module.exports = new StreamService();
