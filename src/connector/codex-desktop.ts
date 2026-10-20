import { DesktopUserInput } from './desktop-user-input.js';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { NativePipeClient, encodeNativeFrame } from './desktop-native-pipe.js';
import { normalizeSessionName } from '../shared/session-name.js';

// Desktop split app tools from browser control in newer builds. Prefer the
// dedicated host, but retain capability-checked discovery for older versions.
const PIPE_PREFIXES = ['codex-app-tools-', 'codex-browser-use-'];
const DEFAULT_TIMEOUT_MS = 15_000;
const STATUS_ENRICHMENT_TIMEOUT_MS = 1_000;
const TASK_SCOPED_TOOLS = new Set(['send_message_to_thread', 'set_thread_title', 'read_thread', 'set_thread_archived']);

type JsonObject = Record<string, any>;
type DesktopClientOptions = { timeoutMs?: number };
type DesktopMessage = {
  threadId: unknown;
  text: unknown;
  requestId: unknown;
  model?: unknown;
  thinking?: unknown;
};
export type DesktopThreadStatus = { id: string; status: string };
type ToolCall = { tool: string; arguments: JsonObject; callerThreadId: string; callId: string };
type DesktopHostError = Error & { code?: string };

export class CodexDesktopClient {
  timeoutMs: number;
  client: NativePipeClient | null;
  private discovery: Promise<NativePipeClient> | null = null;
  private generation = 0;
  readonly userInput: DesktopUserInput;

  constructor(options: DesktopClientOptions = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    this.client = null;
    this.userInput = new DesktopUserInput(threadId => this.openThread({ threadId }), this.timeoutMs);
  }

  async sendMessage({ threadId, text, requestId, model, thinking }: DesktopMessage) {
    const targetThreadId = requireThreadId(threadId);
    const prompt = String(text || '').trim();
    if (!prompt) throw new Error('message_required');
    await this.userInput.send({ threadId: targetThreadId, text: prompt, requestId,
      model: String(model || '').trim() || undefined,
      thinking: String(thinking || '').trim() || undefined,
    });
    return { threadId: targetThreadId, delivery: 'desktop' };
  }

  async renameThread({ threadId, name }: {
    threadId?: unknown;
    name?: unknown;
  }) {
    const targetThreadId = requireThreadId(threadId);
    const title = normalizeSessionName(name);
    let result: JsonObject;
    try {
      result = await this.callTool({
        tool: 'set_thread_title',
        arguments: { threadId: targetThreadId, title },
        callerThreadId: targetThreadId,
        callId: `bridge-rename-${randomUUID()}`,
      });
    } catch (error) {
      const desktopError = error as DesktopHostError;
      if (desktopError?.message === 'desktop_thread_identity_mismatch') throw error;
      if (desktopError?.message.startsWith('desktop_tool_unavailable:')) throw error;
      if (/timeout/i.test(String(desktopError?.message || error))) throw new Error('desktop_rename_timeout');
      if (desktopError?.code === 'desktop_host_error') {
        throw new Error(`desktop_rename_failed:${desktopError.message || 'unknown error'}`);
      }
      throw new Error('desktop_app_unavailable');
    }
    if (result?.success !== true) {
      const message = result?.contentItems?.map((item: JsonObject) => item?.text).filter(Boolean).join('\n');
      throw new Error(`desktop_rename_failed:${message || 'unknown error'}`);
    }
    return { threadId: targetThreadId, title };
  }

  async openThread({ threadId }: { threadId?: unknown }) {
    const targetThreadId = requireThreadId(threadId);
    const result = await this.callTool({
      tool: 'navigate_to_codex_page',
      arguments: { threadId: targetThreadId },
      callerThreadId: targetThreadId,
      callId: `bridge-open-${randomUUID()}`,
    });
    if (result?.success !== true) throw new Error('desktop_thread_open_failed');
    return { threadId: targetThreadId, opened: true };
  }

  async archiveThread({ threadId, cancelPendingApproval = false }: { threadId?: unknown; cancelPendingApproval?: boolean }) {
    const targetThreadId = requireThreadId(threadId);
    const state = await this.readThreadState({ threadId: targetThreadId });
    const confirmedWaiting = cancelPendingApproval === true && state.waitingOnApproval
      && ['active', 'running', 'inProgress', 'waiting'].includes(state.status);
    if (!confirmedWaiting && (state.waitingOnApproval || !['idle', 'completed', 'error', 'notLoaded'].includes(state.status))) {
      throw new Error('session_archive_not_idle');
    }
    const result = await this.callTool({
      tool: 'set_thread_archived',
      arguments: { threadId: targetThreadId, archived: true, source: 'codex' },
      callerThreadId: targetThreadId,
      callId: `bridge-archive-${randomUUID()}`,
    });
    if (result?.success !== true) throw new Error('desktop_thread_archive_failed');
    return { threadId: targetThreadId, archived: true };
  }

  async restoreThread({ threadId }: { threadId?: unknown }) {
    const targetThreadId = requireThreadId(threadId);
    const result = await this.callTool({
      tool: 'set_thread_archived',
      arguments: { threadId: targetThreadId, archived: false, source: 'codex' },
      callerThreadId: targetThreadId,
      callId: `bridge-restore-${randomUUID()}`,
    });
    if (result?.success !== true) throw new Error('desktop_thread_restore_failed');
    return { threadId: targetThreadId, archived: false };
  }

  async listThreads({ callerThreadId, limit = 50 }: { callerThreadId?: unknown; limit?: number } = {}) {
    const caller = String(callerThreadId || '').trim();
    if (!caller) return [];
    const result = await this.callTool({
      tool: 'list_threads',
      arguments: { limit: Math.min(50, Math.max(1, Number(limit) || 50)) },
      callerThreadId: caller,
      callId: `bridge-list-${randomUUID()}`,
    }, { timeoutMs: STATUS_ENRICHMENT_TIMEOUT_MS });
    if (result?.success !== true) throw new Error('desktop_thread_list_failed');
    const payload = parseToolPayload(result);
    const rows = [
      ...(Array.isArray(payload?.pinnedThreads) ? payload.pinnedThreads : []),
      ...(Array.isArray(payload?.threads) ? payload.threads : []),
    ];
    return rows.filter((thread: JsonObject) => thread?.kind === 'codex' && thread?.id).map((thread: JsonObject) => ({
      id: String(thread.id),
      status: String(thread.status || 'unknown'),
    }));
  }

  async readThreadState({ threadId }: { threadId?: unknown }) {
    const targetThreadId = requireThreadId(threadId);
    const result = await this.callTool({
      tool: 'read_thread',
      arguments: {
        threadId: targetThreadId,
        turnLimit: 1,
        includeOutputs: false,
        maxOutputCharsPerItem: 1_000,
      },
      callerThreadId: targetThreadId,
      callId: `bridge-read-state-${randomUUID()}`,
    });
    if (result?.success !== true) throw new Error('desktop_thread_read_failed');
    const payload = parseToolPayload(result);
    const status = payload?.thread?.status;
    const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.map(String) : [];
    return {
      status: String(status?.type || status || 'unknown'),
      waitingOnApproval: activeFlags.includes('waitingOnApproval'),
    };
  }

  async callTool(
    { tool, arguments: toolArguments, callerThreadId, callId }: ToolCall,
    options: { timeoutMs?: number } = {},
  ): Promise<JsonObject> {
    // Snapshot before the asynchronous pipe lookup, so the validated target
    // cannot be replaced while a connection is being established.
    const argumentsSnapshot = { ...toolArguments };
    // A bridge request is never an inter-task delegation. Fail before opening
    // the Desktop pipe if a task-scoped call tries to borrow another identity.
    if (TASK_SCOPED_TOOLS.has(tool) || Object.hasOwn(argumentsSnapshot, 'threadId')) {
      const target = requireThreadId(argumentsSnapshot.threadId);
      if (target !== argumentsSnapshot.threadId || target !== callerThreadId) {
        throw new Error('desktop_thread_identity_mismatch');
      }
    }
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(250, Number(options.timeoutMs)) : this.timeoutMs;
    const client = await this.getClient(timeoutMs);
    if (!client.tools.has(tool)) throw new Error(`desktop_tool_unavailable:${tool}`);
    return client.request('tools/call', {
      arguments: argumentsSnapshot,
      // Newer Desktop hosts require the caller's backing kind. This bridge
      // only delivers to Codex tasks, so never take it from browser input.
      callerSource: 'codex',
      callId,
      namespace: 'codex_app',
      threadId: callerThreadId,
      tool,
      turnId: callId,
    }, timeoutMs);
  }

  async getClient(timeoutMs = this.timeoutMs): Promise<NativePipeClient> {
    if (this.client?.connected) return this.client;
    if (this.discovery) return this.discovery;
    const generation = this.generation;
    const discovery = this.discoverClient(timeoutMs).then(client => {
      if (generation !== this.generation) {
        client?.close();
        throw new Error('desktop_app_unavailable');
      }
      if (!client) throw new Error('desktop_app_unavailable');
      this.client?.close();
      this.client = client;
      return client;
    }).finally(() => {
      if (this.discovery === discovery) this.discovery = null;
    });
    this.discovery = discovery;
    return discovery;
  }

  async discoverClient(timeoutMs: number): Promise<NativePipeClient | null> {
    if (process.platform !== 'win32') throw new Error('desktop_app_unavailable');
    let names;
    try { names = await readdir('\\\\.\\pipe\\'); }
    catch { throw new Error('desktop_app_unavailable'); }
    return discoverDesktopClient(names, name => probePipe(
      `\\\\.\\pipe\\${name}`, Math.min(timeoutMs, 5_000),
    ));
  }

  async getCapabilities() {
    const [appTools, input] = await Promise.allSettled([
      this.getClient(STATUS_ENRICHMENT_TIMEOUT_MS),
      this.userInput.pipe.connect(STATUS_ENRICHMENT_TIMEOUT_MS),
    ]);
    return {
      available: appTools.status === 'fulfilled',
      tools: appTools.status === 'fulfilled' ? [...appTools.value.tools] : [],
      inputAvailable: input.status === 'fulfilled',
    };
  }

  close() {
    this.userInput.close();
    this.generation++;
    this.discovery = null;
    this.client?.close();
    this.client = null;
  }
}

async function discoverDesktopClient<T extends { close(): void }>(
  names: string[], probe: (name: string) => Promise<T | null>,
): Promise<T | null> {
  for (const prefix of PIPE_PREFIXES) {
    const candidates = await Promise.all(names.filter(name => name.startsWith(prefix)).map(probe));
    const client = candidates.find(Boolean);
    for (const candidate of candidates) {
      if (candidate && candidate !== client) candidate.close();
    }
    if (client) return client;
  }
  return null;
}

function requireThreadId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('thread_id_required');
  const id = value.trim();
  if (!id || id.length > 256 || /[\0\r\n]/.test(id)) throw new Error('thread_id_required');
  return id;
}

async function probePipe(pipePath: string, timeoutMs: number): Promise<NativePipeClient | null> {
  const client = new NativePipeClient(pipePath);
  try {
    const result = await client.request('tools/list', { threadStartKind: 'all' }, timeoutMs);
    client.tools = new Set((Array.isArray(result?.tools) ? result.tools : [])
      .filter((tool: JsonObject) => tool.namespace === 'codex_app' && typeof tool.name === 'string')
      .map((tool: JsonObject) => tool.name));
    if (!client.tools.has('send_message_to_thread')) {
      client.close();
      return null;
    }
    return client;
  } catch {
    client.close();
    return null;
  }
}

function parseToolPayload(result: JsonObject): JsonObject {
  for (const candidate of [result?.structuredContent, result?.data, result?.output]) {
    if (candidate && typeof candidate === 'object') return candidate;
  }
  for (const item of Array.isArray(result?.contentItems) ? result.contentItems : []) {
    if (item?.json && typeof item.json === 'object') return item.json;
    if (typeof item?.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try the next content item */ }
  }
  throw new Error('desktop_thread_list_invalid');
}

export function mergeDesktopSessionStatuses<T extends { id: string; status?: string }>(
  sessions: T[], desktopThreads: DesktopThreadStatus[], locallyActiveThreadId = '',
) {
  const statuses = new Map((desktopThreads || []).map((thread) => [thread.id, thread.status]));
  return (sessions || []).map((session) => {
    if (session.id === locallyActiveThreadId) return { ...session, status: 'active' };
    return statuses.has(session.id)
      ? { ...session, status: statuses.get(session.id) }
      : session;
  });
}

export const internals = { encodeNativeFrame, parseToolPayload, discoverDesktopClient, probePipe };
