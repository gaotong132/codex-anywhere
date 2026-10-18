# v0.4.4 — 2026-10-18

[English](release-0.4.4.md) | 简体中文

维护版本，继续使用协议 4，保留配对身份；Browser Agent 仍为可选实验性附加特性。

## 主要变化

- 两个以内执行环境直接显示按钮；切换及自动恢复最近会话时保持侧栏展开，选定会话后收起。
- 统一两个编辑器的附件准备与释放。连续选择、移除、关闭弹窗或切换环境后，迟到的图片和错误不会覆盖当前草稿。
- 纳入紧凑的手机审批/归档提示，刷新双语文档及 README 截图。

## 升级

1. 检查各节点的本地改动和活动任务，保存当前提交、镜像 ID/标签、私有配置、设备注册表和 Connector 身份。保留业务会话与工作区，等待 Connector 持有的任务结束后再重启。
2. 在各节点的干净工作区选择发布版本。Windows 更新依赖前，按部署指南停止本安装的空闲 Connector 与守护器，释放已加载的原生模块：

   ```sh
   git fetch origin --tags
   git checkout --detach v0.4.4
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

[审查报告](code-review-0.4.4.zh-CN.md)记录覆盖范围、问题和检查。没有新增协议动作、设备权限或数据迁移。部署后刷新 Web；现有 v0.4.3 Connector 协议兼容，本轮 Web 修复不要求重启 Connector。实验插件重新构建以对齐版本信息。

Mermaid 12 暂缓升级，需单独验证浏览器兼容性；官方 npm 审计仍有 KaTeX/Mermaid 链上的两项低风险条目。文件元数据检查不等于原子文件系统快照。服务器私有并发/删除改动会保留，但不是公开 tag 的特性。
