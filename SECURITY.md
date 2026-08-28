# Security Policy

## Supported versions

Only the latest commit on `main` is supported. Codex Anywhere is intended for one trusted user and
is not designed as a multi-tenant service.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/gaotong132/codex-anywhere/security/advisories/new).
Do not include credentials, tokens, private hostnames, IP addresses, conversation content, or local
filesystem paths in a public issue.

## Deployment checklist

- Use a unique bridge token generated from at least 32 cryptographically random bytes.
- Store the token only in the relay `.env` and the connector's DPAPI-protected state.
- Prefer `wss://` for every remote connector. Plaintext `ws://` is supported by operator choice but
  exposes the shared token and relayed content to the network path.
- Terminate TLS at a maintained reverse proxy and never expose port 3300 directly. Confirm the
  container publishes only `127.0.0.1:3300`.
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

The shared token grants access to the single-user bridge. It is stored in browser `sessionStorage`
(not persistent local storage) for the active tab, in a root-readable ECS `.env`, and in user-scoped
DPAPI storage when the Windows installer is used. Rotate it immediately after disclosure.

File downloads require explicit browser confirmation and use a random, short-lived, one-file,
client-bound capability. The connector canonicalizes paths, rejects directories and path escapes,
holds a stable file handle, detects changes during transfer, rate-limits chunks, and records only
hashed local audit identifiers. Enabling unrestricted downloads intentionally expands this boundary.

## Out of scope

Codex Anywhere is not a multi-tenant identity provider, a zero-trust gateway, or a general remote
shell. It does not defend against a compromised connector computer, compromised ECS root account,
malicious browser extension, stolen shared token, or an authorized Codex action that the user approves.
