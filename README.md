# UU Bridge

本项目包含两个独立的本地入口：

- `http://127.0.0.1:18787`：官方客户端窗口查看桥接。画面已通过真实 UU 验证；UU 4.46.0 未接受后台模拟输入，真实 UU 的输入开关已禁用。自带验证窗口仍可测试原生输入。
- `http://127.0.0.1:18787/web-controller`：独立开源 UU 网页主控的便捷入口，内部运行在 `127.0.0.1:18789`，源码在 `vendor/uu-web`。直接通过 UU 协议传送画面和键鼠，需要用户在自建网页中登录一次 UU 账号；不提取官方客户端凭证。入口自动建立本机会话，不需要复制或展示带令牌的 URL。构建与登录后真实控制需分别验证。
- `npm run mcp`（`agent/mcp-server.mjs`）：参考 [CrossDesk MCP](https://github.com/kunkundi/crossdesk) 工程方案实现的本地 **MCP (Model Context Protocol) 远控服务**。零新增外部依赖，通过本机 `127.0.0.1:18789` 的独立 Agent Broker 桥接你在浏览器中打开的 UU 网页主控，让 AI Agent 能够安全、可靠地观察和操控远端电脑，同时保留人类实时旁观与一键接管能力。

窗口桥接的登录、连接及网络传输由官方客户端完成，不读取账号、验证码或登录态。网页主控是独立服务，不等于官方客户端画面的再次投屏。

## 运行

独立网页主控已准备后，在项目根目录执行 `npm run start:web`；原桥接服务也保持 `npm start` 运行。然后打开 <http://127.0.0.1:18787/web-controller>，或点击原页面的“打开本地 UU 网页主控”。需要在自建网页中登录 UU；若官方本机主控仍占用同一设备，先断开其控制会话，再从网页连接同一台设备。对方的官方 UU 被控端继续运行。

首次准备独立网页主控可直接运行一键脚本（自动拉取锁定基线提交的 [ofoz/uu_web](https://github.com/ofoz/uu_web)、应用 `integration/uu-web/` 最小本地桥接适配并按 `shared → backend → frontend` 顺序构建，保留上游 MIT 许可证）：

```bash
npm run setup:web
```

以后启动只需执行 `npm run start:web` 与 `npm start`，无需重复安装或构建。两个本地页面均支持 **浅色 / 深色主题（默认跟随系统）**，可随时在界面中手动切换。

以下命令只启动原客户端窗口查看桥接：

需要 macOS 14+、Xcode Command Line Tools（含 Swift）、Node.js 22+。无需 npm 安装依赖、无需 Docker、无需服务器。

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:18787>。服务只监听本机，退出终端中的服务即可停止桥接。端口冲突时可以使用 `PORT=18788 npm start`。

1. 在官方 UU 客户端中登录并连接对方电脑。
2. 在网页中刷新窗口，选择对应 UU 窗口。
3. 按网页提示授权屏幕录制和辅助功能，然后刷新权限状态。
4. 点击开始画面。真实 UU 窗口在这个入口只能查看；实际远控使用独立网页主控。输入开关只对本项目自带的验证窗口开放。

本机验证窗口支持在画面内点击、右键、拖动、滚动，以及常用按键和侧栏文字发送。文字插入当前光标处，不自动覆盖已有内容。后台 macOS 验证窗口的 Command+A 实测未生效，普通 Backspace 可用。这些验证结果不代表官方 UU 接受了后台输入。

## 权限

原生程序位于 `.build/UU Bridge.app`。系统可能把权限归属给启动它的终端或 OpenChamber，按实际弹出的应用名称授权。系统设置 → 隐私与安全性 → 屏幕与系统音频录制 / 辅助功能。授权后刷新状态；若系统要求退出重开，重启桥接服务。

不修改系统权限数据库、不绕过系统确认。截图不自动保存；接口只允许采集选定的 UU / 验证窗口，原生输入只对自带验证窗口开放。不会为绕过 UU 输入限制而自动抢占本机键鼠。

## 验证

网页“本机输入验证”可打开一个独立的无害窗口。选择该窗口后，从浏览器点击计数按钮、点击输入框并发送文字。输入与 UU 使用相同的路径；画面由验证窗口自身的视图绘制，不读取屏幕，因此没有屏幕录制权限也能验证浏览器与原生输入的闭环。网页会标明“应用自身绘制”；这不能证明真实 UU 的 ScreenCaptureKit 采集已经通过。

```bash
npm test
npm run verify:local
```

`verify:local` 要求服务已运行，会打开本项目的验证窗口，实际检查后台点击、Unicode 输入、Backspace、过期目标拒绝和释放后迟到输入的拒绝。它不会请求系统权限或连接远端。接口保护测试只验证本机请求鉴权、来源校验和输入校验，不等于真实窗口或远端操作通过。实际测试记录见 `VERIFICATION.md`。

## MCP 远程 Agent 操控（推荐，基于 UU 网页主控）

借鉴 CrossDesk MCP 的远程 Agent 操控设计，本机 UU 网页主控（`127.0.0.1:18789`）现已内置轻量级 **Agent Broker**（`agent/broker.mjs`）和浏览器端零侵入协同控制条（Shadow DOM，不重构上游页面）。

### 1. 启动与连接流程

1. 启动本地 UU 网页主控（以及可选的原桥接跳转入口）：
   ```bash
   npm run start:web
   npm start
   ```
2. 在本机浏览器打开 <http://127.0.0.1:18787/web-controller>（或读取 `output/uu-web-local-access.json` 中的 `loginUrl`），自行登录 UU 并连接目标远端设备。
3. 在 MCP 客户端（Codex / Claude Code / OpenCode / T3 Code 等）中配置标准 stdio MCP Server：
   ```json
   {
     "mcpServers": {
       "uubridge": {
         "command": "node",
         "args": ["/path/to/uu-bridge/agent/mcp-server.mjs"]
       }
     }
   }
   ```
4. 默认连接处于**仅观察（Observe-Only）**状态。确认画面正常后，在网页右下角的 **Agent 协同控制条**点击「允许 Agent 控制」即可授权；随时点击「暂停接管」、点击「释放按键」，或**直接在远控画面上移动点击/敲键（默认触发自动暂停）**，即可立即中断正在执行的动作并收回控制权。

### 2. 核心工程机制

- **像素级原画采集与直通 UU 协议**：直接从 WebRTC `<video>` 按原分辨率裁剪/缩放导出 PNG（无任何网页 UI 干扰），并通过 `BrowserRemoteSession` 的 UU DataChannel 原生发送键鼠、中文 `text_input` 与剪贴板，不依赖本机系统 `CGEvent` 注入。
- **双通道鉴权隔离**：浏览器协同接口（`/__uubridge/agent/*`）仅认 `HttpOnly` 本地会话 Cookie；Agent 接口（`/__uubridge/mcp/*`）仅认 `output/uu-web-local-access.json`（mode `0600`）中的独立 `agentToken`。Agent 无法自行调用 `viewer-control` 授权或解除人类暂停；`uu_open_panel` 绝不向模型上下文泄露登录令牌或密码。
- **观测绑定与防错**：每次截屏签发不可变 `observation_id`、`generation`、`geometry_epoch`、`image_size` 与 `region`。所有动作坐标基于最近截图的像素空间并自动映射回源视频坐标；分辨率变化、切换显示器或重连会立即使旧观测失效。
- **幂等操作与高效序列**：`uu_action` 强制携带 `operation_id`（128 条 / 5 分钟缓存，参数冲突返回 `OPERATION_CONFLICT`），支持 1–8 步 `sequence` 连续动作，默认 `observe_after: true` 在浏览器端等待画面变化/稳定后直接随结果附带一帧最新 PNG。
- **长按租约防卡键**：`key_down` / `mouse_down` 具有 15 秒自动过期租约，超时、报错、切屏、断连或人类暂停都会自动执行 `releaseAllInputs()`。

### 3. MCP 工具列表

- `uu_open_panel`：检查本地 UU 网页主控状态并可选打开系统浏览器（不泄露令牌）。
- `uu_list_sessions` / `uu_get_session`：列出已连接设备或有界等待（≤25s）设备就绪。
- `uu_screenshot`：截取整屏或裁剪区域 PNG（返回独立 MCP `image` 块 + 观测元数据）。
- `uu_action`：执行单步动作（`click` / `double_click` / `move` / `mouse_down` / `mouse_up` / `scroll` / `drag` / `key_press` / `key_down` / `key_up` / `hotkey` / `type_text`）或 1–8 步 `sequence`。
- `uu_wait`：等待上次观测区域出现视觉变化（`changed`）或趋于稳定（`stable`）并返回最新截图。
- `uu_release_inputs`：立即释放所有长按键鼠并中止进行中的序列。
- `uu_set_control`：在人类已授权且未暂停范围内开关 Agent 控制（无法越权）。
- `uu_clipboard_get` / `uu_clipboard_set`：读写远端文本剪贴板（主动读取目前主要支持 macOS 被控端，Windows 依赖远端复制通知）。
- `uu_select_display`：切换远端多路视频源（多显示器）并使旧观测失效。
- `uu_disconnect`：断开远端设备连接并释放输入。

> 边界说明：UU 协议本身不提供远端 OS 原生无障碍树（AX/UIA）、锁屏状态查询或独立文件传输通道，因此不包含 CrossDesk 的 `desktop_automation` / `unlock` / `files` 工具。

### 4. Agent Skills（`SKILL.md`）

仓库的 `skills/` 目录提供两套遵循开放 `SKILL.md` 规范的 Agent 技能，可直接复制到 Claude Code / Cursor / Codex / Gemini CLI 等工具的技能目录，或打包上架至技能市场：

- **[`skills/uu-bridge-mcp/`](skills/uu-bridge-mcp/SKILL.md)**（配套操作技能）：配合本项目的 `uubridge` MCP Server 使用，约束 Agent 遵守“零凭证泄露、先观测后点击、图像像素坐标系、`operation_id` 幂等、尊重 `CONTROL_DENIED` / `HUMAN_PAUSED` 人工接管”等规则，并附 12 个工具与错误码速查表（`references/tool-reference.md`）。仅包含操作说明，不含第三方协议代码。
- **[`skills/hitl-gui-mcp-architect/`](skills/hitl-gui-mcp-architect/SKILL.md)**（通用架构与审计技能，不绑定网易 UU）：将本项目沉淀的人机协同 GUI MCP 工程不变量抽离为协议无关的通用指南，包含 7 条生产不变量、可复用 JSON Schema 与坐标投影/幂等缓存参考（`references/protocol-contract.md`）以及 20 项安全可靠性审计清单与最低测试矩阵（`references/security-audit-checklist.md`），适用于 WebRTC、VNC、RDP、Playwright、模拟器或原生 OS 自动化 MCP 的设计与审计。

## 原客户端桥接 Agent 接口（仅查看 / 本机验证窗口）

先在本机 `GET /api/session` 获取本次服务进程的令牌，其余接口使用 `X-UUBridge-Token` 请求头。

- `GET /api/status`：权限与客户端状态。
- `GET /api/windows`：可选 UU / 验证窗口。
- `POST /api/select`，`{"windowId":123}`：选定窗口，返回 `selectedId` 和 `selectionVersion`。
- `GET /api/frame?windowId=123&selectionVersion=1`：JPEG 截图，不落盘；响应头包含目标 ID 和版本。
- `POST /api/input`：仅供自带验证窗口使用。每次携带选定的 `windowId`、`selectionVersion`；`x`、`y` 是相对采集窗口的 0–1 坐标。选择已被其他页面改变时拒绝输入；真实 UU 返回 `UU_INPUT_UNSUPPORTED`。
- `POST /api/release`：携带当前 `windowId`、`selectionVersion`，释放鼠标并使该选择版本失效，阻止页面关闭后迟到的输入；继续操作需重新选择或读取最新版本。

例如点击：`{"windowId":123,"selectionVersion":1,"type":"click","x":0.5,"y":0.5,"button":"left"}`；文字、按键同样携带目标字段，再使用 `{"type":"text","text":"你好"}` 或 `{"type":"key","key":"Enter"}`。只提供发出指令的结果，不代表远端任务已完成；Agent 需要重新获取截图确认。

## 实现与边界

原客户端桥接使用 Swift + ScreenCaptureKit 单窗口截图、Core Graphics 验证窗口输入、Node 内置 HTTP 服务和原生网页。画面按需采集，默认约每 500ms 拉取一次，没有音频或高帧率串流。该桥接没有复制第三方实现；独立协议版主控保留上游 MIT 代码和目录结构。

采集窗口缩放保持比例，忽略阴影，输入按原始窗口坐标映射。窗口关闭、最小化、调整大小、UU 隐私模式或系统权限变化可能影响采集。后台合成事件与 UU 转发到远端的能力需单独验证，不能由本地验证窗口结果推定。

后台鼠标定位需要 Apple 未公开的 `CGEventSetWindowLocation` SPI 和事件窗口字段（参考 [WebKit 测试接口声明](https://github.com/WebKit/WebKit/blob/main/Tools/TestRunnerShared/spi/CoreGraphicsTestSPI.h)）。动态检查接口是否存在；不可用时明确报错。该做法在本机实测可用，但系统升级可能影响兼容性。没有复制或嵌入 WebKit 源码。

参考官方接口文档：[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)、[CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent)、[Model Context Protocol (MCP)](https://modelcontextprotocol.io/)。

## 参考项目与致谢

- **[ofoz/uu_web](https://github.com/ofoz/uu_web)**（基于 **[iola1999/uurc-web](https://github.com/iola1999/uurc-web)**，MIT License）：提供本地独立运行的 UU 网页主控协议实现。本项目通过 `scripts/setup-web.mjs` 拉取到 `vendor/uu-web/` 并在外层增加本机鉴权与最小 Agent 桥接适配，完整保留上游目录结构与 `LICENSE`。
- **[kunkundi/crossdesk](https://github.com/kunkundi/crossdesk)**（GPL-3.0 License）：本项目 `agent/` 下的 MCP 工具契约与人机协同安全设计（`observation_id` 观测绑定、`operation_id` 幂等缓存、1–8 步 `sequence` + `observe_after` 视觉等待、15 秒长按租约与一键释键、人类硬暂停不可越权）**仅参考其架构与协议思路，完全独立从零以 Node.js 实现，未复制、移植或链接任何 CrossDesk 源代码**。
- **[WebKit CoreGraphicsTestSPI.h](https://github.com/WebKit/WebKit/blob/main/Tools/TestRunnerShared/spi/CoreGraphicsTestSPI.h)**：仅参考其声明的 macOS 私有 SPI 函数签名，未复制或嵌入任何 WebKit 源码。

## 开源协议与免责声明

- **许可证**：本仓库原创代码与文档（`agent/`、`skills/`、`server.mjs`、`public/`、`native/`、`scripts/`、`integration/`、`test/`）采用 **[MIT License](LICENSE)** 开源；拉取至 `vendor/uu-web/` 的第三方网页主控遵循其原有的 MIT 许可证。
- **非官方声明**：本项目为个人开源实验与本地工具，与网易 UU 远程官方无任何隶属、合作或授权关系。
- **合规与安全边界**：仅限个人学习及在已获得明确授权的设备上本地使用（默认仅监听 `127.0.0.1`），不提取官方客户端凭证、不绕过系统权限授权。请勿将本工具用于未授权的远程访问，使用者需自行遵守当地法律法规及第三方软件服务条款。
