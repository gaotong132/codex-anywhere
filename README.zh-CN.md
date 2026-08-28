# Codex Anywhere

[English](README.md) | 简体中文

[![CI](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="Codex Anywhere 可以通过手机浏览器查看并继续运行在自己电脑上的 Codex 会话" width="100%">
</p>

通过手机或浏览器查看并继续运行在自己电脑上的 Codex 会话。
Codex Anywhere 面向单用户自托管场景，项目文件与 Codex 执行过程始终保留在运行连接器的电脑上。

> [!IMPORTANT]
> 这是一个非官方社区项目，与 OpenAI 无隶属关系，也未得到 OpenAI 的认可或背书。

## 实际部署方式与资源依赖

Codex Anywhere 的实际使用架构依赖一台具有公网入口的 ECS/VPS。
`http://127.0.0.1:3300` 只是同一台电脑上的开发冒烟测试地址：它只能验证网页、转发服务和
连接器能否互通，对手机跨网络访问没有实际意义，也不是推荐的部署方式。

正式使用需要以下资源：

| 资源 | 实用基线 | 用途 |
| --- | --- | --- |
| 公网 ECS/VPS | Linux、1 核 CPU、1 GB 内存、10–20 GB 磁盘、公网 IPv4/EIP | 只运行轻量转发服务与 TLS 反向代理 |
| 域名 | 一个独立的 DNS A 记录 | 为浏览器和连接器提供稳定入口 |
| HTTPS 证书 | 受信任的 TLS 证书，例如 Let's Encrypt | 加密 Token 和中继流量 |
| 服务端软件 | Docker Engine、Compose v2、Nginx、证书申请工具 | 隔离并安全发布转发服务 |
| 本机电脑 | Codex Desktop/CLI、Node.js 22+、可出站访问 TCP 443 | 保存项目并实际执行 Codex 任务 |

不需要数据库、Redis、对象存储，也不需要为本机电脑配置公网 IP、端口映射或任何入站端口。
手机浏览器和本机连接器都只主动向 ECS 建立出站 TLS 连接。

引入 ECS 的首要目的，是保护个人隐私并缩小攻击面：家庭/办公电脑无需暴露到公网，项目文件
始终留在本机，转发服务也不会主动持久化会话或传输文件。但 ECS 仍属于受信任组件，并非无法
查看内容的端到端加密盲中继：TLS 会在 ECS 上终止，ECS 的 root 管理员或云平台理论上可以读取
进程内存。因此应使用自己控制的 ECS，做好主机加固，尽量关闭访问日志，并把 ECS 纳入整体信任边界。

## 主要功能

- 列出最近的 Codex 会话，无需加载每个会话的全部内容。
- 分页查看 Markdown 历史记录，并跟随正在运行的桌面会话。
- 向已有会话发送文本及一张 JPG、PNG 或 WebP 图片。
- 在已配置的项目目录中创建新会话。
- 经浏览器明确确认后，下载助手回复中链接的本机文件。
- 在短暂网络故障后自动恢复浏览器、转发服务与本机连接器的连接。
- 通过运行时配置在中文与英文完整界面之间切换。

本项目不会自动 fork 会话，不会在转发服务上持久化保存会话，也不会开放通用远程 Shell。

## 架构

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Codex Anywhere 架构：手机浏览器、自托管转发服务、主动出站连接的本机连接器与 Codex Desktop" width="100%">
</p>

ECS 上的转发服务仅在内存中完成鉴权与实时帧转发。由 app-server 管理的新任务可以接收原生增量事件；对于桌面应用拥有的已有会话，则通过同一条 WebSocket 自适应轮询 rollout 尾部：内容变化期间约每 1.5 秒一次，静止时约每 6 秒一次。

Codex Anywhere 对 app-server 会话使用 Codex app-server JSON-RPC 协议，对已有桌面会话使用 Codex Desktop 任务工具完成消息投递。本项目没有实现 ACP。

## 默认安全措施

- 至少 32 位的随机 Bridge Token 在首个加密 WebSocket 帧中发送，绝不会放入 URL。
- 本机连接器拒绝远程明文 `ws://`：只有回环开发调试允许使用 `ws://`，ECS 部署必须使用
  `wss://`。
- 浏览器 WebSocket 升级请求必须来自相同的 Web Origin。
- 针对同一客户端 IP 的连续鉴权失败会被临时锁定。
- 转发服务会拒绝不支持的 HTTP 方法与畸形路径，使用仅限当前主机的 CSP，并限制 WebSocket
  帧大小。
- Codex 高权限操作仍需人工批准。
- 连接器的网络访问默认关闭。
- 项目访问与本机文件下载默认限制在 `CODEX_ALLOWED_ROOTS` 中。
- 每次下载都需要确认，并使用短期有效、仅限单个文件且绑定客户端的能力凭证。
- 转发服务不存储附件或下载文件。提供的容器采用只读文件系统、删除全部 Linux capabilities、
  禁止提权、限制进程数、轮转日志，并且只把 3300 端口绑定到 ECS 回环地址。

本项目不是经过加固的多租户网关。请仅供一个受信任用户使用，并在暴露至互联网前阅读 [SECURITY.md](SECURITY.md)。

## 正式部署

准备好上述资源后，按照 [docs/deployment.md](docs/deployment.md) 部署。支持的实际拓扑为：

```text
手机/浏览器 ── HTTPS/WSS ──> 你的 ECS（Nginx :443 → 转发服务 127.0.0.1:3300）
                                  ▲
本机 Connector ── 主动出站 WSS ──┘
        │
        └── Codex Desktop/CLI 与本机项目文件
```

不要公开 3300 端口，不要对远程 IP 或域名使用 `ws://`，也无需在 ECS 上安装 Codex 或复制项目文件。

## 本机开发冒烟测试

要求：Node.js 22 或更高版本，以及已完成登录认证的 Codex CLI。

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
$env:BRIDGE_TOKEN = "replace-with-at-least-32-random-characters"
npm run server
```

在另一个终端中运行：

```powershell
$env:BRIDGE_TOKEN = "replace-with-the-same-token"
$env:BRIDGE_URL = "ws://127.0.0.1:3300/ws"
$env:CODEX_WORKSPACE = "C:\workspace"
$env:CODEX_ALLOWED_ROOTS = "C:\workspace"
npm run connector
```

打开 `http://127.0.0.1:3300` 并输入相同的 Token。这个回环地址只能由同一台电脑访问，仅用于
开发和调测；它不是实际部署方式，也无法提供有意义的手机远程访问。正式使用时必须按照
[docs/deployment.md](docs/deployment.md)，把转发服务部署到具有域名和 HTTPS 的 ECS 上。

## 配置

### 转发服务

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BRIDGE_TOKEN` | 必填 | 共享密钥，至少 32 个字符 |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3300` | HTTP 监听端口 |
| `BRIDGE_TRUST_PROXY` | `0` | 信任 Nginx 的 `X-Real-IP`；仅在该代理之后启用 |
| `CODEX_UI_LANGUAGE` | `zh-CN` | Web 界面语言：`zh-CN` 或 `en`；修改后需重启转发服务 |

### 本机连接器

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BRIDGE_TOKEN` | 必填 | 与转发服务相同的共享密钥 |
| `BRIDGE_URL` | `ws://127.0.0.1:3300/ws` | 仅供开发的回环默认值；正式环境必须使用 `wss://你的域名/ws` |
| `BRIDGE_DEVICE_ID` | `personal-pc` | 连接器标识 |
| `CODEX_BIN` | `codex` | Codex CLI 命令或路径 |
| `CODEX_WORKSPACE` | 当前目录 | 默认项目根目录 |
| `CODEX_ALLOWED_ROOTS` | `CODEX_WORKSPACE` | 会话和下载可使用的根目录，多个路径使用操作系统分隔符 |
| `CODEX_ALLOW_ANY_FILE_DOWNLOAD` | `0` | 仅在明确需要不受限制的本机下载时设为 `1` |
| `CODEX_NETWORK_ACCESS` | `0` | 仅在 Codex 任务确实需要网络访问时设为 `1` |

### Windows 登录后自动启动

安装程序使用当前用户作用域的 Windows DPAPI 保存 Token，并将非敏感配置存放在 `%LOCALAPPDATA%\PersonalCodexBridge`。为了保证升级时不会丢失已有凭据，该旧版内部目录名会继续保留。

```powershell
$token = Read-Host 'Bridge token' -AsSecureString
.\scripts\install-connector.ps1 `
  -Token $token `
  -BridgeUrl 'wss://codex.example.com/ws' `
  -Workspace 'C:\workspace' `
  -AllowedRoots @('C:\workspace')
```

重新运行安装程序且不传入 `-Token`，可以在保留 DPAPI 凭据的同时更新其他设置。只有当这个受信任的单用户连接器确实需要下载配置目录以外的文件时，才应添加 `-AllowAnyFileDownload`。

## 开发

```powershell
npm run check
npm run build
```

React 入口组件将会话与历史记录解析交给 `history-utils.ts`，图片处理交给 `image-utils.ts`，本机链接解析交给 `file-utils.ts`。协议相关逻辑位于 `src/server` 和 `src/connector`。

## 许可证

[MIT](LICENSE)
