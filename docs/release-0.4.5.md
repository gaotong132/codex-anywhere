# v0.4.5 — 2026-10-22

English | [简体中文](release-0.4.5.zh-CN.md)

This release collects the changes since v0.4.4. Protocol 4 and existing pairing identities are retained. Browser Agent remains an **optional experimental add-on**.

## Highlights

- Send Web messages through native Desktop user input, preserving ordinary user-message semantics and steering. Show delivery confirmation only after the target accepts the message.
- Read models, reasoning and permissions without navigating Desktop. Bound expensive state reads, reuse pushed status and retain a compact loading indicator.
- Change permissions from Web, including at creation and for idle chats that Desktop has not yet taken over. Changes remain subject to Connector capabilities and explicit confirmation.
- Support more execution devices with persistent unique routes, conflict rejection and synchronized custom names.
- Run ECS sessions concurrently with isolated streaming, approvals and stopping. Delete idle headless sessions with confirmation without deleting project files.
- Edit and resend an earlier user message: replace that turn and remove later conversation records, preserving original attachments. This does not undo file changes or external actions. Busy sessions, stale confirmations and uncertain results are guarded against unsafe retries.
- Improve Markdown tables, CJK emphasis, process messages and history pagination; preview linked raster images and download originals on demand.
- Reconcile server feature changes into committed source, keeping private configuration and rollback backups outside the repository.

## Upgrade

1. Check local changes and active tasks on each node. Preserve the current commit, image ID/tag, private configuration, device registry and Connector identities. Keep business sessions and workspaces. Wait for Connector-owned tasks to finish before restarting.
2. In a clean checkout on each node, select this release. Before replacing Windows dependencies, stop this installation's idle Connector and watchdog as described in the deployment guide to release loaded native modules:

   ```sh
   git fetch origin --tags
   git checkout --detach v0.4.5
   npm ci
   npm run build
   ```

   A Relay-only host builds inside Docker and does not need host Node/npm. Connector hosts need Node.js 22+; dependencies must be installed for the service account and runtime. Preserve unrelated local work instead of resetting it to the tag.
3. Rebuild the Relay using `docker compose build bridge`, then `docker compose up -d --no-build bridge`. On an idle same-host Connector, rebuild Node output and restart `codex-anywhere-connector.service`. Validate container health, public HTTPS, authenticated WSS and both execution routes. `relay.sh update` follows `main` and does not pin a tag, back up state or wait for idle tasks.
4. Rebuild and restart the Windows Connector through the existing launcher/watchdog. Re-running the installer alone does not necessarily replace an already running process. See [actual restart steps](deployment.md#windows-connector-restart). Preserve DPAPI configuration and identity files; do not stop Codex Desktop.
5. Fully refresh Web or choose **Reload chat** in the side panel. Verify existing history, an image, text/HTML previews and a confirmed download. No database migration or re-pairing is required. The original files must still exist.
6. If using the extension, run `npm run build:extension`, keep the whole `extension/dist` at its installed path and reload it. The directory is generated and untracked. This release adds no browser permissions; `dev (build …)` still denotes an unpacked experimental build.
7. After validation, record current and previous image IDs. Inspect all containers, including stopped ones, and concurrent builds; remove only explicitly identified obsolete project image references. Keep the latest two deployment versions and required base/container images. Do not prune shared caches, volumes or unrelated containers. If validation fails, restore the matching saved image/code while preserving current legitimate device registrations.

## Verification and limits

Release validation on Windows passed all four TypeScript targets, 631 main tests, 100 extension tests, Web/Node production builds and checks of 45 Markdown documents and release metadata. The feature implementation was verified against temporary real PC and ECS sessions; PC edit/resend exercised the unloaded-session runtime path. Desktop-owned native editing has regression coverage but was not independently verified end-to-end in that run.

Upgrade both Relay and Connectors for the new actions; a compatible protocol number alone does not provide new capabilities on older Connectors. Restart idle Connectors and refresh Web. No re-pairing or database migration is required. Existing device IDs and names are retained. Older dated review reports describe their original releases only.

The extension ZIP is an unpacked build: extract it to a fixed directory and load that directory in Chrome/Edge developer mode. Updating an installed directory and reloading preserves its pairing; installing on another computer requires that computer's own authorization. Checksums accompany the release assets.
