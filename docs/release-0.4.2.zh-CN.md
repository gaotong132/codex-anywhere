# v0.4.2 — 2026-10-17

[English](release-0.4.2.md) | 简体中文

维护版本，线协议仍为 4，无需重新配对。Browser Agent 仍是可选实验性附加特性。

## 主要变化

- PC 会话标题栏新增确认归档。保留聊天记录与项目文件，可在 Codex 客户端恢复；运行、等待审批或未知状态拒绝归档。恢复后浏览器页面需重新授权。
- 已有 Desktop 会话显示实际权限及电脑端打开/刷新入口；修复切换时权限图标累积。ECS 权限仍可从 Web 修改。
- 固定发送时的请求数据快照，避免草稿改动影响重连重放；归档也采用请求去重。
- 等长文件改写测试明确更新时间，不依赖文件系统时间精度。

## 升级

1. 检查各节点的本地改动和活动任务，保存当前提交、镜像 ID/标签、私有配置、设备注册表和 Connector 身份。保留业务会话与工作区，等待 Connector 持有的任务结束后再重启。
2. 在各节点的干净工作区选择发布版本。Windows 更新依赖前，按部署指南停止本安装的空闲 Connector 与守护器，释放已加载的原生模块：

   ```sh
   git fetch origin --tags
   git checkout --detach v0.4.2
   npm ci
   npm run build
   ```

   仅运行 Relay 的主机在 Docker 内构建，不需要宿主机 Node/npm。Connector 主机需要 Node.js 22+，依赖须与实际服务账号、运行时匹配。保留无关本地改动，不要直接 reset 覆盖。
3. Relay 执行 `docker compose build bridge`、`docker compose up -d --no-build bridge`；同机 Connector 空闲后构建 Node 产物并重启 `codex-anywhere-connector.service`。验证容器健康、公网 HTTPS、认证后的 WSS 和两个执行节点。`relay.sh update` 跟随 main，不固定 tag、不负责备份，也不等待任务空闲。
4. Windows 构建后，通过既有启动器/守护器实际重启 Connector。只重跑安装器不一定替换正在运行的进程，参见[实际重启步骤](deployment.zh-CN.md#windows-连接器实际重启)。保留 DPAPI 配置和身份，不停止 Codex Desktop。
5. 完整刷新 Web，侧栏可使用“重新加载聊天”。检查原有历史、图片、文本/HTML 预览和确认后的文件下载。不需要数据库迁移或重新配对，源文件仍须存在。
6. 使用插件时运行 `npm run build:extension`，将整个 `extension/dist` 保留在原安装路径并重新加载。该目录是生成产物，不提交 Git。本版没有新增浏览器权限，`dev (build …)` 仍表示解压加载的实验构建。
7. 验收后记录当前与上一版镜像 ID。核对全部容器（含停止容器）及并行构建，仅逐项删除明确的旧项目镜像引用。保留最近两次部署及基础/容器依赖镜像；不清理共享缓存、数据卷或其他任务容器。验收失败时恢复匹配镜像/代码，保留升级后合法的设备注册变化。

## 验证与限制

发布检查包括四项类型检查、主测试、Web/Node 构建、扩展测试和文档校验。使用真实 Desktop 临时会话验证归档及恢复，不修改业务会话；见[代码审视](code-review-2026-10-17.zh-CN.md)。

PC 需要更新并重启 Connector 后才显示归档入口。Web 暂不提供已归档列表或恢复按钮，需在 Codex 客户端恢复。其他客户端可能在状态检查后启动任务，原生占用冲突将返回失败，不会强制抢占或改用删除。请求去重仍受进程生命周期与缓存期限限制。

官方 npm 审计仍有 KaTeX/Mermaid 链上的两项低风险条目，无中、高、严重级别条目。服务器私有并发/删除改动不属于本 tag 的公共功能。
