import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  attachmentRegistryKey,
  parseAssistantMessage,
  historyFingerprint,
  historyItems,
  loadKnownAttachments,
  mergeHistorySnapshot,
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
import { t } from './i18n';
import {
  followLabel,
  formatDate,
  friendlyError,
  isConnectionInterruption,
  isSessionRunning,
  isTemporaryProjectPath,
  makeId,
  markSessionAttentionRead,
  presenceLabel,
  projectLabel,
  reconcileSessionAttention,
  sessionProjectName,
  sessionUpdatedAt,
  shortId,
  type SessionAttentionState,
} from './app-utils';
import { DownloadIndicator, MessageBubble, SidebarIcon } from './ui-components';
import { createAuthProof } from '../../src/shared/auth';
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
  OpenedDownload,
  PendingImage,
  PendingRequest,
  Session,
  TurnStartResult,
} from './app-types';

const DEVICE_ID = 'personal-pc';
const HISTORY_PAGE_SIZE = 6;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_START_REQUEST_TIMEOUT_MS = 11 * 60_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CLIENT_HEARTBEAT_MS = 20_000;
const CLIENT_STALE_AFTER_MS = 55_000;
const SESSION_STATUS_REFRESH_MS = 6_000;
const SESSION_ATTENTION_KEY = 'bridge.sessionAttention.v1';

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

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('bridge.token') || '');
  const [newSessionCwd, setNewSessionCwd] = useState(() => {
    const stored = localStorage.getItem('bridge.newSessionCwd') || '';
    return isTemporaryProjectPath(stored) ? '' : stored;
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState(false);
  const [statusText, setStatusText] = useState(t('未连接', 'Disconnected'));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionAttention, setSessionAttention] = useState<SessionAttentionState>(loadSessionAttention);
  const [sessionSearch, setSessionSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [initialHistoryLoaded, setInitialHistoryLoaded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const [knownAttachments, setKnownAttachments] = useState<Record<string, KnownAttachment>>(loadKnownAttachments);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [followState, setFollowState] = useState<FollowState>('idle');
  const [executionState, setExecutionState] = useState<ExecutionState>('idle');
  const [fileDownload, setFileDownload] = useState<FileDownloadState | null>(null);
  const [creatingNewSession, setCreatingNewSession] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [newSessionPrompt, setNewSessionPrompt] = useState('');
  const [newSessionImage, setNewSessionImage] = useState<PendingImage | null>(null);
  const [newSessionError, setNewSessionError] = useState('');
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const tokenRef = useRef(token);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectWantedRef = useRef(false);
  const socketAuthenticatedRef = useRef(false);
  const connectorOnlineRef = useRef(false);
  const lastServerActivityRef = useRef(0);
  const scheduleReconnectRef = useRef<(immediate?: boolean) => void>(() => {});
  const threadIdRef = useRef<string | null>(null);
  const selectedRequestRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const preserveScrollHeightRef = useRef<number | null>(null);
  const shouldScrollBottomRef = useRef(false);
  const autoFollowLatestRef = useRef(true);
  const streamItemRef = useRef<{ id: string; kind: TimelineKind } | null>(null);
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
  const sessionRefreshInFlightRef = useRef(false);
  const optimisticRestoreRef = useRef<string | null>(null);
  const runningRef = useRef(running);
  const executionStateRef = useRef(executionState);

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { executionStateRef.current = executionState; }, [executionState]);

  const updateSessionAttention = useCallback((
    update: (current: SessionAttentionState) => SessionAttentionState,
  ) => {
    setSessionAttention((current) => {
      const next = update(current);
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
    } else if (shouldScrollBottomRef.current) {
      shouldScrollBottomRef.current = false;
      const scrollToLatest = () => { element.scrollTop = element.scrollHeight; };
      scrollToLatest();
      const frame = requestAnimationFrame(scrollToLatest);
      return () => cancelAnimationFrame(frame);
    }
  }, [timeline, executionState, attachmentUrls]);

  const updateAutoFollowLatest = useCallback(() => {
    const element = messageListRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    autoFollowLatestRef.current = distanceFromBottom < 180;
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
    setTimeline((items) => [...items, { id, kind, text, transient: true }]);
  }, []);

  const finishAssistant = useCallback((text: string) => {
    const content = parseAssistantMessage(text);
    const visibleText = content.text;
    if (!visibleText) return;
    if (autoFollowLatestRef.current) shouldScrollBottomRef.current = true;
    const current = streamItemRef.current;
    streamItemRef.current = null;
    setTimeline((items) => {
      if (current?.kind === 'assistant' && items.some((item) => item.id === current.id)) {
        return items.map((item) => item.id === current.id
          ? { ...item, text: visibleText, contexts: content.contexts }
          : item);
      }
      return [...items, {
        id: makeId(), kind: 'assistant', text: visibleText, contexts: content.contexts, transient: true,
      }];
    });
  }, []);

  const request = useCallback(<T,>(action: string, payload: Record<string, unknown>): Promise<T> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(t('连接未建立', 'Connection is not established')));
    const requestId = makeId();
    const timeoutMs = action === 'turn.start' ? TURN_START_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRef.current.delete(requestId);
        reject(new Error(action === 'turn.start' ? 'turn_start_timeout' : 'request_timeout'));
      }, timeoutMs);
      pendingRef.current.set(requestId, {
        resolve: (value) => resolve(value as T), reject, timer,
      });
      try {
        socket.send(JSON.stringify({ type: 'request', requestId, action, payload, deviceId: DEVICE_ID }));
      } catch {
        clearTimeout(timer);
        pendingRef.current.delete(requestId);
        reject(new Error(t('连接已断开', 'Connection closed')));
      }
    });
  }, []);

  useEffect(() => {
    if (!online) return;
    for (const item of timeline) {
      const attachment = resolveTimelineAttachment(item, threadId, knownAttachments);
      if (!attachment
        || Object.prototype.hasOwnProperty.call(attachmentUrls, attachment.path)
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
  }, [attachmentUrls, knownAttachments, online, request, threadId, timeline]);

  const refreshSessions = useCallback(async () => {
    if (sessionRefreshInFlightRef.current) return [];
    sessionRefreshInFlightRef.current = true;
    try {
      const data = await request<{ sessions: Session[] }>('sessions.list', {});
      const nextSessions = data.sessions || [];
      setSessions(nextSessions);
      const currentThreadId = threadIdRef.current;
      updateSessionAttention((current) => reconcileSessionAttention(
        current,
        nextSessions,
        currentThreadId,
        runningRef.current || executionStateRef.current === 'running' || executionStateRef.current === 'waiting'
          ? currentThreadId : null,
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

  const handleBridgeMessage = useCallback((message: BridgeMessage) => {
    if (message.type === 'auth.ok') {
      socketAuthenticatedRef.current = true;
      reconnectAttemptRef.current = 0;
      setAuthenticated(true);
      setConnecting(false);
      setConnectionEpoch((current) => current + 1);
      const connected = Boolean(message.devices?.includes(DEVICE_ID));
      connectorOnlineRef.current = connected;
      setOnline(connected);
      setStatusText(connected ? t('电脑在线', 'Computer online') : t('电脑离线', 'Computer offline'));
      return;
    }
    if (message.type === 'pong') return;
    if (message.type === 'presence') {
      const wasConnected = connectorOnlineRef.current;
      const connected = Boolean(message.devices?.includes(DEVICE_ID));
      connectorOnlineRef.current = connected;
      setOnline(connected);
      setStatusText(connected ? t('电脑在线', 'Computer online') : t('电脑离线', 'Computer offline'));
      if (connected && !wasConnected) void refreshSessions();
      return;
    }
    if (message.type === 'response' && message.requestId) {
      const pending = pendingRef.current.get(message.requestId);
      if (!pending) return;
      pendingRef.current.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error || t('请求失败', 'Request failed')));
      return;
    }
    if (message.type !== 'event') return;
    const payload = message.payload || {};
    if (message.event === 'turn.waiting') {
      setRunning(true);
      setExecutionState('waiting');
      streamItemRef.current = null;
    } else if (message.event === 'turn.started') {
      const nextThreadId = String(payload.threadId || '');
      if (nextThreadId) {
        setThreadId(nextThreadId);
        threadIdRef.current = nextThreadId;
        localStorage.setItem('bridge.lastThreadId', nextThreadId);
        setCreatingNewSession(false);
        setRunning(true);
        setExecutionState('running');
      }
    } else if (message.event === 'turn.delta') {
      appendStream(payload.phase === 'final_answer' ? 'assistant' : 'progress', String(payload.delta || ''));
    } else if (message.event === 'turn.final') {
      const text = String(payload.text || '');
      finishAssistant(text);
    } else if (message.event === 'approval.requested') {
      setApproval({
        approvalId: String(payload.approvalId || ''),
        kind: String(payload.kind || 'action'),
        summary: String(payload.summary || ''),
      });
    } else if (message.event === 'turn.error') {
      streamItemRef.current = null;
      setRunning(false);
      setExecutionState('failed');
      addTimeline('error', String(payload.error || t('Codex 运行错误', 'Codex execution error')));
    } else if (message.event === 'turn.ended') {
      streamItemRef.current = null;
      setRunning(false);
      setExecutionState((current) => current === 'failed' ? current : 'completed');
      void refreshSessions();
    }
  }, [addTimeline, appendStream, finishAssistant, refreshSessions]);

  const messageHandlerRef = useRef(handleBridgeMessage);
  useEffect(() => { messageHandlerRef.current = handleBridgeMessage; }, [handleBridgeMessage]);

  const rejectPendingRequests = useCallback((message: string) => {
    for (const pending of pendingRef.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    pendingRef.current.clear();
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const openSocket = useCallback((value: string, replaceExisting = false) => {
    if (!reconnectWantedRef.current || value.length < 32) return;
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
          const proof = createAuthProof(value, String(message.challenge || ''), 'client');
          socket.send(JSON.stringify({ type: 'auth.response', role: 'client', proof }));
          return;
        }
        messageHandlerRef.current(message);
      } catch {
        if (!socketAuthenticatedRef.current) socket.close(4003, 'invalid authentication challenge');
      }
    });
    socket.addEventListener('close', (event) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      socketAuthenticatedRef.current = false;
      connectorOnlineRef.current = false;
      setConnecting(false);
      setOnline(false);
      setRunning(false);
      rejectPendingRequests(t('连接已断开', 'Connection closed'));
      if (event.code === 4003) {
        reconnectWantedRef.current = false;
        sessionStorage.removeItem('bridge.token');
        tokenRef.current = '';
        setToken('');
        setAuthenticated(false);
        setStatusText(t('Token 验证失败', 'Token verification failed'));
        return;
      }
      if (event.code === 4406) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        setStatusText(t('连接协议已更新，请刷新页面', 'Connection protocol updated. Refresh the page.'));
        return;
      }
      if (event.code === 4429) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
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
  }, [clearReconnectTimer, rejectPendingRequests]);

  const scheduleReconnect = useCallback((immediate = false) => {
    if (!reconnectWantedRef.current || tokenRef.current.trim().length < 32) return;
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
      openSocket(tokenRef.current.trim(), true);
    }, delay);
  }, [clearReconnectTimer, openSocket]);

  useEffect(() => { scheduleReconnectRef.current = scheduleReconnect; }, [scheduleReconnect]);

  const connect = useCallback((event?: FormEvent) => {
    event?.preventDefault();
    const value = tokenRef.current.trim();
    if (value.length < 32) {
      setStatusText(t('Token 长度不足', 'Token is too short'));
      return;
    }
    sessionStorage.setItem('bridge.token', value);
    reconnectWantedRef.current = true;
    reconnectAttemptRef.current = 0;
    openSocket(value, true);
  }, [openSocket]);

  useEffect(() => {
    reconnectWantedRef.current = tokenRef.current.trim().length >= 32;
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
      socket?.close(1000, 'page closed');
      rejectPendingRequests(t('页面已关闭', 'Page closed'));
    };
  }, [clearReconnectTimer, rejectPendingRequests, scheduleReconnect]);

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
    if (authenticated && connectionEpoch) void refreshSessions();
  }, [authenticated, connectionEpoch, refreshSessions]);

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
      const items = historyItems(page.turns);
      if (cursor) setTimeline((current) => [...items, ...current]);
      else {
        autoFollowLatestRef.current = true;
        shouldScrollBottomRef.current = true;
        setTimeline(items);
        followFingerprintRef.current = historyFingerprint(page.turns);
        latestActivityIdRef.current = page.activityId || '';
        const latestStatus = page.turns[0]?.status;
        const active = latestStatus === 'inProgress';
        const failed = latestStatus === 'failed';
        setExecutionState(active ? 'running' : failed ? 'failed' : 'idle');
      }
      setNextCursor(page.nextCursor || null);
      if (!cursor) setHistoryTruncated(Boolean(page.truncated));
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
        const fingerprint = historyFingerprint(page.turns);
        const previousFingerprint = followFingerprintRef.current;
        const changed = Boolean(previousFingerprint && previousFingerprint !== fingerprint);
        const latestStatus = page.turns[0]?.status;
        const inProgress = latestStatus === 'inProgress';
        const failed = latestStatus === 'failed';
        const latestItems = historyItems(page.turns);
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
    setAttachmentUrls({});
    attachmentLoadsRef.current.clear();
    setNextCursor(null);
    setHistoryTruncated(false);
    setInitialHistoryLoaded(!nextThreadId);
    setHistoryLoading(false);
    followFingerprintRef.current = '';
    latestActivityIdRef.current = '';
    awaitingDesktopTurnRef.current = null;
    setFollowState(nextThreadId ? 'checking' : 'idle');
    setExecutionState('idle');
    autoFollowLatestRef.current = true;
    streamItemRef.current = null;
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

  const loadOlder = useCallback(() => {
    if (threadId && nextCursor) void loadHistory(threadId, nextCursor, selectedRequestRef.current);
  }, [loadHistory, nextCursor, threadId]);

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
    if ((!text && !image) || running || uploading || sendingRef.current) return;
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
      setRunning(true);
      setExecutionState('running');
      const data = await request<TurnStartResult>('turn.start', {
        text: turnText,
        threadId: threadIdRef.current,
        cwd: isExistingSession ? '' : projectCwd,
      });
      if (data.threadId) {
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
      setRunning(false);
      setExecutionState('idle');
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
  }, [addTimeline, newSessionCwd, pendingImage, prompt, rememberAttachment, reportTimelineError, request, running, uploading]);

  useEffect(() => {
    if (!creatingNewSession || !newSessionAutoSendRef.current || running || uploading) return;
    newSessionAutoSendRef.current = false;
    void sendTurn();
  }, [creatingNewSession, pendingImage, prompt, running, sendTurn, uploading]);

  const stopTurn = useCallback(async () => {
    try { await request('turn.stop', {}); } catch (error) { reportTimelineError(error); }
    setRunning(false);
    awaitingDesktopTurnRef.current = null;
    setExecutionState('idle');
  }, [reportTimelineError, request]);

  const answerApproval = useCallback(async (approved: boolean) => {
    if (!approval) return;
    const current = approval;
    setApproval(null);
    try {
      await request('approval.respond', { approvalId: current.approvalId, approved });
    } catch (error) {
      reportTimelineError(error);
    }
  }, [approval, reportTimelineError, request]);

  const downloadLocalFile = useCallback(async (path: string) => {
    if (fileDownloadRef.current) return;
    const accepted = window.confirm(
      t(
        `是否从这台电脑下载以下文件？\n\n${path}\n\n确认后会签发一项 2 分钟、仅限当前页面和此文件的一次性权限。`,
        `Download this file from your computer?\n\n${path}\n\nConfirming grants this page a one-time, file-specific permission valid for 2 minutes.`,
      ),
    );
    if (!accepted) return;
    fileDownloadRef.current = true;
    fileDownloadCancelRef.current = false;
    setFileDownload({ name: localFileName(path), size: 0, received: 0 });
    let opened: OpenedDownload | null = null;
    let completed = false;
    try {
      opened = await request<OpenedDownload>('file.download.open', { path, confirmed: true });
      if (!opened.downloadId || !opened.downloadToken || !Number.isSafeInteger(opened.size) || opened.size < 0) {
        throw new Error('download_capability_invalid');
      }
      setFileDownload({ name: opened.name, size: opened.size, received: 0 });
      const parts: BlobPart[] = [];
      let offset = 0;
      while (true) {
        if (fileDownloadCancelRef.current) throw new Error('download_cancelled');
        const chunk = await request<DownloadFileChunk>('file.download.chunk', {
          downloadId: opened.downloadId,
          downloadToken: opened.downloadToken,
          offset,
        });
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
        setFileDownload({ name: opened.name, size: opened.size, received: offset });
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
      setFileDownload(null);
    }
  }, [reportTimelineError, request]);

  const cancelFileDownload = useCallback(() => {
    fileDownloadCancelRef.current = true;
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

  if (!authenticated) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">C</div>
          <p className="eyebrow">PRIVATE BRIDGE</p>
          <h1>{t('连接本机 Codex', 'Connect to local Codex')}</h1>
          <p className="login-copy">{t('输入 Bridge Token 以继续。', 'Enter the Bridge Token to continue.')}</p>
          <form onSubmit={connect}>
            <label htmlFor="token">Bridge Token</label>
            <input
              id="token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={t('粘贴至少 32 位 Token', 'Paste a token with at least 32 characters')}
            />
            <button className="primary wide" disabled={connecting}>{connecting ? t('连接中…', 'Connecting…') : t('连接', 'Connect')}</button>
          </form>
          <div className="login-status">{statusText}</div>
        </section>
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
                <label className="new-session-field" htmlFor="existing-project">
                  <span>{t('已有项目', 'Existing project')}</span>
                  <select
                    id="existing-project"
                    value={selectedExistingProject}
                    onChange={(event) => setNewSessionCwd(event.target.value)}
                  >
                    <option value="">{t('手动输入其他目录', 'Enter another directory')}</option>
                    {existingProjects.map((project) => (
                      <option key={project.toLocaleLowerCase()} value={project}>{projectLabel(project)}</option>
                    ))}
                  </select>
                </label>
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
            <span>{threadId
              ? `${followLabel(followState)} · ${activeSession?.cwd || shortId(threadId)}`
              : creatingNewSession
                ? (newSessionCwd || t('尚未选择项目目录', 'No project directory selected'))
                : t('从左上角菜单选择会话', 'Choose a session from the top-left menu')}</span>
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

        <div className="message-list" ref={messageListRef} onScroll={updateAutoFollowLatest}>
          {threadId && initialHistoryLoaded && nextCursor && (
            <button className="load-older" disabled={historyLoading} onClick={loadOlder}>
              {historyLoading ? t('正在加载…', 'Loading…') : t('加载更早记录', 'Load older messages')}
            </button>
          )}
          {threadId && initialHistoryLoaded && historyTruncated && (
            <div className="history-tail-notice">{t('该会话记录较大，当前展示最近活动；新输出会继续实时同步。', 'This session is large, so only recent activity is shown. New output will continue to sync live.')}</div>
          )}
          {threadId && historyLoading && !initialHistoryLoaded && <div className="history-skeleton">{t('正在加载最近记录…', 'Loading recent messages…')}</div>}
          {!timeline.length && !historyLoading && (
            <div className="empty-conversation">
              <div className="brand-mark small">C</div>
              <h2>{threadId ? t('这个分页暂无消息', 'No messages on this page') : creatingNewSession ? t('创建一个新会话', 'Create a new session') : t('选择已有会话', 'Choose an existing session')}</h2>
              <p>{threadId
                ? t('历史记录按页加载，不再一次拉取整个会话。', 'History loads page by page instead of fetching the entire session.')
                : creatingNewSession
                  ? t('选择本机项目目录后，第一条消息将在该目录中运行。', 'Choose a local project directory; the first message will run there.')
                  : t('打开左上角菜单选择会话；新会话入口也已移入菜单。', 'Open the top-left menu to choose a session or start a new one.')}</p>
            </div>
          )}
          {timeline.map((item) => {
            const attachment = resolveTimelineAttachment(item, threadId, knownAttachments);
            return (
              <MessageBubble
                key={item.id}
                item={attachment && !item.attachment ? { ...item, attachment } : item}
                imageSource={attachment ? attachmentUrls[attachment.path] : undefined}
                onDownloadFile={downloadLocalFile}
              />
            );
          })}
        </div>

        <div className="execution-strip">
          <DownloadIndicator download={fileDownload} onCancel={cancelFileDownload} />
        </div>

        {approval && (
          <section className="approval-card">
            <div><strong>{t('需要你的批准', 'Your approval is required')}</strong><span>{approval.kind}</span></div>
            <pre>{approval.summary}</pre>
            <div className="approval-actions">
              <button onClick={() => void answerApproval(false)}>{t('拒绝', 'Reject')}</button>
              <button className="danger" onClick={() => void answerApproval(true)}>{t('批准一次', 'Approve once')}</button>
            </div>
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
                : online ? t('发送给本机 Codex…', 'Send to local Codex…') : t('本机连接器离线', 'Local connector is offline')}
              disabled={!online || uploading}
            />
            {running
              ? <button className="stop-button" onClick={() => void stopTurn()} aria-label={t('停止', 'Stop')}>■</button>
              : <button
                  className={`send-button${uploading ? ' uploading' : ''}`}
                  disabled={!online || uploading || (!prompt.trim() && !pendingImage) || (!threadId && !newSessionCwd.trim())}
                  onClick={() => void sendTurn()}
                  aria-label={uploading ? t('正在发送图片', 'Sending image') : t('发送', 'Send')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13" /></svg>
                </button>}
          </div>
          <small>{t('Ctrl / ⌘ + Enter 发送 · 历史记录按页加载', 'Ctrl / ⌘ + Enter to send · History loads by page')}</small>
        </footer>}
      </section>
    </main>
  );
}
