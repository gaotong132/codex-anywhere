# 部署

[English](deployment.md) | 简体中文

Codex Anywhere 使用一台小型 ECS/VPS 作为浏览器与本机电脑的会合点。Codex、项目、附件和生成文件
都留在运行连接器的电脑上；本机只需主动访问外网，不需要公网 IP 或入站防火墙规则。

`http://127.0.0.1:3300` 只能用于同一台电脑上的冒烟测试。手机远程访问必须有可达的转发服务。

## 准备资源

- 一台可访问的 Linux ECS/VPS，安装 Git、Docker Engine 和 Docker Compose v2。
- 一台运行 Codex Desktop/CLI 的 Windows 电脑，安装 Node.js 22+、Git 和 PowerShell。
- 一个浏览器可以访问的入口。代码同时支持 WS 和 WSS；经过公网或不可信网络时，优先使用 WSS、
  VPN 或安全隧道。

域名、TLS 证书和反向代理都是可选方案，不是项目依赖。不需要数据库、Redis 或对象存储。

## 1. 启动转发服务

在 ECS/VPS 上执行：

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
./scripts/relay.sh setup
```

该命令会在需要时生成权限为 0600 的 `.env` 和随机连接器 Token，然后构建容器、启动服务并等待
健康检查通过。参考 Compose 只监听 `127.0.0.1:3300`，不要把 3300 端口开放到公网。

根据自己的环境选择一种访问入口：

| 场景 | 入口方案 |
| --- | --- |
| 普通手机浏览器通过公网访问 | 使用持续维护的 TLS 反向代理，把 HTTPS/WSS 转发到 `127.0.0.1:3300` |
| 只允许自己的可信设备访问 | 使用私有 VPN 或安全隧道 |
| 可信内网或本机测试 | 明确接受风险时可以直接使用 HTTP/WS |

[`deploy/nginx-example.conf`](../deploy/nginx-example.conf) 只是可选的反向代理示例。已有代理、证书流程、
VPN 或隧道都可以继续使用。代理必须支持 WebSocket 升级并覆盖客户端地址转发头；除非接受新的信任
边界，否则不要额外加入第三方入口服务。

## 2. 安装本机连接器

在运行 Codex 的电脑上克隆同一仓库并安装依赖：

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
```

在 ECS 运行 `./scripts/relay.sh token` 读取连接器 Token，通过私密方式传到本机，然后安装连接器：

```powershell
$connectorToken = Read-Host 'Connector token' -AsSecureString
.\scripts\install-connector.ps1 `
  -ConnectorToken $connectorToken `
  -BridgeUrl 'wss://codex.example.com/ws'
```

请换成实际的 `ws://` 或 `wss://` 地址。Windows 会使用当前用户 DPAPI 保存 Token 和连接器私钥，
并通过当前用户后台任务维持唯一的连接器进程；任务计划程序不可用时会回退到登录快捷方式。

新会话没有默认工作目录，需要在 Web 界面选择项目。`-AllowedRoots` 可选，默认只允许连接器仓库；
只有需要选择其他目录时才传入。`-AllowAnyFileDownload` 和 `-EnableNetworkAccess` 都是显式开关。

## 3. 批准连接器并配对浏览器

连接器启动后回到 ECS：

```bash
./scripts/relay.sh approve
./scripts/relay.sh pair https://codex.example.com
```

第一条命令会展示待批准设备并要求确认；第二条会输出十分钟有效、只能使用一次的浏览器链接和二维码。
请把示例地址替换成实际 Web 地址。没有摄像头也能使用：可以直接打开或粘贴链接，也可以在配对页面
上传二维码截图；二维码只在浏览器本地解析。

浏览器会把批准后的设备密钥保存在当前浏览器配置中，每次连接都签署新的随机质询。不存在共享浏览器
Token 或恢复登录。

## 4. 验证

```bash
./scripts/relay.sh status
```

随后在手机上打开一个已有任务并发送无害消息，确认 Codex Desktop 与浏览器都能收到更新。使用参考
代理方案时，还应确认公网入口使用 HTTPS/WSS，并且外网无法访问 `ECS-IP:3300`。

## 日常管理

在 ECS 仓库目录执行：

| 命令 | 用途 |
| --- | --- |
| `./scripts/relay.sh status` | 查看容器并验证服务健康 |
| `./scripts/relay.sh pending` | 查看待批准设备 |
| `./scripts/relay.sh approve` | 批准待处理连接器 |
| `./scripts/relay.sh pair <公网地址>` | 生成一次性浏览器配对链接 |
| `./scripts/relay.sh devices` | 查看已批准设备 |
| `./scripts/relay.sh revoke` | 撤销已批准设备 |
| `./scripts/relay.sh update` | 快进更新 `main`、重新构建、启动并验证服务 |

ECS 与本机仓库应保持同一提交。执行 `relay.sh update` 后，在本机更新代码、运行 `npm ci`，再重启或
重新安装连接器；升级期间仍打开的浏览器页面需要完整刷新。

## 配置

转发服务 `.env`：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BRIDGE_CONNECTOR_TOKEN` | `relay.sh setup` 自动生成 | 仅用于连接器引导的密钥 |
| `BRIDGE_SESSION_MAX_AGE_MS` | `3600000` | 已认证连接重新鉴权前的最长生存期 |
| `CODEX_UI_LANGUAGE` | `zh-CN` | Web 界面语言：`zh-CN` 或 `en` |

连接器安装参数：

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `-BridgeUrl` | `ws://127.0.0.1:3300/ws` | 转发地址，支持 WS 和 WSS |
| `-DeviceId` | `personal-pc` | 连接器逻辑路由 |
| `-AllowedRoots` | 连接器仓库 | 新会话和普通下载可使用的项目根目录 |
| `-AllowAnyFileDownload` | 关闭 | 允许确认后下载配置根目录之外的文件 |
| `-EnableNetworkAccess` | 关闭 | 允许连接器持有的 Codex 任务申请网络访问 |

Windows 的加密状态保存在 `%USERPROFILE%\.codex-anywhere`，不进入仓库。完整信任边界、配对协议和
泄露处理参见[安全策略](SECURITY.zh-CN.md)。
