# Anywhere 浏览器扩展（实验性附加特性）

[English](README.md) | 简体中文

此插件是 Codex Anywhere 的**实验性附加特性**，默认关闭，需要单独构建、安装并显式配置
Relay；页面控制还需配置 Connector 和 MCP。日常会话功能无需安装此插件；其配置、交互和兼容性仍可能调整。

在侧栏聊天中选择运行环境（PC、ECS 或其他已连接节点）和**已有 Session** → 点击「授权当前页」。
之后回到 Anywhere，在这个原会话中让 Codex 读取、点击、输入、滚动该页。没有新建/借用其他会话的回退。
构建时 Manifest 版本自动跟随根目录 `package.json`，并显示 `版本 dev (build 构建指纹)`。
指纹取自构建产物和清单的内容，便于核对是否加载新代码；不代表发布新版本或打 Tag。当前不自动更新现网。

## 侧栏聊天

1. 更新 Relay，并把扩展管理页中的实际扩展 ID 加入 `BRIDGE_EXTENSION_ORIGINS` 白名单（配置见下文）。
2. 点击工具栏中的插件图标，填写 Anywhere 服务器地址，例如 `https://your-anywhere/`，点击「打开聊天」
   并允许访问这个站点。此处只填地址，配对链接在聊天页或「页面控制设置」中输入。
3. 侧栏加载线上 Web，直接选择 PC、ECS 等环境及会话，发送消息、切换模型或处理审批。
   同一浏览器配置、同一站点且已允许站点权限时，可沿用 Web 已有配对；否则在聊天页配对。
4. 要让会话操作网页，先通过「页面控制设置」完成插件自己的配对，再在侧栏选好聊天会话并点击
   「授权当前页」，按浏览器提示允许当前站点访问。设置中无需再次选择环境或会话；授权直接使用聊天当前选择。
   Web 与插件各有设备身份，不能重复消费同一条配对链接。重新加载现有插件保留原有配对。

切换聊天会话不会自动把页面授权转移过去；侧栏始终显示实际获授权的环境和会话。切换标签页后直接点击
「授权当前页」，无需再次点击工具栏图标。授权弹窗期间若切换会话、标签页或刷新文档，需要确认后重新点击。
关闭侧栏不主动撤销页面控制；
「撤销页面授权」会撤销起始页及其子页。页面导航、关闭或文档替换仍按原有规则撤销授权。

若旧页签早已关闭，但仍提示会话已有起始页，更新当前环境的 Connector 与插件后，再点击「授权当前页」。
这次明确授权可替换本插件残留的旧起始页；其他浏览器的旧起始页及全部子页都超过 45 秒无心跳时，也可回收。
替换会撤销整组旧页面并取消在途操作。离线本身不会自动转移授权，仍在线的其他浏览器不会被覆盖，原配对无需重做。

聊天界面随 Relay/Web 部署更新，点击「重新加载聊天」即可加载新代码。插件控制协议发生变化时仍需更新插件。
无法读取聊天会话时会禁用授权；长时间未连接会提示检查 Relay 更新、Origin 白名单和网络。内嵌页的摄像头可能
受浏览器限制，配对可使用粘贴链接或上传二维码截图。Chrome/Edge 的真实侧栏、复制、下载和休眠恢复需逐项验收。

## 构建与安装

使用 Node.js 22+，在仓库根目录运行：

```sh
npm ci
npm run check
npm run build
npm run test:extension
```

Chrome 120+ 的 `chrome://extensions` 中开启开发者模式，加载已解压的 **`extension/dist`**。
从旧预览升级时，在扩展管理页点“重新加载”，若浏览器提示新增权限，确认后重新启用。建议先用独立测试浏览器配置文件。

插件使用 `tabs` 权限读取当前窗口中活动标签页的地址，供侧栏识别授权目标。点击授权时才请求该站点的
可选访问权限；浏览器可能记住此站点权限。实际控制仍绑定当前会话、具体标签页与文档，不会自动纳管其他手动页签。

更新后请点击**扩展卡片上的圆形重新加载箭头**，不是刷新浏览器网页。核对卡片或扩展弹窗底部的
版本/构建指纹与 `extension/dist/manifest.json` 的 `version_name` 相同。如果仍显示 `0.0.1`，
新构建尚未加载。错误页可能保留旧记录，先“全部清除”，再打开扩展弹窗，检查是否产生新错误。

## 一次性配置

扩展不是独立的 Codex 客户端，只有安装扩展还不够：Relay、所选 Connector 和 Codex MCP 都要配置。

1. 在扩展面板或扩展管理页获取 ID。Relay 的环境变量增加精确 Origin：

   ```dotenv
   BRIDGE_EXTENSION_ORIGINS=chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   ```

   把示例 ID 换成实际 ID。多个 Origin 用逗号分隔，禁止通配符。Compose 已透传此设置。
   需在计划的更新窗口重启测试 Relay 后生效，不要为了试插件重启业务现网。

2. 在每个希望被选中的 Connector 主机上设置 `BRIDGE_BROWSER_ENDPOINT_FILE`，值为**绝对路径**，
   位于该运行用户的私有状态目录，不能在仓库、网站静态目录或共享目录下。例如 Windows
   `C:\Users\YOUR_USER\.codex-anywhere\browser-pc.json`；Linux
   `/home/YOUR_USER/.codex-anywhere/browser-ecs.json`。Windows 目录 ACL 必须仅允许运行用户及管理员。
   使用此配置启动该分支 Connector；文件由 Connector 创建，含本机 IPC 端口和随机凭证，不得分享。
   不设置变量时浏览器工具功能关闭，不影响原来的会话功能。

   使用 Windows 登录启动器时，在私有 `connector.json` 中持久配置 `browserEndpointFile` 为上述绝对路径，
   重启后会自动恢复该设置。若 `.codex-anywhere` 目录存在额外读取权限，应创建仅运行用户和管理员可读的
   私有子目录保存端点文件，不要将 IPC 凭证暴露给其他本机用户。

3. 用与该 Connector 相同的 OS 用户，在该节点的 Codex 配置中注册标准 stdio MCP。路径必须替换为实际绝对路径：

   ```sh
   codex mcp add anywhere_browser -- node /ABSOLUTE/REPO/build/browser-control/mcp-server.js /ABSOLUTE/PRIVATE/browser-endpoint.json
   ```

   Windows 示例（`node` 应可由 Desktop 找到，否则写 Node 的绝对路径）：

   ```powershell
   codex mcp add anywhere_browser -- node "D:\project\codex-anywhere\build\browser-control\mcp-server.js" "C:\Users\YOUR_USER\.codex-anywhere\browser-pc.json"
   ```

   确认 `codex mcp list` 中存在此工具；重新加载 Codex 的 MCP 配置。Desktop 可能需要在任务空闲时重启应用。
   **不新建替代 Session**：原会话必须实际提供 `anywhere_browser_list_pages/snapshot/click/fill/scroll/open_link`。
   更新这轮代码后，Connector 与 MCP 也需更新并在空闲时重新加载；只重新加载 Chrome 扩展不够。
   兼容性依赖宿主提供 `x-codex-turn-metadata.thread_id/turn_id`；缺失时安全拒绝，不接受模型填 ID。
   参考 [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

   要让已经授权的会话直接执行浏览器任务，在同一主机的 Codex `config.toml` 中为这四个具体工具预授权：

   ```toml
   [mcp_servers.anywhere_browser.tools.anywhere_browser_click]
   approval_mode = "approve"
   [mcp_servers.anywhere_browser.tools.anywhere_browser_fill]
   approval_mode = "approve"
   [mcp_servers.anywhere_browser.tools.anywhere_browser_scroll]
   approval_mode = "approve"
   [mcp_servers.anywhere_browser.tools.anywhere_browser_open_link]
   approval_mode = "approve"
   ```

   修改后重新加载 Codex MCP。此配置只免除这四个工具的逐次宿主审批；插件的页面授权、会话隔离、站点权限
   和用户任务范围仍生效，不修改全局审批策略或其他 MCP。工具保持真实的读写标注。如果出现
   `MCP tool call requires approval, but approval policy is never`，说明调用被 Codex 在执行前拦截，
   不能据此认定浏览器离线、未登录或跨域失败。可用 `npx tsx scripts/probe-browser-mcp.ts --write`
   在临时合成任务中验证 `never` 策略下预授权的点击，探针不访问实际网页。

4. 按[部署文档](../docs/deployment.zh-CN.md)生成一条新的单次浏览器配对链接，粘贴进扩展。
   已被 Web 浏览器消费的链接不能重用；这注册的是独立的扩展设备。配对成功后只保留设备密钥和服务器 Origin，
   不保留配对秘密。公网必须 HTTPS/WSS，仅 `localhost` 或 `127.0.0.1` 允许 HTTP/WS。
   Chrome CSP 不支持 IPv6 字面地址来源，因此本机 HTTP 请勿使用 `[::1]`。公司代理若阻断 WS，插件不会绕过。

## 使用与边界

- 在聊天中选择环境与现有 Session，确认侧栏上方标题后点“授权当前页”。一个扩展/Session 保持一个手动授权的起始页。
  更多菜单可撤销起始页及子页，再更换会话或页面；不再有实验性“读取页面/停止并清除”。
- 侧栏授权时允许的站点权限也支持 AI 打开的同站子页；使用旧临时授权时，可在设置中补充该站点权限。
  然后在原会话说“把这个页面的详情链接打开到新标签页并查看”。AI 通过 `open_link` 或点击新页链接创建的
  同源子页会自动纳管；跨源链接/重定向或缺少站点权限时，先打开目标页供用户授权，不读取或纳管该页。
  手动页签和网站自己弹窗不会继承授权。普通链接点击也使用这个开页流程，保留原页授权。链接必须来自当前快照，
  不接受任意 URL。权限按站点由 Chrome 保存，实际操作仍校验精确来源（包括端口）、页面和会话。
  多个受管页面时模型先列举，再明确选择 `pageId`；不会默认操作第一个页面。
- 回到 Anywhere 的原会话，例如发送“读取已授权页面的标题”或“在这个测试页的搜索框输入 demo”。
  任务所需的导航、搜索、普通点击和输入应直接执行，实际遇到登录、密码、验证码、新站点权限或超出任务范围
  的操作才暂停。“检查 ECS 状态”包括进入控制台和实例列表，不包含开关机；看到“登录”链接本身不代表已确认未登录。
  Web 显示“浏览器已授权”和子页数量，提示区区分 MCP 尚未验证与最近工具调用成功；心跳在线并不代表模型
  已加载工具。CUA 内置浏览器和 Anywhere 扩展不是同一个浏览器。操作可能改变网站数据，请明确需要的操作。
- **授权没有 10 分钟限制**。单次操作最多 15 秒。20 秒心跳维持连接；超过 45 秒未收到心跳显示离线。
  正文和操作通过现有端到端加密通道传输，Relay 不读取内容。
- 关闭弹窗不撤销授权。后台 worker 重启/网络重连只恢复当前浏览器生命周期中、相同 Session、相同文档的同意，
  且旋转授权 ID；撤销、标签页关闭、页面导航（含保守处理的同源 URL 变化）、浏览器重启后须重新授权。
  网络断开时不会重放点击/输入；超时操作可能已执行，先读取页面确认，不能盲目重试。
- 起始页导航/关闭/撤销会停止所有子页的纳管；子页导航仅撤销自身。连接器重启若丢失子页来源记录，
  仅恢复起始页，请让 AI 重新打开子页。不会自动关闭这些浏览器页签。站点权限可在 Chrome 扩展设置中移除。
- 工具只使用当前快照生成的元素引用，输入/点击后旧引用失效。不支持任意 JavaScript、Cookie/密码导出、
  文件上传、浏览器内部页、iframe、shadow DOM、canvas、原生弹窗或桌面控制。可见正文仍可能含敏感信息，
  这不是自动脱敏系统。密码/敏感输入、表单值、隐藏和 `data-anywhere-private` 区域不会进入快照。
- 工具调用使用 Codex 宿主给出的 Session/轮次身份，而非模型参数。PC Desktop 会话仍由 Desktop 持有，
  Connector 不接管写入端，也不对其他任务发送报告。

## 验证记录与待验收项

已覆盖真实本地 Relay/WebSocket/E2E + **构建后 worker** + Chrome API/DOM 测试替身，包含配对重试、
原 Session 路由、读/点击/输入、旧引用、跨任务拒绝和撤销。另有官方 MCP SDK → 私有 IPC → broker 联调。

```sh
# 可选：会调用真实 Codex，仅创建临时测试任务、读取合成 fixture，不访问业务会话/网页或修改全局配置。
npx tsx scripts/probe-browser-mcp.ts --integration
```

2026-09-04 经所有者授权更新 Relay/Web、PC 和 ECS Connector，并用独立 Chrome for Testing 151
加载真实扩展验收。PC 0.153.0 的原会话通过 Desktop 路径完成页面读取；ECS 0.151.0 完成
读取、滚动、输入和点击，写操作经 Web「批准一次」确认。配对填码、环境切换、刷新重连、撤销和
跨会话/环境拒绝也已实测。详见[部署验收记录](../docs/browser-rollout-2026-09-04.md)。

尚未覆盖用户日常 Chrome/Edge 配置文件、长时间休眠唤醒、强制 worker 更新及全部 PC 写操作审批组合。
已有 Chrome 扩展须在管理页点「重新加载」；不会强制重启用户浏览器或业务会话。

固定手工测试页：运行 `npx vite --config extension/vite.config.ts --host 127.0.0.1`，打开输出的本机地址下
`/test/fixtures/control.html`，授权给专门的测试 Session。页面内输入框和计数按钮不提交网络请求。
`test/fixtures/evaluation.xml` 是十道独立只读模型评估题（读取目录和订单两个区块，必要时滚动），
答案固定；该文件是验收用例，不是已执行的模型评分报告。

参见[架构与验收清单](../docs/browser-agent.zh-CN.md)。
