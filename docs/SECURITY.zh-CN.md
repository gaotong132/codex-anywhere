# 安全策略

[English](SECURITY.md) | 简体中文

## 支持范围

只支持 `main` 分支的最新提交。Codex Anywhere 面向单个可信用户，不是多租户服务。

## 报告漏洞

请使用 [GitHub 私密漏洞报告](https://github.com/gaotong132/codex-anywhere/security/advisories/new)。
不要在公开 Issue 中包含 Token、私有地址、会话内容或本机路径。

## 当前安全设计

- Codex、项目文件、附件和生成文件都留在连接器电脑上；本机不接受公网入站连接。
- 转发服务没有会话数据库，也不会有意持久化消息、预览、HTML 或下载分块。
- 每个浏览器和连接器都要使用管理员批准的 Ed25519 设备密钥；只有 Token 只能创建待批准请求。
- 浏览器与连接器使用 Ed25519 身份验证临时 X25519 密钥，并用 XChaCha20-Poly1305 加密应用帧。
  转发服务能看到路由元数据、时间和密文大小，但看不到消息或文件内容。
- 认证证明绑定随机质询；已认证连接默认一小时后重新认证；重复失败会被限速；同时检查浏览器来源和帧大小。
- Windows 使用当前用户 DPAPI 保护连接器 Token 和设备密钥；浏览器密钥保存在对应浏览器配置中。

一次性浏览器配对链接十分钟过期且只能使用一次。密钥位于 URL 片段中，连接前会从地址栏移除，转发
服务不保存原始密钥。浏览器 Token 只用于管理员恢复，并且必须与连接器 Token 分开。

图片预览限制在配置根目录内，并进行内容校验、缩放和 WebP 转换。原文件下载必须确认，并使用绑定
单个客户端和文件的短时凭证。交互式 HTML 只允许来自 Codex 可视化目录，并在浏览器的隔离、断网沙箱中运行。

## 信任边界

ECS/VPS 仍属于可信基础设施，因为它负责提供 Web 应用和管理设备批准。宿主机管理员被攻破后，可以
替换 Web 代码或信任记录、批准攻击者设备、观察元数据或拒绝服务。浏览器配置或连接器电脑被攻破后，
攻击者会继承该端权限。端到端加密可以减少转发服务暴露面，但不能把系统变成零信任架构。

项目支持直接 `ws://`，应用帧仍会端到端加密，但 HTTP/WS 无法保护 Web 分发、配对、元数据和可用性。
经过不受信网络时，优先使用 WSS、VPN 或安全隧道。

## 部署基线

- 分别生成至少包含 32 字节随机量的浏览器 Token 和连接器 Token。转发服务密钥保存在仅 root 可读的
  `.env`，浏览器恢复凭据保存在密码管理器中。
- 设备注册表卷保持私有和持久化，只允许加密备份，并及时撤销丢失或停用的设备。
- 通过持续维护的入口或私有网络发布服务。参考 Compose 只把 3300 端口绑定到 ECS 回环地址。
- SSH 使用密钥，及时更新主机，限制防火墙规则，并关闭代理访问日志或缩短保留时间。
- 只有可信代理是唯一入口且会覆盖 `X-Real-IP` 时，才启用 `BRIDGE_TRUST_PROXY=1`。
- 缩小 `CODEX_ALLOWED_ROOTS`；只在明确需要时开放不受限下载或连接器网络访问。
- Token 一旦出现在聊天、日志、截图、提交、CI 输出或 Shell 历史中，应立即轮换。

## 设备管理

设备批准和撤销只能在转发服务主机执行：

```bash
docker compose exec bridge node build/server/device-admin.js pair https://codex.example.com
docker compose exec bridge node build/server/device-admin.js list-approved
docker compose exec bridge node build/server/device-admin.js revoke
```

转发服务会自动应用撤销并关闭对应连接，通常不超过 30 秒。

## 凭据可能泄露时

1. 撤销受影响设备；设备私钥泄露时直接视为设备失陷。
2. `BRIDGE_CLIENT_TOKEN` 泄露时，替换 Token 并重启转发服务。
3. `BRIDGE_CONNECTOR_TOKEN` 泄露时，替换 Token、重新安装连接器凭据并重启两端。
4. 检查 ECS 和代理日志、浏览器扩展、剪贴板、Shell 历史、CI 输出及相关基础设施凭据。

## 不在防护范围内

Codex Anywhere 不能防御已失陷的连接器电脑、ECS root 账号、已批准的浏览器配置，或用户主动批准的
恶意 Codex 操作。它不是通用远程 Shell、多租户身份系统或零信任网关。
