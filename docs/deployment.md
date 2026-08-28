# Production deployment

Codex Anywhere is intended to use a small public ECS/VPS as a rendezvous relay. The relay is not
Codex itself: Codex Desktop/CLI, project files, attachments, and generated files stay on the connector
computer. `http://127.0.0.1:3300` is only a same-computer development test and has no practical value
for remote phone access.

## Core requirements and deployment options

| Resource | Requirement | Recommended single-user baseline |
| --- | --- | --- |
| Reachable ECS/VPS | Required | Linux, 1 vCPU, 1 GB RAM, 10–20 GB disk |
| Local computer | Required | Codex Desktop/CLI, Node.js 22+, and outbound network access |
| Encrypted transport | Strongly recommended across an untrusted/public network | TLS, a VPN, or a secure tunnel; plaintext `ws://` remains available at the operator's risk |
| Domain and DNS | Optional | Convenient for a stable public TLS endpoint |
| HTTPS certificate | Optional component | Use when your chosen ingress terminates HTTPS/WSS |
| Docker, Compose, Nginx, certificate tooling | Optional reference stack | Replaceable by equivalent service and encrypted-ingress components |

No database, Redis, object storage, public IP on the local computer, router port forwarding, or
inbound local firewall rule is required.

```text
phone/browser ── HTTPS/WSS ──> ECS Nginx :443 ──> relay 127.0.0.1:3300
                                      ▲
local Connector ── outbound WSS ──────┘
        │
        └── Codex Desktop/CLI and project files
```

## Privacy and trust boundary

The ECS reduces exposure of the personal computer: both endpoints make outbound connections, the
ECS keeps no conversation database, and the reference deployment keeps port 3300 private. The relay
forwards messages, image previews, and download chunks in memory and intentionally does not persist
them. WSS is the recommended transport for these connections.

This is not end-to-end encryption through an untrusted relay. In the recommended WSS setup, TLS
terminates at the ECS ingress and the relay sees plaintext frames in process memory. With WS, the
network path can see them too. The ECS root administrator, cloud provider, any proxy provider, and
anyone who obtains the shared token are therefore in the trust boundary. Use infrastructure you
control, minimize administrators and logs, keep the host patched, and rotate the token after any
suspected disclosure.

## 1. Network and host preparation

1. If using a domain, point its DNS record to the ECS EIP.
2. Allow only the port used by your encrypted ingress. In the reference HTTPS deployment this is
   TCP 443; TCP 80 is optional for redirect or certificate validation.
3. Restrict SSH to trusted source addresses or a VPN and prefer SSH keys over passwords.
4. Do **not** allow inbound TCP 3300 in the cloud security group or host firewall.
5. For the included reference path, install maintained Docker Engine, Docker Compose v2, Nginx, and
   the certificate tooling appropriate for your environment. Equivalent components may be used.

Use a dedicated, minimally privileged server where practical. Do not install Codex or copy local
projects to this ECS.

## 2. Relay and secret

Clone the repository on the ECS. Create the shared token in a root-readable `.env`; use at least 32
cryptographically random bytes (64 hexadecimal characters). The following avoids putting the token
in shell history:

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
umask 077
BRIDGE_TOKEN_INPUT="$(openssl rand -hex 32)"
printf 'BRIDGE_TOKEN=%s\n' "$BRIDGE_TOKEN_INPUT" > .env
printf 'CODEX_UI_LANGUAGE=zh-CN\n' >> .env
unset BRIDGE_TOKEN_INPUT
chmod 600 .env
docker compose up --build -d
```

Retrieve the token only over your encrypted administrator session and place it in a password manager.
Never paste it into a chat, issue, screenshot, source file, shell argument, or CI log. Do not include
`.env` in server backups unless that backup is encrypted and access-controlled.

The supplied Compose service:

- publishes `3300` only as `127.0.0.1:3300` on the ECS;
- runs as an unprivileged user with a read-only filesystem;
- drops all Linux capabilities and enables `no-new-privileges`;
- limits processes, uses a small temporary filesystem, rotates container logs, and has a health check.

Verify the binding before configuring the public proxy:

```bash
docker compose ps
curl -fsS http://127.0.0.1:3300/health
ss -ltn | grep 3300
```

The listener shown by `ss` must be `127.0.0.1:3300`, not `0.0.0.0:3300` or `[::]:3300`.

## 3. Optional reference: TLS reverse proxy

If using the included Nginx path, obtain a certificate appropriate for the endpoint, then copy
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
$env:BRIDGE_TOKEN = Read-Host 'Bridge token'
$env:BRIDGE_URL = 'wss://codex.example.com/ws'
$env:CODEX_WORKSPACE = 'C:\workspace'
$env:CODEX_ALLOWED_ROOTS = 'C:\workspace'
$env:CODEX_NETWORK_ACCESS = '0'
npm run connector
```

On Windows, the login-startup installer stores the token with user-scoped DPAPI rather than in the
repository or a plaintext script:

```powershell
$token = Read-Host 'Bridge token' -AsSecureString
.\scripts\install-connector.ps1 `
  -Token $token `
  -BridgeUrl 'wss://codex.example.com/ws' `
  -Workspace 'C:\workspace' `
  -AllowedRoots @('C:\workspace')
```

Downloads are limited to `AllowedRoots` by default. Add `-AllowAnyFileDownload` only when this is a
trusted single-user computer and unrestricted local download is intentional. Leave network access
disabled unless the Codex task actually needs it.

The encrypted credential and non-secret settings are stored outside the checkout under
`%LOCALAPPDATA%\PersonalCodexBridge`. Re-run the installer without `-Token` to update settings while
retaining the credential. `scripts/copy-token.ps1` copies it to the clipboard when browser login is
needed; clear clipboard history afterward on shared computers.

## 5. End-to-end validation

1. Open `https://codex.example.com`, enter the shared token, and verify the connector is online.
2. Open an existing session and send a harmless test message.
3. Confirm the message and reply appear in Codex Desktop and the browser.
4. Confirm HTTP is redirected to HTTPS and `http://ECS-IP:3300` is unreachable externally.
5. Check `docker compose ps`; the relay should become `healthy` after its startup period.

## Updating

Keep the ECS relay and local connector on the same commit because browser pagination and connector
actions evolve together:

```bash
git pull --ff-only
docker compose up --build -d
curl -fsS http://127.0.0.1:3300/health
```

After connector code changes, restart the local connector too. Review release changes before pulling,
and do not grant the ECS access to local project directories.
