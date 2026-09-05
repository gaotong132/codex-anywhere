# Browser Agent architecture and acceptance

English | [简体中文](browser-agent.zh-CN.md)

Browser Agent is included in `main` as an **experimental add-on**, disabled by default. It requires a separate
extension build and installation plus Relay configuration; page control also needs Connector/MCP setup. Normal session
features do not require it; its configuration, interactions, and compatibility may still change.
PC Desktop, ECS CLI and other Connector environments use the same path; a browser is a resource, not an
execution environment.

## Experience

Click extension → open the live Web chat in the side panel → choose environment and Session → chat, optionally
authorize the current page. Chat does not require browser control; page authorization still requires separate
extension pairing through Page control settings and Connector/MCP setup. Settings only manage the connection;
the chat owns environment and Session selection, with authorization and revocation above it. The toolbar has a fixed icon and tab-specific status dot.

Keep one manually authorized root, not arbitrary multi-tab binding. Site permission requested on authorization also enables same-origin
tabs created by AI `open_link` calls or clicks on `target=_blank` links. Manually opened tabs, unsolicited website
popups and cross-origin links/redirects are not adopted. List managed pages and specify `pageId` when more than one exists.

## Side panel embedding boundary

The local `sidepanel.html` shell embeds the live Web app at `/extension/sidepanel`. Only this relay entry allows
an exact `BRIDGE_EXTENSION_ORIGINS` member through `frame-ancestors`; normal pages retain embedding denial.
Web publishes only versioned environment/Session selection and online state tied to a random frame channel.
The shell validates the source window, site, sequence, and freshness. Messages cannot authorize a page, supply
a browser target, or call extension APIs; device private keys never cross this interface. The `tabs` permission provides
the current window's active tab address. An explicit authorization click requests optional access to that site within
the user gesture; a target or Session change during the prompt cancels authorization. The worker records document identity before
network waits and validates it again before binding. The worker owns control connections and grants independently
of the chat frame. Closing chat does not revoke consent, and selecting another Session does not transfer it.

## Modules

| Module | Responsibility |
| --- | --- |
| Extension connection | Separate device pairing, WS, reused E2E client, bounded requests |
| Extension background | Session selection, document consent, reconnect, grant rotation and revocation |
| Page agent | Fixed isolated scripts, bounded snapshots/references, click/fill/scroll |
| Managed tabs | Create only the requested AI child; validate optional site permission, origin, exact document and deadline |
| Session broker | Environment-local Session routing, one in-flight operation, strict results and cancellation |
| Local endpoint | Loopback-only authenticated IPC and private state file |
| MCP server | Official SDK stdio server, six narrow tools, fixed instructions and trusted host context |
| Connector / Relay | Opt-in capability, existing encrypted requests/events, exact extension Origin allowlist |
| Web status component | Status scoped to the selected environment and Session |

The extension reuses the approved `client` role with a **separate device identity**, not the Web client's key
or a third incompatible auth role. Bridge v4 remains unchanged. The extension requires the opt-in
`browserControl` capability. Normal Web Origin checks are unchanged.

## Isolation

Codex supplies `_meta.x-codex-turn-metadata.thread_id/turn_id` for MCP calls. This was verified with a real
ephemeral task in local CLI 0.153.0, not inferred from tool arguments. Source:
[MCP tool call](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs),
[turn metadata](https://github.com/openai/codex/blob/main/codex-rs/core/src/turn_metadata.rs).
This is a host compatibility dependency: missing/contradictory context fails closed; no model-provided identity fallback.

Each grant binds environment, original Session, authenticated device, connection route, grant ID, tab ID,
document ID and origin. Each Session has one root plus AI-created same-origin child tabs (64 grants maximum per connector).
Explicit `browser.bind` consent uses `replaceExisting: true` to replace the same authenticated device's orphaned
root, or a different browser's tree after every page misses heartbeats for 45 seconds. Session validation precedes atomic
tree revocation and pending-operation cancellation; the new document must acknowledge before tools can run. Validation
intents cover both tab and Session, so older clicks cannot overwrite newer consent. Automatic recovery omits replacement
and uses `recoverOnly: true` only when both Session and tab are unbound. `browserGrantReplacement` advertises Connector support.
Only one operation may be in flight per grant. A child requires its authenticated owner's live open operation; a model-supplied raw tab ID
never grants access. Multiple pages require explicit `pageId`; there is no first-page fallback. Revocation/rebinding cancels
pending calls; stale results cannot finish a new request. Desktop keeps its existing writer; browser setup never
resumes or takes it over. No test messages are sent into business tasks.

Consent has no TTL. A 45-second heartbeat gap means offline. Reconnection rotates grants and never replays
writes. Browser session storage retains consent only within the current browser lifetime. Navigation, closure
and manual revocation invalidate it. Fixed ISOLATED scripts target exact document IDs. Page text is untrusted
data, not an instruction or authorization source; content is not logged or persistently cached.

Root navigation/closure/revocation revokes all children. Child navigation revokes only that child. Network reconnection
rotates known grants without replaying tab creation. If connector restart erased child provenance, only the root restores;
AI must open children again. Chrome site permission is separate from Session consent and can be removed in extension settings.

## Model guidance and status

MCP initialization instructions distinguish the extension from in-app CUA. Start with `anywhere_browser_list_pages`, then
snapshot the chosen page. Empty CUA tabs do not prove extension disconnection. Anywhere-delivered Desktop, headless and steer
messages append a current exact-Session authorization count and tool guidance, with no extra turn, page content, URL or secret.
Messages entered directly in Desktop do not pass through the Connector; they rely on the reloaded MCP instructions.

Web says “Browser authorized”, distinguishing page heartbeat from the last successful tool call, and reports unverified
tools when there is no call evidence. These changes require matching Connector/MCP, Web and extension updates; editing the
branch does not deploy production.

## Acceptance gates

- 2026-09-04 branch increment, not deployed: 307 root tests, 10 extension tests, and Web/Node/extension builds pass.
  Chrome for Testing 151 loads the original manifest with no manifest/CSP/runtime errors. Child-tab tests use the same bundled
  JS in a separate temporary profile, with only `127.0.0.1` pregranted in a test-only manifest copy: real WS/E2E, child creation/read,
  cross-origin denial, manual-tab isolation and root-refresh cascade pass. Native optional-permission prompt acceptance,
  updated production PC/ECS runtimes and model tool-selection behavior are not claimed as tested by that smoke run.
- Automated: input validation, caller spoofing, task/device isolation, no ten-minute expiry, liveness,
  cancellation/late results, write timeout without retry, official MCP SDK/private IPC; compiled extension
  over real WS/E2E with Chrome API/DOM doubles, pairing retry, read/click/fill, stale references and document changes.
- Live Codex: ephemeral task → actual new MCP → private IPC → exact Session broker. Page side is a synthetic fixture.
- Live rollout on 2026-09-04: real Chrome for Testing extension; same PC Session reading through Desktop;
  ECS read/write with Web one-shot approvals; pairing, environment selection, refresh/reconnect, revocation
  and cross-task/environment denial. See the [rollout record](browser-rollout-2026-09-04.md).
- Still required: everyday Chrome/Edge profiles, multiple browsers, long sleep/wake, forced worker updates,
  corporate proxy failures and all PC write-approval combinations. Fixed-fixture success does not cover every scenario.
- Configure/load MCP in idle test infrastructure; deploy/release only when the owner requests it.

See [installation, setup and limitations](../extension/README.md). Future work includes real-browser acceptance,
incremental status/approval UX and richer page interactions. HTTPS fallback for corporate proxies is a separate
requirement, not a network-policy bypass. The browser computer still needs to remain powered on.
