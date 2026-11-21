import { DesktopControls } from './desktop-controls.js';
import { DesktopUserInput } from './desktop-user-input.js';
import { readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { NativePipeClient, NativeRequestError, encodeNativeFrame } from './desktop-native-pipe.js';
import { classifyDesktopError } from './desktop-user-input.js';
import { normalizeSessionName } from '../shared/session-name.js';
import type { SessionProject } from '../shared/session-status.js';

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
  imagePath?: string;
};
export type DesktopThreadStatus = { id: string; status: string; project?: SessionProject };
type ToolCall = { tool: string; arguments: JsonObject; callerThreadId: string; callId: string };
type DesktopHostError = Error & { code?: string };

export class CodexDesktopClient {
  timeoutMs: number;
  client: NativePipeClient | null;
  private discovery: Promise<NativePipeClient> | null = null;
  private generation = 0;
  private messageQueues = new Map<string, Promise<unknown>>();
  readonly userInput: DesktopUserInput;
  readonly controls: DesktopControls;

  constructor(options: DesktopClientOptions = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    this.client = null;
    this.userInput = new DesktopUserInput((threadId, timeoutMs) => this.openThread({ threadId }, timeoutMs), this.timeoutMs);
    this.controls = new DesktopControls(this.userInput, {
      available: () => this.legacyInputAvailable(),
      read: async threadId => ({ ...await this.readThreadState({ threadId }), threadId,
        turnId: null, canStop: false, approvals: [], model: '', reasoningEffort: '', serviceTier: '' }),
    });
  }

  async sendMessage({ threadId, text, requestId, model, thinking, imagePath }: DesktopMessage) {
    const targetThreadId = requireThreadId(threadId);
    const prompt = String(text || '').trim();
    if (!prompt) throw new Error('message_required');
    const input = { threadId: targetThreadId, text: prompt, requestId, ...(imagePath ? { imagePath } : {}),
      model: String(model || '').trim() || undefined, thinking: String(thinking || '').trim() || undefined };
    const previous = this.messageQueues.get(targetThreadId) ?? Promise.resolve();
    const sending = previous.catch(() => {}).then(() => this.deliverMessage(input));
    this.messageQueues.set(targetThreadId, sending);
    try { await sending; }
    finally { if (this.messageQueues.get(targetThreadId) === sending) this.messageQueues.delete(targetThreadId); }
    return { threadId: targetThreadId, delivery: 'desktop' };
  }

  async legacyInputAvailable() {
    try { await this.userInput.pipe.connect(STATUS_ENRICHMENT_TIMEOUT_MS); return true; }
    catch (error) {
      // Only an absent endpoint selects another transport, before any input is
      // dispatched. An existing owner's protocol/transport failures are final.
      if (error instanceof NativeRequestError && !error.dispatched && /^connect (ENOENT|ECONNREFUSED)\b/.test(error.message)) return false;
      throw error;
    }
  }

  private async deliverMessage(input: Parameters<DesktopUserInput['send']>[0]) {
    if (await this.legacyInputAvailable()) return this.userInput.send(input);
    const client = await this.getClient();
    if (!supportsAppToolsInput(client)) throw new Error('desktop_input_unsupported');
    if (input.imagePath) throw new Error('desktop_image_unsupported');
    const fields = client.toolDefinitions.get('send_message_to_thread')!.inputSchema.properties;
    if ((input.model && !fields.model) || (input.thinking && !fields.thinking)) throw new Error('desktop_input_settings_failed');
    const id = createHash('sha256').update(JSON.stringify([input.threadId, String(input.requestId || randomUUID())])).digest('hex');
    try {
      const result = await this.callTool({ tool: 'send_message_to_thread',
        arguments: { threadId: input.threadId, prompt: input.text,
          ...(fields.hostId ? { hostId: 'local' } : {}),
          ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) },
        callerThreadId: input.threadId, callId: `bridge-input-${id}`,
      });
      let acknowledgedThread: unknown;
      try { acknowledgedThread = parseToolPayload(result)?.threadId; } catch { /* malformed acknowledgements are uncertain */ }
      if (result?.success !== true || acknowledgedThread !== input.threadId) {
        throw new NativeRequestError('desktop input invalid acknowledgement', true);
      }
    } catch (error) {
      if ((error as Error).message === 'desktop_thread_identity_mismatch'
        || (error as Error).message.startsWith('desktop_tool_unavailable:')) throw error;
      throw classifyDesktopError(error, true);
    }
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

  async openThread({ threadId }: { threadId?: unknown }, timeoutMs = this.timeoutMs) {
    const targetThreadId = requireThreadId(threadId);
    const result = await this.callTool({
      tool: 'navigate_to_codex_page',
      arguments: { threadId: targetThreadId },
      callerThreadId: targetThreadId,
      callId: `bridge-open-${randomUUID()}`,
    }, { timeoutMs });
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
    // Background enrichment must tolerate a cold Desktop list without delaying
    // the session response. Capability probes still use the shorter deadline.
    const [threadResult, projectResult] = await Promise.allSettled([this.callTool({
      tool: 'list_threads',
      arguments: { mode: 'history', source: 'codex', hostId: 'local',
        limit: Math.min(50, Math.max(1, Number(limit) || 50)) },
      callerThreadId: caller,
      callId: `bridge-list-${randomUUID()}`,
    }, { timeoutMs: DEFAULT_TIMEOUT_MS }), this.callTool({
      tool: 'list_projects', arguments: {}, callerThreadId: caller, callId: `bridge-projects-${randomUUID()}`,
    }, { timeoutMs: STATUS_ENRICHMENT_TIMEOUT_MS })]);
    if (threadResult.status === 'rejected') throw threadResult.reason;
    const result = threadResult.value;
    if (result?.success !== true) throw new Error('desktop_thread_list_failed');
    const payload = parseToolPayload(result);
    const rows = [
      ...(Array.isArray(payload?.pinnedThreads) ? payload.pinnedThreads : []),
      ...(Array.isArray(payload?.threads) ? payload.threads : []),
    ];
    let projects: JsonObject[] = [];
    if (projectResult.status === 'fulfilled' && projectResult.value?.success === true) {
      try { projects = parseToolPayload(projectResult.value).projects || []; }
      catch { /* Missing project metadata does not block the session list or statuses. */ }
    }
    const projectNames = new Map((Array.isArray(projects) ? projects : [])
      .filter(project => project?.projectKind === 'local' && project.hostId === 'local'
        && typeof project.projectId === 'string' && typeof project.label === 'string' && project.label.trim())
      .map(project => [project.projectId, project.label.trim()]));
    return rows.filter((thread: JsonObject) => thread?.kind === 'codex' && thread?.id
      && (thread.hostId === 'local' || thread.hostId === undefined)).map((thread: JsonObject) => {
      let project: SessionProject = { status: 'unavailable' };
      if (thread.hostId === 'local' && thread.projectId === null) project = { status: 'unassigned' };
      else if (thread.hostId === 'local' && typeof thread.projectId === 'string' && projectNames.has(thread.projectId)) {
        project = { status: 'assigned', id: thread.projectId, name: projectNames.get(thread.projectId)! };
      }
      return { id: String(thread.id), status: String(thread.status || 'unknown'), project };
    });
  }

  async readThreadState({ threadId }: { threadId?: unknown }) {
    const targetThreadId = requireThreadId(threadId);
    const client = await this.getClient();
    const metadataOnly = client.toolDefinitions?.get('read_thread')?.inputSchema?.properties?.includeTurns?.type === 'boolean';
    const result = await this.callTool({
      tool: 'read_thread',
      arguments: {
        threadId: targetThreadId,
        turnLimit: 1,
        includeOutputs: false,
        maxOutputCharsPerItem: 1_000,
        ...(metadataOnly ? { includeTurns: false } : {}),
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
      this.legacyInputAvailable(),
    ]);
    return {
      available: appTools.status === 'fulfilled',
      tools: appTools.status === 'fulfilled' ? [...appTools.value.tools] : [],
      inputAvailable: input.status === 'fulfilled' && (input.value || (appTools.status === 'fulfilled' && supportsAppToolsInput(appTools.value))),
      controlsAvailable: input.status === 'fulfilled' && input.value,
      imagesAvailable: input.status === 'fulfilled' && input.value,
      inputTransport: input.status === 'fulfilled' && input.value ? 'owner'
        : input.status === 'fulfilled' && appTools.status === 'fulfilled' && supportsAppToolsInput(appTools.value) ? 'appTools' : 'unavailable',
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
    client.toolDefinitions = new Map((Array.isArray(result?.tools) ? result.tools : [])
      .filter((tool: JsonObject) => tool.namespace === 'codex_app' && typeof tool.name === 'string')
      .map((tool: JsonObject) => [tool.name, tool]));
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

export function supportsAppToolsInput(client: Pick<NativePipeClient, 'tools' | 'toolDefinitions'>) {
  if (!client.tools.has('send_message_to_thread')) return false;
  const schema = client.toolDefinitions?.get('send_message_to_thread')?.inputSchema;
  if (schema?.type !== 'object' || schema.properties?.threadId?.type !== 'string'
    || schema.properties?.prompt?.type !== 'string' || !Array.isArray(schema.required)
    || !schema.required.includes('threadId') || !schema.required.includes('prompt')) return false;
  if (!['hostId', 'model', 'thinking'].every(key => !schema.properties[key] || schema.properties[key].type === 'string')) return false;
  return schema.required.every((key: unknown) => ['threadId', 'prompt'].includes(String(key)));
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

export function mergeDesktopSessionStatuses<T extends { id: string; status?: string; project?: SessionProject }>(
  sessions: T[], desktopThreads: DesktopThreadStatus[], locallyActiveThreadIds: string | Iterable<string> = [],
) {
  const rows = new Map((desktopThreads || []).map((thread) => [thread.id, thread]));
  const active = new Set(typeof locallyActiveThreadIds === 'string' ? [locallyActiveThreadIds] : locallyActiveThreadIds);
  return (sessions || []).map((session) => {
    const desktop = rows.get(session.id);
    const status = active.has(session.id) ? 'active' : desktop?.status;
    if (!status && !desktop?.project) return session;
    return { ...session, ...(status ? { status } : {}), ...(desktop?.project ? { project: desktop.project } : {}) };
  });
}

export const internals = { encodeNativeFrame, parseToolPayload, discoverDesktopClient, probePipe };
