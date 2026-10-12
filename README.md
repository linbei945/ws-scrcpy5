# PC 版（Windows / macOS / Linux 本机运行）

这个文件夹是**自包含**的：把整个 `ws-scrcpy5-pc\` 拷到 U 盘、桌面、另一台电脑，
双击 `start.cmd` 就能跑。除了 Node.js 之外，不需要项目里的任何其他文件。

```
ws-scrcpy5-pc/
├── start.cmd          一键启动（双击）
├── README.md          本文档
├── build.mjs          构建脚本（把 src/ 打包进 dist/）
├── package.json  package-lock.json  tsconfig.json
├── src/               源码
├── public/            页面骨架与样式
├── vendor/            TinyH264 软解胶水代码（打进 decoder.worker.js）
├── scripts/           fetch-server.mjs 下载 scrcpy-server
├── server/            官方 scrcpy-server（已内置，克隆即用）
├── adb/               内置 adb（Windows 版，已内置）
├── tools/             自测脚本与打包脚本
├── node_modules/      npm 依赖（打包带上时才存在）
└── dist/              构建产物，每次启动都会重新生成
```

## 启动

```
start.cmd                            打开 http://localhost:8080
start.cmd 9000                       换端口
start.cmd 8080 192.168.5.1:5555    打开后自动连该设备并开始投屏
```

脚本会依次：找 Node → 用 `adb\adb.exe` → 检查 `server\scrcpy-server-v5.0.1` 在不在 →
**每次启动都重新构建** → 打开浏览器 → 起服务。窗口里按 **Ctrl+C** 停止。

> 为什么要「每次启动都构建」而不是「缺了才构建」：只要 `dist\` 还在，改了 `src\`
> 就永远不会生效，浏览器跑的还是上一次的代码——**这正是「明明修好了手机还黑屏」的
> 典型原因**（进程内存里是旧包）。构建只要约 1 秒，每次重来最省心。

macOS / Linux 没有 `start.cmd`，在本目录执行 `npm install && npm start` 即可。

## 拷贝到别的机器：用 `npm run pack` 生成压缩包

直接把文件夹拖到 U 盘或另一台电脑也能跑，但**用压缩包更稳**：

| 直接拖文件夹的风险 | 后果 |
|---|---|
| U 盘是 FAT32/exFAT | 大文件、长路径可能拷不全 |
| 资源管理器复制 | 中途出错不报错，`node_modules` 里少几个文件 |
| `.cmd` 行尾被改写 | 双击满屏「不是内部或外部命令」 |

```bash
# 在项目根目录
npm run pack
# 得到 ws-scrcpy5-pc.zip（约 14 MB）
```

zip 里已经包含 `node_modules/`，所以目标机器**什么都不用装**，解压后双击 `start.cmd` 即可。
唯一的外部前提是装有 **Node.js 18+**（`start.cmd` 找不到会明确提示）。

压缩包的结构经过验证：解压后是**单个顶层目录** `ws-scrcpy5-pc/`，`adb.exe` 保持可执行、
`start.cmd` 保持 CRLF。打包脚本是 `tools/pack-pc.mjs`，只用 Node 自带模块，不依赖
本机装没装 `zip`/`7z`。

### 打包前建议先跑一遍测试

```bash
npm test          # 215 项断言，含 .cmd 行尾检查
```

说明一下为什么需要它：服务端产物里 `require("ws")` 是外部依赖，加上构建用的 `esbuild`，
两者都在 `node_modules` 里。带上它最省事。

## 两个二进制文件

| 文件 | 来源 | 入库 |
|---|---|---|
| `adb/adb.exe` | [Android platform-tools](https://developer.android.com/tools/releases/platform-tools) 官方包 | 是（仅 Windows） |
| `server/scrcpy-server-v5.0.1` | scrcpy 官方 v5.0.1 release | 是 |

两者都已**随仓库提交**，所以 `git clone` 之后无需任何额外下载即可运行
（`npm install` 装好依赖后直接 `start.cmd`）。`npm run fetch-server` 仍可用，
用于升级到更新的 scrcpy-server 版本。

- Windows：直接用仓库内的 `adb\adb.exe`。
- Linux / macOS：仓库里的 `adb.exe` 用不上，请用系统自带的 `adb`
  （或发行版包管理器装的 platform-tools）；也可改用本项目 Docker 镜像（自带 adb）。

想用自己的 adb：设 `ADB=D:\...\adb.exe`；想用别的 server：设 `SCRCPY_SERVER_PATH=...`。

查找顺序：`$ADB` → 本目录 `adb\` → `tools\platform-tools\` → PATH 里的 `adb`。

如果 `server\` 丢了，`start.cmd` 会直接提示并停下，不会丢一堆看不懂的报错。

## 手机访问（http 直接可用）

手机直接打开局域网地址就行，**不需要证书**：

```
http://192.168.5.1:8080
```

### 为什么以前必须用 HTTPS

浏览器只在**安全上下文**里提供 WebCodecs（`VideoDecoder`）硬件解码接口。安全上下文＝
`https://` 或 `http://localhost`，而 `http://192.168.5.1` 不算——这是浏览器的安全策略，
**服务端怎么改都绕不过去**。所以手机走 http 时浏览器根本不给解码接口，画面全黑。

### 现在的做法：http 下用 MSE 硬件解码

**MSE（Media Source Extensions）不属于「仅安全上下文」的接口**，http 下可以直接用。
它的解码同样是交给 `<video>` 元素走硬件，所以 http 下也能拿到和 https 一样的画质。

页面加载时按这个顺序探测，自动选最好的那个，用户不用做任何操作：
**WebCodecs（原生流） → MSE（http 下自动启用）→ 软件解码（WASM，最后兜底）**。

服务端在收到 `container=mse` 时，把 scrcpy 的裸 H.264 流重新封装成 fMP4
（`ftyp/moov` 初始化段 + 每帧一个 `moof`/`mdat` 分片）再下发；客户端直接喂给
`SourceBuffer`。两端都保留了原有的分帧协议，只是容器换了。

| | 硬件解码（WebCodecs） | 硬件解码（MSE，http 下自动启用） | 软件解码（WASM，兜底） |
|---|---|---|---|
| 触发条件 | 电脑，或 https / localhost | 手机走 `http://局域网IP`，且浏览器支持 MSE | 浏览器既不支持 WebCodecs 也不支持 MSE |
| 支持编码 | **H.264** | **H.264** | **H.264** |
| 清晰度 / 帧率 | 高（1080p 60fps 无压力） | **同左**，不降画质 | 较低（默认限 720p / 24fps / 2Mbps） |
| 设备负担 | GPU，几乎不耗电 | **GPU，几乎不耗电** | 手机 CPU 软解，较耗电 |

落到软件解码时才会把分辨率和帧率压到 720p / 24fps，那是为了手机 CPU 跟得上。绝大多数
新版 Chrome / Edge / 手机浏览器在 http 下都会命中 MSE，也就是**默认就是硬件解码**。

> **统一使用 H.264。** 早期版本能选 h265 / av1，现已移除：MSE 与 WASM 解码器根本读不了
> 这两种流，选了就是黑屏，留着只是个陷阱。服务端现在显式传 `video_codec=h264`
> （见 `ScrcpySession.buildServerArgs()`），不再依赖 scrcpy 的默认值——万一将来 jar 改了
> 默认编码，也不会悄悄发出一路浏览器渲染不出来的流。

#### 手动指定解码方式

自动探测在绝大多数环境下是对的，但有时你想自己定。**更多参数 → 解码方式**：

| 选项 | 说明 |
|---|---|
| 自动（跟随环境） | 默认。按上面的顺序自动选，家人不用动任何设置 |
| WebCodecs 硬件解码 | 仅安全上下文（https / localhost）。延迟最低 |
| MSE 硬件解码 | http 也能用。硬件解码 |
| WASM 软件解码 | 最后的兜底，CPU 软解，更耗电 |

上表的「说明」只是给读文档的人看的——**界面上只有名字，没有这些注解**。

- 下拉框每行就是名字本身，日志里也**只记名字**（`WebCodecs 硬件解码`、`MSE 硬件解码`、
  `WASM 软件解码`）。选择时不需要人念一遍「（安全上下文）」或「延迟最低」。
- 唯一会出现在行尾的额外文字是**不可用的原因**（如「（本浏览器不提供）」），
  因为那是在解释为什么点不了。
- 好处不只是清爽：那些注解会**悄悄过期**——旧的 WebCodecs 提示里写着
  「支持 H.264 / H.265 / AV1」，在 H.265 / AV1 被删掉之后还挂在日志里很久。
  名字放在 `DECODER_LABELS`（`src/app/video.ts`）一处，下拉框和日志共用，
  `npm test` 会检查里面没有这类会过期的说法。

> 命名统一为「标识在前、中文在后」（`WebCodecs 硬件解码`，而不是 `软件解码（WASM）`），
> 这样三行能对齐、也能一眼比对不同的部分。加选项时请沿用。

几条规则：

- **不可用的选项会置灰并写明原因**（如 http 下的 WebCodecs 显示「本浏览器不提供」），
  而不是藏起来——看不到选项会让人以为是 bug。
- **投屏过程中改解码方式会重连**。服务端是在会话建立时决定发裸流还是 fMP4 的，
  不断开的话新解码器可能读不懂旧流。
- `?forceDecoder=mse` 这个测试用的 URL 参数仍然有效，它会预选好下拉框。

#### 为什么不能直接信 `isTypeSupported`

判断浏览器支不支持 MSE，最直觉的写法是问
`MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')`。**这个答案不可信。**

小米浏览器（`XiaoMi/MiuiBrowser/20.28.1020918`，Android 16）里它是个空壳，
对**任何**输入都返回 `false`，连 `'video/mp4'` 这种没有实现会拒绝的字符串也是 `false`。
但同一个页面上实测：

| 调用 | 结果 |
|---|---|
| `MediaSource.isTypeSupported('video/mp4')` | `false` |
| `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')` | `false` |
| `video.canPlayType('video/mp4; codecs="avc1.42E01E"')` | `"probably"` |
| `new MediaSource()` → `sourceopen` → `addSourceBuffer(同上)` | **全部成功** |

也就是说这个浏览器**能正常播放**，只是不肯回答。早先的代码信了 `false`，把手机降级到
WASM 软解，用户看到的就是「无法触发 MSE」。现在探测逻辑按这个顺序判：

1. 接口不存在 → 不支持；
2. `isTypeSupported` 有任何一个 `true` → 支持；
3. **全都 `false`（含裸 `video/mp4`）→ 判定为「空壳实现」，不算数**，继续往下看；
4. `canPlayType()` 返回 `"maybe"` / `"probably"` → 支持；
5. 以上都不成立但 `SourceBuffer` 构造器在 → 支持。

`mimeFor()` 同理：优先用从 `avcC` 读出的精确编码串，但即使 `isTypeSupported` 全否，
也会照常构造 `SourceBuffer`——真不兼容的话 `video.error` 会明确报出来，
比「不试就失败」好诊断得多。

### TLS / HTTPS（由前置反代提供）

本项目只提供 HTTP。要启用 WebCodecs，浏览器需处于安全上下文：本机 `http://localhost`
已满足；外网/手机请在前端放反代终结 TLS（如 npm / lucky / Caddy），把
`https://你的域名` 转发到本服务 `http://<host>:8080` 并开启 WebSocket 透传。
直接以局域网 IP `http://192.168.5.1:8080` 打开则走 MSE，无需证书也可用。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `Cannot find module '...\build.mjs'` | 只拷了一部分文件。用 `npm run pack` 生成的 zip 重新解压 |
| 双击 `start.cmd` 满屏「不是内部或外部命令」 | 行尾被编辑器改成 LF 了。`npm test` 会检出；用 `node -e "const f='start.cmd',b=require('fs').readFileSync(f);require('fs').writeFileSync(f,Buffer.from(b.toString('utf8').replace(/\r?\n/g,'\r\n')))"` 修回 |
| `[error] Missing server\scrcpy-server-v5.0.1` | 压缩包不完整（该文件 733 KB）。重新用 `npm run pack` 打包 |
| `Cannot find package 'esbuild'` | 没带 `node_modules`，在本目录跑 `npm install` |
| 明明改了代码，手机还是旧样子 | 服务进程是旧的。**关掉那个窗口重新双击 `start.cmd`**（新版本每次启动都会重新构建） |
| 提示 `adb executable not found` | `adb\adb.exe` 丢了。设 `ADB=...` 或补回该文件夹 |
| 手机能开页面但黑屏 | 浏览器太旧，WebCodecs / MSE / WebAssembly 一个都不支持。换新版 Chrome / Edge |
| 画面出不来、日志报 `SourceBuffer has been removed` | **服务端进程是旧的**。`dist/` 里的修复没生效，重启服务即可（见下） |
| http 下画面能出但偏卡 | 说明落到了软件解码（浏览器不支持 MSE）。换新版浏览器即可回到硬件解码 |
| 想要 h265 / av1 省带宽 | 不支持。三种解码方式都固定 H.264——MSE 与 WASM 读不了 h265 / av1，统一才不会有陷阱 |
| 「解码方式」里某项是灰的 | 正常。该项在当前环境不可用，括号里写了原因（例如 http 下 WebCodecs 显示「本浏览器不提供」） |
| 选了 MSE / 软件解码，画质变差 | 这两种都不降分辨率；若画面仍偏卡，说明浏览器其实没走 MSE。用 https 改选 WebCodecs 对比一下 |
