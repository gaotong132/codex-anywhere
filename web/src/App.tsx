import {
  KeyboardEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  attachLatestAssistantFileChanges,
  appendUniqueTimelineError,
  attachmentRegistryKey,
  parseAssistantMessage,
  historyFingerprint,
  historyItems,
  isDuplicateFinalProgress,
  latestTurnProgressItemId,
  loadKnownAttachments,
  mergeHistorySnapshot,
  progressTypewriterKey,
  resolveTimelineAttachment,
  storeKnownAttachments,
  type ImageAttachment,
  type KnownAttachment,
  type TimelineItem,
  type TimelineKind,
} from './history-utils';
import {
  buildImageMessage,
  fileToBase64,
  formatBytes,
  isValidImagePayload,
  prepareImageFile,
  type UploadedImage,
} from './image-utils';
import {
  decodeBase64Chunk,
  localFileName,
  safeDownloadName,
} from './file-utils';
import { downloadCanContinue, waitForDownloadReady } from './download-resume';
import { t } from './i18n';
import {
  formatDate,
  friendlyError,
  canSendToActiveDesktopTurn,
  canSteerOwnedTurn,
  canStopOwnedTurn,
  composerPrimaryAction,
  initialBootstrapReady,
  isConnectionInterruption,
  isEventForSelectedThread,
  isNearScrollBottom,
  isSessionRunning,
  isTemporaryProjectPath,
  makeId,
  markSessionAttentionRead,
  presenceLabel,
  projectLabel,
  reconcileSessionAttention,
  replayPendingFrames,
  sessionProjectName,
  sessionUpdatedAt,
  shouldLoadOlderHistory,
  shouldPrefillOlderHistory,
  type SessionAttentionState,
} from './app-utils';
import {
  CustomSelect,
  DownloadIndicator,
  seedTypewriterText,
  SidebarIcon,
  TypewriterText,
} from './ui-components';
import { ConversationTimeline } from './conversation-timeline';
import { BrowserSecureChannel } from './secure-channel-client';
import { normalizeToolPurpose } from '../../src/shared/message-content';
import {
  normalizeTurnProgress,
  type TurnFileProgress,
  type TurnProgress,
} from '../../src/shared/turn-progress';
import { requireCurrentProtocol } from '../../src/shared/protocol-contract';
import {
  clearBrowserDeviceApproval,
  createBrowserDeviceProof,
  hasApprovedBrowserDevice,
  loadOrCreateBrowserDeviceIdentity,
  markBrowserDeviceApproved,
} from './device-identity';
import {
  DEVICE_KEY_AUTH_CONTEXT,
  browserPairingVerifier,
  createBrowserPairingProof,
  encodeBrowserPairingCredential,
  parseBrowserPairingCredential,
  type BrowserPairingCredential,
} from '../../src/shared/pairing-auth';
import type {
  Approval,
  AwaitingDesktopTurn,
  BridgeMessage,
  DownloadedImage,
  DownloadFileChunk,
  ExecutionState,
  FileDownloadState,
  FollowState,
  HistoryPage,
  LiveActivityKind,
  ModelConfigDraft,
  ModelOption,
  OpenedDownload,
  PendingImage,
  PendingApprovals,
  PendingRequest,
  Session,
  SessionModelConfig,
  TurnStartResult,
  VisualizationDocument,
} from './app-types';

const DEVICE_ID = 'personal-pc';
const HISTORY_PAGE_SIZE = 6;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_START_REQUEST_TIMEOUT_MS = 11 * 60_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CLIENT_HEARTBEAT_MS = 20_000;
const CLIENT_STALE_AFTER_MS = 55_000;
const SESSION_STATUS_REFRESH_MS = 6_000;
const INITIAL_BOOTSTRAP_TIMEOUT_MS = 10_000;
const SESSION_ATTENTION_KEY = 'bridge.sessionAttention.v1';
const PENDING_PAIRING_KEY = 'bridge.pendingPairing.v1';
const NEW_TURN_KEY = '__new_turn__';
type RequestOptions = { timeoutMs?: number | null; signal?: AbortSignal };
type ScreenWakeLockSentinel = { released: boolean; release(): Promise<void> };
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<ScreenWakeLockSentinel> };
};
const PairingDialog = lazy(() => import('./pairing-dialog').then((module) => ({
  default: module.PairingDialog,
})));

function loadInitialBrowserPairing() {
  let serialized = '';
  if (location.hash.startsWith('#pair=')) {
    serialized = location.hash;
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  } else {
    try { serialized = sessionStorage.getItem(PENDING_PAIRING_KEY) || ''; } catch { /* blocked store */ }
  }
  if (!serialized) return null;
  try {
    const credential = parseBrowserPairingCredential(serialized);
    try { sessionStorage.setItem(PENDING_PAIRING_KEY, encodeBrowserPairingCredential(credential)); } catch { /* memory only */ }
    return credential;
  } catch {
    try { sessionStorage.removeItem(PENDING_PAIRING_KEY); } catch { /* blocked store */ }
    return null;
  }
}

function loadSessionAttention(): SessionAttentionState {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_ATTENTION_KEY) || '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored)
      .filter(([id, state]) => id && (state === 'running' || state === 'unread'))
      .slice(-200)) as SessionAttentionState;
  } catch {
    return {};
  }
}

function storeSessionAttention(value: SessionAttentionState) {
  try { localStorage.setItem(SESSION_ATTENTION_KEY, JSON.stringify(value)); } catch { /* keep in memory */ }
}

const ACTIVITY_LABELS: Record<LiveActivityKind, [string, string]> = {
  starting: ['正在启动', 'Starting'],
  planning: ['正在规划', 'Planning'],
  command: ['正在执行', 'Running'],
  editing: ['正在修改文件', 'Editing files'],
  searching: ['正在搜索', 'Searching'],
  connectedTool: ['正在处理', 'Using a tool'],
  generating: ['正在生成图片', 'Generating an image'],
  waiting: ['正在等待', 'Waiting'],
  checking: ['正在检查结果', 'Checking results'],
  responding: ['正在整理回复', 'Preparing a response'],
  working: ['正在处理', 'Working'],
};

function safeActivityKind(value: unknown): LiveActivityKind {
  return Object.hasOwn(ACTIVITY_LABELS, String(value || ''))
    ? String(value) as LiveActivityKind : 'working';
}

function activityLabel(kind: LiveActivityKind) {
  return t(...ACTIVITY_LABELS[kind]);
}

function liveEventActivity(payload: Record<string, unknown>): LiveActivityKind {
  const type = String(payload.type || '').toLowerCase();
  const name = String(payload.name || '').toLowerCase();
  if (/websearch|web_search/.test(type) || /web.?search/.test(name)) return 'searching';
  if (/commandexecution|command_execution/.test(type) || /command|shell|exec/.test(name)) return 'command';
  if (/image/.test(type) || /image.?gen/.test(name)) return 'generating';
  return 'connectedTool';
}

function epochMillis(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1_000;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedLabel(startedAt: number | null, now: number) {
  if (!startedAt) return '';
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function LiveActivityStatus({
  kind, purpose, detail, progress, startedAt,
}: {
  kind: LiveActivityKind;
  purpose: string;
  detail: string;
  progress: TurnProgress;
  startedAt: number | null;
}) {
  const [clock, setClock] = useState(Date.now());
  const elapsed = elapsedLabel(startedAt, clock);
  const hasMetrics = Boolean(progress.plan || progress.files);
  useEffect(() => {
    if (!startedAt) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <div
      className={`tool-purpose${purpose ? ' has-purpose' : ''}${hasMetrics ? ' has-metrics' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={[purpose, detail || activityLabel(kind), elapsed].filter(Boolean).join(' · ')}
      title={[purpose, detail || activityLabel(kind), elapsed].filter(Boolean).join(' · ')}
    >
      <div className="activity-content">
        {purpose && (
          <div className="activity-line activity-purpose-line">
            <TypewriterText active as="strong" className="status-change" key={purpose} text={purpose} />
          </div>
        )}
        <div className="activity-line activity-detail-line">
          <ToolActivityDetail detail={detail} kind={kind} />
        </div>
        {hasMetrics && (
          <div className="activity-line activity-secondary">
            <span className="activity-metrics">
              {progress.plan && (
                <TypewriterText
                  active
                  className="status-change"
                  key={`plan:${progress.plan.current}:${progress.plan.total}`}
                  showCaret={false}
                  text={t(`第 ${progress.plan.current} / ${progress.plan.total} 步`, `Step ${progress.plan.current} / ${progress.plan.total}`)}
                />
              )}
              {progress.files && (
                <TypewriterText
                  active
                  className="status-change"
                  completeContent={<>
                    {t(`${progress.files.changed} 个文件已更改`, `${progress.files.changed} files changed`)}
                    {' '}<b className="additions">+{progress.files.additions}</b>
                    {' '}<b className="deletions">-{progress.files.deletions}</b>
                  </>}
                  key={`files:${progress.files.changed}:${progress.files.additions}:${progress.files.deletions}`}
                  showCaret={false}
                  text={t(
                    `${progress.files.changed} 个文件已更改 +${progress.files.additions} -${progress.files.deletions}`,
                    `${progress.files.changed} files changed +${progress.files.additions} -${progress.files.deletions}`,
                  )}
                />
              )}
            </span>
          </div>
        )}
      </div>
      {startedAt && <time className="activity-elapsed">{elapsed}</time>}
    </div>
  );
}

function ToolActivityDetail({ detail, kind }: { detail: string; kind: LiveActivityKind }) {
  const completed = detail.startsWith('✓ ');
  const text = completed ? detail.slice(2) : detail || activityLabel(kind);
  const [checkedDetail, setCheckedDetail] = useState('');
  const [typedText, setTypedText] = useState('');
  useEffect(() => {
    if (!completed) {
      setCheckedDetail('');
      return;
    }
    if (typedText === text) setCheckedDetail(detail);
  }, [completed, detail, text, typedText]);
  return <>
    <TypewriterText
      active
      as="strong"
      className="status-change"
      key={text}
      text={text}
      onComplete={() => {
        setTypedText(text);
        if (completed) setCheckedDetail(detail);
      }}
    />
    {completed && checkedDetail === detail && (
      <span className="activity-complete-check" key={detail} aria-hidden="true">✓</span>
    )}
  </>;
}

function reasoningEffortLabel(value: string) {
  const labels: Record<string, [string, string]> = {
    none: ['无', 'None'], minimal: ['极低', 'Minimal'], low: ['低', 'Low'], medium: ['中', 'Medium'],
    high: ['高', 'High'], xhigh: ['极高', 'X-high'], max: ['最高', 'Max'], ultra: ['超高', 'Ultra'],
  };
  return labels[value] ? t(...labels[value]) : value;
}

function fastTierAvailable(model: ModelOption | undefined) {
  return Boolean(model?.serviceTiers.some((tier) => /(?:fast|priority)/i.test(`${tier.id} ${tier.name}`)));
}

function ModelConfigControl({
  config, loading, disabled, onSave,
}: {
  config: SessionModelConfig | null;
  loading: boolean;
  disabled: boolean;
  onSave: (draft: ModelConfigDraft) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ModelConfigDraft | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = config?.models.find((model) => model.model === config.model);
  const draftModel = config?.models.find((model) => model.model === draft?.model);

  useEffect(() => {
    setOpen(false);
    setError('');
    setDraft(config ? {
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fastMode: config.fastMode,
    } : null);
  }, [config]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const save = async () => {
    if (!draft || saving || disabled) return;
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
      setOpen(false);
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const displayModel = selectedModel?.displayName || config?.model || t('自动选择', 'Automatic');
  return (
    <div className={`model-config${open ? ' open' : ''}`} ref={rootRef}>
      <button
        className="model-config-summary"
        type="button"
        disabled={!config || loading}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title={disabled ? t('会话执行中，可预选并在结束后保存', 'Preselect now and save after the task finishes') : t('配置后续轮次', 'Configure subsequent turns')}
      >
        <span className="model-config-model">{loading ? t('读取模型…', 'Loading model…') : displayModel}</span>
        <span>{config?.reasoningEffort ? reasoningEffortLabel(config.reasoningEffort) : t('默认思考', 'Default reasoning')}</span>
        <span className={config?.fastMode ? 'fast active' : 'fast'}>{config?.fastMode ? t('快速', 'Fast') : t('标准', 'Standard')}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && draft && config && (
        <div className="model-config-popover">
          <header>
            <strong>{t('后续轮次配置', 'Next-turn settings')}</strong>
            <span>{disabled ? t('当前正在执行，可预选并在结束后保存', 'Preselect now and save after the task finishes') : t('保存后用于该会话的后续消息', 'Applies to subsequent messages in this task')}</span>
          </header>
          <div className="model-config-field">
            <span>{t('模型', 'Model')}</span>
            <CustomSelect
              value={draft.model}
              disabled={saving}
              ariaLabel={t('选择模型', 'Select model')}
              options={config.models.map((model) => ({
                value: model.model,
                label: model.displayName,
                description: model.description,
              }))}
              onChange={(value) => {
                const nextModel = config.models.find((model) => model.model === value);
                if (!nextModel) return;
                const effortSupported = nextModel.supportedReasoningEfforts
                  .some((option) => option.reasoningEffort === draft.reasoningEffort);
                setDraft({
                  model: nextModel.model,
                  reasoningEffort: effortSupported ? draft.reasoningEffort : nextModel.defaultReasoningEffort,
                  fastMode: draft.fastMode && fastTierAvailable(nextModel),
                });
              }}
            />
          </div>
          <div className="model-config-field">
            <span>{t('思考强度', 'Reasoning')}</span>
            <CustomSelect
              value={draft.reasoningEffort}
              disabled={saving}
              ariaLabel={t('选择思考强度', 'Select reasoning effort')}
              options={(draftModel?.supportedReasoningEfforts || []).map((option) => ({
                value: option.reasoningEffort,
                label: reasoningEffortLabel(option.reasoningEffort),
                description: option.description,
              }))}
              onChange={(value) => setDraft({ ...draft, reasoningEffort: value })}
            />
          </div>
          <label className={`model-fast-toggle${fastTierAvailable(draftModel) ? '' : ' unavailable'}`}>
            <span><strong>{t('快速模式', 'Fast mode')}</strong><small>{fastTierAvailable(draftModel)
              ? t('使用模型支持的低延迟服务层', 'Use the model’s low-latency service tier')
              : t('当前模型不支持', 'Not available for this model')}</small></span>
            <input
              type="checkbox"
              checked={draft.fastMode}
              disabled={saving || !fastTierAvailable(draftModel)}
              onChange={(event) => setDraft({ ...draft, fastMode: event.target.checked })}
            />
            <i aria-hidden="true" />
          </label>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button type="button" onClick={() => setOpen(false)}>{t('取消', 'Cancel')}</button>
            <button className="primary-action" type="button" disabled={disabled || saving} onClick={() => void save()}>
              {saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function StartupScreen({ status }: { status: string }) {
  return (
    <main className="startup-shell" aria-busy="true" aria-live="polite">
      <div className="startup-visual" aria-hidden="true">
        <div className="startup-orbit"><i /><i /><i /></div>
        <div className="startup-mark"><span>C</span><i /></div>
      </div>
      <div className="startup-copy">
        <strong>CODEX ANYWHERE</strong>
        <span>{status || t('正在恢复上次会话…', 'Restoring your last session…')}</span>
        <div className="startup-pulse" aria-hidden="true"><i /><i /><i /></div>
      </div>
    </main>
  );
}

export default function App() {
  const [pairingCredential, setPairingCredential] = useState<BrowserPairingCredential | null>(loadInitialBrowserPairing);
  const [pairingDialogOpen, setPairingDialogOpen] = useState(false);
  const [newSessionCwd, setNewSessionCwd] = useState(() => {
    const stored = localStorage.getItem('bridge.newSessionCwd') || '';
    return isTemporaryProjectPath(stored) ? '' : stored;
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [initialBootstrapPending, setInitialBootstrapPending] = useState(() => (
    hasApprovedBrowserDevice() || Boolean(pairingCredential)
  ));
  const [sessionsInitialized, setSessionsInitialized] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState(false);
  const [statusText, setStatusText] = useState(t('未连接', 'Disconnected'));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionAttention, setSessionAttention] = useState<SessionAttentionState>(loadSessionAttention);
  const [sessionSearch, setSessionSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<SessionModelConfig | null>(null);
  const [modelConfigLoading, setModelConfigLoading] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [initialHistoryLoaded, setInitialHistoryLoaded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const [knownAttachments, setKnownAttachments] = useState<Record<string, KnownAttachment>>(loadKnownAttachments);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [ownedTurnThreadId, setOwnedTurnThreadId] = useState<string | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [followState, setFollowState] = useState<FollowState>('idle');
  const [executionState, setExecutionState] = useState<ExecutionState>('idle');
  const [toolPurpose, setToolPurpose] = useState('');
  const [activityDetail, setActivityDetail] = useState('');
  const [liveActivity, setLiveActivity] = useState<LiveActivityKind>('working');
  const [activityStartedAt, setActivityStartedAt] = useState<number | null>(null);
  const [turnProgress, setTurnProgress] = useState<TurnProgress>({});
  const [fileDownload, setFileDownload] = useState<FileDownloadState | null>(null);
  const [creatingNewSession, setCreatingNewSession] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [newSessionPrompt, setNewSessionPrompt] = useState('');
  const [newSessionImage, setNewSessionImage] = useState<PendingImage | null>(null);
  const [newSessionError, setNewSessionError] = useState('');
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [stopConfirmationArmed, setStopConfirmationArmed] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const pairingCredentialRef = useRef(pairingCredential);
  const approvedDeviceRef = useRef(hasApprovedBrowserDevice());
  const authAttemptModeRef = useRef<'device' | 'pairing'>('device');
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectWantedRef = useRef(false);
  const socketAuthenticatedRef = useRef(false);
  const connectorOnlineRef = useRef(false);
  const secureChannelRef = useRef<BrowserSecureChannel | null>(null);
  const messageHandlerRef = useRef<(message: BridgeMessage) => void>(() => {});
  const lastServerActivityRef = useRef(0);
  const scheduleReconnectRef = useRef<(immediate?: boolean) => void>(() => {});
  const threadIdRef = useRef<string | null>(null);
  const selectedRequestRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const preserveScrollHeightRef = useRef<number | null>(null);
  const previousMessageScrollTopRef = useRef(0);
  const shouldScrollBottomRef = useRef(false);
  const autoFollowLatestRef = useRef(true);
  const streamItemRef = useRef<{ id: string; kind: TimelineKind } | null>(null);
  const activeTurnIdRef = useRef('');
  const turnProgressRef = useRef<TurnProgress>({});
  const followFingerprintRef = useRef('');
  const latestActivityIdRef = useRef('');
  const awaitingDesktopTurnRef = useRef<AwaitingDesktopTurn | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const newSessionImageInputRef = useRef<HTMLInputElement | null>(null);
  const newSessionAutoSendRef = useRef(false);
  const sendingRef = useRef(false);
  const attachmentLoadsRef = useRef(new Set<string>());
  const fileDownloadRef = useRef(false);
  const fileDownloadCancelRef = useRef(false);
  const fileDownloadAbortRef = useRef<AbortController | null>(null);
  const downloadWakeLockRef = useRef<ScreenWakeLockSentinel | null>(null);
  const sessionRefreshInFlightRef = useRef(false);
  const olderHistoryLoadingRef = useRef(false);
  const liveHistoryHydratedThreadRef = useRef<string | null>(null);
  const optimisticRestoreRef = useRef<string | null>(null);
  const runningRef = useRef(running);
  const ownedTurnThreadIdRef = useRef(ownedTurnThreadId);
  const sessionAttentionRef = useRef(sessionAttention);

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);
  useEffect(() => { pairingCredentialRef.current = pairingCredential; }, [pairingCredential]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { ownedTurnThreadIdRef.current = ownedTurnThreadId; }, [ownedTurnThreadId]);
  useEffect(() => {
    if (!stopConfirmationArmed) return;
    const timer = setTimeout(() => setStopConfirmationArmed(false), 4_000);
    return () => clearTimeout(timer);
  }, [stopConfirmationArmed]);
  useEffect(() => {
    setStopConfirmationArmed(false);
  }, [executionState, online, pendingImage, prompt, threadId]);

  const finishInitialBootstrap = useCallback(() => {
    setInitialBootstrapPending(false);
  }, []);

  const updateSessionAttention = useCallback((
    update: (current: SessionAttentionState) => SessionAttentionState,
  ) => {
    setSessionAttention((current) => {
      const next = update(current);
      sessionAttentionRef.current = next;
      if (next !== current) storeSessionAttention(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!threadId) return;
    if (executionState === 'running' || executionState === 'waiting') {
      updateSessionAttention((current) => current[threadId] === 'running'
        ? current : { ...current, [threadId]: 'running' });
    } else if (executionState === 'completed' || executionState === 'failed') {
      updateSessionAttention((current) => {
        if (!current[threadId]) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [executionState, threadId, updateSessionAttention]);
  useEffect(() => () => {
    if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
  }, [pendingImage]);
  useEffect(() => () => {
    if (newSessionImage) URL.revokeObjectURL(newSessionImage.previewUrl);
  }, [newSessionImage]);
  useEffect(() => {
    if (!newSessionDialogOpen) return undefined;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setNewSessionDialogOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [newSessionDialogOpen]);

  useLayoutEffect(() => {
    const element = messageListRef.current;
    if (!element) return;
    if (preserveScrollHeightRef.current != null) {
      element.scrollTop += element.scrollHeight - preserveScrollHeightRef.current;
      preserveScrollHeightRef.current = null;
      previousMessageScrollTopRef.current = element.scrollTop;
    } else if (shouldScrollBottomRef.current || autoFollowLatestRef.current) {
      shouldScrollBottomRef.current = false;
      const scrollToLatest = () => {
        element.scrollTop = element.scrollHeight;
        previousMessageScrollTopRef.current = element.scrollTop;
      };
      scrollToLatest();
      const frame = requestAnimationFrame(scrollToLatest);
      return () => cancelAnimationFrame(frame);
    }
  }, [
    timeline, executionState, attachmentUrls, fileDownload, approval,
    initialBootstrapPending,
  ]);

  useEffect(() => {
    const element = messageListRef.current;
    const content = messageContentRef.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const followResizedContent = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (autoFollowLatestRef.current && preserveScrollHeightRef.current == null) {
          element.scrollTop = element.scrollHeight;
        }
      });
    };
    const observer = new ResizeObserver(followResizedContent);
    observer.observe(element);
    observer.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [initialBootstrapPending, threadId]);

  const updateAutoFollowLatest = useCallback(() => {
    const element = messageListRef.current;
    if (!element) return;
    autoFollowLatestRef.current = isNearScrollBottom(element);
  }, []);

  useEffect(() => {
    if (executionState !== 'completed') return;
    const timer = setTimeout(() => setExecutionState('idle'), 3_000);
    return () => clearTimeout(timer);
  }, [executionState]);

  const addTimeline = useCallback((
    kind: TimelineKind,
    text: string,
    scroll = true,
    transient = false,
    attachment?: ImageAttachment,
  ) => {
    const item = { id: makeId(), kind, text, transient, attachment };
    if (scroll) {
      autoFollowLatestRef.current = true;
      shouldScrollBottomRef.current = true;
    }
    setTimeline((current) => kind === 'error'
      ? appendUniqueTimelineError(current, item)
      : [...current, item]);
    return item.id;
  }, []);

  const reportTimelineError = useCallback((error: unknown) => {
    if (isConnectionInterruption(error)) return;
    addTimeline('error', friendlyError(error));
  }, [addTimeline]);

  const rememberAttachment = useCallback((targetThreadId: string, text: string, attachment: ImageAttachment) => {
    if (!targetThreadId || !text.trim()) return;
    setKnownAttachments((current) => {
      const next = {
        ...current,
        [attachmentRegistryKey(targetThreadId, text)]: { ...attachment, savedAt: Date.now() },
      };
      const limited = Object.fromEntries(Object.entries(next)
        .sort((left, right) => left[1].savedAt - right[1].savedAt)
        .slice(-40));
      try { storeKnownAttachments(limited); } catch { /* keep in memory */ }
      return limited;
    });
  }, []);

  const appendStream = useCallback((kind: TimelineKind, text: string) => {
    if (!text) return;
    if (autoFollowLatestRef.current) shouldScrollBottomRef.current = true;
    const current = streamItemRef.current;
    if (current?.kind === kind) {
      setTimeline((items) => items.map((item) => item.id === current.id
        ? { ...item, text: `${item.text}${text}` }
        : item));
      return;
    }
    const id = makeId();
    streamItemRef.current = { id, kind };
    setTimeline((items) => [...items, {
      id, kind, text, transient: true,
      ...(activeTurnIdRef.current ? { historyTurnId: activeTurnIdRef.current } : {}),
    }]);
  }, []);

  const finishAssistant = useCallback((text: string, fileChanges?: TurnFileProgress) => {
    const content = parseAssistantMessage(text);
    const visibleText = content.text;
    if (!visibleText) return;
    if (autoFollowLatestRef.current) shouldScrollBottomRef.current = true;
    const current = streamItemRef.current;
    const completedAt = Date.now();
    streamItemRef.current = null;
    setTimeline((items) => {
      const nextItems = current?.kind === 'progress'
        && items.some((item) => item.id === current.id && isDuplicateFinalProgress(item.text, visibleText))
        ? items.filter((item) => item.id !== current.id)
        : items;
      if (current?.kind === 'assistant' && nextItems.some((item) => item.id === current.id)) {
        return nextItems.map((item) => item.id === current.id
          ? {
            ...item,
            text: visibleText,
            contexts: content.contexts,
            completedAt,
            ...(fileChanges ? { fileChanges } : {}),
          }
          : item);
      }
      return [...nextItems, {
        id: makeId(), kind: 'assistant', text: visibleText, contexts: content.contexts, transient: true,
        ...(activeTurnIdRef.current ? { historyTurnId: activeTurnIdRef.current } : {}),
        ...(fileChanges ? { fileChanges } : {}),
        completedAt,
      }];
    });
  }, []);

  const request = useCallback(<T,>(
    action: string,
    payload: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<T> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(t('连接未建立', 'Connection is not established')));
    const requestId = makeId();
    const timeoutMs = options.timeoutMs === undefined
      ? (action === 'turn.start' ? TURN_START_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
      : options.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const cleanup = () => {
        pendingRef.current.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        if (onAbort) options.signal?.removeEventListener('abort', onAbort);
      };
      const frame = { type: 'request', requestId, action, payload, deviceId: DEVICE_ID };
      const pending: PendingRequest = {
        resolve: (value) => { cleanup(); resolve(value as T); },
        reject: (reason) => { cleanup(); reject(reason); },
        timer: null,
        frame,
        acknowledged: false,
      };
      onAbort = () => pending.reject(new Error('download_cancelled'));
      if (options.signal?.aborted) {
        pending.reject(new Error('download_cancelled'));
        return;
      }
      if (timeoutMs != null) {
        pending.timer = setTimeout(() => {
          pending.reject(new Error(action === 'turn.start' ? 'turn_start_timeout' : 'request_timeout'));
        }, timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      pendingRef.current.set(requestId, pending);
      try {
        if (!secureChannelRef.current?.sendFrame(frame)) throw new Error('secure_channel_not_ready');
      } catch {
        pending.reject(new Error(t('连接已断开', 'Connection closed')));
      }
    });
  }, []);

  useEffect(() => {
    if (!threadId || !online) {
      setModelConfig(null);
      setModelConfigLoading(false);
      return undefined;
    }
    let disposed = false;
    setModelConfigLoading(true);
    void request<SessionModelConfig>('session.model-config.read', { threadId })
      .then((config) => {
        if (!disposed && threadIdRef.current === threadId) setModelConfig(config);
      })
      .catch(() => {
        if (!disposed && threadIdRef.current === threadId) setModelConfig(null);
      })
      .finally(() => {
        if (!disposed && threadIdRef.current === threadId) setModelConfigLoading(false);
      });
    return () => { disposed = true; };
  }, [online, request, threadId]);

  const saveModelConfig = useCallback(async (draft: ModelConfigDraft) => {
    const targetThreadId = threadIdRef.current;
    if (!targetThreadId) throw new Error('thread_id_required');
    const config = await request<SessionModelConfig>('session.model-config.update', {
      threadId: targetThreadId,
      ...draft,
    });
    if (threadIdRef.current === targetThreadId) setModelConfig(config);
  }, [request]);

  const replayPendingRequests = useCallback(() => {
    const channel = secureChannelRef.current;
    if (!channel?.isReady()) return 0;
    return replayPendingFrames(
      pendingRef.current.values(),
      (frame) => channel.sendFrame(frame),
    );
  }, []);

  const timelineAttachments = useMemo(() => {
    const attachments = new Map<string, ImageAttachment>();
    for (const item of timeline) {
      const attachment = resolveTimelineAttachment(item, threadId, knownAttachments);
      if (attachment) attachments.set(attachment.path, attachment);
    }
    return [...attachments.values()];
  }, [knownAttachments, threadId, timeline]);

  useEffect(() => {
    if (!online) return;
    for (const attachment of timelineAttachments) {
      if (Object.prototype.hasOwnProperty.call(attachmentUrls, attachment.path)
        || attachmentLoadsRef.current.has(attachment.path)) continue;
      attachmentLoadsRef.current.add(attachment.path);
      void request<DownloadedImage>('attachment.read', {
        path: attachment.path,
        source: attachment.source,
      })
        .then((image) => {
          if (!isValidImagePayload(image.mimeType, image.data)) throw new Error('attachment_content_mismatch');
          if (autoFollowLatestRef.current) shouldScrollBottomRef.current = true;
          setAttachmentUrls((current) => ({
            ...current,
            [attachment.path]: `data:${image.mimeType};base64,${image.data}`,
          }));
        })
        .catch(() => setAttachmentUrls((current) => ({ ...current, [attachment.path]: '' })))
        .finally(() => attachmentLoadsRef.current.delete(attachment.path));
    }
  }, [attachmentUrls, online, request, timelineAttachments]);

  const refreshSessions = useCallback(async () => {
    if (sessionRefreshInFlightRef.current) return [];
    sessionRefreshInFlightRef.current = true;
    try {
      const data = await request<{ sessions: Session[] }>('sessions.list', {});
      const nextSessions = data.sessions || [];
      setSessions(nextSessions);
      setSessionsInitialized(true);
      const currentThreadId = threadIdRef.current;
      updateSessionAttention((current) => reconcileSessionAttention(
        current,
        nextSessions,
        currentThreadId,
        runningRef.current ? ownedTurnThreadIdRef.current : null,
      ));
      if (currentThreadId) {
        const currentSession = nextSessions.find((session) => session.id === currentThreadId);
        if (currentSession) setActiveSession(currentSession);
      }
      return nextSessions;
    } catch {
      // Session refreshes are background synchronization. Connection status and
      // the next retry communicate failures without polluting the conversation.
      return [];
    } finally {
      sessionRefreshInFlightRef.current = false;
    }
  }, [request, updateSessionAttention]);

  const beginSecureChannel = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    secureChannelRef.current?.clear();
    const channel = new BrowserSecureChannel({
      identity: loadOrCreateBrowserDeviceIdentity(),
      routeDeviceId: DEVICE_ID,
      send: (frame) => {
        if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(frame));
        return true;
      },
      onFrame: (frame) => messageHandlerRef.current(frame as BridgeMessage),
      onReady: () => {
        if (secureChannelRef.current !== channel) return;
        connectorOnlineRef.current = true;
        setOnline(true);
        setStatusText(t('电脑在线', 'Computer online'));
        replayPendingRequests();
        void refreshSessions();
      },
      onError: () => {
        if (secureChannelRef.current !== channel) return;
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(t('安全通道中断，正在重连…', 'Secure channel interrupted. Reconnecting…'));
        if (socketRef.current === socket) socket.close(4410, 'secure channel failed');
      },
    });
    secureChannelRef.current = channel;
    return channel.start();
  }, [refreshSessions, replayPendingRequests]);

  const handleBridgeMessage = useCallback((message: BridgeMessage) => {
    if (message.type === 'auth.pairing') {
      setStatusText(t('当前设备等待批准', 'This device is waiting for approval'));
      return;
    }
    if (message.type === 'auth.ok') {
      approvedDeviceRef.current = true;
      markBrowserDeviceApproved();
      pairingCredentialRef.current = null;
      setPairingCredential(null);
      try {
        sessionStorage.removeItem(PENDING_PAIRING_KEY);
      } catch { /* blocked store */ }
      socketAuthenticatedRef.current = true;
      reconnectAttemptRef.current = 0;
      setAuthenticated(true);
      setConnecting(false);
      setConnectionEpoch((current) => current + 1);
      const connected = Boolean(message.devices?.includes(DEVICE_ID));
      if (connected) {
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(t('正在建立安全通道…', 'Establishing secure channel…'));
        beginSecureChannel();
      } else {
        secureChannelRef.current?.clear();
        secureChannelRef.current = null;
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(t('电脑离线', 'Computer offline'));
        finishInitialBootstrap();
      }
      return;
    }
    if (message.type === 'pong') return;
    if (message.type === 'ack' && message.requestId) {
      const pending = pendingRef.current.get(message.requestId);
      if (pending) pending.acknowledged = true;
      return;
    }
    if (message.type === 'presence') {
      const connected = Boolean(message.devices?.includes(DEVICE_ID));
      if (!connected) {
        secureChannelRef.current?.clear();
        secureChannelRef.current = null;
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(t('电脑离线', 'Computer offline'));
        finishInitialBootstrap();
      } else {
        if (!secureChannelRef.current?.isReady()) {
          connectorOnlineRef.current = false;
          setOnline(false);
          setStatusText(t('正在建立安全通道…', 'Establishing secure channel…'));
          if (!secureChannelRef.current) beginSecureChannel();
        }
      }
      return;
    }
    if (message.type === 'response' && message.requestId) {
      const pending = pendingRef.current.get(message.requestId);
      if (!pending) return;
      pendingRef.current.delete(message.requestId);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error || t('请求失败', 'Request failed')));
      return;
    }
    if (message.type !== 'event') return;
    const payload = message.payload || {};
    const eventThreadId = String(payload.threadId || '');
    if (
      message.event !== 'turn.started'
      && !isEventForSelectedThread(eventThreadId, threadIdRef.current, ownedTurnThreadIdRef.current)
    ) {
      if (eventThreadId) {
        updateSessionAttention((current) => current[eventThreadId] === 'running'
          ? current : { ...current, [eventThreadId]: 'running' });
      }
      if (message.event === 'turn.error' || message.event === 'turn.ended') {
        if (eventThreadId && ownedTurnThreadIdRef.current === eventThreadId) {
          runningRef.current = false;
          ownedTurnThreadIdRef.current = null;
          setRunning(false);
          setOwnedTurnThreadId(null);
          updateSessionAttention((current) => current[eventThreadId] === 'running'
            ? { ...current, [eventThreadId]: 'unread' } : current);
        }
        void refreshSessions();
      }
      return;
    }
    if (message.event === 'turn.started') {
      const selectedThreadId = threadIdRef.current;
      const previousOwnedThreadId = ownedTurnThreadIdRef.current;
      const nextThreadId = String(payload.threadId || '');
      activeTurnIdRef.current = String(payload.turnId || '');
      runningRef.current = true;
      ownedTurnThreadIdRef.current = nextThreadId || selectedThreadId || NEW_TURN_KEY;
      setOwnedTurnThreadId(ownedTurnThreadIdRef.current);
      setRunning(true);
      if (nextThreadId && nextThreadId !== selectedThreadId && previousOwnedThreadId !== NEW_TURN_KEY) {
        updateSessionAttention((current) => ({ ...current, [nextThreadId]: 'running' }));
        return;
      }
      setToolPurpose('');
      setActivityDetail('');
      setTurnProgress({});
      turnProgressRef.current = {};
      setLiveActivity('starting');
      setActivityStartedAt(Date.now());
      if (nextThreadId) {
        setThreadId(nextThreadId);
        threadIdRef.current = nextThreadId;
        localStorage.setItem('bridge.lastThreadId', nextThreadId);
        setCreatingNewSession(false);
        setExecutionState('running');
      }
    } else if (message.event === 'turn.delta') {
      setLiveActivity('responding');
      appendStream(payload.phase === 'final_answer' ? 'assistant' : 'progress', String(payload.delta || ''));
    } else if (message.event === 'turn.reasoning') {
      setLiveActivity('planning');
      const purpose = normalizeToolPurpose(payload.text);
      if (purpose) setToolPurpose(purpose);
    } else if (message.event === 'turn.progress') {
      const progress = normalizeTurnProgress(payload);
      turnProgressRef.current = { ...turnProgressRef.current, ...progress };
      setTurnProgress(turnProgressRef.current);
    } else if (message.event === 'tool.started') {
      setLiveActivity(liveEventActivity(payload));
      const detail = normalizeToolPurpose(payload.detail);
      if (detail) setActivityDetail(detail);
    } else if (message.event === 'tool.completed') {
      setLiveActivity('checking');
      const detail = normalizeToolPurpose(payload.detail);
      if (detail) setActivityDetail(`✓ ${detail}`);
    } else if (message.event === 'turn.final') {
      setLiveActivity('responding');
      const text = String(payload.text || '');
      finishAssistant(text, turnProgressRef.current.files);
    } else if (message.event === 'approval.requested') {
      const nextApproval = {
        approvalId: String(payload.approvalId || ''),
        threadId: String(payload.threadId || threadIdRef.current || ''),
        kind: String(payload.kind || 'action'),
        summary: String(payload.summary || ''),
        actionable: true,
      };
      if (!nextApproval.threadId || nextApproval.threadId === threadIdRef.current) {
        setApproval(nextApproval);
        setRunning(true);
        setOwnedTurnThreadId(nextApproval.threadId || threadIdRef.current || NEW_TURN_KEY);
        setExecutionState('waiting');
        setLiveActivity('waiting');
        setActivityStartedAt((current) => current || Date.now());
        autoFollowLatestRef.current = true;
        shouldScrollBottomRef.current = true;
      }
    } else if (message.event === 'turn.error') {
      streamItemRef.current = null;
      activeTurnIdRef.current = '';
      setApproval(null);
      setToolPurpose('');
      setActivityDetail('');
      setLiveActivity('working');
      setActivityStartedAt(null);
      setTurnProgress({});
      turnProgressRef.current = {};
      runningRef.current = false;
      ownedTurnThreadIdRef.current = null;
      setRunning(false);
      setOwnedTurnThreadId(null);
      setExecutionState('failed');
      addTimeline('error', String(payload.error || t('Codex 运行错误', 'Codex execution error')));
    } else if (message.event === 'turn.ended') {
      streamItemRef.current = null;
      activeTurnIdRef.current = '';
      setApproval(null);
      setToolPurpose('');
      setActivityDetail('');
      setLiveActivity('working');
      setActivityStartedAt(null);
      setTurnProgress({});
      turnProgressRef.current = {};
      runningRef.current = false;
      ownedTurnThreadIdRef.current = null;
      setRunning(false);
      setOwnedTurnThreadId(null);
      setExecutionState((current) => current === 'failed' ? current : 'completed');
      void refreshSessions();
    }
  }, [
    addTimeline, appendStream, beginSecureChannel, finishAssistant, finishInitialBootstrap,
    refreshSessions, updateSessionAttention,
  ]);

  useEffect(() => { messageHandlerRef.current = handleBridgeMessage; }, [handleBridgeMessage]);

  const rejectPendingRequests = useCallback((message: string) => {
    for (const pending of pendingRef.current.values()) {
      pending.reject(new Error(message));
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const clearPendingPairing = useCallback(() => {
    pairingCredentialRef.current = null;
    setPairingCredential(null);
    try { sessionStorage.removeItem(PENDING_PAIRING_KEY); } catch { /* blocked store */ }
  }, []);

  const hasAuthenticationMaterial = useCallback(() => (
    approvedDeviceRef.current
    || Boolean(pairingCredentialRef.current)
  ), []);

  const openSocket = useCallback((replaceExisting = false) => {
    if (!reconnectWantedRef.current || !hasAuthenticationMaterial()) return;
    if (navigator.onLine === false) {
      setConnecting(false);
      setOnline(false);
      setStatusText(t('等待网络恢复', 'Waiting for network'));
      return;
    }
    const existing = socketRef.current;
    if (existing && !replaceExisting && (
      existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING
    )) return;
    if (existing) {
      socketRef.current = null;
      existing.close(1000, 'connection replaced');
    }
    clearReconnectTimer();
    setConnecting(true);
    setStatusText(reconnectAttemptRef.current ? t('正在重新连接…', 'Reconnecting…') : t('正在连接…', 'Connecting…'));
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socketRef.current = socket;
    socketAuthenticatedRef.current = false;
    socket.addEventListener('message', (incoming) => {
      lastServerActivityRef.current = Date.now();
      try {
        const message = JSON.parse(String(incoming.data)) as BridgeMessage;
        if (message.type === 'auth.challenge') {
          const protocol = requireCurrentProtocol(message.protocol);
          const challenge = String(message.challenge || '');
          const pairing = pairingCredentialRef.current;
          if (pairing) {
            authAttemptModeRef.current = 'pairing';
            const identity = loadOrCreateBrowserDeviceIdentity();
            const proof = createBrowserPairingProof({
              verifier: browserPairingVerifier(pairing.secret),
              challenge,
              pairingId: pairing.id,
              deviceId: identity.id,
              publicKey: identity.publicKey,
            });
            const device = createBrowserDeviceProof({ challenge, role: 'client', authProof: proof });
            socket.send(JSON.stringify({
              type: 'auth.enroll', role: 'client', pairingId: pairing.id, proof, device, protocol,
            }));
          } else if (approvedDeviceRef.current) {
            authAttemptModeRef.current = 'device';
            const device = createBrowserDeviceProof({
              challenge, role: 'client', authProof: DEVICE_KEY_AUTH_CONTEXT,
            });
            socket.send(JSON.stringify({ type: 'auth.device', role: 'client', device, protocol }));
          } else {
            socket.close(4406, 'pairing required');
          }
          return;
        }
        if (secureChannelRef.current?.handle(message as Record<string, any>)) return;
        messageHandlerRef.current(message);
      } catch {
        if (!socketAuthenticatedRef.current) socket.close(4003, 'invalid authentication challenge');
      }
    });
    socket.addEventListener('close', (event) => {
      if (socketRef.current !== socket) return;
      const replayPending = reconnectWantedRef.current
        && ![4003, 4403, 4406, 4407, 4429].includes(event.code);
      socketRef.current = null;
      socketAuthenticatedRef.current = false;
      connectorOnlineRef.current = false;
      secureChannelRef.current?.clear();
      secureChannelRef.current = null;
      setConnecting(false);
      setOnline(false);
      setRunning(false);
      setOwnedTurnThreadId(null);
      if (!replayPending) rejectPendingRequests(t('连接已断开', 'Connection closed'));
      if (event.code === 4003) {
        reconnectWantedRef.current = false;
        finishInitialBootstrap();
        if (authAttemptModeRef.current === 'pairing') {
          clearPendingPairing();
          setStatusText(t('配对链接无效或已过期', 'Pairing link is invalid or expired'));
          return;
        }
        setAuthenticated(false);
        setStatusText(t('配对凭据无效或已过期', 'Pairing credential is invalid or expired'));
        return;
      }
      if (event.code === 4403) {
        setAuthenticated(false);
        finishInitialBootstrap();
        if (authAttemptModeRef.current === 'device') {
          approvedDeviceRef.current = false;
          clearBrowserDeviceApproval();
          reconnectWantedRef.current = false;
          setStatusText(t('这台设备的授权已失效，请重新配对', 'This device is no longer approved. Pair it again.'));
          return;
        }
        setStatusText(t('当前设备等待管理员批准…', 'Waiting for administrator approval…'));
        scheduleReconnectRef.current();
        return;
      }
      if (event.code === 4407) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        finishInitialBootstrap();
        setStatusText(t('设备身份验证失败', 'Device identity verification failed'));
        return;
      }
      if (event.code === 4406) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        finishInitialBootstrap();
        setStatusText(t('连接协议已更新，请刷新页面', 'Connection protocol updated. Refresh the page.'));
        return;
      }
      if (event.code === 4429) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        finishInitialBootstrap();
        setStatusText(t('登录尝试过多，请 15 分钟后重试', 'Too many login attempts. Try again in 15 minutes.'));
        return;
      }
      setStatusText(navigator.onLine === false
        ? t('等待网络恢复', 'Waiting for network')
        : t('连接中断，准备重连…', 'Connection lost. Reconnecting…'));
      scheduleReconnectRef.current();
    });
    socket.addEventListener('error', () => {
      if (socketRef.current === socket) setStatusText(t('连接失败', 'Connection failed'));
    });
  }, [clearPendingPairing, clearReconnectTimer, finishInitialBootstrap, hasAuthenticationMaterial, rejectPendingRequests]);

  const scheduleReconnect = useCallback((immediate = false) => {
    if (!reconnectWantedRef.current || !hasAuthenticationMaterial()) return;
    clearReconnectTimer();
    if (navigator.onLine === false) {
      setConnecting(false);
      setStatusText(t('等待网络恢复', 'Waiting for network'));
      return;
    }
    const attempt = reconnectAttemptRef.current;
    const delay = immediate
      ? 0
      : Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * (2 ** attempt)) + Math.floor(Math.random() * 500);
    reconnectAttemptRef.current = immediate ? attempt : attempt + 1;
    setConnecting(true);
    const seconds = Math.max(1, Math.ceil(delay / 1_000));
    setStatusText(delay
      ? t(`将在 ${seconds} 秒后重连…`, `Reconnecting in ${seconds}s…`)
      : t('正在重新连接…', 'Reconnecting…'));
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      openSocket(true);
    }, delay);
  }, [clearReconnectTimer, hasAuthenticationMaterial, openSocket]);

  useEffect(() => { scheduleReconnectRef.current = scheduleReconnect; }, [scheduleReconnect]);

  const pairBrowser = useCallback((credential: BrowserPairingCredential) => {
    const serialized = encodeBrowserPairingCredential(credential);
    pairingCredentialRef.current = credential;
    setPairingCredential(credential);
    approvedDeviceRef.current = false;
    clearBrowserDeviceApproval();
    try { sessionStorage.setItem(PENDING_PAIRING_KEY, serialized); } catch { /* memory only */ }
    authAttemptModeRef.current = 'pairing';
    reconnectWantedRef.current = true;
    reconnectAttemptRef.current = 0;
    setInitialBootstrapPending(true);
    setSessionsInitialized(false);
    setPairingDialogOpen(false);
    setStatusText(t('正在安全配对…', 'Pairing securely…'));
    openSocket(true);
  }, [openSocket]);

  useEffect(() => {
    reconnectWantedRef.current = hasAuthenticationMaterial();
    if (reconnectWantedRef.current) scheduleReconnect(true);

    const reconnectNow = () => {
      if (!reconnectWantedRef.current) return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && socketAuthenticatedRef.current) {
        if (lastServerActivityRef.current && Date.now() - lastServerActivityRef.current > CLIENT_STALE_AFTER_MS) {
          socket.close(4000, 'stale connection');
          return;
        }
        socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
        return;
      }
      reconnectAttemptRef.current = 0;
      scheduleReconnect(true);
    };
    const handleOnline = () => {
      if (!reconnectWantedRef.current) return;
      reconnectAttemptRef.current = 0;
      scheduleReconnect(true);
    };
    const handleOffline = () => {
      setOnline(false);
      setConnecting(false);
      setStatusText(t('等待网络恢复', 'Waiting for network'));
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      reconnectWantedRef.current = false;
      clearReconnectTimer();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      const socket = socketRef.current;
      socketRef.current = null;
      secureChannelRef.current?.clear();
      secureChannelRef.current = null;
      socket?.close(1000, 'page closed');
      rejectPendingRequests(t('页面已关闭', 'Page closed'));
    };
  }, [clearReconnectTimer, hasAuthenticationMaterial, rejectPendingRequests, scheduleReconnect]);

  useEffect(() => {
    const heartbeat = setInterval(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || !socketAuthenticatedRef.current) return;
      if (document.visibilityState === 'hidden') return;
      if (lastServerActivityRef.current && Date.now() - lastServerActivityRef.current > CLIENT_STALE_AFTER_MS) {
        socket.close(4000, 'heartbeat timeout');
        return;
      }
      socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
    }, CLIENT_HEARTBEAT_MS);
    return () => clearInterval(heartbeat);
  }, []);

  useEffect(() => {
    if (!authenticated || !online) return;
    const refreshVisibleSessions = () => {
      if (document.visibilityState === 'visible') void refreshSessions();
    };
    const timer = setInterval(refreshVisibleSessions, SESSION_STATUS_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshVisibleSessions);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisibleSessions);
    };
  }, [authenticated, online, refreshSessions]);

  const loadHistory = useCallback(async (targetThreadId: string, cursor: string | null, requestVersion: number) => {
    setHistoryLoading(true);
    if (cursor && messageListRef.current) preserveScrollHeightRef.current = messageListRef.current.scrollHeight;
    try {
      const page = await request<HistoryPage>('session.turns.list', {
        threadId: targetThreadId,
        cursor,
        limit: HISTORY_PAGE_SIZE,
        mode: 'conversation',
      });
      if (selectedRequestRef.current !== requestVersion || threadIdRef.current !== targetThreadId) return;
      const items = attachLatestAssistantFileChanges(historyItems(page.turns), page.turnProgress);
      if (cursor) setTimeline((current) => [...items, ...current]);
      else {
        autoFollowLatestRef.current = true;
        shouldScrollBottomRef.current = true;
        for (const item of items) {
          if (item.kind === 'progress') seedTypewriterText(progressTypewriterKey(item), item.text);
        }
        setTimeline(items);
        followFingerprintRef.current = historyFingerprint(page.turns, page.turnProgress);
        latestActivityIdRef.current = page.activityId || '';
        const latestStatus = page.turns[0]?.status;
        const active = latestStatus === 'inProgress';
        const failed = latestStatus === 'failed';
        setExecutionState(active ? 'running' : failed ? 'failed' : 'idle');
        setToolPurpose(active ? normalizeToolPurpose(page.toolPurpose) : '');
        setActivityDetail(active ? normalizeToolPurpose(page.activityDetail) : '');
        setLiveActivity(active ? safeActivityKind(page.activityKind || (page.toolPurpose ? 'planning' : 'working')) : 'working');
        setActivityStartedAt(active
          ? epochMillis(page.activityStartedAt || page.turns[0]?.startedAt) || Date.now()
          : null);
        setTurnProgress(active ? normalizeTurnProgress(page.turnProgress) : {});
      }
      setNextCursor(page.nextCursor || null);
      setInitialHistoryLoaded(true);
    } catch (error) {
      if (selectedRequestRef.current === requestVersion) reportTimelineError(error);
    } finally {
      if (selectedRequestRef.current === requestVersion) setHistoryLoading(false);
    }
  }, [reportTimelineError, request]);

  useEffect(() => {
    if (!threadId) {
      followFingerprintRef.current = '';
      setFollowState('idle');
      return;
    }
    if (!initialHistoryLoaded || running || !online) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number) => {
      if (!disposed) timer = setTimeout(pollLatest, delay);
    };
    const pollLatest = async () => {
      if (disposed) return;
      if (document.visibilityState === 'hidden') {
        schedule(8_000);
        return;
      }
      try {
        const page = await request<HistoryPage>('session.turns.list', {
          threadId,
          limit: 2,
          mode: 'live',
        });
        if (disposed || threadIdRef.current !== threadId) return;
        const fingerprint = historyFingerprint(page.turns, page.turnProgress);
        const previousFingerprint = followFingerprintRef.current;
        const changed = Boolean(previousFingerprint && previousFingerprint !== fingerprint);
        const latestStatus = page.turns[0]?.status;
        const inProgress = latestStatus === 'inProgress';
        const failed = latestStatus === 'failed';
        setToolPurpose((current) => {
          if (!inProgress) return '';
          return normalizeToolPurpose(page.toolPurpose) || current;
        });
        setActivityDetail(inProgress ? normalizeToolPurpose(page.activityDetail) : '');
        setLiveActivity(inProgress ? safeActivityKind(page.activityKind || (page.toolPurpose ? 'planning' : 'working')) : 'working');
        setActivityStartedAt((current) => (inProgress
          ? epochMillis(page.activityStartedAt || page.turns[0]?.startedAt) || current || Date.now()
          : null));
        setTurnProgress(inProgress ? normalizeTurnProgress(page.turnProgress) : {});
        const latestItems = attachLatestAssistantFileChanges(historyItems(page.turns), page.turnProgress);
        if (liveHistoryHydratedThreadRef.current !== threadId) {
          const liveProgressId = latestTurnProgressItemId(latestItems);
          const liveProgress = latestItems.find((item) => item.id === liveProgressId);
          if (liveProgress) seedTypewriterText(progressTypewriterKey(liveProgress), liveProgress.text);
          liveHistoryHydratedThreadRef.current = threadId;
        }
        const awaitingDesktopTurn = awaitingDesktopTurnRef.current;
        const awaitedMessageSeen = Boolean(awaitingDesktopTurn
          && latestItems.some((item) => item.kind === 'user' && item.text.trim() === awaitingDesktopTurn.text));
        const newActivitySeen = Boolean(awaitingDesktopTurn
          && awaitingDesktopTurn.previousActivityId
          && page.activityId
          && page.activityId !== awaitingDesktopTurn.previousActivityId);
        if (awaitingDesktopTurn && (awaitedMessageSeen || newActivitySeen)) {
          awaitingDesktopTurn.seen = true;
          if (page.activityId) awaitingDesktopTurn.activityId = page.activityId;
        }
        followFingerprintRef.current = fingerprint;
        latestActivityIdRef.current = page.activityId || latestActivityIdRef.current;
        setFollowState(inProgress || changed ? 'following' : 'synced');

        if (inProgress) setExecutionState('running');
        else if (failed) {
          awaitingDesktopTurnRef.current = null;
          setExecutionState('failed');
        } else if (
          awaitingDesktopTurn?.seen
          && latestStatus === 'completed'
          && (!awaitingDesktopTurn.activityId || !page.activityId || awaitingDesktopTurn.activityId === page.activityId)
        ) {
          awaitingDesktopTurnRef.current = null;
          setExecutionState('completed');
        } else if (!awaitingDesktopTurn && latestStatus === 'completed') {
          setExecutionState((current) => current === 'running' || current === 'waiting' ? 'completed' : current);
        }

        if (!previousFingerprint || previousFingerprint !== fingerprint) {
          if (autoFollowLatestRef.current) shouldScrollBottomRef.current = true;
          const latestTurnIds = new Set(page.turns.map((turn) => turn.id));
          setTimeline((current) => mergeHistorySnapshot(current, latestItems, latestTurnIds));
        }
        schedule(inProgress || changed ? 1_500 : 6_000);
      } catch {
        if (disposed) return;
        setFollowState('error');
        schedule(8_000);
      }
    };

    setFollowState('checking');
    schedule(800);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [initialHistoryLoaded, online, request, running, threadId]);

  const selectSession = useCallback((session: Session | null) => {
    const nextThreadId = session?.id || null;
    if (nextThreadId) {
      updateSessionAttention((current) => markSessionAttentionRead(current, nextThreadId));
    }
    if (nextThreadId && nextThreadId === threadIdRef.current) {
      setActiveSession(session);
      setDrawerOpen(false);
      return;
    }
    optimisticRestoreRef.current = null;
    selectedRequestRef.current += 1;
    const requestVersion = selectedRequestRef.current;
    setActiveSession(session);
    setThreadId(nextThreadId);
    threadIdRef.current = nextThreadId;
    setCreatingNewSession(false);
    if (nextThreadId) localStorage.setItem('bridge.lastThreadId', nextThreadId);
    setTimeline([]);
    preserveScrollHeightRef.current = null;
    previousMessageScrollTopRef.current = 0;
    olderHistoryLoadingRef.current = false;
    setAttachmentUrls({});
    attachmentLoadsRef.current.clear();
    setNextCursor(null);
    setInitialHistoryLoaded(!nextThreadId);
    setHistoryLoading(false);
    liveHistoryHydratedThreadRef.current = null;
    followFingerprintRef.current = '';
    latestActivityIdRef.current = '';
    awaitingDesktopTurnRef.current = null;
    setFollowState(nextThreadId ? 'checking' : 'idle');
    setExecutionState('idle');
    setToolPurpose('');
    setActivityDetail('');
    setLiveActivity('working');
    setActivityStartedAt(null);
    setTurnProgress({});
    setApproval(null);
    autoFollowLatestRef.current = true;
    streamItemRef.current = null;
    activeTurnIdRef.current = '';
    setDrawerOpen(false);
    if (nextThreadId) void loadHistory(nextThreadId, null, requestVersion);
  }, [loadHistory, updateSessionAttention]);

  const beginNewSession = useCallback(() => {
    setNewSessionPrompt('');
    setNewSessionImage(null);
    setNewSessionError('');
    setSearchOpen(false);
    setSessionSearch('');
    setDrawerOpen(false);
    setNewSessionDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!authenticated || !online || !connectionEpoch || creatingNewSession || threadId) return;
    const previousThreadId = localStorage.getItem('bridge.lastThreadId');
    if (!previousThreadId) return;
    selectSession({ id: previousThreadId, title: '' });
    optimisticRestoreRef.current = previousThreadId;
  }, [authenticated, connectionEpoch, creatingNewSession, online, selectSession, threadId]);

  useEffect(() => {
    const restoredThreadId = optimisticRestoreRef.current;
    if (!restoredThreadId || !sessions.length || threadId !== restoredThreadId) return;
    optimisticRestoreRef.current = null;
    const restoredSession = sessions.find((session) => session.id === restoredThreadId);
    if (restoredSession) setActiveSession(restoredSession);
    else selectSession(sessions[0]);
  }, [selectSession, sessions, threadId]);

  useEffect(() => {
    if (!authenticated || creatingNewSession || threadId || !sessions.length) return;
    const previousThreadId = localStorage.getItem('bridge.lastThreadId');
    const initialSession = sessions.find((session) => session.id === previousThreadId) || sessions[0];
    selectSession(initialSession);
  }, [authenticated, creatingNewSession, selectSession, sessions, threadId]);

  useEffect(() => {
    if (initialBootstrapPending && initialBootstrapReady(
      authenticated,
      sessionsInitialized,
      sessions.length,
      threadId,
      initialHistoryLoaded,
    )) finishInitialBootstrap();
  }, [
    authenticated, finishInitialBootstrap, initialBootstrapPending, initialHistoryLoaded,
    sessions.length, sessionsInitialized, threadId,
  ]);

  useEffect(() => {
    if (!initialBootstrapPending) return undefined;
    const timer = setTimeout(finishInitialBootstrap, INITIAL_BOOTSTRAP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [finishInitialBootstrap, initialBootstrapPending]);

  const loadOlder = useCallback(() => {
    if (!threadId || !nextCursor || olderHistoryLoadingRef.current) return;
    olderHistoryLoadingRef.current = true;
    void loadHistory(threadId, nextCursor, selectedRequestRef.current)
      .finally(() => { olderHistoryLoadingRef.current = false; });
  }, [loadHistory, nextCursor, threadId]);

  const handleMessageScroll = useCallback(() => {
    const element = messageListRef.current;
    if (!element) return;
    const previousScrollTop = previousMessageScrollTopRef.current;
    const currentScrollTop = Math.max(0, element.scrollTop);
    previousMessageScrollTopRef.current = currentScrollTop;
    updateAutoFollowLatest();
    if (currentScrollTop < previousScrollTop && shouldLoadOlderHistory(
      element, nextCursor, initialHistoryLoaded, historyLoading,
    )) loadOlder();
  }, [historyLoading, initialHistoryLoaded, loadOlder, nextCursor, updateAutoFollowLatest]);

  useEffect(() => {
    const element = messageListRef.current;
    if (element && shouldPrefillOlderHistory(
      element, nextCursor, initialHistoryLoaded, historyLoading,
    )) loadOlder();
  }, [
    historyLoading, initialBootstrapPending, initialHistoryLoaded, loadOlder, nextCursor, timeline,
  ]);

  const chooseImage = useCallback(async (file?: File) => {
    if (!file) return;
    try {
      const prepared = await prepareImageFile(file);
      setPendingImage({
        file: prepared.file,
        transferPreview: prepared.preview,
        previewUrl: URL.createObjectURL(prepared.file),
      });
    } catch (error) {
      reportTimelineError(error);
    }
  }, [reportTimelineError]);

  const chooseNewSessionImage = useCallback(async (file?: File) => {
    if (!file) return;
    try {
      const prepared = await prepareImageFile(file);
      setNewSessionImage({
        file: prepared.file,
        transferPreview: prepared.preview,
        previewUrl: URL.createObjectURL(prepared.file),
      });
      setNewSessionError('');
    } catch (error) {
      setNewSessionError(friendlyError(error));
    }
  }, []);

  const submitNewSession = useCallback(() => {
    const projectCwd = newSessionCwd.trim();
    const text = newSessionPrompt.trim();
    if (!projectCwd) {
      setNewSessionError(t('请选择或填写项目目录。', 'Choose or enter a project directory.'));
      return;
    }
    if (!text && !newSessionImage) {
      setNewSessionError(t('请输入第一条消息或添加图片。', 'Enter the first message or add an image.'));
      return;
    }
    const transferredImage = newSessionImage ? {
      file: newSessionImage.file,
      transferPreview: newSessionImage.transferPreview,
      previewUrl: URL.createObjectURL(newSessionImage.file),
    } : null;
    selectSession(null);
    setCreatingNewSession(true);
    setPrompt(text);
    setPendingImage(transferredImage);
    setNewSessionPrompt('');
    setNewSessionImage(null);
    setNewSessionError('');
    setNewSessionDialogOpen(false);
    newSessionAutoSendRef.current = true;
  }, [newSessionCwd, newSessionImage, newSessionPrompt, selectSession]);

  const sendTurn = useCallback(async () => {
    const text = prompt.trim();
    const image = pendingImage;
    const targetThreadId = threadIdRef.current;
    const steering = canSteerOwnedTurn(
      running, executionState, ownedTurnThreadId, targetThreadId,
    );
    const directDesktopDelivery = canSendToActiveDesktopTurn(
      running, executionState, ownedTurnThreadId, targetThreadId,
    );
    if (
      (!text && !image)
      || uploading
      || sendingRef.current
      || (running && !steering)
      || (steering && Boolean(image))
    ) return;
    const isExistingSession = Boolean(threadIdRef.current);
    const projectCwd = newSessionCwd.trim();
    if (!isExistingSession && !projectCwd) {
      addTimeline('error', t('请先填写新会话的项目目录。', 'Enter a project directory for the new session.'));
      return;
    }
    if (!isExistingSession) localStorage.setItem('bridge.newSessionCwd', projectCwd);
    sendingRef.current = true;
    let turnText = text;
    let visibleText = text;
    let timelineAttachment: ImageAttachment | undefined;
    let optimisticItemId = '';
    let composerCleared = false;
    if (image) setUploading(true);
    try {
      if (image) {
        const encoded = await fileToBase64(image.file);
        const previewEncoded = image.transferPreview ? await fileToBase64(image.transferPreview) : '';
        const uploaded = await request<UploadedImage>('attachment.upload', {
          name: image.file.name,
          mimeType: image.file.type,
          size: image.file.size,
          data: encoded,
          preview: image.transferPreview ? {
            mimeType: image.transferPreview.type,
            size: image.transferPreview.size,
            data: previewEncoded,
          } : undefined,
        });
        const imageMessage = buildImageMessage(text, uploaded);
        turnText = imageMessage.turnText;
        visibleText = imageMessage.visibleText;
        timelineAttachment = { path: uploaded.path, name: uploaded.name };
        if (threadIdRef.current) rememberAttachment(threadIdRef.current, visibleText, timelineAttachment);
        setAttachmentUrls((current) => ({
          ...current,
          [uploaded.path]: image.transferPreview
            ? `data:${image.transferPreview.type};base64,${previewEncoded}`
            : `data:${uploaded.mimeType};base64,${encoded}`,
        }));
      }
      setUploading(false);
      setPrompt('');
      setPendingImage(null);
      composerCleared = true;
      optimisticItemId = addTimeline('user', visibleText, true, true, timelineAttachment);
      streamItemRef.current = null;
      if (!steering) activeTurnIdRef.current = '';
      if (!steering) {
        runningRef.current = true;
        setRunning(true);
        ownedTurnThreadIdRef.current = threadIdRef.current || NEW_TURN_KEY;
        setOwnedTurnThreadId(ownedTurnThreadIdRef.current);
        setExecutionState('running');
        setLiveActivity('starting');
        setActivityStartedAt(Date.now());
        setTurnProgress({});
      }
      const action = steering ? 'turn.steer' : 'turn.start';
      const data = await request<TurnStartResult>(action, {
        text: turnText,
        threadId: threadIdRef.current,
        ...(steering ? {} : {
          cwd: isExistingSession ? '' : projectCwd,
          ...(directDesktopDelivery ? { preferDesktop: true } : {}),
        }),
      });
      const sentAt = Date.now();
      if (optimisticItemId) {
        setTimeline((current) => current.map((item) => item.id === optimisticItemId
          ? { ...item, completedAt: sentAt }
          : item));
      }
      if (data.threadId) {
        setOwnedTurnThreadId(data.delivery === 'desktop' ? null : data.threadId);
        setThreadId(data.threadId);
        threadIdRef.current = data.threadId;
        localStorage.setItem('bridge.lastThreadId', data.threadId);
        setCreatingNewSession(false);
        if (!isExistingSession) {
          setActiveSession({
            id: data.threadId,
            title: visibleText.split(/\r?\n/, 1)[0]?.slice(0, 80) || t('新会话', 'New session'),
            cwd: projectCwd,
            updatedAt: Date.now(),
            status: 'inProgress',
          });
        }
        if (timelineAttachment) rememberAttachment(data.threadId, visibleText, timelineAttachment);
      }
      if (data.delivery === 'desktop') {
        setRunning(false);
        setOwnedTurnThreadId(null);
        awaitingDesktopTurnRef.current = {
          text: visibleText,
          previousActivityId: latestActivityIdRef.current,
          activityId: '',
          seen: false,
        };
        setExecutionState('running');
        setFollowState('following');
      }
    } catch (error) {
      setUploading(false);
      if (!steering) {
        setRunning(false);
        setOwnedTurnThreadId(null);
        setExecutionState('idle');
        setLiveActivity('working');
        setActivityStartedAt(null);
        setTurnProgress({});
      }
      if (optimisticItemId) {
        setTimeline((current) => current.filter((item) => item.id !== optimisticItemId));
      }
      if (composerCleared) {
        setPrompt((current) => current.trim() ? current : text);
        if (image) setPendingImage((current) => current || {
          file: image.file,
          transferPreview: image.transferPreview,
          previewUrl: URL.createObjectURL(image.file),
        });
      }
      if (error instanceof Error && error.message === 'turn_cancelled') {
        return;
      }
      reportTimelineError(error);
    } finally {
      sendingRef.current = false;
    }
  }, [
    addTimeline, executionState, modelConfig, newSessionCwd, ownedTurnThreadId, pendingImage, prompt,
    rememberAttachment, reportTimelineError, request, running, uploading,
  ]);

  useEffect(() => {
    if (!creatingNewSession || !newSessionAutoSendRef.current || running || uploading) return;
    newSessionAutoSendRef.current = false;
    void sendTurn();
  }, [creatingNewSession, pendingImage, prompt, running, sendTurn, uploading]);

  const stopTurn = useCallback(async () => {
    try { await request('turn.stop', {}); } catch (error) { reportTimelineError(error); }
    setRunning(false);
    setOwnedTurnThreadId(null);
    awaitingDesktopTurnRef.current = null;
    setExecutionState('idle');
    setLiveActivity('working');
    setActivityStartedAt(null);
    setTurnProgress({});
  }, [reportTimelineError, request]);

  const answerApproval = useCallback(async (approved: boolean) => {
    if (!approval || approval.actionable === false) return;
    const current = approval;
    setApproval(null);
    try {
      await request('approval.respond', {
        approvalId: current.approvalId,
        threadId: current.threadId,
        approved,
      });
    } catch (error) {
      setApproval(current);
      reportTimelineError(error);
    }
  }, [approval, reportTimelineError, request]);

  useEffect(() => {
    if (!authenticated || !online || !threadId) {
      setApproval(null);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const syncApproval = async () => {
      try {
        const result = await request<PendingApprovals>('approval.pending', { threadId });
        if (disposed || threadIdRef.current !== threadId) return;
        const pending = result.approvals?.[0] || result.externalApproval || null;
        if (pending) {
          setApproval(pending);
          const webOwned = pending.actionable !== false;
          setRunning(webOwned);
          setOwnedTurnThreadId(webOwned ? (pending.threadId || threadId) : null);
          setExecutionState('waiting');
          setLiveActivity('waiting');
          setActivityStartedAt((current) => current || Date.now());
          autoFollowLatestRef.current = true;
          shouldScrollBottomRef.current = true;
        } else if (approval?.actionable === false) {
          setApproval(null);
          setRunning(false);
          setOwnedTurnThreadId(null);
          setExecutionState('running');
          setLiveActivity('working');
        }
        if (pending?.actionable === false || executionState === 'running' || executionState === 'waiting') {
          timer = setTimeout(syncApproval, 4_000);
        }
      } catch { /* session history polling remains the fallback */ }
    };
    void syncApproval();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [approval?.actionable, authenticated, connectionEpoch, executionState, online, request, threadId]);

  const acquireDownloadWakeLock = useCallback(async () => {
    if (!fileDownloadRef.current || document.visibilityState !== 'visible'
      || (downloadWakeLockRef.current && !downloadWakeLockRef.current.released)) return;
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (!wakeLock?.request) {
      setFileDownload((current) => (current ? { ...current, protection: 'foreground-only' } : current));
      return;
    }
    try {
      const sentinel = await wakeLock.request('screen');
      if (!fileDownloadRef.current) {
        await sentinel.release().catch(() => {});
        return;
      }
      downloadWakeLockRef.current = sentinel;
      setFileDownload((current) => (current ? { ...current, protection: 'screen-awake' } : current));
    } catch {
      setFileDownload((current) => (current ? { ...current, protection: 'foreground-only' } : current));
    }
  }, []);

  const releaseDownloadWakeLock = useCallback(async () => {
    const sentinel = downloadWakeLockRef.current;
    downloadWakeLockRef.current = null;
    if (sentinel && !sentinel.released) await sentinel.release().catch(() => {});
  }, []);

  useEffect(() => {
    if (!fileDownloadRef.current) return;
    const paused = !downloadCanContinue({
      visible: document.visibilityState === 'visible',
      online,
      channelReady: Boolean(secureChannelRef.current?.isReady()),
    });
    setFileDownload((current) => (current ? { ...current, paused } : current));
  }, [online]);

  useEffect(() => {
    const syncDownloadVisibility = () => {
      if (!fileDownloadRef.current) return;
      const visible = document.visibilityState === 'visible';
      setFileDownload((current) => (current ? {
        ...current,
        paused: !downloadCanContinue({
          visible,
          online: connectorOnlineRef.current,
          channelReady: Boolean(secureChannelRef.current?.isReady()),
        }),
      } : current));
      if (visible) void acquireDownloadWakeLock();
    };
    document.addEventListener('visibilitychange', syncDownloadVisibility);
    return () => document.removeEventListener('visibilitychange', syncDownloadVisibility);
  }, [acquireDownloadWakeLock]);

  const downloadLocalFile = useCallback(async (path: string) => {
    if (fileDownloadRef.current) return;
    const wakeLockSupported = Boolean((navigator as WakeLockNavigator).wakeLock?.request);
    const accepted = window.confirm(
      t(
        `是否从这台电脑下载以下文件？\n\n${path}\n\n${wakeLockSupported ? '下载期间会尝试保持屏幕常亮；若系统仍暂停，回到本页后会从当前位置继续。' : '当前浏览器不支持可靠的后台下载，请保持屏幕亮起并停留在本页。'}`,
        `Download this file from your computer?\n\n${path}\n\n${wakeLockSupported ? 'The page will try to keep the screen awake. If the system still pauses it, return here to resume from the current position.' : 'This browser cannot provide reliable background downloads. Keep the screen awake and stay on this page.'}`,
      ),
    );
    if (!accepted) return;
    fileDownloadRef.current = true;
    fileDownloadCancelRef.current = false;
    const abortController = new AbortController();
    fileDownloadAbortRef.current = abortController;
    setFileDownload({
      name: localFileName(path), size: 0, received: 0, paused: !online, protection: 'checking',
    });
    void acquireDownloadWakeLock();
    let opened: OpenedDownload | null = null;
    let completed = false;
    try {
      const waitUntilReady = async () => {
        await waitForDownloadReady({
          signal: abortController.signal,
          isReady: () => downloadCanContinue({
            visible: document.visibilityState === 'visible',
            online: connectorOnlineRef.current,
            channelReady: Boolean(secureChannelRef.current?.isReady()),
          }),
          onPause: () => setFileDownload((current) => (current ? { ...current, paused: true } : current)),
        });
        setFileDownload((current) => (current ? { ...current, paused: false } : current));
      };
      await waitUntilReady();
      opened = await request<OpenedDownload>(
        'file.download.open',
        { path, confirmed: true },
        { timeoutMs: null, signal: abortController.signal },
      );
      if (!opened.downloadId || !opened.downloadToken || !Number.isSafeInteger(opened.size) || opened.size < 0) {
        throw new Error('download_capability_invalid');
      }
      setFileDownload((current) => ({
        name: opened!.name,
        size: opened!.size,
        received: 0,
        paused: false,
        protection: current?.protection || 'checking',
      }));
      const parts: BlobPart[] = [];
      let offset = 0;
      while (true) {
        if (fileDownloadCancelRef.current) throw new Error('download_cancelled');
        await waitUntilReady();
        const chunk = await request<DownloadFileChunk>('file.download.chunk', {
          downloadId: opened.downloadId,
          downloadToken: opened.downloadToken,
          offset,
        }, { timeoutMs: null, signal: abortController.signal });
        if (fileDownloadCancelRef.current) throw new Error('download_cancelled');
        const emptyComplete = opened.size === 0 && chunk.done && chunk.nextOffset === 0;
        if (chunk.offset !== offset || !Number.isSafeInteger(chunk.nextOffset)
          || (!emptyComplete && chunk.nextOffset <= offset) || chunk.nextOffset > opened.size) {
          throw new Error('download_chunk_invalid');
        }
        const bytes = decodeBase64Chunk(chunk.data);
        if (bytes.byteLength !== chunk.nextOffset - offset) throw new Error('download_chunk_invalid');
        parts.push(bytes);
        offset = chunk.nextOffset;
        setFileDownload((current) => (current ? {
          ...current,
          name: opened!.name,
          size: opened!.size,
          received: offset,
          paused: !downloadCanContinue({
            visible: document.visibilityState === 'visible',
            online: connectorOnlineRef.current,
            channelReady: Boolean(secureChannelRef.current?.isReady()),
          }),
        } : current));
        if (chunk.done) break;
      }
      completed = true;
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = safeDownloadName(opened.name);
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      if (!(error instanceof Error && error.message === 'download_cancelled')) {
        reportTimelineError(error);
      }
    } finally {
      if (opened && !completed) {
        void request('file.download.close', {
          downloadId: opened.downloadId,
          downloadToken: opened.downloadToken,
        }).catch(() => {});
      }
      fileDownloadRef.current = false;
      fileDownloadCancelRef.current = false;
      if (fileDownloadAbortRef.current === abortController) fileDownloadAbortRef.current = null;
      await releaseDownloadWakeLock();
      setFileDownload(null);
    }
  }, [acquireDownloadWakeLock, online, releaseDownloadWakeLock, reportTimelineError, request]);

  const readVisualization = useCallback(async (path: string) => {
    const result = await request<VisualizationDocument>('visualization.read', { path });
    if (result?.content && result.content.length <= 2 * 1024 * 1024 && !result.content.includes('\0')) {
      return URL.createObjectURL(new Blob([result.content], { type: 'text/html' }));
    }
    throw new Error('visualization_content_invalid');
  }, [request]);

  const cancelFileDownload = useCallback(() => {
    fileDownloadCancelRef.current = true;
    fileDownloadAbortRef.current?.abort();
  }, []);

  const filteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLocaleLowerCase();
    const matches = query
      ? sessions.filter((session) => `${session.title} ${session.cwd || ''} ${session.preview || ''}`
        .toLocaleLowerCase().includes(query))
      : sessions;
    return [...matches].sort((left, right) => sessionUpdatedAt(right.updatedAt) - sessionUpdatedAt(left.updatedAt));
  }, [sessionSearch, sessions]);

  const existingProjects = useMemo(() => {
    const seen = new Set<string>();
    const projects: string[] = [];
    for (const session of sessions) {
      const cwd = String(session.cwd || '').trim();
      const key = cwd.toLocaleLowerCase();
      if (!cwd || session.canStartNewSession === false || isTemporaryProjectPath(cwd) || seen.has(key)) continue;
      seen.add(key);
      projects.push(cwd);
    }
    return projects;
  }, [sessions]);
  const selectedExistingProject = existingProjects.find((project) => (
    project.toLocaleLowerCase() === newSessionCwd.trim().toLocaleLowerCase()
  )) || '';
  const steeringAvailable = canSteerOwnedTurn(
    running, executionState, ownedTurnThreadId, threadId,
  );
  const directDesktopDeliveryAvailable = canSendToActiveDesktopTurn(
    running, executionState, ownedTurnThreadId, threadId,
  );
  const stopAvailable = canStopOwnedTurn(
    running, ownedTurnThreadId, threadId || (creatingNewSession ? NEW_TURN_KEY : null),
  );
  const primaryAction = composerPrimaryAction(stopAvailable, prompt, Boolean(pendingImage));
  const primaryStopsRun = primaryAction === 'stop';
  const executionActive = executionState === 'running' || executionState === 'waiting';
  const liveProgressItemId = useMemo(
    () => executionActive ? latestTurnProgressItemId(timeline) : null,
    [executionActive, timeline],
  );

  if (initialBootstrapPending) return <StartupScreen status={statusText} />;

  if (!authenticated) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">C</div>
          <p className="eyebrow">PRIVATE BRIDGE</p>
          <h1>{t('连接本机 Codex', 'Connect to local Codex')}</h1>
          <p className="login-copy">{t('使用管理员生成的十分钟单次配对链接连接这台设备。', 'Connect this device with a ten-minute, single-use pairing link from the administrator.')}</p>
          <button type="button" className="pair-device-button" onClick={() => setPairingDialogOpen(true)}>
            {connecting ? t('连接中…', 'Connecting…') : t('输入配对链接', 'Enter pairing link')}
          </button>
          <div className="login-status">{statusText}</div>
        </section>
        {pairingDialogOpen && (
          <Suspense fallback={null}>
            <PairingDialog
              open
              onClose={() => setPairingDialogOpen(false)}
              onPair={pairBrowser}
            />
          </Suspense>
        )}
      </main>
    );
  }

  return (
    <main className="app-shell">
      {drawerOpen && <button className="drawer-backdrop" aria-label={t('关闭会话列表', 'Close session list')} onClick={() => setDrawerOpen(false)} />}
      <aside className={`sidebar ${drawerOpen ? 'open' : ''}`} aria-label={t('会话列表', 'Session list')}>
        <div className="sidebar-head">
          <div>
            <p className="eyebrow">CODEX ANYWHERE</p>
          </div>
          <div className="sidebar-actions">
            <button className="sidebar-tool" onClick={beginNewSession} aria-label={t('新会话', 'New session')} title={t('新会话', 'New session')}>
              <SidebarIcon name="plus" />
            </button>
            <button
              className={`sidebar-tool ${searchOpen ? 'active' : ''}`}
              onClick={() => {
                if (searchOpen) setSessionSearch('');
                setSearchOpen((open) => !open);
              }}
              aria-label={searchOpen ? t('收起搜索', 'Collapse search') : t('搜索会话', 'Search sessions')}
              title={searchOpen ? t('收起搜索', 'Collapse search') : t('搜索会话', 'Search sessions')}
            >
              <SidebarIcon name="search" />
            </button>
            <button className="sidebar-tool mobile-only" onClick={() => setDrawerOpen(false)} aria-label={t('收起会话列表', 'Collapse session list')} title={t('收起会话列表', 'Collapse session list')}>
              <SidebarIcon name="panel-close" />
            </button>
          </div>
        </div>
        {searchOpen && (
          <label className="compact-search session-search-panel">
            <span className="compact-search-icon"><SidebarIcon name="search" /></span>
            <input
              autoFocus
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSessionSearch('');
                  setSearchOpen(false);
                }
              }}
              placeholder={t('搜索会话或目录', 'Search sessions or folders')}
            />
          </label>
        )}
        <nav className="session-list">
          {filteredSessions.map((session) => {
            const sessionRunning = isSessionRunning(session.status)
              || (session.id === threadId && (executionState === 'running' || executionState === 'waiting'));
            const completedUnread = !sessionRunning && sessionAttention[session.id] === 'unread';
            const projectName = sessionProjectName(session.cwd);
            return (
              <button
                key={session.id}
                className={`session-card ${threadId === session.id ? 'active' : ''} ${sessionRunning ? 'running' : ''} ${completedUnread ? 'completed-unread' : ''}`}
                onClick={() => selectSession(session)}
              >
                <span className="session-title" title={session.title || session.id}>{session.title || session.id}</span>
                <span className="session-meta">
                  {sessionRunning && <span className="session-running-dot" aria-label={t('运行中', 'Running')} title={t('运行中', 'Running')} />}
                  {completedUnread && <span className="session-unread-dot" aria-label={t('已完成，未读', 'Completed, unread')} title={t('已完成，未读', 'Completed, unread')} />}
                  <span
                    className={projectName ? 'session-project' : 'session-project placeholder'}
                    title={projectName ? session.cwd : undefined}
                  >
                    {projectName || 'General session'}
                  </span>
                  <time>{formatDate(session.updatedAt)}</time>
                </span>
              </button>
            );
          })}
          {!filteredSessions.length && <p className="empty-list">{t('没有匹配的会话', 'No matching sessions')}</p>}
        </nav>
      </aside>

      {newSessionDialogOpen && (
        <div
          className="new-session-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNewSessionDialogOpen(false);
          }}
        >
          <section className="new-session-dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
            <header className="new-session-dialog-head">
              <p className="eyebrow">CODEX ANYWHERE</p>
              <h2 id="new-session-title">{t('新建会话', 'New session')}</h2>
              <span>{t('选择项目并发送第一条消息；创建前，当前会话保持不变。', 'Choose a project and send the first message. The current session stays unchanged until creation.')}</span>
            </header>
            <div className="new-session-dialog-body">
              {existingProjects.length > 0 && (
                <div className="new-session-field">
                  <span>{t('已有项目', 'Existing project')}</span>
                  <CustomSelect
                    value={selectedExistingProject}
                    ariaLabel={t('选择已有项目', 'Select an existing project')}
                    options={[
                      { value: '', label: t('手动输入其他目录', 'Enter another directory') },
                      ...existingProjects.map((project) => ({
                        value: project,
                        label: projectLabel(project),
                        description: project,
                      })),
                    ]}
                    onChange={setNewSessionCwd}
                  />
                </div>
              )}
              <label className="new-session-field" htmlFor="new-session-cwd">
                <span>{t('项目目录', 'Project directory')}</span>
                <input
                  id="new-session-cwd"
                  value={newSessionCwd}
                  onChange={(event) => {
                    setNewSessionCwd(event.target.value);
                    setNewSessionError('');
                  }}
                  placeholder={t('例如 C:\\workspace\\my-app', 'For example, C:\\workspace\\my-app')}
                  autoComplete="off"
                />
              </label>
              <label className="new-session-field" htmlFor="new-session-prompt">
                <span>{t('第一条消息', 'First message')}</span>
                <textarea
                  id="new-session-prompt"
                  autoFocus
                  rows={4}
                  value={newSessionPrompt}
                  onChange={(event) => {
                    setNewSessionPrompt(event.target.value);
                    setNewSessionError('');
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitNewSession();
                  }}
                  placeholder={t('告诉 Codex 要做什么…', 'Tell Codex what to do…')}
                />
              </label>
              {newSessionImage && (
                <div className="new-session-image-preview">
                  <img src={newSessionImage.previewUrl} alt="" />
                  <span title={newSessionImage.file.name}>{newSessionImage.file.name}</span>
                  <button type="button" onClick={() => setNewSessionImage(null)} aria-label={t('移除图片', 'Remove image')}>×</button>
                </div>
              )}
              <input
                ref={newSessionImageInputRef}
                className="image-input"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(event) => {
                  void chooseNewSessionImage(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <button className="new-session-attach" type="button" onClick={() => newSessionImageInputRef.current?.click()}>
                <span aria-hidden="true">＋</span>{t('添加图片', 'Add image')}
              </button>
              {newSessionError && <p className="new-session-error" role="alert">{newSessionError}</p>}
            </div>
            <footer className="new-session-dialog-actions">
              <button type="button" onClick={() => setNewSessionDialogOpen(false)}>{t('取消', 'Cancel')}</button>
              <button
                className="primary-action"
                type="button"
                disabled={!online || running || uploading || !newSessionCwd.trim() || (!newSessionPrompt.trim() && !newSessionImage)}
                onClick={submitNewSession}
              >
                {t('创建并发送', 'Create and send')}
              </button>
            </footer>
          </section>
        </div>
      )}

      <section className="conversation">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setDrawerOpen(true)} aria-label={t('展开会话列表', 'Expand session list')} title={t('展开会话列表', 'Expand session list')}>
            <SidebarIcon name="panel-open" />
          </button>
          <div className="conversation-heading">
            <strong>{activeSession?.title || (threadId ? t('Codex 会话', 'Codex session') : creatingNewSession ? t('新会话', 'New session') : t('最近会话', 'Recent session'))}</strong>
            <ModelConfigControl
              config={modelConfig}
              loading={modelConfigLoading}
              disabled={!online || executionActive}
              onSave={saveModelConfig}
            />
          </div>
          <span
            className={`presence ${online ? 'online' : 'offline'} ${online ? executionState : ''}`}
            role="status"
            aria-live="polite"
            aria-label={presenceLabel(online, executionState, statusText)}
            title={presenceLabel(online, executionState, statusText)}
          >
            <i aria-hidden="true" />
            <span className="visually-hidden">{presenceLabel(online, executionState, statusText)}</span>
          </span>
        </header>

        <div className="session-context" />

        <ConversationTimeline
          messageListRef={messageListRef}
          messageContentRef={messageContentRef}
          threadId={threadId}
          creatingNewSession={creatingNewSession}
          initialHistoryLoaded={initialHistoryLoaded}
          nextCursor={nextCursor}
          historyLoading={historyLoading}
          timeline={timeline}
          knownAttachments={knownAttachments}
          attachmentUrls={attachmentUrls}
          executionActive={executionActive}
          progressAnimationReady={followState !== 'checking'}
          liveProgressItemId={liveProgressItemId}
          onScroll={handleMessageScroll}
          onLoadOlder={loadOlder}
          onDownloadFile={downloadLocalFile}
          onReadVisualization={readVisualization}
        />
        <div className="execution-strip">
          {(executionState === 'running' || executionState === 'waiting') && (
            <LiveActivityStatus
              kind={liveActivity}
              purpose={toolPurpose}
              detail={activityDetail}
              progress={turnProgress}
              startedAt={activityStartedAt}
            />
          )}
          <DownloadIndicator download={fileDownload} onCancel={cancelFileDownload} />
        </div>

        {approval && (
          <section className="approval-card" aria-live="assertive">
            <div>
              <strong>{approval.actionable === false
                ? t('需要在电脑上批准', 'Approval required on your computer')
                : t('需要你的批准', 'Your approval is required')}</strong>
              <span>{approval.kind}</span>
            </div>
            <pre>{approval.actionable === false
              ? t(
                '这项请求已经由 Codex Desktop 持有，当前无法转交给 Web。请在电脑上处理这一次；之后从 Web 发起且由连接器持有的轮次，可以直接在这里批准或拒绝。',
                'Codex Desktop already owns this request, so it cannot be transferred to the Web. Handle this one on your computer; later connector-owned turns started from the Web can be approved or rejected here.',
              )
              : approval.summary}</pre>
            {approval.actionable !== false && (
              <div className="approval-actions">
                <button onClick={() => void answerApproval(false)}>{t('拒绝', 'Reject')}</button>
                <button className="approve" onClick={() => void answerApproval(true)}>{t('批准一次', 'Approve once')}</button>
              </div>
            )}
          </section>
        )}

        {(threadId || creatingNewSession) && <footer className="composer-wrap">
          {pendingImage && (
            <div className="image-preview">
              <img src={pendingImage.previewUrl} alt={t('待发送图片预览', 'Image ready to send')} />
              <span><strong>{pendingImage.file.name}</strong><small>{formatBytes(pendingImage.file.size)}</small></span>
              <button
                type="button"
                onClick={() => setPendingImage(null)}
                disabled={uploading || running}
                aria-label={t('移除图片', 'Remove image')}
              >×</button>
            </div>
          )}
          <div className="composer">
            <input
              ref={imageInputRef}
              className="image-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void chooseImage(file);
              }}
              disabled={!online || running || uploading}
            />
            <button
              className="attach-button"
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={!online || running || uploading}
              aria-label={t('添加图片', 'Add image')}
              title={t('添加图片', 'Add image')}
            >＋</button>
            <textarea
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void sendTurn();
              }}
              placeholder={uploading
                ? t('正在上传图片…', 'Uploading image…')
                : steeringAvailable
                  ? t('向当前任务追加指令…', 'Steer the current run…')
                  : directDesktopDeliveryAvailable
                    ? t('直接发送到当前任务…', 'Send to the current run…')
                  : online ? t('发送给本机 Codex…', 'Send to local Codex…') : t('本机连接器离线', 'Local connector is offline')}
              disabled={!online || uploading}
            />
            <div className="composer-actions">
              {primaryStopsRun && stopConfirmationArmed && (
                <span className="stop-confirmation" role="status">
                  {t('再次点击确认停止', 'Tap again to stop')}
                </span>
              )}
              <button
                  className={`send-button${uploading ? ' uploading' : ''}${primaryStopsRun ? ' stop-mode' : ''}${stopConfirmationArmed ? ' confirm-stop' : ''}`}
                  disabled={
                    !online
                    || uploading
                    || (!primaryStopsRun && (
                      (running && !steeringAvailable)
                      || (!prompt.trim() && !pendingImage)
                      || (!threadId && !newSessionCwd.trim())
                    ))
                  }
                  onClick={() => {
                    if (!primaryStopsRun) {
                      setStopConfirmationArmed(false);
                      void sendTurn();
                      return;
                    }
                    if (!stopConfirmationArmed) {
                      setStopConfirmationArmed(true);
                      return;
                    }
                    setStopConfirmationArmed(false);
                    void stopTurn();
                  }}
                  aria-label={primaryStopsRun
                    ? stopConfirmationArmed
                      ? t('再次点击确认停止', 'Tap again to stop')
                      : t('停止当前任务', 'Stop current run')
                    : uploading
                      ? t('正在发送图片', 'Sending image')
                      : steeringAvailable
                        ? t('追加指令', 'Steer')
                        : t('发送', 'Send')}
                >
                  {primaryStopsRun
                    ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
                    : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13" /></svg>}
              </button>
            </div>
          </div>
          <small>{steeringAvailable
            ? t('运行中可继续追加文字指令', 'You can steer this run with another text instruction')
            : t('Ctrl / ⌘ + Enter 发送 · 历史记录按页加载', 'Ctrl / ⌘ + Enter to send · History loads by page')}</small>
        </footer>}
      </section>
    </main>
  );
}
