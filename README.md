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

- **Continue existing sessions** — browse recent Codex sessions, open Markdown history, and send new
  text or image messages from a phone.
- **Follow work in progress** — see running state and automatically refresh useful assistant progress
  without exposing internal reasoning or tool-call noise.
- **Approve from your phone** — command, file-change, and permission prompts from Web-owned turns can
  be accepted or rejected in the browser, and pending prompts survive a reconnect.
- **Download local files** — after confirmation, download local files linked in assistant replies to a
  phone or browser without an extension allowlist or persistent storage on the relay.
- **Fast on long histories** — session lists and conversation history are loaded incrementally instead
  of downloading every session in full.
- **Mobile-oriented controls** — create a session in an existing project, search recent sessions, open
  attachments, and keep common actions within easy reach.
- **Resilient connection** — the browser and connector recover automatically from transient disconnects
  and network switches.
- **Self-hosted and private by design** — the local computer accepts no public inbound connection; the
  relay does not persist conversations, attachments, or downloaded files.
- **Chinese and English UI** — select `zh-CN` or `en` through runtime configuration.

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
them and forwards live frames in memory; Codex execution and file access remain local.

New sessions and eligible idle sessions are owned by the connector through the Codex app-server
JSON-RPC protocol, enabling native deltas and browser approval prompts. Sessions that are already
active in Codex Desktop remain Desktop-owned and use task tools for delivery plus adaptive history-tail
polling over the same WebSocket; an approval already pending there must still be handled in Desktop.
Codex Anywhere does not implement ACP.

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
   $clientToken = Read-Host 'Browser client token' -AsSecureString
   .\scripts\install-connector.ps1 `
     -ConnectorToken $connectorToken `
     -ClientToken $clientToken `
     -BridgeUrl 'wss://codex.example.com/ws'
   ```

4. Open the relay URL in the phone browser and enter the browser-client token.

Read [SECURITY.md](SECURITY.md) before exposing the relay to the internet. Do not install Codex or copy
project files onto the ECS/VPS.

### Essential configuration

| Variable | Used by | Purpose |
| --- | --- | --- |
| `BRIDGE_CLIENT_TOKEN` | Relay and browser | Browser-control secret; keep separate from the connector credential |
| `BRIDGE_CONNECTOR_TOKEN` | Relay and connector | Local connector secret |
| `BRIDGE_URL` | Connector | Relay WebSocket URL; supports `ws://` and `wss://` |
| `CODEX_UI_LANGUAGE` | Relay | Web UI language: `zh-CN` or `en` |

Authentication uses a fresh challenge and HMAC-SHA-256 proof, so the credential itself is never sent
as a WebSocket frame and a captured proof cannot be replayed on a new connection. This does not make
plaintext `ws://` private: use `wss://`, a VPN, or another secure tunnel on untrusted networks.

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
npm run connector
```

Open `http://127.0.0.1:3300` and enter the token. For development checks and builds:

```powershell
npm run check
npm run build
```

Application source and tests use strict TypeScript. The relay and connector run compiled JavaScript;
the Windows launcher rebuilds only when the TypeScript source changes and then keeps one Node connector
process running.

## License

[MIT](LICENSE)
