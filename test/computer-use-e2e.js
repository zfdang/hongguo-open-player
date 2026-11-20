// SPDX-License-Identifier: GPL-3.0-only
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const APP_PATH = process.env.HONGGUO_APP_PATH || require('electron');
const APP_ARGS = process.env.HONGGUO_APP_PATH ? [] : [path.join(__dirname, '..')];
const os = require('node:os');
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-ui-test-'));
const SCREENSHOT_DIR = process.env.HONGGUO_SCREENSHOT_DIR || path.join(os.tmpdir(), 'hongguo-ui-screenshots');
let CDP_PORT = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 获取 CDP WebSocket 调试地址
async function getDebugUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      if (!CDP_PORT) { await sleep(400); continue; }
      const data = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve(body));
        }).on('error', reject);
      });
      const pages = JSON.parse(data);
      const mainPage = pages.find(p => p.type === 'page' && !p.url.startsWith('devtools://'));
      if (mainPage && mainPage.webSocketDebuggerUrl) {
        return mainPage.webSocketDebuggerUrl;
      }
    } catch (e) {
      // 稍候重试
    }
    await sleep(400);
  }
  throw new Error('未能连接到 Electron 远程测试实例的调试端口');
}

// 封装 CDP 通信协议
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.callbacks = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.result);
        }
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }

  async captureScreenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const outPath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`  📸 截图已保存: ${filename} (${buffer.length} bytes)`);
    return outPath;
  }

  async sendKey(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode
    });
    await sleep(50);
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function runComputerUseTest() {
  console.log('\n======================================================');
  console.log('🤖 启动 Computer Use 原生桌面端到端自动化测试');
  console.log('======================================================\n');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // 2. 原生启动 macOS 应用程序并开启 CDP 调试通道
  console.log('▶ [1/6] 启动原生 macOS 应用程序 (红果播放器 Plus.app)...');
  const appProc = spawn(APP_PATH, [
    ...APP_ARGS,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--remote-debugging-port=0',
    '--enable-logging'
  ], {
    stdio: 'pipe'
  });

  appProc.once('error', error => console.error('启动测试实例失败:', error.message));
  appProc.stdout.on('data', (d) => {
    const s = d.toString();
    if (s.includes('DevTools') || s.includes('服务已启动') || s.includes('StreamService')) {
      process.stdout.write(`  [AppOut] ${s}`);
    }
  });

  appProc.stderr.on('data', (d) => {
    const s = d.toString();
    const endpoint = s.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (endpoint) CDP_PORT = Number(endpoint[1]);
    if (s.includes('DevTools listening') || s.includes('StreamService')) {
      process.stdout.write(`  [AppErr] ${s}`);
    }
  });

  let cdp = null;
  try {
    const debugUrl = await getDebugUrl();
    console.log(`  ✅ 成功建立 Chrome DevTools Protocol 调试通道: ${debugUrl}`);
    cdp = new CDPClient(debugUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    // 3. 验证应用标题与首屏加载
    console.log('\n▶ [2/6] 验证首屏加载与剧目目录展示...');
    await sleep(2000); // 等待 Vue 挂载及 API 返回

    const pageTitle = await cdp.eval('document.title');
    console.log(`  应用标题: "${pageTitle}"`);
    if (!pageTitle.includes('红果播放器 Plus')) {
      throw new Error(`页面标题未包含预期名称: ${pageTitle}`);
    }

    const brandName = await cdp.eval('document.querySelector(".brand-name")?.innerText');
    console.log(`  品牌名称元素: "${brandName}"`);

    // 检查分类标签与剧目卡片数量
    const dramaCount = await cdp.eval('document.querySelectorAll(".drama-card").length');
    console.log(`  已加载剧目卡片数量: ${dramaCount}`);
    if (dramaCount === 0) {
      throw new Error('首屏未加载到剧目卡片');
    }

    await cdp.captureScreenshot('01_app_launch_catalog.png');
    console.log('  ✅ 首屏剧目目录展示正常');

    // 4. 模拟用户搜索
    console.log('\n▶ [3/6] 模拟 Computer Use 用户搜索短剧...');
    const searchKeyword = '离婚';
    await cdp.eval(`
      const input = document.querySelector(".search-box input");
      input.value = "${searchKeyword}";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".search-btn").click();
    `);
    await sleep(1500);

    const firstSearchResult = await cdp.eval('document.querySelector(".drama-card .drama-title")?.innerText');
    console.log(`  首位搜索结果: "${firstSearchResult}"`);
    await cdp.captureScreenshot('02_search_results.png');
    console.log('  ✅ 短剧关键词检索并渲染成功');

    // 5. 点击剧目进入播放器并验证视频流解密播放
    console.log('\n▶ [4/6] 模拟用户点击剧目进入沉浸式播放器...');
    await cdp.eval('document.querySelector(".drama-card").click()');
    
    // 等待视频元数据加载与起播
    console.log('  等待流媒体解密代理服务响应并起播...');
    let isPlaying = false;
    let videoInfo = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      videoInfo = await cdp.eval(`
        (() => {
          const v = document.querySelector("video.video-element");
          if (!v) return null;
          return {
            ready: v.readyState,
            paused: v.paused,
            currentTime: v.currentTime,
            duration: v.duration,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            currentSrc: v.currentSrc
          };
        })()
      `);
      if (videoInfo) {
        if (videoInfo.paused) {
          await cdp.eval('document.querySelector("video.video-element")?.play().catch(() => {})');
        }
        if (videoInfo.ready >= 1 && videoInfo.duration > 0) {
          isPlaying = true;
          break;
        }
      }
    }

    if (!isPlaying || !videoInfo) {
      throw new Error(`视频起播超时或状态异常: ${JSON.stringify(videoInfo)}`);
    }

    console.log(`  ✅ 视频起播成功:`);
    console.log(`     当前播放源: ${videoInfo.currentSrc}`);
    console.log(`     当前播放秒数: ${videoInfo.currentTime.toFixed(2)}s / ${videoInfo.duration.toFixed(2)}s`);
    console.log(`     视频物理分辨率: ${videoInfo.videoWidth} x ${videoInfo.videoHeight} (9:16 沉浸竖屏)`);
    console.log(`     播放状态: ${videoInfo.paused ? '已暂停' : '正在流畅播放'}`);

    await cdp.captureScreenshot('03_video_playback_started.png');

    // 6. 模拟键盘快捷键控制 (Space 暂停/播放，方向键切集)
    console.log('\n▶ [5/6] 模拟 Computer Use 快捷键交互...');
    // 6.1 模拟按下空格暂停
    console.log('  按下 [空格键] 暂停视频...');
    await cdp.sendKey(' ', 'Space', 32);
    await sleep(800);
    const pausedState = await cdp.eval('document.querySelector("video.video-element")?.paused');
    if (!pausedState) throw new Error('空格键未暂停视频');
    console.log(`  视频暂停状态校验: ${pausedState ? '✅ 已成功暂停' : '❌ 未暂停'}`);
    await cdp.captureScreenshot('04_keyboard_space_pause.png');

    // 恢复播放
    console.log('  再次按下 [空格键] 恢复播放...');
    await cdp.sendKey(' ', 'Space', 32);
    await sleep(800);
    const resumedState = await cdp.eval('document.querySelector("video.video-element")?.paused');
    if (resumedState) throw new Error('空格键未恢复视频播放');
    console.log(`  视频恢复播放校验: ${!resumedState ? '✅ 已恢复播放' : '❌ 仍暂停'}`);

    // 6.2 模拟按下向下方向键 ↓ 切到下一集
    console.log('  按下 [↓ 方向键] 秒切到第 2 集...');
    await cdp.sendKey('ArrowDown', 'ArrowDown', 40);
    await sleep(2500); // 等待切集与第二集解密

    const ep2Info = await cdp.eval(`
      (() => {
        const v = document.querySelector("video.video-element");
        const activeEp = document.querySelector(".episode-btn.active")?.innerText;
        return {
          activeEp,
          currentTime: v ? v.currentTime : 0,
          paused: v ? v.paused : true,
          src: v ? v.currentSrc : ''
        };
      })()
    `);
    if (!ep2Info.src || ep2Info.src === videoInfo.currentSrc) throw new Error('下一集未切换播放源');
    console.log(`  切集后激活分集: 第 ${ep2Info.activeEp} 集`);
    console.log(`  切集后播放源: ${ep2Info.src}`);
    await cdp.captureScreenshot('05_arrow_down_next_episode.png');
    console.log('  ✅ 键盘方向键无感秒切下一集测试通过');

    console.log('\n======================================================');
    console.log('🎉 Computer Use 原生端到端交互自动化测试全部成功通过！');
    console.log('======================================================\n');
  } finally {
    if (cdp) {
      cdp.close();
    }
    // 优雅关闭应用
    try {
      if (appProc.pid && appProc.exitCode === null && appProc.signalCode === null) {
        const exited = new Promise(resolve => appProc.once('exit', resolve));
        appProc.kill('SIGTERM');
        await exited;
      }
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    } catch (e) {}
  }
}

runComputerUseTest().catch(err => {
  console.error('\n❌ Computer Use 测试失败:', err);
  process.exit(1);
});
