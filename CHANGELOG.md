# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

- Add permanent deletion to headless session lists with confirmation, active-turn protection, and session-scoped cache/browser-grant cleanup. Uses native history deletion without removing project files.
- Run different ECS sessions concurrently, with task-scoped streaming, approvals, stopping and reconnect recovery. Each session still has at most one active turn; messages and question answers for that session steer its existing turn.
- Preview linked local and generated raster images on demand, with original downloads and unchanged file access checks.

- Fix `turn_id_mismatch` when sending to a resumed ECS session: bind the new turn from its start response, ignore replayed history, and replay early output and approvals only for that turn.
- Rename the ECS availability label to `7×24` across the UI and current documentation.

- Read saved permissions for unloaded Desktop chats and allow idle edits through a temporary runtime; verify persistence and release ownership without navigating Desktop. Saved-state reads remain bounded to 1 MiB.

- Choose access permissions in the new-session dialog. The first turn uses the selection; cancel leaves the current chat and device default unchanged. Full access remains gated by the connector.

- Allow idle Desktop chats to change permissions from Web through the native owner, with stale-settings checks, explicit custom modes and existing full-access gates. Confirm native mutations through state events with one bounded recovery read; avoid control-summary work for streamed item text and reduce polling when native state is pushed.

- Generate unique persistent routes for new Windows/Linux installations while retaining existing routes and pairing. Reject conflicting registrations and route takeover, show approved offline nodes without a 24-device cutoff, and synchronize editable device names across browsers and the relay CLI.
- Read effective reasoning effort from Desktop collaboration/thread settings when the legacy field is empty, preventing an incorrect default-reasoning label.

- Read saved model settings for cold conversations without loading or navigating Desktop. Keep model and reasoning labels readable when a long conversation exceeds the full-state frame limit. Leave unconfirmed full settings read-only, and replace misleading automatic/default labels after read failures with a retry action.

- Confirm message delivery in the existing detail line above the Web composer only after the selected computer or ECS accepts it, without an extra row or browser-closing instructions. The next activity replaces the receipt; otherwise it expires after five seconds. Distinguish pending and unconfirmed delivery, bind receipts to the selected conversation, and handle creation events arriving before the response.

- Deliver Web messages to existing Windows threads through native Desktop owner/follower input, preserving user-message semantics and running-turn steering. Keep uncertain submissions from being resent or downgraded to inter-chat delegation; expose native-input connection health separately.

- Discover the dedicated Codex Desktop app-tools pipe used by newer clients, with capability-checked fallback for older releases. Fix Web messages incorrectly failing with “Codex Desktop is unavailable” while the app is running.

- Compact the PC/ECS buttons to a single 40 px row with a status dot; retain selected state, status tooltips and screen-reader labels. Refresh the README preview.

## v0.4.4 — 2026-10-18

- Share attachment preparation across both editors; reject obsolete images/errors after replacement, removal, dialog closure or environment changes, and release unused preview URLs.
- Show direct PC/ECS environment buttons for up to two routes; preserve the mobile drawer while switching and restoring sessions. Keep the selector for larger inventories.
- Refresh bilingual guides, review evidence and the README screenshot; align package, extension and MCP metadata at 0.4.4.


- Compact mobile approval and archive notices with clear primary actions, a labeled refresh icon, and an inline restore action. Use an inset archive confirmation dialog with bounded titles, explicit consequences, and 44 px action targets; retain full actionable command details.

## v0.4.3 — 2026-10-17

- Serialize expired-attachment cleanup by directory, tolerate disappeared entries and continue scanning; prevent concurrent Windows uploads from failing on deletion races.
- Validate partial-upload file identity and timestamps before appending and finalizing, detecting same-size external changes rather than returning a checksum for different bytes.
- Extract shared attachment cleanup without pulling image-preview dependencies into generic uploads. Update file-type, Zod, Vite and Sass within their current major versions.
- Refresh bilingual guides and release metadata; retain Mermaid 11 pending a separate browser-compatibility migration.


- Recover from Desktop-owned approval waits: open the task on the computer, refresh status, or explicitly stop waiting and archive, then restore and open the same session. Pending actions are never approved by this workflow.
- Retry approval polling after transient failures, preserve unknown Desktop state, ignore obsolete session reads and use actual idle/completed status when a wait ends.

## v0.4.2 — 2026-10-17

- Add confirmed PC session archiving through the original Desktop task identity; retain history and project files, block non-idle tasks, deduplicate retries and revoke the archived task’s browser grants. Restore through Codex Desktop.
- Snapshot request payloads before sending so reconnect replay cannot borrow later draft edits.
- Make same-size file rewrite tests deterministic and refresh bilingual release/deployment documentation.

- Fix permission icons accumulating when switching tasks by giving the permission control a key distinct from the adjacent browser status control.

- Replace misleading disabled permission choices for desktop-managed tasks with their current access, an action to open the same task on the computer, and a persisted-permission refresh. Desktop permissions still require a change in Codex Desktop; ECS retains all three choices and explains temporary locks during execution.

## v0.4.1 — 2026-10-16

- Keep unfinished mutations outside the completed-result cache so eviction or TTL expiry cannot redispatch them on reconnect; bound pending requests.
- Share bounded file reads and snapshot checks across text, image and visualization previews; reject changing files and invalidate same-size, same-mtime image replacements.
- Reserve download slots before asynchronous opens, reject new capabilities during shutdown, protect active reads from expiry pruning and recheck the final chunk.
- Align package, lockfile, extension and MCP versions; refresh bilingual guides and validate documentation links, heading anchors and release metadata.

- Merge summary and live history messages across timestamp precision differences, without collapsing repeated messages from the same source; keep message identities stable during polling and pagination.

- Recover Desktop question answers in logs larger than 64 MiB using a separate incremental index; scan in bounded chunks and retain only requested answers, skipping oversized tool output rows.

- Merge dependency updates for DOMPurify, Hono, ip-address, Vite, Sass and Chrome types; upgrade React, React DOM and both type packages together to 19.3.0, and group future React updates to prevent peer dependency conflicts.

- Update the MCP SDK, proxy-addr, fast-uri, source-map-js and Sharp security fixes. Keep Mermaid 11 pending validation of Mermaid 12's higher browser requirements and changed rendering defaults.

- Hide standalone Desktop open-Page context markers from chat history while preserving quoted examples, ordinary messages and unknown payloads.

- Resolve questions answered in Codex Desktop even when summary history omits the reply or it has left the live tail. Recover answers by question ID from the incremental rollout index across paging and reconnects.

- Preserve history, images and reading anchors after mobile background/resume: merge bounded live tails without deleting known messages, render commentary images, bound image transfers, retry failed reads, and discard obsolete connection reads.

## v0.4.0 — 2026-10-03

- Recover stale Connector WebSockets after laptop sleep with active heartbeats, a silence deadline and a bounded handshake; preserve paired device identities.

- Preserve the reading position while older history, live updates and images load; retain message DOM identities and isolate pagination across session switches. Extract the scroll controller, deduplicate replayed file uploads, and keep POSIX path allowlists case-sensitive.

- Upload general files up to 100 MB with chunked transfer, progress, storage on the selected execution node, and file links in history; image previews and screenshot pasting remain supported.

- Render linked HTML files as sandboxed pages with a source toggle, lazy local images, relative file navigation and Back controls instead of displaying XML code.

- Keep the conversation anchored before paint when diagrams or images change height, avoiding startup flicker while preserving manual reading and history pagination positions.

- Fetch initial conversation text and live progress concurrently and display one merged timeline; retain known answers and fall back to text if progress is unavailable.

- Precompress Web assets with Brotli/gzip, preload the message renderer while connecting, and incrementally index generated-image references as session histories grow.

- Add a fresh-ECS deployment appendix covering software, DNS, ingress, TLS, Nginx/WSS, renewal and verification.

## v0.3.0 — 2026-09-12

- Add the experimental Browser Agent: current-task side-panel chat, one-time Web pairing with a separate linked extension identity, explicit page consent, and eight MCP tools for list/snapshot/screenshot/zoom/click/fill/scroll/open-link.

- Follow AI-opened tabs in their original window, reuse eligible children and retain the five most recently used ordinary children. Preserve same-origin navigation consent, require cross-origin authorization and recover orphaned grants only on explicit consent.

- Support native pointer controls, numeric inputs, native select labels and per-panel horizontal/vertical scrolling. Add bounded viewport screenshots with protected-region masking and per-tab 50%–200% zoom; prefer 80%, then 67% for horizontal clipping, refreshing snapshot refs each time.

- Paste PNG/JPEG/WebP screenshots into chat or new-task messages. Show image preparation, byte-based sending progress and receipt confirmation, with 120-second image upload/read timeouts.

- Answer request_user_input_async from Web using choices or free text, preserving the original task, composer drafts, question IDs and Desktop answer synchronization. Collapse answered cards and repeated question quotes.

- Display generated images from legacy and newer Codex Extension events, hydrate images omitted by summary RPCs, recover large image rows and avoid pagination duplicates. Transfer lightweight references and validated previews instead of Base64 tool history.

- Support GPT-6 Astra and every reasoning level advertised by the selected Connector, including Max and Ultra.

- Keep context compaction progress and completion in one timeline marker. Surface terminal failure reasons, recover history across large hidden records, and retain stable message identity.

- Reduce browser guidance to a 91-character state hint sent only initially or after page/online-state changes; shared workflows remain in MCP instructions, with exact historical reminders hidden.

- Render SVG previews and allow supported text/code/Markdown previews at readable absolute paths. Keep raster preview roots and confirmed download policy separate; fix empty/truncated downloads, cancellation and wake-lock ownership.

- Show approved endpoint connection counts and last-connected/seen times through relay.sh devices and --json. Preserve device trust separately from activity and strengthen Desktop task isolation, RPC draining and extension lifecycle handling.

- Set Docker package metadata permissions explicitly so non-root Node can start under restrictive checkout permissions. Refresh all guides, align version metadata and document tag-pinned upgrades.

See [v0.3.0 upgrade steps and limits](docs/release-0.3.0.md). Update Relay/Web, all Connectors and the optional extension together; retain existing pairing identities.

## v0.2.1 — 2026-09-04

- Unified click feedback across buttons, links, menus, and disclosure controls: suppress native tap
  flashes, limit hover styling to hover-capable pointers, and preserve selected colors and keyboard focus.
  Touch scrolling no longer changes the hovered menu option; reasoning sliders avoid text-input focus halos.
- Cleaned up automation reports followed by heartbeat control blocks: keep the complete report and any
  follow-up text, show a compact automation label, and omit internal fields and the redundant summary
  from display and copying. Escaped blocks and forwarded history are supported; Markdown examples stay intact.
- Fixed browser pairing links not filling the form, including links opened in an already loaded tab.
  Pairing now stays cancellable, times out after 15 seconds, and restores an editable form on failure
  without automatic retries. Replaced socket and cancelled QR callbacks cannot affect a new attempt.
- Fixed a Desktop task-isolation defect: mobile input no longer borrows another conversation as its
  source, which could cause repair summaries to be sent into that unrelated task. Task-scoped native calls
  now bind caller and destination, reject mismatches, and never fall back to another task on failure.
  Rebuild and restart the Windows connector as well as updating the relay; existing history is not changed.

## v0.2.0 — 2026-09-04

- Added isolated execution environments, including the existing Windows/Desktop connector and a 24×7
  Linux/ECS headless connector with environment-scoped sessions, workspaces, unread state, and files.
- Added session renaming plus per-task model, four-level reasoning effort, fast mode, and Web permission
  controls. Desktop-owned approvals remain on the computer.
- Added richer live and historical diagnostics: scheduled-task prompts, context usage with smooth status
  colors, compaction markers, run details, connector-owned turn stopping, and bounded per-turn diffs.
- Made long-session history explicitly incremental with visible loading, retryable failures, stable scroll
  position, and startup that does not recursively fetch old pages.
- Refactored browser request management, session configuration, app-server history and permission handling,
  workspace policy, and live activity into focused modules with regression coverage.
- Made Desktop activity enrichment asynchronous and coalesced so a slow or unavailable Desktop bridge does
  not block session listing or startup.

## v0.1.5 — 2026-09-03

- Added mobile context usage and turn diagnostics, plus bounded per-turn change inspection.
