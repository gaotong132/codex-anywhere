# Anywhere Browser extension (development branch)

English | [简体中文](README.zh-CN.md)

Connect to Anywhere, choose an execution environment (PC, ECS, or any connected node), choose an **existing
Session**, and authorize the current page. Continue that original Session in Anywhere to read, click, fill,
and scroll. No replacement Session is created. Manifest `0.0.1` is an unpublished development identifier.

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
3. As the same OS user, register the standard stdio MCP server in Codex using actual absolute paths:

   ```sh
   codex mcp add anywhere_browser -- node /ABSOLUTE/REPO/build/browser-control/mcp-server.js /ABSOLUTE/PRIVATE/browser-endpoint.json
   ```

   On Windows quote paths and use an absolute Node executable if Desktop cannot resolve `node`. Check
   `codex mcp list`, then reload MCP configuration; Desktop may need a restart when tasks are idle.
   The **original Session** must expose `anywhere_browser_snapshot/click/fill/scroll`. Never start a substitute.
   Host metadata `x-codex-turn-metadata.thread_id/turn_id` is required; missing context fails closed.
   See [Codex MCP configuration](https://developers.openai.com/codex/mcp/).
4. Generate a fresh single-use browser pairing link using the [deployment instructions](../docs/deployment.md).
   Paste it in the extension; a link already consumed by the Web client cannot be reused. This enrolls a separate
   extension device. Only its private device key and server Origin persist, not the pairing secret. Public
   connections require HTTPS/WSS; only localhost permits HTTP/WS. Corporate proxy WS blocking is not bypassed.

## Use and boundaries

- Choose the environment and existing Session, verify its title, authorize the current page, then converse
  in that Session in Anywhere. The Web header shows browser status. This version binds one page per extension
  and one browser tab per Session. The secondary menu revokes, changes Session, or disconnects.
- No ten-minute consent limit; commands time out after 15 seconds. Heartbeats run every 20 seconds;
  more than 45 seconds without a heartbeat means offline, not expired consent. The Relay only transports
  end-to-end encrypted operation/results frames.
- Closing the popup does not revoke. Worker/network restart can restore only the same Session/document consent
  within the current browser lifetime, with a new grant ID. Revocation, tab closure, navigation (including
  conservative same-origin URL changes), or browser restart requires new consent. Timed-out writes may have
  executed: inspect before retrying. Writes are never replayed automatically after disconnect.
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

Verified on local Codex CLI 0.153.0 app-server, 2026-09-04. Actual Chrome/Edge extension installation,
existing Desktop UI Sessions, ECS, worker suspension and sleep/wake still require test-environment acceptance.
The available automated browser cannot load Chrome extensions; simulated tests do not prove those scenarios.
See [architecture and acceptance gates](../docs/browser-agent.md).

For a fixed manual fixture, run `npx vite --config extension/vite.config.ts --host 127.0.0.1` and open
`/test/fixtures/control.html` on the reported local URL. Authorize only a dedicated test Session. Its input
and counter do not submit network requests. `test/fixtures/evaluation.xml` contains ten independent,
read-only model evaluation questions joining the catalog/order sections (viewport scrolling allowed).
Answers are fixed; this file is a test specification, **not an executed model-scoring report**.
