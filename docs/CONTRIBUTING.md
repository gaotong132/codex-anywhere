# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for improving Codex Anywhere. Keep changes aligned with its purpose: a single-user, self-hosted
mobile Web bridge for Codex running on the user's own computer.

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
| `web/src` | React mobile UI, SCSS, localization, browser identity, history, and rendering |
| `src/server` | HTTP/WebSocket relay, endpoint authentication, routing, and device registry |
| `src/connector` | Codex app-server/Desktop integration, history, files, approvals, and reconnect |
| `src/shared` | Strict protocol, authentication, encryption, activity, and message primitives |
| `test` | Integration, behavior, security, and regression tests |
| `scripts` | Relay administration and Windows connector installation/watchdog |
| `docs` / `deploy` | User documentation, diagrams, and optional ingress example |

## Design rules

1. Preserve the single-user, self-hosted architecture. Do not add telemetry, hosted conversation storage,
   a general remote shell, automatic forks, or automatic device trust.
2. Never expose credentials, device identity material, raw tool output, or unnecessary local paths in
   logs or the Web UI.
3. Keep explicit confirmation for local file downloads and privileged Codex actions. Desktop-owned
   approvals must not be presented as Web-actionable.
4. Treat protocol, filesystem, reconnect, rollout/history mapping, optimistic messages, and live animation
   changes as security- or correctness-sensitive. Add a regression test for the failure mode.
5. Keep long-session work bounded and incremental. Avoid full-history reads, unstable React keys, and
   animation state derived from changing transport snapshots.
6. Update English and Simplified Chinese docs together when behavior, setup, trust boundaries, or commands
   change.

The network protocol has one exact current version. Do not add plaintext, old-version, or
missing-capability compatibility paths. A protocol change must update browser, relay, and connector
together, bump the protocol version, and reject outdated peers in tests.

Keep pull requests small enough to review and explain the user-facing result. Add a dependency only when
it removes meaningful maintenance burden, is actively maintained, and does not weaken the browser,
relay, or local-computer trust boundary.

## Extra checks

- When `scripts/relay.sh` changes, run `sh -n scripts/relay.sh` in a POSIX shell.
- Keep helper commands and both deployment guides synchronized.
- Verify mobile layout for long titles, filenames, progress text, and three-line activity status.
- After changing the mobile UI, run `npm run docs:hero` to regenerate the README hero from the
  docs-only React fixture. Set `CODEX_ANYWHERE_BROWSER` when Edge or Chrome is not auto-detected.
- Before a release tag, confirm the package version, update all user documents, run checks and builds,
  and tag the exact tested commit.

## Security and test data

Use GitHub private vulnerability reporting for security issues. Public issues, screenshots, fixtures, and
examples must not contain credentials, real private hosts, personal project names, conversation content,
or real local paths. Use reserved example domains and documentation IP ranges.
