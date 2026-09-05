# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

- Separate Web download/preview and Markdown responsibilities and Relay HTTP handling. Fix empty/truncated downloads,
  selection cancellation and wake-lock ownership; validate preview byte sizes and preserve UTF-8 BOMs. Isolate stale
  extension callbacks, distinguish inbound JSON-RPC request IDs from responses, and invalidate rewritten rollout caches.
  See [the architecture review](docs/refactoring-2026-09.md) for scope and validation.

- Render linked SVG files, local SVG image references, and `svg` code blocks as isolated vector images, with
  source viewing and existing downloads preserved. Resolve Linux file links and Markdown-relative paths alongside Windows paths.

- Execute authorized browser tasks directly, distinguish host MCP approval rejection from site/login failures, and
  document per-tool preapproval under Codex `never`. Open new-site destinations for user authorization without reading
  them; ordinary links preserve the parent page. Keep older browser guidance hidden in history and add a real host write probe.

- Extend `relay.sh devices` with online/offline/unknown status, connection counts, last connected/seen
  timestamps, and `--json`. Persist private activity separately from device trust, retain history across
  restarts, and report stale snapshots as unknown.

- Recover orphaned browser roots after a tab closes and the extension loses its local grant record. Explicit authorization
  can replace this device's old root or a fully stale browser tree, revoke children, and cancel pending operations; automatic
  recovery and delayed validation cannot reclaim newer consent.

- Fix normal-page authorization after switching tabs with the side panel open: read active-tab metadata and request
  current-site access on the authorization click. Remove duplicate environment/Session selectors from control settings;
  use the current chat Session and cancel consent if the target or Session changes during the permission prompt.

- Add experimental side panel chat using the live Web app, with current-Session selection and explicit page
  authorization. Preserve separate pairing and worker-owned grants; add an allowlisted embed entry, source
  and freshness checks, and window/document-replacement regressions.

- Support GPT-6 Astra through the selected Connector's live model catalog. Show all advertised reasoning
  levels, including distinct Max and Ultra options, and preserve them when editing or saving settings.
- Keep injected browser guidance out of displayed user messages and history matching, and drain pending
  RPCs before releasing a Desktop connector runtime so concurrent reads finish normally.
- Replaced the local-only browser prototype with opt-in extension pairing, environment/existing Session
  selection and document consent; added session-bound MCP snapshot/click/fill/scroll tools over E2E routing
  and private loopback IPC. No ten-minute grant expiry, no replacement Session, no Desktop writer takeover.
- Added a compact popup, fixed icon/tab-specific status, secondary revoke menu and Web Session status.
  Added SDK/IPC and compiled-worker real WS/E2E regression tests and a live ephemeral Codex probe.
  Actual Chrome/Edge, Desktop UI and ECS acceptance remain required; no production deployment or release.

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
