# Codex Anywhere

[![CI](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use a phone or browser to follow and continue Codex sessions running on your own computer.
Codex Anywhere is single-user, self-hosted, and keeps project files and Codex execution on the
connector computer.

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with or endorsed by OpenAI.

## What it does

- Lists recent Codex sessions without loading every conversation in full.
- Opens paginated Markdown history and follows an active desktop session.
- Sends text and one JPG, PNG, or WebP image to an existing session.
- Creates a new session in a configured project directory.
- Downloads an assistant-linked local file after explicit browser confirmation.
- Reconnects the browser, relay, and local connector after transient network failures.

It does not automatically fork sessions, persist conversations on the relay, or expose a general
remote shell.

## Architecture

```text
Mobile browser -- HTTPS/WSS --> relay <-- outbound WSS -- Windows connector
                                                       |-- Codex app-server
                                                       |-- Codex Desktop task delivery
                                                       `-- bounded rollout-tail reader
```

The relay authenticates and forwards live frames in memory. New app-server-owned turns can stream
native delta events. Existing desktop-owned sessions are followed by adaptive rollout-tail polling
over the same WebSocket: about 1.5 seconds while content changes and 6 seconds while idle.

Codex Anywhere uses the Codex app-server JSON-RPC protocol for app-server sessions and Codex Desktop
task tools for delivery to existing desktop sessions. It does not implement ACP.

## Security defaults

- A random bridge token of at least 32 characters is sent in the first encrypted WebSocket frame,
  never in the URL.
- Browser WebSocket upgrades must originate from the same web origin.
- Repeated authentication failures are temporarily locked per client IP.
- Codex privileged actions still require manual approval.
- Connector network access is disabled by default.
- Project access and local-file downloads are limited to `CODEX_ALLOWED_ROOTS` by default.
- Each download requires confirmation and a short-lived, one-file, client-bound capability.
- The relay never stores attachments or downloaded files.

This is not a hardened multi-tenant gateway. Use it for one trusted user and read
[SECURITY.md](SECURITY.md) before exposing it to the internet.

## Quick start

Requirements: Node.js 22 or newer and an authenticated Codex CLI on the connector computer.

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
$env:BRIDGE_TOKEN = "replace-with-at-least-32-random-characters"
npm run server
```

In another terminal:

```powershell
$env:BRIDGE_TOKEN = "replace-with-the-same-token"
$env:BRIDGE_URL = "ws://127.0.0.1:3300/ws"
$env:CODEX_WORKSPACE = "C:\workspace"
$env:CODEX_ALLOWED_ROOTS = "C:\workspace"
npm run connector
```

Open `http://127.0.0.1:3300` and enter the same token. For an internet deployment, follow
[docs/deployment.md](docs/deployment.md); never expose port 3300 directly.

## Configuration

### Relay

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_TOKEN` | required | Shared secret, at least 32 characters |
| `HOST` | `127.0.0.1` | HTTP listen address |
| `PORT` | `3300` | HTTP listen port |
| `BRIDGE_TRUST_PROXY` | `0` | Trust Nginx `X-Real-IP`; enable only behind that proxy |

### Connector

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_TOKEN` | required | Same shared secret as the relay |
| `BRIDGE_URL` | `ws://127.0.0.1:3300/ws` | Relay WebSocket URL |
| `BRIDGE_DEVICE_ID` | `personal-pc` | Connector identity |
| `CODEX_BIN` | `codex` | Codex CLI command or path |
| `CODEX_WORKSPACE` | current directory | Default project root |
| `CODEX_ALLOWED_ROOTS` | `CODEX_WORKSPACE` | OS-delimited roots sessions and downloads may use |
| `CODEX_ALLOW_ANY_FILE_DOWNLOAD` | `0` | Set to `1` only when unrestricted local downloads are intentional |
| `CODEX_NETWORK_ACCESS` | `0` | Set to `1` only when Codex tasks require network access |

### Windows login startup

The installer stores the token with user-scoped Windows DPAPI and keeps non-secret settings under
`%LOCALAPPDATA%\PersonalCodexBridge`. That legacy internal directory name is retained so upgrades do
not lose existing credentials.

```powershell
$token = Read-Host 'Bridge token' -AsSecureString
.\scripts\install-connector.ps1 `
  -Token $token `
  -BridgeUrl 'wss://codex.example.com/ws' `
  -Workspace 'C:\workspace' `
  -AllowedRoots @('C:\workspace')
```

Re-run the installer without `-Token` to update settings while preserving the DPAPI credential.
Add `-AllowAnyFileDownload` only if this trusted single-user connector must download files outside
the configured roots.

## Development

```powershell
npm run check
npm run build
```

The React entry component delegates conversation/history parsing to `history-utils.ts`, image work
to `image-utils.ts`, and local-link decoding to `file-utils.ts`. Protocol behavior lives under
`src/server` and `src/connector`.

## License

[MIT](LICENSE)
