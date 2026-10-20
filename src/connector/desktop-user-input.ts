import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopInputPipe } from './desktop-input-pipe.js';
import { NativeRequestError } from './desktop-native-pipe.js';

export type UserInput = { threadId: string; text: string; requestId: unknown; model?: string; thinking?: string };

export class DesktopUserInput {
  readonly pipe: DesktopInputPipe;
  private queues = new Map<string, Promise<unknown>>();

  constructor(private openThread: (threadId: string) => Promise<unknown>, private timeoutMs: number,
    pipe = new DesktopInputPipe()) { this.pipe = pipe; }

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

  private async owner(threadId: string) {
    const deadline = Date.now() + this.timeoutMs;
    let opened = false;
    while (true) {
      try {
        const owner = await this.pipe.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, this.timeoutMs);
        const state = await this.pipe.request('thread-follower-read-model-settings', { conversationId: threadId }, this.timeoutMs, owner.handledByClientId);
        if (state.result?.settings?.resumeState === 'resumed') return { id: owner.handledByClientId as string, settings: state.result.settings };
      } catch (error) {
        if (!(error instanceof NativeRequestError) || error.code !== 'desktop_host_error' || !error.message.includes('no-client-found')) throw error;
      }
      // Only Desktop may resume/own the thread. Opening a cold thread can focus its window.
      if (!opened) { await this.openThread(threadId); opened = true; }
      if (Date.now() >= deadline) throw new Error('desktop_input_not_ready');
      await delay(250);
    }
  }

  private async deliver({ threadId, text, requestId, model, thinking }: UserInput) {
    let owner: Awaited<ReturnType<DesktopUserInput['owner']>>;
    try { owner = await this.owner(threadId); }
    catch (error) {
      if ((error as Error).message === 'desktop_request_too_large') throw error;
      throw new Error('desktop_input_unavailable');
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
    const input = [{ type: 'text', text, text_elements: [] }];
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
            context: { inheritThreadSettings: true, restoreMessage } },
        }, this.timeoutMs, owner.id);
      }
      // start returns {turn}; steer returns {turnId}. Both must acknowledge the owner operation.
      if (!response.result?.result?.turn?.id && !response.result?.result?.turnId) throw new NativeRequestError('desktop input invalid acknowledgement', true);
    } catch (error) {
      if ((error as Error).message === 'desktop_request_too_large') throw error;
      if (error instanceof NativeRequestError && error.dispatched) throw new Error('desktop_delivery_unknown');
      throw new Error('desktop_input_unavailable');
    }
  }

  close() { this.pipe.close(); }
}
