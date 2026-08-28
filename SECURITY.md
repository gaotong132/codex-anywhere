# Security Policy

## Supported versions

Only the latest commit on `main` is supported. Codex Anywhere is intended for one trusted user and
is not designed as a multi-tenant service.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/gaotong132/codex-anywhere/security/advisories/new).
Do not include credentials, tokens, private hostnames, IP addresses, conversation content, or local
filesystem paths in a public issue.

## Deployment checklist

- Use a unique bridge token with at least 32 random characters.
- Store the token only in the relay `.env` and the connector's DPAPI-protected state.
- Terminate TLS at a maintained reverse proxy and never expose port 3300 directly.
- If `BRIDGE_TRUST_PROXY=1`, ensure the relay is reachable only through the proxy and that the proxy
  overwrites `X-Real-IP`.
- Restrict SSH and HTTPS with firewall rules where practical.
- Keep `CODEX_ALLOWED_ROOTS` narrow, leave `CODEX_ALLOW_ANY_FILE_DOWNLOAD=0`, and leave connector
  network access disabled unless they are explicitly required.
- Rotate credentials immediately if they appear in chat, terminal output, logs, screenshots,
  commits, or CI artifacts.
- Audit complete reachable Git history, not only the current checkout, before changing visibility.

The relay forwards conversation and file frames in memory. It does not intentionally persist them,
but operators must still protect process memory, reverse-proxy logs, backups, and the connector
computer.
