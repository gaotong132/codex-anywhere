# Browser Agent 架构与验收

[English](browser-agent.md) | 简体中文

分支 `codex/browser-agent`，稳定基线 `v0.2.1`。当前实现为可配置的会话浏览器控制开发版；不自动发布、
打 Tag、合并 main 或重启现网。目标覆盖 PC Desktop、ECS CLI 及其他 Connector，浏览器是资源而不是执行环境。

## 用户路径

扩展连接 Anywhere → 选择环境 → 选择已有 Session → 授权当前页 → 在 Anywhere 原会话继续对话。
主界面不再放本机读取/停止实验按钮或十分钟倒计时。撤销/换会话在更多菜单，工具栏固定图标配标签页专属小状态点。

## 模块

| 模块 | 职责 |
| --- | --- |
| `extension/src/connection.ts` | 独立设备配对、WS、复用现有 E2E 客户端、请求截止时间 |
| `extension/src/background.ts` | 选择与授权、文档绑定、同意恢复、重连、撤销、序号校验 |
| `extension/src/page-agent.ts` | 固定隔离脚本，快照、稳定引用、点击、输入、滚动 |
| `src/browser-control/session-broker.ts` | 每环境的 Session→浏览器授权路由；并发、超时、回包隔离 |
| `src/browser-control/local-endpoint.ts` | 仅 loopback 的令牌保护 IPC；私有状态文件 |
| `src/browser-control/mcp-server.ts` | 官方 SDK 的 stdio MCP，四个窄工具，宿主身份校验 |
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
每 Session 最多一个授权标签页；每授权最多一个在途操作。撤销/重绑取消待处理请求，旧回包不能结束新请求。
只读请求也不回退到“最近任务”。Desktop 保持原写入端，连接器从不为了接浏览器而 resume 接管。

授权无 TTL；45 秒心跳只决定在线状态。网络重连旋转 grantId，不重放操作。浏览器 session storage 只保存
当前浏览器生命周期的同意；页面导航/关闭/手动撤销立即失效。页面内容只进入所属工具响应，不进入日志或持久缓存。
读写通过固定 `ISOLATED` 脚本和精确 `documentIds` 执行，页面指令不构成授权。

## 验证与发布门槛

- 已实现自动测试：严格输入、身份伪造、不同任务/设备拒绝、无十分钟超时、心跳离线、在途取消、迟到回包、
  写操作超时不重试、MCP SDK/IPC；构建后 worker 配对与真 WS/E2E 路由、页面读/点击/输入、旧引用、页面变更和重试。
- 已跑真实 Codex 临时任务 → 新 MCP → 私有 IPC → 对应 Session broker；页面侧为明确标注的合成 fixture。
- 待实际安装验收：Chrome/Edge、原有 Desktop UI Session、新/已有 ECS Session、两环境同 ID、多浏览器、
  休眠唤醒、worker 强制停止/更新、代理故障与设备撤销。没有这些实测，不宣称生产可用。
- 在空闲测试环境注册/加载 MCP；先在固定测试页验收，绝不向业务任务发送测试消息。由所有者指定后才部署/发布。

安装、配置与限制见[扩展说明](../extension/README.zh-CN.md)。

## 后续

补齐真实浏览器验收、增量 UI 状态与审批体验，再评估多标签页和更复杂页面交互。企业代理的 HTTPS 备用传输
是独立需求；扩展不获得绕过公司网络策略的能力。浏览器电脑仍须开机，ECS 的 24×7 只保证执行节点可用。
