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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  attachmentRegistryKey,
  displayAssistantMessage,
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
  type Turn,
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
  localFilePathFromHref,
  safeDownloadName,
} from './file-utils';

const DEVICE_ID = 'personal-pc';
const HISTORY_PAGE_SIZE = 6;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_START_REQUEST_TIMEOUT_MS = 11 * 60_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CLIENT_HEARTBEAT_MS = 20_000;
const CLIENT_STALE_AFTER_MS = 55_000;
const SESSION_STATUS_REFRESH_MS = 6_000;

type Session = {
  id: string;
  title: string;
  preview?: string;
  cwd?: string;
  updatedAt?: number | string | null;
  status?: string;
  canStartNewSession?: boolean;
};

type FollowState = 'idle' | 'checking' | 'following' | 'synced' | 'error';
type ExecutionState = 'idle' | 'waiting' | 'running' | 'completed' | 'failed';
type AwaitingDesktopTurn = {
  text: string;
  previousActivityId: string;
  activityId: string;
  seen: boolean;
};
type Approval = { approvalId: string; kind?: string; summary?: string };
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BridgeMessage = {
  type: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  data?: unknown;
  devices?: string[];
  event?: string;
  payload?: Record<string, unknown>;
};

type HistoryPage = {
  threadId: string;
  turns: Turn[];
  nextCursor: string | null;
  truncated?: boolean;
  source?: string;
  activityId?: string;
};
type TurnStartResult = { threadId: string; delivery?: 'desktop' | 'appServer' };
type PendingImage = { file: File; transferPreview?: File; previewUrl: string };
type DownloadedImage = { path: string; mimeType: string; size: number; data: string };
type OpenedDownload = { downloadId: string; downloadToken: string; name: string; size: number };
type DownloadFileChunk = { offset: number; nextOffset: number; done: boolean; data: string };
type FileDownloadState = { name: string; size: number; received: number };

const makeId = () => crypto.randomUUID();

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('bridge.token') || '');
  const [newSessionCwd, setNewSessionCwd] = useState(() => {
    const stored = localStorage.getItem('bridge.newSessionCwd') || '';
    return isTemporaryProjectPath(stored) ? '' : stored;
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState(false);
  const [statusText, setStatusText] = useState('未连接');
  const [sessions, setSessions] = useState<Session[]>([]);
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
  const sendingRef = useRef(false);
  const attachmentLoadsRef = useRef(new Set<string>());
  const fileDownloadRef = useRef(false);
  const fileDownloadCancelRef = useRef(false);
  const sessionRefreshInFlightRef = useRef(false);

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => () => {
    if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
  }, [pendingImage]);

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
    const visibleText = displayAssistantMessage(text);
    if (!visibleText) return;
    if (autoFollowLatestRef.current) shouldScrollBottomRef.current = true;
    const current = streamItemRef.current;
    streamItemRef.current = null;
    setTimeline((items) => {
      if (current?.kind === 'assistant' && items.some((item) => item.id === current.id)) {
        return items.map((item) => item.id === current.id ? { ...item, text: visibleText } : item);
      }
      return [...items, { id: makeId(), kind: 'assistant', text: visibleText, transient: true }];
    });
  }, []);

  const request = useCallback(<T,>(action: string, payload: Record<string, unknown>): Promise<T> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('连接未建立'));
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
      socket.send(JSON.stringify({ type: 'request', requestId, action, payload, deviceId: DEVICE_ID }));
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
      void request<DownloadedImage>('attachment.read', { path: attachment.path })
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

  const refreshSessions = useCallback(async (options: { silent?: boolean } = {}) => {
    if (sessionRefreshInFlightRef.current) return [];
    sessionRefreshInFlightRef.current = true;
    try {
      const data = await request<{ sessions: Session[] }>('sessions.list', {});
      const nextSessions = data.sessions || [];
      setSessions(nextSessions);
      const currentThreadId = threadIdRef.current;
      if (currentThreadId) {
        const currentSession = nextSessions.find((session) => session.id === currentThreadId);
        if (currentSession) setActiveSession(currentSession);
      }
      return nextSessions;
    } catch (error) {
      if (!options.silent) addTimeline('error', friendlyError(error));
      return [];
    } finally {
      sessionRefreshInFlightRef.current = false;
    }
  }, [addTimeline, request]);

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
      setStatusText(connected ? '电脑在线' : '电脑离线');
      return;
    }
    if (message.type === 'pong') return;
    if (message.type === 'presence') {
      const wasConnected = connectorOnlineRef.current;
      const connected = Boolean(message.devices?.includes(DEVICE_ID));
      connectorOnlineRef.current = connected;
      setOnline(connected);
      setStatusText(connected ? '电脑在线' : '电脑离线');
      if (connected && !wasConnected) void refreshSessions();
      return;
    }
    if (message.type === 'response' && message.requestId) {
      const pending = pendingRef.current.get(message.requestId);
      if (!pending) return;
      pendingRef.current.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error || '请求失败'));
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
      addTimeline('error', String(payload.error || 'Codex 运行错误'));
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
      setStatusText('等待网络恢复');
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
    setStatusText(reconnectAttemptRef.current ? '正在重新连接…' : '正在连接…');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socketRef.current = socket;
    socketAuthenticatedRef.current = false;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'auth', role: 'client', token: value }));
    });
    socket.addEventListener('message', (incoming) => {
      lastServerActivityRef.current = Date.now();
      try { messageHandlerRef.current(JSON.parse(String(incoming.data)) as BridgeMessage); } catch { /* ignore invalid frame */ }
    });
    socket.addEventListener('close', (event) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      socketAuthenticatedRef.current = false;
      connectorOnlineRef.current = false;
      setConnecting(false);
      setOnline(false);
      setRunning(false);
      rejectPendingRequests('连接已断开');
      if (event.code === 4003) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        setStatusText('Token 验证失败');
        return;
      }
      if (event.code === 4429) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        setStatusText('登录尝试过多，请 15 分钟后重试');
        return;
      }
      setStatusText(navigator.onLine === false ? '等待网络恢复' : '连接中断，准备重连…');
      scheduleReconnectRef.current();
    });
    socket.addEventListener('error', () => {
      if (socketRef.current === socket) setStatusText('连接失败');
    });
  }, [clearReconnectTimer, rejectPendingRequests]);

  const scheduleReconnect = useCallback((immediate = false) => {
    if (!reconnectWantedRef.current || tokenRef.current.trim().length < 32) return;
    clearReconnectTimer();
    if (navigator.onLine === false) {
      setConnecting(false);
      setStatusText('等待网络恢复');
      return;
    }
    const attempt = reconnectAttemptRef.current;
    const delay = immediate
      ? 0
      : Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * (2 ** attempt)) + Math.floor(Math.random() * 500);
    reconnectAttemptRef.current = immediate ? attempt : attempt + 1;
    setConnecting(true);
    setStatusText(delay ? `将在 ${Math.max(1, Math.ceil(delay / 1_000))} 秒后重连…` : '正在重新连接…');
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
      setStatusText('Token 长度不足');
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
    const handleOffline = () => {
      setOnline(false);
      setConnecting(false);
      setStatusText('等待网络恢复');
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };
    window.addEventListener('online', reconnectNow);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      reconnectWantedRef.current = false;
      clearReconnectTimer();
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(1000, 'page closed');
      rejectPendingRequests('页面已关闭');
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
      if (document.visibilityState === 'visible') void refreshSessions({ silent: true });
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
      if (selectedRequestRef.current === requestVersion) addTimeline('error', friendlyError(error), false);
    } finally {
      if (selectedRequestRef.current === requestVersion) setHistoryLoading(false);
    }
  }, [addTimeline, request]);

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
  }, [loadHistory]);

  const beginNewSession = useCallback(() => {
    selectSession(null);
    setCreatingNewSession(true);
  }, [selectSession]);

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
      addTimeline('error', friendlyError(error));
    }
  }, [addTimeline]);

  const sendTurn = useCallback(async () => {
    const text = prompt.trim();
    const image = pendingImage;
    if ((!text && !image) || running || uploading || sendingRef.current) return;
    const isExistingSession = Boolean(threadIdRef.current);
    const workspace = newSessionCwd.trim();
    if (!isExistingSession && !workspace) {
      addTimeline('error', '请先填写新会话的项目目录。');
      return;
    }
    if (!isExistingSession) localStorage.setItem('bridge.newSessionCwd', workspace);
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
        cwd: isExistingSession ? '' : workspace,
      });
      if (data.threadId) {
        setThreadId(data.threadId);
        threadIdRef.current = data.threadId;
        localStorage.setItem('bridge.lastThreadId', data.threadId);
        setCreatingNewSession(false);
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
        addTimeline('notice', '已取消发送，原消息已放回输入框。');
        return;
      }
      addTimeline('error', friendlyError(error));
    } finally {
      sendingRef.current = false;
    }
  }, [addTimeline, newSessionCwd, pendingImage, prompt, rememberAttachment, request, running, uploading]);

  const stopTurn = useCallback(async () => {
    try { await request('turn.stop', {}); } catch (error) { addTimeline('error', friendlyError(error)); }
    setRunning(false);
    awaitingDesktopTurnRef.current = null;
    setExecutionState('idle');
  }, [addTimeline, request]);

  const answerApproval = useCallback(async (approved: boolean) => {
    if (!approval) return;
    const current = approval;
    setApproval(null);
    try {
      await request('approval.respond', { approvalId: current.approvalId, approved });
    } catch (error) {
      addTimeline('error', friendlyError(error));
    }
  }, [addTimeline, approval, request]);

  const downloadLocalFile = useCallback(async (path: string) => {
    if (fileDownloadRef.current) return;
    const accepted = window.confirm(
      `是否从这台电脑下载以下文件？\n\n${path}\n\n确认后会签发一项 2 分钟、仅限当前页面和此文件的一次性权限。`,
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
        addTimeline('error', friendlyError(error));
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
  }, [addTimeline, request]);

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
          <h1>连接本机 Codex</h1>
          <p className="login-copy">输入 Bridge Token 以继续。</p>
          <form onSubmit={connect}>
            <label htmlFor="token">Bridge Token</label>
            <input
              id="token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="粘贴至少 32 位 Token"
            />
            <button className="primary wide" disabled={connecting}>{connecting ? '连接中…' : '连接'}</button>
          </form>
          <div className="login-status">{statusText}</div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {drawerOpen && <button className="drawer-backdrop" aria-label="关闭会话列表" onClick={() => setDrawerOpen(false)} />}
      <aside className={`sidebar ${drawerOpen ? 'open' : ''}`}>
        <div className="sidebar-head">
          <div>
            <p className="eyebrow">PERSONAL CODEX</p>
            <h1>会话</h1>
          </div>
          <div className="sidebar-actions">
            <button className="sidebar-tool primary-tool" onClick={beginNewSession} aria-label="新会话" title="新会话">＋</button>
            <button
              className={`sidebar-tool ${searchOpen ? 'active' : ''}`}
              onClick={() => {
                if (searchOpen) setSessionSearch('');
                setSearchOpen((open) => !open);
              }}
              aria-label={searchOpen ? '关闭搜索' : '搜索会话'}
              title={searchOpen ? '关闭搜索' : '搜索会话'}
            >⌕</button>
            <button className="sidebar-tool" onClick={() => void refreshSessions()} aria-label="刷新会话" title="刷新会话">↻</button>
            <button className="sidebar-tool mobile-only" onClick={() => setDrawerOpen(false)} aria-label="关闭" title="关闭">×</button>
          </div>
        </div>
        {searchOpen && (
          <label className="compact-search session-search-panel">
            <span>⌕</span>
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
              placeholder="搜索会话或目录"
            />
          </label>
        )}
        <nav className="session-list">
          {filteredSessions.map((session) => {
            const sessionRunning = isSessionRunning(session.status)
              || (session.id === threadId && (executionState === 'running' || executionState === 'waiting'));
            const projectName = sessionProjectName(session.cwd);
            return (
              <button
                key={session.id}
                className={`session-card ${threadId === session.id ? 'active' : ''} ${sessionRunning ? 'running' : ''}`}
                onClick={() => selectSession(session)}
              >
                <span className="session-title" title={session.title || session.id}>{session.title || session.id}</span>
                <span className="session-meta">
                  {sessionRunning && <span className="session-running-dot" aria-label="运行中" title="运行中" />}
                  {projectName && <span className="session-project" title={session.cwd}>{projectName}</span>}
                  <time>{formatDate(session.updatedAt)}</time>
                </span>
              </button>
            );
          })}
          {!filteredSessions.length && <p className="empty-list">没有匹配的会话</p>}
        </nav>
      </aside>

      <section className="conversation">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setDrawerOpen(true)} aria-label="打开会话列表">☰</button>
          <div className="conversation-heading">
            <strong>{activeSession?.title || (threadId ? 'Codex 会话' : creatingNewSession ? '新会话' : '最近会话')}</strong>
            <span>{threadId
              ? `${followLabel(followState)} · ${activeSession?.cwd || shortId(threadId)}`
              : creatingNewSession ? (newSessionCwd || '尚未选择项目目录') : '从左上角菜单选择会话'}</span>
          </div>
          <span className={`presence ${online ? 'online' : 'offline'}`}><i />{statusText}</span>
        </header>

        <div className="session-context">
          {!threadId && creatingNewSession && (
            <div className="new-session-setup">
              {existingProjects.length > 0 && (
                <>
                  <label htmlFor="existing-project">已有项目</label>
                  <select
                    id="existing-project"
                    value={selectedExistingProject}
                    onChange={(event) => setNewSessionCwd(event.target.value)}
                  >
                    <option value="">手动输入其他目录</option>
                    {existingProjects.map((project) => (
                      <option key={project.toLocaleLowerCase()} value={project}>{projectLabel(project)}</option>
                    ))}
                  </select>
                </>
              )}
              <label htmlFor="new-session-cwd">项目目录</label>
              <input
                id="new-session-cwd"
                value={newSessionCwd}
                onChange={(event) => setNewSessionCwd(event.target.value)}
                placeholder="例如 C:\\workspace\\my-app"
                autoComplete="off"
              />
              <small>已有项目来自最近会话的目录；也可以手动输入新目录。只影响新会话。</small>
            </div>
          )}
        </div>

        <div className="message-list" ref={messageListRef} onScroll={updateAutoFollowLatest}>
          {threadId && initialHistoryLoaded && nextCursor && (
            <button className="load-older" disabled={historyLoading} onClick={loadOlder}>
              {historyLoading ? '正在加载…' : '加载更早记录'}
            </button>
          )}
          {threadId && initialHistoryLoaded && historyTruncated && (
            <div className="history-tail-notice">该会话记录较大，当前展示最近活动；新输出会继续实时同步。</div>
          )}
          {threadId && historyLoading && !initialHistoryLoaded && <div className="history-skeleton">正在加载最近记录…</div>}
          {!timeline.length && !historyLoading && (
            <div className="empty-conversation">
              <div className="brand-mark small">C</div>
              <h2>{threadId ? '这个分页暂无消息' : creatingNewSession ? '创建一个新会话' : '选择已有会话'}</h2>
              <p>{threadId
                ? '历史记录按页加载，不再一次拉取整个会话。'
                : creatingNewSession
                  ? '选择本机项目目录后，第一条消息将在该目录中运行。'
                  : '打开左上角菜单选择会话；新会话入口也已移入菜单。'}</p>
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
          <ExecutionIndicator state={executionState} />
          <DownloadIndicator download={fileDownload} onCancel={cancelFileDownload} />
        </div>

        {approval && (
          <section className="approval-card">
            <div><strong>需要你的批准</strong><span>{approval.kind}</span></div>
            <pre>{approval.summary}</pre>
            <div className="approval-actions">
              <button onClick={() => void answerApproval(false)}>拒绝</button>
              <button className="danger" onClick={() => void answerApproval(true)}>批准一次</button>
            </div>
          </section>
        )}

        {(threadId || creatingNewSession) && <footer className="composer-wrap">
          {pendingImage && (
            <div className="image-preview">
              <img src={pendingImage.previewUrl} alt="待发送图片预览" />
              <span><strong>{pendingImage.file.name}</strong><small>{formatBytes(pendingImage.file.size)}</small></span>
              <button
                type="button"
                onClick={() => setPendingImage(null)}
                disabled={uploading || running}
                aria-label="移除图片"
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
              aria-label="添加图片"
              title="添加图片"
            >＋</button>
            <textarea
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void sendTurn();
              }}
              placeholder={uploading ? '正在上传图片…' : online ? '发送给本机 Codex…' : '本机连接器离线'}
              disabled={!online || uploading}
            />
            {running
              ? <button className="stop-button" onClick={() => void stopTurn()} aria-label="停止">■</button>
              : <button className="send-button" disabled={!online || uploading || (!prompt.trim() && !pendingImage) || (!threadId && !newSessionCwd.trim())} onClick={() => void sendTurn()} aria-label="发送">{uploading ? '…' : '↑'}</button>}
          </div>
          <small>Ctrl / ⌘ + Enter 发送 · 历史记录按页加载</small>
        </footer>}
      </section>
    </main>
  );
}

function ExecutionIndicator({ state }: { state: ExecutionState }) {
  if (state === 'idle') return null;
  if (state === 'running' || state === 'waiting') {
    return (
      <div className={`execution-status ${state}`} role="status" aria-live="polite">
        <span className="execution-dots" aria-hidden="true"><i /><i /><i /></span>
        <span>{state === 'waiting' ? '正在等待桌面会话空闲' : 'Codex 正在执行'}</span>
      </div>
    );
  }
  return (
    <div className={`execution-status ${state}`} role="status" aria-live="polite">
      <span className="execution-result" aria-hidden="true">{state === 'completed' ? '✓' : '!'}</span>
      <span>{state === 'completed' ? '本轮执行完成' : '本轮执行失败'}</span>
    </div>
  );
}

function DownloadIndicator({
  download,
  onCancel,
}: {
  download: FileDownloadState | null;
  onCancel: () => void;
}) {
  if (!download) return null;
  const progress = download.size > 0 ? Math.min(100, Math.round(download.received / download.size * 100)) : 0;
  return (
    <div className="download-status" role="status" aria-live="polite">
      <span>正在下载 {download.name}</span>
      <strong>{download.size > 0 ? `${progress}%` : '准备中'}</strong>
      <progress value={download.received} max={Math.max(1, download.size)} />
      <button type="button" onClick={onCancel}>取消下载</button>
    </div>
  );
}

function MessageBubble({
  item,
  imageSource,
  onDownloadFile,
}: {
  item: TimelineItem;
  imageSource?: string;
  onDownloadFile: (path: string) => void;
}) {
  if (item.kind === 'progress') {
    return (
      <details className="progress-card" open>
        <summary>进度更新</summary>
        <pre>{item.text}</pre>
      </details>
    );
  }
  return (
    <div className={`message ${item.kind}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, children, ...props }) => {
            const localPath = localFilePathFromHref(href);
            return localPath
              ? <a {...props} href={href} onClick={(event) => {
                  event.preventDefault();
                  onDownloadFile(localPath);
                }}>{children}</a>
              : <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
        }}
      >
        {item.text}
      </ReactMarkdown>
      {item.attachment && imageSource !== '' && (
        <figure className="message-image">
          {imageSource === undefined && <div className="message-image-state">正在加载图片…</div>}
          {imageSource === '' && <div className="message-image-state">图片已过期或无法读取</div>}
          {imageSource && (
            <a href={imageSource} target="_blank" rel="noreferrer noopener" aria-label="查看原图">
              <img src={imageSource} alt={item.attachment.name} loading="lazy" />
            </a>
          )}
          <figcaption>{item.attachment.name}</figcaption>
        </figure>
      )}
    </div>
  );
}

function followLabel(state: FollowState) {
  if (state === 'following') return '实时跟随';
  if (state === 'checking') return '检查进度';
  if (state === 'error') return '跟随重试中';
  return '已同步';
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '请求失败');
  if (message === 'connector_offline') return '本机连接器离线，请确认电脑已开机且连接器正在运行。';
  if (message === 'another_turn_is_active') return '当前已有一个任务在运行，请等待完成或先停止。';
  if (message === 'workspace_outside_allowed_root') return '该目录不在连接器允许访问的范围内。';
  if (message === 'request_timeout') return '请求超过 30 秒没有响应，消息未确认发送，已恢复到输入框。';
  if (message === 'turn_start_timeout') return '等待原会话可写超时，消息没有发送，已恢复到输入框。';
  if (message === 'desktop_app_unavailable') return '桌面 Codex 当前不可用，请打开桌面应用后重试。';
  if (message === 'desktop_delivery_timeout') return '桌面 Codex 没有及时确认接收，消息已恢复到输入框，请确认后再重试。';
  if (message === 'desktop_required_for_large_session') return '这是一个超大会话，需要桌面 Codex 打开后才能安全发送到原会话。';
  if (message === 'attachment_type_not_allowed') return '只支持 JPG、PNG 和 WebP 图片。';
  if (message === 'attachment_too_large') return '图片处理后仍超过 4 MB，请换一张更小的图片。';
  if (message === 'attachment_invalid_base64' || message === 'attachment_size_mismatch' || message === 'attachment_content_mismatch') {
    return '图片内容校验失败，请重新选择后再试。';
  }
  if (message === 'download_file_not_found') return '本机文件不存在，可能已被移动或删除。';
  if (message === 'download_not_a_file') return '该链接不是可下载的普通文件。';
  if (message === 'download_path_not_allowed') return '该文件不在连接器允许下载的目录中。';
  if (message === 'download_file_changed') return '文件在下载过程中发生变化，请重新点击下载。';
  if (message === 'download_capability_invalid') return '下载授权已失效或不属于当前页面，请重新点击文件链接。';
  if (message === 'download_rate_limited') return '下载请求过快，请稍后重新点击文件链接。';
  if (message === 'download_confirmation_required') return '需要在当前页面确认后才能下载本机文件。';
  if (message.startsWith('download_')) return '本机文件下载失败，请检查电脑连接后重试。';
  if (message.startsWith('desktop_delivery_failed:')) {
    return `桌面 Codex 未接收这条消息：${message.slice('desktop_delivery_failed:'.length)}`;
  }
  if (message === 'thread_active_writer_timeout') {
    return '等待原会话可写已超时，消息没有发送，也没有创建 fork。请确认桌面任务已经结束后重试。';
  }
  if (/already has an active writer/i.test(message)) {
    return '这个会话当前正由桌面 Codex 占用，不能同时从手机写入。请先让桌面任务结束并关闭该会话，再重试；系统不会自动创建 fork。';
  }
  return message;
}

function shortId(value: string) {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function isSessionRunning(status?: string) {
  return /^(?:active|running|inProgress|waiting)$/i.test(String(status || ''));
}

function sessionUpdatedAt(value: Session['updatedAt']) {
  if (!value) return 0;
  const numeric = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value;
  const timestamp = new Date(numeric).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function projectLabel(path: string) {
  const normalized = path.replace(/[\\/]+$/, '');
  const name = normalized.split(/[\\/]/).at(-1) || normalized;
  return name && name !== path ? `${name} — ${path}` : path;
}

function sessionProjectName(path?: string) {
  const value = String(path || '').trim();
  if (!value || isTemporaryProjectPath(value)) return '';
  const normalized = value.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).at(-1) || normalized;
}

function isTemporaryProjectPath(path: string) {
  const normalized = String(path || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
  if (!normalized) return false;
  return /\/documents\/codex\/\d{4}-\d{2}-\d{2}(?:\/|$)/.test(normalized)
    || /\/\.codex\/(?:tmp|temp|worktrees|visualizations)(?:\/|$)/.test(normalized)
    || /\/appdata\/local\/temp(?:\/|$)/.test(normalized)
    || /\/(?:windows\/)?temp(?:\/|$)/.test(normalized);
}

function formatDate(value: Session['updatedAt']) {
  if (!value) return '未知时间';
  const numeric = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return '最近更新';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
