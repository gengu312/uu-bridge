# 本机验证记录

日期：2026-11-15。

结论：浏览器与自带原生窗口之间的显示、点击和文字输入闭环已通过，真实 UU 窗口的 ScreenCaptureKit 采集也已通过。但原客户端桥接对真实 UU 的输入测试未通过，不能用该入口可靠控制远端；真实 UU 输入现已明确禁用。独立协议版网页主控位于 `vendor/uu-web`，需要用户网页登录后另行验证控制。

## 环境

- macOS 27.2.1，Apple Silicon。
- Node.js 24.22.3；本机 Swift 编译器。
- 官方 UU 4.46.0 已安装，进程运行；重新运行时识别到三个 UU 窗口。
- 重新运行时确认辅助功能和屏幕录制均已授权，无需再次请求。
- 服务运行在 `http://127.0.0.1:18787`，没有外部服务器、Docker 或运行时 npm 依赖。
- OpenChamber 项目列表已确认包含当前工作目录。

## 已通过

重新运行后进行了一次真实 UU 窗口的只读采集：`/api/frame` 返回 200，来源为 `screen-capture-kit`，JPEG 为 1920 × 1077、341891 字节。真实 UU 图像未保存到项目。没有向真实 UU 窗口发送点击或键盘事件。

`npm run build` 成功。

`npm test`：8 项测试全部通过，覆盖令牌、来源和 Host 校验、坐标校验、原生命令白名单、权限错误返回，以及不同窗口／选择版本的在途截图隔离。

`npm run verify:local` 已实际调用运行中的原生程序，并重复执行验证非空输入框场景：

- 原生按钮收到点击，计数真实增加。
- Unicode 中文、空格、表情及数字输入匹配。
- 普通 Backspace 生效。
- 目标原生应用保持后台。
- 过期选择版本的输入返回 409。
- HTTP 请求先发出 pointerdown 的部分 body，完成 release 后才补齐 body；迟到的按下返回 409。
- 本机验证画面返回 `X-Frame-Source: app-rendered-test`，带窗口 ID 和选择版本。

使用独立 Playwright 浏览器实际操作网页：

- 开始画面、开启输入控制，从缩放后的图片坐标点击原生按钮，计数从 2 增加到 3。
- 在图片中的输入框定位，从网页文本框发送 ` / 浏览器输入 🙂 456`，原生窗口实际收到插入文字。
- 在按钮处按下鼠标后直接关闭浏览器，原生收到释放，计数增加到 4。
- 最终原生输入框为 `UU Bridge 本地验证 🙂 123 / 浏览器输入 🙂 456`，应用 `active=false`。
- 独立验证浏览器已退出，桥接服务保持运行。

结果文件：

- `output/local-verification.json`：原生接口闭环结果。
- `output/local-verification.jpg`：验证窗口自身绘制的画面。
- `output/browser-verification.json`：浏览器操作后的真实原生状态。
- `output/playwright/bridge-verified.png`：已操作后的网页截图。

这些图像只含本项目自带的验证窗口，不是 UU 的真实远控画面。自有窗口通过 AppKit 绘制其视图，不使用系统屏幕采集，也不能证明 ScreenCaptureKit 链路通过。

## 已知限制与待验证

- 真实 UU 的 ScreenCaptureKit 截图已成功；与真实画面匹配的输入坐标、持续刷新耗时仍待验证。
- 用户已连接远端并确认官方 UU 的真实鼠标可操作；桥接后台输入没有带来远端响应。切换“使用主控端鼠标”并关闭“智能鼠标”也未解决。
- 后台 macOS 窗口的 Command+A 实测未生效；文字发送是插入当前光标位置。普通 Backspace 已验证，UU 会话内其他组合键需单独验证。
- 后台鼠标依赖 Apple 未公开的窗口定位 SPI；接口缺失会明确报错，系统升级可能影响兼容性。
- 当前按需拉取截图，默认约 500ms 一次，属于 Agent 操作验证原型，没有音频、高帧率视频或文件传输。

## 下一次验证

1. 通过本地入口进入独立协议版网页主控，由用户登录 UU。
2. 从协议版连接刚才那台设备，验证真实远端点击、文字、常用按键和断开。

## 2026-11-16：修复内嵌浏览器无画面

用户报告 UU 已打开但网页没有画面。排查确认后台真实截图约 100ms 返回 200；网页停在“已收到窗口截图，正在准备显示”，阻塞于离屏图片的 `decode()`。另发现上次所选的 UU 窗口已关闭并被新窗口替换。

修复：直接加载页面中的图片，以 `load` / `error` 及 5 秒超时判断结果，不再等待 `decode()`；用户主动开始后，后台页面也继续刷新；每 5 秒更新窗口列表，失效窗口会清空画面并提示重选，不自动转发到新窗口。仅查看的标签页退出时不再使其他页面的选择失效。减小桌面布局的最小高度，以适应内嵌面板。

验证：

- 在 OpenChamber 原内嵌面板中，`#frameInfo` 显示 `1920 × 1132`，图片 `display=block`、`visibility=visible` 且位于可视区域。
- 独立 Playwright 浏览器将 `decode()` 改成永不返回，并将 `document.hidden` 固定为 true：实际图片成功显示，至少刷新两帧，`decodeCalls=0`，输入控制保持关闭。
- `node --check public/app.js` 和 8 项接口回归测试通过。
- 没有保存真实 UU 截图，也没有发送真实远端输入。

## 2026-11-16：点击排查与方案边界

用户报告开启输入控制后仍无法点击。

已复现并修复一个前端丢事件问题：OpenChamber 的 Agent 点击合成 PointerEvent，而 `setPointerCapture` 对不存在的活动指针抛出 NotFoundError。旧代码因此没发出按下，只发出抬起。修复将指针捕获设为可选，并补充 window 层的抬起与取消释放。

使用独立的 `127.0.0.1:18788` 本机测试服务验证：修复前按钮计数 1→1，报 NotFoundError；修复后合成点击 1→2，正常鼠标点击 2→3，无异常。测试考虑 Retina 图像为逻辑窗口的两倍尺寸，使用归一化位置。该测试服务和浏览器验证会话已停止。

真实 UU 验证没有通过：

- 用户确认直接在官方客户端使用真实鼠标能够操作。
- 在远端桌面空白处进行右键菜单探测，进程投递没有可见响应。
- 试验过前台与系统事件流投递，没有获得可确认的成功；这些结果不能证明具体的内部过滤机制，也没有保留成自动抢占本机键鼠的功能。
- 用户重新连接后再次测试，以及更换鼠标模式后再次测试，仍没有响应。
- 用户使用修复后的桥接页面复测，明确反馈仍无法点击。

因此原客户端入口已改为查看用途：UI 禁用真实 UU 的输入，原生 API 返回 409 / `UU_INPUT_UNSUPPORTED`，自带测试窗口保留输入验证。根项目 9 项接口测试通过。用于检查局部画面的临时裁剪和系统输入探针已清理，未修改远端文件或设置。

替代方案：本机独立运行 `ofoz/uu_web`，基线提交 `6a118973f90ce55e448b596a19e40ac0a67c0fee`，MIT 许可证保留。通过 UU 协议传送键鼠，不依赖本机系统输入注入；需要在自建页面登录账号，不提取官方客户端凭证。服务仅绑定 `127.0.0.1:18789`，便捷入口为 `http://127.0.0.1:18787/web-controller`。登录和真实控制的结果将单独记录，构建成功不等于远控成功。


## 2026-11-24：基于 CrossDesk MCP 方案新增 UU 网页主控 Agent / MCP 控制层

参照 `kunkundi/crossdesk`（`mcp` 分支）的远程 Agent 架构，在不重构 `vendor/uu-web` 上游界面的前提下，新增了零外部依赖的本地 Agent Broker、标准 stdio MCP Server 以及浏览器端 Shadow DOM 协同控制条：

- 根目录新增：`agent/protocol.mjs`（键名映射、参数/序列/坐标严格校验）、`agent/broker.mjs`（SSE 命令调度、观测生命周期、128 条 / 5 分钟幂等操作缓存、15 秒长按租约自动释放、人类硬权限仲裁）、`agent/mcp-server.mjs`（12 个标准 MCP stdio 工具）、`test/agent.test.mjs`。
- `vendor/uu-web/local-run.mjs` 挂载 `/__uubridge/agent/*`（Cookie 鉴权）与 `/__uubridge/mcp/*`（独立 Bearer 鉴权），将 `agentToken` 写入 `output/uu-web-local-access.json`（mode `0600`）。
- `vendor/uu-web/frontend/src/localAgentBridge.ts`（仅在 `main.tsx` 增加 1 行启动，另在 `remoteSessionEventBridge.ts` 增加只读剪贴板观察者、`browserRemoteSession.ts` 增加 `getTargetPlatform()`）：从 `<video>` 按原分辨率裁剪缩放截屏、在本地完成 `changed`/`stable` 视觉等待、直通 `BrowserRemoteSession` 发送键鼠/文本/剪贴板，并提供右下角 Shadow DOM 协同控制条（默认仅观察，一键授权、暂停接管、手动操作画面自动暂停、紧急释放按键）。

验证结果：

- 根项目 `npm test`：13/13 全部通过（含原有 9 项桥接安全测试 + 新增 4 项协议/Broker/MCP/长按租约/真实 `local-run.mjs` 与真实 stdio MCP 子进程端到端隔离测试）。
- `vendor/uu-web` 前端构建 `npm run build -w frontend`（`tsc --noEmit && vite build && vite build --ssr && prerender`）：全部通过。
- `vendor/uu-web` ESLint（所有新增与修改文件）：0 错误 0 警告。
- `vendor/uu-web/frontend` 核心单测（`localAgentBridge.test.ts`、`useRemoteInputController.test.tsx`、`browserRemoteSession.input.test.ts`、`browserRemoteSession.clipboard.test.ts`）：47/47 全部通过。
- 注：全量运行上游 `vendor/uu-web` 前端测试时，`tests/app.remoteAssistance.test.tsx` 中 1 个上游基线用例（第 71 行断言取消协助后展示「已取消协助」）失败，其余 302/303 通过；该测试未加载 `main.tsx` / `localAgentBridge.ts`，为上游基线已有问题，非本次回归。
- 待验证（需用户自行操作）：在本地浏览器打开 `http://127.0.0.1:18787/web-controller` 登录 UU 并连接真实远端设备后，验证在右下角控制条点击「允许 Agent 控制」并通过 MCP 客户端实际操控远端画面、键鼠、文本输入和人工接管自动暂停。

### 2026-11-24 真机端到端实测通过（Apple Silicon macOS 被控端）

用户自行在本机浏览器登录 `http://127.0.0.1:18789` 并连接远端 Apple Silicon macOS 测试设备（`1920 × 1080`，`control` / `text` / `file` DataChannel 全部 `open`），授权 Agent 控制后，通过 `agent/mcp-server.mjs` 完成真实端到端操作闭环：

- `uu_list_sessions` / `uu_screenshot`：成功抓取 1920×1080 真实桌面原画（缩放 `1280 × 720` PNG，帧龄 3–149ms）。
- 人类权限保护：切窗时处于 `human_paused: true` 期间，Agent 未绕过人类暂停；用户点击「恢复 Agent」后变为 `control_allowed: true`。
- 鼠标 `click`：点击 Dock「访达」图标，82ms 内检测到画面变化，成功打开访达窗口。
- 复合 `sequence` + `key_press(SPACE)`：点击选中 `agent.sh` 并按空格弹出 Quick Look 预览窗口，完整显示脚本内容。
- 侧栏点击 + `double_click`：关闭预览、点击左侧「WorkSpace」、双击进入子目录浏览 6 个子文件夹。
- 应用启动 + `uu_wait(changed)`：点击 Dock「Google Chrome」图标，等待浏览器窗口出现并自动返回新帧。
- 4 步 `sequence`（`click` 新标签页 + `hotkey(META+L)` + 中文 `type_text("CrossDesk MCP 远程桌面")` + `key_press(ENTER)`）：709ms 内完成输入并成功加载 Google 搜索结果页。
- `scroll(down, ticks: 6)`：macOS 桌面滚轮方向正确，页面平滑向下滚动展示后续搜索结果。
- 随后修复了实战中发现的切窗误触问题：`localAgentBridge.ts` 的人工接管监听器现已忽略单独修饰键（`Meta`/`Control`/`Alt`/`Shift`）及 `Cmd+Tab` / `Cmd+H` 等系统切窗组合键。远端真实桌面截图未保存到仓库目录。
