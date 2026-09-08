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
   并允许访问这个站点。此处只填地址，配对链接在聊天页输入一次。
3. 侧栏加载线上 Web，直接选择 PC、ECS 等环境及会话，发送消息、切换模型或处理审批。
   同一浏览器配置、同一站点且已允许站点权限时，可沿用 Web 已有配对；否则在聊天页配对。
4. 聊天配对成功后，页面控制自动关联并连接，无需第二条配对链接；已经配对的聊天也可直接关联新插件。
   在侧栏选好聊天会话并点击「授权当前页」，按浏览器提示允许当前站点访问。设置中无需再次选择环境或会话。
   Web 与插件仍各自保存私钥；只传递绑定本次连接和插件身份的关联签名，不复制 Web 私钥。重新加载插件保留身份。
   主动断开后不会自动重连，点击「重新连接」恢复。升级本功能需同时更新 Relay/Web 和插件，再重新加载聊天。

顶部只保留授权状态和「⋯」更多菜单；「服务器地址」「页面控制设置」「重新加载聊天」「撤销页面授权」
收在菜单中。当前页已授权给当前会话时显示「已授权」，完整授权归属与站点可在更多菜单查看。
切换聊天会话不会自动把页面授权转移过去；若当前页属于另一会话，会明确提示原会话名称。切换标签页后直接点击
「授权当前页」，无需再次点击工具栏图标。授权弹窗期间若切换会话、标签页或刷新文档，需要确认后重新点击。
关闭侧栏不主动撤销页面控制；
「撤销页面授权」会撤销起始页及其子页。页面导航、关闭或文档替换仍按原有规则撤销授权。

插件通过链接打开新页签时，Chrome 会在原窗口自动切到新页签，侧栏保留当前聊天会话。
同站且已有站点权限的子页可继续操作；跨站或缺少权限时，新页会显示出来等待授权，切换页签本身不授予控制权限。

重复链接优先复用本任务中地址相同、文档仍有效且未编辑的受控子页。普通子页保留最近使用的 5 个，
成功操作后自动关闭更早的空闲子页，并撤销对应页面授权。起始页、手动页签、固定/播放声音的页签、
移到其他窗口的页签以及检测到输入或更改的页面不会被清理；正在操作或浏览的页面也会保留。
保护的页面不计入这 5 个额度。该规则仅处理仍有来源记录的受控子页，不按网址批量关闭历史或未授权页签。

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

4. 按[部署文档](../docs/deployment.zh-CN.md)生成一条单次浏览器配对链接，在侧栏聊天输入即可。
   已配对的 Web 无需新链接，插件自动关联。Relay 仍分别登记 Web 与插件设备，保留独立撤销能力；
   撤销 Web 会同时撤销其关联插件，显式撤销的设备不会被自动重新登记。旧版独立配对身份继续有效。
   公网必须 HTTPS/WSS，仅 `localhost` 或 `127.0.0.1` 允许 HTTP/WS。
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
  且旋转授权 ID；单页应用的 URL 变化仅在原 documentId/来源校验通过时保留授权，文档替换、撤销、标签页关闭或浏览器重启后须重新授权。
  网络断开时不会重放点击/输入；超时操作可能已执行，先读取页面确认，不能盲目重试。
- 起始页导航/关闭/撤销会停止所有子页的纳管；子页导航仅撤销自身。连接器重启若丢失子页来源记录，
  仅恢复起始页，请让 AI 重新打开子页。撤销或丢失来源记录本身不会关闭页签；普通受控子页按上述保留规则清理。站点权限可在 Chrome 扩展设置中移除。
- 工具只使用当前快照生成的元素引用，输入/点击后旧引用失效。不支持任意 JavaScript、Cookie/密码导出、
  文件上传、浏览器内部页、iframe、shadow DOM、canvas、原生弹窗或桌面控制。可见正文仍可能含敏感信息，
  这不是自动脱敏系统。密码/敏感输入、表单值、隐藏和 `data-anywhere-private` 区域不会进入快照。
- 工具调用使用 Codex 宿主给出的 Session/轮次身份，而非模型参数。PC Desktop 会话仍由 Desktop 持有，
  Connector 不接管写入端，也不对其他任务发送报告。

## 控制台操作与诊断

仍使用原有六个工具。快照把按钮内嵌文字和可见标签关联到可操作的 ref，并按需提供 `role`、`inputType`、
`disabled`、`checked`、`expanded`、`scrollable`。默认不读取表单当前值。
遍历时直接跳过隐藏/私有分支和 select/textarea 的内部内容，折叠菜单不会在可见控件之前耗尽扫描额度。
快照返回 `scannedElements`；截断时附 `truncationReason`（`scan_limit`、`node_limit`、`text_limit`、`result_limit`）。
最多检查 5,000 个节点，输出最多 200 个节点、8,000 个文本字符；序列化预算为 23,000 字符，低于 Connector 的 24,000 字符上限。
控件的内嵌标签只输出一次。具有可聚焦属性、内联点击处理或手形光标的自定义控件也可获得 ref；这些是可交互的提示，
不等同于操作已经生效，点击后仍须验证结果。禁用/遮挡检查和链接纳管流程保持，独立的内嵌控件仍可操作。
没有 `href` 的 a 元素可以作为普通控件点击；只有具备实际 HTTP(S) 目标的链接才能使用 `open_link`。
点击和填写时对支持聚焦的控件正常聚焦，不触发滚动；填写仍不自动提交表单。

- `fill` 支持文本和数字输入。数字先校验浏览器原生的 `min`、`max`、`step`、必填约束，通过后才改值。
  操作触发 input/change 事件，不提交表单。
- 原生单选下拉框先用 `click` 获取最多 50 项选项标签和禁用状态，不改变选择、不返回选项内部值。
  重新读取快照后，用 `fill` 填写一个完整、无歧义的可用标签。暂不支持多选框；自定义下拉框通过可见的
  combobox/option ref 点击，没有暴露可操作控件的组件仍属于能力缺口。
- `scroll` 可传入快照中 `scrollable` 面板的 `ref`；省略时滚动整页。结果说明是否实际移动，随后重新读取快照。
  被面板边界裁剪的内容会在滚入可见范围后才出现在快照中。

排查先调用 `list_pages`。`environmentId` 表示实际连接到的环境；`no_authorized_page` 表示当前任务在该连接器上
没有授权，`authorized_pages_offline` 表示已有授权但全部心跳离线，`ready` 表示至少一个页面在线。
计数覆盖当前任务全部授权，不受分页影响。成功返回空列表说明 MCP 到连接器的调用成功，不能据此认定扩展断线
或用户没有做过授权。先核对侧栏的环境、任务和扩展状态，再判断是否需要重新授权；不会列出其他任务或未授权标签页。

页面脚本、扩展、连接器、MCP 全链路保留具体错误码，并附恢复建议。引用过期需要重新读取快照；被遮挡需要检查
弹窗或覆盖层；数字无效、选项不可用时保持字段原值。这些失败不会撤销页面授权。
iframe、shadow DOM、canvas、文件上传和原生对话框仍不支持，遇到时应明确报告插件能力缺口，重新配对不能解决。
写操作超时仍可能已经执行，必须先检查结果再重试。

连接器/MCP 与扩展需要同步更新。已经运行的 MCP 进程和 Chrome 已加载的扩展仍使用旧代码，仅生成构建文件不会自动更新它们。

## 验证记录与待验收项

2026-09-08，独立 Chrome for Testing 151 经本地 Relay/E2E 验证了 HTML/body 溢出传播后的滚动读取、
无盒容器、图片始终未完成时读取子页、脚本新开页不重复创建且可读取、迟到弹窗不纳管，以及源页刷新撤销。
这些是通用模拟页面，生产控制台仍需在重载扩展后验证。

快照补充 `viewport` 的视口尺寸、滚动位置及文档尺寸。传播给视口的 HTML/body 溢出属性与 `display: contents`
容器不会误裁剪可见后代；普通面板裁剪仍然有效。新页文档进入 interactive 即可操作，无需等慢图片等资源结束，
但这不表示应用异步内容全部加载完成，仍需根据可见结果确认。

扩展新增 `webNavigation` 权限，用于识别当前 AI 点击期间产生的新导航目标。仅原授权顶层文档产生的单个新页，
在来源文档、目标同源及站点权限检查通过后归原任务管理；点击结果返回 100 毫秒后停止监听，不追踪迟到弹窗、
已有页签或其他 frame。多目标、非 HTTP(S) 目标返回 `authorizationRequired`，不猜选、不重放点击。
操作期间避免在同一页并发手动导航。升级后若 Chrome 提示新增权限，需重新启用扩展。

2026-09-07，`test/fixtures/console-controls.html` 在真实 Chrome for Testing 151 中经本地 Relay/E2E 链路通过：
数字约束、原生选项精确选择、input/change 事件、面板裁剪与滚动、嵌套按钮文字、禁用/遮挡、错误透传和导航撤销。
隔离测试配置仅预授予 loopback 权限。这验证的是模拟表单的浏览器行为，尚未验收已登录云控制台及其自定义组件。

2026-09-07 在独立临时 Chrome 配置的真实侧栏中，使用构建后的 Web、插件和本地 Relay 验证了：
一条配对链接完成聊天与插件关联、两端独立身份、未自动授予网页控制、刷新侧栏后身份不变。
该用例只预授予测试副本的 loopback 站点权限；日常站点权限提示仍需用户点击。回归同时覆盖签名重放、
错误扩展/设备/窗口、未批准身份、级联撤销、断开后保持暂停及旧版独立配对。

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
