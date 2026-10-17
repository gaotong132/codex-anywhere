# v0.4.2 — 2026-10-17

English | [简体中文](release-0.4.2.zh-CN.md)

A maintenance release retaining protocol 4 and pairing identities. Browser Agent remains an optional experimental add-on.

## Highlights

- Confirm PC session archiving from the title bar, retaining history and project files. Restore in Codex Desktop. Running, approval-waiting and unknown states are rejected; browser pages require new consent after restoration.
- Show Desktop-managed permissions with open/refresh actions and fix accumulating permission icons. ECS permissions remain editable in Web.
- Snapshot request data before sending so later draft edits cannot alter reconnect replay; deduplicate archive mutations too.
- Make same-size file rewrite tests independent of filesystem timestamp granularity.

## Upgrade

1. Check local changes and active tasks on each node. Preserve the current commit, image ID/tag, private configuration, device registry and Connector identities. Keep business sessions and workspaces. Wait for Connector-owned tasks to finish before restarting.
2. In a clean checkout on each node, select this release. Before replacing Windows dependencies, stop this installation's idle Connector and watchdog as described in the deployment guide to release loaded native modules:

   ```sh
   git fetch origin --tags
   git checkout --detach v0.4.2
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

Release checks cover four TypeScript targets, main tests, Web/Node builds, extension tests and documentation. A real Desktop temporary session verifies archive and restore without modifying business conversations; see the [code review](code-review-2026-10-17.md).

Update and restart the PC Connector to expose archiving. Web does not list or restore archived sessions; restore through Codex Desktop. External clients can start after the status check; native ownership conflicts fail without forced takeover or deletion. Replay still has process-lifetime and cache-retention limits.

The official npm audit retains two low-severity entries in the KaTeX/Mermaid chain and no moderate, high or critical entries. Private server concurrency/deletion changes are not features of this public tag.
