# Codex Anywhere

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml/badge.svg)](https://github.com/gaotong132/codex-anywhere/actions/workflows/codeql.yml)
[![Version](https://img.shields.io/github/v/tag/gaotong132/codex-anywhere?sort=semver)](https://github.com/gaotong132/codex-anywhere/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/readme-hero.png" alt="Codex Anywhere lets a mobile browser follow Codex work, preview linked source files, and continue sessions running on your own computer" width="100%">
</p>

Codex Anywhere is a single-user, self-hosted Web bridge for Codex sessions on your own execution nodes.
Follow work from a phone, continue a task, send images, preview linked source files, and bring generated
files back without exposing a personal computer to the public internet. Codex and project files remain on
the selected connector node; a small relay you control provides the remote meeting point.

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with or endorsed by OpenAI.

## What it does

- **Switch execution environments** — choose a personal computer or a 24×7 headless ECS connector from
  the same browser. Sessions, unread state, remembered workspace, attachments, and requests stay scoped
  to the selected environment so matching thread IDs or paths cannot cross nodes.
- **Continue real Codex sessions** — browse recent sessions, read Markdown history, send text or images,
  and start a task in an existing local project.
- **Follow work as it happens** — see running and unread-complete sessions, progress updates, plan steps,
  tool purpose, elapsed time, and file-change totals. The status ring tracks current context usage and
  reveals token details on hover or tap, while compaction events stay visible in the timeline. Completed
  turns keep compact tool summaries, configuration changes, and failure or cancellation reasons. Tap a
  completed turn's totals to inspect its bounded unified diff. Long histories load incrementally.
- **Guide an active task** — append text to a connector-owned run, or use Desktop delivery when the
  existing session supports it. Messages are sent directly; Codex Anywhere does not maintain a Web queue.
- **Choose how Codex works** — view or change the model, reasoning effort, and fast mode when the selected
  Codex model exposes those options.
- **Use the results on mobile** — preview sent or generated images; open linked Markdown, source, config,
  and plain-text files; view syntax-highlighted code and Mermaid diagrams; open isolated Codex
  visualizations; copy messages; and download local files after confirmation. Downloads try to keep the
  screen awake; a foreground transfer pauses safely and resumes after the approved browser reconnects.
- **Handle supported approvals** — approve or reject requests owned by a run started through the
  connector. Requests already owned by Codex Desktop remain on the computer.
- **Recover from network changes** — browser, relay, and connectors reconnect and resynchronize without
  duplicating accepted messages.
- **Approve every endpoint** — browsers use a ten-minute, single-use pairing link and persistent device
  keys; connectors require both a secret and explicit owner approval.

Codex Anywhere deliberately stays small: it is not a multi-user gateway, a general remote shell, an
automatic session forker, or hosted conversation storage.

### Linked local files

Clicking a supported local file link opens a read-only preview without leaving the conversation:

| File | Browser behavior |
| --- | --- |
| Markdown | Rendered Markdown; Mermaid blocks render on demand and relative links remain usable |
| Common source and config files | Code preview with language detection and on-demand syntax highlighting |
| Plain text, logs, CSV, and TSV | Plain-text preview with horizontal scrolling |
| Binary, sensitive, or unrecognized files | Existing confirmed download flow; no inline preview |

Text previews accept only regular UTF-8 files up to 2 MiB inside configured connector roots. Sensitive
extensions such as `.env`, `.pem`, and `.key` are intentionally excluded. Every preview keeps a Download
button, and highlighting falls back to escaped plain code if a language is unavailable or the input is
too large to highlight efficiently.

### Per-turn code changes

When a completed reply shows file-change totals, tap them to open the unified diff produced by that Codex
turn. The browser requests it only on demand; the connector reads the known session rollout incrementally,
keeps turns isolated, and returns at most 512 KiB. Large diffs are marked as truncated, and unavailable
legacy turns fail closed instead of falling back to the current working-tree diff. The preview includes
old and new line numbers, file boundaries, and an optional line-wrapping control for narrow screens.

### Context and timeline diagnostics

When Codex reports token accounting, the top-right activity ring also shows how much of the model context
window is in use. Hover over or tap the ring for the exact token count; the ring changes tone at high and
critical usage. Context compactions appear as dedicated timeline markers with their sequence and available
before/after totals. Completed turns retain compact counts for tools, commands, edits, and other actions,
plus bounded model-setting changes and failure or cancellation reasons. Raw reasoning, tool arguments, and
tool output are not copied into these summaries.

## Architecture

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Codex Anywhere architecture: a mobile browser selects an outbound Windows or headless ECS connector through a self-hosted relay" width="100%">
</p>

```text
phone / browser ── WS or WSS ──> your ECS/VPS relay
                                      ▲       ▲
Windows connector ── outbound WSS ────┘       └── loopback WS ── ECS connector
        │                                                        │
        └── Codex Desktop / app-server + local projects          └── Codex CLI app-server + ECS workspaces
```

Every connector has a stable route and connects outward to the relay. The browser opens one authenticated
end-to-end encrypted channel to the selected route. Application requests, responses, events, previews, and
file chunks stay on that channel; the relay authenticates devices and routes ciphertext without keeping a
conversation database.

Each connector starts its own Codex app-server. A Windows connector uses `desktop` mode: existing Desktop
sessions keep Desktop delivery and bounded adaptive history polling. A Linux/ECS connector uses `headless`
mode and owns new and resumed sessions through its app-server, so work can continue without a desktop
login. Connector-owned runs support native events, steering, stopping, and Web approvals. Codex Anywhere
does not implement ACP.

## Security at a glance

<p align="center">
  <img src="docs/assets/security-model.svg" alt="Codex Anywhere security model: layered device authentication, a self-hosted relay trust boundary, and Codex execution and files on the selected node" width="100%">
</p>

| Boundary | Current protection |
| --- | --- |
| Browser access | Single-use pairing followed by an approved Ed25519 device identity; no shared browser login token |
| Application traffic | Authenticated X25519 exchange and XChaCha20-Poly1305 encryption between browser and connector |
| Execution nodes | Outbound connections only; Windows credentials use current-user DPAPI, while the Linux service keeps a mode-0600 environment file and device identity |
| Files | Root-bound image and bounded text/code/Markdown previews, confirmed resumable downloads bound to one approved device and file, and sandboxed visualizations |
| Relay | Loopback-bound reference service, reduced container privileges, bounded logs, and device trust records only |

The relay is still trusted infrastructure: it serves Web code, manages device trust, and can observe routing
metadata, timing, and ciphertext size. A compromised relay, browser profile, or connector computer is not
made harmless by end-to-end encryption. Direct `ws://` keeps application frames encrypted but does not
protect Web delivery, pairing, or metadata. Prefer WSS, a VPN, or a secure tunnel on untrusted networks.

Read the honest threat model and incident steps in the [security policy](docs/SECURITY.md).

## Deploy

You need:

- a reachable Linux ECS/VPS with Git, Docker Engine, and Docker Compose v2; add Node.js 22+ and an
  authenticated Codex CLI when the same host should also run a 24×7 connector;
- a Windows computer with Codex Desktop/CLI, Node.js 22+, Git, and PowerShell;
- a browser-reachable entry point. A domain, certificate, and reverse proxy are optional; WSS is
  recommended over public or untrusted networks.

Start the relay:

```bash
git clone https://github.com/gaotong132/codex-anywhere.git
cd codex-anywhere
./scripts/relay.sh setup
```

Install one or more connectors, approve each with `./scripts/relay.sh approve`, and create a browser pairing
link with `./scripts/relay.sh pair <public-url>`. The [deployment guide](docs/deployment.md) covers both the
Windows/Desktop and Linux/ECS headless modes, environment switching, and maintenance commands.

The reference service binds to `127.0.0.1:3300`; do not expose that port directly to the public internet.
The address is useful only for same-computer development unless an ingress, VPN, or tunnel provides the
remote entry point.

## Develop

Requirements: Node.js 22+ and an authenticated Codex CLI.

```bash
npm ci
npm run check
npm run build
```

Application source and tests use strict TypeScript. The generated JavaScript in `build/` and bundled Web
assets in `dist/` are build output and are not committed. See [Contributing](docs/CONTRIBUTING.md) for the
repository map and protocol rules.

## Community

Share setups and ideas in [GitHub Discussions](https://github.com/gaotong132/codex-anywhere/discussions),
or report reproducible problems through [Issues](https://github.com/gaotong132/codex-anywhere/issues).
Please report security concerns privately through the [security policy](docs/SECURITY.md).

## License

[MIT](LICENSE)
