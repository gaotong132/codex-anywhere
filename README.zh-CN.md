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
- **跟随执行进度**：查看哪些会话正在运行，并及时了解有价值的工作进展。
- **手机端处理审批**：在浏览器中批准或拒绝支持的命令、文件修改和权限请求，断线重连后仍可继续处理。
- **随时取回工作结果**：确认后即可预览助手回复中的图片，或把相关文件下载到手机和浏览器。
- **预览 Codex 可视化**：全屏查看 Codex 生成的交互稿，也可以下载原文件。
- **长会话也能快速打开**：优先打开最近内容，需要时再继续加载更早的记录。
- **针对手机操作优化**：可以在已有项目中新建会话、搜索最近会话并查看附件。
- **断线自动恢复**：手机网络切换或短暂断联后，手机与连接电脑会自动重连并同步当前状态。
- **每台设备都要经过确认**：每台手机、浏览器和连接电脑只有得到所有者批准后才能访问会话，仅拿到 Token 也无法直接登录。
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

浏览器和本机连接器都会主动连接转发服务。转发服务负责鉴权、协商双方兼容的协议版本和能力集合，
并在内存中转发实时消息；Codex 执行和文件访问仍在本机完成。

新会话和符合条件的空闲会话由连接器通过 Codex app-server JSON-RPC 协议持有，因此可以接收
原生增量事件并在浏览器处理审批。已经在 Codex Desktop 中运行的会话仍由桌面持有，通过任务
工具投递消息并在同一条 WebSocket 上自适应轮询历史尾部；已经在桌面产生的待审批请求仍需在
Desktop 中处理。Codex Anywhere 没有实现 ACP。

## 安全设计

<p align="center">
  <img src="docs/assets/security-model.svg" alt="Codex Anywhere 安全设计：多层设备认证、自托管转发服务信任边界，以及只在本机执行的 Codex 和文件访问" width="100%">
</p>

当前安全机制采用多层防护，而不是只依赖一个持有者 Token：

| 防护层 | 当前实际实现 |
| --- | --- |
| 设备访问 | 浏览器与连接器使用不同 Token；每次连接都需要新的 256 位随机挑战、HMAC-SHA-256 证明，以及已由管理员明确批准设备的 Ed25519 签名。只有 Token 无法建立会话。 |
| 会话控制 | 拒绝重放证明；认证连接默认一小时过期；重复认证失败会被限速和临时锁定；检查浏览器同源，并限制 WebSocket 帧大小。 |
| 本机电脑 | 不接受公网入站连接。Windows 上的连接器 Token 和设备私钥使用当前用户 DPAPI 保护；Codex 执行和项目文件始终留在本机。 |
| 文件访问 | 位图预览只能来自配置根目录，并经过内容校验、缩放和 WebP 转换；SVG 只允许下载。Codex HTML 可视化受大小限制，只在转发服务内存中短暂停留，并在隔离且禁用网络的框架中运行。原文件下载仍需明确确认，并使用随机、绑定当前客户端且短时有效的能力凭证。 |
| 转发部署 | 参考 Compose 只绑定 ECS 回环地址；容器使用非 root 用户、只读文件系统并删除全部 Linux capabilities；只持久化设备公钥和审批元数据，不保存会话或文件内容。 |
| 浏览器加固 | 浏览器 Token 只保存在 `sessionStorage`；WebSocket 要求同源；网页响应包含严格 CSP 和其他浏览器安全响应头。 |

安全边界也必须如实说明。Codex Anywhere **没有**提供跨转发服务的应用层端到端加密：WSS 可以保护
网络传输，但 TLS 会在 ECS/VPS 终止，因此转发进程能够在内存中看到消息、预览和文件分块。转发服务
没有会话数据库，也不会有意持久化这些帧，但 ECS 管理员和宿主机仍然属于信任范围。浏览器设备私钥
保存在浏览器配置中，而不是硬件安全存储；浏览器配置或恶意扩展被攻破时，攻击者可以冒充该已批准设备。
本机电脑一旦被攻破，攻击者也能访问 Codex 本身能够访问的数据。代码支持部署者选择明文 `ws://`，
但它不提供保密性。

这是单用户个人桥接工具，不是多租户身份系统、零信任网关，也不能替代 Codex 的权限审查。建议使用
自己控制的 ECS/VPS，在不受信网络优先使用 WSS、VPN 或安全隧道，及时更新主机，只批准刚刚由自己
发起且可以确认的设备请求；疑似泄露后应撤销设备并轮换对应角色 Token。完整说明参见
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
2. 分别生成两个至少含 32 字节随机量的密钥：浏览器 Token 和连接器 Token。在转发服务中配置
   两者，本机连接器只保存连接器 Token。
3. 在运行 Codex 的电脑上安装连接器。Windows 可以将其注册为登录后自动启动：

   ```powershell
   $connectorToken = Read-Host 'Connector token' -AsSecureString
   $clientToken = Read-Host 'Browser client token' -AsSecureString
   .\scripts\install-connector.ps1 `
     -ConnectorToken $connectorToken `
     -ClientToken $clientToken `
     -BridgeUrl 'wss://codex.example.com/ws'
   ```

   登录启动器还包含一个轻量守护进程。当应用升级或主机事件结束连接器时，它会重新启动唯一的
   Node 连接器进程，并且不会长期持有明文 Token。

4. 在手机浏览器中打开转发服务地址并输入浏览器 Token。浏览器会自动生成设备身份，页面只显示
   通用的等待批准状态。
5. 在 ECS/VPS 上按[正式部署指南](docs/deployment.zh-CN.md)批准每个新连接器或浏览器。以后增加可信
   设备时重新运行该命令。Web 界面不会获取或展示设备 ID、请求 ID、公钥、IP 和设备清单。

   ```bash
   docker compose exec bridge node build/server/device-admin.js
   ```

   命令会列出待批准设备；输入对应序号并确认即可，不需要复制设备 ID 或修改 JSON。

将服务暴露到互联网前请阅读[安全策略](docs/SECURITY.zh-CN.md)。ECS/VPS 上不需要安装 Codex，也不要
把项目文件复制到 ECS/VPS。

### 必要配置

| 环境变量 | 使用方 | 用途 |
| --- | --- | --- |
| `BRIDGE_CLIENT_TOKEN` | 转发服务和浏览器 | 浏览器控制密钥，应与连接器密钥分开 |
| `BRIDGE_CONNECTOR_TOKEN` | 转发服务和连接器 | 本机连接器密钥 |
| `BRIDGE_SESSION_MAX_AGE_MS` | 转发服务 | 已认证 WebSocket 的最长生存期，默认一小时 |
| `BRIDGE_DEVICE_REGISTRY_FILE` | 转发服务 | 持久化已批准/待批准设备的公开记录；Compose 已自动配置 |
| `BRIDGE_URL` | 连接器 | 转发服务 WebSocket 地址，支持 `ws://` 和 `wss://` |
| `CODEX_UI_LANGUAGE` | 转发服务 | Web 界面语言：`zh-CN` 或 `en` |

鉴权同时要求一次性 HMAC-SHA-256 Token 证明，以及已批准、持久化的 Ed25519 设备密钥签名。
随机挑战会把两份证明绑定到角色、当前连接和连接器路由，截获后不能重放。但这不会让明文
`ws://` 具备保密性；不受信网络仍应使用 `wss://`、VPN 或其他安全隧道。

新会话必须在 Web 界面中明确选择或填写项目目录，连接器不再提供可配置的默认工作目录。
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
$env:BRIDGE_CLIENT_TOKEN = 'replace-with-at-least-32-random-characters-for-the-browser'
$env:BRIDGE_CONNECTOR_TOKEN = 'replace-with-a-different-32-random-characters-for-the-connector'
npm run server
```

在另一个终端运行：

```powershell
$env:BRIDGE_CONNECTOR_TOKEN = 'replace-with-the-connector-token-above'
$env:BRIDGE_URL = 'ws://127.0.0.1:3300/ws'
$env:BRIDGE_DEVICE_IDENTITY_FILE = '.\data\connector-device.json'
npm run connector
```

打开 `http://127.0.0.1:3300` 并输入 Token。本机开发也保持严格设备审批。在第三个终端运行与正式
环境相同的管理员命令，分别批准连接器和浏览器；它会自动读取本机的 `data/devices.json`：

```powershell
node build/server/device-admin.js
```

每个设备运行一次，不要增加“首设备自动放行”的代码例外。开发检查与构建命令：

```powershell
npm run check
npm run build
```

应用源码和测试统一使用严格 TypeScript。转发服务和连接器运行编译后的 JavaScript；Windows
启动器只会在 TypeScript 源码变化后重新构建。

欢迎参与改进；提交 Pull Request 前请阅读[贡献指南](docs/CONTRIBUTING.zh-CN.md)。

## 许可证

[MIT](LICENSE)
