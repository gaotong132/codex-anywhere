# Anywhere Browser extension (experimental add-on)

English | [简体中文](README.zh-CN.md)

This extension is an **experimental add-on** for Codex Anywhere, disabled by default. It requires a separate
build and installation plus explicit Relay configuration; page control also needs Connector and MCP setup. Normal session features do
not require it; its configuration, interactions, and compatibility may still change.

In side panel chat, choose an execution environment (PC, ECS, or any connected node) and an **existing
Session**, then authorize the current page. Continue that original Session in Anywhere to read, click, fill,
and scroll. No replacement Session is created. The built manifest follows the root `package.json` version
and displays `version dev (build fingerprint)`. The content fingerprint identifies the loaded artifacts;
it does not publish a release or create a Tag.

## Side panel chat

1. Update the relay and allow the actual extension ID in `BRIDGE_EXTENSION_ORIGINS` (see configuration below).
2. Click the toolbar icon, enter the Anywhere server address, such as `https://your-anywhere/`, and choose
   **Open chat**, granting access to that site. Enter only the server address here; pairing links belong in
   the chat page, once.
3. The panel loads the live Web app. Select a PC/ECS environment and Session to chat, configure models, or
   handle approvals. The same browser profile and site can reuse existing Web pairing when host permission
   is granted; otherwise pair in the chat page.
4. Once chat is paired, page control links and connects automatically without a second pairing link. An already paired
   Web client can link a new extension too. Select the chat Session and click **Authorize current page**, allowing site
   access when prompted. Web and extension retain separate private keys; only a connection-bound association signature
   crosses the frame boundary. Reloading preserves identity. An explicit disconnect pauses automatic reconnection;
   **Reconnect** resumes it. Update Relay/Web and the extension together, then reload chat for this feature.

The compact header keeps the authorization state and a **⋯** menu. Server address, page control settings,
reload chat, and revoke page access live in that menu, alongside the full grant owner and site. **Authorized**
appears only when the current page belongs to the selected Session. Changing the chat Session does not transfer
consent; a page owned by another Session names that owner. After switching tabs, authorize from the panel without another toolbar click.
Changing the Session, tab, or document during the permission prompt requires a new authorization click.
Closing the panel does not revoke page control. Revocation removes
the root and its children; navigation, tab closure, and document replacement retain the existing revocation rules.

Links opened by the extension become the active tab in their original Chrome window while the side panel keeps
the current chat Session. Same-origin children with site permission remain controllable; other destinations open
visibly for authorization. Activating a tab does not grant control of its site.

Repeated links reuse an unedited, still-authorized child at the same URL in the same task/window.
Keep the 5 most recently used ordinary children; after successful operations, close older idle children and
revoke their grants. Root/manual tabs, pinned or audible tabs, tabs moved to another window, and pages with
detected input/changes are preserved and do not consume this allowance. Active or busy pages are also retained.
Cleanup uses existing child provenance, never URL-based discovery of historical or unauthorized tabs.

If a closed tab still occupies the Session, update the selected Connector and extension, then click **Authorize current
page** again. This explicit grant can replace this extension's orphaned root, or another browser's root when every page
in its tree has missed heartbeats for 45 seconds. Replacement revokes the old tree and cancels pending operations.
Offline status alone never transfers consent, and another live browser is not displaced. Existing pairing is preserved.

Chat UI updates follow Relay/Web deployment: use **Reload chat** to load new code. Control protocol changes still
require an extension update. Missing/stale chat state disables authorization; a connection warning points to relay
updates, the Origin allowlist, and network setup. Camera access may be restricted in the frame; paste a pairing link
or upload a QR screenshot instead. Actual Chrome/Edge side panels, clipboard, downloads, and sleep recovery need acceptance checks.

## Build and install

With Node.js 22+, from the repository root:

```sh
npm ci
npm run check
npm run build
npm run test:extension
```

Use Chrome 120+ → Extensions → Developer mode → Load unpacked → **`extension/dist`**. Reload the extension
when upgrading the previous preview, and re-enable it if Chrome asks you to accept the added permission. Prefer a separate test browser profile.

The `tabs` permission provides the active tab's address in the panel's window. Site access remains optional and is
requested only on an authorization click. Chrome may remember that site permission; actual control still requires
the selected Session, exact tab, and document grant. Other manually opened tabs are never automatically adopted.

Real mouse input requires the manifest's `debugger` permission; Chrome does not support it as an optional permission.
Reload/re-enable the updated extension and accept Chrome's new permission warning if prompted.
Chrome may show a debugging notice during an operation. The extension attaches only to
the already granted tab, sends a fixed move/press/release sequence, then detaches. It does not expose debugger
commands or coordinates to the model, grant other tabs, disable popup protection, or take over another debugger.
Browser policy denial or a debugger conflict is reported without a DOM-click fallback.

`webNavigation` identifies newly created navigation targets during an AI click. Only one new target from the
authorized top-level document can join the same task, after its source document, destination origin and site access
are verified. The listener ends 100 ms after the click result; delayed popups, existing tabs and other frames are
not followed. Multiple or unsupported destinations return `authorizationRequired`, without choosing one or replaying
the click. Avoid simultaneous manual navigation in the page being operated on. Chrome may ask to re-enable the
updated extension because of this additional permission.

Click the **reload arrow on the extension card**, not the browser's page refresh button. Confirm the version
and fingerprint on the card or popup footer match `version_name` in `extension/dist/manifest.json`.
If it still shows `0.0.1`, the new build has not loaded. Clear historical entries on the extension's Errors
page, then reopen the popup and check whether any new errors appear.

## One-time setup on test infrastructure

1. Configure Relay `BRIDGE_EXTENSION_ORIGINS=chrome-extension://YOUR_EXACT_32_CHARACTER_EXTENSION_ID`.
   Use the actual ID shown in the popup/Extensions page; multiple exact Origins are comma-separated.
   No wildcards. Compose passes this setting through. Restart the test Relay during a planned update window;
   this branch does not deploy or restart production automatically.
2. On each selected Connector host, set `BRIDGE_BROWSER_ENDPOINT_FILE` to an **absolute private state path**
   outside the repository, static Web root and shared directories. Example:
   `/home/YOUR_USER/.codex-anywhere/browser-ecs.json`, or
   `C:\Users\YOUR_USER\.codex-anywhere\browser-pc.json`. On Windows, restrict directory ACLs to the runtime
   user and administrators. Start the branch Connector with this setting. It creates a private loopback
   port/token file; never share it. Without the setting, browser control remains disabled.
   With the Windows login launcher, persist that absolute path as `browserEndpointFile` in private
   `connector.json`. If the parent state directory grants other users read access, use a private child
   directory restricted to the runtime user and administrators for the endpoint file.
3. As the same OS user, register the standard stdio MCP server in Codex using actual absolute paths:

   ```sh
   codex mcp add anywhere_browser -- node /ABSOLUTE/REPO/build/browser-control/mcp-server.js /ABSOLUTE/PRIVATE/browser-endpoint.json
   ```

   On Windows quote paths and use an absolute Node executable if Desktop cannot resolve `node`. Check
   `codex mcp list`, then reload MCP configuration; Desktop may need a restart when tasks are idle.
   The **original Session** must expose `anywhere_browser_list_pages/snapshot/click/fill/scroll/open_link`. Never start a substitute.

   For direct execution in an authorized Session, preapprove these four specific tools in that host's Codex `config.toml`:

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

   Reload Codex MCP afterward. This removes per-call host prompts for those tools only; page consent, Session isolation,
   site permissions and task scope still apply. Keep truthful write annotations and other MCP/global approval settings.
   `MCP tool call requires approval, but approval policy is never` means Codex blocked execution; it is not evidence of
   a browser, login or cross-origin failure. See [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
   Run `npx tsx scripts/probe-browser-mcp.ts --write` to verify an explicitly preapproved click under `never`
   using an ephemeral synthetic task, without accessing a real website.
   Update/reload the Connector and MCP while idle as well; reloading the Chrome extension alone is insufficient for these changes.
   Host metadata `x-codex-turn-metadata.thread_id/turn_id` is required; missing context fails closed.
   See [Codex MCP configuration](https://developers.openai.com/codex/mcp/).
4. Generate one single-use pairing link using the [deployment instructions](../docs/deployment.md) and enter it in chat.
   Already paired Web clients need no new link. Relay records the linked extension separately; revoking Web also revokes
   its linked plugins, and explicit revocation blocks automatic re-enrollment. Existing independently paired plugins remain
   valid. Public connections require HTTPS/WSS; only `localhost` or `127.0.0.1` permits HTTP/WS.
   Chrome CSP does not support IPv6 literal sources, so do not use `[::1]` for local HTTP. Corporate proxy WS blocking is not bypassed.

## Use and boundaries

- Choose the environment and existing Session in chat, verify its title above the chat, authorize the current page, then converse
  in that Session in Anywhere. Keep one manually authorized root per extension/Session. Revoke the root and its
  children from the secondary menu before selecting another root or Session.
- Site access granted by the side panel also permits AI-opened same-site children. Older temporary root grants
  can request that optional permission from settings. `open_link` or a link click from a fresh snapshot creates
  a same-origin managed child, keeping its parent authorized. Cross-origin destinations/redirects or missing site permission
  open a visible tab for the user to authorize, without reading or adopting it. No arbitrary URLs, manually opened tabs or
  unsolicited site popups inherit consent. Chrome stores site permission, while runtime checks still require the exact origin
  (including port), document and Session. Multiple managed pages require an explicit `pageId` from the list tool.
- Web says “Browser authorized” with a child count. Its hint distinguishes unverified MCP tools from a recorded
  successful call; heartbeat alone does not prove model tool availability. In-app CUA and Anywhere are separate browsers.
- Execute task-required navigation, search, clicks and ordinary input directly. Pause at actual login, passwords,
  verification, new site permissions or actions outside the requested scope. Checking ECS status includes opening its
  console and instance list, not starting/stopping instances. A Login link alone does not establish the login state.
- No ten-minute consent limit; commands time out after 15 seconds. Heartbeats run every 20 seconds;
  more than 45 seconds without a heartbeat means offline, not expired consent. The Relay only transports
  end-to-end encrypted operation/results frames.
- Closing the popup does not revoke. Worker/network restart can restore only the same Session/document consent
  within the current browser lifetime, with a new grant ID. Same-document SPA routes retain consent only after an exact
  documentId/origin check; document replacement, tab closure, revocation or browser restart requires new consent. Timed-out writes may have
  executed: inspect before retrying. Writes are never replayed automatically after disconnect.
- Root navigation/closure/revocation stops all children; child navigation stops only that child. A connector restart
  that loses child provenance restores only the root; ask AI to open children again. Revocation or lost provenance alone
  does not close tabs; ordinary managed children follow the retention policy above.
  Optional site permissions can be removed in Chrome extension settings.
- Page content is untrusted and may contain sensitive visible text. Snapshots omit form values, sensitive
  inputs, hidden/private regions; this is not automatic secret redaction. References are snapshot-scoped and
  invalidated after click/fill. No arbitrary scripts, password/cookie export, file upload, browser internal
  pages, iframe/shadow DOM/canvas, native dialogs or desktop control. Website-changing actions need user authority.
- The Codex host supplies caller identity. Desktop retains its existing writer; the Connector does not take
  over or send messages to other tasks.

## Console controls and diagnostics

The same six tools support console forms. Snapshots attach nested button text and visible labels to actionable refs,
and include `role`, `inputType`, `disabled`, `checked`, `expanded` and `scrollable` when applicable. Form values stay omitted.
Hidden/private branches and select/textarea contents are skipped during traversal, so a collapsed menu does not consume
the scan budget before visible controls. Snapshots report `scannedElements` and, when truncated, `truncationReason`
(`scan_limit`, `node_limit`, `text_limit`, `result_limit`). Snapshots inspect at most 5,000 elements and return up to 200 nodes
and 8,000 text characters, with a 23,000-character serialized budget below the Connector's 24,000-character ceiling.
Nested control labels are returned once. Custom controls with focusability, an inline click handler or a pointer cursor
can also receive refs; these are interaction hints, not proof of a successful action. Verify the result after clicking.
Disabled/obscured checks and the managed-link flow still apply; independent nested controls remain available.
Anchors without `href` can be clicked as controls; only anchors with actual HTTP(S) destinations can be opened as links.
Real mouse clicks perform the browser's normal pointer and focus behavior; filling focuses without scrolling and does not submit forms.
Click checks a point inside a visible line fragment after viewport/panel clipping. A partly visible control or
wrapped inline link can be operated without mistaking its offscreen center or whitespace for an overlay;
controls actually covered by another element still return `browser_element_obscured`.
Before pressing and releasing, the extension rechecks the exact document, ref, visible point and current grant.
Its own hover/focus styling may change; replacement nodes, changed labels/actions and overlays still stop the click.
If a press has started but completion cannot be confirmed, it returns `browser_native_click_interrupted`:
inspect the page before any retry. A dispatched click is not proof of the application's intended result.

Snapshots include `viewport` dimensions, scroll position and document size. Document overflow propagated to the
viewport and `display: contents` wrappers do not hide visible descendants; ordinary clipped panels still do.
New children become usable when the document is interactive, even while images or other optional resources load.
This does not assert that an application's asynchronous content has finished; verify its visible result normally.

- `fill` accepts text and numeric inputs. Native number constraints (`min`, `max`, `step`, required) are checked before
  changing the input. It emits input/change events but does not submit the form.
- For a native single select, `click` returns up to 50 option labels and disabled states without changing selection
  or returning option values. Take a fresh snapshot, then `fill` with one exact, unambiguous enabled label.
  Multiple selects are unsupported. Custom dropdowns use visible combobox/option refs and ordinary clicks;
  widgets without exposed controls remain a capability limit.
- `scroll` accepts an optional `ref` for a visible `scrollable` panel; omit it for the page. Snapshots include
  `scrollAxes` (`x`/`y`) and `scrollPosition` (`x`, `y`) for panels. Each delta is an integer within ±2000 pixels:
  vertical `{deltaY: 500}`, horizontal `{deltaY: 0, deltaX: 500}`, or both `{deltaY: 200, deltaX: -300}`.
  Positive deltas move right/down and negative deltas left/up; RTL panels retain native negative scroll coordinates.
  Unsupported panel axes fail before either axis moves. Results report actual `deltaX`/`deltaY` and `scrolled`;
  zero movement can mean an edge was reached. Read a fresh snapshot afterward. For clipped table columns,
  scroll that same table horizontally; offscreen contents become available only after entering the visible area.

Start diagnosis with `list_pages`. Its `environmentId` identifies the Connector actually reached. `no_authorized_page`
means this Session currently has no grant on that Connector, `authorized_pages_offline` means all its grants missed
heartbeats, and `ready` means at least one is online. Counts cover this Session, not only the returned page of results.
An empty successful response proves MCP reached the Connector; it does not establish that the extension is disconnected
or that the user never authorized a page. Check the environment and Session shown in the side panel before asking for another grant.
Other Sessions and ungranted tabs are never listed.

Specific error codes survive the page agent → extension → Connector → MCP path. A stale ref requires a new snapshot;
an obscured control requires inspecting the overlay; an invalid number or unavailable option leaves the field unchanged.
These failures do not revoke page consent. MCP reports a recovery hint instead of treating every failure as an authorization
problem. Unsupported iframe/shadow DOM/canvas controls, file uploads and native dialogs still require an explicit capability
report; re-pairing does not add support. A timed-out write remains uncertain: inspect before retrying.

Update Connector/MCP and reload the extension together. An already-running MCP process or loaded Chrome extension keeps
its old code. Build output alone does not update either process.

## Verification status

On 2026-09-08, isolated Chrome for Testing 151 with a local Relay/E2E channel verified scrolled HTML/body overflow,
boxless wrappers, child reads while an image never finishes, script-created child reads without a duplicate tab,
late-popup exclusion and source-reload revocation. These are generic fixtures; the production console still needs
verification after reloading the extension.

On 2026-09-07, `test/fixtures/console-controls.html` passed in real Chrome for Testing 151 through a local Relay/E2E channel:
numeric bounds, exact native selection, input/change events, panel clipping/scrolling, nested button labels,
disabled/obscured controls, error propagation and navigation revocation. The isolated test profile pregranted loopback
permission only. This verifies browser behavior on a synthetic form, not a logged-in cloud console or its custom widgets.

On 2026-09-07, a real Chrome side panel in an isolated profile, built Web/extension and a local Relay verified
one-link pairing, separate identities, no implicit page grant and identity preservation after panel reload.
Only loopback site access was pre-granted in the test copy; normal site prompts still require a user gesture.
Regressions cover replay, wrong extension/key/window, unapproved sponsors, cascading revocation, explicit
disconnect pausing reconnection, and legacy independent pairing.

Tests exercise a real local Relay/WS/E2E channel, **compiled worker**, Chrome API/DOM doubles, pairing retry,
Session isolation, snapshot/click/fill, stale references, and revocation. Official MCP SDK → private IPC →
broker integration is also covered. Optional live probe (ephemeral Codex task and synthetic read-only fixture,
no real pages/business Sessions/global configuration changes):

```sh
npx tsx scripts/probe-browser-mcp.ts --integration
```

On 2026-09-04 the owner authorized updating Relay/Web and both Connectors. A real unpacked extension in
isolated Chrome for Testing 151 passed pairing, environment selection and page authorization. The same PC
Session read the page through Desktop (0.153.0); ECS (0.151.0) read/scrolled/filled/clicked it, with write
approvals accepted once in Web. Revocation and cross-task/environment denial were checked too.
See the [rollout record](../docs/browser-rollout-2026-09-04.md). Everyday Chrome/Edge profiles, long sleep/wake,
forced worker updates and all PC write-approval combinations remain unverified. Reload an installed unpacked
extension in its management page; the rollout does not force-restart user browsers or business Sessions.
See [architecture and acceptance gates](../docs/browser-agent.md).

For a fixed manual fixture, run `npx vite --config extension/vite.config.ts --host 127.0.0.1` and open
`/test/fixtures/control.html` on the reported local URL. Authorize only a dedicated test Session. Its input
and counter do not submit network requests. `test/fixtures/evaluation.xml` contains ten independent,
read-only model evaluation questions joining the catalog/order sections (viewport scrolling allowed).
Answers are fixed; this file is a test specification, **not an executed model-scoring report**.
