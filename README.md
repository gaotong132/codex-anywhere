# Codex Anywhere

English | [简体中文](README.zh-CN.md)

Documentation for **v0.3.0 (2026-09-12)** · [Release and upgrade](docs/release-0.3.0.md) · [Documentation index](docs/README.md)

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

Codex Anywhere is designed for personal use, with conversations stored on your execution nodes.
It does not provide multi-user hosting, a general remote shell or automatic session forks.

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with or endorsed by OpenAI.

## What it does

- **Switch execution environments** — choose a personal computer or a 24×7 headless ECS node in the same
  browser. Sessions, unread state, recent workspaces, attachments and requests stay scoped to the selected machine.
- **Continue real sessions** — browse, rename and resume existing Codex sessions, or start a task in a local
  project. Markdown history opens at the latest page and loads older entries as you browse upward, preserving your position.
- **Follow task progress** — see running status, unread updates, progress, plans, tool purpose and elapsed time.
  Completed turns retain action summaries, configuration changes and failure or cancellation reasons; automation reports
  keep their full body while redundant notifications and internal fields stay out of the display.
- **Add instructions during a run** — steer active tasks with text, using Desktop delivery for existing sessions
  when supported. Stop a turn from Web when the selected connector owns it; messages are sent directly without a Web queue.
- **Choose models and permissions** — select the model, reasoning effort, fast mode and approval mode, including
  GPT-6 Astra, Max and Ultra when offered by the selected node. Headless nodes support user approval, Codex auto-review
  and explicitly enabled full access; settings and new-task defaults stay scoped to each environment.
- **Answer task questions** — choose suggested answers or enter your own in question cards, including those from
  `request_user_input_async`. Answered state syncs with Desktop and full exchanges remain expandable; answering preserves
  the chat draft, and preselected options are never submitted automatically.
- **Handle task approvals** — approve or reject requests for connector-owned turns from Web.
  Approvals already owned by Codex Desktop remain on the computer, preserving ownership across clients.
- **Paste and upload screenshots** — paste with Ctrl+V / ⌘+V in chat or a new task, or choose a PNG, JPEG or WebP
  file. Preview one image per message before sending; upload status distinguishes preparation, byte-based progress
  and receipt confirmation.
- **Preview images and local files** — enlarge sent or generated images and open linked Markdown, source, config,
  logs and SVG with syntax highlighting, Mermaid diagrams and isolated visualizations. Historical generated images
  can be recovered from the selected node while their original files remain available.
- **Review code changes by turn** — open a completed turn's Diff on demand, with file boundaries, old and new line
  numbers and optional wrapping on narrow screens. Oversized content is marked as truncated; unavailable historical
  diffs never fall back to unrelated changes in the current working tree.
- **Track context usage** — the status ring shows context usage and token details reported by Codex. Timeline markers
  retain compaction progress, elapsed time and completion, with before/after usage when available for longer tasks.
- **Bring results back** — copy replies and download files from the selected node after confirmation, including from
  previews. Downloads try to keep the screen awake; interrupted foreground transfers pause safely and resume when
  the approved browser reconnects.
- **Authorize browser actions (experimental add-on)** — an optional extension shares chat and the current task in its
  side panel. Pair once, then authorize pages for snapshots, screenshots, zoom, clicks, input, scrolling and navigation,
  with new-tab following. Disabled by default; see the [extension instructions](extension/README.md) and
  [development plan](docs/browser-agent.md) for setup and limitations.
- **Recover from disconnections** — browser, Relay and connectors reconnect and resynchronize without duplicating
  accepted messages, so you can keep following the original task after a network change.
- **Approve every endpoint** — browsers pair through a ten-minute, single-use link and then use persistent device keys;
  connectors also require a secret and explicit owner approval. Application traffic between browser and connector is
  end-to-end encrypted, and personal computers make outbound connections only.

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
login. Connector-owned runs support native events, steering, stopping, Web approvals, and per-task
permission modes. Desktop activity is optional status enrichment: session listing returns from app-server
data immediately, then merges a short-lived Desktop status cache on a later poll so an unavailable Desktop
bridge cannot hold up startup. Codex Anywhere does not implement ACP.

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
| Relay | Loopback-bound reference service, reduced container privileges, bounded logs, and private device trust/activity records |

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
repository map and protocol rules. Release highlights are recorded in the [changelog](CHANGELOG.md).

## Community

Share setups and ideas in [GitHub Discussions](https://github.com/gaotong132/codex-anywhere/discussions),
or report reproducible problems through [Issues](https://github.com/gaotong132/codex-anywhere/issues).
Please report security concerns privately through the [security policy](docs/SECURITY.md).

## License

[MIT](LICENSE)
