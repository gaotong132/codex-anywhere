# Codex Anywhere

[English](README.md) | 简体中文

[![CI](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="Codex Anywhere 可以通过手机浏览器查看并继续运行在自己电脑上的 Codex 会话" width="100%">
</p>

Codex Anywhere 是一个面向单用户、自托管场景的远程桥接工具，让你可以从手机或其他浏览器
查看并继续电脑上的 Codex 会话。Codex 和项目文件始终留在运行连接器的电脑上，你自己的
ECS/VPS 只提供轻量的远程入口。

> [!IMPORTANT]
> 这是一个非官方社区项目，与 OpenAI 无隶属关系，也未得到 OpenAI 的认可或背书。

## 功能与亮点

- **继续已有会话**：在手机上浏览最近的 Codex 会话、查看 Markdown 历史，并发送新的文字或图片消息。
- **跟随执行进度**：识别会话运行状态，自动刷新有用的助手进展，不展示内部思考和工具调用噪音。
- **下载本机文件**：助手回复中的本机文件可在确认后下载到手机或浏览器，不限制文件扩展名，也不会在转发服务上持久化。
- **长会话也能快速打开**：会话列表与历史记录按需增量加载，不会一次下载所有会话的完整内容。
- **针对手机操作优化**：可以在已有项目中新建会话、搜索最近会话并查看附件。
- **断线自动恢复**：手机网络切换或短暂断联后，浏览器和本机连接器会自动重连并同步当前状态。
- **自主托管，保护本机**：本机无需开放公网入站端口；转发服务不会持久化会话、附件或下载文件。
- **中英文界面**：通过运行时配置在 `zh-CN` 与 `en` 之间切换。

Codex Anywhere 定位为个人桥接工具，不提供自动 fork、通用远程 Shell 或多用户网关。

## 架构

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Codex Anywhere 架构：手机浏览器、自托管转发服务、主动出站连接的本机连接器与 Codex Desktop" width="100%">
</p>

```text
手机 / 浏览器 ── WS 或 WSS ──> 你的 ECS/VPS 转发服务
                                      ▲
本机连接器 ── 主动出站 WS/WSS ───────┘
     │
     └── Codex Desktop/CLI 与本机项目
```

浏览器和本机连接器都会主动连接转发服务。转发服务负责鉴权并在内存中转发实时消息，Codex
执行和文件访问仍在本机完成。

由 app-server 管理的轮次使用 Codex app-server JSON-RPC 协议，并可以接收原生增量事件；已有
桌面会话使用 Codex Desktop 任务工具投递消息，并通过同一条 WebSocket 自适应轮询历史尾部。
Codex Anywhere 没有实现 ACP。

## 部署

### 需要的资源

| 资源 | 要求 |
| --- | --- |
| 可访问的 ECS/VPS | 必需。轻量 Linux 主机即可，约 1 核 CPU、1 GB 内存和 10–20 GB 磁盘。 |
| 本机电脑 | 必需。运行 Codex Desktop/CLI、Node.js 22+、本机连接器和项目文件。 |
| 公网入口 | 可选组件。根据环境选择固定地址、域名、反向代理、VPN 或安全隧道。 |

不需要数据库、Redis、对象存储，也不需要为本机配置公网 IP、家庭网络端口映射或任何入站端口。
ECS/VPS 的作用是避免本机直接暴露到公网，并为浏览器和连接器提供一个稳定的汇合点。

代码同时支持 `ws://` 和 `wss://`，具体传输方式由部署者决定。经过公网或不受信网络时，强烈
推荐使用 `wss://` 或等效的安全隧道。

### 开始部署

1. 将转发服务部署到 ECS/VPS，并决定如何提供访问入口。完整步骤参见
   [正式部署指南](docs/deployment.md)。
2. 生成一个至少 32 位的随机 Token，并在转发服务和本机连接器中配置相同的值。
3. 在运行 Codex 的电脑上安装连接器。Windows 可以将其注册为登录后自动启动：

   ```powershell
   $token = Read-Host 'Bridge token' -AsSecureString
   .\scripts\install-connector.ps1 `
     -Token $token `
     -BridgeUrl 'wss://codex.example.com/ws' `
     -Workspace 'C:\workspace'
   ```

4. 在手机浏览器中打开转发服务地址，并输入相同的 Token。

将服务暴露到互联网前请阅读 [SECURITY.md](SECURITY.md)。ECS/VPS 上不需要安装 Codex，也不要
把项目文件复制到 ECS/VPS。

### 必要配置

| 环境变量 | 使用方 | 用途 |
| --- | --- | --- |
| `BRIDGE_TOKEN` | 转发服务和连接器 | 至少 32 位的共享密钥 |
| `BRIDGE_URL` | 连接器 | 转发服务 WebSocket 地址，支持 `ws://` 和 `wss://` |
| `CODEX_UI_LANGUAGE` | 转发服务 | Web 界面语言：`zh-CN` 或 `en` |

连接器默认使用当前目录。`-Workspace` 仅用于修改新会话的默认目录，并会自动成为允许访问的根目录；
只有需要开放多个互不相邻的本机目录时才需要 `-AllowedRoots`。安装器会把这些可选设置保存在仓库
之外，因此无需写进转发服务使用的 `.env` 文件。

完整配置见 [.env.example](.env.example) 和 [正式部署指南](docs/deployment.md)，其中包括代理信任、
网络访问和不受目录限制的文件下载选项。

## 本机开发

`http://127.0.0.1:3300` 只是同一台电脑上的冒烟测试地址，用于验证网页、转发服务和连接器是否
互通；它无法提供有实际意义的手机远程访问。正式使用必须部署上面的 ECS/VPS 转发服务。

要求：Node.js 22+，以及已完成登录认证的 Codex CLI。

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
$env:BRIDGE_TOKEN = 'replace-with-at-least-32-random-characters'
npm run server
```

在另一个终端运行：

```powershell
$env:BRIDGE_TOKEN = 'replace-with-the-same-token'
$env:BRIDGE_URL = 'ws://127.0.0.1:3300/ws'
npm run connector
```

打开 `http://127.0.0.1:3300` 并输入 Token。开发检查与构建命令：

```powershell
npm run check
npm run build
```

应用源码和测试统一使用严格 TypeScript。转发服务和连接器运行编译后的 JavaScript；Windows
启动器只会在 TypeScript 源码变化后重新构建，并保持单个 Node 连接器进程运行。

## 许可证

[MIT](LICENSE)
