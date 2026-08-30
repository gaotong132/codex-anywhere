# Codex Anywhere

[English](README.md) | 简体中文

[![CI](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="Codex Anywhere 可以通过手机浏览器查看并继续运行在自己电脑上的 Codex 会话" width="100%">
</p>

Codex Anywhere 是一个面向单用户、自托管场景的 Codex Web 桥接工具。你可以在手机上跟进任务、继续
会话、发送图片并取回生成文件，同时不需要把自己的电脑暴露到公网。Codex 和项目文件留在运行连接器
的电脑上，由你控制的小型转发服务提供远程会合点。

> [!IMPORTANT]
> 这是一个非官方社区项目，与 OpenAI 无隶属关系，也未得到 OpenAI 的认可或背书。

## 功能与亮点

- **继续真实 Codex 会话**：浏览最近会话和 Markdown 历史，发送文字或图片，也可以在已有本机项目中
  新建任务。
- **跟随执行过程**：查看运行中和完成未读状态，以及进度、计划步骤、工具目的、执行时间和文件变更；
  长会话按页加载。
- **随时补充下一步**：连接器持有的运行中任务可以追加文字；已有 Desktop 会话在支持时使用桌面投递。
  消息直接发送，Web 端不维护排队队列。
- **配置 Codex**：在当前模型支持时，查看或修改模型、思考强度和快速模式。
- **在手机取回结果**：预览发送或生成的图片，隔离打开 Codex 可视化，复制消息，并在确认后下载回复中
  链接的本机文件。
- **处理可转交的审批**：连接器发起并持有的轮次可以在 Web 端批准或拒绝；已经由 Codex Desktop 持有
  的审批仍需在电脑上处理。
- **断线自动恢复**：浏览器、转发服务和本机连接器会自动重连并重新同步，避免重复发送已被接收的消息。
- **每个端点都要经过确认**：浏览器使用十分钟单次配对链接和持久设备密钥；连接器同时需要密钥和所有者
  明确批准。

Codex Anywhere 刻意保持小而专注：它不是多用户网关、通用远程 Shell、自动会话 fork 服务，也不会
托管会话内容。

## 架构

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Codex Anywhere 架构：手机浏览器、自托管转发服务、主动出站连接的本机连接器与 Codex Desktop" width="100%">
</p>

```text
手机 / 浏览器 ── WS 或 WSS ──> 你的 ECS/VPS 转发服务
                                      ▲
本机连接器 ── 主动出站 WS/WSS ───────┘
     │
     └── Codex app-server / Desktop 与本机项目
```

两端都会主动连接转发服务。应用请求、响应、事件、预览和文件分块通过经过身份验证的端到端加密通道
传输；转发服务只负责设备鉴权和密文路由，不保存会话数据库。

连接器会启动自己的 Codex app-server，并管理它能够持有的会话，这类轮次支持原生事件、追加指令、
停止和 Web 审批。已有 Desktop 会话使用桌面投递和有界自适应历史轮询；Desktop 已持有的审批不能
转交。Codex Anywhere 没有实现 ACP。

## 安全概览

<p align="center">
  <img src="docs/assets/security-model.svg" alt="Codex Anywhere 安全设计：多层设备认证、自托管转发服务信任边界，以及只在本机执行的 Codex 和文件访问" width="100%">
</p>

| 边界 | 当前防护 |
| --- | --- |
| 浏览器访问 | 单次配对后使用已批准的 Ed25519 设备身份；不存在共享浏览器登录 Token |
| 应用流量 | 浏览器和连接器之间使用经过身份验证的 X25519 交换与 XChaCha20-Poly1305 加密 |
| 本机电脑 | 只建立出站连接；Windows 连接器凭据使用当前用户 DPAPI 保护 |
| 文件 | 受根目录限制的预览、明确下载确认、短时能力凭证和隔离可视化 |
| 转发服务 | 参考服务只监听回环地址，容器降权运行，只保存设备信任记录并限制日志大小 |

转发服务仍是可信基础设施：它负责提供 Web 代码和管理设备信任，也能观察路由元数据、时间和密文
大小。端到端加密不能消除转发主机、浏览器配置或连接器电脑失陷后的风险。直接使用 `ws://` 时，应用
帧仍会加密，但 Web 分发、配对和元数据不受保护；经过不可信网络时优先使用 WSS、VPN 或安全隧道。

完整威胁边界和泄露处理方式参见[安全策略](docs/SECURITY.zh-CN.md)。

## 部署

你需要：

- 一台可访问的 Linux ECS/VPS，安装 Git、Docker Engine 和 Docker Compose v2；
- 一台运行 Codex Desktop/CLI 的 Windows 电脑，安装 Node.js 22+、Git 和 PowerShell；
- 一个浏览器可以访问的入口。域名、证书和反向代理可选；经过公网或不可信网络时推荐 WSS。

启动转发服务：

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
./scripts/relay.sh setup
```

随后安装 Windows 连接器，用 `./scripts/relay.sh approve` 批准连接器，再通过
`./scripts/relay.sh pair <公网地址>` 生成浏览器配对链接。完整四步流程和日常维护命令参见
[部署指南](docs/deployment.zh-CN.md)。

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

## 许可证

[MIT](LICENSE)
