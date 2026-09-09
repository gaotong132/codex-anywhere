# Browser Agent architecture and acceptance

English | [简体中文](browser-agent.zh-CN.md)

Browser Agent is included in `main` as an **experimental add-on**, disabled by default. It requires a separate
extension build and installation plus Relay configuration; page control also needs Connector/MCP setup. Normal session
features do not require it; its configuration, interactions, and compatibility may still change.
PC Desktop, ECS CLI and other Connector environments use the same path; a browser is a resource, not an
execution environment.

## Experience

Click extension → open the live Web chat in the side panel → choose environment and Session → chat, optionally
authorize the current page. Pair chat once; it automatically links the extension's page-control identity.
Page control still requires Connector/MCP setup. Settings only manage the connection;
the chat owns environment and Session selection, with authorization and revocation above it. The toolbar has a fixed icon and tab-specific status dot.

Keep one manually authorized root, not arbitrary multi-tab binding. Site permission requested on authorization also enables same-origin
tabs created by AI `open_link` calls or ordinary link clicks. Cross-origin destinations/redirects and missing site permissions
open a visible tab and return `authorizationRequired`, without injecting or granting access. The user can log in and authorize
that destination. Existing/manual tabs and popups outside the current click are not adopted. A scoped `webNavigation`
listener can follow a single new target from the authorized top-level page during an AI click, including `window.open`.
It closes 100 ms after the renderer result and rechecks the exact source document before inspecting the destination.
Multiple/unsupported targets require user authorization; delayed popups and subframes are not adopted. This attribution
uses the browser event's source and a bounded operation window; do not concurrently navigate the source page manually.
List managed pages and specify `pageId`
when more than one exists.

## Side panel embedding boundary

The local `sidepanel.html` shell embeds the live Web app at `/extension/sidepanel`. Only this relay entry allows
an exact `BRIDGE_EXTENSION_ORIGINS` member through `frame-ancestors`; normal pages retain embedding denial.
Web publishes versioned environment/Session selection, authentication and online state tied to a random frame channel.
The shell validates the source window, site, sequence, and freshness. Authenticated Web can also sign the current parent
extension's association request, bound to the Relay connection challenge, extension Origin and public key. Relay checks
Web approval, the association signature and the plugin's own key proof. Proofs cannot be reused across connections,
extensions or keys. Revoking Web cascades to linked plugins; revocation blocks automatic re-enrollment, and linked plugins
cannot sponsor more clients. Messages cannot authorize a page, supply
a browser target, or call extension APIs; device private keys never cross this interface. The `tabs` permission provides
the current window's active tab address. An explicit authorization click requests optional access to that site within
the user gesture; a target or Session change during the prompt cancels authorization. The worker records document identity before
network waits and validates it again before binding. The worker owns control connections and grants independently
of the chat frame. Closing chat does not revoke consent, and selecting another Session does not transfer it.

## Modules

| Module | Responsibility |
| --- | --- |
| Extension connection | Automatic association of an independent identity, WS, reused E2E client, bounded requests |
| Extension background | Session selection, document consent, reconnect, grant rotation and revocation |
| Page runtime / binding | Exact-document dispatch to fixed DOM/native drivers; validated target identity independent of field order |
| Managed-tab lifecycle | Reuse known unedited children and retire old idle children, rechecking grant identity and activity |
| Deadline helper | Bounded waits and disposal of late resources; no cancellation claim or write replay |
| Page agent | Fixed isolated scripts, bounded snapshots/references, click/fill/scroll |
| Managed tabs / click navigation | Identify a newly created child from the current operation; validate optional site permission, source/destination documents, origin and deadline |
| Session broker | Environment-local Session routing, one in-flight operation, strict results and cancellation |
| Local endpoint | Loopback-only authenticated IPC and private state file |
| MCP server | Official SDK stdio server, eight narrow tools, fixed instructions and trusted host context |
| Screenshot driver / contract | Exact-tab viewport capture, private-region masking, compression and image-boundary validation |
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
writes. Browser session storage retains consent only within the current browser lifetime. Cross-origin navigation, closure
and manual revocation invalidate it. Fixed ISOLATED scripts target exact document IDs. Page text is untrusted
data, not an instruction or authorization source; content is not logged or persistently cached.

Same-document SPA routes retain the current grant. Same-origin navigation and reload in an already authorized tab
renew the document grant using Chrome's committed top-frame document ID and the existing site permission.
The authenticated extension uses `browser.navigate`, which cannot change the device, tab, origin or Session and
cannot recreate a revoked grant. The old page ID, refs and pending results (including screenshots) are retired;
existing children retain their lineage. Concurrent navigations are serialized per tab and converge on the latest
committed document; manual revocation or newer consent wins. No click or other write is replayed.
Cross-origin hops end consent, including an observed hop that redirects back. Other manual tabs are not adopted.
This is a coordinated extension/Connector action; deploy both before using the updated extension.

Root cross-origin navigation/closure/revocation revokes all children. A child leaving the origin revokes only that child. Network reconnection
rotates known grants without replaying tab creation. If connector restart erased child provenance, only the root restores;
AI must open children again. Chrome site permission is separate from Session consent and can be removed in extension settings.

Control clicks use a fixed browser mouse sequence with the manifest's `debugger` permission. Chrome does not
support optional debugger permission; users accept its warning when enabling the updated extension.
An exact-document ISOLATED script validates the latest ref and visible hit point before input;
the click driver sends fixed `Input.dispatchMouseEvent` commands to that already granted tab.
Successful clicks and screenshots reuse its exact-document debugger for up to 60 seconds idle; navigation, revocation,
disconnection or failure closes it earlier. User cancellation of the debugging notice revokes that page's consent.
Hover/press changes trigger revalidation; interrupted presses are reported as uncertain, with no click replay.
Links retain the managed-tab path and native selects retain bounded label reads. No tool accepts debugger commands,
raw coordinates, cookie access or script evaluation; missing permission/policy conflicts never trigger a fallback.

Page authorization includes screenshots by default, with no separate setting. `anywhere_browser_screenshot` uses the existing grant route
and fixed `Page.captureScreenshot` command on the exact tab viewport, sharing the per-page busy guard with clicks.
Document probes and change monitoring span capture, masking and encoding; revocation discards pending results.
Capture is bounded to 15 seconds and overall image transport to 60 seconds. Intermediate PNG data stays in extension memory;
form/embedded/detected private regions are masked before JPEG encoding (1920 pixels per side, 1 MiB maximum).
Broker and MCP validate image headers, dimensions, origin and byte limits; ordinary text responses retain the 24 KB cap.
MCP returns standard image content with metadata-only text/structuredContent. Images remain untrusted page data;
masking cannot identify all sensitive visible text or canvas content. Capture shares the scoped debugger lifecycle above; Relay has no
image cache; the host may retain tool history. See [page screenshots](../extension/README.md#page-screenshots-experimental).

The `anywhere_browser_zoom` tool uses the same exact Session/tab grant for native 50%–200% zoom (100 resets).
Fixed document probes surround the change; Chrome `automatic/per-tab` isolation precedes setting the factor. Other tabs
and site preferences stay unchanged; Chrome resets this mode on navigation. Snapshots report zoom and horizontal overflow.
For clipped columns, guidance prefers 80%, then 67%, with fresh snapshots; old refs expire, including after manual zoom.
Remaining clipped panels can scroll horizontally. Interrupted changes are never retried. See [page zoom](../extension/README.md#page-zoom-experimental).

## Model guidance and status

MCP initialization instructions distinguish the extension from in-app CUA. Start with `anywhere_browser_list_pages`, then
snapshot the chosen page. Empty CUA tabs do not prove extension disconnection. Anywhere-delivered Desktop, headless and steer
messages append exact-Session status on the first related send and after the page set or online state changes,
with no extra turn, page content, URL or secret. Ordinary messages in an unchanged state carry no reminder.
Messages entered directly in Desktop do not pass through the Connector; they rely on the reloaded MCP instructions.

Shared workflows and consent boundaries live in MCP server instructions. Each tool describes only its own operation;
specific failures carry recovery hints. The status hint is one line with live counts and the list-pages entry point
(91 characters for a single page, down from 408). It is recorded only after a successful send; failed/uncertain sends
do not consume it or trigger an automatic resend. Page replacement and per-page liveness changes are detected even when
counts stay equal. Revocation sends a zero-page notice on the next ordinary message; question-answer envelopes remain exact.
The Connector retains up to 64 recent task states in memory, so restarting it or revisiting an evicted authorized task
may send the initial hint again. Tools always recheck live authorization. Server/tool prose remains 3,822 characters;
the current update changes no MCP tool descriptions. Update Connector and Web; no extension reload or new pairing is needed.

Guidance tells the model to execute task-required navigation, search, ordinary clicks and input directly, verifying the
result and pausing for actual login, verification, new permissions or out-of-scope actions. Host MCP approval rejection,
browser connectivity and website login are diagnosed separately. Follow the extension setup to preapprove the five specific
write tools with `approval_mode="approve"` under Codex `never`; retain truthful annotations and other approval settings.
Both current and older generated guidance suffixes remain hidden by history parsing.

Web says “Browser authorized”, distinguishing page heartbeat from the last successful tool call, and reports unverified
tools when there is no call evidence. These changes require matching Connector/MCP, Web and extension updates; editing the
branch does not deploy production.

## Acceptance gates

- 2026-09-09 state reminders: 370 root tests, type checks and builds pass. Coverage includes stable-state suppression,
  failures and reordered delivery receipts, same-count page replacement, liveness changes, reconnect, bounded retention,
  async question envelopes, old/new history parsing and all three message delivery routes. Extension build stays `f4d6f529`.
- 2026-09-09 guidance deduplication: 361 root tests and all type/build checks pass; SDK discovery matches the previous
  eight tool contracts apart from descriptions. A real Codex ephemeral task against a synthetic table independently
  follows snapshot → 80% → snapshot → 67% → snapshot to read a clipped price. No business page is used.
- 2026-09-07 console-controls increment: 340 root tests and 25 compiled-extension tests pass. Real Chrome for Testing
  151 with a local Relay/E2E path validates numeric bounds without changing invalid input, native select labels and
  selection, clipped panel scrolling, nested button labels, exact disabled/obscured errors, and navigation revocation.
  Only loopback permission is pregranted in the isolated test copy. This does not claim production cloud console
  acceptance or an updated everyday browser. See the [control workflow](../extension/README.md#console-controls-and-diagnostics).

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
