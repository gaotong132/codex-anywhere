# Browser Agent 架构与验收

[English](browser-agent.md) | 简体中文

Browser Agent 已纳入 `main`，仍属于**实验性附加特性**，默认关闭，需要单独构建、安装插件并显式配置
Relay；页面控制还需配置 Connector 和 MCP。日常会话功能无需安装插件；其配置、交互和兼容性仍可能调整。
目标覆盖 PC Desktop、ECS CLI 及其他 Connector，浏览器是资源而不是执行环境。

## 用户路径

点击扩展图标 → 侧栏打开线上 Web → 选择环境和 Session → 直接对话，按需授权当前页。
聊天无需开启浏览器控制；授权前仍需在「页面控制设置」中为插件单独配对并配置 Connector/MCP。
设置只保留连接管理，环境与会话以聊天当前选择为准；侧栏上方确认目标并授权或撤销。工具栏固定图标配标签页专属小状态点。

保持一个手动授权的起始页，不开放任意多页绑定。侧栏点击授权时按需申请起始站点的可选权限，也用于
AI 通过 `open_link` 或普通链接点击打开的同源新页签，归原会话管理；
跨源链接、重定向或站点权限不足时，先打开并展示目标页，返回 `authorizationRequired`，不注入脚本、不创建授权；
用户只需在目标页完成登录及必要的页面授权。手动页签和网站自行 `window.open` 的弹窗不自动纳管。
多个受管页面由模型先列举再指定 `pageId`。

## 侧栏嵌入边界

`sidepanel.html` 是本地扩展外壳，聊天通过 `/extension/sidepanel` 加载线上 Web。Relay 只在此入口对
`BRIDGE_EXTENSION_ORIGINS` 中精确匹配的扩展设置 `frame-ancestors`；普通页面保留禁止嵌入策略。
Web 向父页面只发送版本化、绑定随机页面通道的当前环境/会话和在线状态；外壳同时验证来源窗口、站点、
序号和新鲜度。消息本身不能触发授权、传入浏览器目标或调用扩展 API，设备私钥不通过此接口传递。
外壳通过 `tabs` 权限读取当前窗口的活动标签页地址，用户点击授权时在该手势内请求具体站点的可选访问权限。
权限提示期间目标或会话变化会取消本次授权；后台在网络等待前捕获文档身份，并在授权前重新验证。
后台继续持有页面控制连接和授权，聊天关闭不主动撤销；切换聊天会话也不隐式转移已有授权。

## 模块

| 模块 | 职责 |
| --- | --- |
| `extension/src/connection.ts` | 独立设备配对、WS、复用现有 E2E 客户端、请求截止时间 |
| `extension/src/background.ts` | 选择与授权、文档绑定、同意恢复、重连、撤销、序号校验 |
| `extension/src/page-agent.ts` | 固定隔离脚本，快照、稳定引用、点击、输入、滚动 |
| `extension/src/managed-tabs.ts` | 仅创建并识别本次 AI 操作产生的子页；同源、文档身份、权限、截止时间校验 |
| `src/browser-control/session-broker.ts` | 每环境的 Session→浏览器授权路由；并发、超时、回包隔离 |
| `src/browser-control/local-endpoint.ts` | 仅 loopback 的令牌保护 IPC；私有状态文件 |
| `src/browser-control/mcp-server.ts` | 官方 SDK 的 stdio MCP，六个窄工具、固定 instructions、宿主身份校验 |
| Connector / Relay | 显式能力开关、加密请求/事件、精确扩展 Origin 白名单 |
| `web/src/browser-session-status.tsx` | 当前环境、当前 Session 的浏览器连接状态 |

复用现有已批准 `client` 设备角色及加密信封，而不是新增不兼容的第三种身份协议。扩展拥有独立设备密钥，
不共享 Web 身份，不把自身作为 Connector 列入环境。Bridge v4 不变；扩展要求 Connector 明确提供
`browserControl` 能力，未启用时不能授权。普通 Web Origin 校验保持原样。

## 可信调用者与隔离

标准 MCP 每次调用的 `_meta.x-codex-turn-metadata` 由 Codex 宿主填入 `thread_id`、`turn_id`。
本机 CLI 0.153.0 已通过真实临时任务验证。源码依据：
[MCP tool call](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs)、
[turn metadata](https://github.com/openai/codex/blob/main/codex-rs/core/src/turn_metadata.rs)。
这是宿主兼容性依赖，不承诺所有旧版本都有；缺失/矛盾则拒绝。工具 schema 不接受会话 ID、环境 ID 或任意脚本。

授权绑定环境、原 Session、认证设备、连接路由、grantId、tabId、documentId、origin。模型无法选择其他会话。
每 Session 最多一个起始页，可包含 AI 打开的同源子页；连接器总授权数有 64 页保护上限。
明确点击授权时，`browser.bind` 携带 `replaceExisting: true`：可替换同一认证设备的旧起始页，或整组页面
超过 45 秒无心跳的其他浏览器占位。先验证原 Session，再原子撤销旧树、取消在途操作并绑定新文档；新页心跳确认后才可操作。
并发验证同时按标签页和 Session 排序，迟到请求不能覆盖更新的选择。自动恢复不携带替换标记；恢复回退使用
`recoverOnly: true`，仅在 Session 和标签页均未被新授权占用时执行。连接器通过 `browserGrantReplacement` 宣告支持。
子页只能凭所属设备的在途开页操作登记，不能把模型传入的裸标签页 ID 当授权。每页最多一个在途操作；
多页时省略 `pageId` 安全拒绝，不默认操作第一个。撤销/重绑取消待处理请求，旧回包不能结束新请求。
只读请求也不回退到“最近任务”。Desktop 保持原写入端，连接器从不为了接浏览器而 resume 接管。

授权无 TTL；45 秒心跳只决定在线状态。网络重连旋转 grantId，不重放操作。浏览器 session storage 只保存
当前浏览器生命周期的同意；页面导航/关闭/手动撤销立即失效。页面内容只进入所属工具响应，不进入日志或持久缓存。
读写通过固定 `ISOLATED` 脚本和精确 `documentIds` 执行，页面指令不构成授权。

起始页撤销/导航/关闭会级联撤销子页；子页导航只撤销该子页。网络重连使用服务器已有授权恢复并旋转 ID，
不重复开页。连接器重启丢失子页来源记录时仅恢复起始页，子页需由 AI 重新打开。Chrome 站点权限不等于会话授权；
即使同站点权限已获批，其他页签也不在路由表中。站点权限可在 Chrome 扩展设置中移除。

## 模型指引与状态

MCP 初始化 instructions 明确区分 Anywhere 扩展和 Codex 内置 CUA 浏览器。模型先调用 `anywhere_browser_list_pages`，
再使用该列表中的页面 ID 快照/操作；CUA 空列表不能作为扩展离线的证据。Connector 在通过 Anywhere 发送的
PC、Headless 和 steer 消息中附加当前原会话的实时授权计数和工具指引，不另发一轮消息，不注入网页内容、URL 或密钥。
Desktop 直接输入的消息不经过 Connector，只能依靠已加载的 MCP instructions；需要空闲时重新加载 MCP。

指引要求模型直接完成用户任务所需的导航、搜索、普通点击/输入，并验证结果；遇到实际登录、验证码、新权限
或超出任务范围的操作才暂停。宿主 MCP 审批拒绝与浏览器离线、页面授权、网站登录分别诊断，不凭“登录”链接猜测登录态。
Codex `approval_policy=never` 会拒绝需要提示的写工具；按扩展说明为四个具体写工具配置 `approval_mode="approve"`，
不伪造只读标注、不改变其他 MCP 或全局审批策略。旧版消息后缀仍能被历史解析器识别并隐藏。

Web 标记「浏览器已授权」，提示区区分页面心跳与最近实际工具调用成功时间；没有工具调用证据时显示尚未验证，
不声称模型已经加载工具。此轮新功能需更新 Connector/MCP、Web 和扩展；不会因修改代码自动部署现网。

## 验证与发布门槛

- 2026-09-04 分支增量（未部署）：`npm run check` 307 项、`npm run test:extension` 10 项通过，Web/Node/扩展构建通过。
  Chrome for Testing 151 实际加载原始构建，无 Manifest/CSP/运行时错误；子页测试使用相同 JS 构建和独立临时配置，
  仅在测试清单副本预授予 `127.0.0.1` 权限，验证真 WS/E2E、真实子页创建/读取、跨源拒绝、手动页签隔离和起始页刷新级联撤销。
  此测试不代表原生可选权限弹窗已人工验收，也不代表 PC/ECS 现网已升级或模型工具选择已完成实测。
- 已实现自动测试：严格输入、身份伪造、不同任务/设备拒绝、无十分钟超时、心跳离线、在途取消、迟到回包、
  写操作超时不重试、MCP SDK/IPC；构建后 worker 配对与真 WS/E2E 路由、页面读/点击/输入、旧引用、页面变更和重试。
- 已跑真实 Codex 临时任务 → 新 MCP → 私有 IPC → 对应 Session broker；页面侧为明确标注的合成 fixture。
- 2026-09-04 已完成真实 Chrome for Testing 扩展、PC 原会话 Desktop 读取、ECS 会话读写与 Web 单次审批、
  配对/切环境/刷新重连、撤销和跨会话/环境拒绝，详见[部署验收记录](browser-rollout-2026-09-04.md)。
- 待覆盖日常 Chrome/Edge 配置文件、多浏览器、长时间休眠唤醒、worker 强制更新、公司代理故障和
  全部 PC 写操作审批组合；不将当前固定测试页验收扩大成所有场景均已验证。
- 在空闲测试环境注册/加载 MCP；先在固定测试页验收，绝不向业务任务发送测试消息。由所有者指定后才部署/发布。

安装、配置与限制见[扩展说明](../extension/README.zh-CN.md)。

## 后续

补齐真实浏览器验收、增量 UI 状态与审批体验，再评估更复杂页面交互。企业代理的 HTTPS 备用传输
是独立需求；扩展不获得绕过公司网络策略的能力。浏览器电脑仍须开机，ECS 的 24×7 只保证执行节点可用。
