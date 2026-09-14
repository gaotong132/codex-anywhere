# Codex Anywhere

[English](README.md) | 简体中文

文档对应 **v0.3.0（2026-09-12）** · [发布与升级](docs/release-0.3.0.zh-CN.md) · [文档索引](docs/README.zh-CN.md)

[![CI](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml)
[![Version](https://img.shields.io/github/v/tag/gaotong132/codex-anywhere?sort=semver)](https://github.com/gaotong132/codex-anywhere/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/readme-hero.png" alt="Codex Anywhere 可以通过手机浏览器跟进 Codex、预览链接的源文件，并继续运行在自己电脑上的会话" width="100%">
</p>

Codex Anywhere 是一个面向单用户、自托管场景的 Codex Web 桥接工具。你可以在手机上跟进任务、继续
会话、发送图片、预览回复中链接的源文件并取回生成文件，同时不需要把个人电脑暴露到公网。Codex 和
项目文件留在当前选择的执行节点上，由你控制的小型转发服务提供远程会合点。

Codex Anywhere 专注个人使用场景，会话保存在执行节点上；不提供多用户托管、通用远程 Shell 或自动会话 fork。

> [!IMPORTANT]
> 这是一个非官方社区项目，与 OpenAI 无隶属关系，也未得到 OpenAI 的认可或背书。

## 功能与亮点

- **切换执行环境**：在同一个浏览器里选择个人电脑或 24×7 无头 ECS 节点。会话、未读状态、最近工作目录、
  附件和请求按环境隔离，操作始终发送到当前选择的机器。
- **继续真实会话**：浏览、重命名和继续已有 Codex 会话，也可以在本机项目中新建任务。历史支持 Markdown，
  长会话先显示最新内容，向上浏览时加载更早记录，并保持阅读位置。
- **跟随任务进展**：查看运行状态、未读提醒、进度、计划、工具用途和执行耗时。已完成轮次保留操作汇总、
  配置变化及失败或中止原因；自动任务报告保留完整正文，并过滤重复通知与内部字段。
- **随时补充指令**：向运行中的任务追加文字，已有 Desktop 会话在支持时使用桌面投递。
  当前连接器持有的轮次可直接在 Web 停止；消息直接发送，无需维护 Web 消息队列。
- **配置模型与权限**：选择模型、思考强度、快速模式和审批模式，包括所选节点提供的 GPT-6 Astra、Max 和 Ultra。
  无头节点支持“请求批准”“帮我批准”，以及由节点显式开放的“完全访问权限”；设置和新任务默认值按环境保存。
- **回答任务提问**：通过问题卡片选择建议答案或填写自己的回答，支持 `request_user_input_async`。
  已回答状态与 Desktop 同步，完整问答可展开查看；回答不会清空聊天草稿，预选答案也不会自动提交。
- **处理任务审批**：在 Web 批准或拒绝连接器持有轮次中的审批请求。
  已由 Codex Desktop 持有的审批仍在电脑上处理，避免跨端误操作。
- **粘贴和上传截图**：在聊天框或新任务中按 Ctrl+V / ⌘+V 粘贴截图，也可选择 PNG、JPEG、WebP 文件。
  每条消息支持一张图片，发送前可预览；上传分别显示准备状态、按字节计算的发送进度和接收确认。
- **预览图片与本机文件**：放大查看发送或生成的图片，直接打开回复中的 Markdown、源码、配置、日志和 SVG，
  支持语法着色、Mermaid 图表及隔离可视化。历史生成图片可从所选节点恢复预览，前提是原图仍在。
- **查看轮次代码变更**：点击文件变更统计，按需查看该轮 Codex 产生的 Diff，包括文件边界、新旧行号和窄屏换行。
  超大内容明确标记截断，无法恢复的旧轮次不会混入当前工作区的其他修改。
- **掌握上下文用量**：状态环展示 Codex 提供的上下文用量和 Token 明细。时间线保留压缩过程、等待耗时与完成状态，
  并在可用时显示压缩前后用量，方便跟进长任务。
- **取回生成结果**：复制回复，在确认后下载当前节点上的文件；预览中也可直接进入下载。
  下载会尝试保持屏幕常亮，前台传输中断后可安全暂停，并在已批准的浏览器重连后续传。
- **授权浏览器操作（实验性附加特性）**：可选插件在侧栏复用聊天与当前任务，完成一次配对后单独授权页面，
  支持快照、截图、缩放、点击、输入、滚动和打开链接，并跟随新页签。默认关闭，安装和限制见
  [扩展使用说明](extension/README.zh-CN.md)与[开发方案](docs/browser-agent.zh-CN.md)。
- **断线自动恢复**：浏览器、Relay 和连接器自动重连并重新同步，避免重复发送已接收的消息。
  切换网络后可以继续跟进原任务。
- **确认每个端点**：浏览器通过十分钟单次链接配对，之后使用持久设备密钥；连接器还需密钥和所有者明确批准。
  浏览器与连接器之间的应用流量经过端到端加密，个人电脑只建立出站连接。

## 架构

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Codex Anywhere 架构：手机浏览器通过自托管转发服务选择主动出站的 Windows 或无头 ECS 连接器" width="100%">
</p>

```text
手机 / 浏览器 ── WS 或 WSS ──> 你的 ECS/VPS 转发服务
                                      ▲       ▲
Windows 连接器 ── 主动出站 WSS ───────┘       └── 回环 WS ── ECS 连接器
      │                                                       │
      └── Codex Desktop / app-server 与本机项目               └── Codex CLI app-server 与 ECS 工作区
```

每个连接器都有稳定的路由，并主动连接转发服务。浏览器只向当前选择的路由建立经过身份验证的端到端
加密通道；应用请求、响应、事件、预览和文件分块都留在该通道内。转发服务只负责设备鉴权和密文路由，
不保存会话数据库。

每个连接器都会启动自己的 Codex app-server。Windows 连接器使用 `desktop` 模式：已有 Desktop 会话
继续使用桌面投递和有界自适应历史轮询。Linux/ECS 连接器使用 `headless` 模式，由 app-server 管理新建
和恢复的会话，因此无需桌面登录也能持续工作。连接器持有的轮次支持原生事件、追加指令、停止、Web
审批和按会话配置权限。Desktop 活动状态属于可选补全：会话列表先直接返回 app-server 数据，再在后续
轮询合并短期 Desktop 状态缓存，因此 Desktop 桥不可用或响应慢不会阻塞启动。Codex Anywhere 没有实现 ACP。

## 安全概览

<p align="center">
  <img src="docs/assets/security-model.svg" alt="Codex Anywhere 安全设计：多层设备认证、自托管转发服务信任边界，以及留在当前执行节点的 Codex 和文件" width="100%">
</p>

| 边界 | 当前防护 |
| --- | --- |
| 浏览器访问 | 单次配对后使用已批准的 Ed25519 设备身份；不存在共享浏览器登录 Token |
| 应用流量 | 浏览器和连接器之间使用经过身份验证的 X25519 交换与 XChaCha20-Poly1305 加密 |
| 执行节点 | 只建立出站连接；Windows 凭据使用当前用户 DPAPI，Linux 服务使用权限为 0600 的环境文件和设备身份 |
| 文件 | 受根目录限制的图片和有界文本/代码/Markdown 预览、绑定已批准设备和单个文件的可续传下载，以及隔离可视化 |
| 转发服务 | 参考服务只监听回环地址，容器降权运行，私有保存设备信任及连接活跃记录，并限制日志大小 |

转发服务仍是可信基础设施：它负责提供 Web 代码和管理设备信任，也能观察路由元数据、时间和密文
大小。端到端加密不能消除转发主机、浏览器配置或连接器电脑失陷后的风险。直接使用 `ws://` 时，应用
帧仍会加密，但 Web 分发、配对和元数据不受保护；经过不可信网络时优先使用 WSS、VPN 或安全隧道。

完整威胁边界和泄露处理方式参见[安全策略](docs/SECURITY.zh-CN.md)。

## 部署

你需要：

- 一台可访问的 Linux ECS/VPS，安装 Git、Docker Engine 和 Docker Compose v2；如果它还要作为 24×7
  执行节点，则需要 Node.js 22+ 和已登录的 Codex CLI；
- 一台运行 Codex Desktop/CLI 的 Windows 电脑，安装 Node.js 22+、Git 和 PowerShell；
- 一个浏览器可以访问的入口。域名、证书和反向代理可选；经过公网或不可信网络时推荐 WSS。

启动转发服务：

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
./scripts/relay.sh setup
```

随后安装一个或多个连接器，用 `./scripts/relay.sh approve` 逐个批准，再通过
`./scripts/relay.sh pair <公网地址>` 生成浏览器配对链接。[部署指南](docs/deployment.zh-CN.md)包含
Windows/Desktop、Linux/ECS 无头模式、环境切换和日常维护命令。

参考服务只监听 `127.0.0.1:3300`，不要直接把该端口暴露到公网。除非由入口代理、VPN 或隧道提供
远程入口，否则它只适合同一台电脑上的开发调试。

## 开发

要求：Node.js 22+，以及已完成登录认证的 Codex CLI。

```bash
npm ci
npm run check
npm run build
```

应用源码和测试统一使用严格 TypeScript。`build/` 中的 JavaScript 和 `dist/` 中的 Web 资源属于构建
产物，不进入仓库。仓库结构和协议约束参见[贡献指南](docs/CONTRIBUTING.zh-CN.md)，版本重点参见
[更新日志](CHANGELOG.zh-CN.md)。

## 社区

欢迎在 [GitHub Discussions](https://github.com/gaotong132/codex-anywhere/discussions) 分享部署经验和想法，
可复现的问题请提交到 [Issues](https://github.com/gaotong132/codex-anywhere/issues)。安全问题请按照
[安全说明](docs/SECURITY.zh-CN.md)私下报告。

## 许可证

[MIT](LICENSE)
