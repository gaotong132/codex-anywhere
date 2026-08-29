# Production deployment

English | [简体中文](deployment.zh-CN.md)

Codex Anywhere is intended to use a small public ECS/VPS as a rendezvous relay. The relay is not
Codex itself: Codex Desktop/CLI, project files, attachments, and generated files stay on the connector
computer. `http://127.0.0.1:3300` is only a same-computer development test and has no practical value
for remote phone access.

## Core requirements and deployment options

| Resource | Requirement | Recommended single-user baseline |
| --- | --- | --- |
| Reachable ECS/VPS | Required | Linux, 1 vCPU, 1 GB RAM, 10–20 GB disk |
| Local computer | Required | Codex Desktop/CLI, Node.js 22+, and outbound network access |
| Transport protection | Strongly recommended across an untrusted/public network | TLS, a VPN, or a secure tunnel; direct `ws://` remains available at the operator's risk |
| Domain and DNS | Optional | Convenient for a stable public TLS endpoint |
| HTTPS certificate | Optional component | Use when your chosen ingress terminates HTTPS/WSS |
| Docker, Compose, Nginx, certificate tooling | Optional reference stack | Replaceable by equivalent service and encrypted-ingress components |

No database, Redis, object storage, public IP on the local computer, router port forwarding, or
inbound local firewall rule is required.

```text
phone/browser ── WS/WSS ──> ECS/VPS ingress ──> relay 127.0.0.1:3300
                                      ▲
local Connector ── outbound WS/WSS ───┘
        │
        └── Codex Desktop/CLI and project files
```

## Privacy and trust boundary

The ECS reduces exposure of the personal computer: both endpoints make outbound connections, the ECS
keeps no conversation database, and the reference deployment keeps port 3300 private. Browser and
connector use authenticated application-layer encryption, so the relay routes message,
preview, visualization, and download ciphertext without intentionally persisting it. WSS remains the
recommended transport because it also protects Web code delivery, authentication bootstrap and metadata.

This is not a zero-trust relay. The ECS serves the Web application and manages role tokens and device trust.
A compromised root administrator can change future code or
trust decisions, register an attacker-controlled device, or observe routing metadata.
Use infrastructure you control, minimize administrators and logs, keep the host patched, separate the
two roles, and revoke a device or rotate an affected token after any suspected disclosure.

## 1. Network and host preparation

1. If using a domain, point its DNS record to the ECS EIP.
2. Allow only the port used by your encrypted ingress. In the reference HTTPS deployment this is
   TCP 443; TCP 80 is optional for redirect or certificate validation.
3. Restrict SSH to trusted source addresses or a VPN and prefer SSH keys over passwords.
4. In the reference reverse-proxy deployment, do **not** allow inbound TCP 3300 in the cloud security
   group or host firewall. If you deliberately choose direct `ws://`, expose only the selected relay
   port and restrict its source range where practical. End-to-end encrypted application frames remain
   protected, but Web delivery, enrollment, metadata, and availability do not have transport security.
5. For the included reference path, install maintained Docker Engine, Docker Compose v2, Nginx, and
   the certificate tooling appropriate for your environment. Equivalent components may be used.

Use a dedicated, minimally privileged server where practical. Do not install Codex or copy local
projects to this ECS.

## 2. Relay and secret

Clone the repository on the ECS. Create separate browser-client and connector tokens in a root-readable
`.env`; use at least 32 cryptographically random bytes (64 hexadecimal characters) for each. The
following avoids putting them in shell history:

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
umask 077
BRIDGE_CLIENT_TOKEN_INPUT="$(openssl rand -hex 32)"
BRIDGE_CONNECTOR_TOKEN_INPUT="$(openssl rand -hex 32)"
printf 'BRIDGE_CLIENT_TOKEN=%s\n' "$BRIDGE_CLIENT_TOKEN_INPUT" > .env
printf 'BRIDGE_CONNECTOR_TOKEN=%s\n' "$BRIDGE_CONNECTOR_TOKEN_INPUT" >> .env
printf 'CODEX_UI_LANGUAGE=zh-CN\n' >> .env
unset BRIDGE_CLIENT_TOKEN_INPUT BRIDGE_CONNECTOR_TOKEN_INPUT
chmod 600 .env
docker compose up --build -d
```

Use the one-time browser-pairing flow in section 5 for normal enrollment; it avoids copying the client
token to each browser. Keep the client token only as an administrator-controlled recovery credential,
preferably in a password manager reached through an encrypted administrator session. Pass only the
connector token to the local installer. Never paste either value into a chat, issue, screenshot, source
file, shell argument, or CI log. Do not include `.env` in server backups unless that backup is encrypted
and access-controlled.

The relay requires an Ed25519 signature from every approved device key. One-time enrollment and recovery
Token bootstrap also bind an HMAC proof to a fresh challenge. The relay rejects captured-proof replay,
locks repeated failures, and renews authenticated sockets every hour (`BRIDGE_SESSION_MAX_AGE_MS`). The
Compose volume `bridge-state` persists public device keys, one-way pairing verifiers, pairing metadata,
and optional Web Push state. The relay generates its own VAPID key in that volume; browser and connector
private device keys never enter the relay. Conversation and file content are not stored.

The supplied Compose service:

- publishes `3300` only as `127.0.0.1:3300` on the ECS;
- runs as an unprivileged user with a read-only filesystem;
- drops all Linux capabilities;
- limits processes, uses a small temporary filesystem, rotates container logs, and has a health check.

Verify the binding before configuring the public proxy:

```bash
docker compose ps
curl -fsS http://127.0.0.1:3300/health
ss -ltn | grep 3300
```

The listener shown by `ss` must be `127.0.0.1:3300`, not `0.0.0.0:3300` or `[::]:3300`.

Relay configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_CLIENT_TOKEN` | required | Browser credential; use at least 32 random bytes |
| `BRIDGE_CONNECTOR_TOKEN` | required | Connector credential; keep it different from the browser credential |
| `BRIDGE_SESSION_MAX_AGE_MS` | `3600000` | Maximum authenticated WebSocket lifetime before fresh authentication |
| `BRIDGE_DEVICE_REGISTRY_FILE` | `data/devices.json` | Approved public keys and short-lived pairing records |
| `BRIDGE_PUSH_SUBJECT` | `https://codex-anywhere.local` in Compose | Contact URI for optional Web Push; Compose generates VAPID keys in `/data/vapid.json` |
| `BRIDGE_PUSH_VAPID_FILE` | unset (`/data/vapid.json` in Compose) | Protected auto-generated Web Push key file |
| `BRIDGE_PUSH_SUBSCRIPTIONS_FILE` | next to the device registry (`/data/push-subscriptions.json` in Compose) | Opted-in approved browser subscriptions; never contains conversation content |
| `CODEX_UI_LANGUAGE` | `zh-CN` | Web UI language: `zh-CN` or `en` |
| `HOST` / `PORT` | `127.0.0.1` / `3300` | Direct Node listener; Compose supplies its own container values |
| `BRIDGE_TRUST_PROXY` | `0` | Trust `X-Real-IP` only when a controlled proxy is the relay's sole ingress |

## 3. Recommended public ingress: TLS reverse proxy

For direct access from an ordinary phone browser over the internet, the best balance is a maintained
TLS reverse proxy on the ECS/VPS with the relay kept on loopback. Nginx is the included reference, not
a required dependency. Keep an existing, correctly configured Nginx deployment; changing proxies does
not strengthen the relay trust boundary by itself.

| Situation | Recommended ingress |
| --- | --- |
| Existing maintained Nginx and a public browser URL | Keep Nginx and use WSS; this is the reference path below. |
| New single-service host with minimal administration | A maintained proxy with automatic HTTPS, such as Caddy, can reduce certificate and redirect configuration. |
| Only explicitly enrolled personal devices need access | A private VPN or overlay-network ingress reduces public exposure, but every phone or computer must join that network. |
| Loopback or a fully trusted private network | Direct `ws://` remains supported; never treat it as confidential on an untrusted path. |

Whichever TLS proxy is selected, it must support WebSocket upgrade, overwrite trusted forwarding
headers, and be the only path to port 3300. Certificate renewal, proxy updates, and host security
updates remain operator responsibilities. TLS terminates on the ECS/VPS; application frames also use an
authenticated end-to-end encrypted channel between browser and connector.

To use the included Nginx path, obtain a certificate appropriate for the endpoint, then copy
[`deploy/nginx-example.conf`](../deploy/nginx-example.conf) into the Nginx site configuration. Replace
every `codex.example.com` with your hostname and adjust certificate paths if necessary.

The supplied Nginx policy disables access logs by default to avoid retaining client IP and request
metadata, keeps only warning/error diagnostics, overwrites the trusted `X-Real-IP`, and forwards the
WebSocket only to ECS loopback. If troubleshooting requires an access log, enable it temporarily with
short retention and disable it afterward.

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -fsS https://codex.example.com/health
```

Do not place a third-party CDN or hosted reverse proxy in front unless you accept it as another party
that can terminate TLS and retain metadata.

## 4. Local connector

The local computer must already have an authenticated Codex CLI/Desktop environment. The connector
accepts both `ws://` and `wss://`; WSS is strongly recommended whenever the route crosses a public or
otherwise untrusted network.

For a foreground test:

```powershell
$env:BRIDGE_CONNECTOR_TOKEN = Read-Host 'Connector token'
$env:BRIDGE_URL = 'wss://codex.example.com/ws'
$env:BRIDGE_DEVICE_IDENTITY_FILE = '.\data\connector-device.json'
$env:CODEX_NETWORK_ACCESS = '0'
npm run connector
```

On Windows, the background-task installer stores the token with user-scoped DPAPI rather than in the
repository or a plaintext script. It also creates a separate persistent Ed25519 connector identity and
protects that private key with the same user-scoped DPAPI boundary:

```powershell
$connectorToken = Read-Host 'Connector token' -AsSecureString
$clientToken = Read-Host 'Browser client token' -AsSecureString
.\scripts\install-connector.ps1 `
  -ConnectorToken $connectorToken `
  -ClientToken $clientToken `
  -BridgeUrl 'wss://codex.example.com/ws'
```

The installer registers a current-user Task Scheduler task that starts after sign-in and runs a lightweight
watchdog in the interactive user session. It restarts the single Node connector process after an application
update or unexpected exit. The watchdog does not decrypt or retain either token; each restart goes through
the DPAPI-backed launcher. If Task Scheduler is unavailable, the installer falls back to a login shortcut.

New sessions require a project directory selected in the web UI; there is no default-workspace setting.
`-AllowedRoots` is optional and defaults to the connector checkout. Set it only when additional local
roots should be selectable. Local raster previews and downloads are limited to those roots by default. Add
`-AllowAnyFileDownload` only when this is a trusted single-user computer and unrestricted local download
is intentional. Leave network access disabled unless the Codex task actually needs it.

Encrypted credentials and settings are stored outside the checkout under
`%USERPROFILE%\.codex-anywhere`. Re-run the installer without Tokens to update settings while keeping the
stored credentials.
`scripts/copy-token.ps1` copies only the separately stored browser token; it never exposes the connector
credential. Clear clipboard history afterward on shared computers.

Connector configuration:

| Variable / installer option | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_URL` / `-BridgeUrl` | `ws://127.0.0.1:3300/ws` | Relay WebSocket endpoint; `ws://` and `wss://` are supported |
| `BRIDGE_DEVICE_ID` / `-DeviceId` | `personal-pc` | Logical connector route, not the cryptographic device identity |
| `BRIDGE_DEVICE_IDENTITY_FILE` | none | Mode-0600 key file for foreground/non-Windows use; Windows uses DPAPI instead |
| `CODEX_BIN` | auto-detected | Optional Codex command or stable absolute-path override; versioned Codex Desktop paths are rediscovered automatically |
| `CODEX_ALLOWED_ROOTS` / `-AllowedRoots` | connector checkout | OS-delimited project roots available to new sessions and normal downloads |
| `CODEX_ALLOW_ANY_FILE_DOWNLOAD` / `-AllowAnyFileDownload` | off | Allow confirmed downloads outside the configured roots |
| `CODEX_NETWORK_ACCESS` / `-EnableNetworkAccess` | off | Permit connector-owned Codex turns to request network access |

## 5. Pair trusted devices

The relay never auto-approves a connector or browser. Start the connector and approve it from an
encrypted ECS administrator session:

```bash
docker compose exec bridge node build/server/device-admin.js
```

For a browser, the preferred path is a short-lived, single-use pairing link:

```bash
docker compose exec bridge node build/server/device-admin.js pair https://codex.example.com
```

Replace the example URL with the real Web endpoint. Open the printed link or scan the terminal QR code
within ten minutes. A camera is not required: copy the link, or open the Web pairing panel and upload a
QR screenshot. Screenshot decoding happens in the browser and is not uploaded.

```mermaid
sequenceDiagram
    participant B as Browser
    participant R as Self-hosted relay
    participant A as ECS administrator
    A->>R: Create one-time browser pairing
    R->>R: Store verifier and ten-minute expiry
    R-->>A: URL fragment and QR code
    A-->>B: Open, scan, paste, or upload QR screenshot
    B->>B: Remove secret from address bar; create device key
    B->>R: Open WebSocket
    R-->>B: Fresh 256-bit challenge
    B->>R: One-time proof + Ed25519 signature
    R->>R: Verify, consume pairing, approve public key
    R-->>B: Authenticated session
    Note over B,R: Later reconnects use only the approved device key
```

- The link secret is in the URL fragment, so it is not part of the HTTP request. The browser removes it
  from the address bar before connecting. The relay stores only its verifier, expiry, and no bearer
  secret; successful enrollment consumes the record.
- The device private key never leaves the browser. Reconnects use a fresh challenge and the approved
  Ed25519 device key; the browser Token is reserved for administrator recovery.
- Browser Token login remains available as an administrator recovery path. It creates a pending request;
  run the first command, select the matching request, and do not approve an ambiguous device.
- The Web UI cannot list or approve registered devices. Approval and revocation remain ECS-only.

Device approval authenticates access to the bridge. Codex command, file-change, and permission
approvals remain separate controls.

## 6. End-to-end validation

1. Pair the browser with the one-time link, reopen the Web endpoint, and verify it reconnects without
   asking for the shared browser Token and shows the approved connector online.
2. Open an existing session and send a harmless test message.
3. Confirm the message and reply appear in Codex Desktop and the browser.
4. For the reference TLS setup, confirm HTTP redirects to HTTPS and `http://ECS-IP:3300` is
   unreachable externally. For an intentional direct-WS deployment, verify the firewall exposes only
   the chosen relay endpoint and accept that Web delivery, enrollment, metadata, and availability lack
   transport protection. Application frames remain end-to-end encrypted.
5. Check `docker compose ps`; the relay should become `healthy` after its startup period.

## Updating

Keep the ECS relay and local connector on the same commit. Update both components together:

```bash
git pull --ff-only
docker compose up --build -d
curl -fsS http://127.0.0.1:3300/health
```

Restart the local connector immediately after the relay deployment, then fully refresh any browser tab
that was open during the update. Review release changes before pulling, and do not grant the ECS access
to local project directories.
