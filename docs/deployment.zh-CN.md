# 部署

[English](deployment.md) | 简体中文

Codex Anywhere 使用一台小型 Linux 转发服务作为浏览器与 Codex 电脑上连接器的会合点。Codex、项目、
附件和生成文件都留在本机；本机只建立出站连接，不需要公网 IP 或家庭网络入站规则。

`http://127.0.0.1:3300` 只是同一台电脑上的调测地址，不是有实际意义的手机部署方式。

## 准备资源

- 可访问的 Linux ECS/VPS：Git、Docker Engine、Docker Compose v2。
- Windows Codex 电脑：Codex Desktop/CLI、Node.js 22+、Git、PowerShell。
- 浏览器可达的入口：经过公网或不可信网络时推荐 WSS。域名、TLS 证书和反向代理可选，也可以使用
  私有 VPN 或安全隧道。

不需要数据库、Redis、对象存储，也不需要给 Windows 电脑开放公网入站端口。

## 1. 启动转发服务

在 ECS/VPS 执行：

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
./scripts/relay.sh setup
```

`setup` 会创建权限为 0600 的 `.env` 和随机连接器专用密钥，然后构建镜像、启动容器并等待健康检查。
参考 Compose 只发布 `127.0.0.1:3300`；应继续关闭公网 3300 端口。

根据网络选择入口：

| 网络 | 推荐入口 |
| --- | --- |
| 公网 | 持续维护的 HTTPS/WSS 反向代理，转发到 `127.0.0.1:3300` |
| 仅自己的可信设备 | 在转发服务终止的私有 VPN 或安全隧道 |
| 同一主机开发 | 直接访问 `127.0.0.1:3300` 的 HTTP/WS |

[`deploy/nginx-example.conf`](../deploy/nginx-example.conf) 只是参考配置；已有入口、证书、VPN 或隧道工具
都可以继续使用。反向代理必须支持 WebSocket 升级并覆盖客户端地址转发头。引入第三方入口也意味着
扩大信任边界。

## 2. 安装 Windows 连接器

在运行 Codex 的电脑上执行：

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
```

在 ECS 运行 `./scripts/relay.sh token` 读取连接器密钥，通过私密方式传到本机并安装：

```powershell
$connectorToken = Read-Host 'Connector token' -AsSecureString
.\scripts\install-connector.ps1 `
  -ConnectorToken $connectorToken `
  -BridgeUrl 'wss://codex.example.com/ws'
```

请换成实际的 `ws://` 或 `wss://` 地址。Windows 使用当前用户 DPAPI 保护连接器密钥和设备私钥，
把配置保存在 `%USERPROFILE%\.codex-anywhere`，并通过当前用户后台任务保持一个连接器运行；任务计划
程序不可用时会回退到登录快捷方式。

新会话没有默认工作目录，需要在 Web 界面选择项目。`-AllowedRoots` 可选，默认只允许连接器仓库；
只有希望选择或预览其他目录时才增加根目录。`-AllowAnyFileDownload` 和 `-EnableNetworkAccess` 都是
显式开关。

图片、Markdown、源代码、配置和文本的内联预览始终受根目录限制。启用 `-AllowAnyFileDownload` 只会
允许用户确认后下载根目录外的文件，不会静默扩大预览权限。需要在 Web 界面使用其他项目树时，请用
完整的 `-AllowedRoots` 列表重新运行安装程序。

## 3. 批准连接器并配对浏览器

连接器首次尝试连接后，回到 ECS 执行：

```bash
./scripts/relay.sh approve
./scripts/relay.sh pair https://codex.example.com
```

`approve` 会列出待批准端点，并在信任所选连接器前要求确认。`pair` 会输出十分钟有效、只能使用一次的
浏览器链接和二维码。请把示例地址替换成真实 Web 地址。

摄像头不是必需条件：可以直接打开或粘贴链接，也可以在配对页面上传二维码截图；二维码只在浏览器
本地解析。配对完成后，该浏览器配置使用自己的已批准设备密钥重连，不存在共享浏览器 Token 或恢复
登录。

## 4. 验证

```bash
./scripts/relay.sh status
```

在手机打开一个已有会话并发送无害消息，确认浏览器和 Codex 都收到更新。如果会话中包含本机文件
链接，再分别点击一个 Markdown 和常见源代码文件：两者都应打开有界预览，受支持的源文件应出现语法
着色，而且预览页都应保留“下载”按钮。如果已完成回复显示文件变更，点击统计并确认有界 Diff 属于
该轮任务。同时确认公网入口使用了预期传输方式，并且外网不能访问
`ECS-IP:3300`。

## 日常管理与升级

在 ECS 仓库目录执行：

| 命令 | 用途 |
| --- | --- |
| `./scripts/relay.sh status` | 查看容器并验证健康状态 |
| `./scripts/relay.sh token` | 输出连接器专用密钥，只能私密传输 |
| `./scripts/relay.sh pending` | 查看待批准端点 |
| `./scripts/relay.sh approve` | 审核并批准待处理端点 |
| `./scripts/relay.sh pair <公网地址>` | 生成单次浏览器配对链接 |
| `./scripts/relay.sh devices` | 查看已批准端点 |
| `./scripts/relay.sh revoke` | 撤销已批准端点 |
| `./scripts/relay.sh update` | 快进更新 `main`、重建、重启并验证 |

转发服务和连接器仓库应保持同一提交。更新 ECS 后，在 Windows 更新仓库、执行 `npm ci`，再重启或
重新安装连接器。协调升级期间仍打开的浏览器页面需要完整刷新；已加载页面会继续运行旧 JavaScript，
直到刷新或重新打开，而且严格协议不支持混用版本。

## 排查本机文件链接

| 现象 | 检查项 |
| --- | --- |
| 支持的代码链接仍然直接下载 | 更新两端仓库、重启连接器，再完整刷新或重新打开浏览器页面 |
| 预览弹出但提示失败 | 确认它是 `-AllowedRoots` 内、不超过 2 MiB 的普通 UTF-8 文件 |
| 代码可读但没有语法着色 | 该语言不在按需高亮子集内，或文件超过 512 KiB 高亮上限；此时安全显示纯代码属于预期行为 |
| 二进制、`.env`、证书或密钥文件进入下载流程 | 敏感、二进制和未识别格式有意不提供内联文本预览 |

预览权限和下载权限相互独立。`-AllowAnyFileDownload` 只影响确认下载，不会让根目录外的文件变得
可预览。

## 支持的配置

转发服务 `.env`：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BRIDGE_CONNECTOR_TOKEN` | `relay.sh setup` 自动生成 | 只接受连接器使用的密钥，至少 32 个字符 |
| `BRIDGE_SESSION_MAX_AGE_MS` | `3600000` | 已认证连接重新鉴权前的最长生存期 |
| `BRIDGE_TRUST_PROXY` | 参考 Compose 为 `1` | 只信任会覆盖客户端地址头的本机代理；没有此类代理时设为 `0` |
| `CODEX_UI_LANGUAGE` | `zh-CN` | Web 与设备管理命令语言：`zh-CN` 或 `en` |

连接器安装参数：

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `-BridgeUrl` | `ws://127.0.0.1:3300/ws` | 转发服务 WebSocket 地址 |
| `-AllowedRoots` | 连接器仓库 | 新会话、预览和普通下载可使用的本机项目根目录 |
| `-AllowAnyFileDownload` | 关闭 | 确认后允许下载配置根目录外的文件；不会扩大预览根目录 |
| `-EnableNetworkAccess` | 关闭 | 允许连接器持有的 Codex 轮次申请网络访问 |

调整文件根目录、下载范围、入口或连接器网络访问前，请阅读[安全策略](SECURITY.zh-CN.md)。
