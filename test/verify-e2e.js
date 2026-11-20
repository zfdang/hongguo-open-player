// SPDX-License-Identifier: GPL-3.0-only
const assert = require('assert');
const axios = require('axios');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-e2e-'));
process.env.HONGGUO_DATA_DIR = testDataDir;
const { startServer } = require('../src/server/index.js');

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 开始红果播放器 Plus 全链路自动化端到端测试 (E2E Verification)');
  console.log('======================================================\n');

  let serverInstance = null;
  try {
    const { server, port } = await startServer(0);
    serverInstance = server;
    const BASE_URL = `http://127.0.0.1:${port}`;
    const client = axios.create();
    // 1. 验证静态前端资源服务
    console.log('▶ [1/7] 验证静态前端资源交付...');
    const htmlRes = await client.get(`${BASE_URL}/`);
    assert.strictEqual(htmlRes.status, 200);
    client.defaults.headers.common.Cookie = htmlRes.headers['set-cookie'][0].split(';')[0];
    assert(htmlRes.data.includes('红果播放器 Plus'), 'index.html 标题应正确');
    assert(htmlRes.data.includes('vue.global.prod.js'), '应包含本地 Vue 3 引用');

    const jsRes = await client.get(`${BASE_URL}/js/app.js`);
    assert.strictEqual(jsRes.status, 200);
    assert(jsRes.data.includes('createApp'), 'app.js 应成功送达');
    console.log('  ✅ 前端静态 SPA 资源交付正常\n');

    // 2. 验证剧场目录接口
    console.log('▶ [2/7] 验证热门短剧目录获取 (GET /api/catalog)...');
    let catalogRes;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        catalogRes = await client.get(`${BASE_URL}/api/catalog?category=hot-drama&page=1`, { timeout: 15000 });
        if (catalogRes.status === 200 && catalogRes.data?.results?.length > 0) break;
      } catch (err) {
        if (attempt === 3) throw err;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.strictEqual(catalogRes.status, 200);
    const catalogDramas = catalogRes.data?.results || [];
    assert(catalogDramas.length > 0, '热门剧场应返回短剧列表');
    console.log(`  ✅ 成功获取热门短剧列表，返回 ${catalogDramas.length} 部剧目:`);
    console.log(`     示例: 《${catalogDramas[0]?.series_title}》 (总集数: ${catalogDramas[0]?.episode_count})\n`);

    // 3. 验证短剧全网关键词检索
    console.log('▶ [3/7] 验证短剧搜索接口 (GET /api/search)...');
    const testKeyword = '离婚';
    let searchRes;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        searchRes = await client.get(`${BASE_URL}/api/search?keyword=${encodeURIComponent(testKeyword)}`, { timeout: 15000 });
        if (searchRes.status === 200 && searchRes.data?.results?.length > 0) break;
      } catch (err) {
        if (attempt === 3) throw err;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.strictEqual(searchRes.status, 200);
    const searchResults = searchRes.data?.results || [];
    assert(searchResults.length > 0, '搜索应返回结果');
    const targetDrama = searchResults[0];
    console.log(`  ✅ 搜索关键词 "${testKeyword}" 成功，返回 ${searchResults.length} 条记录:`);
    console.log(`     首位匹配剧目: 《${targetDrama.series_title}》 (series_id: ${targetDrama.series_id})\n`);
    console.log(`     首位匹配剧目: 《${targetDrama.series_title}》 (series_id: ${targetDrama.series_id})\n`);

    // 4. 验证全部分集列表获取
    console.log('▶ [4/7] 验证剧集全集拉取 (GET /api/series/:seriesId)...');
    const seriesId = targetDrama.series_id || '7696091370296970265';
    const seriesRes = await client.get(`${BASE_URL}/api/series/${seriesId}`);
    assert.strictEqual(seriesRes.status, 200);
    const seriesData = seriesRes.data;
    assert.strictEqual(seriesData.series_id, seriesId);
    assert(Array.isArray(seriesData.episodes) && seriesData.episodes.length > 0, '剧目应返回分集数组');
    console.log(`  ✅ 《${seriesData.series_title}》分集列表加载成功，共 ${seriesData.episodes.length} 集全部就绪:`);
    console.log(`     第 1 集 vid: ${seriesData.episodes[0].vid}`);
    console.log(`     第 4 集 vid: ${seriesData.episodes[3].vid}`);
    console.log(`     末尾集 vid: ${seriesData.episodes[seriesData.episodes.length - 1].vid}\n`);

    // 5. 验证单集视频解析与 Spade-A 密钥派生
    console.log('▶ [5/7] 验证单集播放信息解析 (GET /api/play/:vid)...');
    const targetEpisodes = [seriesData.episodes[3], seriesData.episodes[0]].filter(Boolean);
    let playRes;
    let selectedEp;
    let lastErr;
    for (const candidateEp of targetEpisodes) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          playRes = await client.get(`${BASE_URL}/api/play/${candidateEp.vid}?quality=1080p`);
          if (playRes.status === 200) {
            selectedEp = candidateEp;
            break;
          }
        } catch (err) {
          lastErr = err;
          if (err.response?.status === 500) {
            await client.post(`${BASE_URL}/api/device/reset`).catch(() => {});
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (selectedEp) break;
    }
    if (!selectedEp || !playRes || playRes.status !== 200) {
      throw lastErr || new Error('单集解析重试耗尽失败');
    }
    const ep4 = selectedEp; // 用于后续流媒体验证
    assert.strictEqual(playRes.status, 200);
    const playData = playRes.data;
    assert(playData.url, '应解析出有效的媒体 URL');
    if (playData.contentKeyHex !== null && playData.contentKeyHex !== undefined) {
      assert.match(playData.contentKeyHex, /^[0-9a-f]{32}$/i, 'AES-128 解密密钥应为 32 位十六进制字符串');
    }
    console.log(`  ✅ 第 4 集 (${ep4.vid}) 解析成功:`);
    console.log(`     编码: ${playData.codec}`);
    console.log(`     清晰度: ${playData.quality}`);
    console.log(`     AES-128 密钥派生: ${playData.contentKeyHex ? '成功' : '无需（未加密直出片源）'}\n`);

    // 6. 验证流式边下边解边播代理与 Range 分片支持
    console.log('▶ [6/7] 验证流媒体解密代理服务 (GET /api/stream/:vid)...');
    // 6.1 HEAD 请求验证
    const headRes = await client.head(`${BASE_URL}/api/stream/${ep4.vid}`);
    assert.strictEqual(headRes.status, 200);
    assert.strictEqual(headRes.headers['content-type'], 'video/mp4');
    assert.strictEqual(headRes.headers['accept-ranges'], 'bytes');
    const totalBytes = parseInt(headRes.headers['content-length'], 10);
    assert(totalBytes > 1024 * 1024, '解密后的 MP4 体积应大于 1MB');

    // 6.2 Range 分片请求验证 (bytes=0-1023)
    const rangeRes = await client.get(`${BASE_URL}/api/stream/${ep4.vid}`, {
      headers: { Range: 'bytes=0-1023' },
      responseType: 'arraybuffer'
    });
    assert.strictEqual(rangeRes.status, 206, '分片请求应返回 HTTP 206 Partial Content');
    assert.strictEqual(rangeRes.headers['content-range'], `bytes 0-1023/${totalBytes}`);
    assert.strictEqual(rangeRes.data.length, 1024);

    // 6.3 验证解密后的 MP4 文件头特征 (ftyp 盒子)
    const headerBuf = Buffer.from(rangeRes.data);
    const ftypBox = headerBuf.subarray(4, 8).toString('ascii');
    assert.strictEqual(ftypBox, 'ftyp', '解密后的流首部应为标准 MP4 ftyp 盒子');
    console.log(`  ✅ 实时流式解密代理验证通过:`);
    console.log(`     完整时长/体积: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`     HTTP 206 Range 分片分段响应: 正常 (bytes 0-1023/${totalBytes})`);
    console.log(`     标准 MP4 ftyp 容器标识: 校验成功\n`);

    // 7. 验证进度记录本地持久化
    console.log('▶ [7/7] 验证用户播放进度记录本地持久化...');
    const progressPayload = {
      series_id: seriesId,
      series_title: seriesData.series_title,
      cover: seriesData.cover,
      episode_index: 4,
      vid: ep4.vid,
      position_sec: 45.5,
      duration_sec: 152.0
    };
    const saveProgRes = await client.post(`${BASE_URL}/api/progress`, progressPayload);
    assert.strictEqual(saveProgRes.status, 200);

    const historyRes = await client.get(`${BASE_URL}/api/history`);
    const histItem = (historyRes.data || []).find(h => h.series_id === seriesId);
    assert(histItem, '观影历史中应查到刚刚观看的短剧');
    assert.strictEqual(histItem.episode_index, 4);
    assert.strictEqual(histItem.position_sec, 45.5);

    console.log(`  ✅ 用户观影进度本地持久化读写校验成功\n`);

    console.log('======================================================');
    console.log('🎉 所有 7 项全流程测试全部成功通过！');
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n❌ 测试失败:', err.response?.data?.error || err.message);
    if (err.config?.url) {
      console.error('请求路径:', new URL(err.config.url).pathname, 'HTTP:', err.response?.status || '无响应');
    }
    process.exitCode = 1;
  } finally {
    if (serverInstance) {
      serverInstance.close();
      serverInstance.closeAllConnections?.();
    }
    fs.rmSync(testDataDir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
}

runTests();
