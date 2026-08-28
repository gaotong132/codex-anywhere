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

转发服务仅在内存中完成鉴权与实时帧转发。由 app-server 管理的新任务可以接收原生增量事件；对于桌面应用拥有的已有会话，则通过同一条 WebSocket 自适应轮询 rollout 尾部：内容变化期间约每 1.5 秒一次，静止时约每 6 秒一次。

Codex Anywhere 对 app-server 会话使用 Codex app-server JSON-RPC 协议，对已有桌面会话使用 Codex Desktop 任务工具完成消息投递。本项目没有实现 ACP。

## 默认安全措施

- 至少 32 位的随机 Bridge Token 在首个加密 WebSocket 帧中发送，绝不会放入 URL。
- 浏览器 WebSocket 升级请求必须来自相同的 Web Origin。
- 针对同一客户端 IP 的连续鉴权失败会被临时锁定。
- Codex 高权限操作仍需人工批准。
- 连接器的网络访问默认关闭。
- 项目访问与本机文件下载默认限制在 `CODEX_ALLOWED_ROOTS` 中。
- 每次下载都需要确认，并使用短期有效、仅限单个文件且绑定客户端的能力凭证。
- 转发服务不存储附件或下载文件。

本项目不是经过加固的多租户网关。请仅供一个受信任用户使用，并在暴露至互联网前阅读 [SECURITY.md](SECURITY.md)。

## 快速开始

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

打开 `http://127.0.0.1:3300` 并输入相同的 Token。如需部署到互联网，请参考 [docs/deployment.md](docs/deployment.md)，不要直接将 3300 端口暴露到公网。

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
| `BRIDGE_URL` | `ws://127.0.0.1:3300/ws` | 转发服务的 WebSocket 地址 |
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
