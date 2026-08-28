# Deployment

This deployment keeps the bridge process private on `127.0.0.1:3300` and publishes it only through Nginx TLS.

## DNS and firewall

1. Point a dedicated DNS A record to the ECS EIP.
2. Allow inbound TCP 80 and 443.
3. Restrict SSH to trusted source addresses.
4. Do not expose TCP 3300 publicly.

## Server

Create a random shared secret without putting it in shell history:

```bash
umask 077
read -rsp 'Bridge token: ' BRIDGE_TOKEN_INPUT
printf 'BRIDGE_TOKEN=%s\n' "$BRIDGE_TOKEN_INPUT" > .env
unset BRIDGE_TOKEN_INPUT
docker compose up --build -d
```

## Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name codex.example.com;
    ssl_certificate     /etc/letsencrypt/live/codex.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/codex.example.com/privkey.pem;

    location /ws {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Local connector

Run the connector only after Codex CLI is authenticated on the local computer:

```powershell
$env:BRIDGE_TOKEN = Read-Host 'Bridge token'
$env:BRIDGE_URL = 'wss://codex.example.com/ws'
$env:CODEX_WORKSPACE = 'C:\workspace'
$env:CODEX_NETWORK_ACCESS = '0'
npm run connector
```

For unattended use, keep the token in user-scoped encrypted storage and inject it only into the connector process. Do not store it in the repository or a world-readable script.

This repository also includes a Windows login-startup installer that stores the token with user-scoped DPAPI encryption:

```powershell
$token = Read-Host 'Bridge token' -AsSecureString
.\scripts\install-connector.ps1 `
  -Token $token `
  -BridgeUrl 'wss://codex.example.com/ws' `
  -Workspace 'C:\workspace' `
  -AllowedRoots @($env:USERPROFILE, 'C:\workspace')
```

Downloads are limited to `AllowedRoots` by default. Add `-AllowAnyFileDownload` only on a trusted
single-user machine when downloads outside those roots are intentionally required.

The encrypted credential and non-secret connector configuration are stored outside the checkout under `%LOCALAPPDATA%\PersonalCodexBridge`. Re-run the installer without `-Token` to change settings while retaining the existing credential.

Copy the stored token when signing in from the same PC without printing it to the terminal:

```powershell
.\scripts\copy-token.ps1
```

## Validation

```bash
curl -fsS https://codex.example.com/health
docker compose ps
docker compose logs --tail=100 bridge
```

After updating the connector code, restart the local connector as well as rebuilding the ECS container. This keeps the browser pagination protocol and connector actions on the same version.
