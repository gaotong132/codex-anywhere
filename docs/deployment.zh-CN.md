# 部署

[English](deployment.md) | 简体中文

文档对应 **v0.3.0（2026-09-12）** · [发布与升级](release-0.3.0.zh-CN.md) · [文档索引](README.zh-CN.md)

Codex Anywhere 使用一台小型 Linux 转发服务作为浏览器与一个或多个 Codex 执行节点的会合点。Codex、
项目、附件和生成文件都留在当前选择的节点；每个连接器只建立出站连接，因此个人电脑不需要公网 IP
或家庭网络入站规则。转发主机也可以同时运行一个 24×7 无头连接器。

`http://127.0.0.1:3300` 只是同一台电脑上的调测地址，不是有实际意义的手机部署方式。

## 准备资源

第一次购买 ECS、尚未配置公网入口时，可按文末[附录：新购 ECS 从零部署](#附录新购-ecs-从零部署)完成基础安装。

- 可访问的 Linux ECS/VPS：Git、Docker Engine、Docker Compose v2；如果还要作为执行节点，需要
  Node.js 22+ 和已登录认证的 Codex CLI。
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

## 2A. 安装 Windows/Desktop 连接器

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
需要选择其他项目目录或预览其中的位图时才增加根目录；文本类文件预览不需要。`-AllowAnyFileDownload`、`-EnableNetworkAccess` 和
`-AllowFullAccess` 都是显式开关。

Markdown、SVG、源代码、配置和文本预览支持连接器账号可读的任意绝对路径，保留 2 MiB、UTF-8 和类型校验；位图预览仍受根目录限制。`-AllowAnyFileDownload` 只控制确认下载的目录范围。需要在 Web 界面使用其他项目树时，请用
完整的 `-AllowedRoots` 列表重新运行安装程序。

安装多个连接器时，请为每个节点使用稳定、容易识别的路由：

```powershell
.\scripts\install-connector.ps1 `
  -DeviceId 'personal-pc' `
  -AllowedRoots 'D:\project'
```

## 2B. 安装 24×7 Linux/ECS 连接器

Linux 连接器使用 `headless` 模式：新建和恢复的会话都由它自己的 Codex app-server 管理，不依赖 Codex
Desktop。先确认准备运行服务的账号已经登录 Codex：

```bash
codex login status
```

连接器和转发服务位于同一主机、同一仓库时，安装器会复用转发服务密钥而不把它打印出来。请选择专用
工作区根目录，不要把整个 Home 目录暴露给连接器：

```bash
mkdir -p /root/codex-workspaces
sudo ./scripts/install-linux-connector.sh \
  --device-id ecs \
  --label 'ECS · 24x7' \
  --allowed-root /root/codex-workspaces \
  --enable-network
```

`--enable-network` 是可选项；只有该节点上的 Codex 确实需要申请网络访问时才启用。若还需要在 Web
端选择“完全访问权限”，必须另外传入 `--allow-full-access`。安装器会在
`/etc/codex-anywhere` 写入权限为 0600 的环境文件，在服务账号的 `~/.codex-anywhere` 保存连接器设备
身份，安装经过约束的 systemd 服务并启动。连接到其他转发主机时，请在安装进程环境中私密提供
`BRIDGE_CONNECTOR_TOKEN`，并设置 `--bridge-url wss://codex.example.com/ws`。

查看服务状态时不需要读取它的环境文件：

```bash
systemctl status codex-anywhere-connector --no-pager
journalctl -u codex-anywhere-connector -n 50 --no-pager
```

## 3. 批准连接器并配对浏览器

每个连接器首次尝试连接后，回到转发主机。每个新连接器路由都要分别执行一次 `approve`，然后再配对
浏览器：

```bash
./scripts/relay.sh approve
./scripts/relay.sh pair https://codex.example.com
```

`approve` 会列出待批准端点，并在信任所选连接器前要求确认；第二个连接器不会被自动信任。`pair` 会
输出十分钟有效、只能使用一次的
浏览器链接和二维码。请把示例地址替换成真实 Web 地址。

摄像头不是必需条件：可以直接打开或粘贴链接，也可以在配对页面上传二维码截图；二维码只在浏览器
本地解析。配对完成后，该浏览器配置使用自己的已批准设备密钥重连，不存在共享浏览器 Token 或恢复
登录。

打开链接会自动弹出配对框并填入配对码，点击“配对”即可连接；同一标签页打开另一条链接也会更新
输入内容。配对过程中可以随时取消，无需关闭页面；认证超过 15 秒未完成会自动结束。配对码无效、
已使用或已过期时，会显示错误并恢复可编辑状态，修改配对码或生成新链接后即可重试，不会自动反复
配对。成功前刷新页面会丢弃内存中的配对码，需要重新打开或粘贴链接。

## 4. 验证

```bash
./scripts/relay.sh status
```

在手机打开一个已有会话并发送无害消息，确认浏览器和 Codex 都收到更新。如果会话中包含本机文件
链接，再分别点击一个 Markdown 和常见源代码文件：两者都应打开有界预览，受支持的源文件应出现语法
着色，而且预览页都应保留“下载”按钮。如果已完成回复显示文件变更，点击统计并确认有界 Diff 属于
该轮任务，再切换一次自动换行。Codex 提供上下文统计时，确认右上角活动状态环显示用量，悬停或点击
可以看到准确 Token 数；发生过上下文压缩的会话应在时间线保留压缩节点。同时确认公网入口使用了
预期传输方式，并且外网不能访问 `ECS-IP:3300`。对长会话向上浏览一次，确认出现更早记录加载提示、
当前阅读位置不会跳动，并且失败后可重试。对连接器持有的测试轮次打开运行状态条，确认“停止”只中断
这一轮；Desktop 已持有的任务应提示回电脑停止。批准多个连接器后，在侧边栏切换执行环境，确认顶部
环境标签、会话列表、最近工作目录和在线状态一起变化；分别在两个节点创建一个无害会话，再来回切换，
确认历史和文件不会混到另一台机器。

## 日常管理与升级
固定使用发布版本时，按 [v0.3.0 升级步骤](release-0.3.0.zh-CN.md#升级)操作。
`update` 脚本跟随 `main`，不会锁定 tag，也不会等待全部业务任务空闲。升级前先保留旧提交、镜像和私有状态，
选择空闲窗口，并在重启后逐个验证 Connector。



在 ECS 仓库目录执行：

| 命令 | 用途 |
| --- | --- |
| `./scripts/relay.sh status` | 查看容器并验证健康状态 |
| `./scripts/relay.sh token` | 输出连接器专用密钥，只能私密传输 |
| `./scripts/relay.sh pending` | 查看待批准端点 |
| `./scripts/relay.sh approve` | 审核并批准待处理端点 |
| `./scripts/relay.sh pair <公网地址>` | 生成单次浏览器配对链接 |
| `./scripts/relay.sh devices` | 查看已批准端点、在线状态、连接数及最近连接/最后在线时间 |
| `./scripts/relay.sh devices --json` | 输出设备与活跃记录的 JSON，便于脚本处理 |
| `./scripts/relay.sh revoke` | 撤销已批准端点 |
| `./scripts/relay.sh update` | 快进更新 `main`、重建并验证；同机已启用的无头连接器也会重启 |

设备按批准时间倒序排列，与 `revoke` 的选择序号一致。同一设备的多个连接合并统计；在线和最后在线反映
WebSocket 连接与心跳，不代表用户正在操作。文本时间为 UTC，JSON 时间为 Unix 毫秒。活跃历史从升级后开始
记录，未观察到的时间显示“未记录”（JSON 为 `null`），不会用批准时间冒充最后在线时间。

Relay 在设备注册表旁单独写入私有 `devices.json.activity.json`，每 5 秒及认证/断连时更新。运行中快照超过
15 秒未更新时显示“状态未知”（JSON 连接数为 `null`）；正常停止显示离线，重启保留历史并重新统计连接。
这份快照不通过公网接口提供，也不改变配对身份或自动撤销设备。

转发服务和连接器仓库应保持同一提交。同一仓库中的 Linux 服务会由 `relay.sh update` 重启；其他主机
上的连接器需要拉取代码并重启 `codex-anywhere-connector.service`。更新 ECS 后，在 Windows 更新仓库、
执行 `npm ci`，再重启或重新安装连接器。协调升级期间仍打开的浏览器页面需要完整刷新；已加载页面会继续运行旧 JavaScript，
直到刷新或重新打开，而且严格协议不支持混用版本。

## 排查问题

| 现象 | 检查项 |
| --- | --- |
| 生成图片未显示 | 更新并重启所选 Connector、刷新 Web，确认 Codex 生成图片目录内的原图仍在；只更新 Relay 无法修复节点侧历史解析 |
| Docker 因 package.json 权限错误退出 | 使用 v0.3.0 重建，Dockerfile 已为非 root 运行账号设置包元数据读取权限；不要公开私有配置或改用 root 绕过 |
| 容器健康状态仍是 starting | 参考配置每 30 秒探测一次，启动宽限期为 10 秒；检查容器状态和日志，等待首轮探测后再判断失败 |
| 支持的代码链接仍然直接下载 | 更新两端仓库、重启连接器，再完整刷新或重新打开浏览器页面 |
| 预览弹出但提示失败 | 文本预览需为不超过 2 MiB 的普通 UTF-8 文件、受支持的文件名/类型，且服务账号有读取权限；工作区根目录限制只适用于位图预览 |
| 代码可读但没有语法着色 | 该语言不在按需高亮子集内，或文件超过 512 KiB 高亮上限；此时安全显示纯代码属于预期行为 |
| 二进制、`.env`、证书或密钥文件进入下载流程 | 敏感、二进制和未识别格式有意不提供内联文本预览 |
| 上下文环没有进度 | 更新两端仓库并完整刷新浏览器；所选会话还必须包含 Codex 提供的 Token 统计 |
| 更早历史没有加载 | 先离开最新消息边缘并继续向上滚动；只有用户开始浏览旧内容后才会自动分页。请求失败时使用可见的重试按钮 |
| 会话列表先出现，运行中的 Desktop 标记稍后才显示 | 这是预期行为：app-server 会话会立即返回，Desktop 活动状态在后续轮询异步合并 |
| 手机输入显示来自无关会话，或投递被会话身份校验阻止 | 暂停发送，同时更新并重启 Windows 连接器（不能只更新 ECS），并审查受影响历史。原生调用来源与目标必须为同一会话，禁止借用其他会话绕过失败 |
| 运行中的任务没有停止按钮 | Web 只能中断当前连接器持有且身份匹配的轮次；Desktop 已持有的任务需要回电脑停止 |
| 预期的执行环境没有出现 | 确认对应 systemd/Windows 连接器正在运行且已批准，再等待转发服务刷新在线状态 |
| Linux 会话完成第一轮后无法继续 | 确认 `CODEX_CONNECTOR_MODE=headless`，更新仓库并重启 systemd 服务 |

预览权限和下载权限相互独立。文本类文件不限根目录；位图仍受根目录限制。`-AllowAnyFileDownload` 只影响确认下载。

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
| `-DeviceId` / `--device-id` | Windows 为 `personal-pc`，Linux 为 `ecs` | 浏览器显示的稳定执行环境路由 |
| `-AllowedRoots` | 连接器仓库 | 新会话、位图预览和普通下载可使用的本机项目根目录；不限制文本类预览 |
| `-AllowAnyFileDownload` | 关闭 | 确认后允许下载配置根目录外的文件；不改变预览策略 |
| `-EnableNetworkAccess` | 关闭 | 允许连接器持有的 Codex 轮次申请网络访问 |
| `-AllowFullAccess` / `--allow-full-access` | 关闭 | 允许已批准的 Web 端取消该节点上 Codex 的审批和沙箱限制 |

连接器运行时环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BRIDGE_DEVICE_LABEL` | 设备 ID | 诊断信息使用的连接器名称 |
| `CODEX_CONNECTOR_MODE` | Windows 为 `desktop`，其他平台为 `headless` | 保留 Desktop 会话所有权，或让无头 app-server 管理恢复的会话 |
| `CODEX_ALLOW_FULL_ACCESS` | `0` | Web“完全访问权限”的服务端总开关 |
| `BRIDGE_DEVICE_IDENTITY_FILE` | 安装器管理 | Linux 上权限为 0600 的 Ed25519 连接器身份文件 |

“完全访问权限”和 `-AllowedRoots` 是两条不同边界：后者仍限定位图预览和普通下载，但 Codex 本身将退出
沙箱，并可读写连接器服务账号能访问的任何文件。只应在专用节点上、且所有已批准浏览器都可信时开启。

调整文件根目录、下载范围、入口或连接器网络、完全访问权限前，请阅读[安全策略](SECURITY.zh-CN.md)。

## 附录：新购 ECS 从零部署

本附录以 **Ubuntu Server 24.04 LTS、systemd、独立公网 IPv4** 的全新 ECS 为例，步骤核对日期为
2026-09-14。其他发行版需要换用相应的软件源和服务配置。已有网站的服务器应合并配置，避免覆盖原站点。
下文的 `codex.example.com` 必须全部换成自己的域名。

### A. 软件和服务清单

| 组件 | 是否需要 | 用途 / 运行方式 |
| --- | --- | --- |
| Git、curl、CA 证书 | 必需 | 获取代码、下载依赖、验证 HTTPS |
| Docker Engine、Compose 插件 | 必需 | 构建和运行 Relay，Docker 由 systemd 管理 |
| Nginx | 本附录需要 | 监听 80/443，终止 TLS，反向代理 HTTP 和 WebSocket |
| 域名及 DNS 解析 | 本附录需要 | 让客户端访问固定域名，并完成证书域名验证 |
| TLS 证书、Certbot / snapd | 本附录需要 | 签发和自动续期证书；已有受信任证书可用自己的证书管理工具 |
| Node.js 22+、已认证的 Codex CLI、Connector | 可选 | 仅在 ECS 也要执行 Codex 任务时安装；仅转发时 Node 在容器内运行 |

**WSS 是经过 TLS 加密的 WebSocket，不需要另外安装“WSS 服务”。** 在这个方案中：

```text
浏览器 ── HTTPS / WSS :443 ──> Nginx ── HTTP / WS 127.0.0.1:3300 ──> Relay
PC Connector ── 出站 WSS :443 ──> 同一个 Nginx / Relay
ECS Connector（可选）── 本机 WS 127.0.0.1:3300 ──> Relay
```

Web 入口为 `https://codex.example.com`，远程连接器地址为 `wss://codex.example.com/ws`。
TLS 在 Nginx 终止，Relay 使用回环地址上的明文 WS；不需要给容器配置证书，也不需要数据库或 Redis。

### B. 公网、域名和端口

在域名服务商处添加 `codex` 的 **A 记录**，指向 ECS 的公网 IPv4（不是内网 IP）。只有在 ECS 的 IPv6
监听、路由和安全组均已配置时才添加 AAAA 记录。先使用直接 DNS 解析；如需 CDN，之后再核对其 WebSocket 支持。

同时检查云安全组和操作系统防火墙：

| 入站 TCP 端口 | 来源 | 用途 |
| --- | --- | --- |
| 22（或实际 SSH 端口） | 管理员的可信 IP | SSH 运维 |
| 80 | 公网 | 本附录的 HTTP-01 证书验证，以及跳转 HTTPS |
| 443 | 需要访问的客户端网络 | HTTPS 页面和 WSS 共用此端口 |
| 3300 | 不向公网开放 | 仅允许本机回环访问 Relay |

若启用主机防火墙，先允许实际 SSH 端口与管理员 IP，并保留当前 SSH 连接验证新连接可用；不要清空已有规则。
Docker 发布端口可能绕过 UFW，因此应保留 Compose 的 `127.0.0.1:3300:3300` 绑定，不能只依赖 UFW 阻止公网 3300。
参见 [Docker 防火墙说明](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations)。
服务器还需要可用的 DNS、软件源及 HTTPS 出站网络；若运行 Connector，还需能访问其 Codex 服务。

### C. 安装基础软件与 Docker

通过 SSH 登录后，以下安装命令在 **ECS 的 root Bash** 中依次执行（普通管理员先运行 `sudo -i`）。
本示例将仓库放在 `/root/codex-anywhere`，不要求为 Docker 开放远程管理端口。

```bash
apt-get update
apt-get install -y git curl ca-certificates nginx snapd dnsutils nano
```

按 [Docker 官方 Ubuntu 安装指南](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository)
的“Set up Docker's apt repository”配置官方 APT 软件源，然后执行：

```bash
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker nginx
docker compose version
docker run --rm hello-world
```

云镜像若已预装 Docker，先核对现有版本和 Compose 插件，不要直接混装不同来源的软件包。

### D. 启动 Relay，建立 HTTP 验证入口

```bash
cd /root
git clone https://github.com/gaotong132/codex-anywhere.git
cd /root/codex-anywhere
./scripts/relay.sh setup
curl --fail --silent --show-error http://127.0.0.1:3300/health
dig +short A codex.example.com
dig +short AAAA codex.example.com
```

健康接口应返回成功，DNS 应指向这台 ECS。此时还不能直接启用仓库里的 HTTPS 配置：证书尚未签发。
先用 `nano /etc/nginx/sites-available/codex-anywhere` 创建以下临时 HTTP 站点：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name codex.example.com;
    server_tokens off;
    access_log off;
    location / {
        default_type text/plain;
        return 200 "codex-anywhere TLS setup\n";
    }
}
```

```bash
ln -s /etc/nginx/sites-available/codex-anywhere /etc/nginx/sites-enabled/codex-anywhere
nginx -t && systemctl reload nginx
```

从另一台电脑打开 `http://codex.example.com`，确认显示 `codex-anywhere TLS setup`。如果出现默认欢迎页，
检查域名和 `server_name`；如果连接超时，检查 DNS、安全组、防火墙及云服务商的入口限制。此临时站点不提供配对入口。

### E. 签发证书，启用 HTTPS / WSS

使用 [Certbot 的 snap 安装方式](https://certbot.eff.org/instructions?os=snap&ws=nginx)。
本附录使用 `certonly --nginx` 获取证书，再安装项目提供的代理配置：

```bash
snap install --classic certbot
/snap/bin/certbot certonly --nginx --cert-name codex.example.com -d codex.example.com
```

按提示填写联系邮箱并阅读、接受服务条款。确认签发成功后，备份临时配置并安装模板：

```bash
cp /etc/nginx/sites-available/codex-anywhere /root/codex-anywhere-http-bootstrap.conf
install -m 644 /root/codex-anywhere/deploy/nginx-example.conf /etc/nginx/sites-available/codex-anywhere
nano /etc/nginx/sites-available/codex-anywhere
```

在配置中替换两个 `server_name` 的示例域名，并将证书路径改为：

```nginx
ssl_certificate /etc/letsencrypt/live/codex.example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/codex.example.com/privkey.pem;
```

保留模板中的 `/ws` 精确匹配、HTTP/1.1、`Upgrade` / `Connection` 请求头和长连接超时。
这些设置负责将 WSS 连接升级并转发到 Relay，参见 [Nginx WebSocket 代理文档](https://nginx.org/en/docs/http/websocket.html)。
模板还覆盖客户端地址转发头，与参考 Compose 的 `BRIDGE_TRUST_PROXY=1` 配合；若在 Nginx 前再加一层代理，
需要重新确定可信代理和真实客户端地址规则。

```bash
nginx -t && systemctl reload nginx
curl --fail --silent --show-error https://codex.example.com/health
```

不要用 `curl -k` 忽略证书错误。若已持有云厂商签发的证书，可以跳过 Certbot，安装完整证书链和私钥，
并自行安排续期与 Nginx reload；不要把私钥提交到 Git。

`npm run build` 也会生成 Web 资源的 Brotli/gzip 版本，Relay 根据 `Accept-Encoding` 协商返回，普通代理即可
转发已压缩的响应。更新后，在浏览器 Network 中检查 JavaScript 的实际 **GET** 请求是否包含
`Content-Encoding: br` 或 `gzip`，且响应下载完整；仅健康检查成功不能证明大文件传输正常。若 Nginx 日志在
`proxy_temp_path` 下报告权限错误，检查工作进程用户能否访问该目录及子目录；保留严格权限，不要开放全员写入。

### F. 配对、WSS 验收和可选执行节点

按正文“安装 Windows/Desktop 连接器”把 PC 连接到 `wss://codex.example.com/ws`，随后在 ECS 执行：

```bash
cd /root/codex-anywhere
./scripts/relay.sh approve
./scripts/relay.sh pair https://codex.example.com
./scripts/relay.sh devices
```

配对链接只交给自己的浏览器。打开 HTTPS 页面完成配对，确认执行环境在线，并在自己的测试会话中发送消息、
检查流式回复。浏览器开发者工具 Network → WS 中的 `/ws` 请求应返回 **101 Switching Protocols** 并持续收发帧。
仅 `/health` 成功不能证明 WSS 升级和连接器认证成功，普通 `curl /ws` 也不是完整的 WebSocket 验收。

如果 ECS 也要执行任务，再按正文“安装 24×7 Linux/ECS 连接器”安装 Node.js、认证 Codex CLI 和 systemd 服务，
完成相同的批准与在线检查；仅作 Relay 时无需此步骤。浏览器扩展属于实验性附加特性，也不是基础部署的前提。

### G. 自动续期、巡检和备份

`certonly` 没有替你安装证书到 Nginx，需要配置续期成功后的 reload。创建部署钩子：

```bash
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/codex-anywhere-nginx.sh <<'EOF'
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/bin/systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/codex-anywhere-nginx.sh
/snap/bin/certbot renew --dry-run --run-deploy-hooks
systemctl list-timers --all | grep -i certbot
```

确认定时器有下次执行时间；snap 安装通常显示 `snap.certbot.renew.timer`。本流程使用 Nginx HTTP-01 验证，
续期时仍需公网 80 可达；若无法开放 80，改用 DNS 服务商支持的自动 DNS 验证。续期机制和钩子参见
[Certbot 使用指南](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)。

常用巡检命令：

```bash
cd /root/codex-anywhere
./scripts/relay.sh status
./scripts/relay.sh devices
systemctl is-active docker nginx
docker compose logs --tail 100 bridge
tail -n 100 /var/log/nginx/codex-bridge-error.log
/snap/bin/certbot certificates
# 仅安装了 ECS Connector 时执行：
systemctl status codex-anywhere-connector.service --no-pager
```

公网 HTTPS 超时先查 DNS 和入口端口；502 先查 Relay 的本机健康接口；页面正常而 WS 失败则检查 `/ws`
升级头、代理超时和连接器状态。更新前备份当前提交、镜像、`.env`、Compose 数据卷中的设备注册表、
连接器配置与身份文件，以及 Nginx 配置和 `/etc/letsencrypt`；这些私有备份应限制访问。保留业务会话、工作区和
现有网络配置，等待任务空闲后再重启服务。应用更新参见正文“日常管理与升级”。
