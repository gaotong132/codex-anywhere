# Deployment

English | [简体中文](deployment.zh-CN.md)

Codex Anywhere uses a small Linux relay as the meeting point for a browser and one or more Codex connector
nodes. Codex, projects, attachments, and generated files remain on the selected node. Every connector makes
an outbound connection only, so a personal computer needs neither a public IP nor a home-network inbound
rule. The relay host can also run a headless connector for 24×7 work.

`http://127.0.0.1:3300` is a same-computer test endpoint, not a practical phone deployment.

## Requirements

- Reachable Linux ECS/VPS: Git, Docker Engine, Docker Compose v2. Add Node.js 22+ and an authenticated
  Codex CLI when this host should also be an execution node.
- Windows Codex computer: Codex Desktop/CLI, Node.js 22+, Git, PowerShell.
- Browser-reachable entry: WSS is recommended across public or untrusted networks. A domain, TLS
  certificate, and reverse proxy are optional; a private VPN or secure tunnel is also suitable.

No database, Redis, object storage, or public inbound port on the Windows computer is required.

## 1. Start the relay

On the ECS/VPS:

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
./scripts/relay.sh setup
```

`setup` creates a mode-0600 `.env` with a random connector-only secret, builds the image, starts the
container, and waits for health. The reference Compose service publishes only
`127.0.0.1:3300`; keep port 3300 closed to the public internet.

Choose an entry that fits your network:

| Network | Recommended entry |
| --- | --- |
| Public internet | Maintained HTTPS/WSS reverse proxy to `127.0.0.1:3300` |
| Your enrolled devices only | Private VPN or secure tunnel terminating at the relay |
| Same host development | Direct HTTP/WS on `127.0.0.1:3300` |

[`deploy/nginx-example.conf`](../deploy/nginx-example.conf) is only a reference. Existing ingress,
certificate, VPN, or tunnel tooling is fine. A reverse proxy must support WebSocket upgrade and overwrite
forwarded client-address headers. Adding a third-party ingress also adds it to the trust boundary.

## 2A. Install a Windows/Desktop connector

On the computer running Codex:

```powershell
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
npm ci
```

Read the connector secret on the ECS with `./scripts/relay.sh token`, transfer it privately, and install:

```powershell
$connectorToken = Read-Host 'Connector token' -AsSecureString
.\scripts\install-connector.ps1 `
  -ConnectorToken $connectorToken `
  -BridgeUrl 'wss://codex.example.com/ws'
```

Use the actual `ws://` or `wss://` endpoint. Windows protects the connector secret and device private key
with current-user DPAPI, stores configuration in `%USERPROFILE%\.codex-anywhere`, and keeps one connector
alive through a current-user background task. If Task Scheduler is unavailable, installation falls back
to a login shortcut.

New sessions have no default workspace: choose a project in the Web UI. `-AllowedRoots` is optional and
defaults to the connector checkout; specify additional roots only when those directories should be
selectable or previewable. `-AllowAnyFileDownload`, `-EnableNetworkAccess`, and `-AllowFullAccess` are
explicit opt-ins.

Inline image, Markdown, source-code, config, and text previews always remain root-bound. Enabling
`-AllowAnyFileDownload` permits a confirmed download outside those roots; it does not silently expand
preview access. Re-run the installer with the complete intended `-AllowedRoots` list when another project
tree should be available in the Web UI.

Use a stable, recognizable route when installing more than one connector:

```powershell
.\scripts\install-connector.ps1 `
  -DeviceId 'personal-pc' `
  -AllowedRoots 'D:\project'
```

## 2B. Install a 24×7 Linux/ECS connector

The Linux connector runs in `headless` mode: it owns both new and resumed sessions through Codex
app-server and never depends on Codex Desktop. First verify that the intended service account has a valid
Codex login:

```bash
codex login status
```

When the connector runs on the same host and checkout as the relay, the installer reuses the relay's
connector token without printing it. Choose a dedicated workspace root instead of exposing the whole
home directory:

```bash
mkdir -p /root/codex-workspaces
sudo ./scripts/install-linux-connector.sh \
  --device-id ecs \
  --label 'ECS · 24x7' \
  --allowed-root /root/codex-workspaces \
  --enable-network
```

`--enable-network` is optional; use it only when Codex on that node should be allowed to request network
access. The installer writes a mode-0600 environment file under `/etc/codex-anywhere`, stores the connector
device identity under the service user's `~/.codex-anywhere`, installs a hardened systemd service, and
starts it. For a different relay host, provide `BRIDGE_CONNECTOR_TOKEN` privately in the installer process
environment and set `--bridge-url wss://codex.example.com/ws`.

Inspect the service without exposing its environment file:

```bash
systemctl status codex-anywhere-connector --no-pager
journalctl -u codex-anywhere-connector -n 50 --no-pager
```

## 3. Approve the connector and pair a browser

After each connector attempts its first connection, return to the relay host. Run `approve` once for every
new connector route, then pair the browser:

```bash
./scripts/relay.sh approve
./scripts/relay.sh pair https://codex.example.com
```

`approve` shows pending endpoints and asks before trusting the selected connector. A second connector is
never trusted automatically. `pair` prints a
ten-minute, single-use browser link and QR code. Replace the example address with the real Web URL.

A camera is optional: open or paste the link, or upload a QR screenshot on the pairing page. QR decoding
stays in the browser. After pairing, that browser profile reconnects with its own approved device key;
there is no shared browser token or recovery login.

## 4. Verify

```bash
./scripts/relay.sh status
```

Open an existing session from the phone and send a harmless message. Confirm that the browser and Codex
receive the update. If the conversation contains local links, click one Markdown file and one common
source file: each should open a bounded preview, the source file should use syntax color when supported,
and both previews should retain a Download button. If a completed reply reports file changes, tap the
totals, confirm that the bounded diff belongs to that turn, and toggle line wrapping once. When Codex
reports context accounting, confirm that the top-right activity ring shows usage and reveals exact token
details on hover or tap; a session that has compacted should keep a compaction marker in its timeline.
When multiple connectors are approved, open the sidebar, switch execution environments, and confirm that
the top-bar badge, session list, remembered workspace, and online state change together. Start one harmless
session on each node and confirm that returning to the other node never mixes their history or files. Also
verify that the public URL uses the intended transport and that `ECS-IP:3300` is unreachable externally.

## Operate and update

Run these commands in the ECS checkout:

| Command | Purpose |
| --- | --- |
| `./scripts/relay.sh status` | Show containers and verify relay health |
| `./scripts/relay.sh token` | Print the connector-only secret for private transfer |
| `./scripts/relay.sh pending` | List endpoints awaiting approval |
| `./scripts/relay.sh approve` | Review and approve a pending endpoint |
| `./scripts/relay.sh pair <public-url>` | Create a single-use browser pairing link |
| `./scripts/relay.sh devices` | List approved endpoints |
| `./scripts/relay.sh revoke` | Revoke an approved endpoint |
| `./scripts/relay.sh update` | Fast-forward `main`, rebuild, restart, verify, and restart an enabled same-host headless connector |

Keep relay and connector checkouts on the same revision. A same-checkout Linux service is restarted by
`relay.sh update`; for a connector on another host, pull and restart `codex-anywhere-connector.service`.
After updating the ECS, update the Windows checkout, run `npm ci`, and restart or reinstall its connector.
Fully refresh browser tabs left open
during a coordinated upgrade; a loaded tab keeps running its previous JavaScript until refreshed, and
the strict protocol does not support mixed versions.

## Troubleshoot local file links

| Symptom | Check |
| --- | --- |
| A supported code link still downloads immediately | Update both checkouts, restart the connector, then fully refresh or reopen the browser tab |
| The preview opens but reports failure | Confirm the file is regular UTF-8, no larger than 2 MiB, and inside `-AllowedRoots` |
| Code is readable but has no syntax color | The recognized language is not in the lazy highlighter subset or the file exceeds the 512 KiB highlighting limit; plain escaped text is expected |
| A binary, `.env`, certificate, or key file downloads instead | Sensitive, binary, and unrecognized formats intentionally never receive inline text preview |
| The context ring is empty | Update both checkouts and fully refresh the browser; the selected session must also contain token accounting reported by Codex |
| An expected environment is missing | Confirm its systemd/Windows connector is running and approved, then wait for relay presence to refresh |
| A Linux session cannot continue after its first turn | Confirm `CODEX_CONNECTOR_MODE=headless`, update the checkout, and restart the systemd service |

Preview access and download access are separate. `-AllowAnyFileDownload` affects only the confirmed
download path and does not make an out-of-root file previewable.

## Supported configuration

Relay `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_CONNECTOR_TOKEN` | generated by `relay.sh setup` | Secret accepted only from connectors; minimum 32 characters |
| `BRIDGE_SESSION_MAX_AGE_MS` | `3600000` | Authenticated socket lifetime before reauthentication |
| `BRIDGE_TRUST_PROXY` | `1` in reference Compose | Trust client addresses only from a header-overwriting local proxy; use `0` without one |
| `CODEX_UI_LANGUAGE` | `zh-CN` | Web and device-admin language: `zh-CN` or `en` |

Connector installer options:

| Option | Default | Purpose |
| --- | --- | --- |
| `-BridgeUrl` | `ws://127.0.0.1:3300/ws` | Relay WebSocket endpoint |
| `-DeviceId` / `--device-id` | `personal-pc` on Windows, `ecs` on Linux | Stable execution-environment route shown in the browser |
| `-AllowedRoots` | connector checkout | Local roots available to new sessions, previews, and normal downloads |
| `-AllowAnyFileDownload` | off | Allow confirmed downloads outside configured roots; never expands preview roots |
| `-EnableNetworkAccess` | off | Allow connector-owned Codex turns to request network access |
| `-AllowFullAccess` / `--allow-full-access` | off | Let approved Web clients remove Codex approval and sandbox restrictions on this node |

Connector runtime environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_DEVICE_LABEL` | device id | Human-readable connector label used in diagnostics |
| `CODEX_CONNECTOR_MODE` | `desktop` on Windows, `headless` elsewhere | Preserve Desktop ownership or let a headless app-server own resumed sessions |
| `CODEX_ALLOW_FULL_ACCESS` | `0` | Server-side gate for the Web full-access permission mode |
| `BRIDGE_DEVICE_IDENTITY_FILE` | installer-managed | Mode-0600 Ed25519 connector identity file on Linux |

Full access is intentionally separate from `-AllowedRoots`: those roots still bound previews and ordinary
downloads, but Codex itself is unsandboxed and can read or modify any file available to the connector
service account. Enable it only on a dedicated node and only when every approved browser is trusted.

See the [security policy](SECURITY.md) before changing file roots, download scope, ingress, or connector
network or full access.
