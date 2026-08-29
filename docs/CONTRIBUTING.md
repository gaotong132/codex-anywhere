# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve Codex Anywhere. Keep changes focused on its purpose: a single-user,
self-hosted mobile bridge for Codex running on the user's own computer.

## Development workflow

Requirements: Node.js 22+ and npm.

```bash
npm ci
npm run check
npm run build
```

Source and tests use strict TypeScript. Do not commit generated `build/` or `dist/` output. Add focused
tests for protocol, authentication, reconnect, file access, history mapping, or other behavior affected
by the change. The network protocol is intentionally strict: do not add plaintext, older-version, or
missing-capability fallbacks. A protocol change must bump the exact version, update browser, relay, and
connector together, add rejection tests for outdated peers, and document the coordinated upgrade.

## Repository map

| Path | Responsibility |
| --- | --- |
| `web/src` | React mobile Web UI, rendering, localization, and browser device identity |
| `src/server` | HTTP/WebSocket relay, authentication, routing, and device registry |
| `src/connector` | Local Codex/Desktop integration, attachments, downloads, and reconnect logic |
| `src/shared` | Frames and authentication primitives shared by relay and connector |
| `test` | Node integration and behavior tests |
| `scripts` | Relay administration plus Windows installation, DPAPI credentials, and connector watchdog |
| `docs` / `deploy` | Operator documentation and reference ingress configuration |

## Project rules

1. Keep the default architecture single-user and self-hosted.
2. Do not add telemetry, hosted conversation storage, automatic device trust, or secrets and identity
   material to logs or the Web UI.
3. Preserve explicit confirmation for file downloads and privileged Codex actions.
4. Treat relay/connector changes, filesystem paths, XML/history presentation, and reconnect behavior as
   security-sensitive; add regression coverage.
5. Update English and Simplified Chinese documentation together when user-visible behavior changes.

Keep pull requests small enough to review and explain the user-facing outcome. Avoid unrelated format
or dependency churn. A dependency should replace meaningful maintenance burden, be actively maintained,
and not weaken the browser or local-machine trust boundary.

When changing `scripts/relay.sh`, run `sh -n scripts/relay.sh` on a POSIX shell in addition to the normal
TypeScript checks. Deployment documentation and helper commands must describe the same workflow.

## Security and test data

Use GitHub private vulnerability reporting for security issues. Public issues and fixtures must not
contain credentials, private hosts, real IP addresses, conversation content, personal project names,
or real local filesystem paths. Use reserved example domains and documentation IP ranges.
