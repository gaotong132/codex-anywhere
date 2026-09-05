# September 2026 architecture review

This pass reviewed the Web client, Relay, Connector, shared protocol, browser extension, and deployment/test paths.
It preserves the existing E2E protocol, device identities, workspace boundaries, and Desktop writer ownership.

## Responsibilities

| Area | Result |
| --- | --- |
| Web application | `App.tsx` orchestrates selection and connection state; `file-transfer.ts` owns download cancellation, resume, progress, and wake locks. |
| Preview transport | `file-preview-client.ts` owns text/visualization/diff readers and verifies UTF-8 byte sizes; `download-validation.ts` validates capabilities and chunk completion. |
| Message rendering | `message-markdown.tsx` owns Markdown links, Mermaid, and SVG dispatch. Stable callbacks prevent overlay state changes from remounting every diagram and re-reading local SVGs. |
| Relay | `http.ts` owns health/config/static routes, CSP, and side-panel embedding. `server.ts` retains authentication, device activity, and encrypted WebSocket routing. |
| Connector RPC | Server requests are distinguished from responses before matching pending IDs; malformed JSON values cannot crash dispatch. Existing writer release/draining behavior remains covered. |
| History | Incremental rollout caching verifies file identity and modification metadata. A 512-byte sample at the prior file boundary detects common truncate/regrow cases. |
| Extension transport | Socket and channel callbacks apply only to their current connection; selection settles once and pending operations are cancelled on disappearance or replacement. |

## Correctness fixes

- Empty files can complete a download. A final chunk must reach exactly the advertised file size; an incomplete
  transfer cannot be saved as a successful download.
- Changing the selected task cancels its download instead of leaving it waiting for an obsolete selection revision.
  Cancellation closes the file capability when the original environment is still reachable.
- Wake-lock acquisition is serialized and bound to its download. A delayed lock cannot be adopted by a later transfer;
  cleanup cannot clear the next transfer's progress.
- Text previews preserve a UTF-8 BOM so the source's byte count and transmitted text agree.
- Late extension socket errors cannot close a replacement connection. Invalid addresses are rejected before closing
  a working connection, duplicate authentication messages cannot install duplicate heartbeats, and disappearing
  environments cancel pending channel selection promptly.
- An incoming JSON-RPC approval request cannot resolve an outgoing RPC that happens to have the same numeric ID.
- Relay sends return failure if a socket closes during the write, without throwing through heartbeat or routing.
- Equal-length log rewrites and replacement files invalidate history caches; append-only growth keeps incremental reads.

## Validation

- `npm run check`: type checks and 337 tests, including new download, preview size, extension lifecycle, RPC dispatch,
  and rollout cache regressions.
- `npm run test:extension`: 22 tests covering the compiled worker, pairing, reconnect, current-Session page consent,
  child pages, and revocation.
- Connection status remains pending until environment initialization finishes; page authorization stays disabled
  during that interval, including after a worker reload.
- `npm run build`: production Web and Node builds.
- Headless Chrome checks using the actual React components: normal and empty file downloads, truncated-transfer
  rejection, cancellation, capability cleanup, SVG file/image/code previews, source switching, mobile layout,
  and script/external-resource isolation under the production CSP.
- Deployment checks: public HTTPS health, current Relay assets, PC/ECS Connector status, SVG reads within configured
  roots, and preservation of approved identities.

## Deliberate limits

This is a behavior-preserving decomposition with targeted fixes, not a new transport or permission model. The existing
session orchestration in `App.tsx` and Codex history mapping remain substantial domain modules. File downloads still
assemble a browser Blob in memory; large-file streaming would need a separate browser-support and resume design.
The rollout tail sample is an optimization for normal append/rewrite operations, not a cryptographic integrity check
of the entire log. Dependencies and protocol versions are unchanged.
