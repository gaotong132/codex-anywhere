# v0.4.3 code review — 2026-10-17

English | [简体中文](code-review-0.4.3.zh-CN.md)

## Scope and decisions

Revisited request replay and secure-channel lifetime, Web history merging and download resume, approval polling, upload/download/preview bounds, HTTP boundaries and browser consent. Existing regressions cover authentication, environment isolation, reconnect, rendering and browser operations. This is a risk-based review, not a claim that every line or every deployment is defect-free.

The current split between Relay, Connector, shared protocol and Web remains appropriate. Do not rewrite the large UI or Codex adapter merely to reduce line counts. This pass extracts attachment cleanup because generic uploads otherwise import the image-preview dependency tree and duplicate cleanup error handling.

## Reproduced issues

| Issue | Evidence | Fix |
| --- | --- | --- |
| Concurrent expired-file deletion breaks uploads | Four simultaneous cleanup calls against 30 expired files reproduced three rejected calls on Windows, including EPERM. Image uploads propagate the error; the generic-upload workaround could abort the remaining scan. | Serialize scans per normalized directory; ignore only disappeared entries within the scan; release the queue after success or failure. Real permission/I/O errors remain visible. |
| Same-size partial-file edits produce an inconsistent checksum | A two-byte partial upload rewritten with different two-byte content was accepted before the fix. | Reuse bounded-file snapshot comparison before opening/appending and finalizing; validate the opened handle and record metadata after each successful write. |

Both regressions failed against the old implementation and pass after the fixes. A third regression checks recovery after a failed cleanup. Existing transfer tests cover byte preservation, bounds, ownership, cancellation and expiry.

## Dependencies and verification

- Update file-type to 22.1.1, Zod to 4.6.7, Vite to 8.3.4 and Sass to 1.105.1; keep exact direct versions and the lockfile together.
- Four TypeScript targets and 471 main tests pass. Web/Node production builds and the compiled extension suite are checked before tagging; documentation validation checks bilingual links, anchors and version metadata.
- The official npm registry audit retains two low entries in the KaTeX/Mermaid chain and zero moderate/high/critical entries. Mermaid 12 is deferred because it changes browser requirements and rendering defaults; that migration needs separate target-phone validation.
- Deployment must preserve the server's private overlay, registry and pairing identities, back up the preceding runtime, wait for Connector-owned tasks to idle, and verify public HTTPS plus authenticated WSS on both routes. Deployment evidence is local to the operator; the tag alone is not proof of deployment.

## Remaining limits

Metadata checks detect ordinary external file changes; they are not atomic filesystem snapshots and cannot protect against an attacker controlling the Connector OS. Cleanup serialization is process-local. Uploads remain temporary and downloads still assemble browser Blobs. Replay protection remains bounded and process-local. Automated browser checks do not prove physical-phone usability. The public release does not incorporate private ECS concurrency/deletion modifications.

The release also includes the previously verified Desktop approval recovery fix; see the [deployment guide](deployment.md#recovering-a-desktop-approval-wait-v043). The original [v0.4.2 review](code-review-2026-10-17.md) remains historical.
