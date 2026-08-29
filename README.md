# Codex Anywhere

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="Codex Anywhere lets a mobile browser follow and continue Codex sessions running on your own computer" width="100%">
</p>

Codex Anywhere is a single-user, self-hosted bridge for following and continuing the Codex sessions
on your computer from a phone or another browser. Codex and project files stay on the connector
computer; a lightweight relay on your own ECS/VPS provides the remote entry point.

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with or endorsed by OpenAI.

## Features and highlights

- **Continue existing sessions** — browse recent work, read Markdown history, and send new text or image
  messages from a phone.
- **Guide the next step** — send follow-up instructions directly to a running task without creating
  another session.
- **Follow work in progress** — see which sessions are running and follow useful progress as it happens.
- **Approve from your phone** — accept or reject supported command, file-change, and permission
  requests in the browser, even after reconnecting.
- **Bring results back with you** — preview images and download files linked in assistant replies after
  a clear confirmation.
- **Preview Codex visualizations** — open Codex-generated interactive concepts full-screen or download
  the original artifact.
- **Fast on long histories** — open recent sessions quickly and load older messages only when needed.
- **Mobile-oriented controls** — create a session in an existing project, search recent sessions, open
  attachments, and keep common actions within easy reach.
- **Resilient connection** — your phone and connected computer recover automatically from transient
  disconnects and network switches.
- **Approve every device** — each phone, browser, and connected computer must be trusted by the owner
  before it can open any session; a copied token alone is not enough.
- **Keep work on your own computer** — Codex execution and project files stay local, while a relay you
  control provides the remote entry point.

Codex Anywhere is intentionally a personal bridge. It does not provide automatic session forks, a
general remote shell, or a multi-user gateway.

## Architecture

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Codex Anywhere architecture: mobile browser, self-hosted relay, outbound local connector, and Codex Desktop" width="100%">
</p>

```text
phone / browser ── WS or WSS ──> your ECS/VPS relay
                                      ▲
local connector ── outbound WS/WSS ───┘
       │
       └── Codex Desktop/CLI + local projects
```

Both the browser and local connector initiate connections to the relay. Every application request,
response, event, preview, and download chunk uses an authenticated end-to-end encrypted channel; the
relay authenticates devices and routes ciphertext.

The connector uses Codex app-server JSON-RPC for sessions it owns. Active Desktop sessions use native
delivery and adaptive history polling, so follow-up instructions go straight to the running task.
Approvals already owned by Desktop remain there. Codex Anywhere does not implement ACP.

## Security model

<p align="center">
  <img src="docs/assets/security-model.svg" alt="Codex Anywhere security model: layered device authentication, a self-hosted relay trust boundary, and local-only Codex execution and files" width="100%">
</p>

Security is layered rather than delegated to a single bearer token:

| Layer | Protection |
| --- | --- |
| Device access | Ten-minute, single-use browser pairing and administrator-approved Ed25519 device keys. A Token alone cannot open a session. |
| Content protection | Authenticated X25519 key exchange and XChaCha20-Poly1305 encryption for application traffic. The relay sees metadata and ciphertext size, not messages or files. |
| Session controls | Challenge-bound proofs, periodic reauthentication, failure throttling, origin checks, and frame-size limits. |
| Local computer | Accepts no inbound public connection. On Windows, the connector token and device private key are protected with current-user DPAPI. Codex execution and project files remain local. |
| Files and previews | Root-bound image previews, confirmed short-lived downloads, and isolated network-blocked HTML visualizations. |
| Relay | The reference service binds to ECS loopback, runs with reduced privileges, and stores device trust records—not conversations or file content. |

The ECS still serves the Web app and manages device trust, so it is not a zero-trust relay. A compromised
host can change Web code or approvals and observe metadata. A compromised browser profile or connector
computer keeps that endpoint's authority. Direct
`ws://` keeps application traffic encrypted but does not protect Web delivery, pairing, or metadata;
prefer WSS, a VPN, or a secure tunnel on untrusted networks.

This is a single-user personal bridge, not a multi-tenant identity system, a zero-trust gateway, or a
replacement for Codex permission review. Use an ECS/VPS you control, prefer WSS/VPN/a secure tunnel on
untrusted networks, keep the host patched, approve only a freshly initiated device request, and revoke
devices or rotate role tokens after suspected exposure. See the complete [security policy](docs/SECURITY.md)
and [production deployment guide](docs/deployment.md).

## Deployment

### What you need

| Resource | Requirement |
| --- | --- |
| Reachable ECS/VPS | Required. A small Linux host (about 1 vCPU, 1 GB RAM, and 10–20 GB disk) is enough for the relay. |
| Connector computer | Required. Runs Codex Desktop/CLI, Node.js 22+, the connector, and your local projects. |
| Public ingress | Optional components. Choose an address, domain, reverse proxy, VPN, or secure tunnel that fits your environment. |

No database, Redis, object storage, public IP on the connector computer, or inbound home-network port
is required. The ECS/VPS exists to keep the connector computer off the public network and to give the
browser and connector a stable meeting point.

The code supports both `ws://` and `wss://`. You choose the transport; `wss://` or an equivalent secure
tunnel is strongly recommended whenever traffic crosses a public or untrusted network.

### Set it up

1. Deploy the relay to your ECS/VPS and choose how it will be reachable. Follow the complete
   [production deployment guide](docs/deployment.md).
2. Generate two independent secrets from at least 32 random bytes: one browser-client token and one
   connector token. Configure both on the relay and give only the connector token to the connector.
3. On the computer that runs Codex, install the connector. On Windows this registers a current-user
   background task that starts after sign-in:

   ```powershell
   $connectorToken = Read-Host 'Connector token' -AsSecureString
   .\scripts\install-connector.ps1 `
     -ConnectorToken $connectorToken `
     -BridgeUrl 'wss://codex.example.com/ws'
   ```

   A lightweight watchdog restarts the single Node connector process after an application update or
   unexpected exit, without retaining a plaintext token. If Task Scheduler is unavailable, installation
   falls back to a login shortcut.

4. Start the connector, then approve that connector from the ECS/VPS. Device identity and registry
   internals are never exposed to the browser UI.

   ```bash
   docker compose exec bridge node build/server/device-admin.js
   ```

5. Create a single-use browser pairing link, replacing the example URL with your actual Web endpoint:

   ```bash
   docker compose exec bridge node build/server/device-admin.js pair https://codex.example.com
   ```

   Open the printed link or scan its QR code within ten minutes. A camera is optional: the Web page
   also accepts the link directly or decodes an uploaded QR screenshot locally. The shared browser
   token is reserved for administrator recovery.

Read the [security policy](docs/SECURITY.md) before exposing the relay to the internet. Do not install Codex or copy
project files onto the ECS/VPS.

### Essential configuration

| Variable | Used by | Purpose |
| --- | --- | --- |
| `BRIDGE_CLIENT_TOKEN` | Relay and recovery browser login | Browser recovery bootstrap secret; keep separate from the connector credential |
| `BRIDGE_CONNECTOR_TOKEN` | Relay and connector | Local connector secret |
| `BRIDGE_SESSION_MAX_AGE_MS` | Relay | Maximum authenticated WebSocket lifetime; defaults to one hour |
| `BRIDGE_DEVICE_REGISTRY_FILE` | Relay | Persistent approved/pending public device records; Compose configures this automatically |
| `BRIDGE_URL` | Connector | Relay WebSocket URL; supports `ws://` and `wss://` |
| `CODEX_UI_LANGUAGE` | Relay | Web UI language: `zh-CN` or `en` |

After pairing, the browser signs a fresh challenge with its approved device key. Captured proofs cannot
be replayed. Application traffic is end-to-end encrypted over WS and WSS; WSS also protects Web delivery,
pairing, and metadata from the network.

New sessions require an explicit project directory selected in the web UI; there is no default workspace.
`-AllowedRoots` is optional and limits which local directories may be
selected. When omitted, the connector checkout is the only allowed root. The installer stores this
optional setting outside the repository, so it does not belong in the relay `.env` file.

See [.env.example](.env.example) and [docs/deployment.md](docs/deployment.md) for all options, including
proxy trust, network access, and unrestricted file-download settings.

## Local development

`http://127.0.0.1:3300` is only a same-computer smoke test. It verifies the web app, relay, and connector,
but it cannot provide practical remote phone access; real use requires the relay deployment above.

Requirements: Node.js 22+ and an authenticated Codex CLI.

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
$env:BRIDGE_CLIENT_TOKEN = 'replace-with-at-least-32-random-characters-for-the-browser'
$env:BRIDGE_CONNECTOR_TOKEN = 'replace-with-a-different-32-random-characters-for-the-connector'
npm run server
```

In another terminal:

```powershell
$env:BRIDGE_CONNECTOR_TOKEN = 'replace-with-the-connector-token-above'
$env:BRIDGE_URL = 'ws://127.0.0.1:3300/ws'
$env:BRIDGE_DEVICE_IDENTITY_FILE = '.\data\connector-device.json'
npm run connector
```

Open `http://127.0.0.1:3300` and enter the token. Strict device approval still applies in local
development. In a third terminal, approve the pending connector and browser through the same
administrator command used in production (run it once for each); it reads the local
`data/devices.json` automatically:

```powershell
node build/server/device-admin.js
```

Do not add an automatic first-device exception. For development checks and builds:

```powershell
npm run check
npm run build
```

Application source and tests use strict TypeScript. The relay and connector run compiled JavaScript;
the Windows launcher rebuilds only when the TypeScript source changes.

Contributions are welcome; read the [contributing guide](docs/CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)
