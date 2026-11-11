#!/bin/bash
# 打包飞牛 fnOS 应用：在装有 docker 和 fnpack 的机器（例如飞牛本机）上运行
#   sudo ./fnos/build.sh            → fnos/out/miscreen_<版本>.fpk
# 步骤：构建 Docker 镜像 → 导出文件系统为 rootfs.tar.gz → 套上 fpk 骨架 → fnpack build
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$HERE/out"
VERSION="$(sed -n 's/^version=//p' "$HERE/pkg/manifest")"
command -v fnpack >/dev/null || { echo "找不到 fnpack（飞牛系统自带，或从 https://developer.fnnas.com/docs/cli/fnpack 下载）" >&2; exit 1; }

echo "==> 构建镜像 miscreen:build"
docker build ${DOCKER_BUILD_ARGS:-} -t miscreen:build "$ROOT"

echo "==> 准备打包目录"
rm -rf "$OUT/miscreen"
mkdir -p "$OUT"
cp -a "$HERE/pkg" "$OUT/miscreen"
sed -i "s/@VERSION@/$VERSION/" "$OUT/miscreen/app/docker/docker-compose.yaml"
python3 "$HERE/tools/make-icon.py" 64 "$OUT/miscreen/ICON.PNG"
python3 "$HERE/tools/make-icon.py" 256 "$OUT/miscreen/ICON_256.PNG"
cp "$OUT/miscreen/ICON.PNG" "$OUT/miscreen/app/ui/images/icon_64.png"
cp "$OUT/miscreen/ICON_256.PNG" "$OUT/miscreen/app/ui/images/icon_256.png"

echo "==> 导出镜像文件系统"
cid="$(docker create miscreen:build)"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker export "$cid" | gzip -6 > "$OUT/miscreen/app/docker/rootfs.tar.gz"
ls -lh "$OUT/miscreen/app/docker/rootfs.tar.gz"

echo "==> fnpack build"
chmod +x "$OUT/miscreen/cmd/"*
(cd "$OUT" && fnpack build -d miscreen)
ls -lh "$OUT"/*.fpk
