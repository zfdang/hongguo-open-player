// SPDX-License-Identifier: GPL-3.0-only
const express = require('express');
const http = require('node:http');
const path = require('path');
const { randomBytes } = require('node:crypto');
const sessionToken = randomBytes(32).toString('hex');
const dramaService = require('./services/dramaService');
const streamService = require('./services/streamService');
const storeService = require('./services/storeService');
const logger = require('./services/logger');

const app = express();
const PORT = process.env.PORT || 8899;

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // Vue's local template compiler currently requires unsafe-eval.
    'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  });
  next();
});

// Only the local application's own origin may access personal data or trigger downloads.
app.use((req, res, next) => {
  const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
  if (!hosts.includes(req.headers.host) ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
      ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
    return res.status(403).json({ error: '仅允许本地播放器访问' });
  }
  next();
});
app.use((req, res, next) => {
  const normalizedPath = req.path.toLowerCase();
  const port = req.socket?.localPort;
  const portCookieName = port ? `player_session_${port}` : null;
  if (normalizedPath.startsWith('/api/')) {
    const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim());
    const hasValidSession = (portCookieName && cookies.includes(`${portCookieName}=${sessionToken}`)) ||
                            cookies.includes(`player_session=${sessionToken}`);
    if (!hasValidSession) return res.status(401).json({ error: '请从播放器首页建立本地会话' });
  } else if (normalizedPath === '/' || normalizedPath === '/index.html') {
    if (portCookieName) {
      res.cookie(portCookieName, sessionToken, { httpOnly: true, sameSite: 'strict', path: '/' });
    }
    res.cookie('player_session', sessionToken, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.json({ limit: '64kb' }));

// 核心 API 请求访问与耗时日志中间件 (用于日常排错与运行诊断)
app.use((req, res, next) => {
  if (req.path.toLowerCase().startsWith('/api/')) {
    const t0 = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - t0;
      const msg = `${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} (${duration}ms)`;
      if (res.statusCode >= 500) {
        logger.error('API', msg);
      } else if (res.statusCode >= 400) {
        logger.warn('API', msg);
      } else {
        logger.info('API', msg);
      }
    });
  }
  next();
});

// 静态前端资源目录
const clientDir = path.join(__dirname, '../client');
app.use(express.static(clientDir));

function sendApiError(res, error) {
  const status = error.status >= 400 && error.status < 600 ? error.status : 500;
  const messages = {
    DEVICE_REGISTRATION_FAILED: '播放设备注册暂时失败，请稍后重试',
    ETIMEDOUT: '上游请求超时，请稍后重试',
    SECURITY_BLOCKED: '视频源地址未通过安全检查',
    EACCES: '无法访问本地数据目录，请检查写入权限',
    EPERM: '无法保存本地数据，请稍后重试',
    EBUSY: '本地数据文件正被占用，请稍后重试'
  };
  logger.error('API', `${error.code || 'REQUEST_FAILED'} - ${error.message}`);
  res.status(status).json({ error: status === 400 ? error.message : messages[error.code] || '操作失败，请稍后重试' });
}

// ================= API 路由 =================

/**
 * 1. 剧场精选/分类列表
 */
app.get('/api/catalog', async (req, res) => {
  try {
    const { page, category, genre } = req.query;
    const data = await dramaService.catalog({ page, category, genre });
    res.json(data);
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 2. 搜索短剧
 */
app.get('/api/search', async (req, res) => {
  try {
    const { keyword, page } = req.query;
    const data = await dramaService.search(keyword, page);
    res.json(data);
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 3. 获取剧集详情及全部分集列表
 */
app.get('/api/series/:seriesId', async (req, res) => {
  try {
    const { seriesId } = req.params;
    const detail = await dramaService.getSeriesDetail(seriesId);
    // 注入用户本地观看历史及收藏状态
    const savedProgress = storeService.getSeriesProgress(seriesId);
    const isFav = storeService.isFavorite(seriesId);
    res.json({
      ...detail,
      saved_progress: savedProgress,
      is_favorite: isFav
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 4. 解析单集播放元信息
 */
app.get('/api/play/:vid', async (req, res) => {
  try {
    const { vid } = req.params;
    const { quality } = req.query;
    const playInfo = await dramaService.getPlayInfo(vid, quality);
    res.json(playInfo);
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 5. 本地流媒体解密播放代理 (核心)
 * 支持 Range 请求，边下边解边播，支持预加载
 */
app.get('/api/stream/:vid', (req, res) => {
  const { vid } = req.params;
  streamService.handleStream(req, res, vid);
});

/**
 * 6. 播放进度与历史
 */
app.get('/api/history', (req, res) => {
  res.json(storeService.getHistory());
});

app.post('/api/progress', async (req, res) => {
  try {
    const item = req.body;
    const updated = await storeService.updateProgress(item);
    res.json({ success: true, progress: updated });
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 7. 收藏夹管理
 */
app.get('/api/favorites', (req, res) => {
  res.json(storeService.getFavorites());
});

app.post('/api/favorites/toggle', async (req, res) => {
  try {
    const isFav = await storeService.toggleFavorite(req.body);
    res.json({ success: true, is_favorite: isFav });
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 8. 剧星榜（演员排行榜）
 */
app.get('/api/actors/ranking', async (req, res) => {
  try {
    const { page, limit, gender } = req.query;
    const data = await dramaService.getActorRankings({ page, limit, gender });
    res.json(data);
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 9. 演员个人主页详情
 */
app.get('/api/actors/:actorId', async (req, res) => {
  try {
    const { actorId } = req.params;
    const data = await dramaService.getActorDetail(actorId);
    res.json(data);
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 10. 演员参演短剧作品列表
 */
app.get('/api/actors/:actorId/works', async (req, res) => {
  try {
    const { actorId } = req.params;
    const { count, offset } = req.query;
    const data = await dramaService.getActorWorks(actorId, { count, offset });
    res.json(data);
  } catch (err) {
    sendApiError(res, err);
  }
});

/**
 * 11. 前端播放器核心事件/报错上报日志接口
 */
app.post('/api/client-log', (req, res) => {
  const { level = 'INFO', tag = 'ClientPlayer', message, extra } = req.body || {};
  if (message && typeof message === 'string') {
    const cleanMsg = message.slice(0, 500);
    if (level === 'ERROR') logger.error(tag, cleanMsg, extra);
    else if (level === 'WARN') logger.warn(tag, cleanMsg, extra);
    else logger.info(tag, cleanMsg, extra);
  }
  res.json({ success: true });
});

/**
 * 9. 系统诊断与日志排查接口
 */
app.get('/api/system/logs', (req, res) => {
  const limit = Math.min(500, Math.max(10, Number(req.query?.limit) || 100));
  res.json({
    logFile: logger.getLogFilePath(),
    logDir: logger.getLogDir(),
    recent: logger.getRecentLogs(limit)
  });
});

function openSystemPath(targetPath, isDirectory = false) {
  if (process.env.NODE_ENV === 'test' || Boolean(process.env.CI)) {
    return;
  }
  try {
    const electron = require('electron');
    if (electron?.shell?.openPath) {
      electron.shell.openPath(targetPath);
      return;
    }
  } catch (_) {}

  try {
    const { spawn } = require('node:child_process');
    let child;
    if (process.platform === 'win32') {
      if (isDirectory) {
        child = spawn('explorer', [targetPath], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('cmd', ['/c', 'start', '""', targetPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          shell: false
        });
      }
    } else if (process.platform === 'darwin') {
      child = spawn('open', [targetPath], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' });
    }
    if (child && typeof child.unref === 'function') {
      child.unref();
    }
  } catch (_) {}
}

app.post('/api/system/open-log-dir', async (req, res) => {
  try {
    const fs = require('node:fs');
    const logDir = logger.getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    openSystemPath(logDir, true);
    res.json({ success: true, logDir });
  } catch (err) {
    logger.error('System', `打开日志目录失败: ${err.message}`);
    res.status(500).json({ error: '无法打开日志目录' });
  }
});

app.post('/api/system/open-log-file', async (req, res) => {
  try {
    const fs = require('node:fs');
    const logFile = logger.getLogFilePath();
    const logDir = logger.getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, '', 'utf8');
    }
    openSystemPath(logFile, false);
    res.json({ success: true, logFile });
  } catch (err) {
    logger.error('System', `打开日志文件失败: ${err.message}`);
    res.status(500).json({ error: '无法打开日志文件' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  sendApiError(res, error);
});

// 前端 SPA 页面兜底
app.use((req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

// 启动服务函数封装
async function startServer(preferredPort = PORT) {
  function listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(app);
      const onError = error => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server);
      };
      // Express 5 also invokes its listen callback on failure. Only the actual
      // listening event guarantees that server.address() is available.
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  let server;
  try {
    server = await listen(preferredPort);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    logger.warn('Server', `端口 ${preferredPort} 已被占用，尝试使用动态空闲端口...`);
    server = await listen(0);
  }
  const actualPort = server.address().port;
  logger.info('Server', `🚀 红果开源播放器服务已启动: http://127.0.0.1:${actualPort}`);
  logger.info('Server', `📄 运行日志文件: ${logger.getLogFilePath()}`);
  return { app, server, port: actualPort };
}

// CLI 直接运行模式
if (require.main === module) {
  startServer().then(({ port }) => {
    if (process.argv.includes('--open') || process.env.HONGGUO_AUTO_OPEN === '1') {
      const url = `http://127.0.0.1:${port}`;
      const cmd = process.platform === 'darwin' ? `open "${url}"` :
                  process.platform === 'win32' ? `start "" "${url}"` :
                  `xdg-open "${url}"`;
      require('child_process').exec(cmd, (err) => {
        if (err) logger.warn('Server', `无法自动打开浏览器: ${err.message}`);
      });
    }
  }).catch((err) => {
    console.error('启动服务失败:', err);
    process.exit(1);
  });
}

module.exports = { app, startServer };
