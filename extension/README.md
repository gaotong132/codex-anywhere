# Anywhere Browser extension (experimental add-on)

English | [简体中文](README.zh-CN.md)

This extension is an **experimental add-on** for Codex Anywhere, disabled by default. It requires a separate
build and installation plus explicit Relay, Connector, and MCP configuration. Normal session features do
not require it; its configuration, interactions, and compatibility may still change.

Connect to Anywhere, choose an execution environment (PC, ECS, or any connected node), choose an **existing
Session**, and authorize the current page. Continue that original Session in Anywhere to read, click, fill,
and scroll. No replacement Session is created. The built manifest follows the root `package.json` version
and displays `version dev (build fingerprint)`. The content fingerprint identifies the loaded artifacts;
it does not publish a release or create a Tag.

## Build and install

With Node.js 22+, from the repository root:

```sh
npm ci
npm run check
npm run build
npm run test:extension
```

Use Chrome 120+ → Extensions → Developer mode → Load unpacked → **`extension/dist`**. Reload the extension
when upgrading the previous preview. Prefer a separate test browser profile.

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
   Update/reload the Connector and MCP while idle as well; reloading the Chrome extension alone is insufficient for these changes.
   Host metadata `x-codex-turn-metadata.thread_id/turn_id` is required; missing context fails closed.
   See [Codex MCP configuration](https://developers.openai.com/codex/mcp/).
4. Generate a fresh single-use browser pairing link using the [deployment instructions](../docs/deployment.md).
   Paste it in the extension; a link already consumed by the Web client cannot be reused. This enrolls a separate
   extension device. Only its private device key and server Origin persist, not the pairing secret. Public
   connections require HTTPS/WSS; only `localhost` or `127.0.0.1` permits HTTP/WS.
   Chrome CSP does not support IPv6 literal sources, so do not use `[::1]` for local HTTP. Corporate proxy WS blocking is not bypassed.

## Use and boundaries

- Choose the environment and existing Session, verify its title, authorize the current page, then converse
  in that Session in Anywhere. Keep one manually authorized root per extension/Session. Revoke the root and its
  children from the secondary menu before selecting another root or Session.
- Optionally enable AI-opened same-site children in the popup and approve the current site's Chrome permission.
  Without it, single-page control still works. `open_link` or a click on a new-tab link from a fresh snapshot creates
  a same-origin managed child. No arbitrary URLs, manually opened tabs, unsolicited site popups or cross-origin
  links/redirects inherit consent. Chrome stores site permission, while runtime checks still require the exact origin
  (including port), document and Session. Multiple managed pages require an explicit `pageId` from the list tool.
- Web says “Browser authorized” with a child count. Its hint distinguishes unverified MCP tools from a recorded
  successful call; heartbeat alone does not prove model tool availability. In-app CUA and Anywhere are separate browsers.
- No ten-minute consent limit; commands time out after 15 seconds. Heartbeats run every 20 seconds;
  more than 45 seconds without a heartbeat means offline, not expired consent. The Relay only transports
  end-to-end encrypted operation/results frames.
- Closing the popup does not revoke. Worker/network restart can restore only the same Session/document consent
  within the current browser lifetime, with a new grant ID. Revocation, tab closure, navigation (including
  conservative same-origin URL changes), or browser restart requires new consent. Timed-out writes may have
  executed: inspect before retrying. Writes are never replayed automatically after disconnect.
- Root navigation/closure/revocation stops all children; child navigation stops only that child. A connector restart
  that loses child provenance restores only the root; ask AI to open children again. Tabs are not automatically closed.
  Optional site permissions can be removed in Chrome extension settings.
- Page content is untrusted and may contain sensitive visible text. Snapshots omit form values, sensitive
  inputs, hidden/private regions; this is not automatic secret redaction. References are snapshot-scoped and
  invalidated after click/fill. No arbitrary scripts, password/cookie export, file upload, browser internal
  pages, iframe/shadow DOM/canvas, native dialogs or desktop control. Website-changing actions need user authority.
- The Codex host supplies caller identity. Desktop retains its existing writer; the Connector does not take
  over or send messages to other tasks.

## Verification status

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
