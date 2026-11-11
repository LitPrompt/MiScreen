# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 构建前端 ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# 国内网络可传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --include=dev
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

# ---------- 运行环境 ----------
FROM ${NODE_IMAGE}
# 国内网络可传 --build-arg APT_MIRROR=mirrors.ustc.edu.cn
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends adb openssl tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# HOME=/data：adb 密钥（~/.android）和自签名证书都放在 /data，挂载卷后设备授权不会丢
ENV NODE_ENV=production \
    HOME=/data \
    DATA_DIR=/data \
    PORT=8080 \
    HTTPS_PORT=8443

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY vendor ./vendor
# scrcpy-server v5.0.1 官方发布文件的 sha256
RUN echo "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536  vendor/scrcpy-server-v5.0.1" | sha256sum -c -

EXPOSE 8080 8443
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
