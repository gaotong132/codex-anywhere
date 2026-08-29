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
- **随时补充下一步**：可以直接向正在运行的任务发送后续指令，且不会新建重复会话。
- **跟随执行进度**：查看哪些会话正在运行，并及时了解有价值的工作进展。
- **手机端处理审批**：在浏览器中批准或拒绝支持的命令、文件修改和权限请求，断线重连后仍可继续处理。
- **随时取回工作结果**：确认后即可预览助手回复中的图片，或把相关文件下载到手机和浏览器。
- **预览 Codex 可视化**：全屏查看 Codex 生成的交互稿，也可以下载原文件。
- **长会话也能快速打开**：优先打开最近内容，需要时再继续加载更早的记录。
- **针对手机操作优化**：可以在已有项目中新建会话、搜索最近会话并查看附件。
- **断线自动恢复**：手机网络切换或短暂断联后，手机与连接电脑会自动重连并同步当前状态。
- **每台设备都要经过确认**：浏览器通过十分钟单次链接配对，之后仅凭已批准的设备密钥重连；连接电脑也需要所有者批准。
- **工作始终留在自己的电脑上**：Codex 和项目文件都在本机运行，由你掌控的转发服务只负责提供远程入口。

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

浏览器和本机连接器都会主动连接转发服务。所有应用请求、响应、事件、预览和下载分块都使用经过身份
验证的端到端加密通道；转发服务负责设备鉴权和密文路由。

连接器通过 Codex app-server JSON-RPC 管理自己持有的会话；正在 Desktop 中运行的会话使用原生投递
和自适应历史轮询，后续指令会直接发送到正在运行的任务。Desktop 已持有的审批仍在 Desktop 处理。
Codex Anywhere 没有实现 ACP。

## 安全设计

<p align="center">
  <img src="docs/assets/security-model.svg" alt="Codex Anywhere 安全设计：多层设备认证、自托管转发服务信任边界，以及只在本机执行的 Codex 和文件访问" width="100%">
</p>

当前安全机制以短时注册和持久设备身份为核心：

| 防护层 | 保护措施 |
| --- | --- |
| 设备访问 | 十分钟有效的单次浏览器配对和后续 Ed25519 设备密钥认证；浏览器没有共享 Token 登录。 |
| 内容保护 | 使用经过身份验证的 X25519 密钥交换和 XChaCha20-Poly1305 加密应用流量；转发服务只能看到元数据和密文大小。 |
| 会话控制 | 随机质询、防重放、定期重新认证、失败限速、来源检查和帧大小限制。 |
| 本机电脑 | 不接受公网入站连接。Windows 上的连接器 Token 和设备私钥使用当前用户 DPAPI 保护；Codex 执行和项目文件始终留在本机。 |
| 文件与预览 | 图片预览受目录限制；原文件下载需要确认和短时凭证；HTML 可视化在隔离、断网的沙箱中运行。 |
| 转发服务 | 参考服务只绑定 ECS 回环地址并降低容器权限；只保存设备信任记录，不保存会话或文件内容。 |

ECS 负责提供 Web 应用和管理设备信任，因此不是零信任转发节点。宿主机被攻破后，攻击者可以修改
Web 代码或批准记录并观察元数据；浏览器配置或连接器电脑被攻破后，也会继承该端权限。直接 `ws://`
仍会加密应用流量，但不能保护 Web 分发、配对和元数据；经过
不受信网络时优先使用 WSS、VPN 或安全隧道。

这是单用户个人桥接工具，不是多租户身份系统、零信任网关，也不能替代 Codex 的权限审查。建议使用
自己控制的 ECS/VPS，在不受信网络优先使用 WSS、VPN 或安全隧道，及时更新主机，只批准刚刚由自己
发起且可以确认的设备请求；疑似泄露后应撤销设备并轮换连接器凭据。完整说明参见
[安全策略](docs/SECURITY.zh-CN.md)和[正式部署指南](docs/deployment.zh-CN.md)。

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
   [正式部署指南](docs/deployment.zh-CN.md)。
2. 生成一个至少含 32 字节随机量的连接器密钥，在转发服务和连接电脑上配置同一个值。浏览器不使用
   该密钥。
3. 在运行 Codex 的电脑上安装连接器。Windows 会注册一个当前用户后台任务，在登录后自动启动：

   ```powershell
   $connectorToken = Read-Host 'Connector token' -AsSecureString
   .\scripts\install-connector.ps1 `
     -ConnectorToken $connectorToken `
     -BridgeUrl 'wss://codex.example.com/ws'
   ```

   轻量守护进程会在应用升级或意外退出后重新启动唯一的 Node 连接器进程，并且不会长期持有明文
   Token。无法使用任务计划程序时，安装器会自动回退到登录快捷方式。

4. 启动连接器，然后在 ECS/VPS 上批准该连接器。Web 界面不会获取或展示设备 ID、请求 ID、公钥、
   IP 和设备清单。

   ```bash
   docker compose exec bridge node build/server/device-admin.js
   ```

5. 生成一个仅可使用一次的浏览器配对链接，把示例地址替换为实际 Web 入口：

   ```bash
   docker compose exec bridge node build/server/device-admin.js pair https://codex.example.com
   ```

   在十分钟内打开链接或扫描二维码。摄像头不是前提：Web 页面也可以直接粘贴链接，或在本机解析
   上传的二维码截图。

将服务暴露到互联网前请阅读[安全策略](docs/SECURITY.zh-CN.md)。ECS/VPS 上不需要安装 Codex，也不要
把项目文件复制到 ECS/VPS。

### 必要配置

| 环境变量 | 使用方 | 用途 |
| --- | --- | --- |
| `BRIDGE_CONNECTOR_TOKEN` | 转发服务和连接器 | 本机连接器密钥 |
| `BRIDGE_SESSION_MAX_AGE_MS` | 转发服务 | 已认证 WebSocket 的最长生存期，默认一小时 |
| `BRIDGE_DEVICE_REGISTRY_FILE` | 转发服务 | 持久化已批准/待批准设备的公开记录；Compose 已自动配置 |
| `BRIDGE_URL` | 连接器 | 转发服务 WebSocket 地址，支持 `ws://` 和 `wss://` |
| `CODEX_UI_LANGUAGE` | 转发服务 | Web 界面语言：`zh-CN` 或 `en` |

完成配对后，浏览器使用已批准的设备密钥签署每次随机质询，截获的证明不能重放。WS 和 WSS 都会
端到端加密应用流量；WSS 还能保护 Web 分发、配对和元数据。

新会话必须在 Web 界面中明确选择或填写项目目录，系统没有默认工作目录。
`-AllowedRoots` 是可选的目录边界；省略时只允许连接器仓库目录。安装器会把这个可选设置保存在
仓库之外，因此无需写进转发服务使用的 `.env` 文件。

完整配置见 [.env.example](.env.example) 和 [正式部署指南](docs/deployment.zh-CN.md)，其中包括代理信任、
网络访问和不受目录限制的文件下载选项。

## 本机开发

`http://127.0.0.1:3300` 只是同一台电脑上的冒烟测试地址，用于验证网页、转发服务和连接器是否
互通；它无法提供有实际意义的手机远程访问。正式使用必须部署上面的 ECS/VPS 转发服务。

要求：Node.js 22+，以及已完成登录认证的 Codex CLI。

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
$env:BRIDGE_CONNECTOR_TOKEN = 'replace-with-at-least-32-random-characters-for-the-connector'
npm run server
```

在另一个终端运行：

```powershell
$env:BRIDGE_CONNECTOR_TOKEN = 'replace-with-the-connector-token-above'
$env:BRIDGE_URL = 'ws://127.0.0.1:3300/ws'
$env:BRIDGE_DEVICE_IDENTITY_FILE = '.\data\connector-device.json'
npm run connector
```

本机开发也保持严格设备审批。在第三个终端批准连接器，再生成并打开单次浏览器配对链接；命令会自动
读取本机的 `data/devices.json`：

```powershell
node build/server/device-admin.js
node build/server/device-admin.js pair http://127.0.0.1:3300
```

不要增加“首设备自动放行”的代码例外。开发检查与构建命令：

```powershell
npm run check
npm run build
```

应用源码和测试统一使用严格 TypeScript。转发服务和连接器运行编译后的 JavaScript；Windows
启动器只会在 TypeScript 源码变化后重新构建。

欢迎参与改进；提交 Pull Request 前请阅读[贡献指南](docs/CONTRIBUTING.zh-CN.md)。

## 许可证

[MIT](LICENSE)
