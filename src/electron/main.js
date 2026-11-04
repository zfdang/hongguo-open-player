// SPDX-License-Identifier: GPL-3.0-only
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');

// 必须在 app.whenReady 之前注入 Chromium 硬件解码与 macOS VideoToolbox HEVC (H.265) 解码开关
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let serverInstance = null;
let serverStart = null;
let windowCreation = null;
function createWindow() {
  if (mainWindow) { mainWindow.focus(); return Promise.resolve(); }
  windowCreation ||= buildWindow().catch(error => {
    console.error('Window startup failed:', error);
    dialog.showErrorBox('播放器启动失败', '无法启动本地播放服务，请关闭应用后重试。');
    app.quit();
  }).finally(() => { windowCreation = null; });
  return windowCreation;
}

async function buildWindow() {
  // 1. 启动本地内嵌 Node Express 引擎
  process.env.HONGGUO_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.HONGGUO_LOG_DIR = path.join(app.getPath('userData'), 'logs');
  let logger;
  try {
    logger = require('../server/services/logger');
  } catch {
    logger = { info() {}, error() {}, warn() {}, debug() {}, getLogDir() { return ''; }, getLogFilePath() { return ''; } };
  }
  logger.info('Electron', `正在启动原生客户端: 架构=${process.arch}, 平台=${process.platform}, 版本=${typeof app.getVersion === 'function' ? app.getVersion() : 'dev'}`);
  const { startServer } = require('../server/index.js');
  serverStart ||= startServer(8899).catch(error => { serverStart = null; throw error; });
  const res = await serverStart;
  serverInstance = res.server;
  const port = res.port;

  // 2. 创建原生跨平台桌面窗口 (macOS / Windows / Linux)
  const isMac = process.platform === 'darwin';
  const windowOptions = {
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: '红果开源播放器',
    backgroundColor: '#0f1015',
    autoHideMenuBar: !isMac, // Windows 下默认隐藏传统菜单栏，保持纯粹现代深色观影质感 (按 Alt 唤出)
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      devTools: true
    },
    show: false // 待内容准备完毕后再优雅显示，避免白屏
  };

  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset'; // 优雅的 macOS 胶囊红绿灯一体化标题栏
    windowOptions.trafficLightPosition = { x: 16, y: 16 };
  } else {
    // Windows uses ICO; Linux uses the shared PNG artwork.
    windowOptions.icon = process.platform === 'win32'
      ? path.join(__dirname, '../../build/icon.ico')
      : path.join(__dirname, '../client/assets/app-icon.png');
    if (process.platform === 'win32') {
      windowOptions.titleBarStyle = 'hidden';
      windowOptions.titleBarOverlay = { color: '#14171f', symbolColor: '#ffffff', height: 40 };
    }
  }

  const window = new BrowserWindow(windowOptions);
  mainWindow = window;
  const appUrl = `http://127.0.0.1:${port}`;
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    try { if (new URL(url).origin === appUrl) return; } catch (_) {}
    event.preventDefault();
  };
  let recoveryPending = false;
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (details.reason === 'clean-exit' || recoveryPending || mainWindow !== window || window.isDestroyed?.()) return;
    recoveryPending = true;
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: '播放器界面已停止', message: '播放器界面意外停止运行',
        detail: '可以重新加载界面，播放进度将从最近保存的位置恢复。',
        buttons: ['重新加载', '稍后处理'], defaultId: 0, cancelId: 1, noLink: true
      });
      if (result.response === 0 && mainWindow === window && !window.isDestroyed?.() && !window.webContents.isDestroyed?.()) window.webContents.reload();
    } catch (error) {
      console.error('Renderer recovery failed:', error);
    } finally {
      recoveryPending = false;
    }
  });
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await window.loadURL(appUrl);
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

const GITHUB_REPO_URL = 'https://github.com/zfdang/hongguo-open-player';

function showAboutDialog() {
  const version = typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0';
  const iconPath = process.platform === 'darwin'
    ? path.join(__dirname, '../../build/icon.png')
    : path.join(__dirname, '../client/assets/app-icon.png');
  let icon;
  try {
    const { nativeImage } = require('electron');
    if (nativeImage?.createFromPath && require('node:fs').existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
    }
  } catch (_) {}

  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: '关于 红果开源播放器',
    message: `红果开源播放器 v${version}`,
    detail: `一款优雅、无广告的开源跨平台红果短剧播放器。\n\n项目开源主页: ${GITHUB_REPO_URL}\n开源许可: GPL-3.0`,
    buttons: ['访问 GitHub 主页', '确定'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    ...(icon ? { icon } : {})
  }).then(result => {
    if (result && result.response === 0) {
      shell.openExternal(GITHUB_REPO_URL).catch(console.error);
    }
  }).catch(console.error);
}

// 构建原生 macOS 菜单栏
function setupMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: '红果开源播放器',
            submenu: [
              {
                label: '关于 红果开源播放器',
                click: () => showAboutDialog()
              },
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 红果开源播放器' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 红果开源播放器' }
            ]
          }
        ]
      : []),
    ...(!isMac ? [{ label: '文件', submenu: [{ role: 'close', label: '关闭窗口' }, { role: 'quit', label: '退出' }] }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front', label: '前置全部窗口' },
              { type: 'separator' },
              { role: 'window', label: '窗口' }
            ]
          : [{ role: 'close', label: '关闭' }])
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 红果开源播放器',
          click: () => showAboutDialog()
        },
        {
          label: 'GitHub 项目主页',
          click: async () => {
            await shell.openExternal(GITHUB_REPO_URL);
          }
        },
        { type: 'separator' },
        {
          label: '打开日志目录 (Troubleshooting)',
          click: async () => {
            const logger = require('../server/services/logger');
            await shell.openPath(logger.getLogDir());
          }
        },
        {
          label: '查看当前运行日志',
          click: async () => {
            const logger = require('../server/services/logger');
            const logFile = logger.getLogFilePath();
            if (require('node:fs').existsSync(logFile)) {
              await shell.openPath(logFile);
            } else {
              dialog.showMessageBox(mainWindow, { type: 'info', title: '日志文件', message: '暂无日志生成' });
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// 单实例锁定 (Single Instance Lock)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(path.join(__dirname, '../../build/icon.png'));
    }
    if (typeof app.setAboutPanelOptions === 'function') {
      app.setAboutPanelOptions({
        applicationName: '红果开源播放器',
        applicationVersion: typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0',
        copyright: 'Copyright © 2026 zfdang. Licensed under GPL-3.0.',
        website: GITHUB_REPO_URL,
        credits: GITHUB_REPO_URL
      });
    }
    setupMenu();
    createWindow().catch((err) => {
      console.error('Failed to create window:', err);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch(console.error);
      }
    });
  });

  // 所有窗口关闭时退出应用
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  let quitting = false;
  app.on('before-quit', event => {
    if (quitting || !serverInstance) return;
    quitting = true;
    event.preventDefault();
    try { require('../server/services/logger').info('Electron', '应用程序正在退出，保存状态并关闭服务...'); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
      mainWindow = null;
    }
    require('../server/services/streamService').shutdown();
    serverInstance.close();
    serverInstance.closeAllConnections?.();
    require('../server/services/storeService').pending.catch(console.error).finally(() => app.quit());
  });
}
