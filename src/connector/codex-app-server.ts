import { editIdentifier, editText, editToken, messageEditInput } from './message-edit.js';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { CompactionProgressReader } from './compaction-progress.js';
import {
  readRolloutContextUsage,
  readRolloutGeneratedImages,
  readRolloutQuestionReplies,
  readRolloutModelSettings,
  readRolloutPermissionMode,
  readRolloutPermissionSnapshot,
  readRolloutTail,
  type RolloutModelSettings,
} from './rollout-tail.js';
import { needsDesktopPermissionRecovery } from './session-permissions.js';
import { resolveCodexExecutable } from './codex-executable.js';
import { summarizePlanSteps, summarizeUnifiedDiff } from '../shared/turn-progress.js';
import { publicError } from '../shared/protocol.js';
import {
  normalizePermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../shared/permission-mode.js';
import { normalizeSessionName } from '../shared/session-name.js';
import { parseInjectedUserMessage } from '../shared/message-content.js';
import { asyncQuestionsFromItem } from '../shared/async-questions.js';
import {
  extractText,
  isReasoningMethod,
  mapTurns,
  summarizeItem,
} from './app-server-history.js';
import {
  approvalDecisionSummary,
  approvalKind,
  isMcpToolApproval,
  approvalResult,
  approvalSummary,
  approvedPermissions,
  permissionSettings,
  type PendingApproval,
} from './app-server-permissions.js';
import { isAllowedWorkspace, resolveAllowedWorkspace } from './workspace-policy.js';
import {
  createTurnDiffDocument,
  readRolloutTurnDiff,
  type TurnDiffDocument,
} from './turn-diffs.js';
import { loadSessionModelSettings, saveSessionModelSettings } from './session-model-settings.js';

const RPC_TIMEOUT_MS = 20_000;
const SUMMARY_LIMIT = 4_000;
const DEFAULT_HISTORY_PAGE_SIZE = 6;
const MAX_HISTORY_PAGE_SIZE = 10;
const MAX_LIVE_PAGE_SIZE = 2;
const LARGE_ROLLOUT_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_TURN_DIFFS = 12;
const PACKAGE_VERSION = String((JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version?: unknown }).version || '0.0.0');

type JsonObject = Record<string, any>;
type CodexAppServerOptions = {
  releaseRuntimeAfterTurn?: boolean;
  bin?: string;
  runtimeCwd?: string;
  allowedRoots?: string[];
  networkAccess?: boolean;
  allowFullAccess?: boolean;
  modelSettingsPath?: string;
};
type PendingRpc = {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};
type SessionMetadata = { cwd: string; path: string; canAcceptDirectInput: boolean };
type ModelOption = {
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
  isDefault: boolean;
};
type SessionModelConfig = RolloutModelSettings & { fastMode: boolean; models: ModelOption[] };
type TurnContext = {
  compaction?: { itemId: string; startedAt: number };
  clientId?: string;
  requestId?: string;
  threadId: string;
  turnId: string;
  cwd: string;
  state: string;
  cancelRequested?: boolean;
  startMessages?: JsonObject[];
};
type StartTurnOptions = {
  text?: unknown;
  threadId?: unknown;
  cwd?: unknown;
  clientId?: string;
  requestId?: string;
  permissionMode?: unknown;
  edit?: { turnId: string; token: string; confirm: boolean };
};

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);

export class CodexAppServer extends EventEmitter {
  bin: string;
  runtimeCwd: string;
  allowedRoots: string[];
  networkAccess: boolean;
  allowFullAccess: boolean;
  child: ChildProcessWithoutNullStreams | null;
  readyPromise: Promise<void> | null;
  nextId: number;
  pending: Map<number, PendingRpc>;
  approvals: Map<string, PendingApproval>;
  activeTurns = new Map<string | symbol, TurnContext>();
  private deletingThreads = new Set<string>();
  private threadReleases = new Map<string, Promise<void>>();
  private threadRelease: Promise<void>;
  private runtimeRelease: Promise<void> | null = null;
  private compactionProgress = new CompactionProgressReader();
  private inflightRpcs = new Set<Promise<unknown>>();
  private releaseRuntimeAfterTurn: boolean;
  sessionMetadata: Map<string, SessionMetadata>;
  sessionModelSettings: Map<string, RolloutModelSettings>;
  private modelSettingsPath: string | null;
  sessionPermissionModes: Map<string, PermissionMode>;
  modelCatalogCache: { expiresAt: number; models: ModelOption[] } | null;
  private modelCatalogRead: Promise<ModelOption[]> | null = null;
  private sessionListReads = new Map<string, Promise<any[]>>();
  turnDiffs: Map<string, TurnDiffDocument>;

  constructor(options: CodexAppServerOptions = {}) {
    super();
    this.bin = options.bin || 'codex';
    this.runtimeCwd = resolve(options.runtimeCwd || process.cwd());
    const configuredRoots = Array.isArray(options.allowedRoots)
      ? options.allowedRoots.map((root) => String(root).trim()).filter(Boolean).map((root) => resolve(root))
      : [];
    this.allowedRoots = configuredRoots.length ? configuredRoots : [this.runtimeCwd];
    this.networkAccess = options.networkAccess === true;
    this.allowFullAccess = options.allowFullAccess === true;
    this.child = null;
    this.readyPromise = null;
    this.nextId = 0;
    this.pending = new Map();
    this.approvals = new Map();
    this.threadRelease = Promise.resolve();
    this.releaseRuntimeAfterTurn = options.releaseRuntimeAfterTurn === true;
    this.sessionMetadata = new Map();
    this.modelSettingsPath = options.modelSettingsPath ? resolve(options.modelSettingsPath) : null;
    this.sessionModelSettings = loadSessionModelSettings(this.modelSettingsPath);
    this.sessionPermissionModes = new Map();
    this.modelCatalogCache = null;
    this.turnDiffs = new Map();
  }

  async ensureStarted(): Promise<void> {
    if (this.runtimeRelease) await this.runtimeRelease;
    if (this.readyPromise) return this.readyPromise;
    if (this.child?.stdin?.writable) return;
    this.readyPromise = this.startProcess();
    try { await this.readyPromise; } finally { this.readyPromise = null; }
  }

  async startProcess(): Promise<void> {
    const firstBin = await resolveCodexExecutable(this.bin);
    try {
      await this.spawnAndInitialize(firstBin);
      this.bin = firstBin;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      const refreshedBin = await resolveCodexExecutable(this.bin);
      if (refreshedBin === firstBin) throw error;
      await this.spawnAndInitialize(refreshedBin);
      this.bin = refreshedBin;
    }
  }

  private async spawnAndInitialize(bin: string): Promise<void> {
    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.runtimeCwd,
      env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.emit('diagnostic', String(chunk).slice(-SUMMARY_LIMIT)));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (this.child === child) this.handleLine(line);
    });
    child.on('error', (error) => this.handleExit(error, child));
    child.on('close', (code, signal) => this.handleExit(
      new Error(`codex app-server exited (${code ?? signal})`), child,
    ));
    try {
      await this.rpcRaw('initialize', {
        clientInfo: { name: 'codex-anywhere', version: PACKAGE_VERSION },
        capabilities: { experimentalApi: true },
      });
    } catch (error) {
      child.kill();
      this.handleExit(error instanceof Error ? error : new Error(String(error)), child);
      throw error;
    }
  }

  async listSessions(options: { cwd?: string } = {}) {
    const cwd = options.cwd ? resolveAllowedWorkspace(this.allowedRoots, options.cwd) : '';
    const pending = this.sessionListReads.get(cwd);
    if (pending) return pending;
    const reading = this.readSessionList(cwd).finally(() => {
      if (this.sessionListReads.get(cwd) === reading) this.sessionListReads.delete(cwd);
    });
    this.sessionListReads.set(cwd, reading);
    return reading;
  }

  private async readSessionList(cwd: string) {
    await this.ensureStarted();
    const result = await this.rpcRaw('thread/list', {
      limit: 100,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      useStateDbOnly: true,
      sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
      ...(cwd ? { cwd: process.platform === 'win32' ? [cwd, cwd.toLowerCase()] : cwd } : {}),
    });
    const rows: JsonObject[] = Array.isArray(result?.data) ? result.data : [];
    return rows.map((thread: JsonObject) => {
      const threadCwd = thread.cwd || cwd;
      if (thread.id) this.sessionMetadata.set(thread.id, {
        cwd: threadCwd,
        path: thread.path || '',
        canAcceptDirectInput: thread.canAcceptDirectInput !== false,
      });
      return {
        id: thread.id,
        title: thread.name || thread.title || thread.preview || thread.id,
        preview: thread.preview || '',
        cwd: threadCwd,
        updatedAt: thread.recencyAt || thread.updatedAt || thread.createdAt || null,
        status: thread.status?.type || 'unknown',
        canAcceptDirectInput: thread.canAcceptDirectInput !== false,
        canStartNewSession: Boolean(threadCwd) && isAllowedWorkspace(this.allowedRoots, threadCwd),
      };
    }).filter((thread: JsonObject) => thread.id);
  }

  async prepareMessageEdit(threadId: unknown, turnId: unknown) {
    const id = editIdentifier(threadId), target = editIdentifier(turnId);
    await this.ensureStarted();
    const { thread } = await this.rpcRaw('thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id || !thread.cwd) throw new Error('message_edit_unavailable');
    resolveAllowedWorkspace(this.allowedRoots, thread.cwd);
    if (!['idle', 'notLoaded'].includes(thread.status?.type)) throw new Error('message_edit_busy');
    let cursor: string | undefined, latestTurnId = '';
    const visited = new Set<string>();
    // Read display summaries only, and only on explicit edit. Never fetch full
    // tool output or scan rollout files just to render an edit icon.
    for (let page = 0; page < 200; page++) {
      const result = await this.rpcRaw('thread/turns/list', {
        threadId: id, limit: 20, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}),
      });
      const turns = result.data || [];
      if (!latestTurnId) latestTurnId = turns[0]?.id || '';
      if (turns.some((turn: JsonObject) => turn.status === 'inProgress')) throw new Error('message_edit_busy');
      const turn = turns.find((turn: JsonObject) => turn.id === target);
      if (turn) {
        const users = (turn.items || []).filter((item: JsonObject) => item.type === 'userMessage');
        if (users.length !== 1 || !Array.isArray(users[0].content)) throw new Error('message_edit_unsupported');
        const input = users[0].content;
        const { text } = messageEditInput(input);
        return { threadId: id, turnId: target, latestTurnId, text, token: editToken(id, target, latestTurnId, input), input };
      }
      if (!result.nextCursor || visited.has(result.nextCursor)) break;
      cursor = result.nextCursor;
      visited.add(cursor!);
    }
    throw new Error('message_edit_unavailable');
  }

  async readSession(threadId: string) {
    await this.ensureStarted();
    const result = await this.rpcRaw('thread/read', { threadId, includeTurns: false });
    const recordedCwd = result?.thread?.cwd || this.sessionMetadata.get(threadId)?.cwd;
    if (!recordedCwd) throw new Error('session_project_directory_unavailable');
    const cwd = resolveAllowedWorkspace(this.allowedRoots, recordedCwd);
    this.sessionMetadata.set(threadId, {
      cwd,
      path: result?.thread?.path || this.sessionMetadata.get(threadId)?.path || '',
      canAcceptDirectInput: result?.thread?.canAcceptDirectInput !== false,
    });
    const history = await this.listSessionTurns(threadId);
    return {
      id: result?.thread?.id || threadId,
      title: result?.thread?.name || result?.thread?.title || result?.thread?.preview || threadId,
      cwd,
      turns: history.turns,
      nextCursor: history.nextCursor,
    };
  }

  async renameSession(threadId: unknown, value: unknown) {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId || resolvedThreadId.length > 256 || /[\0\r\n]/.test(resolvedThreadId)) {
      throw new Error('thread_id_required');
    }
    const name = normalizeSessionName(value);
    await this.rpcRaw('thread/name/set', { threadId: resolvedThreadId, name });
    return { threadId: resolvedThreadId, title: name };
  }

  async deleteSession(threadId: unknown) {
    const id = typeof threadId === 'string' ? threadId.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new Error('thread_id_required');
    if (this.getActiveTurn(id)) throw new Error('session_delete_turn_active');
    if (this.deletingThreads.has(id)) throw new Error('session_delete_in_progress');
    // Reserve before awaiting so a concurrent start cannot acquire this thread.
    this.deletingThreads.add(id);
    try {
      await this.threadReleases.get(id);
      await this.ensureStarted();
      const result = await this.rpcRaw('thread/read', { threadId: id, includeTurns: false });
      const thread = result?.thread;
      if (thread?.id !== id) throw new Error('session_delivery_mismatch');
      if (!thread.cwd) throw new Error('session_project_directory_unavailable');
      resolveAllowedWorkspace(this.allowedRoots, thread.cwd);
      if (['active', 'running', 'waiting', 'inProgress'].includes(thread.status?.type)
        || thread.turns?.some((turn: JsonObject) => turn.status === 'inProgress')) {
        throw new Error('session_delete_turn_active');
      }
      if (!['idle', 'notLoaded'].includes(thread.status?.type)) throw new Error('session_delete_status_unknown');
      // Native deletion maintains Codex's history/indexes. Never remove paths
      // supplied by the browser or touch the session's project directory.
      await this.rpcRaw('thread/delete', { threadId: id });
      this.sessionMetadata.delete(id);
      this.sessionPermissionModes.delete(id);
      this.sessionModelSettings.delete(id);
      this.clearApprovalsForThread(id);
      for (const [key, document] of this.turnDiffs) {
        if (document.threadId === id) this.turnDiffs.delete(key);
      }
      try { saveSessionModelSettings(this.modelSettingsPath, this.sessionModelSettings); }
      catch { this.emit('diagnostic', 'Could not persist model settings after session deletion'); }
      return { threadId: id, deleted: true };
    } finally {
      this.deletingThreads.delete(id);
    }
  }

  async listSessionTurns(threadId: unknown, options: {
    mode?: string; limit?: unknown; cursor?: unknown; questionIds?: unknown;
  } = {}) {
    const page = await this.readSessionTurns(threadId, options);
    const ids = new Set<string>(page.turns.flatMap((turn) => turn.items.flatMap((item: JsonObject) => (
      item.questions?.map((question: { id: string }) => question.id) || []
    ))));
    if (Array.isArray(options.questionIds)) for (const id of options.questionIds.slice(0, 512)) {
      if (typeof id === 'string' && id.length > 0 && id.length <= 1024) ids.add(id);
    }
    const path = this.sessionMetadata.get(String(threadId || '').trim())?.path;
    const questionReplies = ids.size && path
      ? await readRolloutQuestionReplies(path, ids).catch(() => [])
      : [];
    return { ...page, questionReplies };
  }

  async readSessionTurns(threadId: unknown, options: { mode?: string; limit?: unknown; cursor?: unknown } = {}) {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) throw new Error('thread_id_required');
    const mode = options.mode === 'live' ? 'live' : 'conversation';
    const maxLimit = mode === 'live' ? MAX_LIVE_PAGE_SIZE : MAX_HISTORY_PAGE_SIZE;
    const defaultLimit = mode === 'live' ? MAX_LIVE_PAGE_SIZE : DEFAULT_HISTORY_PAGE_SIZE;
    const parsedLimit = Number.parseInt(String(options.limit || defaultLimit), 10);
    const limit = Math.min(maxLimit, Math.max(1, Number.isFinite(parsedLimit)
      ? parsedLimit : defaultLimit));
    const cursor = String(options.cursor || '').trim();
    let metadata = this.sessionMetadata.get(resolvedThreadId);
    if (mode === 'live' && !metadata?.path) {
      await this.listSessions();
      metadata = this.sessionMetadata.get(resolvedThreadId);
    }
    if (!cursor && mode === 'live' && metadata?.path) {
      return this.readSessionTail(resolvedThreadId, metadata.path);
    }
    if (cursor.startsWith('rollout:v1:')) {
      if (!metadata?.path) throw new Error('session_history_unavailable');
      return this.readSessionTail(resolvedThreadId, metadata.path, { paged: true, cursor });
    }
    if (!cursor && await this.isLargeSession(resolvedThreadId)) {
      return this.readSessionTail(resolvedThreadId, metadata?.path, { paged: true });
    }
    const imageReferences = mode === 'conversation' && metadata?.path
      ? readRolloutGeneratedImages(metadata.path).catch(() => []) : Promise.resolve([]);
    try {
      const result = await this.rpcRaw('thread/turns/list', {
        threadId: resolvedThreadId,
        limit,
        sortDirection: 'desc',
        itemsView: mode === 'live' ? 'full' : 'summary',
        ...(cursor ? { cursor } : {}),
      });
      const contextUsage = !cursor && metadata?.path
        ? await readRolloutContextUsage(metadata.path).catch(() => undefined)
        : undefined;
      const rawTurns = Array.isArray(result?.data) ? result.data : [];
      const hydratedTurns = mode === 'conversation'
        ? await this.hydrateInjectedTurnInputs(resolvedThreadId, rawTurns)
        : rawTurns;
      const turns = mapTurns(hydratedTurns);
      if (mode === 'conversation' && metadata?.path) {
        const images = await imageReferences;
        for (const turn of turns) {
          const missing = images.filter((image) => image.turnId === turn.id
            && !turn.items.some((item: JsonObject) => item.attachment?.path === image.attachment?.path));
          const finalIndex = turn.items.findIndex((item: JsonObject) => item.phase === 'final_answer');
          turn.items.splice(finalIndex < 0 ? turn.items.length : finalIndex, 0, ...missing);
        }
      }
      return {
        threadId: resolvedThreadId,
        turns,
        nextCursor: result?.nextCursor || null,
        truncated: false,
        source: 'appServer',
        contextUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!cursor && metadata?.path && /RPC timeout: thread\/turns\/list/i.test(message)) {
        return this.readSessionTail(resolvedThreadId, metadata.path, { paged: true });
      }
      throw error;
    }
  }

  async hydrateInjectedTurnInputs(threadId: string, turns: JsonObject[]) {
    const summaries = mapTurns(turns);
    return Promise.all(turns.map(async (turn, index) => {
      const summaryItems = summaries[index]?.items || [];
      const hasVisibleUserInput = summaryItems.some((item: JsonObject) => item.type === 'userMessage');
      if (!summaryItems.length || hasVisibleUserInput || !turn?.id) return turn;
      try {
        const result = await this.rpcRaw('thread/items/list', {
          threadId, turnId: turn.id, limit: 4, sortDirection: 'asc',
        });
        const injected = (Array.isArray(result?.data) ? result.data : [])
          .map((entry: JsonObject) => entry?.item || entry)
          .find((item: JsonObject) => Boolean(parseInjectedUserMessage(item)));
        return injected
          ? { ...turn, items: [injected, ...(Array.isArray(turn.items) ? turn.items : [])] }
          : turn;
      } catch {
        // Older app-server builds may not expose item pagination. Keep the
        // lightweight summary instead of failing the whole history page.
        return turn;
      }
    }));
  }

  async isLargeSession(threadId: unknown) {
    const filePath = this.sessionMetadata.get(String(threadId || '').trim())?.path;
    if (!filePath) return false;
    try { return (await stat(filePath)).size >= LARGE_ROLLOUT_BYTES; } catch { return false; }
  }

  canOwnSession(threadId: unknown) {
    const cwd = this.sessionMetadata.get(String(threadId || '').trim())?.cwd;
    return Boolean(cwd && isAllowedWorkspace(this.allowedRoots, cwd));
  }

  async needsDesktopPermissionRecovery(threadId: unknown) {
    const resolvedThreadId = String(threadId || '').trim();
    let filePath = this.sessionMetadata.get(resolvedThreadId)?.path;
    if (!filePath) {
      await this.listSessions();
      filePath = this.sessionMetadata.get(resolvedThreadId)?.path;
    }
    return filePath ? needsDesktopPermissionRecovery(filePath) : false;
  }

  async readSessionTail(
    threadId: string, filePath?: string, options: { paged?: boolean; cursor?: string | null } = {},
  ) {
    if (!filePath) throw new Error('session_history_unavailable');
    const page = await readRolloutTail({ filePath, threadId, ...options });
    let compactionStartedAt: number | null = null;
    if (!options.cursor && page.turns[0]?.status === 'inProgress' && page.activityId) {
      const active = this.getActiveTurn(threadId);
      if (active?.turnId === page.activityId) {
        compactionStartedAt = active.compaction?.startedAt || null;
      } else {
        const progress = await this.compactionProgress.read({
          threadId, turnId: page.activityId, turnStartedAt: page.activityStartedAt || 0,
          after: Math.max(page.lastCompactionAt || 0, page.contextUsage?.updatedAt || 0),
        });
        compactionStartedAt = progress?.startedAt || null;
      }
    }
    return { ...page, compactionStartedAt };
  }

  async readTurnDiff(threadId: unknown, turnId: unknown) {
    const resolvedThreadId = String(threadId || '').trim();
    const resolvedTurnId = String(turnId || '').trim();
    if (!resolvedThreadId || resolvedThreadId.length > 256 || /[\0\r\n]/.test(resolvedThreadId)) {
      throw new Error('thread_id_required');
    }
    if (!resolvedTurnId || resolvedTurnId.length > 256 || /[\0\r\n]/.test(resolvedTurnId)) {
      throw new Error('turn_id_required');
    }
    const cached = this.turnDiffs.get(turnDiffKey(resolvedThreadId, resolvedTurnId));
    if (cached) return cached;

    try {
      await this.ensureStarted();
      let metadata = this.sessionMetadata.get(resolvedThreadId);
      if (!metadata?.path || !metadata?.cwd) {
        await this.listSessions();
        metadata = this.sessionMetadata.get(resolvedThreadId);
      }
      if (!metadata?.path || !metadata.cwd || !isAllowedWorkspace(this.allowedRoots, metadata.cwd)) {
        throw new Error('turn_diff_unavailable');
      }
      return await readRolloutTurnDiff({
        filePath: metadata.path,
        threadId: resolvedThreadId,
        turnId: resolvedTurnId,
      });
    } catch {
      throw new Error('turn_diff_unavailable');
    }
  }

  async readStoredModelConfig(threadId: string, catalog: ModelOption[] | Promise<ModelOption[]>) {
    const id = threadId.trim();
    if (!id) throw new Error('thread_id_required');
    await this.ensureStarted();
    // Metadata includes the latest persisted settings without loading the thread
    // or reading its turns. Never substitute global defaults for missing values.
    const [result, models] = await Promise.all([
      this.rpcRaw('thread/read', { threadId: id, includeTurns: false }, 5000), catalog,
    ]);
    const thread = result?.thread;
    if (thread?.id !== id || typeof thread.model !== 'string' || !thread.model.trim()) {
      throw new Error('desktop_model_unavailable');
    }
    return { model: thread.model, reasoningEffort: thread.reasoningEffort ?? '',
      serviceTier: null, fastMode: false, readOnly: true, source: 'persisted' as const, models };
  }

  async readModelConfig(threadId: unknown): Promise<SessionModelConfig> {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) throw new Error('thread_id_required');
    let metadata = this.sessionMetadata.get(resolvedThreadId);
    if (!metadata?.path || !metadata?.cwd) {
      await this.listSessions();
      metadata = this.sessionMetadata.get(resolvedThreadId);
    }
    if (!metadata) throw new Error('session_not_found');
    const [models, configResult, rolloutSettings] = await Promise.all([
      this.listModels(),
      this.rpcRaw('config/read', { cwd: metadata.cwd }).catch(() => ({ config: {} })),
      metadata.path
        ? readRolloutModelSettings(metadata.path).catch(() => ({} as RolloutModelSettings))
        : Promise.resolve({} as RolloutModelSettings),
    ]);
    const remembered = this.sessionModelSettings.get(resolvedThreadId) || {};
    const defaults = configResult?.config || {};
    const fallbackModel = models.find((model) => model.isDefault) || models[0];
    const requestedModel = remembered.model || rolloutSettings.model
      || String(defaults.model || fallbackModel?.model || '');
    const selectedModel = models.find((model) => model.model === requestedModel) || fallbackModel;
    if (!selectedModel) throw new Error('model_not_available');
    const requestedEffort = remembered.reasoningEffort || rolloutSettings.reasoningEffort
      || String(defaults.model_reasoning_effort || selectedModel.defaultReasoningEffort || '');
    const reasoningEffort = normalizeModelReasoningEffort(selectedModel, requestedEffort);
    const requestedServiceTier = remembered.serviceTier || rolloutSettings.serviceTier
      || String(defaults.service_tier || selectedModel.defaultServiceTier || 'default');
    const serviceTier = selectedModel.serviceTiers.some((tier) => tier.id === requestedServiceTier)
      ? requestedServiceTier : selectedModel.defaultServiceTier || 'default';
    const settings = {
      model: selectedModel.model,
      reasoningEffort,
      serviceTier,
    };
    return { ...settings, fastMode: isFastServiceTier(settings.serviceTier, models, settings.model), models };
  }

  async updateModelConfig(threadId: unknown, value: JsonObject): Promise<SessionModelConfig> {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) throw new Error('thread_id_required');
    if (this.getActiveTurn(resolvedThreadId)) throw new Error('model_config_turn_active');
    const models = await this.listModels();
    const requestedModel = String(value.model || '').trim();
    const model = models.find((candidate) => candidate.model === requestedModel);
    if (!model) throw new Error('model_not_available');
    const effort = String(value.reasoningEffort || '').trim();
    if (!model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) {
      throw new Error('reasoning_effort_not_available');
    }
    const fastMode = value.fastMode === true;
    const fastTier = model.serviceTiers.find((tier) => /(?:fast|priority)/i.test(`${tier.id} ${tier.name}`));
    if (fastMode && !fastTier) throw new Error('fast_mode_not_available');
    const standardTier = model.serviceTiers.find((tier) => tier.id === model.defaultServiceTier)
      || model.serviceTiers.find((tier) => /default|standard/i.test(`${tier.id} ${tier.name}`));
    const serviceTier = fastMode ? fastTier!.id : standardTier?.id || model.defaultServiceTier || null;
    const params = {
      threadId: resolvedThreadId,
      model: model.model,
      effort,
      serviceTier,
    };
    let desktopOwned = false;
    try {
      await this.rpcRaw('thread/settings/update', params);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (isActiveWriterError(error)) {
        desktopOwned = true;
      } else if (!/thread not found/i.test(message)) {
        throw error;
      }
      if (!desktopOwned) {
        let metadata = this.sessionMetadata.get(resolvedThreadId);
        if (!metadata?.cwd) {
          await this.listSessions();
          metadata = this.sessionMetadata.get(resolvedThreadId);
        }
        if (!metadata?.cwd) throw new Error('session_not_found');
        try {
          await this.rpcRaw('thread/resume', {
            threadId: resolvedThreadId,
            cwd: metadata.cwd,
            model: model.model,
            serviceTier,
            excludeTurns: true,
          });
        } catch (resumeError) {
          if (!isActiveWriterError(resumeError)) throw resumeError;
          desktopOwned = true;
        }
        if (!desktopOwned) {
          try {
            await this.rpcRaw('thread/settings/update', params);
          } finally {
            await this.rpcRaw('thread/unsubscribe', { threadId: resolvedThreadId }).catch(() => undefined);
          }
        }
      }
    }
    const settings = {
      model: model.model,
      reasoningEffort: effort,
      serviceTier: serviceTier || 'default',
    };
    this.rememberSessionModelSettings(resolvedThreadId, settings);
    return { ...settings, fastMode, models };
  }

  async readStoredPermissionConfig(threadId: string) {
    const id = threadId.trim();
    if (!id) throw new Error('thread_id_required');
    // The owned turn has already acknowledged these settings; its rollout may
    // still be flushing. Never reuse this cache after ownership ends.
    const applied = this.sessionPermissionModes.get(id);
    const active = this.activeTurns.get(id);
    if (active?.state === 'running' && applied) {
      return { mode: applied, networkAccess: applied === 'full' || this.networkAccess,
        source: 'persisted' as const, editable: false };
    }
    const read = async (metadata: SessionMetadata) => {
      resolveAllowedWorkspace(this.allowedRoots, metadata.cwd);
      return { ...await readRolloutPermissionSnapshot(metadata.path), source: 'persisted' as const, editable: !this.activeTurns.size };
    };
    const cached = this.sessionMetadata.get(id);
    if (cached?.path) {
      try { return await read(cached); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await this.ensureStarted();
    const { thread } = await this.rpcRaw('thread/read', { threadId: id, includeTurns: false }, 5000);
    if (thread?.id !== id || !thread.path || !thread.cwd) throw new Error('desktop_permissions_unavailable');
    const metadata = { cwd: thread.cwd, path: thread.path, canAcceptDirectInput: thread.canAcceptDirectInput !== false };
    const config = await read(metadata);
    this.sessionMetadata.set(id, metadata);
    return config;
  }

  updateStoredPermissionConfig(threadId: string, value: { mode?: unknown; settingsToken?: unknown }) {
    // Serialize with connector delivery/release; ordinary reads remain independent.
    const operation = this.threadRelease.then(async () => {
      if (this.activeTurns.size) throw new Error('permission_mode_turn_active');
      if (!PERMISSION_MODES.includes(value.mode as PermissionMode)) throw new Error('permission_mode_invalid');
      const mode = value.mode as PermissionMode;
      if (mode === 'full' && !this.allowFullAccess) throw new Error('full_access_not_allowed');
      const before = await this.readStoredPermissionConfig(threadId);
      if (!value.settingsToken || !('settingsToken' in before) || before.settingsToken !== value.settingsToken) {
        throw new Error('desktop_settings_changed');
      }
      const metadata = this.sessionMetadata.get(threadId)!;
      const editor = new CodexAppServer({ bin: this.bin, runtimeCwd: this.runtimeCwd,
        allowedRoots: this.allowedRoots, networkAccess: this.networkAccess, allowFullAccess: this.allowFullAccess,
        releaseRuntimeAfterTurn: true });
      try {
        await editor.ensureStarted();
        // Core's writer lock arbitrates simultaneous Desktop takeover. Never
        // navigate Desktop, retry uncertain writes, or retain another writer.
        const resumed = await editor.rpcRaw('thread/resume', { threadId, excludeTurns: true }, 5000);
        if (resumed.thread?.id !== threadId || resumed.thread?.status?.type !== 'idle') {
          throw new Error('permission_mode_turn_active');
        }
        const current = await readRolloutPermissionSnapshot(resumed.thread.path);
        if (current.settingsToken !== value.settingsToken) throw new Error('desktop_settings_changed');
        await editor.rpcRaw('thread/settings/update', { threadId,
          ...permissionSettings(mode, resolveAllowedWorkspace(this.allowedRoots, resumed.thread.cwd), this.networkAccess).turn });
        metadata.path = resumed.thread.path;
        // The RPC acknowledges an enqueued update. Confirm its persisted result
        // before stopping this short-lived runtime (no background polling).
        for (let attempt = 0; ; attempt++) {
          const saved = await readRolloutPermissionSnapshot(metadata.path);
          if (saved.mode === mode && saved.networkAccess === (mode === 'full' || this.networkAccess)) break;
          if (attempt === 10) throw new Error('desktop_settings_unconfirmed');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        if (isActiveWriterError(error)) throw new Error('permission_mode_managed_on_computer');
        throw error;
      } finally {
        await editor.releaseThread(threadId);
      }
      const confirmed = await this.readStoredPermissionConfig(threadId);
      if (confirmed.mode !== mode) throw new Error('desktop_settings_unconfirmed');
      this.sessionPermissionModes.set(threadId, mode);
      return confirmed;
    });
    this.threadRelease = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async readPermissionMode(threadId: unknown, { fresh = false }: { fresh?: boolean } = {}) {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) throw new Error('thread_id_required');
    const remembered = this.sessionPermissionModes.get(resolvedThreadId);
    if (remembered && !fresh) return { mode: remembered };
    let metadata = this.sessionMetadata.get(resolvedThreadId);
    if (!metadata?.path) {
      await this.listSessions();
      metadata = this.sessionMetadata.get(resolvedThreadId);
    }
    if (!metadata) throw new Error('session_not_found');
    const mode = metadata.path
      ? await readRolloutPermissionMode(metadata.path).catch(() => undefined)
      : undefined;
    return { mode: mode || 'ask' };
  }

  async updatePermissionMode(threadId: unknown, value: unknown) {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) throw new Error('thread_id_required');
    if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new Error('permission_mode_invalid');
    const mode = normalizePermissionMode(value);
    if (mode === 'full' && !this.allowFullAccess) throw new Error('full_access_not_allowed');
    if (this.getActiveTurn(resolvedThreadId)) throw new Error('permission_mode_turn_active');
    let metadata = this.sessionMetadata.get(resolvedThreadId);
    if (!metadata?.cwd) {
      await this.listSessions();
      metadata = this.sessionMetadata.get(resolvedThreadId);
    }
    if (!metadata?.cwd) throw new Error('session_not_found');
    const cwd = resolveAllowedWorkspace(this.allowedRoots, metadata.cwd);
    const params = {
      threadId: resolvedThreadId,
      ...permissionSettings(mode, cwd, this.networkAccess).turn,
    };
    try {
      await this.rpcRaw('thread/settings/update', params);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (isActiveWriterError(error)) throw new Error('permission_mode_managed_on_computer');
      if (!/thread not found/i.test(message)) throw error;
      try {
        await this.rpcRaw('thread/resume', {
          threadId: resolvedThreadId, cwd, excludeTurns: true,
        });
        await this.rpcRaw('thread/settings/update', params);
      } catch (resumeError) {
        if (isActiveWriterError(resumeError)) throw new Error('permission_mode_managed_on_computer');
        throw resumeError;
      } finally {
        await this.rpcRaw('thread/unsubscribe', { threadId: resolvedThreadId }).catch(() => undefined);
      }
    }
    this.sessionPermissionModes.set(resolvedThreadId, mode);
    return { mode };
  }

  async getDesktopTurnOverrides(threadId: unknown) {
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) return {};
    let settings = this.sessionModelSettings.get(resolvedThreadId);
    if (!settings) {
      try {
        settings = await this.readModelConfig(resolvedThreadId);
      } catch {
        // A temporary app-server/catalog failure must not block Desktop delivery.
        return {};
      }
    }
    return {
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.reasoningEffort ? { thinking: settings.reasoningEffort } : {}),
    };
  }

  private rememberSessionModelSettings(threadId: string, settings: RolloutModelSettings) {
    this.sessionModelSettings.delete(threadId);
    this.sessionModelSettings.set(threadId, settings);
    saveSessionModelSettings(this.modelSettingsPath, this.sessionModelSettings);
  }

  async listModels(options: { allowStale?: boolean } = {}): Promise<ModelOption[]> {
    if (this.modelCatalogCache && this.modelCatalogCache.expiresAt > Date.now()) {
      return this.modelCatalogCache.models;
    }
    if (!this.modelCatalogRead) {
      const reading = this.readModelCatalog().finally(() => {
        if (this.modelCatalogRead === reading) this.modelCatalogRead = null;
      });
      this.modelCatalogRead = reading;
    }
    if (options.allowStale && this.modelCatalogCache) {
      void this.modelCatalogRead.catch(() => {});
      return this.modelCatalogCache.models;
    }
    return this.modelCatalogRead;
  }

  private async readModelCatalog(): Promise<ModelOption[]> {
    await this.ensureStarted();
    const result = await this.rpcRaw('model/list', { limit: 100, includeHidden: false });
    const models = (Array.isArray(result?.data) ? result.data : []).map((model: JsonObject) => ({
      model: String(model.model || model.id || ''),
      displayName: String(model.displayName || model.model || model.id || ''),
      description: String(model.description || ''),
      supportedReasoningEfforts: (Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts : []).map((option: JsonObject) => ({
        reasoningEffort: String(option.reasoningEffort || ''),
        description: String(option.description || ''),
      })).filter((option: { reasoningEffort: string }) => option.reasoningEffort),
      defaultReasoningEffort: String(model.defaultReasoningEffort || ''),
      serviceTiers: (Array.isArray(model.serviceTiers) ? model.serviceTiers : []).map((tier: JsonObject) => ({
        id: String(tier.id || ''), name: String(tier.name || ''), description: String(tier.description || ''),
      })).filter((tier: { id: string }) => tier.id),
      defaultServiceTier: model.defaultServiceTier == null ? null : String(model.defaultServiceTier),
      isDefault: model.isDefault === true,
    })).filter((model: ModelOption) => model.model && model.supportedReasoningEfforts.length);
    this.modelCatalogCache = { expiresAt: Date.now() + 5 * 60_000, models };
    return models;
  }

  async startTurn({ text, threadId, cwd, clientId, requestId, permissionMode, edit }: StartTurnOptions) {
    let resolvedThreadId = String(threadId || '').trim();
    // Desktop first turns share a temporary runtime which must fully release
    // its writer before another task can start. Headless tasks remain parallel.
    if (this.releaseRuntimeAfterTurn) {
      await this.threadRelease;
      if (this.activeTurns.size) throw new Error('desktop_first_turn_busy');
    }
    if (this.deletingThreads.has(resolvedThreadId)) throw new Error('session_delete_in_progress');
    if (resolvedThreadId && this.getActiveTurn(resolvedThreadId)) throw new Error('another_turn_is_active');
    if (edit && (!resolvedThreadId || edit.confirm !== true || !edit.token)) throw new Error('message_edit_invalid');
    let editReverted = false;
    let subscribedThreadId = '';
    const isNewThread = !resolvedThreadId;
    const requestedPermissionMode = permissionMode === undefined
      ? null : normalizePermissionMode(permissionMode);
    if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode as PermissionMode)) {
      throw new Error('permission_mode_invalid');
    }
    if (requestedPermissionMode === 'full' && !this.allowFullAccess) {
      throw new Error('full_access_not_allowed');
    }
    if (!resolvedThreadId && !String(cwd || '').trim()) throw new Error('project_directory_required');
    let turnCwd = '';
    const turnContext: TurnContext = {
      clientId, requestId, threadId: resolvedThreadId, turnId: '', cwd: turnCwd, state: 'starting',
    };
    // Reserve existing tasks before the first await. New tasks have independent
    // provisional keys until app-server assigns their thread IDs.
    let key: string | symbol = resolvedThreadId || Symbol('new-thread');
    this.activeTurns.set(key, turnContext);
    try {
      await (this.releaseRuntimeAfterTurn ? this.threadRelease : this.threadReleases.get(resolvedThreadId));
      await this.ensureStarted();
      if (this.activeTurns.get(key) !== turnContext || turnContext.cancelRequested) throw new Error('turn_cancelled');
      if (resolvedThreadId) {
        const cachedMetadata = this.sessionMetadata.get(resolvedThreadId);
        if (cachedMetadata?.cwd) {
          turnCwd = resolveAllowedWorkspace(this.allowedRoots, cachedMetadata.cwd);
        } else {
          const metadata = await this.rpcRaw('thread/read', { threadId: resolvedThreadId, includeTurns: false });
          if (!metadata?.thread?.cwd) throw new Error('session_project_directory_unavailable');
          turnCwd = resolveAllowedWorkspace(this.allowedRoots, metadata.thread.cwd);
        }
      } else {
        turnCwd = resolveAllowedWorkspace(this.allowedRoots, cwd);
      }
      turnContext.cwd = turnCwd;
      const appliedPermissionMode = requestedPermissionMode || (isNewThread ? 'ask' : null);
      const permissions = appliedPermissionMode
        ? permissionSettings(appliedPermissionMode, turnCwd, this.networkAccess) : null;
      const threadParams = isNewThread && permissions
        ? { cwd: turnCwd, ...permissions.thread } : { cwd: turnCwd };
      if (resolvedThreadId) {
        const result = await this.resumeThread(resolvedThreadId, threadParams, turnContext);
        const resumedId = result?.thread?.id || result?.id || resolvedThreadId;
        if (resumedId !== resolvedThreadId) throw new Error('session_delivery_mismatch');
      } else {
        const result = await this.rpcRaw('thread/start', threadParams);
        resolvedThreadId = result?.thread?.id || result?.id || result?.threadId;
        if (!resolvedThreadId) throw new Error('codex_did_not_return_thread_id');
        if (result.thread?.path) this.sessionMetadata.set(resolvedThreadId, {
          cwd: turnCwd, path: result.thread.path, canAcceptDirectInput: result.thread.canAcceptDirectInput !== false,
        });
      }
      if (key !== resolvedThreadId && this.activeTurns.has(resolvedThreadId)) throw new Error('session_delivery_mismatch');
      subscribedThreadId = resolvedThreadId;
      if (this.activeTurns.get(key) !== turnContext || turnContext.cancelRequested) throw new Error('turn_cancelled');
      if (key !== resolvedThreadId) {
        this.activeTurns.delete(key);
        key = resolvedThreadId;
        this.activeTurns.set(key, turnContext);
      }
      turnContext.threadId = resolvedThreadId;
      let input: JsonObject[] = [{ type: 'text', text: String(text || '') }];
      if (edit) {
        const plan = await this.prepareMessageEdit(resolvedThreadId, edit.turnId);
        if (plan.token !== edit.token) throw new Error('message_edit_changed');
        input = messageEditInput(plan.input).replace(editText(text));
        if (turnContext.cancelRequested) throw new Error('turn_cancelled');
        await this.rpcRaw('thread/revert', { threadId: resolvedThreadId, beforeTurnId: edit.turnId });
        editReverted = true;
        if (turnContext.cancelRequested) throw new Error('turn_cancelled');
        for (const [cacheKey, document] of this.turnDiffs) {
          if (document.threadId === resolvedThreadId) this.turnDiffs.delete(cacheKey);
        }
      }
      // Resume may replay events from the previous turn. Only collect events
      // once we dispatch this start; its response is authoritative for turn ID.
      turnContext.startMessages = [];
      const startResult = await this.rpcRaw('turn/start', {
        threadId: resolvedThreadId,
        input,
        cwd: turnCwd,
        ...(permissions ? permissions.turn : {}),
      });
      const turnId = String(startResult?.turn?.id || startResult?.turnId || '').trim();
      if (!turnId) throw new Error('codex_did_not_return_turn_id');
      turnContext.turnId = turnId;
      if (this.activeTurns.get(key) !== turnContext || turnContext.cancelRequested) {
        await this.rpcRaw('turn/interrupt', { threadId: resolvedThreadId, turnId }).catch(() => undefined);
        throw new Error('turn_cancelled');
      }
      turnContext.state = 'running';
      if (appliedPermissionMode) {
        this.sessionPermissionModes.set(resolvedThreadId, appliedPermissionMode);
      }
      this.emitTurn('turn.started', { threadId: resolvedThreadId, turnId }, turnContext);
      const messages = turnContext.startMessages;
      delete turnContext.startMessages;
      for (const message of messages) {
        if (message.id != null) this.handleServerRequest(message);
        else this.handleNotification(message.method, message.params);
      }
      return { threadId: resolvedThreadId };
    } catch (error) {
      // A failed or cancelled start must not leave native approval RPCs waiting.
      for (const message of turnContext.startMessages || []) {
        if (message.id == null) continue;
        try {
          this.writeRpc({ jsonrpc: '2.0', id: message.id,
            result: approvalResult(message.method, false, message.params) });
        } catch { /* The runtime may already have exited. */ }
      }
      delete turnContext.startMessages;
      if (this.activeTurns.get(key) === turnContext) this.activeTurns.delete(key);
      await this.releaseThread(subscribedThreadId);
      if (editReverted) throw new Error('message_edit_reverted_send_failed');
      throw error;
    }
  }

  private releaseThread(threadId: unknown): Promise<void> {
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) return Promise.resolve();
    const child = this.child;
    const release = (this.threadReleases.get(resolvedThreadId) || Promise.resolve())
      .catch(() => undefined)
      .then(() => this.rpcRaw('thread/unsubscribe', { threadId: resolvedThreadId }))
      .finally(async () => {
        // Current hosts may retain an unsubscribed writer for minutes. Desktop
        // mode only uses this runtime for first turns; release our OWN idle child
        // before handing that same task to Desktop. Never stop a replacement or
        // a runtime executing another turn. Headless environments keep theirs.
        if (!this.releaseRuntimeAfterTurn || !child || this.child !== child || this.activeTurns.size) return;
        let finishRelease!: () => void;
        this.runtimeRelease = new Promise<void>((resolve) => { finishRelease = resolve; });
        try {
          // Let already dispatched RPCs finish. New calls wait for the next
          // runtime, including later steps of an existing multi-RPC operation.
          await Promise.allSettled([...this.inflightRpcs]);
          if (this.child !== child || this.activeTurns.size) return;
          const exited = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('codex_writer_release_timeout')), 5_000);
            child.once('close', () => { clearTimeout(timer); resolve(); });
          });
          await this.close();
          await exited;
        } finally {
          this.runtimeRelease = null;
          finishRelease();
        }
      })
      .then(() => undefined);
    const settled = release.catch((error) => {
      this.emit('diagnostic', `Failed to release Codex thread ${resolvedThreadId}: ${String(error)}`);
    }).finally(() => {
      if (this.threadReleases.get(resolvedThreadId) === settled) this.threadReleases.delete(resolvedThreadId);
    });
    this.threadReleases.set(resolvedThreadId, settled);
    this.threadRelease = Promise.all([this.threadRelease, settled]).then(() => undefined);
    return release;
  }

  async prepareDesktopTurn() { await this.threadRelease; }

  async steerTurn({ text, threadId, clientId, requestId }: StartTurnOptions) {
    const targetThreadId = String(threadId || '').trim();
    const prompt = String(text || '').trim();
    if (!targetThreadId) throw new Error('thread_id_required');
    if (!prompt) throw new Error('message_required');
    const turnContext = this.getActiveTurn(targetThreadId);
    if (
      !turnContext
      || turnContext.threadId !== targetThreadId
      || turnContext.state !== 'running'
      || !turnContext.turnId
    ) {
      throw new Error('turn_not_active');
    }
    turnContext.clientId = clientId;
    turnContext.requestId = requestId;
    const result = await this.rpcRaw('turn/steer', {
      threadId: targetThreadId,
      input: [{ type: 'text', text: prompt }],
      expectedTurnId: turnContext.turnId,
    });
    const acceptedTurnId = String(result?.turnId || '').trim();
    if (acceptedTurnId && acceptedTurnId !== turnContext.turnId) throw new Error('turn_id_mismatch');
    return { threadId: targetThreadId, turnId: turnContext.turnId, steered: true };
  }

  async resumeThread(
    threadId: string,
    threadParams: JsonObject,
    turnContext: TurnContext,
  ) {
    try {
      return await this.rpcRaw('thread/resume', { threadId, ...threadParams });
    } catch (error) {
      if (this.getActiveTurn(threadId) !== turnContext) throw new Error('turn_cancelled');
      if (isActiveWriterError(error)) throw new Error('thread_active_writer_conflict');
      throw error;
    }
  }

  listApprovals(threadId: unknown, clientId?: string) {
    const targetThreadId = String(threadId || '').trim();
    const active = targetThreadId ? this.getActiveTurn(targetThreadId) : null;
    if (clientId && active) {
      active.clientId = clientId;
    }
    return {
      activeTurn: active ? {
        threadId: active.threadId,
        turnId: active.turnId,
        state: active.state,
      } : null,
      approvals: [...this.approvals.entries()]
        .filter(([, pending]) => !targetThreadId || pending.threadId === targetThreadId)
        .map(([approvalId, pending]) => ({
          approvalId,
          threadId: pending.threadId,
          kind: pending.kind,
          summary: pending.summary,
        })),
    };
  }

  async respondApproval(approvalId: unknown, approved: boolean, threadId?: unknown) {
    const pending = this.approvals.get(String(approvalId));
    if (!pending) throw new Error('approval_not_found');
    const expectedThreadId = String(threadId || '').trim();
    if (expectedThreadId && pending.threadId !== expectedThreadId) throw new Error('approval_thread_mismatch');
    this.writeRpc({
      jsonrpc: '2.0',
      id: pending.id,
      result: approvalResult(
        pending.method, approved, pending.params, this.allowedRoots, this.networkAccess,
      ),
    });
    this.approvals.delete(String(approvalId));
    this.emitTurn('approval.resolved', {
      approvalId: String(approvalId),
      kind: pending.kind,
      summary: approvalDecisionSummary(pending),
      approved: approved === true,
    }, this.getActiveTurn(pending.threadId));
    return { approvalId: String(approvalId), approved: approved === true };
  }

  async stopTurn(expectedThreadId?: unknown) {
    const expected = String(expectedThreadId || '').trim();
    if (!expected && this.activeTurns.size > 1) throw new Error('thread_id_required');
    const turn = this.getActiveTurn(expected) || (this.getActiveTurn()?.threadId === '' ? this.getActiveTurn() : null);
    if (!turn) {
      if (expected && this.activeTurns.size) throw new Error('turn_stop_mismatch');
      return { stopped: false };
    }
    if (expected && turn.threadId && expected !== turn.threadId) {
      throw new Error('turn_stop_mismatch');
    }
    turn.cancelRequested = true;
    if (!turn.threadId || !turn.turnId || turn.state !== 'running') {
      return { stopped: true, pending: true };
    }
    turn.state = 'cancelling';
    try {
      await this.rpcRaw('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId });
    } catch (error) {
      if (this.getActiveTurn(turn.threadId) !== turn) return { stopped: true };
      turn.cancelRequested = false;
      turn.state = 'running';
      throw error;
    }
    return { stopped: true };
  }

  async close() {
    this.activeTurns.clear();
    this.approvals.clear();
    if (!this.child) return;
    const child = this.child;
    child.kill();
    this.handleExit(new Error('Codex app-server closed'), child);
  }

  async rpcRaw<T = any>(method: string, params: JsonObject = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    if (this.runtimeRelease) {
      await this.runtimeRelease;
      await this.ensureStarted();
    }
    const id = ++this.nextId;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
    });
    try {
      this.writeRpc({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.inflightRpcs.add(promise);
    try { return await promise; }
    finally { this.inflightRpcs.delete(promise); }
  }

  sendRpcNotification(method: string, params: JsonObject, includeId = false) {
    this.writeRpc({ jsonrpc: '2.0', ...(includeId ? { id: ++this.nextId } : {}), method, params });
  }

  writeRpc(message: JsonObject) {
    if (!this.child?.stdin?.writable) throw new Error('codex_app_server_offline');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line: string) {
    let message: JsonObject;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    // JSON-RPC requests and responses have independent ID spaces. An inbound
    // approval request must never settle an outbound request with the same ID.
    if (message.id != null && typeof message.method === 'string') {
      this.handleServerRequest(message);
      return;
    }
    if (message.id != null && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
      && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(Object.hasOwn(message, 'result') ? message.result : message);
      return;
    }
    if (typeof message.method === 'string') this.handleNotification(message.method, message.params || {});
  }

  handleServerRequest(message: JsonObject) {
    const method = message.method || '';
    const params = message.params || {};
    const mcpApproval = isMcpToolApproval(method, params);
    if (method === 'mcpServer/elicitation/request' && !mcpApproval) {
      this.writeRpc({ jsonrpc: '2.0', id: message.id, result: { action: 'decline', content: null, _meta: null } });
      return;
    }
    if (!APPROVAL_METHODS.has(method) && !mcpApproval) {
      this.writeRpc({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unsupported app-server request: ${method}` },
      });
      return;
    }
    if (this.bufferStartingMessage(message)) return;
    const active = this.notificationTurn(params);
    if (!active || (mcpApproval && !params.threadId)) {
      this.writeRpc({ jsonrpc: '2.0', id: message.id, result: approvalResult(method, false, params) });
      return;
    }
    const approvalId = String(message.id);
    const threadId = active.threadId;
    const kind = approvalKind(method);
    const summary = approvalSummary(method, params, SUMMARY_LIMIT);
    this.approvals.set(approvalId, {
      id: message.id, method, params, threadId, kind, summary,
    });
    this.emitTurn('approval.requested', {
      approvalId,
      threadId,
      kind,
      summary,
    }, active);
  }

  handleNotification(method: string, params: JsonObject) {
    if (this.bufferStartingMessage({ method, params })) return;
    const active = this.notificationTurn(params);
    if (!active) return;
    const emit = (event: string, payload: JsonObject) => this.emitTurn(event, payload, active);
    if ((method === 'item/started' || method === 'item/completed') && params.item?.type === 'contextCompaction') {
      if (!active || params.threadId !== active.threadId || params.turnId !== active.turnId) return;
      if (method === 'item/started') {
        if (active.compaction?.itemId !== params.item.id) active.compaction = { itemId: params.item.id, startedAt: Date.now() };
      } else {
        if (active.compaction && active.compaction.itemId !== params.item.id) return;
        delete active.compaction;
      }
      emit('turn.compaction', { startedAt: active.compaction?.startedAt || null });
      return;
    }
    if (method === 'turn/plan/updated') {
      const plan = summarizePlanSteps(params.plan);
      if (plan) emit('turn.progress', { plan });
      return;
    }
    if (method === 'turn/diff/updated') {
      const files = summarizeUnifiedDiff(params.diff);
      if (files) {
        const activeTurn = active;
        const document = activeTurn
          ? createTurnDiffDocument(activeTurn.threadId, activeTurn.turnId, params.diff)
          : null;
        if (document) this.rememberTurnDiff(document);
        emit('turn.progress', { files });
      }
      return;
    }
    if (isReasoningMethod(method)) {
      const text = extractText(params);
      if (text) emit('turn.reasoning', { text });
      return;
    }
    const itemType = String(params.item?.type || params.type || '');
    if (
      method === 'item/agentMessage/delta'
      || method === 'item/agent_message/delta'
      || (method.endsWith('/delta') && /agent.?message/i.test(itemType))
    ) {
      const delta = String(params.delta || '');
      const itemId = String(params.itemId || params.item_id || params.item?.id || '');
      if (delta) emit('turn.delta', {
        delta, phase: params.phase || params.item?.phase || '', ...(itemId ? { itemId } : {}),
      });
      return;
    }
    if (method === 'item/started') {
      const item = params.item || {};
      if (['commandExecution', 'toolCall', 'webSearch'].includes(item.type)) emit('tool.started', summarizeItem(item));
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (['commandExecution', 'toolCall', 'webSearch'].includes(item.type)) {
        emit('tool.completed', summarizeItem(item));
        return;
      }
      const questions = asyncQuestionsFromItem(item);
      if (questions) {
        if (params.threadId === active?.threadId && params.turnId === active?.turnId) {
          emit('turn.questions', { questions, itemId: item.id });
        }
        return;
      }
      const text = extractText(item);
      if (text && item.phase === 'final_answer') emit('turn.final', { text });
      return;
    }
    if (method === 'turn/completed' || method === 'turn.completed') {
      const previous = active;
      const threadId = params.threadId || params.thread_id;
      const turnId = params.turn?.id || params.turnId || params.turn_id;
      if (!previous || (threadId && threadId !== previous.threadId) || (turnId && turnId !== previous.turnId)) return;
      const status = String(params.turn?.status || params.status || 'completed');
      const failure = params.turn?.error || params.error;
      const reason = /interrupted/i.test(status) ? 'cancelled'
        : failure || /failed|error/i.test(status) ? 'failed' : 'completed';
      const error = failure ? publicError(extractText(failure) || 'Codex execution error').slice(0, 500) : '';
      this.clearApprovalsForThread(previous?.threadId);
      emit('turn.ended', {
        reason, status, threadId: previous?.threadId, usage: params.usage || params.turn?.usage,
        ...(error ? { error } : {}),
      });
      previous.state = 'completed';
      if (this.getActiveTurn(previous.threadId) === previous) this.activeTurns.delete(previous.threadId);
      void this.releaseThread(previous?.threadId).catch(() => {});
      return;
    }
    if (method === 'error' || method.includes('error')) {
      emit('turn.error', {
        error: publicError(String(params.message || params.error?.message || 'Codex error')).slice(0, SUMMARY_LIMIT),
      });
    }
  }

  clearApprovalsForThread(threadId: unknown) {
    const targetThreadId = String(threadId || '').trim();
    if (!targetThreadId) return;
    for (const [approvalId, pending] of this.approvals) {
      if (pending.threadId === targetThreadId) this.approvals.delete(approvalId);
    }
  }

  rememberTurnDiff(document: TurnDiffDocument) {
    const key = turnDiffKey(document.threadId, document.turnId);
    this.turnDiffs.delete(key);
    this.turnDiffs.set(key, document);
    while (this.turnDiffs.size > MAX_CACHED_TURN_DIFFS) {
      const oldest = this.turnDiffs.keys().next().value;
      if (oldest === undefined) break;
      this.turnDiffs.delete(oldest);
    }
  }

  getActiveTurn(threadId?: unknown): TurnContext | null {
    const id = String(threadId || '').trim();
    if (id) return this.activeTurns.get(id) || null;
    return this.activeTurns.size === 1 ? this.activeTurns.values().next().value! : null;
  }

  private bufferStartingMessage(message: JsonObject): boolean {
    const params = message.params || {};
    const threadId = params.threadId || params.thread_id || params.conversationId;
    // Never assign unscoped events to a provisional or concurrent start.
    const active = threadId ? this.getActiveTurn(threadId) : null;
    if (!active?.startMessages || active.turnId) return false;
    if (active.startMessages.length >= 512) {
      active.cancelRequested = true;
      if (message.id != null) this.writeRpc({ jsonrpc: '2.0', id: message.id,
        result: approvalResult(message.method, false, params) });
      return true;
    }
    active.startMessages.push(message);
    return true;
  }

  private notificationTurn(params: JsonObject): TurnContext | null {
    const threadId = params.threadId || params.thread_id || params.conversationId;
    const turnId = params.turnId || params.turn_id || params.turn?.id;
    const active = threadId ? this.getActiveTurn(threadId)
      : turnId ? [...this.activeTurns.values()].find(turn => turn.turnId === turnId) || null
        : this.getActiveTurn();
    if (!active || (!active.turnId && active.state === 'starting')) return null;
    return turnId && turnId !== active.turnId ? null : active;
  }

  emitTurn(event: string, payload: JsonObject, active: TurnContext | null) {
    if (!active) return;
    this.emit('turn-event', {
      clientId: active.clientId,
      requestId: active.requestId,
      event,
      payload: {
        ...payload,
        threadId: active.threadId,
        turnId: active.turnId,
      },
    });
  }

  handleExit(error: Error, child = this.child) {
    if (!child || this.child !== child) return;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.approvals.clear();
    for (const active of this.activeTurns.values()) {
      this.emitTurn('turn.error', { error: publicError(error) }, active);
    }
    this.activeTurns.clear();
  }
}

function isFastServiceTier(serviceTier: unknown, models: ModelOption[], selectedModel: unknown) {
  const tierId = String(serviceTier || '');
  const model = models.find((candidate) => candidate.model === String(selectedModel || ''));
  const tier = model?.serviceTiers.find((candidate) => candidate.id === tierId);
  return /(?:fast|priority)/i.test(`${tierId} ${tier?.name || ''}`);
}

function normalizeModelReasoningEffort(model: ModelOption, value: unknown) {
  const requested = String(value || '').trim();
  const supported = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (supported.includes(requested)) return requested;
  if (['none', 'minimal'].includes(requested) && supported.includes('low')) return 'low';
  if (['max', 'ultra'].includes(requested) && supported.includes('xhigh')) return 'xhigh';
  if (supported.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
  return supported[0] || '';
}

function turnDiffKey(threadId: string, turnId: string) {
  return `${threadId}\0${turnId}`;
}

function isActiveWriterError(error: unknown) {
  return /already has an active writer/i.test(String(error instanceof Error ? error.message : error || ''));
}

export const internals = {
  approvedPermissions, approvalKind, approvalResult, extractText, mapTurns,
  isAllowedWorkspace, permissionSettings, resolveAllowedWorkspace, summarizeItem,
};
