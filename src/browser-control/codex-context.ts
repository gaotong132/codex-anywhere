import { BrowserControlError, parseBrowserOwner, parseSnapshotOptions, requireBrowserId, requireRecord } from './contracts.js';

// Adapter seam only: production app-server does not enable these tools yet.
// Read identity from the private app-server envelope; NEVER from arguments or
// a "most recent"/global task. The host must also own this exact active turn.
export function parseCodexBrowserSnapshotCall(value: unknown, host: {
  environmentId: string;
  controllerId: string;
  threadId: string;
  turnId: string;
}) {
  const params = requireRecord(value, ['threadId', 'turnId', 'callId', 'namespace', 'tool', 'arguments']);
  if (params.threadId !== requireBrowserId(host.threadId) || params.turnId !== requireBrowserId(host.turnId)) {
    throw new BrowserControlError('browser_task_mismatch');
  }
  if (params.tool !== 'anywhere_browser_snapshot' || params.namespace != null) {
    throw new BrowserControlError('browser_method_not_supported');
  }
  return {
    owner: parseBrowserOwner({
      environmentId: host.environmentId, controllerId: host.controllerId, threadId: params.threadId,
    }),
    turnId: requireBrowserId(params.turnId),
    callId: requireBrowserId(params.callId),
    options: parseSnapshotOptions(params.arguments),
  };
}
