# v0.4.1 — 2026-10-16

[English](release-0.4.1.md) | 简体中文

这是 v0.4.0 之后的维护版本。Browser Agent 仍是**可选实验性附加特性**。线协议保持版本 4，保留已有设备配对。

## 主要变化

- 历史摘要和实时记录即使时间精度不同也正确合并，保留确实重复的发言；手机后台恢复后保留历史、图片与阅读位置，从超大会话日志补齐桌面端问题答案。
- 未完成的变更请求独立于已完成结果缓存，避免淘汰或 TTL 到期后重连重放导致重复执行；限制等待请求数量，结果 TTL 从完成时起算。
- 文本、图片和可视化共用有界读取与文件快照；拒绝读取期间变化的文件，校验可视化 UTF-8，并识别保留大小与修改时间的图片替换。
- 异步打开前预留下载名额，服务关闭后不发布新下载，过期清理不关闭活动读取，最后一块完成前重新核对文件。
- 汇总已审查的依赖升级，统一 React 配套包至 19.3.0。Mermaid 保持 11.17.2；发布审计仍有 KaTeX/Mermaid 依赖链的两项低风险条目，无中、高、严重级别条目。
- 刷新中英文文档，将 `npm run check:docs` 纳入 `npm run check`；package、lockfile、扩展源清单与 MCP 统一为 0.4.1。

## 升级

1. 检查各节点的本地改动和活动任务，保存当前提交、镜像 ID/标签、私有配置、设备注册表和 Connector 身份。保留业务会话与工作区，等待 Connector 持有的任务结束后再重启。
2. 在各节点的干净工作区选择发布版本。Windows 更新依赖前，按部署指南停止本安装的空闲 Connector 与守护器，释放已加载的原生模块：

   ```sh
   git fetch origin --tags
   git checkout --detach v0.4.1
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

发布检查包括 451 项主测试、四个 TypeScript 目标、Web/Node 生产构建、编译后的扩展测试，以及本地文档链接、标题锚点和版本一致性。[代码审视记录](code-review-2026-10-16.zh-CN.md)说明已复现问题和保留边界。发布部署还检查 HTTPS/WSS、Connector 状态以及两端的实际文件操作。

重放保护有界且仅存在于进程内：已完成缓存会过期或淘汰，Connector 重启不提供持久化“恰好执行一次”。文件检查检测正常并发修改，不是防恶意操作系统的机制或原子文件系统快照。下载仍在浏览器内组装 Blob，上传文件仍是临时存储，刷新不能恢复已删除源文件。

浏览器登录、MFA、新站点授权及请求范围之外的操作仍需要用户参与。浏览器自动化不等同于手机真机验收，带日期的报告与截图保留原始范围。

参见[部署](deployment.zh-CN.md)、[安全](SECURITY.zh-CN.md)、[插件安装](../extension/README.zh-CN.md)和[更新日志](../CHANGELOG.zh-CN.md)。
