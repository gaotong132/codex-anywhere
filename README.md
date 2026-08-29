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

Both the browser and the local connector initiate connections to the relay. The relay authenticates
them and negotiates a compatible protocol version and capability set. Current peers establish an
authenticated end-to-end encrypted channel, so the relay routes ciphertext while Codex execution and
file access remain local. Rolling upgrades keep a legacy plaintext path only when one peer does not yet
advertise end-to-end encryption.

New sessions and eligible idle sessions are owned by the connector through the Codex app-server
JSON-RPC protocol, enabling native deltas and browser approval prompts. Sessions that are already
active in Codex Desktop remain Desktop-owned and use task tools for delivery plus adaptive history-tail
polling over the same WebSocket; an approval already pending there must still be handled in Desktop.
Codex Anywhere does not implement ACP.

## Security model

<p align="center">
  <img src="docs/assets/security-model.svg" alt="Codex Anywhere security model: layered device authentication, a self-hosted relay trust boundary, and local-only Codex execution and files" width="100%">
</p>

Security is layered rather than delegated to a single bearer token:

| Layer | What the current implementation does |
| --- | --- |
| Device access | Uses one-time, ten-minute browser pairing links and persistent Ed25519 device keys. The relay stores only a verifier for each unused pairing link; after enrollment, the browser reconnects with its approved device key instead of a shared token. Connector and legacy browser token flows remain challenge-bound and separately scoped. |
| Content protection | Current browser and connector peers authenticate an ephemeral X25519 handshake with their approved Ed25519 identities, then encrypt ordered application frames with XChaCha20-Poly1305. The relay sees routing metadata, timing and ciphertext size, but not message or file content. |
| Session controls | Rejects replayed proofs, expires authenticated connections after one hour by default, rate-limits repeated failures, validates browser origins, and limits WebSocket frame size. |
| Local computer | Accepts no inbound public connection. On Windows, the connector token and device private key are protected with current-user DPAPI. Codex execution and project files remain local. |
| File access | Raster previews are restricted to configured roots, content-validated, resized, and converted to WebP; SVG remains download-only. Codex HTML visualizations are size-limited, decrypted in the browser, and run in an isolated, network-blocked frame. Original-file downloads require explicit confirmation and a random, client-bound, short-lived capability. |
| Relay deployment | The reference Compose service binds only to ECS loopback, runs as a non-root user with a read-only filesystem and no Linux capabilities, and persists public device keys plus approval metadata—not conversations or file content. |
| Browser hardening | Removes the one-time secret from the URL fragment before connecting, clears temporary pairing/token material after approval, enforces same-origin WebSocket access, and serves a restrictive CSP and other browser security headers. |

The limits matter just as much. End-to-end encryption prevents the normal relay process from reading
current application frames, but it does not make the deployment zero-trust. The ECS serves the Web app
and administers the device trust registry; a compromised host or root administrator could serve changed
browser code, alter future trust decisions, observe metadata, or force a legacy downgrade. Browser keys
live in that browser profile rather than hardware-backed storage, so a compromised profile or extension
can act as the approved browser. A compromised local computer can access everything available to Codex.
Plain `ws://` remains supported, but does not protect Web delivery, authentication bootstrap, or metadata
from the network; use WSS, a VPN, or a secure tunnel on untrusted networks.

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
3. On the computer that runs Codex, install the connector. Windows users can register it for login
   startup with:

   ```powershell
   $connectorToken = Read-Host 'Connector token' -AsSecureString
   .\scripts\install-connector.ps1 `
     -ConnectorToken $connectorToken `
     -BridgeUrl 'wss://codex.example.com/ws'
   ```

   The login launcher also runs a lightweight watchdog. If an application update or host event terminates
   the connector, it restarts the single Node connector process without retaining a plaintext token.

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
   token remains a compatibility and recovery path, not the preferred daily login.

Read the [security policy](docs/SECURITY.md) before exposing the relay to the internet. Do not install Codex or copy
project files onto the ECS/VPS.

### Essential configuration

| Variable | Used by | Purpose |
| --- | --- | --- |
| `BRIDGE_CLIENT_TOKEN` | Relay and legacy/recovery browser login | Browser bootstrap secret; keep separate from the connector credential |
| `BRIDGE_CONNECTOR_TOKEN` | Relay and connector | Local connector secret |
| `BRIDGE_SESSION_MAX_AGE_MS` | Relay | Maximum authenticated WebSocket lifetime; defaults to one hour |
| `BRIDGE_DEVICE_REGISTRY_FILE` | Relay | Persistent approved/pending public device records; Compose configures this automatically |
| `BRIDGE_URL` | Connector | Relay WebSocket URL; supports `ws://` and `wss://` |
| `CODEX_UI_LANGUAGE` | Relay | Web UI language: `zh-CN` or `en` |

After pairing, browser authentication uses a fresh challenge signed by its approved, persistent
Ed25519 device key. One-time enrollment and legacy Token login bind their HMAC proof and device
signature to the same challenge, so captured proofs cannot be replayed. This does not make plaintext `ws://` private: use
`wss://`, a VPN, or another secure tunnel on untrusted networks.

New sessions always require an explicit project directory selected in the web UI; the connector has no
configurable default workspace. `-AllowedRoots` is optional and limits which local directories may be
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
