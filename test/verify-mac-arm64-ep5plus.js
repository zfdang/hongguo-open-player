// SPDX-License-Identifier: GPL-3.0-only
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const assert = require('assert');

const DEFAULT_APP_PATH = path.join(__dirname, '../dist-electron/mac-arm64/红果播放器 Plus.app/Contents/MacOS/红果播放器 Plus');
const APP_PATH = process.env.HONGGUO_APP_PATH || DEFAULT_APP_PATH;
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-arm64-test-'));
const SCREENSHOT_DIR = process.env.HONGGUO_SCREENSHOT_DIR || path.join(
  process.env.HOME || '',
  '.gemini/antigravity/brain/220b2044-22eb-481a-9093-469f02a930a6/screenshots'
);

let CDP_PORT = 9888;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getDebugUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      if (!CDP_PORT) {
        await sleep(400);
        continue;
      }
      const data = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
          let body = '';
          res.on('data', chunk => (body += chunk));
          res.on('end', () => resolve(body));
        }).on('error', reject);
      });
      const pages = JSON.parse(data);
      const mainPage = pages.find(p => p.type === 'page' && !p.url.startsWith('devtools://'));
      if (mainPage && mainPage.webSocketDebuggerUrl) {
        return mainPage.webSocketDebuggerUrl;
      }
    } catch (e) {
      // retry
    }
    await sleep(400);
  }
  throw new Error(`未能连接到 Electron 远程调试端口 (port=${CDP_PORT})`);
}

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
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const outPath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`  📸 截图已保存: ${filename} (${buffer.length} 字节) -> ${outPath}`);
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
    await sleep(60);
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

async function runArm64Verification() {
  console.log('================================================================');
  console.log('🍎 红果播放器 Plus macOS Apple Silicon (arm64) 原生发布端到端深度验证');
  console.log('================================================================\n');

  // 1. 验证目标二进制架构与文件存在性
  console.log(`▶ [1/7] 检查目标 arm64 二进制文件: ${APP_PATH}`);
  assert(fs.existsSync(APP_PATH), `目标可执行文件不存在: ${APP_PATH}`);
  const fileArch = execSync(`file "${APP_PATH}"`).toString().trim();
  console.log(`  二进制架构检测: ${fileArch}`);
  assert(fileArch.includes('arm64'), `目标二进制必须包含 arm64 架构: ${fileArch}`);
  console.log('  ✅ 确认目标为原生 macOS arm64 架构二进制程序\n');

  // 2. 启动原生 arm64 桌面应用程序
  console.log('▶ [2/7] 启动 macOS 原生应用实例并监听 CDP...');
  const appProc = spawn(APP_PATH, [
    `--user-data-dir=${USER_DATA_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--enable-logging'
  ], {
    stdio: 'pipe'
  });

  appProc.once('error', error => console.error('  ❌ 启动失败:', error.message));
  appProc.stdout.on('data', (d) => {
    const s = d.toString();
    if (s.includes('服务已启动') || s.includes('StreamService') || s.includes('DevTools listening')) {
      process.stdout.write(`  [AppOut] ${s}`);
    }
  });

  appProc.stderr.on('data', (d) => {
    const s = d.toString();
    const endpoint = s.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (endpoint) CDP_PORT = Number(endpoint[1]);
    if (s.includes('DevTools listening') || s.includes('StreamService') || s.includes('error')) {
      process.stdout.write(`  [AppErr] ${s}`);
    }
  });

  let cdp = null;
  try {
    const debugUrl = await getDebugUrl();
    console.log(`  ✅ 成功挂接 CDP 自动化控制通道 (port=${CDP_PORT})\n`);
    cdp = new CDPClient(debugUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    // 3. 验证首屏节目加载与目录展示
    console.log('▶ [3/7] 验证首屏应用加载与目录渲染...');
    let dramaCount = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      dramaCount = await cdp.eval('document.querySelectorAll(".drama-card").length') || 0;
      if (dramaCount > 0) break;
    }
    console.log(`  已渲染短剧卡片数量: ${dramaCount}`);
    assert(dramaCount > 0, '首屏未成功加载到短剧卡片');

    const firstTitle = await cdp.eval('document.querySelector(".drama-card .drama-title")?.innerText');
    console.log(`  首选剧目名称: 《${firstTitle}》`);
    await cdp.captureScreenshot('01_macos_arm64_catalog.png');
    console.log('  ✅ 节目目录加载与首屏展示正常\n');

    // 4. 打开剧场模式并加载完整分集列表
    console.log('▶ [4/7] 模拟用户点击剧目进入沉浸式播放器...');
    await cdp.eval('document.querySelector(".drama-card").click()');
    
    // 等待剧集侧栏与分集列表渲染
    let episodeCount = 0;
    let seriesTitle = '';
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      episodeCount = await cdp.eval('document.querySelectorAll(".episode-btn").length') || 0;
      seriesTitle = await cdp.eval('document.querySelector(".theater-title")?.innerText || document.querySelector(".sidebar-title")?.innerText');
      if (episodeCount >= 6) break;
    }
    console.log(`  剧目名称: 《${seriesTitle}》, 当前加载分集按钮数: ${episodeCount}`);
    assert(episodeCount >= 6, `分集数量不足 6 集进行深度验证 (当前仅有 ${episodeCount} 集)`);
    await cdp.captureScreenshot('02_macos_arm64_theater_loaded.png');
    console.log('  ✅ 剧场模式与全部分集列表就绪\n');

    // 5. 重点验证：播放第 5 集之后的内容（第 6 集）
    console.log('▶ [5/7] 核心验证：切换到【第 6 集】(超越前5集) 并验证流式解密与起播...');
    
    // 点击第 6 集按钮
    const clickedEp6 = await cdp.eval(`
      (() => {
        const buttons = Array.from(document.querySelectorAll(".episode-btn"));
        const ep6Btn = buttons.find(b => {
          const num = b.querySelector('.ep-num')?.innerText?.trim() || b.innerText.trim();
          return num === '6' || b.innerText.includes('6');
        });
        if (ep6Btn) {
          ep6Btn.click();
          return true;
        }
        return false;
      })()
    `);
    assert(clickedEp6, '未找到第 6 集的选集按钮');
    console.log('  已触发切换至第 6 集，等待流媒体解密代理服务派发并播放...');

    // 轮询检查第 6 集起播状态与解密情况
    let ep6Playing = false;
    let ep6VideoState = null;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      ep6VideoState = await cdp.eval(`
        (() => {
          const v = document.querySelector("video.video-element");
          const activeBtn = document.querySelector(".episode-btn.active")?.innerText?.trim();
          const badge = document.querySelector(".playing-ep-badge")?.innerText?.trim();
          if (!v) return null;
          return {
            activeBtn,
            badge,
            readyState: v.readyState,
            paused: v.paused,
            currentTime: v.currentTime,
            duration: v.duration,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            currentSrc: v.currentSrc,
            networkState: v.networkState,
            error: v.error ? { code: v.error.code, message: v.error.message } : null
          };
        })()
      `);

      if (ep6VideoState) {
        if (ep6VideoState.paused) {
          await cdp.eval('document.querySelector("video.video-element")?.play().catch(() => {})');
        }
        // 当 readyState >= 2 且 duration > 0，且当前集数对应第 6 集
        const isEp6 = (ep6VideoState.activeBtn && ep6VideoState.activeBtn.includes('6')) ||
                      (ep6VideoState.badge && ep6VideoState.badge.includes('第 6 集'));
        if (ep6VideoState.readyState >= 2 && ep6VideoState.duration > 0 && isEp6) {
          ep6Playing = true;
          break;
        }
      }
    }

    assert(ep6Playing, `第 6 集起播失败: ${JSON.stringify(ep6VideoState)}`);
    console.log('  ✅ 第 6 集流式解密并成功起播:');
    console.log(`     激活集数标识: ${ep6VideoState.badge} (按钮激活: 第 ${ep6VideoState.activeBtn} 集)`);
    console.log(`     流媒体代理直链: ${ep6VideoState.currentSrc}`);
    console.log(`     视频分辨率: ${ep6VideoState.videoWidth} x ${ep6VideoState.videoHeight}`);
    console.log(`     视频时长: ${ep6VideoState.duration.toFixed(2)} 秒`);
    console.log(`     当前播放进度: ${ep6VideoState.currentTime.toFixed(2)} 秒`);

    // 等待 3 秒观察播放时间持续走动
    const initialTime = ep6VideoState.currentTime;
    await sleep(3000);
    const updatedEp6State = await cdp.eval(`
      (() => {
        const v = document.querySelector("video.video-element");
        return {
          currentTime: v ? v.currentTime : 0,
          paused: v ? v.paused : true,
          error: v && v.error ? v.error.message : null
        };
      })()
    `);
    console.log(`     连续播放 3s 后的时间: ${updatedEp6State.currentTime.toFixed(2)} 秒 (前进 ${(updatedEp6State.currentTime - initialTime).toFixed(2)}s)`);
    assert(updatedEp6State.currentTime > initialTime, '视频播放进度未能持续推进');
    assert.strictEqual(updatedEp6State.error, null, '视频播放过程中不应有解码错误');

    await cdp.captureScreenshot('03_macos_arm64_episode6_playing.png');
    console.log('  ✅ 第 6 集端到端视频解密与顺畅播放校验通过！\n');

    // 6. 深入跨越验证：再次切换到【第 8 集】验证持续解密与按键控制
    console.log('▶ [6/7] 深度验证：直接跨越切换到【第 8 集】验证多集连续解密与交互...');
    const clickedEp8 = await cdp.eval(`
      (() => {
        const buttons = Array.from(document.querySelectorAll(".episode-btn"));
        const ep8Btn = buttons.find(b => {
          const num = b.querySelector('.ep-num')?.innerText?.trim() || b.innerText.trim();
          return num === '8' || b.innerText.includes('8');
        });
        if (ep8Btn) {
          ep8Btn.click();
          return true;
        }
        return false;
      })()
    `);
    assert(clickedEp8, '未找到第 8 集选集按钮');

    let ep8Playing = false;
    let ep8VideoState = null;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      ep8VideoState = await cdp.eval(`
        (() => {
          const v = document.querySelector("video.video-element");
          const activeBtn = document.querySelector(".episode-btn.active")?.innerText?.trim();
          const badge = document.querySelector(".playing-ep-badge")?.innerText?.trim();
          if (!v) return null;
          return {
            activeBtn,
            badge,
            readyState: v.readyState,
            paused: v.paused,
            currentTime: v.currentTime,
            duration: v.duration,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            currentSrc: v.currentSrc
          };
        })()
      `);
      if (ep8VideoState) {
        if (ep8VideoState.paused) {
          await cdp.eval('document.querySelector("video.video-element")?.play().catch(() => {})');
        }
        const isEp8 = (ep8VideoState.activeBtn && ep8VideoState.activeBtn.includes('8')) ||
                      (ep8VideoState.badge && ep8VideoState.badge.includes('第 8 集'));
        if (ep8VideoState.readyState >= 2 && ep8VideoState.duration > 0 && isEp8) {
          ep8Playing = true;
          break;
        }
      }
    }
    assert(ep8Playing, `第 8 集起播失败: ${JSON.stringify(ep8VideoState)}`);
    console.log('  ✅ 第 8 集流式解密与起播成功:');
    console.log(`     激活集数标识: ${ep8VideoState.badge}`);
    console.log(`     视频分辨率: ${ep8VideoState.videoWidth} x ${ep8VideoState.videoHeight}`);
    console.log(`     当前播放源: ${ep8VideoState.currentSrc}`);

    await sleep(2500);
    await cdp.captureScreenshot('04_macos_arm64_episode8_playing.png');

    // 模拟空格键暂停与恢复
    console.log('  测试空格键交互暂停...');
    await cdp.sendKey(' ', 'Space', 32);
    await sleep(600);
    const pausedNow = await cdp.eval('document.querySelector("video.video-element")?.paused');
    assert(pausedNow === true, '按空格键未能暂停');
    console.log('  ✅ 空格键成功暂停视频');
    await cdp.captureScreenshot('05_macos_arm64_episode8_paused.png');

    console.log('  再次按下空格键恢复播放...');
    await cdp.sendKey(' ', 'Space', 32);
    await sleep(600);
    const resumedNow = await cdp.eval('document.querySelector("video.video-element")?.paused');
    assert(resumedNow === false, '按空格键未能恢复播放');
    console.log('  ✅ 空格键成功恢复播放\n');

    // 7. 验证原生窗口与系统信息
    console.log('▶ [7/7] 验证 macOS 原生应用环境与平台标识...');
    const sysInfo = await cdp.eval(`
      (() => {
        return {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          electronVersion: window.hongguoDesktop?.platform || 'native-browser-embedded',
          devicePixelRatio: window.devicePixelRatio,
          windowInner: { w: window.innerWidth, h: window.innerHeight }
        };
      })()
    `);
    console.log(`  User-Agent: ${sysInfo.userAgent}`);
    console.log(`  渲染视口尺寸: ${sysInfo.windowInner.w} x ${sysInfo.windowInner.h} (DPR: ${sysInfo.devicePixelRatio})`);
    await cdp.captureScreenshot('06_macos_arm64_fullscreen_or_desktop.png');
    console.log('  ✅ 原生应用环境校验通过\n');

    console.log('================================================================');
    console.log('🎉 验证全部通过！macOS arm64 发布版第 5 集之后内容播放、解密、加载均完全正常！');
    console.log('================================================================\n');
  } finally {
    if (cdp) {
      cdp.close();
    }
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

runArm64Verification().catch((err) => {
  console.error('\n❌ macOS arm64 端到端深度验证失败:', err);
  process.exit(1);
});
