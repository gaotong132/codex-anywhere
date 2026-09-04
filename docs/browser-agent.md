# Browser Agent development plan

English | [简体中文](browser-agent.zh-CN.md)

Status: foundation and **local-only read preview**. No production remote browser feature is enabled.
The stable baseline is `v0.2.1`; development starts on `codex/browser-agent` in the same repository.
Keep the extension independently buildable/installable. Do not publish another tag without an explicit
release request, and do not restart production services merely to try the preview.

## Target and modules

The intended first remote workflow is: an ECS Codex task reads and later operates one explicitly
authorized Chrome/Edge tab on another computer. Browser devices are resources, not execution environments.
The Web UI selects the task, browser and grant; page-operation traffic must not depend on the Web UI
remaining open. The machine hosting the controlled browser must still be awake.

| Module | Responsibility | Current state |
| --- | --- | --- |
| Browser control core (`src/browser-control`) | Strict requests, task/document identity, grants, cancellation, deadlines, bounds | Read-only foundation and tests |
| Browser extension (`extension`) | Local consent, document-bound browser execution, revoke and local status | Unpacked local-only preview |
| Codex adapter / Browser MCP | Narrow tools, trusted caller identity, structured results | Adapter parser only; no registered or connected tools |
| Connector integration | Bind tools to an owned active turn; manage browser-controller lifecycle | Pending |
| Relay / device registry | Explicitly paired browser role, authenticated encrypted routing, revocation | Pending; current production protocol unchanged |
| Web control UI | Browser devices, task-to-tab requests, grant status and revoke | Pending; existing environment selector unchanged |
| Operations / tests / docs | Independent build, installation, compatibility and end-to-end isolation checks | Build and initial tests/docs; remote/manual browser checks pending |

## Trust model before remote access

Bind every grant to `(environmentId, threadId, controllerId)` and
`(browserDeviceId, tabId, documentId, origin)`. Tool arguments contain operation parameters, **never the
authoritative task identity**. Do not infer a caller from the selected, latest, or another convenient task.
The extension enforces the grant, not just the Web UI or Relay. Reconnection must not restore consent.

The initial core accepts only `browser.snapshot`, with a grant ID, exact next sequence, request ID and
bounded deadline. Grants are in-memory, exclusive per browser/tab, and last at most ten minutes; requests
last at most fifteen seconds. Validate the document before and after reading. Revocation or expiry discards
late results. A stopped/replaced request cannot overwrite a new grant. These checks are **not endpoint
authentication**: remote transports still require authenticated pairing and end-to-end encryption.

The local Codex CLI `0.153.0` generated experimental app-server types on 2026-09-04 showing `threadId`,
`turnId` and `callId` outside `arguments` in `DynamicToolCallParams`. The adapter parser exercises this
candidate boundary against an explicitly supplied host-owned turn. **This is a schema probe, not a live
integration test.** Ordinary MCP configuration has not been shown to provide a trustworthy per-call task
identity. Before selecting the final MCP integration, verify the host transport live; if it cannot carry
verified context, use a truly task-scoped adapter/endpoint. Never trust a model-supplied ID as a workaround.

The proposed browser contract version is experimental and separate from the existing bridge protocol.
It is not currently an accepted Relay message. Adding browser peers must revise the coordinated protocol,
require exact capabilities, and test rejection of outdated/unknown roles without adding a plaintext or
wildcard-origin compatibility path.

## Implementation sequence and exit criteria

1. **Foundation (this milestone).** Read-only contract, grant enforcement, deadline/revoke handling,
   standalone extension, privacy-aware bounded text extraction and tests. The extension remains local-only
   with `connect-src 'none'`. See [build and manual verification](../extension/README.md).
2. **Trusted Codex binding.** Run a real tool call through an owned ECS app-server turn, verify outer
   task/turn identity and interrupted-turn behavior. Cover two concurrent tasks, a malicious identity
   parameter and adapter restart. Decide the narrow MCP/host adapter integration from this evidence.
3. **Encrypted browser pairing and remote read.** Add a distinct browser peer role, explicit enrollment,
   authenticated E2E channels and document grants. Verify two execution environments and two browsers
   concurrently; revoked/replaced/disconnected peers must not get page text or inherit grants. Opening the
   Web control UI must not itself grant a tab or relax the existing WebSocket origin policy.
4. **Bounded interaction.** Add stable snapshot-scoped element references before click/type/scroll/wait.
   Stale references fail closed. Submitting forms, purchases, deleting data and other external side effects
   require clear local confirmation; never expose arbitrary script evaluation, cookies or password export.
5. **Control UI and release hardening.** Show the exact task, environment, browser, origin, remaining grant
   lifetime, operation state and Stop. Test actual Chrome/Edge installation, worker suspension, sleep/wake,
   proxy/network failure, extension update and independent rollout. Release only on owner instruction.

Page text and tool results remain untrusted content, not instructions or permission changes. Logs must
not contain page bodies, field values, full URLs, pairing secrets or device keys. No native dialogs,
desktop control, credential extraction, broad all-tab access or hidden background authorization is in scope.
No local OS helper is needed for the current preview; evaluate one only if a concrete requirement needs it.

Corporate proxies may still block WebSocket traffic. An approved HTTPS fallback is a separate transport
project; installing the extension neither fixes that automatically nor authorizes bypassing company policy.

## References

- [Chrome activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting and document targeting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Extension worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
