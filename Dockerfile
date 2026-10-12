# syntax=docker/dockerfile:1
#
# ws-scrcpy5 —— 浏览器投屏（官方 scrcpy-server 5.0.1 + Node 中转）
#
# 一个镜像同时支持 Windows(Docker Desktop) 和 Linux：
#   docker build -t ws-scrcpy5:latest .
#   docker compose up -d
#
# 多架构（amd64 + arm64，需 buildx）：
#   docker buildx create --use --name ws-builder
#   docker buildx build --platform linux/amd64,linux/arm64 -t ws-scrcpy5:latest --push <仓库>
#   本地只想留一份：docker buildx build --platform linux/arm64 -t ws-scrcpy5:arm64 --load .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# 构建阶段：esbuild 打包。产物是纯 JS，与 CPU 架构无关。
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

WORKDIR /build

# 先只拷依赖清单：改源码时这一层能命中缓存，不必重装依赖
COPY package.json package-lock.json ./
RUN npm ci

COPY build.mjs tsconfig.json ./
COPY src ./src
COPY public ./public
COPY vendor ./vendor

RUN npm run build

# ---------------------------------------------------------------------------
# 运行阶段
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# adb     : 用发行版包而不是 Google platform-tools —— amd64 / arm64 都有，
#           换架构不用改 Dockerfile（树莓派、ARM 云主机同理）。
# openssl : HTTPS 自签证书由 openssl 生成；node:*-slim 里没带它，
#           缺了不会报错，只会静默跳过 HTTPS。必须显式装。
RUN apt-get update \
 && apt-get install -y --no-install-recommends adb openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 服务端 bundle 把 ws 标成了 external，运行期只需要生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 打包产物（dist/public 是前端页面，dist/server/index.js 是入口）
COPY --from=build /build/dist ./dist
# 推到手机上运行的 scrcpy-server jar，与平台无关
COPY server ./server

# HOST 必须是 0.0.0.0，否则容器外访问不到
ENV HOST=0.0.0.0 \
    PORT=8080 \
    NODE_ENV=production

EXPOSE 8080

# /root/.android adb 授权密钥，持久化后手机不用再点一次「允许调试」
VOLUME ["/root/.android"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["node", "dist/server/index.js"]
