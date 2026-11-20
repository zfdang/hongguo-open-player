#!/usr/bin/env bash
# Rebuild application icons from the 1024px transparent master on macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v magick >/dev/null || { echo 'ImageMagick is required.' >&2; exit 1; }
command -v iconutil >/dev/null || { echo 'The macOS iconutil utility is required.' >&2; exit 1; }
icon_work_dir="$(mktemp -d)"
trap 'rm -rf "$icon_work_dir"' EXIT
mkdir -p "$icon_work_dir/player.iconset" src/client/assets
for size in 16 32 128 256 512; do
  magick build/icon.png -resize "${size}x${size}" "$icon_work_dir/player.iconset/icon_${size}x${size}.png"
  double_size=$((size * 2))
  magick build/icon.png -resize "${double_size}x${double_size}" "$icon_work_dir/player.iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$icon_work_dir/player.iconset" -o build/icon.icns
magick build/icon.png -define icon:auto-resize=256,128,64,48,32,24,16 build/icon.ico
magick build/icon.png -resize 256x256 src/client/assets/app-icon.png
magick build/icon.png -resize 32x32 src/client/assets/favicon-32.png
