# Security Policy

## Supported versions

Only the latest commit on `main` is supported. Codex Anywhere is intended for one trusted user and
is not designed as a multi-tenant service.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/gaotong132/codex-anywhere/security/advisories/new).
Do not include credentials, tokens, private hostnames, IP addresses, conversation content, or local
filesystem paths in a public issue.

## Deployment checklist

- Use independent browser-client and connector tokens, each generated from at least 32
  cryptographically random bytes.
- Store both tokens only in the relay `.env`; store only the connector token in the connector's
  DPAPI-protected state. Put the client token in a password manager and enter it only on trusted
  browser devices.
- Prefer `wss://` for every remote connector. Plaintext `ws://` is supported by operator choice but
  exposes relayed content and permits active network attackers to interfere with an authenticated
  connection. Challenge-response authentication avoids sending the token itself, but is not a
  substitute for transport encryption.
- For public WSS, terminate TLS at a maintained ingress and keep the relay on loopback. The included
  Compose reference publishes only `127.0.0.1:3300`. Direct WS remains supported by operator choice,
  but should be firewall-scoped and must be treated as plaintext transport.
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

The relay is nevertheless trusted. TLS terminates at the ECS reverse proxy, so Nginx and the relay
see plaintext frames in memory. This project does not provide application-layer end-to-end encryption
that hides content from the ECS operator or cloud host. Protect process memory, `.env`, proxy error
logs, backups, DNS and cloud accounts, and every administrator with access to the host.

The client token grants full browser-control access to the single-user bridge. It is stored in browser
`sessionStorage` (not persistent local storage) for the active tab and in a root-readable ECS `.env`.
The connector token can register or replace a local connector and is stored in the ECS `.env` and
user-scoped DPAPI storage when the Windows installer is used. Keep the roles separate so disclosure of
the browser token cannot impersonate the connector.

WebSocket authentication sends an HMAC-SHA-256 proof bound to a fresh 256-bit relay challenge, role,
and connector device ID; it never sends a raw token frame. Captured proofs are not reusable on a new
connection. Authenticated sockets expire after one hour by default and reconnect with a fresh proof.
Repeated failures are temporarily locked per client address. These controls reduce replay, brute-force,
and stolen-live-session risk; they cannot make a valid stolen token harmless.

File downloads require explicit browser confirmation and use a random, short-lived, one-file,
client-bound capability. The connector canonicalizes paths, rejects directories and path escapes,
holds a stable file handle, detects changes during transfer, rate-limits chunks, and records only
hashed local audit identifiers. Enabling unrestricted downloads intentionally expands this boundary.

## If a token may have leaked

1. Treat it as compromised; do not wait for evidence of use.
2. If only `BRIDGE_CLIENT_TOKEN` leaked, replace it with a new random value and restart the relay.
   Existing browser sockets are closed during restart; the connector credential remains valid.
3. If `BRIDGE_CONNECTOR_TOKEN` leaked, replace it on the relay and re-run the connector installer with
   the new secure token, then restart both relay and connector.
4. Review ECS/proxy logs, browser extensions, clipboard history, shell history, screenshots, CI output,
   password-manager access, and unexpected connector replacements. Rotate any infrastructure credential
   exposed with it.

## Out of scope

Codex Anywhere is not a multi-tenant identity provider, a zero-trust gateway, or a general remote
shell. It does not defend against a compromised connector computer, compromised ECS root account,
malicious browser extension, a valid stolen token before it is revoked, or an authorized Codex action
that the user approves.
