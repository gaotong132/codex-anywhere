import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopState } from './desktop-state.js';
import { DesktopInputPipe } from './desktop-input-pipe.js';
import { NativeRequestError } from './desktop-native-pipe.js';

export type UserInput = { threadId: string; text: string; requestId: unknown; model?: string; thinking?: string; imagePath?: string };

export class DesktopUserInput {
  readonly pipe: DesktopInputPipe;
  readonly state: DesktopState;
  private readonly statePipe: DesktopInputPipe;
  private queues = new Map<string, Promise<unknown>>();
  private owners = new Map<string, Promise<{ id: string; settings: Record<string, any> }>>();

  constructor(private openThread: (threadId: string, timeoutMs?: number) => Promise<unknown>, private timeoutMs: number,
    pipe = new DesktopInputPipe(), statePipe = new DesktopInputPipe(pipe.path)) {
    this.pipe = pipe;
    // Large follower snapshots must never disconnect in-flight user input or
    // small owner/model requests. Both connections still use the same owner.
    this.statePipe = statePipe;
    this.state = new DesktopState(statePipe);
  }

  send(input: UserInput): Promise<void> {
    const snapshot = { ...input };
    const previous = this.queues.get(input.threadId) ?? Promise.resolve();
    const sending = previous.catch(() => {}).then(() => this.deliver(snapshot));
    this.queues.set(input.threadId, sending);
    void sending.finally(() => {
      if (this.queues.get(input.threadId) === sending) this.queues.delete(input.threadId);
    }).catch(() => {});
    return sending;
  }

  owner(threadId: string, open = true, timeoutMs = this.timeoutMs) {
    const key = JSON.stringify([threadId, open, timeoutMs]);
    const pending = this.owners.get(key);
    if (pending) return pending;
    const reading = this.readOwner(threadId, open, timeoutMs).finally(() => {
      if (this.owners.get(key) === reading) this.owners.delete(key);
    });
    this.owners.set(key, reading);
    return reading;
  }

  private async readOwner(threadId: string, open: boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => {
      if (Date.now() >= deadline) throw new Error('desktop_input_not_ready');
      return Math.max(1, deadline - Date.now());
    };
    let opened = false;
    while (true) {
      try {
        const owner = await this.pipe.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, remaining());
        const state = await this.pipe.request('thread-follower-read-model-settings', { conversationId: threadId }, remaining(), owner.handledByClientId);
        if (state.result?.settings?.resumeState === 'resumed') return { id: owner.handledByClientId as string, settings: state.result.settings };
      } catch (error) {
        if (!(error instanceof NativeRequestError) || error.code !== 'desktop_host_error' || !error.message.includes('no-client-found')) throw error;
      }
      // Only Desktop may resume/own the thread. Opening a cold thread can focus its window.
      if (!open) throw new Error('desktop_input_not_ready');
      if (!opened) { await this.openThread(threadId, remaining()); opened = true; }
      if (Date.now() >= deadline) throw new Error('desktop_input_not_ready');
      await delay(250);
    }
  }

  private async deliver({ threadId, text, requestId, model, thinking, imagePath }: UserInput) {
    let owner: Awaited<ReturnType<DesktopUserInput['owner']>>;
    try { owner = await this.owner(threadId); }
    catch (error) {
      if ((error as Error).message === 'desktop_request_too_large') throw error;
      throw classifyDesktopError(error, false);
    }
    if (model || thinking) {
      try {
        const settings = await this.pipe.request('thread-follower-update-thread-settings', {
          conversationId: threadId,
          threadSettings: { model: model || owner.settings.model, effort: thinking || owner.settings.reasoningEffort },
        }, this.timeoutMs, owner.id);
        if (settings.result?.applied !== true) throw new Error('settings not applied');
      } catch { throw new Error('desktop_input_settings_failed'); }
    }
    const id = createHash('sha256').update(JSON.stringify([threadId, String(requestId || randomUUID())])).digest('hex');
    const input: Record<string, any>[] = [{ type: 'text', text, text_elements: [] }];
    if (imagePath) input.push({ type: 'localImage', path: imagePath });
    const restoreMessage = { id, text, createdAt: Date.now(), context: {
      prompt: text, addedFiles: [], fileAttachments: [], imageAttachments: [], ideContext: null,
    } };
    let response;
    try {
      try {
        // The owner checks active state atomically before mutating. Trying steer
        // first avoids a stale read of Desktop's running/idle state.
        response = await this.pipe.request('thread-follower-steer-turn', {
          conversationId: threadId, input, restoreMessage, attachments: [], clientUserMessageId: id,
        }, this.timeoutMs, owner.id);
      } catch (error) {
        // Only this exact owner precondition proves no message was accepted.
        // No timeout, lost owner, generic host error or missing ack is retried.
        if (!(error instanceof NativeRequestError) || error.code !== 'desktop_host_error'
          || error.message !== `Cannot steer conversation ${threadId} because its active turn already ended`) throw error;
        response = await this.pipe.request('thread-follower-start-turn', {
          conversationId: threadId,
          turnStart: { request: { threadId, input, clientUserMessageId: id },
            // Use Desktop's current permission selection, rather than letting
            // its legacy fallback reuse the previous turn's permission profile.
            context: { inheritThreadSettings: true, usePermissionSelection: true, restoreMessage } },
        }, this.timeoutMs, owner.id);
      }
      // start returns {turn}; steer returns {turnId}. Both must acknowledge the owner operation.
      if (!response.result?.result?.turn?.id && !response.result?.result?.turnId) throw new NativeRequestError('desktop input invalid acknowledgement', true);
    } catch (error) {
      if ((error as Error).message === 'desktop_request_too_large') throw error;
      throw classifyDesktopError(error, true);
    }
  }

  close() { this.state.close(); this.statePipe.close(); this.pipe.close(); }
}

export function classifyDesktopError(error: unknown, mutation: boolean): Error {
  if (error instanceof NativeRequestError && error.code === 'desktop_host_error') {
    if (['request-version-mismatch', 'no-handler-for-request'].includes(error.message)) return new Error('desktop_input_unsupported');
    if (error.message === 'no-client-found') return new Error('desktop_input_not_ready');
  }
  if ((error as Error)?.message === 'desktop_input_not_ready') return error as Error;
  return new Error(mutation && error instanceof NativeRequestError && error.dispatched ? 'desktop_delivery_unknown' : 'desktop_input_unavailable');
}
