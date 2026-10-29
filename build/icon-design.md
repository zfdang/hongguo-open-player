# 应用图标

采用 A 方案「开放圆环」：珊瑚红圆环在右下方留出开口，表达开放与共享；中央红色播放三角形表达视频播放。暖白色圆角底座搭配简洁几何轮廓，保留红色品牌线索，在小尺寸下也便于识别。底座外缘为透明留白。

## 文件

- `icon.png`：1024×1024、透明 RGBA 主图。
- `icon.icns`：macOS 应用图标，含 16px 至 1024px 的标准分辨率。
- `icon.ico`：Windows 图标，含 16、24、32、48、64、128、256px。
- `../src/client/assets/app-icon.png`：256px 应用内标识及 Linux 窗口图标。
- `../src/client/assets/favicon-32.png`：32px 网页标签图标。

修改主图后，在装有 ImageMagick 的 macOS 环境运行 `./scripts/build-icons.sh`，重新生成平台及客户端资源。保持透明通道和四周留白，不要拉伸或添加额外的外框。

## 设计提示词

Use case: logo-brand. Asset type: desktop application icon for 红果开源播放器. A bold coral-red circular ring with a broad opening at lower right surrounds a red right-pointing play triangle. Warm white rounded-square tile, flat geometric design, rounded terminals, generous negative space and optical centering. Preserve the approved open-circle design and its colors and proportions. Keep the tile fully opaque and the exterior margins genuinely transparent. No fruit, leaves, text, watermark, ribbons, sculptural effects or decorative objects. Export a 1024×1024 RGBA master and derive all platform sizes from it.
