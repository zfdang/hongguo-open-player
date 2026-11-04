<p><img src="src/client/assets/app-icon.png" alt="红果开源播放器：开放圆环与播放键图标" width="96" height="96"></p>

# 红果开源播放器 (Hongguo Open Player)

[![CI](https://github.com/zfdang/hongguo-open-player/actions/workflows/ci.yml/badge.svg)](https://github.com/zfdang/hongguo-open-player/actions/workflows/ci.yml)
[![Release](https://github.com/zfdang/hongguo-open-player/actions/workflows/build-release.yml/badge.svg)](https://github.com/zfdang/hongguo-open-player/actions/workflows/build-release.yml)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

一款红果短剧跨平台桌面播放客户端（支持 macOS 与 Windows）。无需安装安卓模拟器，内置流媒体解密与本地代理，提供剧目检索、演员与作品浏览、沉浸式观影和本地进度记忆。

---

## 📸 界面预览

以下截图来自桌面版实际运行界面，剧目、弹幕和榜单内容会随来源更新。

### 播放、弹幕与选集

在播放页观看短剧、调整弹幕和播放设置，并通过右侧分组选集快速切换剧集。

![短剧播放界面：视频上方显示弹幕，右侧展示剧目介绍和分组选集](docs/screenshots/theater-playback.jpg)

### 浏览短剧

从热门榜单和分类浏览短剧，通过海报、集数和简介挑选想看的内容。

![热门短剧目录：顶部提供分类导航和搜索，下面以海报卡片展示短剧](docs/screenshots/catalog-overview.jpg)

### 搜索与最近搜索

搜索剧名、演员或题材；再次点击搜索框时，可直接选择本地保存的最近搜索。

![搜索结果及最近搜索下拉列表](docs/screenshots/search-history.jpg)

### 剧星榜与演员作品

浏览剧星榜和人气变化，筛选演员并进入主页查看参演作品。

![剧星榜：演员筛选和按排名排列的演员卡片](docs/screenshots/actor-ranking.jpg)

---

## ✨ 核心特性

* **🚀 免模拟器极速播放**：直接在桌面端原生直连播放，告别笨重的安卓模拟器；
* **🎬 实时流式解密代理**：内置基于 Spade-A 派生算法的 CENC-MP4 流式解密中间件，动态重写 MP4 容器（消除 `sinf` 还原为 `avc1`/`hvc1`），支持标准 HTTP Range 分片请求与 Seek 拖拽；
* **🎞️ 分集选择与连续播放**：通过匿名设备协议获取剧目分集，支持上一集、下一集及自动连播；实际内容可用性取决于来源与网络状态；
* **⚡ 按需读取与预加载**：按播放器请求的 Range 范围读取并解密媒体，兼容路径支持并发分块下载；条件允许时预取下一集信息，减少连播等待；
* **🔎 最近搜索**：搜索框保存最近 10 条搜索，支持再次搜索、单条删除和清空；
* **💬 弹幕**：观看时可开启弹幕，并调整显示行数和不透明度；
* **🌟 剧星榜与演员主页**：顶部「剧星榜」入口支持分页浏览演员排名与人气信息；点击演员查看简介、合作演员及参演短剧，作品列表可加载更多，点击作品即可进入播放；
* **📱 沉浸式影院视效**：智能画幅自适应（横屏 16:9 / 竖屏 9:16 均按最大视口等比铺满），支持一键全屏、双击全屏、铺满模式与选集侧栏收展；
* **⌨️ 快捷键对齐移动端**：
  * `空格` / `K`：播放 / 暂停
  * `↑` / `PageUp`：上一集
  * `↓` / `PageDown`：下一集
  * `←` / `→`：快退 / 快进 5 秒
  * `F` 或 `双击画面`：全屏切换
* **🕒 本地进度记忆与收藏**：本地持久化保存每部短剧的观看历史、当前集数及精确秒数，支持继续播放与书架收藏；
* **🖥️ 跨平台原生桌面支持**：同时支持 macOS（Apple Silicon 与 Intel 架构）及 Windows（x64），提供原生安装包及免安装便携版。

---

## 🍎 macOS 提示“应用已损坏，无法打开”

目前 macOS 安装包未使用 Apple 开发者证书签名和公证，系统的安全检查可能阻止其打开，并提示“应用已损坏”。同样的提示也可能由下载损坏或文件被篡改引起。

请先从项目的 [GitHub Releases](https://github.com/zfdang/hongguo-open-player/releases) 重新下载安装包，选择适合自己 Mac 的版本，并将应用拖入“应用程序”文件夹。如果确认应用来自官方发布页面且未被篡改，仍然无法打开，可以打开“终端”并执行：

```bash
xattr -dr com.apple.quarantine "/Applications/红果开源播放器.app"
```

这条命令只移除该应用及其内部文件的下载隔离标记，不会关闭整个系统的安全检查。完成后重新打开应用。如果应用安装在其他位置，请将命令中的路径替换为实际路径；也可以输入 `xattr -dr com.apple.quarantine ` 后，将应用拖到终端窗口自动填入路径。如果提示权限不足，可在同一命令前加 `sudo `，并按提示输入 Mac 的登录密码。

移除隔离标记会绕过此应用的部分安全检查，请只对确认可信的文件使用。如果系统明确提示包含恶意软件，或重新下载后仍怀疑文件损坏、被篡改，请勿运行该命令。更多说明请参阅 [Apple 的安全打开应用指南](https://support.apple.com/zh-cn/102445)。

## 🏗️ 架构设计与文档

当前实现采用 **Electron 桌面窗口 + Node.js / Express 本地服务 + Vue 界面**，观看历史、收藏和最近搜索以本地 JSON 文件保存。早期方案中的 SwiftUI、AVPlayer 和 SQLite 选型不代表当前实现。

运行指南、实现记录与早期研究文档位于 `docs/`：

* [🚀 快速开始与安装指南](docs/快速开始.md)
* [🎮 播放器交互设计与键盘焦点](docs/播放器交互设计.md)
* [📐 产品设计与技术架构（早期方案）](docs/产品设计与技术架构.md)
* [🔍 参考项目架构解析：hongguo-player](docs/hongguo-player-architecture.md)
* [🔍 参考项目架构解析：hongguo-drama](docs/hongguo-drama-architecture.md)
* [🧪 真机接口验证与方案报告](docs/验证与实现方案.md)

---

## 💡 参考项目与致敬 (Acknowledgements & References)

在本项目的设计与开发过程中，参考了社区中相关优秀开源项目的实践与研究：

### 🔐 视频流解密与核心算法参考
* [`zhangbaio/hongguo`](https://github.com/zhangbaio/hongguo)：红果短剧协议解析与媒体解密开源研究项目，提供了 CENC 解密与移动端协议处理参考；
* [`N3urda/hongguoTV`](https://github.com/N3urda/hongguoTV) / [`woshishiq1/drpys`](https://github.com/hjdhnx/drpy-node)：开源短剧爬虫与算法派生实践，提供了基于 Spade-A 派生 AES 密钥的计算逻辑参考；
* [`jackotom/hongguo-drama`](https://github.com/jackotom/hongguo-drama)：提供了 MP4 CENC 容器格式重写（消除 `sinf` 还原为 `avc1`/`hvc1`）及媒体处理参考。

### 🖥️ 客户端产品与交互设计参考
* [`yangbin1322/hongguo-player`](https://github.com/yangbin1322/hongguo-player)：原第三方 macOS 客户端，提供了 9:16 沉浸式竖屏观影体验与原型交互参考。

---

## ⚖️ 免责声明与版权声明

1. **学习与技术交流**：本项目仅供个人学习、多媒体流处理与跨平台桌面应用开发技术交流研究，不用于任何商业用途。
2. **参考开源项目**：因可能存在版权风险，本项目的所有内容与实现逻辑**均参考社区已开源的项目与公开网络技术资料**。
3. **内容来源与版权**：所有短剧音视频数据与元信息均实时请求自公开网络服务，本项目不提供、不存储亦不分发任何音视频资源文件。请支持正版内容。
4. **侵权与异议联系**：本项目高度尊重原创内容与相关知识产权。对于可能存在的侵权行为，如果有人觉得不合适，请联系作者进行处理（可通过 GitHub 提交 Issue 或联系作者），作者将在核实后第一时间进行删除或修改。
