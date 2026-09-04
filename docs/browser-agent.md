# Browser Agent architecture and acceptance

English | [简体中文](browser-agent.zh-CN.md)

Branch `codex/browser-agent`, stable baseline `v0.2.1`. This is an opt-in development implementation, not a
production rollout. No automatic tag/release/main merge or service restart. PC Desktop, ECS CLI and other
Connector environments use the same path; a browser is a resource, not an execution environment.

## Experience

Connect extension → choose environment → choose an **existing Session** → authorize current page → continue
in that original Anywhere Session. No ten-minute consent timer or experimental read/stop controls. A secondary
menu revokes/changes Session. The toolbar has a fixed icon and tab-specific status dot.

## Modules

| Module | Responsibility |
| --- | --- |
| Extension connection | Separate device pairing, WS, reused E2E client, bounded requests |
| Extension background | Session selection, document consent, reconnect, grant rotation and revocation |
| Page agent | Fixed isolated scripts, bounded snapshots/references, click/fill/scroll |
| Session broker | Environment-local Session routing, one in-flight operation, strict results and cancellation |
| Local endpoint | Loopback-only authenticated IPC and private state file |
| MCP server | Official SDK stdio server, four narrow tools, trusted host context |
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
document ID and origin. One tab per Session, one in-flight operation per grant. Revocation/rebinding cancels
pending calls; stale results cannot finish a new request. Desktop keeps its existing writer; browser setup never
resumes or takes it over. No test messages are sent into business tasks.

Consent has no TTL. A 45-second heartbeat gap means offline. Reconnection rotates grants and never replays
writes. Browser session storage retains consent only within the current browser lifetime. Navigation, closure
and manual revocation invalidate it. Fixed ISOLATED scripts target exact document IDs. Page text is untrusted
data, not an instruction or authorization source; content is not logged or persistently cached.

## Acceptance gates

- Automated: input validation, caller spoofing, task/device isolation, no ten-minute expiry, liveness,
  cancellation/late results, write timeout without retry, official MCP SDK/private IPC; compiled extension
  over real WS/E2E with Chrome API/DOM doubles, pairing retry, read/click/fill, stale references and document changes.
- Live Codex: ephemeral task → actual new MCP → private IPC → exact Session broker. Page side is a synthetic fixture.
- Still required: actual Chrome/Edge installation, original Desktop UI Session, new/existing ECS Session,
  two environments with matching IDs, multiple browsers, sleep/wake, forced worker stop/update, proxy failure,
  and device revocation. Do not claim production readiness before these tests.
- Configure/load MCP in idle test infrastructure; deploy/release only when the owner requests it.

See [installation, setup and limitations](../extension/README.md). Future work includes real-browser acceptance,
incremental status/approval UX and multi-tab support. HTTPS fallback for corporate proxies is a separate
requirement, not a network-policy bypass. The browser computer still needs to remain powered on.
