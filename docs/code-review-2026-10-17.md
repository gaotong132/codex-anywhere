# Code review — 2026-10-17

English | [简体中文](code-review-2026-10-17.zh-CN.md)

This pass revisited Web session configuration, lists and replay, Connector upload/download/preview lifecycles, browser consent, and existing reconnect, identity-isolation and encrypted-channel regressions. It covers critical paths, not proof that every line or deployment is defect-free. See the [previous review](code-review-2026-10-16.md) for bounded file reads and replay-cache refactoring.

## Findings and changes

| Area | Evidence and treatment |
| --- | --- |
| Mutable replay data | Editing nested input and threadId after dispatch changed the replay. The old regression fails; structuredClone now snapshots request data before sending. |
| Accumulating permission icons | Adjacent React controls shared a key. Distinct prefixes fixed it; previous public desktop/narrow-screen validation kept one control across 20 switches. |
| Flaky rewrite check | Fast same-size writes may retain filesystem timestamps. Tests now advance time explicitly, without claiming atomic snapshots. |
| PC session organization | The user chose recoverable archiving. Use native set_thread_archived, validate idle status, identity, confirmation and response; revoke that session's browser grants and invalidate pre-archive list reads. No permanent delete API is added. |

## Refactoring decisions

Isolate the archive confirmation component and reuse the native client, dispatch, replay cache and styles. A wholesale rewrite of App or history projection lacks evidence of sufficient benefit relative to regression risk. No new production dependency or protocol change is required. Private server concurrency/deletion changes are preserved separately and are not part of this public release.

## Validation and limits

- Archive regressions cover task identity, active/unknown-state rejection, confirmation, capability discovery, reconnect deduplication and scoped consent removal. A temporary native Desktop session verifies archive and restore, with persisted-state verification; business sessions remain untouched.
- Release checks cover types, main and compiled extension tests, production builds, and bilingual links, anchors and version metadata. The official npm registry audit reports two low-severity entries and no moderate, high or critical entries. The KaTeX/Mermaid major migration remains separate.
- Only a capable PC Connector exposes archiving. Web has no restore list; use Codex Desktop. An external client may start after the status check; native ownership conflicts fail without deletion or forced takeover.
- Existing limits remain: history/image sources must exist, temporary uploads expire, downloads assemble browser Blobs, replay is not durable exactly-once processing, and automated browser checks do not prove physical-phone usability.
