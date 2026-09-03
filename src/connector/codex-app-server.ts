import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  basename, dirname, isAbsolute, relative, resolve,
} from 'node:path';
import { createInterface } from 'node:readline';
import { parseAssistantMessage, parseUserMessage } from '../shared/message-content.js';
import {
  readRolloutContextUsage,
  readRolloutModelSettings,
  readRolloutPermissionMode,
  readRolloutTail,
  type RolloutModelSettings,
} from './rollout-tail.js';
import { extractGeneratedImageAttachment } from './generated-images.js';
import { needsDesktopPermissionRecovery } from './session-permissions.js';
import { resolveCodexExecutable } from './codex-executable.js';
import { summarizePlanSteps, summarizeUnifiedDiff } from '../shared/turn-progress.js';
import { summarizeToolActivity } from '../shared/activity-detail.js';
import { publicError } from '../shared/protocol.js';
import {
  normalizePermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../shared/permission-mode.js';
import { normalizeSessionName } from '../shared/session-name.js';
import {
  createTurnDiffDocument,
  readRolloutTurnDiff,
  type TurnDiffDocument,
} from './turn-diffs.js';

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
  bin?: string;
  runtimeCwd?: string;
  allowedRoots?: string[];
  networkAccess?: boolean;
  allowFullAccess?: boolean;
};
type PendingRpc = {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};
type PendingApproval = {
  id: string | number;
  method: string;
  params: JsonObject;
  threadId: string;
  kind: string;
  summary: string;
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
  clientId?: string;
  requestId?: string;
  threadId: string;
  turnId: string;
  cwd: string;
  state: string;
};
type StartTurnOptions = {
  text?: unknown;
  threadId?: unknown;
  cwd?: unknown;
  clientId?: string;
  requestId?: string;
  permissionMode?: unknown;
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
  activeTurn: TurnContext | null;
  private threadRelease: Promise<void>;
  sessionMetadata: Map<string, SessionMetadata>;
  sessionModelSettings: Map<string, RolloutModelSettings>;
  sessionPermissionModes: Map<string, PermissionMode>;
  modelCatalogCache: { expiresAt: number; models: ModelOption[] } | null;
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
    this.activeTurn = null;
    this.threadRelease = Promise.resolve();
    this.sessionMetadata = new Map();
    this.sessionModelSettings = new Map();
    this.sessionPermissionModes = new Map();
    this.modelCatalogCache = null;
    this.turnDiffs = new Map();
  }

  async ensureStarted(): Promise<void> {
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
    await this.ensureStarted();
    const cwd = options.cwd ? resolveAllowedWorkspace(this.allowedRoots, options.cwd) : '';
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

  async listSessionTurns(threadId: unknown, options: { mode?: string; limit?: unknown; cursor?: unknown } = {}) {
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
      return {
        threadId: resolvedThreadId,
        turns: mapTurns(result?.data),
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

  getControllerThreadId(targetThreadId: unknown) {
    const target = String(targetThreadId || '').trim();
    // Desktop requires a valid caller task for app tool requests. Prefer a
    // different known task so the destination stays writable and explicit.
    return [...this.sessionMetadata.keys()].find((threadId) => threadId !== target) || target;
  }

  async readSessionTail(
    threadId: string, filePath?: string, options: { paged?: boolean; cursor?: string | null } = {},
  ) {
    if (!filePath) throw new Error('session_history_unavailable');
    return readRolloutTail({ filePath, threadId, ...options });
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
    const settings = {
      model: remembered.model || rolloutSettings.model || String(defaults.model || fallbackModel?.model || ''),
      reasoningEffort: remembered.reasoningEffort || rolloutSettings.reasoningEffort
        || String(defaults.model_reasoning_effort || fallbackModel?.defaultReasoningEffort || ''),
      serviceTier: remembered.serviceTier || rolloutSettings.serviceTier
        || String(defaults.service_tier || fallbackModel?.defaultServiceTier || 'default'),
    };
    return { ...settings, fastMode: isFastServiceTier(settings.serviceTier, models, settings.model), models };
  }

  async updateModelConfig(threadId: unknown, value: JsonObject): Promise<SessionModelConfig> {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) throw new Error('thread_id_required');
    if (this.activeTurn?.threadId === resolvedThreadId) throw new Error('model_config_turn_active');
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
    this.sessionModelSettings.set(resolvedThreadId, settings);
    return { ...settings, fastMode, models };
  }

  async readPermissionMode(threadId: unknown) {
    await this.ensureStarted();
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) throw new Error('thread_id_required');
    const remembered = this.sessionPermissionModes.get(resolvedThreadId);
    if (remembered) return { mode: remembered };
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
    if (this.activeTurn) throw new Error('permission_mode_turn_active');
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

  getDesktopTurnOverrides(threadId: unknown) {
    const settings = this.sessionModelSettings.get(String(threadId || '').trim());
    if (!settings) return {};
    return {
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.reasoningEffort ? { thinking: settings.reasoningEffort } : {}),
    };
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.modelCatalogCache && this.modelCatalogCache.expiresAt > Date.now()) {
      return this.modelCatalogCache.models;
    }
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

  async startTurn({ text, threadId, cwd, clientId, requestId, permissionMode }: StartTurnOptions) {
    if (this.activeTurn) throw new Error('another_turn_is_active');
    await this.threadRelease;
    if (this.activeTurn) throw new Error('another_turn_is_active');
    let resolvedThreadId = String(threadId || '').trim();
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
    const turnContext = {
      clientId, requestId, threadId: resolvedThreadId, turnId: '', cwd: turnCwd, state: 'starting',
    };
    this.activeTurn = turnContext;
    try {
      await this.ensureStarted();
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
        resolvedThreadId = result?.thread?.id || result?.id || resolvedThreadId;
      } else {
        const result = await this.rpcRaw('thread/start', threadParams);
        resolvedThreadId = result?.thread?.id || result?.id || result?.threadId;
        if (!resolvedThreadId) throw new Error('codex_did_not_return_thread_id');
      }
      subscribedThreadId = resolvedThreadId;
      if (this.activeTurn !== turnContext) throw new Error('turn_cancelled');
      const startResult = await this.rpcRaw('turn/start', {
        threadId: resolvedThreadId,
        input: [{ type: 'text', text: String(text || '') }],
        cwd: turnCwd,
        ...(permissions ? permissions.turn : {}),
      });
      if (this.activeTurn !== turnContext) throw new Error('turn_cancelled');
      const turnId = String(startResult?.turn?.id || startResult?.turnId || '').trim();
      if (!turnId) throw new Error('codex_did_not_return_turn_id');
      turnContext.threadId = resolvedThreadId;
      turnContext.turnId = turnId;
      turnContext.state = 'running';
      if (appliedPermissionMode) {
        this.sessionPermissionModes.set(resolvedThreadId, appliedPermissionMode);
      }
      this.emitTurn('turn.started', { threadId: resolvedThreadId, turnId });
      return { threadId: resolvedThreadId };
    } catch (error) {
      if (this.activeTurn === turnContext) this.activeTurn = null;
      await this.releaseThread(subscribedThreadId);
      throw error;
    }
  }

  private releaseThread(threadId: unknown): Promise<void> {
    const resolvedThreadId = String(threadId || '').trim();
    if (!resolvedThreadId) return this.threadRelease;
    const release = this.threadRelease
      .catch(() => undefined)
      .then(() => this.rpcRaw('thread/unsubscribe', { threadId: resolvedThreadId }))
      .then(() => undefined);
    this.threadRelease = release.catch((error) => {
      this.emit('diagnostic', `Failed to release Codex thread ${resolvedThreadId}: ${String(error)}`);
    });
    return this.threadRelease;
  }

  async steerTurn({ text, threadId, clientId, requestId }: StartTurnOptions) {
    const targetThreadId = String(threadId || '').trim();
    const prompt = String(text || '').trim();
    if (!targetThreadId) throw new Error('thread_id_required');
    if (!prompt) throw new Error('message_required');
    const turnContext = this.activeTurn;
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
      if (this.activeTurn !== turnContext) throw new Error('turn_cancelled');
      if (isActiveWriterError(error)) throw new Error('thread_active_writer_conflict');
      throw error;
    }
  }

  listApprovals(threadId: unknown, clientId?: string) {
    const targetThreadId = String(threadId || '').trim();
    if (clientId && this.activeTurn?.threadId === targetThreadId) {
      this.activeTurn.clientId = clientId;
    }
    return {
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
    });
    return { approvalId: String(approvalId), approved: approved === true };
  }

  async stopTurn() {
    if (!this.child) return { stopped: false };
    const previous = this.activeTurn;
    const child = this.child;
    this.activeTurn = null;
    this.clearApprovalsForThread(previous?.threadId);
    child.kill();
    this.handleExit(new Error('Codex app-server stopped'), child);
    this.emit('turn-event', {
      clientId: previous?.clientId,
      requestId: previous?.requestId,
      event: 'turn.ended',
      payload: { reason: 'cancelled', threadId: previous?.threadId },
    });
    return { stopped: true };
  }

  async close() {
    const previous = this.activeTurn;
    this.activeTurn = null;
    this.clearApprovalsForThread(previous?.threadId);
    if (!this.child) return;
    const child = this.child;
    child.kill();
    this.handleExit(new Error('Codex app-server closed'), child);
  }

  async rpcRaw<T = any>(method: string, params: JsonObject = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
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
    return promise;
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
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(Object.hasOwn(message, 'result') ? message.result : message);
      return;
    }
    if (message.id != null && message.method) {
      this.handleServerRequest(message);
      return;
    }
    this.handleNotification(message.method || '', message.params || {});
  }

  handleServerRequest(message: JsonObject) {
    const method = message.method || '';
    if (!APPROVAL_METHODS.has(method)) {
      this.writeRpc({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unsupported app-server request: ${method}` },
      });
      return;
    }
    const params = message.params || {};
    const approvalId = String(message.id);
    const threadId = String(params.threadId || params.conversationId || this.activeTurn?.threadId || '');
    const kind = approvalKind(method);
    const summary = approvalSummary(method, params);
    this.approvals.set(approvalId, {
      id: message.id, method, params, threadId, kind, summary,
    });
    this.emitTurn('approval.requested', {
      approvalId,
      threadId,
      kind,
      summary,
    });
  }

  handleNotification(method: string, params: JsonObject) {
    if (method === 'turn/plan/updated') {
      const plan = summarizePlanSteps(params.plan);
      if (plan) this.emitTurn('turn.progress', { plan });
      return;
    }
    if (method === 'turn/diff/updated') {
      const files = summarizeUnifiedDiff(params.diff);
      if (files) {
        const activeTurn = this.activeTurn;
        const document = activeTurn
          ? createTurnDiffDocument(activeTurn.threadId, activeTurn.turnId, params.diff)
          : null;
        if (document) this.rememberTurnDiff(document);
        this.emitTurn('turn.progress', { files });
      }
      return;
    }
    if (isReasoningMethod(method)) {
      const text = extractText(params);
      if (text) this.emitTurn('turn.reasoning', { text });
      return;
    }
    const itemType = String(params.item?.type || params.type || '');
    if (
      method === 'item/agentMessage/delta'
      || method === 'item/agent_message/delta'
      || (method.endsWith('/delta') && /agent.?message/i.test(itemType))
    ) {
      const delta = String(params.delta || '');
      if (delta) this.emitTurn('turn.delta', { delta, phase: params.phase || params.item?.phase || '' });
      return;
    }
    if (method === 'item/started') {
      const item = params.item || {};
      if (['commandExecution', 'toolCall', 'webSearch'].includes(item.type)) this.emitTurn('tool.started', summarizeItem(item));
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (['commandExecution', 'toolCall', 'webSearch'].includes(item.type)) {
        this.emitTurn('tool.completed', summarizeItem(item));
        return;
      }
      const text = extractText(item);
      if (text && item.phase === 'final_answer') this.emitTurn('turn.final', { text });
      return;
    }
    if (method === 'turn/completed' || method === 'turn.completed') {
      const previous = this.activeTurn;
      this.clearApprovalsForThread(previous?.threadId);
      this.emitTurn('turn.ended', { reason: 'completed', threadId: previous?.threadId, usage: params.usage || params.turn?.usage });
      this.activeTurn = null;
      void this.releaseThread(previous?.threadId);
      return;
    }
    if (method === 'error' || method.includes('error')) {
      this.emitTurn('turn.error', {
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

  emitTurn(event: string, payload: JsonObject) {
    if (!this.activeTurn) return;
    this.emit('turn-event', {
      clientId: this.activeTurn.clientId,
      requestId: this.activeTurn.requestId,
      event,
      payload: {
        ...payload,
        threadId: this.activeTurn.threadId,
        turnId: this.activeTurn.turnId,
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
    if (this.activeTurn) {
      this.emitTurn('turn.error', { error: publicError(error) });
      this.activeTurn = null;
    }
  }
}

function isFastServiceTier(serviceTier: unknown, models: ModelOption[], selectedModel: unknown) {
  const tierId = String(serviceTier || '');
  const model = models.find((candidate) => candidate.model === String(selectedModel || ''));
  const tier = model?.serviceTiers.find((candidate) => candidate.id === tierId);
  return /(?:fast|priority)/i.test(`${tierId} ${tier?.name || ''}`);
}

function turnDiffKey(threadId: string, turnId: string) {
  return `${threadId}\0${turnId}`;
}

function approvalKind(method: string) {
  if (/commandExecution|execCommand/i.test(method)) return 'command';
  if (/fileChange|applyPatch/i.test(method)) return 'file-change';
  if (/permissions/i.test(method)) return 'permission';
  if (/requestUserInput/i.test(method)) return 'user-input';
  return 'action';
}

function approvalSummary(method: string, params: JsonObject) {
  const value = params.command || params.reason || params.grantRoot || params.permissions
    || params.path || params.input || method;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.slice(0, SUMMARY_LIMIT);
}

function approvalDecisionSummary(pending: PendingApproval) {
  if (pending.kind === 'command') {
    return summarizeToolActivity({
      type: 'commandExecution',
      command: pending.params.command,
      parsed_cmd: pending.params.parsedCommand || pending.params.parsed_cmd,
    }) || 'command';
  }
  if (pending.kind === 'file-change') {
    const path = String(pending.params.path || pending.params.filePath || '').trim();
    return path ? `file-change · ${basename(path)}` : 'file-change';
  }
  return pending.kind;
}

function approvalResult(
  method: string,
  approved: boolean,
  params: JsonObject = {},
  allowedRoots: string[] = [],
  networkAccess = false,
) {
  if (/permissions\/requestApproval/i.test(method)) {
    return approved
      ? { permissions: approvedPermissions(params.permissions, allowedRoots, networkAccess), scope: 'turn' }
      : { permissions: {}, scope: 'turn' };
  }
  if (/applyPatchApproval|execCommandApproval/i.test(method)) {
    return {
      decision: approved ? 'approved' : { denied: { rejection: 'Rejected from Codex Anywhere' } },
    };
  }
  return { decision: approved ? 'accept' : 'decline' };
}

function approvedPermissions(requested: JsonObject = {}, allowedRoots: string[], networkAccess: boolean) {
  const permissions: JsonObject = {};
  const requestedFileSystem = requested?.fileSystem;
  if (requestedFileSystem && typeof requestedFileSystem === 'object') {
    const read = filterAllowedPaths(requestedFileSystem.read, allowedRoots);
    const write = filterAllowedPaths(requestedFileSystem.write, allowedRoots);
    const entries = (Array.isArray(requestedFileSystem.entries) ? requestedFileSystem.entries : [])
      .flatMap((entry: JsonObject) => {
        if (entry?.path?.type !== 'path') return [];
        try {
          const path = resolveAllowedWorkspace(allowedRoots, entry.path.path);
          return [{ ...entry, path: { ...entry.path, path } }];
        } catch {
          return [];
        }
      });
    if (read.length || write.length || entries.length) {
      permissions.fileSystem = {
        read: read.length ? read : null,
        write: write.length ? write : null,
        ...(entries.length ? { entries } : {}),
      };
    }
  }
  if (networkAccess && requested?.network?.enabled === true) {
    permissions.network = { enabled: true };
  }
  return permissions;
}

function permissionSettings(mode: PermissionMode, cwd: string, networkAccess: boolean) {
  if (mode === 'full') {
    return {
      thread: {
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access',
        config: { sandbox_mode: 'danger-full-access' },
      },
      turn: {
        approvalPolicy: 'never', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    };
  }
  return {
    thread: {
      approvalPolicy: 'on-request',
      approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
      sandbox: 'workspace-write',
      config: {
        sandbox_mode: 'workspace-write',
        sandbox_workspace_write: {
          writable_roots: [cwd],
          network_access: networkAccess,
          exclude_tmpdir_env_var: false,
          exclude_slash_tmp: false,
        },
      },
    },
    turn: {
      approvalPolicy: 'on-request',
      approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
      sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: [cwd], networkAccess,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    },
  };
}

function filterAllowedPaths(values: unknown, allowedRoots: string[]) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .flatMap((value) => {
      if (!value) return [];
      try { return [resolveAllowedWorkspace(allowedRoots, value)]; } catch { return []; }
    });
}

function summarizeItem(item: JsonObject) {
  const detail = summarizeToolActivity(item);
  return {
    type: item.type || '',
    status: item.status || '',
    ...(detail ? { detail } : {}),
  };
}

function isReasoningMethod(method: string) {
  return /reasoning/i.test(method) && /delta|summary|completed/i.test(method);
}

function extractText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.delta === 'string') return value.delta;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.summary === 'string') return value.summary;
  if (Array.isArray(value.summary)) return value.summary.map(extractText).filter(Boolean).join('\n');
  if (Array.isArray(value.content)) return value.content.map(extractText).filter(Boolean).join('\n');
  if (Array.isArray(value.input)) return value.input.map(extractText).filter(Boolean).join('\n');
  if (value.item) return extractText(value.item);
  return '';
}

function mapTurns(turns: unknown) {
  return (Array.isArray(turns) ? turns : []).map((turn: JsonObject) => {
    const rawItems = Array.isArray(turn.items) ? turn.items : [];
    const items: JsonObject[] = rawItems
      .filter((item: JsonObject) => {
        const type = String(item.type || '');
        return Boolean(extractGeneratedImageAttachment(item))
          || (!/reasoning|command|tool|webSearch|fileChange|system|developer/i.test(type)
            && /user|agent|assistant|message/i.test(type));
      })
      .map((item: JsonObject) => {
        const attachment = extractGeneratedImageAttachment(item);
        const userMessage = /user/i.test(String(item.type || ''));
        const completedAt = item.completedAt || item.updatedAt || item.createdAt || item.timestamp
          || (userMessage ? turn.startedAt : turn.completedAt) || null;
        const timing = completedAt ? { completedAt } : {};
        if (attachment) {
          return {
            type: 'agentMessage', phase: 'final_answer', status: item.status || '', text: '', attachment,
            ...timing,
          };
        }
        const content = userMessage
          ? parseUserMessage(extractText(item)) : parseAssistantMessage(extractText(item));
        return {
          type: item.type,
          phase: item.phase || '',
          status: item.status || '',
          ...content,
          ...timing,
        };
      })
      .filter((item: JsonObject) => item.text || item.attachment);
    const toolSummary = summarizeTurnTools(rawItems);
    if (toolSummary) {
      const finalIndex = items.findIndex((item: JsonObject) => item.phase === 'final_answer');
      items.splice(finalIndex < 0 ? items.length : finalIndex, 0, {
        type: 'timelineNotice', text: '', notice: toolSummary,
        completedAt: turn.completedAt || null,
      });
    }
    const status = String(turn.status?.type || turn.status || '');
    if (/failed|aborted|error/i.test(status)) {
      const detailValue = turn.error?.message || turn.error || turn.message || turn.reason;
      const rawDetail = typeof detailValue === 'string' ? detailValue.trim() : '';
      const detail = rawDetail ? publicError(rawDetail).slice(0, 500) : '';
      items.push({
        type: 'timelineNotice', text: '',
        notice: {
          kind: 'turnStatus',
          status: /aborted/i.test(status) ? 'aborted' : /error/i.test(status) ? 'error' : 'failed',
          ...(detail ? { detail } : {}),
        },
        completedAt: turn.completedAt || null,
      });
    }
    return {
      id: turn.id,
      status,
      startedAt: turn.startedAt || null,
      completedAt: turn.completedAt || null,
      items,
    };
  });
}

function summarizeTurnTools(items: JsonObject[]) {
  const counts = {
    commands: 0, edits: 0, searches: 0, connectedTools: 0, generations: 0, other: 0,
  };
  let total = 0;
  for (const item of items) {
    const type = String(item?.type || '');
    if (!/command|tool|webSearch|fileChange|mcp/i.test(type)
      || /output/i.test(type)) continue;
    const label = summarizeToolActivity(item).split(' · ')[0]?.toLowerCase() || '';
    if (!label) continue;
    const field = /command|exec_command/.test(label) ? 'commands'
      : /file.?change|apply_patch|patch/.test(label) ? 'edits'
        : /web|search/.test(label) ? 'searches'
          : /image.?gen/.test(label) ? 'generations'
            : /mcp/.test(label) ? 'connectedTools'
              : 'other';
    counts[field] += 1;
    total += 1;
  }
  return total ? {
    kind: 'toolSummary', total,
    ...Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0)),
  } : undefined;
}

function isActiveWriterError(error: unknown) {
  return /already has an active writer/i.test(String(error instanceof Error ? error.message : error || ''));
}

function resolveAllowedWorkspace(roots: string[] | string, candidate: unknown) {
  const rawCandidate = String(candidate || '').trim();
  if (!rawCandidate) throw new Error('project_directory_required');
  const requested = canonicalizeWorkspaceCandidate(rawCandidate);
  const allowedRoots = (Array.isArray(roots) ? roots : [roots])
    .map((root) => String(root || '').trim())
    .filter(Boolean)
    .flatMap((root) => {
      try { return [realpathSync(resolve(root))]; } catch { return []; }
    });
  for (const allowedRoot of allowedRoots) {
    const pathFromRoot = relative(allowedRoot, requested);
    if (!pathFromRoot || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
      return requested;
    }
  }
  throw new Error('workspace_outside_allowed_root');
}

function canonicalizeWorkspaceCandidate(candidate: string) {
  let current = resolve(candidate);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(current), ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('workspace_path_invalid');
      const parent = dirname(current);
      if (parent === current) throw new Error('workspace_path_invalid');
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

function isAllowedWorkspace(roots: string[] | string, candidate: unknown) {
  try {
    resolveAllowedWorkspace(roots, candidate);
    return true;
  } catch {
    return false;
  }
}

export const internals = {
  approvedPermissions, approvalKind, approvalResult, extractText, mapTurns,
  isAllowedWorkspace, permissionSettings, resolveAllowedWorkspace, summarizeItem,
};
