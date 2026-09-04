# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for improving Codex Anywhere. Keep changes aligned with its purpose: a single-user, self-hosted
mobile Web bridge for Codex running on the user's own execution nodes.

## Get started

Requirements: Node.js 22+ and npm. CI covers Node.js 22 and 24.

```bash
npm ci
npm run check
npm run build
```

Source and tests use strict TypeScript; styles use SCSS. Do not commit generated `build/` or `dist/`
output. Add focused tests for every changed protocol, authentication, reconnect, history, approval,
attachment, file-access, or rendering behavior.

## Repository map

| Path | Responsibility |
| --- | --- |
| `web/src` | React mobile UI, SCSS, localization, browser identity, history, previews, and rendering |
| `src/server` | HTTP/WebSocket relay, endpoint authentication, routing, and device registry |
| `src/connector` | Codex app-server/Desktop integration, history, files, approvals, and reconnect |
| `src/shared` | Strict protocol, authentication, encryption, activity, message, and shared file-type primitives |
| `test` | Integration, behavior, security, and regression tests |
| `scripts` | Relay administration plus Windows and Linux connector installation/watchdogs |
| `docs` / `deploy` | User documentation, diagrams, and optional ingress example |

Keep the top-level UI and app-server adapter as orchestration layers. Browser request lifetime and replay
belong in `bridge-request-manager`; environment/session-scoped model and permission state belong in
`session-configuration`. Connector workspace policy, approval mapping, and history projection stay in
their focused `src/connector` modules instead of accumulating in the process/RPC adapter.

## Design rules

1. Preserve the single-user, self-hosted architecture. Do not add telemetry, hosted conversation storage,
   a general remote shell, automatic forks, or automatic device trust.
2. Never expose credentials, device identity material, raw tool output, or unnecessary local paths in
   logs or the Web UI.
3. Keep explicit confirmation for local file downloads and privileged Codex actions. Inline previews
   must stay bounded, root-restricted, type-allowlisted, and read-only. Desktop-owned approvals must not
   be presented as Web-actionable.
4. Treat protocol, filesystem, reconnect, rollout/history mapping, optimistic messages, and live animation
   changes as security- or correctness-sensitive. Add a regression test for the failure mode.
5. Keep long-session work bounded and incremental. Avoid full-history reads, unstable React keys, and
   animation state derived from changing transport snapshots. Open the latest page first, enable older-page
   loading only after explicit upward browsing, preserve the scroll anchor, and surface retryable failures.
6. Treat an execution environment as an isolation boundary. Requests, secure channels, session selection,
   unread state, remembered paths, downloads, and attachment recovery must never silently move to another
   connector route. Switching environments may leave accepted work running on the previous node.
7. Update English and Simplified Chinese docs together when behavior, setup, trust boundaries, or commands
   change.
8. Treat Codex Desktop status as best-effort enrichment. Session listing and startup must not wait for it;
   coalesce concurrent refreshes, bound native calls, and keep app-server state as the fallback.
9. Stop only the connector-owned turn whose thread identity matches the current session. Do not substitute
   process termination, task archival, or a Desktop-owned action for the official app-server interrupt.
10. Bind native Desktop task calls to the destination itself. Never pick another business task as a caller
    or controller: Desktop records it as the source of a delegation and may cause replies to cross projects.
    Test both source and destination, including concurrent delivery and failure paths; a mocked success
    response alone does not prove task isolation.

The network protocol has one exact current version. Do not add plaintext, old-version, or
missing-capability compatibility paths. A mandatory wire-format or capability change must update browser,
relay, and connector together, bump the protocol version, and reject outdated peers in tests. A new
coordinated action still requires browser/connector routing tests and same-revision deployment even when
it does not change the mandatory capability set.

Keep pull requests small enough to review and explain the user-facing result. Add a dependency only when
it removes meaningful maintenance burden, is actively maintained, and does not weaken the browser,
relay, or local-computer trust boundary. Load large renderers on demand, bound their input, sanitize any
generated markup, and preserve a safe plain-text fallback.

## Extra checks

- Keep shared click/focus rules in `styles/_interaction.scss`; add hover styling through its capability-gated
  mixin. Preserve keyboard `:focus-visible` and persistent selected states, and ignore touch/drag movement
  when updating hovered menu options.
- When POSIX service scripts change, run `sh -n` on each changed script.
- Keep helper commands and both deployment guides synchronized.
- For multi-environment changes, test at least two simultaneous connector routes and both `desktop` and
  `headless` delivery modes.
- Verify mobile layout for long titles, filenames, progress text, and three-line activity status. File
  preview changes must also cover long code lines, syntax-highlight fallback, Download/Close controls,
  and the binary or unsupported-file path.
- After changing the mobile UI, run `npm run docs:hero` to regenerate the README hero from the
  docs-only React fixture. Set `CODEX_ANYWHERE_BROWSER` when Edge or Chrome is not auto-detected.
- Before a release tag, confirm the package version, update all user documents, run checks and builds,
  and tag the exact tested commit.

## Security and test data

Use GitHub private vulnerability reporting for security issues. Public issues, screenshots, fixtures, and
examples must not contain credentials, real private hosts, personal project names, conversation content,
or real local paths. Use reserved example domains and documentation IP ranges.
