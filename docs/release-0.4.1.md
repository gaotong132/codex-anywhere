# v0.4.1 — 2026-10-16

English | [简体中文](release-0.4.1.zh-CN.md)

Maintenance release following v0.4.0. Browser Agent remains an **optional experimental add-on**. The wire protocol remains version 4 and existing device pairing is retained.

## Highlights

- Merge summary and live history despite different timestamp precision, without discarding deliberate repeats. Retain history, images and reading anchors across mobile background/resume and recover Desktop question answers from large rollout logs.
- Keep unfinished mutations outside the completed-result cache, so eviction or TTL expiry cannot dispatch the same unfinished request again after reconnect. Bound pending mutations and start result TTL at completion.
- Share bounded preview reads and file snapshots. Reject files that change during reading, validate visualization UTF-8, and invalidate image caches when a same-size file is replaced with its modification time preserved.
- Reserve download slots before opening files, prevent capabilities from appearing after shutdown, protect active reads from expiration and recheck the final chunk before completing a download.
- Include the reviewed dependency updates and React 19.3.0 package alignment. Mermaid remains 11.17.2; the audit still reports two low-severity dependency entries in the KaTeX/Mermaid chain. No moderate, high or critical findings were reported by the release audit.
- Refresh English/Chinese guides and add `npm run check:docs` to `npm run check`. Package, lockfile, extension source manifest and MCP version now agree on 0.4.1.

## Upgrade

1. Check local changes and active tasks on each node. Preserve the current commit, image ID/tag, private configuration, device registry and Connector identities. Keep business sessions and workspaces. Wait for Connector-owned tasks to finish before restarting.
2. In a clean checkout on each node, select this release. Before replacing Windows dependencies, stop this installation's idle Connector and watchdog as described in the deployment guide to release loaded native modules:

   ```sh
   git fetch origin --tags
   git checkout --detach v0.4.1
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

Release checks include 451 main tests, four TypeScript targets, Web/Node production builds, the compiled extension suite, and local documentation links/anchors/version metadata. The [code review](code-review-2026-10-16.md) records reproduced faults and the retained boundaries. Release deployment additionally checks HTTPS/WSS, Connector status and actual file operations on both nodes.

Replay protection is process-local and bounded. Completed results can expire or be evicted; Connector restart does not provide durable exactly-once delivery. File checks detect ordinary concurrent changes, not a malicious OS or an atomic filesystem snapshot. Downloads still assemble a browser Blob, uploads remain temporary, and a missing source file cannot be restored by refreshing.

Browser login/MFA, new site permission and actions outside the requested scope still require user involvement. Browser automation is not acceptance on a physical phone. Dated reports and screenshots retain their original scope.

See [deployment](deployment.md), [security](SECURITY.md), [extension setup](../extension/README.md) and the [changelog](../CHANGELOG.md).
