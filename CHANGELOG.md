# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

No changes yet.

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
