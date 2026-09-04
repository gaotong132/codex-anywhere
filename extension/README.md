# Browser extension — local development preview

English | [简体中文](README.zh-CN.md)

This is the first Browser Agent milestone, **not remote browser control**. It lets you explicitly grant
read access to one ordinary HTTP(S) tab and inspect bounded page text in a local popup. It does not pair
with Relay, connect to ECS/Codex, click, type, navigate, or upload content.

## Build and try

From the repository root, using Node.js 22+:

```bash
npm ci
npm run check
npm run build:extension
npm run test:extension
```

1. Use a separate test profile in Chrome 120+ or a compatible Chromium-based Edge.
2. Open the browser's Extensions management page, enable developer mode, and choose Load unpacked.
3. Select `extension/dist` in this repository, not the source `extension` directory. This build output
   is separate from the production Web assets in the root `dist` directory.
4. Open a non-sensitive test page, click the extension action, and explicitly authorize the current tab.
5. Click Read page to display its text. Stop and clear revokes access and clears the popup.
6. Reload/navigate the page and verify that another read requires new approval. Removing the extension
   through the browser's Extensions page removes this development installation.

Authorization lasts at most ten minutes. Page navigation (including conservative same-origin URL
changes), tab closure, manual stop, expiry, and extension worker restart revoke it. Closing the popup
does not itself revoke the grant; use Stop, or wait for expiry/worker restart. Reads and tab discovery
time out after at most fifteen seconds. Stop stays available while a request is pending.

## Boundaries

- Only `activeTab` and `scripting` permissions; no persistent host access or all-tabs grant. The extension
  rejects content-script/website messages and injects only packaged, fixed functions into the approved
  top-level document in the isolated world.
- Network connections are blocked by the extension-page CSP. No device pairing, telemetry, persistent
  page-content storage, cookie/password export, arbitrary JavaScript or desktop control is implemented.
- Preview excludes input/textarea/select values, editable regions, hidden regions, scripts, iframes and
  elements marked `data-anywhere-private`. It includes text and element tags, not attributes or full URLs.
- This is **not automatic secret redaction**. Visible page text may itself contain sensitive information.
  CSS visibility handling is best-effort; canvas, shadow roots and embedded frames are not read.
- Default output: 100 text nodes / 8,000 characters; absolute limits: 200 / 16,000. Traversal is bounded
  to 5,000 nodes and ancestry checks to 64 levels. The popup renders text, never page-provided HTML.

Automated checks cover contracts, authorization, races and DOM extraction. A build or simulated driver
test does not establish compatibility with actual installed Chrome/Edge, nor does it validate remote
Codex integration. Complete the manual checks above before using the unpacked preview.

See [the development plan](../docs/browser-agent.md) for the remaining milestones. The manifest's
`0.0.1` is an unpublished development identifier, not a project release/tag.
