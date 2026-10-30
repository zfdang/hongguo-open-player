# 红果开源播放器 (Hongguo Open Player) 全方位安全审计与漏洞扫描报告

- **审计对象**：`hongguo-open-player` (Commit `a5eefda` on `main`)
- **审计日期**：2026-10-28
- **审计范围**：本地 Node Express 服务、Electron 宿主进程、数据持久化与隐私、Android 协议模拟与密钥安全
- **报告版本**：v1.0.0
- **报告归档路径**：`reviews/01-security-and-api-review.md`

---

## 1. 审计结论与总体安全评分

### 1.1 总体安全评分：`91 / 100` (等级：A- 优秀)

本项目的整体安全架构设计处于**业内同类开源桌面端/播放器项目的优秀水准**。项目开发团队在架构初期便对本地回环服务的暴露风险、Electron 进程逃逸以及第三方协议模拟中的隐私边界有较深刻的理解，并落地了多项极具针对性的防御措施：
- 严格将 Express 服务绑定至 `127.0.0.1` 单机回环地址；
- 主动部署针对 DNS Rebinding（DNS 重绑定）与跨站请求（CORS / Host / Origin / Sec-Fetch-Site）的校验中间件；
- Electron 完全禁用了 `nodeIntegration` 并开启了 `contextIsolation` 与 `webSecurity`；
- 外部链接跳转使用严格的 `https?` 正则过滤并交由系统默认浏览器打开；
- 针对短剧平台协议模拟设计了**进程内内存生命周期**的匿名设备注册体系，避免了真实硬件指纹或敏感私钥的持久化与泄露。

总体安全风险处于低位，未发现 Critical（严重）或 High（高危）级别的直接远程代码执行（RCE）或任意文件读写漏洞。审计中发现的主要风险集中在：**Stream 代理层未禁用 HTTP 重定向导致的潜在 SSRF 穿透**、**Express 来源校验对于非现代浏览器或特定协议的防御纵深不足**、**缺失 CSP 安全头**以及 **Electron 部分边缘导航事件的异常处理保护**。

### 1.2 漏洞与风险概览统计

| 严重级别 (Severity) | 发现数量 | 说明 |
| :--- | :---: | :--- |
| **Critical (严重)** | 0 | 未发现系统性提权、远程代码执行 (RCE) 或无限制任意命令执行 |
| **High (高危)** | 0 | 未发现未经身份验证的数据破坏或任意本地文件读写漏洞 |
| **Medium (中危)** | 2 | Stream 代理重定向 SSRF 风险；Express 来源校验缺失防御纵深令牌 |
| **Low (低危)** | 3 | Electron `will-navigate` 缺少 try/catch 与 `will-redirect` 监听；缺少 CSP 头；macOS Hardened Runtime 未开启 |
| **Info (提示)** | 2 | 原生模块残留未使用的第三方引用死代码；生产环境错误信息回显 |

---

## 2. 详细安全发现清单 (Findings List)

### 【Medium-01】流媒体拉取代理未限制 HTTP 重定向与公网 IP 校验 (潜在 SSRF 风险)

- **严重级别**：Medium
- **影响组件**：`src/server/services/streamService.js` (`downloadWithParallelRanges` 及 `downloadFastestMedia`)
- **相关标准**：CWE-918: Server-Side Request Forgery (SSRF)

#### 1. 缺陷描述与成因分析
在 `streamService.js` 中，播放器通过 `downloadWithParallelRanges` 向边缘 CDN 拉取分集视频流。代码虽在 `app-source.js` 的 `fetchAppPlayUrl` 中通过 `checkedUrl(media, ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com'])` 校验了 CDN 的初始域名白名单，但是在实际发起 Axios 请求时：
1. **未设置 `maxRedirects: 0`**：Axios 默认会跟随最多 5 次 HTTP 重定向（301/302/307/308）；
2. **未引入 `web-media-guard.js` 提供的 IP 边界检查**：在 `hongguo.js` 中处理官网页面和解析时使用了 `webMediaRequestOptions`，可有效阻断私有地址（如 `127.0.0.0/8`, `192.168.0.0/16`, `169.254.169.254` 等），但 `streamService.js` 直接使用了原生全局 `axios.get`，未配置该保护。

#### 2. 潜在攻击场景推演
若上游某条 CDN 边缘节点存在开放重定向（Open Redirect）漏洞，或者第三方视频流配置了指向重定向服务的 URL：
1. Axios 发起请求探测分片 `Range: bytes=0-0`；
2. 上游响应 `302 Found`，`Location: http://127.0.0.1:8899/api/favorites/toggle` 或内网元数据服务 `http://169.254.169.254/...`；
3. Axios 会自动跟随重定向，将内网服务或本机的响应内容作为视频流的一部分下载并缓存到内存中，构成 SSRF 盲区。

#### 3. 修复方案与代码示例
在 `streamService.js` 中显式设置 `maxRedirects: 0`，或者使用 `web-media-guard.js` 中的安全 Agent 校验解析后的目标 IP 地址：

```javascript
// src/server/services/streamService.js 修复建议
const { webMediaRequestOptions } = require('../native/web-media-guard');

async downloadWithParallelRanges(url, userAgent, timeoutMs = 20000, signal = null) {
  const headers = {
    'User-Agent': userAgent || '...',
    'Accept-Encoding': 'identity'
  };

  const guardOptions = {
    maxRedirects: 0, // 禁止自动跟随不可信重定向，阻断 SSRF 跳转
    timeout: timeoutMs,
    signal,
    headers
  };

  try {
    const probe = await axios.get(url, {
      ...guardOptions,
      headers: { ...headers, Range: 'bytes=0-0' },
      timeout: 4000,
      responseType: 'arraybuffer',
      maxContentLength: 64 * 1024 * 1024,
    });
    // ... 后续逻辑保持不变 ...
```

---

### 【Medium-02】本地 Express 服务请求来源验证对非现代浏览器及无 Origin 请求缺少防御纵深

- **严重级别**：Medium
- **影响组件**：`src/server/index.js` (第 12-20 行)
- **相关标准**：CWE-346: Origin Validation Error / CWE-352: Cross-Site Request Forgery (CSRF)

#### 1. 缺陷描述与成因分析
`src/server/index.js` 当前的来源拦截机制如下：
```javascript
app.use((req, res, next) => {
  const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
  if (!hosts.includes(req.headers.host) ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: '仅允许本地播放器访问' });
  }
  next();
});
```
该中间件成功防护了常规现代浏览器（Chrome/Firefox/Edge）中发起的带 `Origin` 或 `Sec-Fetch-Site: cross-site` 的跨站攻击。然而存在以下防御盲区：
1. **旧版或特定浏览器缺失 Fetch Metadata**：如部分老版本浏览器或特制 WebView 不发送 `Sec-Fetch-Site`；
2. **简单 GET 跨站请求不携带 Origin**：对于 `<img src="...">`, `<audio src="...">`, `<video src="...">` 等跨站 GET 请求，浏览器不会附加 `Origin` 头；
3. **缺少会话令牌（Session Token / Nonce）**：若无随机 Token 隔离，本地环境中的任何其他无特权脚本均可向 `http://127.0.0.1:<port>` 发起 API 调用，无法验证请求是否确实来源于 Electron 内部加载的前端窗口。

#### 2. 潜在攻击场景推演
1. 用户在外部浏览器打开了某个恶意网页 `https://attacker.org`；
2. 恶意网页通过非标准途径向 `http://127.0.0.1:<port>/api/stream/<vid>` 发送跨站探测请求（在不支持 Fetch Metadata 的旧客户端或通过特定的简单请求类型）；
3. 恶意网页可能通过探测响应时延（XS-Leaks 计时侧信道）分析用户近期播放过的视频 ID，或者通过耗尽本地 Express 服务的网络与 CPU 资源实施拒绝服务（DoS）。

#### 3. 修复方案与代码示例
为本地 Express 服务引入**一次性本地会话凭证（Local App Token）**机制：
在 Electron 启动本地 Express 时生成一个进程级安全随机 Token，并作为全局配置或 URL 参数注入 Electron 窗口，前端在所有 `/api/*` 请求时携带自定义头（如 `x-app-token`）。由于外部浏览器跨站请求无法读取该 Token 也无法伪造自定义 Header，可构建 100% 免疫的访问控制屏障。

```javascript
// 1. 在 src/server/index.js 中支持生成与验证 token
const crypto = require('crypto');
const APP_TOKEN = process.env.HONGGUO_SERVER_TOKEN || crypto.randomUUID();

app.use((req, res, next) => {
  const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
  const token = req.headers['x-app-token'] || req.query.token;

  // 严格校验 Host 与来源
  if (!hosts.includes(req.headers.host) ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: '仅允许本地播放器访问' });
  }

  // 对 /api/ 路由执行 Token 校验 (静态资源除外)
  if (req.path.startsWith('/api/') && token !== APP_TOKEN) {
    return res.status(401).json({ error: '未授权的内部请求' });
  }

  next();
});
```

---

### 【Low-01】Electron `will-navigate` 缺少异常保护且未监听 `will-redirect`

- **严重级别**：Low
- **影响组件**：`src/electron/main.js` (第 54-60 行)
- **相关标准**：CWE-601: URL Redirection to Untrusted Site ('Open Redirect')

#### 1. 缺陷描述与成因分析
`src/electron/main.js` 中的导航保护代码如下：
```javascript
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== appUrl) event.preventDefault();
  });
```
存在两个边缘缺陷：
1. `new URL(url)` 在传入非标准格式的 URL（例如某些特殊 scheme 或畸形字符串）时会抛出 `TypeError` 异常。在 Node.js / Electron 事件循环中，未捕获的异常会导致该事件回调中断，无法执行到 `event.preventDefault()`，使非法导航未能被及时拦截。
2. Electron 的 `will-navigate` 只会在用户触发的顶层导航时触发；如果目标网页发生 HTTP 302/301 服务端重定向，触发的是 `will-redirect` 事件。当前代码未监听 `will-redirect`。

#### 2. 修复方案与代码示例
增强异常捕获，并同时监听 `will-redirect` 事件：

```javascript
// src/electron/main.js 修复代码示例
function isSafeOrigin(url, appUrl) {
  try {
    return new URL(url).origin === appUrl;
  } catch (_) {
    return false; // 解析失败一律视为不安全，拦截跳转
  }
}

window.webContents.on('will-navigate', (event, url) => {
  if (!isSafeOrigin(url, appUrl)) {
    event.preventDefault();
  }
});

window.webContents.on('will-redirect', (event, url) => {
  if (!isSafeOrigin(url, appUrl)) {
    event.preventDefault();
  }
});
```

---

### 【Low-02】静态资源缺乏 Content-Security-Policy (CSP) 与安全标头

- **严重级别**：Low
- **影响组件**：`src/server/index.js`, `src/client/index.html`
- **相关标准**：CWE-693: Protection Mechanism Failure

#### 1. 缺陷描述与成因分析
虽然 Electron 开启了 `webSecurity: true`，但 Express 服务响应以及前端 `index.html` 均未定义 `Content-Security-Policy` (CSP) 标头或 `<meta>` 标签，同时也缺失常规的 HTTP 安全防御响应头：
- 未配置 `Content-Security-Policy`：无法约束内联脚本、跨域媒体和样式的加载源；
- 未配置 `X-Content-Type-Options: nosniff`：可能导致 MIME 嗅探攻击；
- 未配置 `X-Frame-Options: DENY`：未明确禁止页面被外部浏览器 `iframe` 嵌入。

#### 2. 修复方案与代码示例
在 `src/server/index.js` 中增加安全响应头中间件：

```javascript
// src/server/index.js 修复建议
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self' https:;"
  );
  next();
});
```

---

### 【Low-03】macOS 打包配置关闭了 Hardened Runtime 与代码签名强化

- **严重级别**：Low / Hardening
- **影响组件**：`package.json` (第 50-51 行)
- **相关标准**：macOS Hardened Runtime Security Best Practices

#### 1. 缺陷描述与成因分析
在 `package.json` 的 `build.mac` 节中：
```json
"hardenedRuntime": false,
"gatekeeperAssess": false
```
当前配置显式关闭了苹果的 `hardenedRuntime`（强化运行时）。在 macOS 平台上，关闭该选项会导致应用失去操作系统级的运行时代码签名校验保护，使得恶意进程容易通过注入动态链接库（`DYLD_INSERT_LIBRARIES`）或 Hook 手段对播放器进程实施进程内存注入。

#### 2. 修复方案
在准备公开发布正式生产安装包时，应在 CI/CD 中开启 `hardenedRuntime: true`，并配置相应的签名证书与公证流程：
```json
"mac": {
  "category": "public.app-category.video",
  "icon": "build/icon.icns",
  "hardenedRuntime": true,
  "gatekeeperAssess": true
}
```

---

### 【Info-01】原生模块存在未使用的第三方解混淆/扩展源死代码引用

- **严重级别**：Info
- **影响组件**：`src/server/native/hongguo.js` (第 430-432 行，第 624-626 行)

#### 1. 缺陷描述
在 `src/server/native/hongguo.js` 中存在如下代码片段：
```javascript
if (String(seriesId).startsWith('custom:')) return require('./custom-source').fetchEpisodeList(seriesId);
if (String(seriesId).startsWith('hema:')) return require('./hema').fetchEpisodeList(seriesId);
if (String(seriesId).startsWith('xifan:')) return require('./xifan').fetchEpisodeList(seriesId);
```
经比对仓库文件树，当前项目中并不存在 `custom-source.js`、`hema.js`、`xifan.js` 等模块。当用户请求不合法的 ID 时，虽然上层逻辑有捕获保护，但这属于上游开源项目（如 TV 聚合版代码）移植时残留的无用死代码。

#### 2. 修复方案
清理掉未被引入的第三方模块引用分支，保持代码库整洁，降低攻击面与审计混淆。

---

### 【Info-02】生产环境错误捕获直接回显底层 Exception 细节

- **严重级别**：Info
- **影响组件**：`src/server/index.js` (API 路由通用 catch 块)

#### 1. 缺陷描述
多个 API 接口直接将底层捕获到的 `err.message` 通过 JSON 抛给前端：
```javascript
} catch (err) {
  res.status(err.status || 500).json({ error: err.message });
}
```
当底层网络或解密抛出包含文件绝对路径、上游接口鉴权参数或系统日志等内部敏感错误时，直接暴露错误详情不够优雅。建议统一错误包装器，屏蔽未受控的底层调用堆栈。

---

## 3. 专项深度审查报告

### 3.1 本地 Node Express 服务安全审计

| 审查检查项 | 状态 | 详细分析与佐证 |
| :--- | :---: | :--- |
| **回环隔离 (127.0.0.1)** | ✅ 合规 | `app.listen(port, '127.0.0.1')` 显式限定本地回环，未绑定 `0.0.0.0`，杜绝局域网未授权直连。 |
| **DNS Rebinding 防范** | ✅ 合规 | 中间件校验 `req.headers.host`，仅允许匹配当前进程监听端口的 `127.0.0.1:<port>` 与 `localhost:<port>`，域名绑定攻击无法绕过 Host 校验。 |
| **CORS 跨域防护** | ✅ 合规 | 未开放任何全通配的 `Access-Control-Allow-Origin: *` 头，且若收到外部 `Origin` 则强制比对当前 `host`。 |
| **路径穿越风险** | ✅ 安全 | `express.static(clientDir)` 由 `serve-static` 标准库内嵌路径归一化防御；SPA 兜底写死加载 `index.html`；API 未对外提供任何可带 `../` 的静态读取接口。 |
| **请求 Payload 限制** | ✅ 合规 | 显式配置 `express.json({ limit: '64kb' })`，从根本上杜绝了大体积恶意 JSON 导致的内存耗尽与反序列化拒绝服务攻击。 |

### 3.2 Electron 宿主安全审计

| 审查检查项 | 状态 | 详细分析与佐证 |
| :--- | :---: | :--- |
| **Node.js 集成隔离** | ✅ 合规 | `webPreferences.nodeIntegration: false`，渲染进程无法直接访问 `process`、`require`、`child_process`。 |
| **上下文隔离** | ✅ 合规 | `webPreferences.contextIsolation: true`，页面脚本与内部扩展上下文严格物理隔离。 |
| **同源策略开启** | ✅ 合规 | `webPreferences.webSecurity: true`，Chromium 标准沙箱与 SOP 规则完全生效。 |
| **外部弹窗管控** | ✅ 合规 | `setWindowOpenHandler` 返回 `{ action: 'deny' }` 拦截一切原生弹窗；仅针对 `https?` 协议交由系统 `shell.openExternal` 打开。 |
| **单实例锁机制** | ✅ 合规 | `app.requestSingleInstanceLock()` 保证桌面应用单实例运行，避免多进程竞态冲突。 |

### 3.3 数据持久化与隐私安全审计

| 审查检查项 | 状态 | 详细分析与佐证 |
| :--- | :---: | :--- |
| **存储规范性** | ✅ 合规 | Electron 模式下统一存入 `app.getPath('userData')/data/user_data.json`，严格遵循 OS 应用数据目录规范。 |
| **原子写入与并发安全** | ✅ 合规 | 写入采用 `.tmp` 临时文件 + `fs.renameSync` 原子覆盖模式，避免写入中断造成的数据损坏或文件清空。 |
| **文件访问权限** | ✅ 合规 | 写入权限显式设定为 `mode: 0o600`，仅限当前操作系统用户读写，杜绝跨用户权限泄露。 |
| **防原型链污染** | ✅ 合规 | `storeService.js` 中 `history` 和 `favorites` 均采用 `Object.create(null)` 创建字典，键名经 `^\d{1,30}$` 正则校验，免疫原型链污染。 |
| **无敏感隐私外泄** | ✅ 合规 | 文件仅持久化剧集 ID、剧名、封面 URL、分集索引与播放进度秒数，无任何密码、个人凭据或真实设备硬件指纹。 |

### 3.4 Android 协议模拟与加密参数审计

| 审查检查项 | 状态 | 详细分析与佐证 |
| :--- | :---: | :--- |
| **设备标识生成方式** | ✅ 极佳 | `playback-device.js` 中 `cdid`, `openudid`, `clientudid`, `req_id` 均使用安全随机生成 (`crypto.randomUUID`, `crypto.randomBytes`)。 |
| **生命周期管理** | ✅ 极佳 | 设备注册会话完全仅存放在内存 Promise 中 (`registration ||= ...`)，不写磁盘，进程重启即销毁，不产生长期追踪指纹。 |
| **无真实私钥硬编码** | ✅ 合规 | 参考开源实现涉及的常量为公开的混淆表、SBOX 与固定协议盐（`KDF_SALT`），非任何特定个人的私钥或身份证书。 |
| **国密 SM3 与 CENC 解密**| ✅ 稳健 | `sm3.js` 为纯 JS 实现的标准国密摘要算法；`decryptMp4Buffer` 实现了内存内的标准 ISO-14496-12 CENC AES-CTR 解密与 MP4 Box 重构，无溢出风险。 |

---

## 4. 体系化加固与修复实施方案

为了将项目的安全防护水位提升至生产级标杆（98+ 分），建议按以下步骤实施加固：

### 阶段一：防御纵深与网络收敛（解决 Medium 级风险）
1. **统一 Stream 下载的网络防护**：
   在 `streamService.js` 中使用 `webMediaRequestOptions` 或直接配置 `maxRedirects: 0`，对下载的媒体流阻断跨域和非公网重定向。
2. **在 Express 与前端注入一次性通信握手 Token**：
   在 Electron 启动本地服务时传入随机生成的高熵 UUID 作为通信凭据，彻底杜绝外部浏览器任何形式的未授权调用。

### 阶段二：Electron 宿主防御加固（解决 Low 级风险）
1. **完善导航监听**：
   在 `main.js` 中包裹 `will-navigate` 的 URL 解析为安全函数，并增补对 `will-redirect` 事件的拦截；
2. **补充 CSP 标头**：
   在 Express 的静态托管中间件前注入通用 CSP 响应头，限制前端脚本只允许执行来自本地服务的静态文件。

### 阶段三：工程整洁度与构建配置优化（解决 Info 级风险）
1. **清理 `hongguo.js` 中遗留的未引用模块**：
   剔除 `custom-source`, `hema`, `xifan` 相关的空引用分支；
2. **发布配置完善**：
   在 `package.json` 的 macOS 构建配置中设置 `hardenedRuntime: true`。

---

## 5. 结论

`hongguo-open-player` 展现了极高的工程质量与安全防御自觉性。通过合理的架构分层，项目在实现复杂的 MP4 CENC 实时流式解密播放功能的同时，严密防范了单机桌面应用最常见的本地服务暴露和进程注入风险。本报告提出的改进建议均为防御纵深层面的精细化加固，预计在实施上述修复后，该项目的安全性可达到同类短剧播放器项目的顶尖水准。
