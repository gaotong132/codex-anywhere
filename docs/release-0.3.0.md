# v0.3.0 — 2026-09-12

English | [简体中文](release-0.3.0.zh-CN.md)

This release follows v0.2.1. The core remains a single-user, self-hosted Web bridge; Browser Agent remains an **experimental add-on**, disabled by default and installed separately.

## Highlights

- Browser side-panel chat uses the currently selected task. Pair chat once; the extension automatically links its separate identity. Page control still requires an explicit grant.
- Eight browser tools cover page inventory, text snapshots, viewport screenshots, per-tab zoom, clicks, input, scrolling and link navigation. Horizontal clipping prefers 80%, then 67% zoom with a new snapshot after each change.
- AI-opened tabs follow in the original window, reuse eligible children and retain the five most recently used ordinary children. Same-origin navigation preserves consent; cross-origin destinations require authorization. Protected and manually opened tabs are retained.
- Paste a screenshot with Ctrl/⌘+V, preview it and send. Uploads show preparation, byte-based progress and receipt confirmation. One PNG/JPEG/WebP image is supported per message.
- Answer `request_user_input_async` questions in Web using choices or free text. Replies stay in the original task, preserve composer drafts and synchronize with Desktop; answered cards and repeated question quotes are compact.
- Generated images appear from both legacy and newer Codex events, including summary history and large image rows. Existing local files need no regeneration. Text/SVG/code previews accept supported readable absolute paths; raster preview roots and confirmed downloads retain their separate policies.
- GPT-6 Astra is selectable when advertised by the connected Codex runtime. All advertised reasoning levels, including Max and Ultra, are preserved.
- Context compaction updates one timeline marker in place. Terminal failures retain their reason. Browser context is a 91-character state hint sent only initially or after a state change.
- Device administration shows connection activity and JSON output. History, file transfer and browser driver lifecycles have additional isolation and timeout handling. Docker package metadata stays readable by the non-root runtime under restrictive checkout permissions.

## Upgrade

1. Check for local changes and active tasks on every node. Save the current commit, Relay image and protected copies of private configuration, device registry and connector identities. Wait for connector-owned work to finish before restarting it; preserve business sessions and workspaces.
2. Fetch tags and select the tested version in each clean checkout:

   ```sh
   git fetch origin --tags
   git checkout --detach v0.3.0
   npm ci
   npm run build
   ```

3. On the Relay host, rebuild and start the image with `docker compose build bridge` and `docker compose up -d --no-build bridge`. Restart an installed same-host Connector only after it is idle. Verify container health, the HTTPS entry and each Connector. The reference health check interval is 30 seconds with a 10-second start period; inspect failures instead of equating a successful build with a healthy service.
4. On Windows, rebuild before restarting the Connector through the installed launcher or installer. Preserve its configuration and DPAPI identity files. Do not stop Codex Desktop or unrelated tasks. On Linux, restart `codex-anywhere-connector.service` after the matching build is ready.
5. Fully refresh Web, or choose **Reload chat** in the side panel. Verify an existing generated image, a supported file preview and a harmless task on the intended node. Existing device pairing remains valid.
6. If using Browser Agent, run `npm run build:extension`, keep `extension/dist` at its existing installation path and reload the extension. Compare its version/fingerprint to the built manifest. Reload the host MCP tool list while idle and verify the eight tools. Upgrading an older extension may prompt for `debugger` or `webNavigation`; this tag adds no permissions beyond the preceding main build.

`relay.sh update` tracks `main`, so use the explicit steps above when pinning this tag. A later upgrade must again coordinate Relay, Web and all Connectors. Restore the saved matching code/image/configuration if verification fails; do not recreate the device registry or pairing identities as a recovery step.

## Install the extension on another computer

Build from this tag and copy the **entire** `extension/dist` directory to a fixed location on the other computer. The generated directory is not committed to Git; the source and build configuration are. Load that directory in Chrome/Edge's extension management page. Register that installation's exact extension Origin with the Relay, pair chat once on the new browser profile and explicitly authorize the intended page. Do not copy browser profiles, private keys or one-time credentials from another installation. See the [extension guide](../extension/README.md).

## Verification and limits

Release verification on 2026-09-12: all type checks and 389 main tests passed; Web/Node builds and all 100 extension tests passed. All 24 Markdown documents passed local-link and heading-anchor checks. The built extension fingerprint is `0ad9ef11`. The package, lockfile, extension source manifest and MCP server identify 0.3.0. The extension still displays `dev (build …)` because it is an unpacked experimental build; the Git tag identifies the release, and the fingerprint identifies the artifacts.

Dated browser acceptance and refactoring reports describe their original test runs, not a new acceptance of every site. Arbitrary scripts, cookie/password export, iframe/shadow-DOM controls, native dialogs and browser file uploads remain unsupported. Screenshot masking is not comprehensive secret detection. Zoom cannot replace pagination, lazy loading or snapshot limits. Actual login, verification, new site permissions and out-of-scope actions still need user involvement.

See the [documentation index](README.md), [deployment guide](deployment.md), [security policy](SECURITY.md) and [changelog](../CHANGELOG.md).
