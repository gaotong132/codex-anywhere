# Deployment

English | [简体中文](deployment.zh-CN.md)

Documentation for **v0.3.0 (2026-09-12)** · [Release and upgrade](release-0.3.0.md) · [Documentation index](README.md)

Codex Anywhere uses a small Linux relay as the meeting point for a browser and one or more Codex connector
nodes. Codex, projects, attachments, and generated files remain on the selected node. Every connector makes
an outbound connection only, so a personal computer needs neither a public IP nor a home-network inbound
rule. The relay host can also run a headless connector for 24×7 work.

`http://127.0.0.1:3300` is a same-computer test endpoint, not a practical phone deployment.

## Requirements

For a newly purchased ECS without a public endpoint, follow the [fresh-ECS appendix](#appendix-deploy-on-a-new-ecs) at the end of this guide.

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
selectable or available for raster image previews; text-based previews need no additional roots. `-AllowAnyFileDownload`, `-EnableNetworkAccess`, and `-AllowFullAccess` are
explicit opt-ins.

Markdown, SVG, source-code, config, and text previews accept any readable absolute path, with type, UTF-8 and 2 MiB limits. Raster image previews remain root-bound. Enabling
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

Opening a link automatically fills and opens the pairing form; click **Pair** to connect. Opening another
link in the same tab replaces the draft. An attempt can be cancelled without closing the page and ends
after 15 seconds if authentication does not complete. Invalid, used, or expired codes leave an editable
form with an error; correct the code or generate a new link and retry. Failed pairing does not retry
automatically. Refreshing before success discards the in-memory code; reopen or paste the link.

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
For a long session, browse upward once and confirm that the older-history indicator appears, the current
reading position does not jump, and a failed request offers retry. For a connector-owned test run, open
the running-status strip and verify that Stop interrupts only that run; Desktop-owned work should instead
explain that it must be stopped on the computer.
When multiple connectors are approved, open the sidebar, switch execution environments, and confirm that
the top-bar badge, session list, remembered workspace, and online state change together. Start one harmless
session on each node and confirm that returning to the other node never mixes their history or files. Also
verify that the public URL uses the intended transport and that `ECS-IP:3300` is unreachable externally.

## Operate and update
For the tagged release, follow the [v0.3.0 upgrade procedure](release-0.3.0.md#upgrade).
The `update` helper tracks `main`; it does not pin a tag or wait for all business tasks to become idle.
Save the previous commit, image and private state first, schedule an idle window, and verify each Connector after restart.



Run these commands in the ECS checkout:

| Command | Purpose |
| --- | --- |
| `./scripts/relay.sh status` | Show containers and verify relay health |
| `./scripts/relay.sh token` | Print the connector-only secret for private transfer |
| `./scripts/relay.sh pending` | List endpoints awaiting approval |
| `./scripts/relay.sh approve` | Review and approve a pending endpoint |
| `./scripts/relay.sh pair <public-url>` | Create a single-use browser pairing link |
| `./scripts/relay.sh devices` | List approved endpoints, status, connection counts, and last connected/seen times |
| `./scripts/relay.sh devices --json` | Output device and activity records as JSON for scripts |
| `./scripts/relay.sh revoke` | Revoke an approved endpoint |
| `./scripts/relay.sh update` | Fast-forward `main`, rebuild, restart, verify, and restart an enabled same-host headless connector |

Devices are sorted by approval time, newest first, using the same selection numbers as `revoke`. Multiple
connections from one device are aggregated. Online and last seen reflect WebSocket connections and
heartbeats, not user interaction. Text timestamps use UTC; JSON timestamps use Unix milliseconds.
History starts after upgrading; unobserved timestamps are "not recorded" (`null` in JSON), never inferred
from approval time.

The Relay alone writes a private `devices.json.activity.json` beside the device registry every five seconds
and on authentication/disconnection. A running snapshot older than 15 seconds reports unknown status
(`null` connections in JSON). Clean shutdown reports offline; restart retains history and resets counts.
The snapshot has no public endpoint and does not change pairing identities or automatically revoke devices.

Keep relay and connector checkouts on the same revision. A same-checkout Linux service is restarted by
`relay.sh update`; for a connector on another host, pull and restart `codex-anywhere-connector.service`.
After updating the ECS, update the Windows checkout, run `npm ci`, and restart or reinstall its connector.
Fully refresh browser tabs left open
during a coordinated upgrade; a loaded tab keeps running its previous JavaScript until refreshed, and
the strict protocol does not support mixed versions.

## Troubleshoot

| Symptom | Check |
| --- | --- |
| Generated images are missing | Update and restart the selected Connector, refresh Web and check the original files under the Codex generated-images directory; updating Relay alone cannot fix node-side history parsing |
| Docker exits with a package.json permission error | Rebuild from v0.3.0; the Dockerfile sets readable package metadata for the non-root runtime. Do not make private configuration public or run the service as root to bypass it |
| Container health still says starting | The reference health check runs every 30 seconds with a 10-second start period; inspect container state/logs and allow for the first probe before declaring failure |
| A supported code link still downloads immediately | Update both checkouts, restart the connector, then fully refresh or reopen the browser tab |
| The preview opens but reports failure | For text previews, confirm a regular UTF-8 file no larger than 2 MiB, an allowed filename/type and OS read access; workspace roots apply to raster previews, not text |
| Code is readable but has no syntax color | The recognized language is not in the lazy highlighter subset or the file exceeds the 512 KiB highlighting limit; plain escaped text is expected |
| A binary, `.env`, certificate, or key file downloads instead | Sensitive, binary, and unrecognized formats intentionally never receive inline text preview |
| The context ring is empty | Update both checkouts and fully refresh the browser; the selected session must also contain token accounting reported by Codex |
| Older history does not load | Scroll away from the latest edge and continue upward; automatic paging is intentionally disabled until the user starts browsing older content. Use the visible retry control after a request failure |
| The session list opens before a running Desktop badge appears | This is expected: app-server sessions return immediately and Desktop activity is merged asynchronously on a later poll |
| Mobile input appears to come from an unrelated task, or task identity validation blocks delivery | Stop sending, update and restart the Windows connector too (not just ECS), and review affected history. Native caller and destination must be the same task; never work around a failure by borrowing another task |
| Stop is unavailable for a running task | Only the exact turn owned by the selected connector can be interrupted from Web. Desktop-owned work must be stopped on the computer |
| An expected environment is missing | Confirm its systemd/Windows connector is running and approved, then wait for relay presence to refresh |
| A Linux session cannot continue after its first turn | Confirm `CODEX_CONNECTOR_MODE=headless`, update the checkout, and restart the systemd service |

Preview access and download access are separate. `-AllowAnyFileDownload` affects only the confirmed
download path. Text-based previews already accept any readable absolute path; raster image previews retain their root checks.

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
| `-AllowedRoots` | connector checkout | Local roots for new sessions, raster image previews and normal downloads; does not restrict text-based previews |
| `-AllowAnyFileDownload` | off | Allow confirmed downloads outside configured roots; does not change preview policy |
| `-EnableNetworkAccess` | off | Allow connector-owned Codex turns to request network access |
| `-AllowFullAccess` / `--allow-full-access` | off | Let approved Web clients remove Codex approval and sandbox restrictions on this node |

Connector runtime environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_DEVICE_LABEL` | device id | Human-readable connector label used in diagnostics |
| `CODEX_CONNECTOR_MODE` | `desktop` on Windows, `headless` elsewhere | Preserve Desktop ownership or let a headless app-server own resumed sessions |
| `CODEX_ALLOW_FULL_ACCESS` | `0` | Server-side gate for the Web full-access permission mode |
| `BRIDGE_DEVICE_IDENTITY_FILE` | installer-managed | Mode-0600 Ed25519 connector identity file on Linux |

Full access is intentionally separate from `-AllowedRoots`: those roots still bound raster image previews and ordinary
downloads, but Codex itself is unsandboxed and can read or modify any file available to the connector
service account. Enable it only on a dedicated node and only when every approved browser is trusted.

See the [security policy](SECURITY.md) before changing file roots, download scope, ingress, or connector
network or full access.

## Appendix: deploy on a new ECS

This reference uses a fresh **Ubuntu Server 24.04 LTS** ECS with systemd and a dedicated public IPv4
address. Steps reviewed on 2026-09-14. Other distributions need their own repositories and service
configuration. On a server hosting existing websites, merge settings without overwriting those sites.
Replace every occurrence of `codex.example.com` below with your own domain.

### A. Software and services

| Component | Needed? | Purpose / operation |
| --- | --- | --- |
| Git, curl, CA certificates | Required | Fetch source, download dependencies and verify HTTPS |
| Docker Engine, Compose plugin | Required | Build and run Relay; systemd manages Docker |
| Nginx | For this appendix | Listen on 80/443, terminate TLS and proxy HTTP/WebSocket |
| Domain and DNS record | For this appendix | Give clients a stable endpoint and validate domain ownership |
| TLS certificate, Certbot / snapd | For this appendix | Issue and renew certificates; existing trusted certificates can use another manager |
| Node.js 22+, authenticated Codex CLI, Connector | Optional | Install on the host only if ECS also executes Codex tasks; Relay runs Node inside Docker |

**WSS is WebSocket over TLS; there is no separate WSS service to install.** The connections are:

```text
Browser ── HTTPS / WSS :443 ──> Nginx ── HTTP / WS 127.0.0.1:3300 ──> Relay
PC Connector ── outbound WSS :443 ──> the same Nginx / Relay
ECS Connector (optional) ── local WS 127.0.0.1:3300 ──> Relay
```

The Web URL is `https://codex.example.com`; remote connectors use `wss://codex.example.com/ws`.
Nginx terminates TLS and forwards plain WS over loopback. The container needs no certificate,
database or Redis service.

### B. Public address, domain and ports

At your DNS provider, create an **A record** for `codex` pointing to the ECS public IPv4 address,
not its private address. Add an AAAA record only after configuring IPv6 listeners, routing and security
groups. Start with direct DNS; check WebSocket support before introducing a CDN.

Check both the cloud security group and the host firewall:

| Inbound TCP port | Source | Purpose |
| --- | --- | --- |
| 22 (or your actual SSH port) | Trusted administrator IPs | SSH administration |
| 80 | Public Internet | HTTP-01 certificate validation and HTTPS redirects |
| 443 | Client networks that need access | HTTPS and WSS share this port |
| 3300 | Never expose publicly | Relay is reachable only through host loopback |

Before enabling a host firewall, allow your actual SSH port and administrator IP; keep the current SSH
connection open while verifying a second connection. Preserve existing rules. Docker-published ports
can bypass UFW, so retain Compose's `127.0.0.1:3300:3300` binding instead of relying only on UFW to
block public port 3300. See [Docker's firewall notes](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations).
The server also needs DNS and outbound access to package sources over HTTPS; an optional Connector
needs access to its Codex service too.

### C. Install base packages and Docker

After connecting over SSH, run the following steps in **root Bash on ECS** (`sudo -i` for a sudo-enabled
administrator). This example uses `/root/codex-anywhere` and does not expose Docker's management API.

```bash
apt-get update
apt-get install -y git curl ca-certificates nginx snapd dnsutils nano
```

Follow “Set up Docker's apt repository” in the [official Docker Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository)
to configure its APT repository, then run:

```bash
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker nginx
docker compose version
docker run --rm hello-world
```

If the cloud image already includes Docker, check its version and Compose plugin before mixing packages
from different sources.

### D. Start Relay and bootstrap HTTP validation

```bash
cd /root
git clone https://github.com/gaotong132/codex-anywhere.git
cd /root/codex-anywhere
./scripts/relay.sh setup
curl --fail --silent --show-error http://127.0.0.1:3300/health
dig +short A codex.example.com
dig +short AAAA codex.example.com
```

The health endpoint must succeed and DNS must point to this ECS. Do not enable the repository's HTTPS
configuration yet: its certificate does not exist. Use `nano /etc/nginx/sites-available/codex-anywhere`
to create this temporary HTTP site first:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name codex.example.com;
    server_tokens off;
    access_log off;
    location / {
        default_type text/plain;
        return 200 "codex-anywhere TLS setup\n";
    }
}
```

```bash
ln -s /etc/nginx/sites-available/codex-anywhere /etc/nginx/sites-enabled/codex-anywhere
nginx -t && systemctl reload nginx
```

Open `http://codex.example.com` from another computer and confirm it shows `codex-anywhere TLS setup`.
A default welcome page means you should check DNS and `server_name`; a timeout calls for checking DNS,
security groups, firewalls and the cloud provider's ingress restrictions. This temporary site does not expose pairing.

### E. Issue the certificate and enable HTTPS / WSS

Use [Certbot's snap installation](https://certbot.eff.org/instructions?os=snap&ws=nginx).
This procedure obtains the certificate with `certonly --nginx`, then installs the project's proxy configuration:

```bash
snap install --classic certbot
/snap/bin/certbot certonly --nginx --cert-name codex.example.com -d codex.example.com
```

Follow the prompts for a contact email and review and accept the terms. After successful issuance,
back up the temporary configuration and install the template:

```bash
cp /etc/nginx/sites-available/codex-anywhere /root/codex-anywhere-http-bootstrap.conf
install -m 644 /root/codex-anywhere/deploy/nginx-example.conf /etc/nginx/sites-available/codex-anywhere
nano /etc/nginx/sites-available/codex-anywhere
```

Replace the example domain in both `server_name` directives and use these certificate paths:

```nginx
ssl_certificate /etc/letsencrypt/live/codex.example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/codex.example.com/privkey.pem;
```

Keep the template's exact `/ws` location, HTTP/1.1, `Upgrade` / `Connection` headers and long connection
timeouts. These settings upgrade and proxy WSS connections to Relay; see [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html).
The template also overwrites client address forwarding headers to work with reference Compose's
`BRIDGE_TRUST_PROXY=1`. Adding a proxy in front of Nginx requires reviewing which proxies and client
address headers to trust.

```bash
nginx -t && systemctl reload nginx
curl --fail --silent --show-error https://codex.example.com/health
```

Do not bypass certificate failures with `curl -k`. If you already have a cloud-provider certificate,
skip Certbot, install its full chain and private key, and arrange renewal plus Nginx reload yourself.
Keep private keys out of Git.

### F. Pair clients, verify WSS and optionally add an execution node

Follow “Install a Windows/Desktop connector” above to connect the PC to `wss://codex.example.com/ws`,
then run on ECS:

```bash
cd /root/codex-anywhere
./scripts/relay.sh approve
./scripts/relay.sh pair https://codex.example.com
./scripts/relay.sh devices
```

Give the pairing link only to your own browser. Complete pairing over HTTPS, confirm the execution
environment is online, and send a message in your own test session to check streamed replies.
In browser developer tools, Network → WS should show **101 Switching Protocols** for `/ws`, followed
by ongoing frames. A successful `/health` response alone does not verify WSS upgrades or connector
authentication; ordinary `curl /ws` is not a complete WebSocket test either.

If ECS should also execute tasks, follow “Install a 24×7 Linux/ECS connector” above for Node.js,
Codex CLI authentication and the systemd service; approve it and verify its online status. Skip this
step for a Relay-only host. The browser extension is an experimental extra, not a prerequisite for deployment.

### G. Renewal, routine checks and backups

`certonly` does not install the certificate into Nginx for you. Create a deployment hook to reload
Nginx after successful renewal:

```bash
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/codex-anywhere-nginx.sh <<'EOF'
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/bin/systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/codex-anywhere-nginx.sh
/snap/bin/certbot renew --dry-run --run-deploy-hooks
systemctl list-timers --all | grep -i certbot
```

Confirm a next execution time is scheduled; the snap installation typically uses
`snap.certbot.renew.timer`. This Nginx HTTP-01 workflow still needs public port 80 during renewal.
If port 80 is unavailable, use automated validation through a supported DNS provider.
See the [Certbot renewal guide](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates).

Routine checks:

```bash
cd /root/codex-anywhere
./scripts/relay.sh status
./scripts/relay.sh devices
systemctl is-active docker nginx
docker compose logs --tail 100 bridge
tail -n 100 /var/log/nginx/codex-bridge-error.log
/snap/bin/certbot certificates
# Only if the ECS Connector is installed:
systemctl status codex-anywhere-connector.service --no-pager
```

For a public HTTPS timeout, check DNS and ingress ports. For 502, check Relay's local health endpoint.
If the page works but WS fails, check `/ws` upgrade headers, proxy timeouts and connector status.
Before updates, back up the current commit, image, `.env`, the device registry in the Compose data
volume, connector configuration and identity files, Nginx configuration and `/etc/letsencrypt`.
Restrict access to these private backups. Preserve sessions, workspaces and existing network configuration,
and wait for tasks to become idle before restarting services. See “Operate and update” above for application upgrades.
