# Production source reconciliation — 2026-10-21

## Scope

The ECS checkout based on `16c4c99` contained 35 modified tracked files and seven untracked files. Six untracked files were implementation/tests; the seventh was a machine-local `AGENTS.md`. The entire overlay was backed up outside the checkout before review. Machine credentials, device identities, project workspaces and conversation history are outside this source reconciliation.

## Features reviewed

- Headless concurrency: per-thread reservations, out-of-order start responses, early events, approval routing, cancellation, runtime exit, per-thread unsubscribe and reconnect ownership. One session still has at most one active turn.
- Headless deletion: explicit confirmation, allowed workspace checks, native thread deletion, racing start/delete exclusion and session-scoped cache/browser-grant cleanup. Project files are not deleted.
- Recovery: old resume events cannot select the new turn ID; queued output and approvals are matched to the acknowledged turn. Browser ownership snapshots cannot overwrite newer execution events.
- Linked raster images: previews are fetched only on demand, original downloads remain separate, and the generated-image fallback is limited to an explicit local-root rejection. Canonical root and image-content validation remain enforced.
- UI and documentation: controls follow the selected session, deletion has a confirmation dialog, and feature descriptions are moved to Unreleased. Formatting-only source movement was discarded.

## Additional corrections

- Reject deletion when native session status is unknown, instead of assuming it is idle.
- Keep Desktop connector first turns serialized and wait for writer release before reserving the next task. Independent headless tasks remain concurrent; existing native Desktop tasks keep their own execution path.
- Propagate writer-release failures to operations that must confirm release; background completion still records failures without an unhandled rejection.
- Bound pre-start event buffering to 512 messages, cancel overflowed starts and decline their approval requests.
- Ignore delayed delivery responses after switching devices, and do not reset the newly selected session's execution controls when another Desktop delivery completes.

- Preserve the restored session when its synchronous selection and the initial list render happen in the same React commit; the default selection must check the current selection ref. A bounded, eventually consistent list is not proof that a saved session no longer exists; remove that fallback and let the targeted history request determine availability. This needs no extra requests or polling.

## Deployment invariant

Source must match a committed revision before building and remain Git-clean after activation. Keep machine-only instructions in `.git/info/exclude`, secrets in ignored or external configuration, and snapshots outside the checkout. Do not preserve uncommitted feature overlays across future deployments. Verify the deployed commit, container image, public health and both connector routes; preserve a previous runtime for rollback.
