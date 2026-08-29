# Security Policy

English | [简体中文](SECURITY.zh-CN.md)

## Supported versions

Only the latest commit on `main` is supported. Codex Anywhere is intended for one trusted user and
is not designed as a multi-tenant service.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/gaotong132/codex-anywhere/security/advisories/new).
Do not include credentials, tokens, private hostnames, IP addresses, conversation content, or local
filesystem paths in a public issue.

## Deployment checklist

- Use independent browser-client and connector tokens, each generated from at least 32
  cryptographically random bytes. Prefer one-time links for browser enrollment; keep the browser Token
  as an administrator-controlled recovery credential rather than sharing it with every browser.
- Store both tokens in the root-readable relay `.env`. The Windows installer keeps the connector token
  and connector device key in current-user DPAPI state; if supplied, it stores the browser token in a
  separate DPAPI record only so the operator can copy it to a trusted browser. The connector process
  does not receive the browser token. A password manager remains the recommended browser-token store.
- Keep the device registry volume persistent and root-administered. Create one-time browser pairings
  only from an encrypted administrator session. Treat an unused ten-minute link as a temporary secret;
  do not paste it into logs, issues, or chat. Review pending recovery requests and revoke lost or retired devices.
- Treat notification permission as optional. Web Push subscriptions and the relay-generated VAPID
  private key remain in the protected state volume; do not publish or back up that volume unencrypted.
- Prefer `wss://` for every remote connector. Direct `ws://` is supported by operator choice, and
  application frames remain end-to-end encrypted, but HTTP/WS exposes Web delivery, enrollment,
  metadata, and availability to network attackers. Application encryption is not a substitute for
  transport encryption.
- For public WSS, terminate TLS at a maintained ingress and keep the relay on loopback. The included
  Compose reference publishes only `127.0.0.1:3300`. Direct WS remains supported by operator choice,
  but should be firewall-scoped and treated as an unprotected transport for Web delivery and metadata.
- If `BRIDGE_TRUST_PROXY=1`, ensure the relay is reachable only through the proxy and that the proxy
  overwrites `X-Real-IP`.
- Restrict SSH and HTTPS with firewall rules where practical; use SSH keys and keep the ECS patched.
- Disable reverse-proxy access logs or use short retention. Treat client IPs, hostnames, paths, and
  error diagnostics as private metadata.
- Keep `CODEX_ALLOWED_ROOTS` narrow, leave `CODEX_ALLOW_ANY_FILE_DOWNLOAD=0`, and leave connector
  network access disabled unless they are explicitly required.
- Rotate credentials immediately if they appear in chat, terminal output, logs, screenshots,
  commits, or CI artifacts.
- Audit complete reachable Git history, not only the current checkout, before changing visibility.

## Trust model and data handling

The ECS avoids exposing the connector computer to inbound internet traffic. The browser and local
connector both initiate outbound connections; WSS is recommended on public networks. Project files
and Codex execution remain local.
The relay has no conversation database and does not intentionally persist messages, attachment
previews, or download chunks.

When a user opts into notifications, the relay persists that approved browser's push-service endpoint
and encryption material. While the browser is disconnected, the connector sends only the generic event
kind `completed` or `approval`; the relay forwards that kind through Web Push. This exposes event type
and timing to the relay and push provider, but no task ID, session title, message, project name, path,
attachment, or tool output. Connected browsers receive local notifications instead. Delivery also
depends on browser and mobile-OS background policies and is not guaranteed.

Protocol v3 rejects outdated or incomplete peers and requires an application-layer encrypted channel
after WebSocket authentication. Browser and connector authenticate ephemeral X25519 keys with their approved Ed25519 identities, derive
directional keys with HKDF-SHA-256, and protect ordered JSON frames with XChaCha20-Poly1305. Message text,
image previews, visualization HTML, and download chunks cross the relay as ciphertext. The relay still
sees public device identities, route IDs, connection timing, frame direction and approximate size.

The relay host remains a trust boundary rather than a zero-trust component. It serves the browser code,
holds role tokens and the device trust registry, and enforces the current protocol. A compromised ECS or
root administrator could change future browser code, replace trust records, register an attacker-controlled
device, or deny service. End-to-end encryption protects against routine relay inspection and accidental
logging, not a malicious host that controls enrollment and code delivery. Protect `.env`, the registry,
proxy logs, backups, DNS and cloud accounts, and every administrator with host access. There is no
older-protocol or plaintext application-frame fallback: mismatched browser, relay, and connector builds
fail closed and must be updated together.

The preferred browser bootstrap is a random, ten-minute, single-use pairing link. Its secret is carried
in a URL fragment, removed from the address bar before the WebSocket is opened, and retained only in
`sessionStorage` until enrollment succeeds. The relay persists only a SHA-256 verifier and expiry, then
deletes that record after use. The client token remains a recovery bootstrap credential in the
root-readable ECS `.env`; when used, it exists only in browser `sessionStorage` until approval succeeds.
The connector token can register or replace a local connector and is stored in the ECS `.env` and
user-scoped DPAPI storage when the Windows installer is used. Keep the roles separate so disclosure of
the browser token cannot impersonate the connector.

WebSocket authentication requires an Ed25519 signature from an approved device identity. Enrollment
binds the one-time HMAC proof, public device key, and fresh 256-bit challenge; later browser reconnects
need only a new challenge signed by that already approved device key. Connector and recovery Token
flows bind the signature to their challenge, HMAC proof, role, and connector route ID. Raw tokens,
pairing secrets, and private device keys are never sent to the relay. Browser device keys persist
in that browser profile, while the Windows connector key is protected with user-scoped DPAPI. The
registry stores only public keys and pairing metadata. Captured proofs are not reusable, and a token
alone can create only a visible pending request—not an authenticated session. Authenticated sockets
expire after one hour by default and reconnect with fresh proofs; repeated failures are temporarily
locked per client address.

Assistant Markdown may embed a local JPEG, PNG, or WebP from `CODEX_ALLOWED_ROOTS`. The connector
validates the canonical path and actual file type, then sends only a bounded WebP preview; SVG and
other active or unsupported formats remain download-only. Original-file downloads require explicit
browser confirmation and use a random, short-lived, one-file, client-bound capability. The connector
rejects directories and path escapes, holds a stable file handle, detects changes during transfer,
rate-limits chunks, and records only hashed local audit identifiers. Enabling unrestricted downloads
intentionally expands the download boundary, not the automatic preview roots.

Codex-generated `.html` files are previewed only from the canonical `.codex/visualizations` directory
and are capped at 2 MiB. HTML reaches the browser only through the encrypted channel and becomes a
short-lived local Blob URL; the relay no longer stores an HTML preview or serves a preview capability.
The browser runs it in a sandboxed, opaque-origin frame without access to the
parent page, storage, forms, popups, top navigation, or network connections. Inline script is allowed
inside that isolated frame so the artifact remains interactive. The original file still uses the
confirmed, short-lived download capability.

Device administration is deliberately available only from the relay host. Create a browser pairing,
or use the default command to approve a connector or recovery Token request. These variants list or
revoke approved devices without
printing device IDs, request IDs, or public keys:

```bash
docker compose exec bridge node build/server/device-admin.js pair https://codex.example.com
docker compose exec bridge node build/server/device-admin.js list-approved
docker compose exec bridge node build/server/device-admin.js revoke
```

Revocation is observed by the running relay and closes the device's active socket on the next relay
heartbeat (normally within 30 seconds); no relay restart is required.

## If a token may have leaked

1. Treat it as compromised; do not wait for evidence of use.
2. Run the administrator `revoke` command above and remove any affected browser or connector identity.
   If a device private key may have leaked, assume that identity is compromised even if its token remains secret. Registry
   identities and pairing metadata are intentionally unavailable to the Web client.
3. If only `BRIDGE_CLIENT_TOKEN` leaked, replace it with a new random value and restart the relay.
   Existing browser sockets are closed during restart; the connector credential remains valid.
4. If `BRIDGE_CONNECTOR_TOKEN` leaked, replace it on the relay and re-run the connector installer with
   the new secure token, then restart both relay and connector.
5. Review ECS/proxy logs, browser extensions, clipboard history, shell history, screenshots, CI output,
   password-manager access, and unexpected connector replacements. Rotate any infrastructure credential
   exposed with it.

## Out of scope

Codex Anywhere is not a multi-tenant identity provider, a zero-trust gateway, or a general remote
shell. It does not defend against a compromised connector computer, compromised ECS root account,
malicious browser extension that can use an approved browser identity, simultaneous compromise of the
required credentials, or an authorized Codex action that the user approves.
