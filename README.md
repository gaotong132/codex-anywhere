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
- **Follow real progress** — see running and unread-complete tasks, live activity, plan steps, and file
  change totals without exposing raw tool output.
- **Approve from your phone** — accept or reject supported command, file-change, and permission
  requests in the browser, even after reconnecting.
- **Bring results back with you** — preview images and download files linked in assistant replies after
  a clear confirmation.
- **Preview Codex visualizations** — open Codex-generated interactive concepts full-screen or download
  the original artifact.
- **Fast on long histories** — open recent sessions quickly, load older messages as you scroll upward,
  and copy timestamped messages when needed.
- **Mobile-oriented controls** — create a session in an existing project, search recent sessions, open
  attachments, and keep common actions within easy reach.
- **Resilient connection** — your phone and connected computer recover automatically from transient
  disconnects and network switches.
- **Approve every device** — browsers enroll with a ten-minute, single-use pairing link and reconnect
  with their approved device key; connected computers require owner approval too.
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

Security is layered around short-lived enrollment and persistent device identities:

| Layer | Protection |
| --- | --- |
| Device access | Ten-minute, single-use browser pairing followed by an approved Ed25519 device key. Browsers have no shared-token login. |
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
devices or rotate the connector credential after suspected exposure. See the complete [security policy](docs/SECURITY.md)
and [production deployment guide](docs/deployment.md).

## Deployment

You need a reachable Linux ECS/VPS and a Windows computer already running Codex Desktop/CLI. A small
relay host is enough; no database, public IP on the local computer, or inbound home-network port is
required. A domain, certificate, and reverse proxy are optional choices. WS and WSS are supported, but
prefer WSS, a VPN, or a secure tunnel on an untrusted network.

Start the relay on the ECS:

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
./scripts/relay.sh setup
```

Install the connector on the Codex computer, approve it with `./scripts/relay.sh approve`, then create a
browser link with `./scripts/relay.sh pair <public-url>`. The streamlined
[deployment guide](docs/deployment.md) covers the complete four-step flow, ingress choices, updates, and
the few supported options.

Do not expose the reference port 3300 to the internet or copy projects to the ECS. Read the
[security policy](docs/SECURITY.md) before publishing the relay.

## Local development

`http://127.0.0.1:3300` is only a same-computer smoke test. It verifies the web app, relay, and connector,
but it cannot provide practical remote phone access; real use requires the relay deployment above.

Requirements: Node.js 22+ and an authenticated Codex CLI.

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
$env:BRIDGE_CONNECTOR_TOKEN = 'replace-with-at-least-32-random-characters-for-the-connector'
npm run server
```

In another terminal:

```powershell
$env:BRIDGE_CONNECTOR_TOKEN = 'replace-with-the-connector-token-above'
$env:BRIDGE_URL = 'ws://127.0.0.1:3300/ws'
$env:BRIDGE_DEVICE_IDENTITY_FILE = '.\data\connector-device.json'
npm run connector
```

Strict device approval still applies in local development. In a third terminal, approve the pending
connector, then create and open a one-time browser pairing link; the commands read the local
`data/devices.json` automatically:

```powershell
node build/server/device-admin.js
node build/server/device-admin.js pair http://127.0.0.1:3300
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
