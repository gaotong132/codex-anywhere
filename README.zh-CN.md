# Codex Anywhere

[English](README.md) | 简体中文

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

> [!IMPORTANT]
> 这是一个非官方社区项目，与 OpenAI 无隶属关系，也未得到 OpenAI 的认可或背书。

## 功能与亮点

- **切换执行环境**：在同一个浏览器里选择个人电脑或 24×7 运行的无头 ECS 连接器。会话、未读状态、
  最近工作目录、附件和请求都按执行环境隔离，相同会话 ID 或路径不会串到另一台机器。
- **继续真实 Codex 会话**：浏览最近会话和 Markdown 历史，发送文字或图片，也可以在已有本机项目中
  新建任务。
- **跟随执行过程**：查看运行中和完成未读状态，以及进度、计划步骤、工具目的、执行时间和文件变更；
  右上角状态环会显示当前上下文用量，悬停或点击可查看 Token 明细，上下文压缩事件则保留在时间线中；
  已完成轮次会显示精简的工具汇总、配置变化、失败或中止原因。点击变更统计可以查看有界 unified diff；
  长会话按页加载。
- **随时补充下一步**：连接器持有的运行中任务可以追加文字；已有 Desktop 会话在支持时使用桌面投递。
  消息直接发送，Web 端不维护排队队列。
- **配置 Codex**：查看或修改模型、思考强度、快速模式和审批模式。无头连接器支持“请求批准”、
  “帮我批准”和由执行节点显式开放的“完全访问权限”；当前选择和新会话默认值按执行环境隔离。
- **在手机取回结果**：预览发送或生成的图片；在线打开回复中链接的 Markdown、源代码、配置和纯文本
  文件；查看带语法着色的代码与 Mermaid 图表；隔离打开 Codex 可视化；复制消息，并在确认后下载
  本机文件。下载时会尝试保持屏幕常亮，前台传输中断后可安全暂停并在重连时续传。
- **处理可转交的审批**：连接器发起并持有的轮次可以在 Web 端批准或拒绝；已经由 Codex Desktop 持有
  的审批仍需在电脑上处理。
- **断线自动恢复**：浏览器、转发服务和各连接器会自动重连并重新同步，避免重复发送已被接收的消息。
- **每个端点都要经过确认**：浏览器使用十分钟单次配对链接和持久设备密钥；连接器同时需要密钥和所有者
  明确批准。

Codex Anywhere 刻意保持小而专注：它不是多用户网关、通用远程 Shell、自动会话 fork 服务，也不会
托管会话内容。

### 回复中的本机文件链接

点击支持的本机文件链接，会直接在会话内打开只读预览：

| 文件 | 浏览器行为 |
| --- | --- |
| Markdown | 渲染 Markdown；Mermaid 代码块按需生成图表，相对文件链接仍可继续打开 |
| 常见源代码和配置文件 | 识别语言并按需加载语法着色器的代码预览 |
| 纯文本、日志、CSV、TSV | 支持横向滚动的纯文本预览 |
| 二进制、敏感或未识别文件 | 继续使用原有的确认下载流程，不做内联预览 |

文本预览只接受连接器配置根目录内、不超过 2 MiB 的普通 UTF-8 文件；`.env`、`.pem`、`.key` 等敏感
扩展名有意排除。预览页始终保留“下载”按钮；语言不可用或文件不适合高亮时，会安全回退为转义后的
纯代码文本。

### 按轮次查看代码变更

已完成回复显示文件变更统计时，点击即可打开该轮 Codex 产生的 unified diff。浏览器只在点击后请求；
连接器从已知会话的 rollout 中增量读取、严格隔离轮次，并且最多返回 512 KiB。超大 Diff 会明确标记
截断；无法恢复的旧轮次会安全失败，不会退化成可能混入其他修改的当前工作区 Diff。预览会显示新旧
行号和文件边界，并可在窄屏上按需开启自动换行。

### 上下文与时间线诊断

Codex 提供 Token 统计时，右上角活动状态环也会显示模型上下文窗口的当前用量；悬停或点击状态环可查看
准确 Token 数，高用量和临界用量会使用不同颜色。上下文压缩会作为独立时间线节点显示压缩次数，以及
可获得的压缩前后用量。已完成轮次会保留工具、命令、编辑和其他操作的精简计数，以及有界的模型配置
变化、失败或中止原因；这些汇总不会复制原始推理、工具参数或工具输出。

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
审批和按会话配置权限。Codex Anywhere 没有实现 ACP。

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
| 转发服务 | 参考服务只监听回环地址，容器降权运行，只保存设备信任记录并限制日志大小 |

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
产物，不进入仓库。仓库结构和协议约束参见[贡献指南](docs/CONTRIBUTING.zh-CN.md)。

## 社区

欢迎在 [GitHub Discussions](https://github.com/gaotong132/codex-anywhere/discussions) 分享部署经验和想法，
可复现的问题请提交到 [Issues](https://github.com/gaotong132/codex-anywhere/issues)。安全问题请按照
[安全说明](docs/SECURITY.zh-CN.md)私下报告。

## 许可证

[MIT](LICENSE)
