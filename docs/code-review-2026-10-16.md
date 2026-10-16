# Code review — 2026-10-16

English | [简体中文](code-review-2026-10-16.zh-CN.md)

Reviewed Web history/request/image lifecycles, Connector file handling and replay state, Relay authentication/encrypted routing, extension connection/page grants, dependency audit and release documentation. This records concrete evidence, not a claim that every deployment or website is defect-free.

## Confirmed issues

| Issue | Evidence and correction |
| --- | --- |
| Pending mutations could leave the replay cache | Held a `turn.start`, completed 70 other mutations, then reconnected/replayed its ID: the old handler ran twice. `RequestReplayCache` keeps pending work separate from the completed LRU, bounds pending entries and starts TTL at settlement. The regression now runs once. |
| Concurrent opens bypassed the one-download-per-client rule | Eight simultaneous opens previously created eight capabilities. A reservation before the first await permits one; other clients remain independent. |
| Shutdown could be followed by a late capability | Starting an open immediately before `closeAll` previously succeeded after shutdown. The manager now rejects pending/new opens and closes their handles. |
| Expiry pruning closed an active read | Advancing the test clock while another client's read was busy previously removed its capability. Pruning now skips busy reads. |
| Last-chunk mutation could still report success | Rewriting a file during its final read previously returned completion. A post-read snapshot check now revokes the capability and reports change. |
| Some previews used an unbounded read after a size check | Image and visualization readers could follow growth past the checked size. `bounded-file.ts` allocates only that size, handles short reads and checks metadata again; tests cover growth, shrinkage and same-size rewrites. |
| Image cache missed file replacement | Replacing an image with another of equal size and preserved mtime could return old pixels. Cache identity now includes device/inode and ctime; a real PNG replacement regression verifies the preview changes. |
| Release metadata and guides lagged behind tags | Current guides/package still said 0.3.0 while v0.4.0 existed. Versions are aligned at 0.4.1, v0.4.0 history is restored in the changelog, and `check:docs` prevents metadata/link drift. |

## Refactoring decisions

Extracted two focused modules: `bounded-file.ts` owns byte limits, snapshots and strict text decoding; `request-replay.ts` owns pending/completed mutation state. Callers keep their path, identity and permission checks. No wire-protocol or stored-identity migration was needed.

Kept App orchestration, Codex history projection, Relay routing and extension authorization intact. They remain substantial modules; splitting them without a demonstrated ownership boundary would add churn. Existing lifecycle, security and extension regressions are part of the release checks. No new production dependency was introduced.

## Validation and retained limits

- All four type checks and 451 main tests passed, including the failing-before/passing-after download and encrypted replay scenarios. Release checks also run the compiled extension suite, production builds and documentation validation.
- The npm registry audit reported two low-severity dependency entries (KaTeX and its Mermaid parent), with zero moderate/high/critical entries. Mermaid 12 remains a separate browser-compatibility migration.
- Preview byte bounds do not impose a total process-memory budget for many simultaneous requests. Downloads still create a browser Blob. Pending mutation protection remains process-local, and completed-result LRU/TTL limits are explicit.
- Filesystem metadata catches ordinary concurrent modification; it is not a transactional snapshot. Trusted local users can still change files and the host OS remains part of the trust boundary.
- Existing chronological reports retain their original counts and acceptance scope. Browser checks do not establish physical-phone performance or compatibility with every third-party page.
