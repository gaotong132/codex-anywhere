# Security Policy

English | [简体中文](SECURITY.zh-CN.md)

## Supported versions

Use the latest tagged release or current `main`, and keep the browser, relay, and connector on the same
revision. The protocol is strict and intentionally has no plaintext, missing-capability, or older-version
fallback.

Codex Anywhere is designed for one trusted user. It is not a multi-tenant identity service.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/gaotong132/codex-anywhere/security/advisories/new).
Do not put credentials, private addresses, conversation content, or local paths in a public issue.

## What is protected

- Codex, projects, attachments, and generated files stay on the connector computer. That computer accepts
  no public inbound connection.
- The relay has no conversation database and does not intentionally persist messages, previews,
  visualizations, or download chunks. It persists only device trust state.
- A browser enrolls through a ten-minute, single-use pairing link, then authenticates with its approved
  Ed25519 key. There is no shared browser token or recovery login.
- A connector needs its connector-only secret and an administrator-approved Ed25519 identity. Windows
  protects both connector credentials with current-user DPAPI.
- Browser and connector authenticate ephemeral X25519 keys, then protect application frames with
  XChaCha20-Poly1305. The relay routes ciphertext and can see metadata, timing, and approximate size—not
  message or file content.
- Authentication uses fresh challenges, expires authenticated sockets after one hour by default, throttles
  repeated failures, validates browser origins, and limits frame size.

The browser private key is stored in that browser profile. Browser storage is not a hardware-backed
keystore; anyone who compromises the profile can act as that browser until the device is revoked.

## Pairing flow

The pairing credential is carried in the URL fragment, removed before the WebSocket connects, and stored
by the relay only as a one-way verifier until it expires or is consumed.

```mermaid
sequenceDiagram
    participant O as Owner on relay host
    participant R as Relay
    participant B as Browser
    O->>R: Create single-use pairing link
    R-->>O: URL fragment + QR code (10 min)
    O-->>B: Open/paste link, scan QR, or upload screenshot
    B->>B: Create device key and remove URL secret
    R-->>B: Fresh challenge
    B->>R: One-time proof + signed device identity
    R->>R: Consume pairing and approve public key
    Note over B,R: Reconnects use the approved key and fresh challenges
```

Connectors do not use browser pairing. Their first signed connection appears as pending and must be
reviewed from the relay host with `./scripts/relay.sh approve`.

## Files, previews, and approvals

- Image previews must resolve inside an allowed root, pass content validation, and are resized and
  converted to WebP before transfer.
- Original file downloads require user confirmation and an in-memory capability bound to one approved
  browser identity and one unchanged file. The capability expires after 30 minutes without progress and
  is not stored by the relay. The Web client tries to keep the screen awake; while hidden or disconnected,
  it stops requesting new chunks and resumes after the same browser reconnects.
- Local text previews require an explicit click, accept only allowlisted Markdown, source, config, or
  plain-text names, and remain restricted to configured or managed local roots. The connector resolves the
  canonical file path, requires a regular UTF-8 file no larger than 2 MiB, rejects embedded NUL bytes and
  changing snapshots, and intentionally excludes sensitive extensions such as `.env`, `.pem`, and `.key`.
- Source previews load the common syntax-highlighting runtime only when needed. Highlighted markup is
  sanitized to classed `span` elements before insertion; unavailable languages and inputs above 512 KiB
  fall back to escaped plain code. Every preview retains the separately confirmed download path without
  sending file contents through the relay in plaintext.
- Mermaid code blocks load the renderer on demand with strict security and bounded input and edge counts.
  Generated SVG is sanitized again before inline display and uses an explicit high-contrast dark theme;
  invalid diagrams fall back to their source code.
- Interactive HTML is limited to Codex visualization roots and rendered in an opaque-origin,
  network-blocked sandbox.
- The Web UI can act only on approvals owned by connector-started turns. An approval already owned by
  Codex Desktop stays on the computer and is shown as non-actionable in the Web UI.

Broad `-AllowedRoots`, `-AllowAnyFileDownload`, and `-EnableNetworkAccess` options increase connector
authority and are disabled or narrow by default. `-AllowAnyFileDownload` expands only confirmed downloads;
it does not expand the roots accepted by image or text previews.

## Trust boundary and honest limits

The ECS/VPS is trusted infrastructure because it serves the Web application and manages device trust.
A compromised relay administrator can replace future Web code or trust records, approve an attacker,
observe metadata, or deny service. A compromised connector computer or approved browser profile retains
that endpoint's authority. End-to-end encryption reduces relay exposure; it does not make the deployment
zero-trust.

Direct `ws://` is supported and application frames remain encrypted, but HTTP/WS does not protect Web
delivery, pairing, metadata, or availability from the network. Prefer WSS, a VPN, or a secure tunnel on
untrusted networks.

Codex Anywhere does not defend against a harmful Codex action that the user approves, and it does not
replace Codex permission review.

## Deployment baseline

- Keep the reference port bound to ECS loopback and publish it through a maintained ingress or private
  network. Use SSH keys, patch the host, and restrict firewall rules.
- Keep `.env` and the device-registry volume private. Back them up only when the backup is encrypted.
- Set `BRIDGE_TRUST_PROXY=1` only when a trusted proxy is the sole ingress and overwrites `X-Real-IP`.
- Disable proxy access logs or retain them briefly; relay container logs are size-bounded by default.
- Approve only a request you just initiated. Revoke lost, retired, or unexpected devices.
- Rotate any secret exposed in chat, screenshots, logs, shell history, commits, or CI output.

## Device administration

Run on the relay host:

```bash
./scripts/relay.sh pair https://codex.example.com
./scripts/relay.sh devices
./scripts/relay.sh revoke
```

The running relay reloads the registry and closes a revoked connection, normally within 30 seconds.

## If access may be compromised

1. Revoke the affected browser or connector. Treat a copied device private key as a compromised endpoint.
2. If the connector secret leaked, replace `BRIDGE_CONNECTOR_TOKEN`, reinstall the Windows connector
   credential, and restart the relay and connector.
3. Review the ECS, ingress, browser extensions, clipboard, shell history, and related infrastructure
   credentials. Do not publish forensic data that contains conversation or identity material.
