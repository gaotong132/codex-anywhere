# Deployment

English | [简体中文](deployment.zh-CN.md)

Codex Anywhere uses a small ECS/VPS as a meeting point for your browser and your computer. Codex,
projects, attachments, and generated files stay on the computer running the connector. The computer
needs outbound network access only; it does not need a public IP or an inbound firewall rule.

`http://127.0.0.1:3300` is only useful for a same-computer smoke test. Remote phone access needs a
reachable relay.

## Requirements

- A reachable Linux ECS/VPS with Git, Docker Engine, and Docker Compose v2.
- A Windows computer with Codex Desktop/CLI, Node.js 22+, Git, and PowerShell.
- A browser-reachable entry point. The code supports WS and WSS; prefer WSS, a VPN, or a secure tunnel
  whenever the route crosses a public or untrusted network.

A domain, TLS certificate, and reverse proxy are optional choices, not project dependencies. No
database, Redis, or object storage is required.

## 1. Start the relay

On the ECS/VPS:

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
./scripts/relay.sh setup
```

The command creates a mode-0600 `.env` with a random connector token when needed, builds the container,
starts it, and waits for the health check. The reference Compose service binds only to
`127.0.0.1:3300`, so port 3300 should remain closed to the public internet.

Choose one public entry:

| Situation | Entry point |
| --- | --- |
| Ordinary phone browser on the internet | A maintained TLS reverse proxy forwarding HTTPS/WSS to `127.0.0.1:3300` |
| Only your enrolled devices need access | A private VPN or secure tunnel |
| Trusted private network or local test | Direct HTTP/WS if its risk is acceptable |

[`deploy/nginx-example.conf`](../deploy/nginx-example.conf) is an optional reverse-proxy example. Use
your existing proxy, certificate process, VPN, or tunnel if preferred. Any proxy must support WebSocket
upgrade and overwrite forwarded client-address headers. Do not add a third-party ingress unless you
accept it inside the trust boundary.

## 2. Install the local connector

Clone the same repository on the computer that runs Codex, then install dependencies:

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
```

Read the connector token from the ECS with `./scripts/relay.sh token`, transfer it privately, and install
the connector:

```powershell
$connectorToken = Read-Host 'Connector token' -AsSecureString
.\scripts\install-connector.ps1 `
  -ConnectorToken $connectorToken `
  -BridgeUrl 'wss://codex.example.com/ws'
```

Use the actual `ws://` or `wss://` endpoint. Windows stores the token and connector private key with
current-user DPAPI, then runs a single connector through a current-user background task. If Task
Scheduler is unavailable, installation falls back to a login shortcut.

New sessions have no default workspace: select a project in the Web UI. `-AllowedRoots` is optional and
defaults to the connector checkout; pass additional roots only when those directories should be
available. `-AllowAnyFileDownload` and `-EnableNetworkAccess` are explicit opt-ins.

## 3. Approve the connector and pair the browser

After the connector starts, return to the ECS:

```bash
./scripts/relay.sh approve
./scripts/relay.sh pair https://codex.example.com
```

The first command shows pending devices and asks for confirmation. The second prints a ten-minute,
single-use browser link and QR code. Replace the example URL with the actual Web URL. A camera is not
required: open or paste the link, or upload a QR screenshot in the pairing page. QR decoding stays in
the browser.

The browser keeps its approved device key in that browser profile and uses a fresh signed challenge on
every connection. There is no shared browser token or recovery login.

## 4. Verify

```bash
./scripts/relay.sh status
```

Then open an existing task from the phone and send a harmless message. Confirm that both Codex Desktop
and the browser receive the update. For the reference proxy deployment, also verify that the public URL
uses HTTPS/WSS and that `ECS-IP:3300` is not reachable externally.

## Daily administration

Run these commands from the ECS checkout:

| Command | Purpose |
| --- | --- |
| `./scripts/relay.sh status` | Show the container and verify relay health |
| `./scripts/relay.sh pending` | List devices waiting for approval |
| `./scripts/relay.sh approve` | Approve a pending connector |
| `./scripts/relay.sh pair <public-url>` | Create a one-time browser pairing link |
| `./scripts/relay.sh devices` | List approved devices |
| `./scripts/relay.sh revoke` | Revoke an approved device |
| `./scripts/relay.sh update` | Fast-forward `main`, rebuild, restart, and verify the relay |

Keep the ECS and local checkout on the same commit. After `relay.sh update`, update the local checkout,
run `npm ci`, and restart or reinstall the connector. Fully refresh browser tabs that stayed open during
the upgrade.

## Configuration

Relay `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_CONNECTOR_TOKEN` | generated by `relay.sh setup` | Bootstrap secret used only by the connector |
| `BRIDGE_SESSION_MAX_AGE_MS` | `3600000` | Maximum authenticated socket lifetime before reauthentication |
| `CODEX_UI_LANGUAGE` | `zh-CN` | Web UI language: `zh-CN` or `en` |

Connector installer options:

| Option | Default | Purpose |
| --- | --- | --- |
| `-BridgeUrl` | `ws://127.0.0.1:3300/ws` | Relay endpoint; accepts WS or WSS |
| `-DeviceId` | `personal-pc` | Logical connector route |
| `-AllowedRoots` | connector checkout | Project roots available to new sessions and normal downloads |
| `-AllowAnyFileDownload` | off | Allow confirmed downloads outside configured roots |
| `-EnableNetworkAccess` | off | Allow connector-owned Codex turns to request network access |

Encrypted Windows state lives in `%USERPROFILE%\.codex-anywhere`, outside the repository. See the
[security policy](SECURITY.md) for the trust boundary, pairing protocol, and incident response.
