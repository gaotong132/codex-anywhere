# Codex Anywhere

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="Codex Anywhere lets a mobile browser follow and continue Codex sessions running on your own computer" width="100%">
</p>

Use a phone or browser to follow and continue Codex sessions running on your own computer.
Codex Anywhere is single-user, self-hosted, and keeps project files and Codex execution on the
connector computer.

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with or endorsed by OpenAI.

## Intended deployment and required resources

Codex Anywhere is designed around a small public ECS/VPS relay. `http://127.0.0.1:3300` is only a
same-computer development smoke test: it proves that the web app, relay, and connector can talk, but
it provides no practical remote access from a phone or another network.

The core requirements and replaceable deployment options are:

| Resource | Requirement | Practical baseline / purpose |
| --- | --- | --- |
| Reachable ECS/VPS | Required | Linux, 1 vCPU, 1 GB RAM, 10–20 GB disk; runs only the lightweight relay |
| Connector computer | Required | Codex Desktop/CLI and Node.js 22+; keeps projects and execution local |
| Encrypted transport | Strongly recommended across an untrusted/public network | A TLS endpoint, VPN, or secure tunnel; remote plaintext `ws://` is supported only when the operator accepts the exposure |
| Domain and DNS | Optional | A convenient stable endpoint; a fixed address or secure tunnel can replace it |
| HTTPS certificate | Optional component | Needed only when the chosen encrypted ingress terminates HTTPS/WSS itself |
| Docker, Compose, Nginx, certificate tooling | Optional reference stack | The included deployment path; equivalent container, service-manager, proxy, or tunnel choices are supported |

No database, Redis, object storage, inbound home-network port, or public IP on the connector
computer is required. Both the browser and local connector initiate outbound connections to the ECS;
the recommended public setup encrypts both connections.

The ECS exists primarily to improve personal privacy and reduce attack surface: your home computer
does not accept public inbound connections, project files stay local, and the relay intentionally
does not persist conversations or transferred files. It is still a trusted component, not an
end-to-end-encrypted blind relay: in the recommended WSS setup, TLS terminates on the ECS, so its root
administrator and cloud host could inspect process memory. Plaintext WS additionally exposes traffic
to the network path. Use an ECS you control, harden it, retain as little logging as possible, and
protect it as part of the trust boundary.

## What it does

- Lists recent Codex sessions without loading every conversation in full.
- Opens paginated Markdown history and follows an active desktop session.
- Sends text and one JPG, PNG, or WebP image to an existing session.
- Creates a new session in a configured project directory.
- Downloads an assistant-linked local file after explicit browser confirmation.
- Reconnects the browser, relay, and local connector after transient network failures.
- Switches the complete web interface between Chinese and English through runtime configuration.

It does not automatically fork sessions, persist conversations on the relay, or expose a general
remote shell.

## Architecture

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Codex Anywhere architecture: mobile browser, self-hosted relay, outbound local connector, and Codex Desktop" width="100%">
</p>

The ECS relay authenticates and forwards live frames in memory. New app-server-owned turns can stream
native delta events. Existing desktop-owned sessions are followed by adaptive rollout-tail polling
over the same WebSocket: about 1.5 seconds while content changes and 6 seconds while idle.

Codex Anywhere uses the Codex app-server JSON-RPC protocol for app-server sessions and Codex Desktop
task tools for delivery to existing desktop sessions. It does not implement ACP.

## Security defaults

- A random bridge token of at least 32 characters is sent in the first encrypted WebSocket frame,
  never in the URL.
- The connector supports both `ws://` and `wss://`. `wss://` is strongly recommended for public
  deployments because `ws://` does not protect the token or conversation in transit.
- Browser WebSocket upgrades must originate from the same web origin.
- Repeated authentication failures are temporarily locked per client IP.
- The relay rejects unsupported HTTP methods and malformed paths, applies a host-scoped CSP, and
  limits WebSocket frame size.
- Codex privileged actions still require manual approval.
- Connector network access is disabled by default.
- Project access and local-file downloads are limited to `CODEX_ALLOWED_ROOTS` by default.
- Each download requires confirmation and a short-lived, one-file, client-bound capability.
- The relay never stores attachments or downloaded files. The supplied container runs as a non-root
  user, is read-only, drops Linux capabilities, limits processes, rotates logs, and binds port 3300
  only to ECS loopback.

This is not a hardened multi-tenant gateway. Use it for one trusted user and read
[SECURITY.md](SECURITY.md) before exposing it to the internet.

## Production setup

Provision the resources above, then follow [docs/deployment.md](docs/deployment.md). The supported
topology is:

```text
phone/browser ── HTTPS/WSS ──> your ECS (Nginx :443 → relay 127.0.0.1:3300)
                                  ▲
local Connector ── outbound WSS ──┘
        │
        └── Codex Desktop/CLI + local project files
```

The reference deployment keeps port 3300 private and uses WSS. Operators can choose WS, but exposing
3300 or using remote plaintext WS gives up transport confidentiality. Do not install Codex or copy
project files onto the ECS.

## Local development smoke test

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

Open `http://127.0.0.1:3300` and enter the same token. This loopback address works only on the same
computer and exists solely for development/debugging; it is not the intended deployment and cannot
provide useful phone access. For actual use, deploy the relay to an ECS as described in
[docs/deployment.md](docs/deployment.md); an encrypted public ingress is strongly recommended.

## Configuration

### Relay

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_TOKEN` | required | Shared secret, at least 32 characters |
| `HOST` | `127.0.0.1` | HTTP listen address |
| `PORT` | `3300` | HTTP listen port |
| `BRIDGE_TRUST_PROXY` | `0` | Trust Nginx `X-Real-IP`; enable only behind that proxy |
| `CODEX_UI_LANGUAGE` | `zh-CN` | Web UI language: `zh-CN` or `en`; restart the relay after changing it |

### Connector

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_TOKEN` | required | Same shared secret as the relay |
| `BRIDGE_URL` | `ws://127.0.0.1:3300/ws` | Supports `ws://` and `wss://`; WSS is strongly recommended for public networks |
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
