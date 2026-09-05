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
  appendStreamedMessageText,
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
import { useFileTransfer } from './file-transfer';
import { useFilePreviews } from './file-preview-client';
import { t } from './i18n';
import {
  friendlyError,
  canSendToActiveDesktopTurn,
  canSteerOwnedTurn,
  canStopOwnedTurn,
  initialBootstrapReady,
  isConnectionInterruption,
  isCurrentSessionRequest,
  isEventForSelectedThread,
  isNearScrollBottom,
  isTemporaryProjectPath,
  makeId,
  markSessionAttentionRead,
  projectLabel,
  reconcileSessionAttention,
  sessionDeliveryMatchesTarget,
  shouldAdoptStartedThread,
  shouldLoadOlderHistory,
  type SessionAttentionState,
} from './app-utils';
import {
  CustomSelect,
  DownloadIndicator,
  seedTypewriterText,
  SidebarIcon,
} from './ui-components';
import { ConversationTimeline } from './conversation-timeline';
import { useConversationExecution } from './conversation-execution';
import { SessionSidebar } from './session-sidebar';
import { SessionRenameDialog } from './session-rename-dialog';
import {
  epochMillis,
  liveEventActivity,
  LiveActivityStatus,
  RunDetailsSheet,
  safeActivityKind,
} from './live-activity';
import { ModelConfigControl } from './model-config-control';
import { StartupScreen } from './startup-screen';
import {
  SESSION_PERMISSION_MODE_KEY,
  useSessionConfiguration,
} from './session-configuration';
import {
  BridgeRequestManager,
  type BridgeRequestOptions as RequestOptions,
} from './bridge-request-manager';
import { BrowserSecureChannel } from './secure-channel-client';
import {
  DEFAULT_ENVIRONMENT_ID,
  environmentDisplayName,
  environmentOfflineLabel,
  environmentOnlineLabel,
  environmentShortName,
  loadEnvironmentValue,
  loadKnownEnvironmentIds,
  loadSelectedEnvironmentId,
  mergeKnownEnvironmentIds,
  normalizeEnvironmentId,
  normalizeEnvironmentIds,
  storeEnvironmentValue,
  storeKnownEnvironmentIds,
  storeSelectedEnvironmentId,
} from './execution-environments';
import { normalizeToolPurpose } from '../../src/shared/message-content';
import {
  normalizeContextUsage,
  type ContextUsage,
} from '../../src/shared/context-compaction';
import type { TimelineNotice } from '../../src/shared/timeline-notice';
import { PresenceIndicator } from './presence-indicator';
import { PermissionModeControl } from './permission-mode-control';
import { BrowserSessionStatus } from './browser-session-status';
import { useSidePanelSession } from './sidepanel-session';
import {
  normalizePermissionMode,
} from '../../src/shared/permission-mode';
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
  type BrowserPairingCredential,
} from '../../src/shared/pairing-auth';
import { PAIRING_TIMEOUT_MS, PENDING_PAIRING_KEY, pairingFailureMessage, takePairingInput } from './pairing-input';
import type {
  Approval,
  AwaitingDesktopTurn,
  BridgeMessage,
  DownloadedImage,
  FollowState,
  HistoryPage,
  PendingImage,
  PendingApprovals,
  Session,
  TurnStartResult,
} from './app-types';

const HISTORY_PAGE_SIZE = 6;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CLIENT_HEARTBEAT_MS = 20_000;
const CLIENT_STALE_AFTER_MS = 55_000;
const SESSION_STATUS_REFRESH_MS = 6_000;
const INITIAL_BOOTSTRAP_TIMEOUT_MS = 10_000;
const SESSION_ATTENTION_KEY = 'bridge.sessionAttention.v1';
const LAST_THREAD_KEY = 'bridge.lastThreadId';
const NEW_SESSION_CWD_KEY = 'bridge.newSessionCwd';
const NEW_TURN_KEY = '__new_turn__';
const PairingDialog = lazy(() => import('./pairing-dialog').then((module) => ({
  default: module.PairingDialog,
})));

function loadSessionAttention(environmentId = DEFAULT_ENVIRONMENT_ID): SessionAttentionState {
  try {
    const stored = JSON.parse(
      loadEnvironmentValue(SESSION_ATTENTION_KEY, environmentId) || '{}',
    ) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored)
      .filter(([id, state]) => id && (state === 'running' || state === 'unread'))
      .slice(-200)) as SessionAttentionState;
  } catch {
    return {};
  }
}

function storeSessionAttention(environmentId: string, value: SessionAttentionState) {
  storeEnvironmentValue(SESSION_ATTENTION_KEY, environmentId, JSON.stringify(value));
}


export default function App({ initialPairingInput = null }: { initialPairingInput?: string | null } = {}) {
  const [pairingCredential, setPairingCredential] = useState<BrowserPairingCredential | null>(null);
  const [pairingInput, setPairingInput] = useState(initialPairingInput || '');
  const [pairingError, setPairingError] = useState('');
  const [pairingDialogOpen, setPairingDialogOpen] = useState(initialPairingInput !== null);
  const initialEnvironmentIdRef = useRef(loadSelectedEnvironmentId());
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentIdRef.current);
  const [environmentIds, setEnvironmentIds] = useState(() => mergeKnownEnvironmentIds(
    loadKnownEnvironmentIds(), [], initialEnvironmentIdRef.current,
  ));
  const [onlineEnvironmentIds, setOnlineEnvironmentIds] = useState<string[]>([]);
  const [newSessionCwd, setNewSessionCwd] = useState(() => {
    const stored = loadEnvironmentValue(NEW_SESSION_CWD_KEY, initialEnvironmentIdRef.current) || '';
    return isTemporaryProjectPath(stored) ? '' : stored;
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [initialBootstrapPending, setInitialBootstrapPending] = useState(() => (
    hasApprovedBrowserDevice() && initialPairingInput === null
  ));
  const [sessionsInitialized, setSessionsInitialized] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState(false);
  const [statusText, setStatusText] = useState(t('未连接', 'Disconnected'));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionAttention, setSessionAttention] = useState<SessionAttentionState>(() => (
    loadSessionAttention(initialEnvironmentIdRef.current)
  ));
  const [sessionSearch, setSessionSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [olderHistoryError, setOlderHistoryError] = useState(false);
  const [olderHistoryAutoLoadEnabled, setOlderHistoryAutoLoadEnabled] = useState(false);
  const [initialHistoryLoaded, setInitialHistoryLoaded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const [knownAttachments, setKnownAttachments] = useState<Record<string, KnownAttachment>>(loadKnownAttachments);
  const [uploading, setUploading] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [followState, setFollowState] = useState<FollowState>('idle');
  const {
    execution: {
      running,
      ownedTurnThreadId,
      state: executionState,
      purpose: toolPurpose,
      detail: activityDetail,
      activity: liveActivity,
      startedAt: activityStartedAt,
      progress: turnProgress,
    },
    resetExecution,
    resetExecutionPresentation,
    updateExecution,
    setState: setExecutionState,
    setPurpose: setToolPurpose,
    setDetail: setActivityDetail,
    setActivity: setLiveActivity,
    setProgress: setTurnProgress,
  } = useConversationExecution();
  const [creatingNewSession, setCreatingNewSession] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [newSessionPrompt, setNewSessionPrompt] = useState('');
  const [newSessionImage, setNewSessionImage] = useState<PendingImage | null>(null);
  const [newSessionError, setNewSessionError] = useState('');
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [runDetailsOpen, setRunDetailsOpen] = useState(false);
  const [stopping, setStopping] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const pairingCredentialRef = useRef(pairingCredential);
  const approvedDeviceRef = useRef(hasApprovedBrowserDevice() && initialPairingInput === null);
  const authAttemptModeRef = useRef<'device' | 'pairing'>('device');
  const pairingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectWantedRef = useRef(false);
  const socketAuthenticatedRef = useRef(false);
  const environmentIdRef = useRef(environmentId);
  const onlineEnvironmentIdsRef = useRef<string[]>([]);
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
  const shouldScrollBottomRef = useRef(false);
  const autoFollowLatestRef = useRef(true);
  const streamItemRef = useRef<{ id: string; kind: TimelineKind; sourceItemId: string } | null>(null);
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
  const sessionRefreshInFlightRef = useRef(false);
  const olderHistoryLoadingRef = useRef(false);
  const liveHistoryHydratedThreadRef = useRef<string | null>(null);
  const optimisticRestoreRef = useRef<string | null>(null);
  const runningRef = useRef(running);
  const ownedTurnThreadIdRef = useRef(ownedTurnThreadId);
  const sessionAttentionRef = useRef(sessionAttention);
  const requestManagerRef = useRef<BridgeRequestManager | null>(null);
  if (!requestManagerRef.current) {
    requestManagerRef.current = new BridgeRequestManager({
      isConnected: () => socketRef.current?.readyState === WebSocket.OPEN,
      send: (frame) => secureChannelRef.current?.sendFrame(frame) === true,
    });
  }

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);
  useEffect(() => { environmentIdRef.current = environmentId; }, [environmentId]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { ownedTurnThreadIdRef.current = ownedTurnThreadId; }, [ownedTurnThreadId]);
  useEffect(() => {
    if (executionState !== 'running' && executionState !== 'waiting') {
      setRunDetailsOpen(false);
      setStopping(false);
    }
  }, [executionState]);
  useEffect(() => { setRunDetailsOpen(false); }, [environmentId, threadId]);

  const finishInitialBootstrap = useCallback(() => {
    setInitialBootstrapPending(false);
  }, []);

  const updateSessionAttention = useCallback((
    update: (current: SessionAttentionState) => SessionAttentionState,
  ) => {
    setSessionAttention((current) => {
      const next = update(current);
      sessionAttentionRef.current = next;
      if (next !== current) storeSessionAttention(environmentIdRef.current, next);
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

  const addTimelineNotice = useCallback((notice: TimelineNotice) => {
    const item: TimelineItem = {
      id: makeId(),
      kind: 'system',
      text: '',
      notice,
      transient: true,
      historyTurnId: activeTurnIdRef.current || undefined,
      completedAt: Date.now(),
    };
    autoFollowLatestRef.current = true;
    shouldScrollBottomRef.current = true;
    setTimeline((current) => [...current, item]);
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
        [attachmentRegistryKey(targetThreadId, text, environmentIdRef.current)]: {
          ...attachment, savedAt: Date.now(),
        },
      };
      const limited = Object.fromEntries(Object.entries(next)
        .sort((left, right) => left[1].savedAt - right[1].savedAt)
        .slice(-40));
      try { storeKnownAttachments(limited); } catch { /* keep in memory */ }
      return limited;
    });
  }, []);

  const appendStream = useCallback((kind: TimelineKind, text: string, sourceItemId = '') => {
    if (!text) return;
    if (autoFollowLatestRef.current) shouldScrollBottomRef.current = true;
    const current = streamItemRef.current;
    if (current?.kind === kind) {
      const normalizedSourceItemId = sourceItemId.trim();
      const newProgressItem = kind === 'progress'
        && Boolean(normalizedSourceItemId && current.sourceItemId
          && normalizedSourceItemId !== current.sourceItemId);
      if (normalizedSourceItemId) current.sourceItemId = normalizedSourceItemId;
      setTimeline((items) => items.map((item) => item.id === current.id
        ? { ...item, text: appendStreamedMessageText(item.text, text, newProgressItem) }
        : item));
      return;
    }
    const id = makeId();
    streamItemRef.current = { id, kind, sourceItemId: sourceItemId.trim() };
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
  ): Promise<T> => requestManagerRef.current!.request<T>(action, payload, options), []);

  const { fileDownload, downloadLocalFile, cancelFileDownload } = useFileTransfer({
    online, request, reportTimelineError, environmentIdRef, selectedRequestRef, connectorOnlineRef, secureChannelRef,
  });
  const { readVisualization, readTextFile, readTurnDiff } = useFilePreviews(request, threadId);

  useLayoutEffect(() => {
    const element = messageListRef.current;
    if (!element) return;
    if (preserveScrollHeightRef.current != null) {
      element.scrollTop += element.scrollHeight - preserveScrollHeightRef.current;
      preserveScrollHeightRef.current = null;
    } else if (shouldScrollBottomRef.current || autoFollowLatestRef.current) {
      shouldScrollBottomRef.current = false;
      const scrollToLatest = () => {
        element.scrollTop = element.scrollHeight;
      };
      scrollToLatest();
      const frame = requestAnimationFrame(scrollToLatest);
      return () => cancelAnimationFrame(frame);
    }
  }, [
    timeline, executionState, attachmentUrls, fileDownload, approval,
    initialBootstrapPending,
  ]);


  const {
    modelConfig,
    modelConfigLoading,
    permissionConfig,
    permissionConfigLoading,
    saveModelConfig,
    savePermissionMode,
  } = useSessionConfiguration({ environmentId, online, threadId, request });

  const replayPendingRequests = useCallback(() => {
    if (!secureChannelRef.current?.isReady()) return 0;
    return requestManagerRef.current!.replay();
  }, []);

  const timelineAttachments = useMemo(() => {
    const attachments = new Map<string, ImageAttachment>();
    for (const item of timeline) {
      const attachment = resolveTimelineAttachment(item, threadId, knownAttachments, environmentId);
      if (attachment) attachments.set(attachment.path, attachment);
    }
    return [...attachments.values()];
  }, [environmentId, knownAttachments, threadId, timeline]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === threadId) || null,
    [sessions, threadId],
  );

  useEffect(() => {
    if (!online) return;
    const targetThreadId = threadId;
    const requestVersion = selectedRequestRef.current;
    for (const attachment of timelineAttachments) {
      const loadKey = `${requestVersion}\0${attachment.path}`;
      if (Object.prototype.hasOwnProperty.call(attachmentUrls, attachment.path)
        || attachmentLoadsRef.current.has(loadKey)) continue;
      attachmentLoadsRef.current.add(loadKey);
      void request<DownloadedImage>('attachment.read', {
        path: attachment.path,
        source: attachment.source,
      })
        .then((image) => {
          if (!isCurrentSessionRequest(
            targetThreadId, threadIdRef.current, requestVersion, selectedRequestRef.current,
          )) return;
          if (!isValidImagePayload(image.mimeType, image.data)) throw new Error('attachment_content_mismatch');
          if (autoFollowLatestRef.current) shouldScrollBottomRef.current = true;
          setAttachmentUrls((current) => ({
            ...current,
            [attachment.path]: `data:${image.mimeType};base64,${image.data}`,
          }));
        })
        .catch(() => {
          if (isCurrentSessionRequest(
            targetThreadId, threadIdRef.current, requestVersion, selectedRequestRef.current,
          )) setAttachmentUrls((current) => ({ ...current, [attachment.path]: '' }));
        })
        .finally(() => attachmentLoadsRef.current.delete(loadKey));
    }
  }, [attachmentUrls, online, request, threadId, timelineAttachments]);

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
      return nextSessions;
    } catch {
      // Session refreshes are background synchronization. Connection status and
      // the next retry communicate failures without polluting the conversation.
      return [];
    } finally {
      sessionRefreshInFlightRef.current = false;
    }
  }, [request, updateSessionAttention]);

  const beginSecureChannel = useCallback((routeDeviceId = environmentIdRef.current) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    secureChannelRef.current?.clear();
    const channel = new BrowserSecureChannel({
      identity: loadOrCreateBrowserDeviceIdentity(),
      routeDeviceId,
      send: (frame) => {
        if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(frame));
        return true;
      },
      onFrame: (frame) => messageHandlerRef.current(frame as BridgeMessage),
      onReady: () => {
        if (secureChannelRef.current !== channel || environmentIdRef.current !== routeDeviceId) return;
        connectorOnlineRef.current = true;
        setOnline(true);
        setStatusText(environmentOnlineLabel(routeDeviceId));
        replayPendingRequests();
        void refreshSessions();
      },
      onError: () => {
        if (secureChannelRef.current !== channel || environmentIdRef.current !== routeDeviceId) return;
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
      if (pairingTimeoutRef.current) clearTimeout(pairingTimeoutRef.current);
      pairingTimeoutRef.current = null;
      authAttemptModeRef.current = 'device';
      setPairingInput('');
      setPairingError('');
      setPairingDialogOpen(false);
      try {
        sessionStorage.removeItem(PENDING_PAIRING_KEY);
      } catch { /* blocked store */ }
      socketAuthenticatedRef.current = true;
      reconnectAttemptRef.current = 0;
      setAuthenticated(true);
      setConnecting(false);
      setConnectionEpoch((current) => current + 1);
      const devices = normalizeEnvironmentIds(message.devices);
      onlineEnvironmentIdsRef.current = devices;
      setOnlineEnvironmentIds(devices);
      setEnvironmentIds((current) => {
        const next = mergeKnownEnvironmentIds(current, devices, environmentIdRef.current);
        storeKnownEnvironmentIds(next);
        return next;
      });
      const routeDeviceId = environmentIdRef.current;
      const connected = devices.includes(routeDeviceId);
      if (connected) {
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(t('正在建立安全通道…', 'Establishing secure channel…'));
        beginSecureChannel(routeDeviceId);
      } else {
        secureChannelRef.current?.clear();
        secureChannelRef.current = null;
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(environmentOfflineLabel(routeDeviceId));
        finishInitialBootstrap();
      }
      return;
    }
    if (message.type === 'pong') return;
    if (requestManagerRef.current!.handle(message)) return;
    if (message.type === 'presence') {
      const devices = normalizeEnvironmentIds(message.devices);
      onlineEnvironmentIdsRef.current = devices;
      setOnlineEnvironmentIds(devices);
      setEnvironmentIds((current) => {
        const next = mergeKnownEnvironmentIds(current, devices, environmentIdRef.current);
        storeKnownEnvironmentIds(next);
        return next;
      });
      const routeDeviceId = environmentIdRef.current;
      const connected = devices.includes(routeDeviceId);
      if (!connected) {
        secureChannelRef.current?.clear();
        secureChannelRef.current = null;
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(environmentOfflineLabel(routeDeviceId));
        finishInitialBootstrap();
      } else {
        if (!secureChannelRef.current?.isReady()) {
          connectorOnlineRef.current = false;
          setOnline(false);
          setStatusText(t('正在建立安全通道…', 'Establishing secure channel…'));
          if (!secureChannelRef.current) beginSecureChannel(routeDeviceId);
        }
      }
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
          updateExecution({ running: false, ownedTurnThreadId: null });
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
      const adoptStartedThread = shouldAdoptStartedThread(
        nextThreadId, selectedThreadId, previousOwnedThreadId === NEW_TURN_KEY,
      );
      if (nextThreadId && !adoptStartedThread) {
        updateSessionAttention((current) => ({ ...current, [nextThreadId]: 'running' }));
        return;
      }
      activeTurnIdRef.current = String(payload.turnId || '');
      runningRef.current = true;
      ownedTurnThreadIdRef.current = nextThreadId || selectedThreadId || NEW_TURN_KEY;
      turnProgressRef.current = {};
      updateExecution({
        running: true,
        ownedTurnThreadId: ownedTurnThreadIdRef.current,
        purpose: '',
        detail: '',
        progress: {},
        activity: 'starting',
        startedAt: Date.now(),
        ...(nextThreadId ? { state: 'running' as const } : {}),
      });
      if (nextThreadId) {
        setThreadId(nextThreadId);
        threadIdRef.current = nextThreadId;
        storeEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current, nextThreadId);
        setCreatingNewSession(false);
      }
    } else if (message.event === 'turn.delta') {
      setLiveActivity('responding');
      appendStream(
        payload.phase === 'final_answer' ? 'assistant' : 'progress',
        String(payload.delta || ''),
        String(payload.itemId || ''),
      );
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
        runningRef.current = true;
        ownedTurnThreadIdRef.current = nextApproval.threadId || threadIdRef.current || NEW_TURN_KEY;
        updateExecution((current) => ({
          running: true,
          ownedTurnThreadId: ownedTurnThreadIdRef.current,
          state: 'waiting',
          activity: 'waiting',
          startedAt: current.startedAt || Date.now(),
        }));
        autoFollowLatestRef.current = true;
        shouldScrollBottomRef.current = true;
      }
    } else if (message.event === 'approval.resolved') {
      setApproval(null);
      addTimelineNotice({
        kind: 'approval',
        decision: payload.approved === true ? 'approved' : 'rejected',
        approvalKind: String(payload.kind || 'action'),
        summary: String(payload.summary || ''),
      });
    } else if (message.event === 'turn.error') {
      const error = String(payload.error || t('Codex 运行错误', 'Codex execution error'));
      addTimelineNotice({ kind: 'turnStatus', status: 'error', detail: error });
      streamItemRef.current = null;
      activeTurnIdRef.current = '';
      setApproval(null);
      turnProgressRef.current = {};
      runningRef.current = false;
      ownedTurnThreadIdRef.current = null;
      resetExecution('failed');
    } else if (message.event === 'turn.ended') {
      if (payload.reason === 'cancelled') {
        addTimelineNotice({ kind: 'turnStatus', status: 'aborted', detail: 'cancelled' });
      }
      streamItemRef.current = null;
      activeTurnIdRef.current = '';
      setApproval(null);
      turnProgressRef.current = {};
      runningRef.current = false;
      ownedTurnThreadIdRef.current = null;
      updateExecution((current) => ({
        running: false,
        ownedTurnThreadId: null,
        purpose: '',
        detail: '',
        activity: 'working',
        startedAt: null,
        progress: {},
        state: current.state === 'failed' ? 'failed' : 'completed',
      }));
      void refreshSessions();
    }
  }, [
    addTimelineNotice, appendStream, beginSecureChannel, finishAssistant, finishInitialBootstrap,
    refreshSessions, resetExecution, updateExecution, updateSessionAttention,
  ]);

  useEffect(() => { messageHandlerRef.current = handleBridgeMessage; }, [handleBridgeMessage]);

  const rejectPendingRequests = useCallback((message: string) => {
    requestManagerRef.current!.rejectAll(message);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const clearPendingPairing = useCallback(() => {
    pairingCredentialRef.current = null;
    setPairingCredential(null);
    if (pairingTimeoutRef.current) clearTimeout(pairingTimeoutRef.current);
    pairingTimeoutRef.current = null;
    try { sessionStorage.removeItem(PENDING_PAIRING_KEY); } catch { /* blocked store */ }
  }, []);

  const stopPairing = useCallback((error = '', keepDialogOpen = true) => {
    reconnectWantedRef.current = false;
    clearReconnectTimer();
    clearPendingPairing();
    const socket = socketRef.current;
    // Detach before closing: a late challenge/auth.ok/close from this attempt
    // must not affect cancellation or a newly entered pairing code.
    socketRef.current = null;
    socketAuthenticatedRef.current = false;
    socket?.close(1000, 'pairing stopped');
    secureChannelRef.current?.clear();
    secureChannelRef.current = null;
    connectorOnlineRef.current = false;
    setConnecting(false);
    setOnline(false);
    setAuthenticated(false);
    finishInitialBootstrap();
    rejectPendingRequests(t('配对已结束', 'Pairing ended'));
    setPairingError(error);
    setPairingDialogOpen(keepDialogOpen);
    setStatusText(error || t('已取消配对，可以重新输入', 'Pairing cancelled. You can enter another code.'));
    // Closing an unsubmitted link must not discard an existing device approval.
    if (!keepDialogOpen && hasApprovedBrowserDevice()) {
      approvedDeviceRef.current = true;
      reconnectWantedRef.current = true;
      scheduleReconnectRef.current(true);
    }
  }, [clearPendingPairing, clearReconnectTimer, finishInitialBootstrap, rejectPendingRequests]);

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
      if (socketRef.current !== socket) return;
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
      if (!socketAuthenticatedRef.current && authAttemptModeRef.current === 'pairing') {
        stopPairing(pairingFailureMessage(event.code));
        return;
      }
      const replayPending = reconnectWantedRef.current
        && ![4003, 4403, 4406, 4407, 4429].includes(event.code);
      socketRef.current = null;
      socketAuthenticatedRef.current = false;
      onlineEnvironmentIdsRef.current = [];
      setOnlineEnvironmentIds([]);
      connectorOnlineRef.current = false;
      secureChannelRef.current?.clear();
      secureChannelRef.current = null;
      setConnecting(false);
      setOnline(false);
      runningRef.current = false;
      ownedTurnThreadIdRef.current = null;
      updateExecution({ running: false, ownedTurnThreadId: null });
      if (!replayPending) rejectPendingRequests(t('连接已断开', 'Connection closed'));
      if (event.code === 4003) {
        reconnectWantedRef.current = false;
        finishInitialBootstrap();
        setAuthenticated(false);
        setStatusText(t('配对凭据无效或已过期', 'Pairing credential is invalid or expired'));
        return;
      }
      if (event.code === 4403) {
        setAuthenticated(false);
        finishInitialBootstrap();
        approvedDeviceRef.current = false;
        clearBrowserDeviceApproval();
        reconnectWantedRef.current = false;
        setStatusText(t('这台设备的授权已失效，请重新配对', 'This device is no longer approved. Pair it again.'));
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
  }, [
    clearReconnectTimer, finishInitialBootstrap, hasAuthenticationMaterial,
    rejectPendingRequests, stopPairing, updateExecution,
  ]);

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
    clearPendingPairing();
    pairingCredentialRef.current = credential;
    setPairingCredential(credential);
    setPairingInput(serialized);
    setPairingError('');
    approvedDeviceRef.current = false;
    clearBrowserDeviceApproval();
    authAttemptModeRef.current = 'pairing';
    reconnectWantedRef.current = true;
    reconnectAttemptRef.current = 0;
    setInitialBootstrapPending(false);
    setSessionsInitialized(false);
    setPairingDialogOpen(true);
    setStatusText(t('正在安全配对…', 'Pairing securely…'));
    pairingTimeoutRef.current = setTimeout(() => stopPairing(pairingFailureMessage(4001)), PAIRING_TIMEOUT_MS);
    try { openSocket(true); } catch { stopPairing(pairingFailureMessage(1006)); }
  }, [clearPendingPairing, openSocket, stopPairing]);

  useEffect(() => {
    const receivePairingLink = () => {
      let storage: Storage | undefined;
      try { storage = sessionStorage; } catch { /* blocked store */ }
      const input = takePairingInput(location, history, storage);
      if (input === null) return;
      stopPairing();
      approvedDeviceRef.current = false;
      setPairingInput(input);
      setStatusText(t('已读取配对链接，请确认配对', 'Pairing link loaded. Confirm to pair.'));
    };
    window.addEventListener('hashchange', receivePairingLink);
    return () => window.removeEventListener('hashchange', receivePairingLink);
  }, [stopPairing]);

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
      if (pairingTimeoutRef.current) clearTimeout(pairingTimeoutRef.current);
      pairingTimeoutRef.current = null;
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
    if (cursor) setOlderHistoryError(false);
    const preservedScrollHeight = cursor && messageListRef.current
      ? messageListRef.current.scrollHeight : null;
    if (preservedScrollHeight != null) preserveScrollHeightRef.current = preservedScrollHeight;
    const discardUnusedScrollAnchor = () => {
      if (preserveScrollHeightRef.current === preservedScrollHeight) {
        preserveScrollHeightRef.current = null;
      }
    };
    try {
      const page = await request<HistoryPage>('session.turns.list', {
        threadId: targetThreadId,
        cursor,
        limit: HISTORY_PAGE_SIZE,
        mode: 'conversation',
      });
      if (selectedRequestRef.current !== requestVersion || threadIdRef.current !== targetThreadId) {
        discardUnusedScrollAnchor();
        return;
      }
      const items = attachLatestAssistantFileChanges(historyItems(page.turns), page.turnProgress);
      if (cursor) setTimeline((current) => [...items, ...current]);
      else {
        setContextUsage(normalizeContextUsage(page.contextUsage) || null);
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
        updateExecution({
          state: active ? 'running' : failed ? 'failed' : 'idle',
          purpose: active ? normalizeToolPurpose(page.toolPurpose) : '',
          detail: active ? normalizeToolPurpose(page.activityDetail) : '',
          activity: active
            ? safeActivityKind(page.activityKind || (page.toolPurpose ? 'planning' : 'working'))
            : 'working',
          startedAt: active
            ? epochMillis(page.activityStartedAt || page.turns[0]?.startedAt) || Date.now()
            : null,
          progress: active ? normalizeTurnProgress(page.turnProgress) : {},
        });
      }
      setNextCursor(page.nextCursor || null);
      if (cursor) setOlderHistoryError(false);
      setInitialHistoryLoaded(true);
    } catch (error) {
      discardUnusedScrollAnchor();
      if (selectedRequestRef.current === requestVersion) {
        if (cursor) setOlderHistoryError(true);
        else reportTimelineError(error);
      }
    } finally {
      if (selectedRequestRef.current === requestVersion) setHistoryLoading(false);
    }
  }, [reportTimelineError, request, updateExecution]);

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
        const nextContextUsage = normalizeContextUsage(page.contextUsage);
        if (nextContextUsage) setContextUsage(nextContextUsage);
        const fingerprint = historyFingerprint(page.turns, page.turnProgress);
        const previousFingerprint = followFingerprintRef.current;
        const changed = Boolean(previousFingerprint && previousFingerprint !== fingerprint);
        const latestStatus = page.turns[0]?.status;
        const inProgress = latestStatus === 'inProgress';
        const failed = latestStatus === 'failed';
        updateExecution((current) => ({
          purpose: inProgress ? normalizeToolPurpose(page.toolPurpose) || current.purpose : '',
          detail: inProgress ? normalizeToolPurpose(page.activityDetail) : '',
          activity: inProgress
            ? safeActivityKind(page.activityKind || (page.toolPurpose ? 'planning' : 'working'))
            : 'working',
          startedAt: inProgress
            ? epochMillis(page.activityStartedAt || page.turns[0]?.startedAt) || current.startedAt || Date.now()
            : null,
          progress: inProgress ? normalizeTurnProgress(page.turnProgress) : {},
        }));
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
          const latestTurnIds = new Set(latestItems
            .map((item) => item.historyTurnId)
            .filter((turnId): turnId is string => Boolean(turnId)));
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
  }, [initialHistoryLoaded, online, request, running, threadId, updateExecution]);

  const selectSession = useCallback((session: Session | null) => {
    const nextThreadId = session?.id || null;
    if (nextThreadId) {
      updateSessionAttention((current) => markSessionAttentionRead(current, nextThreadId));
    }
    if (nextThreadId && nextThreadId === threadIdRef.current) {
      setDrawerOpen(false);
      return;
    }
    cancelFileDownload();
    optimisticRestoreRef.current = null;
    selectedRequestRef.current += 1;
    const requestVersion = selectedRequestRef.current;
    setThreadId(nextThreadId);
    threadIdRef.current = nextThreadId;
    setCreatingNewSession(false);
    if (nextThreadId) storeEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current, nextThreadId);
    setTimeline([]);
    setContextUsage(null);
    preserveScrollHeightRef.current = null;
    olderHistoryLoadingRef.current = false;
    setAttachmentUrls({});
    attachmentLoadsRef.current.clear();
    setNextCursor(null);
    setOlderHistoryError(false);
    setOlderHistoryAutoLoadEnabled(false);
    setInitialHistoryLoaded(!nextThreadId);
    setHistoryLoading(false);
    liveHistoryHydratedThreadRef.current = null;
    followFingerprintRef.current = '';
    latestActivityIdRef.current = '';
    awaitingDesktopTurnRef.current = null;
    setFollowState(nextThreadId ? 'checking' : 'idle');
    resetExecutionPresentation();
    setApproval(null);
    autoFollowLatestRef.current = true;
    streamItemRef.current = null;
    activeTurnIdRef.current = '';
    setDrawerOpen(false);
    if (nextThreadId) void loadHistory(nextThreadId, null, requestVersion);
  }, [cancelFileDownload, loadHistory, resetExecutionPresentation, updateSessionAttention]);

  const selectEnvironment = useCallback((value: string) => {
    const nextEnvironmentId = normalizeEnvironmentId(value);
    if (!nextEnvironmentId || nextEnvironmentId === environmentIdRef.current) {
      setDrawerOpen(false);
      return;
    }

    selectedRequestRef.current += 1;
    cancelFileDownload();
    rejectPendingRequests(t('已切换执行环境', 'Execution environment changed'));
    secureChannelRef.current?.clear();
    secureChannelRef.current = null;
    connectorOnlineRef.current = false;
    runningRef.current = false;
    ownedTurnThreadIdRef.current = null;
    setOnline(false);
    setEnvironmentId(nextEnvironmentId);
    environmentIdRef.current = nextEnvironmentId;
    storeSelectedEnvironmentId(nextEnvironmentId);
    setEnvironmentIds((current) => {
      const next = mergeKnownEnvironmentIds(current, onlineEnvironmentIdsRef.current, nextEnvironmentId);
      storeKnownEnvironmentIds(next);
      return next;
    });
    const nextAttention = loadSessionAttention(nextEnvironmentId);
    setSessionAttention(nextAttention);
    sessionAttentionRef.current = nextAttention;
    setSessions([]);
    setSessionsInitialized(false);
    setSessionSearch('');
    setSearchOpen(false);
    setNewSessionDialogOpen(false);
    setRenameDialogOpen(false);
    setNewSessionCwd(() => {
      const stored = loadEnvironmentValue(NEW_SESSION_CWD_KEY, nextEnvironmentId) || '';
      return isTemporaryProjectPath(stored) ? '' : stored;
    });
    selectSession(null);
    resetExecution();

    const connectorAvailable = onlineEnvironmentIdsRef.current.includes(nextEnvironmentId);
    if (socketAuthenticatedRef.current && connectorAvailable) {
      setStatusText(t('正在建立安全通道…', 'Establishing secure channel…'));
      beginSecureChannel(nextEnvironmentId);
    } else {
      setStatusText(environmentOfflineLabel(nextEnvironmentId));
    }
  }, [beginSecureChannel, cancelFileDownload, rejectPendingRequests, resetExecution, selectSession]);

  const beginNewSession = useCallback(() => {
    setNewSessionPrompt('');
    setNewSessionImage(null);
    setNewSessionError('');
    setSearchOpen(false);
    setSessionSearch('');
    setDrawerOpen(false);
    setNewSessionDialogOpen(true);
  }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const renameSession = useCallback(async (name: string) => {
    const targetThreadId = threadIdRef.current;
    const requestVersion = selectedRequestRef.current;
    if (!targetThreadId) throw new Error('thread_id_required');
    const renamed = await request<{ threadId: string; title: string }>('session.rename', {
      threadId: targetThreadId,
      name,
    });
    if (!isCurrentSessionRequest(
      targetThreadId, threadIdRef.current, requestVersion, selectedRequestRef.current,
    )) return;
    setSessions((current) => current.map((session) => session.id === targetThreadId
      ? { ...session, title: renamed.title }
      : session));
  }, [request]);

  useEffect(() => {
    if (!authenticated || !online || !connectionEpoch || creatingNewSession || threadId) return;
    const previousThreadId = loadEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current);
    if (!previousThreadId) return;
    selectSession({ id: previousThreadId, title: '' });
    optimisticRestoreRef.current = previousThreadId;
  }, [authenticated, connectionEpoch, creatingNewSession, online, selectSession, threadId]);

  useEffect(() => {
    const restoredThreadId = optimisticRestoreRef.current;
    if (!restoredThreadId || !sessions.length || threadId !== restoredThreadId) return;
    optimisticRestoreRef.current = null;
    const restoredSession = sessions.find((session) => session.id === restoredThreadId);
    if (!restoredSession) selectSession(sessions[0]);
  }, [selectSession, sessions, threadId]);

  useEffect(() => {
    if (!authenticated || creatingNewSession || threadId || !sessions.length) return;
    const previousThreadId = loadEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current);
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
    const followingLatest = isNearScrollBottom(element);
    const browsingOlder = element.scrollHeight - element.scrollTop - element.clientHeight > 2;
    autoFollowLatestRef.current = followingLatest;
    if (browsingOlder) setOlderHistoryAutoLoadEnabled(true);
    if (browsingOlder && shouldLoadOlderHistory(
      element, nextCursor, initialHistoryLoaded, historyLoading,
    )) loadOlder();
  }, [historyLoading, initialHistoryLoaded, loadOlder, nextCursor]);

  const chooseImage = useCallback(async (file?: File) => {
    if (!file) return;
    const selectionVersion = selectedRequestRef.current;
    try {
      const prepared = await prepareImageFile(file);
      if (selectionVersion !== selectedRequestRef.current) return;
      setPendingImage({
        file: prepared.file,
        transferPreview: prepared.preview,
        previewUrl: URL.createObjectURL(prepared.file),
      });
    } catch (error) {
      if (selectionVersion === selectedRequestRef.current) reportTimelineError(error);
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
    const isExistingSession = Boolean(targetThreadId);
    const selectionVersion = selectedRequestRef.current;
    const projectCwd = newSessionCwd.trim();
    if (!isExistingSession && !projectCwd) {
      addTimeline('error', t('请先填写新会话的项目目录。', 'Enter a project directory for the new session.'));
      return;
    }
    if (!isExistingSession) {
      storeEnvironmentValue(NEW_SESSION_CWD_KEY, environmentIdRef.current, projectCwd);
    }
    sendingRef.current = true;
    let turnText = text;
    let visibleText = text;
    let timelineAttachment: ImageAttachment | undefined;
    let uploadedPreviewUrl = '';
    let optimisticItemId = '';
    let composerCleared = false;
    if (image) setUploading(true);
    try {
      if (image) {
        const encoded = await fileToBase64(image.file);
        const previewEncoded = image.transferPreview ? await fileToBase64(image.transferPreview) : '';
        if (!isCurrentSessionRequest(
          targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current,
        )) {
          setUploading(false);
          return;
        }
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
        uploadedPreviewUrl = image.transferPreview
          ? `data:${image.transferPreview.type};base64,${previewEncoded}`
          : `data:${uploaded.mimeType};base64,${encoded}`;
      }
      if (!isCurrentSessionRequest(
        targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current,
      )) {
        setUploading(false);
        return;
      }
      if (image && timelineAttachment) {
        if (targetThreadId) rememberAttachment(targetThreadId, visibleText, timelineAttachment);
        setAttachmentUrls((current) => ({
          ...current,
          [timelineAttachment!.path]: uploadedPreviewUrl,
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
        ownedTurnThreadIdRef.current = targetThreadId || NEW_TURN_KEY;
        updateExecution({
          running: true,
          ownedTurnThreadId: ownedTurnThreadIdRef.current,
          state: 'running',
          activity: 'starting',
          startedAt: Date.now(),
          progress: {},
        });
      }
      const action = steering ? 'turn.steer' : 'turn.start';
      const selectedPermissionMode = isExistingSession
        ? permissionConfig?.mode
        : normalizePermissionMode(loadEnvironmentValue(SESSION_PERMISSION_MODE_KEY, environmentIdRef.current));
      const data = await request<TurnStartResult>(action, {
        text: turnText,
        threadId: targetThreadId,
        ...(steering ? {} : {
          cwd: isExistingSession ? '' : projectCwd,
          ...(selectedPermissionMode ? { permissionMode: selectedPermissionMode } : {}),
          ...(directDesktopDelivery ? { preferDesktop: true } : {}),
        }),
      });
      const sentAt = Date.now();
      if (optimisticItemId) {
        setTimeline((current) => current.map((item) => item.id === optimisticItemId
          ? { ...item, completedAt: sentAt }
          : item));
      }
      if (isExistingSession && !sessionDeliveryMatchesTarget(targetThreadId, data.threadId)) {
        throw new Error('session_delivery_mismatch');
      }
      const selectionStillCurrent = isCurrentSessionRequest(
        targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current,
      );
      if (data.threadId) {
        if (!isExistingSession) {
          const createdSession = {
            id: data.threadId,
            title: visibleText.split(/\r?\n/, 1)[0]?.slice(0, 80) || t('新会话', 'New session'),
            cwd: projectCwd,
            updatedAt: Date.now(),
            status: 'inProgress',
          } satisfies Session;
          setSessions((current) => [
            createdSession,
            ...current.filter((session) => session.id !== data.threadId),
          ]);
          if (selectionStillCurrent) {
            ownedTurnThreadIdRef.current = data.delivery === 'desktop' ? null : data.threadId;
            updateExecution({ ownedTurnThreadId: ownedTurnThreadIdRef.current });
            setThreadId(data.threadId);
            threadIdRef.current = data.threadId;
            storeEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current, data.threadId);
            setCreatingNewSession(false);
          } else {
            updateSessionAttention((current) => ({ ...current, [data.threadId]: 'running' }));
          }
        } else if (selectionStillCurrent) {
          ownedTurnThreadIdRef.current = data.delivery === 'desktop' ? null : data.threadId;
          updateExecution({ ownedTurnThreadId: ownedTurnThreadIdRef.current });
        }
        if (timelineAttachment) rememberAttachment(data.threadId, visibleText, timelineAttachment);
      }
      if (data.delivery === 'desktop') {
        runningRef.current = false;
        ownedTurnThreadIdRef.current = null;
        updateExecution({ running: false, ownedTurnThreadId: null });
        if (!selectionStillCurrent) {
          if (targetThreadId) {
            updateSessionAttention((current) => ({ ...current, [targetThreadId]: 'running' }));
          }
          void refreshSessions();
          return;
        }
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
      const selectionStillCurrent = isCurrentSessionRequest(
        targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current,
      );
      if (!selectionStillCurrent) {
        if (!steering && ownedTurnThreadIdRef.current === (targetThreadId || NEW_TURN_KEY)) {
          runningRef.current = false;
          ownedTurnThreadIdRef.current = null;
          updateExecution({ running: false, ownedTurnThreadId: null });
        }
        void refreshSessions();
        return;
      }
      if (!steering) {
        runningRef.current = false;
        ownedTurnThreadIdRef.current = null;
        resetExecution();
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
    addTimeline, executionState, modelConfig, newSessionCwd, ownedTurnThreadId, pendingImage,
    permissionConfig, prompt,
    refreshSessions, rememberAttachment, reportTimelineError, request, resetExecution, running,
    updateExecution, updateSessionAttention, uploading,
  ]);

  useEffect(() => {
    if (!creatingNewSession || !newSessionAutoSendRef.current || running || uploading) return;
    newSessionAutoSendRef.current = false;
    void sendTurn();
  }, [creatingNewSession, pendingImage, prompt, running, sendTurn, uploading]);

  const stopTurn = useCallback(async () => {
    const selectionVersion = selectedRequestRef.current;
    const targetThreadId = ownedTurnThreadIdRef.current || threadIdRef.current;
    setStopping(true);
    try {
      await request('turn.stop', targetThreadId ? { threadId: targetThreadId } : {});
    } catch (error) {
      if (selectionVersion === selectedRequestRef.current) reportTimelineError(error);
      setStopping(false);
      return;
    }
    setStopping(false);
    if (selectionVersion !== selectedRequestRef.current) return;
    runningRef.current = false;
    ownedTurnThreadIdRef.current = null;
    awaitingDesktopTurnRef.current = null;
    setApproval(null);
    setRunDetailsOpen(false);
    resetExecution();
  }, [reportTimelineError, request, resetExecution]);

  const answerApproval = useCallback(async (approved: boolean) => {
    if (!approval || approval.actionable === false) return;
    const current = approval;
    const selectionVersion = selectedRequestRef.current;
    setApproval(null);
    try {
      await request('approval.respond', {
        approvalId: current.approvalId,
        threadId: current.threadId,
        approved,
      });
    } catch (error) {
      if (selectionVersion === selectedRequestRef.current) {
        setApproval(current);
        reportTimelineError(error);
      }
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
          runningRef.current = webOwned;
          ownedTurnThreadIdRef.current = webOwned ? (pending.threadId || threadId) : null;
          updateExecution((current) => ({
            running: webOwned,
            ownedTurnThreadId: ownedTurnThreadIdRef.current,
            state: 'waiting',
            activity: 'waiting',
            startedAt: current.startedAt || Date.now(),
          }));
          autoFollowLatestRef.current = true;
          shouldScrollBottomRef.current = true;
        } else if (approval?.actionable === false) {
          setApproval(null);
          runningRef.current = false;
          ownedTurnThreadIdRef.current = null;
          updateExecution({
            running: false,
            ownedTurnThreadId: null,
            state: 'running',
            activity: 'working',
          });
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
  }, [
    approval?.actionable, authenticated, connectionEpoch, executionState, online, request,
    threadId, updateExecution,
  ]);

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
  const executionActive = executionState === 'running' || executionState === 'waiting';
  const liveProgressItemId = useMemo(
    () => executionActive ? latestTurnProgressItemId(timeline) : null,
    [executionActive, timeline],
  );

  useSidePanelSession({ environmentId, threadId: authenticated ? threadId : null,
    title: String(sessions.find((session) => session.id === threadId)?.title || '').slice(0, 160),
    online: authenticated && online });

  if (initialBootstrapPending && !pairingDialogOpen) return <StartupScreen status={statusText} />;

  if (!authenticated) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">C</div>
          <p className="eyebrow">PRIVATE BRIDGE</p>
          <h1>{t('连接 Codex Anywhere', 'Connect to Codex Anywhere')}</h1>
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
              value={pairingInput}
              onValueChange={(value) => { setPairingInput(value); setPairingError(''); }}
              pairing={Boolean(pairingCredential)}
              status={statusText}
              error={pairingError}
              onCancel={() => stopPairing()}
              onClose={() => stopPairing('', false)}
              onPair={pairBrowser}
            />
          </Suspense>
        )}
      </main>
    );
  }

  return (
    <main className="app-shell">
      {drawerOpen && <button className="drawer-backdrop" aria-label={t('关闭会话列表', 'Close session list')} onClick={closeDrawer} />}
      <SessionSidebar
        open={drawerOpen}
        environmentId={environmentId}
        environmentIds={environmentIds}
        onlineEnvironmentIds={onlineEnvironmentIds}
        sessions={sessions}
        selectedThreadId={threadId}
        executionState={executionState}
        attention={sessionAttention}
        searchOpen={searchOpen}
        search={sessionSearch}
        onSearchOpenChange={setSearchOpen}
        onSearchChange={setSessionSearch}
        onEnvironmentChange={selectEnvironment}
        onNewSession={beginNewSession}
        onClose={closeDrawer}
        onSelect={selectSession}
      />

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

      <SessionRenameDialog
        open={renameDialogOpen}
        initialName={activeSession?.title || ''}
        onClose={() => setRenameDialogOpen(false)}
        onRename={renameSession}
      />

      <RunDetailsSheet
        open={runDetailsOpen && executionActive}
        state={executionState}
        kind={liveActivity}
        purpose={toolPurpose}
        detail={activityDetail}
        progress={turnProgress}
        startedAt={activityStartedAt}
        environment={environmentDisplayName(environmentId)}
        canStop={stopAvailable}
        stopping={stopping}
        onClose={() => setRunDetailsOpen(false)}
        onStop={() => void stopTurn()}
      />

      <section className="conversation">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setDrawerOpen(true)} aria-label={t('展开会话列表', 'Expand session list')} title={t('展开会话列表', 'Expand session list')}>
            <SidebarIcon name="panel-open" />
          </button>
          <div className="conversation-heading">
            <div className="conversation-title">
              <strong>{activeSession?.title || (threadId ? t('Codex 会话', 'Codex session') : creatingNewSession ? t('新会话', 'New session') : t('最近会话', 'Recent session'))}</strong>
              {threadId && (
                <button
                  className="session-rename-button"
                  type="button"
                  disabled={!online}
                  onClick={() => setRenameDialogOpen(true)}
                  aria-label={t('修改会话名称', 'Rename session')}
                  title={t('修改会话名称', 'Rename session')}
                >
                  <SidebarIcon name="edit" />
                </button>
              )}
              <span>{environmentShortName(environmentId)}</span>
            </div>
            <div className="conversation-controls">
              <ModelConfigControl
                config={modelConfig}
                loading={modelConfigLoading}
                disabled={!online || executionActive}
                onSave={saveModelConfig}
              />
              <PermissionModeControl
                config={permissionConfig}
                loading={permissionConfigLoading}
                disabled={!online || executionActive}
                onChange={savePermissionMode}
              />
              <BrowserSessionStatus key={`${environmentId}:${threadId}`} environmentId={environmentId} threadId={threadId} online={online} request={request} />
            </div>
          </div>
          <PresenceIndicator
            online={online}
            executionState={executionState}
            statusText={statusText}
            contextUsage={contextUsage}
          />
        </header>

        <ConversationTimeline
          messageListRef={messageListRef}
          messageContentRef={messageContentRef}
          threadId={threadId}
          environmentId={environmentId}
          creatingNewSession={creatingNewSession}
          initialHistoryLoaded={initialHistoryLoaded}
          nextCursor={nextCursor}
          historyLoading={historyLoading}
          olderHistoryError={olderHistoryError}
          olderHistoryAutoLoadEnabled={olderHistoryAutoLoadEnabled}
          timeline={timeline}
          knownAttachments={knownAttachments}
          attachmentUrls={attachmentUrls}
          executionActive={executionActive}
          progressAnimationReady={followState !== 'checking'}
          liveProgressItemId={liveProgressItemId}
          onScroll={handleMessageScroll}
          onLoadOlder={loadOlder}
          onDownloadFile={downloadLocalFile}
          onReadTextFile={readTextFile}
          onReadTurnDiff={readTurnDiff}
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
              onOpenDetails={() => setRunDetailsOpen(true)}
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
                  : online ? t('发送给当前 Codex…', 'Send to the current Codex…') : t('当前执行环境离线', 'Current environment is offline')}
              disabled={!online || uploading}
            />
            <div className="composer-actions">
              <button
                  className={`send-button${uploading ? ' uploading' : ''}`}
                  disabled={
                    !online
                    || uploading
                    || (running && !steeringAvailable)
                    || (!prompt.trim() && !pendingImage)
                    || (!threadId && !newSessionCwd.trim())
                  }
                  onClick={() => void sendTurn()}
                  aria-label={uploading
                    ? t('正在发送图片', 'Sending image')
                    : steeringAvailable
                      ? t('追加指令', 'Steer')
                      : t('发送', 'Send')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13" /></svg>
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
