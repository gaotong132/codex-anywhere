# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

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
