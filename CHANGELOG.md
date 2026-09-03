# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

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
