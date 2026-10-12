# Docker 运行（Windows / Linux 通用）

同一个镜像，Windows（Docker Desktop）和 Linux 都能跑。两个平台**统一用 bridge + 端口映射**：

| 平台 | 启动命令 | 网络 |
|---|---|---|
| Windows（Docker Desktop） | `docker compose up -d` | bridge + 端口映射 |
| Linux（含 NAS） | `docker compose up -d` | bridge + 端口映射 |

bridge + `8080:8080` 端口映射已同时覆盖本机 LAN 访问（`http://宿主机IP:8080`）和
外网反代访问（反代终结 TLS 后转发到 `http://宿主机IP:8080`，开 WS 升级即可）。
scrcpy 服务端是**出站** `adb connect 手机IP:5555`（NAT 放行出向），入站网页/WS 走
已发布的 8080，无需容器直接在 LAN 子网里，所以**不需要 host 网络**。

Windows 上**也做不到** USB 直连：容器跑在 WSL2 虚拟机里，USB 设备进不去，
这是架构限制，不是配置问题。所以连手机一律走**无线 adb**（手机和电脑同一个局域网）。

## 快速开始

```bash
docker compose up -d            # 首次会构建镜像，约 1～2 分钟
docker compose logs -f          # 日志里有访问地址
```

然后浏览器打开 <http://localhost:8080>。停止：`docker compose down`。

## 连手机：不用进终端

1. 手机开「开发者选项 → 无线调试」，页面上会显示 `IP:端口`
2. 在网页的「连接设备」里填 `192.168.5.1:5555`，点连接
3. Android 11+ 需要先「配对」：手机点「使用配对码配对」，把码填进页面的配对框

> 历史设备存在**浏览器**的 localStorage 里，容器重启后还在，
> 前提是访问地址（协议 + 主机 + 端口）没变。所以**不需要**搞「容器启动自动连设备」。

## 持久化：adb 授权密钥（绑定挂载）

| 宿主路径 | 容器内路径 | 作用 |
|---|---|---|
| `./adbkeys` | `/root/.android` | adb 授权密钥，重建容器手机不用再点「允许调试」 |

用的是**绑定挂载**（`./adbkeys:/root/.android`）而不是 Docker 命名卷，所以密钥
**就存在 compose 文件所在目录下的 `adbkeys/` 里**，跟着项目走、便于备份和迁移。
`docker compose down -v` **不会**删它（`-v` 只删命名卷）。请勿手动删除该目录。

## TLS / HTTPS：由前置反代提供

本项目容器**只提供 HTTP（8080）**，不再内置 TLS 监听，也不生成自签证书。

浏览器要启用 WebCodecs 必须处于安全上下文，而安全上下文由**浏览器看到的页面
origin** 决定，不是由本容器决定：

- 本机 `http://localhost` 是安全上下文（loopback 例外）→ WebCodecs 可用；
- 通过反代 `https://你的域名` 访问 → 反代终结 TLS，浏览器看到 https → WebCodecs 可用；
- 直接用局域网 IP `http://192.168.5.1:8080` → 非安全上下文 → 走 MSE（无需证书，可用）。

所以要让外网/手机用 WebCodecs，请在容器前放一个反代（npm / lucky / Caddy /
Cloudflare 等）：终结 TLS，把 `https://域名` 转发到本容器 `http://8080`，并**开启
WebSocket 透传**（wss→ws）。无需改本项目的代码、无需重建镜像。

**其实不必折腾**：现在 http + MSE 的画质跟 https 等价，https 只是省掉一次证书警告。

## 多架构（amd64 + arm64）

镜像用发行版的 `adb`（不是 Google platform-tools），amd64 / arm64 都有，
换架构不用改 Dockerfile。

本地已经有两份（构建命令备查）：

```bash
docker build -t ws-scrcpy5:latest -t ws-scrcpy5:amd64 .          # 本机 x86
docker buildx build --platform linux/arm64 -t ws-scrcpy5:arm64 --load .   # ARM 板子
```

## 发布到 Docker Hub

**一次出多架构 manifest（推荐，一条命令搞定）：**

```bash
docker login
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <你的用户名>/ws-scrcpy5:latest --push .
```

`docker pull` 时会按目标机器的架构自动挑对应镜像。

**拉取后怎么跑**：用仓库里的 `docker-compose.hub.yml`（已去掉 `build:` 段，专为「拉取即运行」设计，
镜像名已指向 `linbei945/ws-scrcpy5:latest`）：

```bash
docker pull linbei945/ws-scrcpy5:latest
docker compose -f docker-compose.hub.yml up -d
```

`latest` 是**多架构清单**（amd64 + arm64），`docker pull` 时按目标机器架构自动挑选，
x86 机器和 ARM 板子用同一个地址即可。

> 别用仓库默认的 `docker-compose.yml` 去跑 Hub 镜像——它带 `build:`，
> 如果用户机器上没有源码，会尝试本地构建而失败。`docker-compose.hub.yml` 才是给最终用户用的。

**或者**用本地已经构建好的两份（不用重新编译，适合离线环境）：

```bash
docker tag ws-scrcpy5:amd64 <用户名>/ws-scrcpy5:amd64
docker tag ws-scrcpy5:arm64 <用户名>/ws-scrcpy5:arm64
docker push <用户名>/ws-scrcpy5:amd64
docker push <用户名>/ws-scrcpy5:arm64
# 合成一个多架构 manifest
docker buildx imagetools create -t <用户名>/ws-scrcpy5:latest \
  <用户名>/ws-scrcpy5:amd64 <用户名>/ws-scrcpy5:arm64
```

> 多架构 manifest **必须先推到仓库才能合成**——本地 `docker images` 只能存单架构，
> 所以 `--platform` 写两个又想 `--load` 是不行的。

在没有 Hub 的情况下拷到别的机器：

```bash
docker save ws-scrcpy5:amd64 ws-scrcpy5:arm64 -o ws-scrcpy5-images.tar
# 目标机器上：
docker load -i ws-scrcpy5-images.tar
```

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `docker compose up` 卡在拉镜像 | 本机到 Docker Hub 不通。给 daemon 配镜像源：`~/.docker/daemon.json` 里加 `"registry-mirrors": ["https://docker.m.daocloud.io"]`，重启 Docker Desktop |
| 端口被占用 | 改 `docker-compose.yml` 里的 `8080:8080` 左边那个（宿主端口） |
| WebCodecs 没生效（走 MSE） | WebCodecs 只在安全上下文里可用。用 `http://localhost` 或反代 `https://域名` 访问才会触发；直接 `http://宿主机IP:8080` 是非安全上下文，必然走 MSE（画质等价，只是要手动选）。反代必须开启 WebSocket 透传 |
| 手机一直连不上 | 确认手机和**宿主机**在同一局域网；容器是主动连手机的，只要宿主机能 ping 通手机即可 |
| 每次重建都要重新授权调试 | 项目目录下的 `./adbkeys` 目录被删了（或换了部署目录）。它是绑定挂载，`docker compose down -v` 不会删它；确认该目录还在且容器内 `/root/.android/adbkey` 存在 |
