# v0.4.4 code review — 2026-10-18

English | [简体中文](code-review-0.4.4.zh-CN.md)

## Scope and decisions

Reviewed environment/session transitions, attachment preparation and transfer, request replay, encrypted channel lifetime, history merging, download resume, approval/browser polling, HTTP boundaries and release checks. Existing tests cover protocol, authentication, file access and extension consent. This is a risk-based review, not proof that every line or device is defect-free.

Keep the Relay/Connector/Web split and protocol 4. Extract two focused units: a reusable environment switcher shared with the documentation preview, and an attachment draft hook that owns preparation invalidation and preview cleanup. A broad rewrite of App or the Codex adapter would add risk without evidence of a corresponding benefit.

## Findings and changes

| Finding | Change and evidence |
| --- | --- |
| Selecting an environment closes the mobile drawer; automatic session restoration closes it again. | Direct buttons for up to two routes, a stable PC-first order, separate selected/online states, and explicit control of drawer closure. Real authenticated PC/ECS history reads verify remembered sessions and an open drawer at 320/390 px; choosing a session closes it. More routes retain the selector. |
| Two image preparations can finish out of order and overwrite the latest selection. Removing an attachment does not invalidate work already running. | A generation guard accepts only the latest result/error. Replacement and removal invalidate pending work; unused preview URLs are revoked. Deferred-promise regressions deliberately reverse completion order. |
| New-session preparation can finish after closing the dialog or changing environments. | All close paths invalidate preparation and clear the attachment. Environment changes clear both attachment drafts; session changes invalidate pending composer preparation. Context guards reject obsolete results/errors. |

## Validation and limits

- Four TypeScript targets, 477 main tests, the 100-test compiled extension suite, production builds and bilingual documentation checks form the release gate.
- Mobile browser emulation checks direct switching, remembered sessions, drawer behavior, viewport overflow and touch-target dimensions against real authenticated routes. It does not establish physical-phone performance or usability.
- npm's official audit reports two low-severity entries in the KaTeX/Mermaid chain, with no moderate/high/critical entries. Keep Mermaid 11 pending separate validation of Mermaid 12's browser requirements and rendering changes. No dependency changes are made in this release.
- Preview cleanup is explicit, but already-started browser image decoding is not forcibly aborted. File transfer remains temporary and browser downloads assemble Blobs. Existing replay/file snapshot limits still apply; see the [previous review](code-review-0.4.3.md).
- Deployment must back up and preserve the private ECS source overlay, identities and registry, check active tasks, validate public HTTPS and authenticated WSS, and retain the previous image. Private concurrency/deletion features are not included in the public tag.
