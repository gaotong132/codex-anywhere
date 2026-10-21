import type { Turn } from './history-utils';
import type { CurrentProtocol, ProtocolOffer } from '../../src/shared/protocol-contract';
import type { TurnProgress } from '../../src/shared/turn-progress';
import type { ContextUsage } from '../../src/shared/context-compaction';
import type { PermissionMode } from '../../src/shared/permission-mode';

export type Session = {
  id: string;
  title: string;
  preview?: string;
  cwd?: string;
  updatedAt?: number | string | null;
  status?: string;
  canStartNewSession?: boolean;
};
export type ModelOption = {
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
  isDefault: boolean;
};
export type SessionModelConfig = {
  source?: 'desktop' | 'persisted';
  readOnly?: boolean;
  model: string;
  reasoningEffort: string;
  serviceTier: string | null;
  fastMode: boolean;
  models: ModelOption[];
};
export type ModelConfigDraft = Pick<SessionModelConfig, 'model' | 'reasoningEffort' | 'fastMode'>;
export type ConnectorStatus = {
  deviceId: string;
  deviceLabel: string;
  mode: 'desktop' | 'headless';
  platform: string;
  codexOnline: boolean;
  activeTurn: boolean;
  capabilities: { networkAccess: boolean; fullAccess: boolean; fileUpload?: boolean; sessionArchive?: boolean; sessionDelete?: boolean;
    sessionArchivePendingApproval?: boolean; sessionRestore?: boolean; desktopNativeImages?: boolean; desktopNativeState?: boolean };
};
export type SessionPermissionConfig = {
  mode: PermissionMode | 'custom';
  source?: 'desktop' | 'persisted';
  settingsToken?: string;
  editable: boolean;
  networkAccess: boolean;
  allowFullAccess: boolean;
  canOpenOnDesktop?: boolean;
};

export type FollowState = 'idle' | 'checking' | 'following' | 'synced' | 'error';
export type ExecutionState = 'idle' | 'waiting' | 'running' | 'completed' | 'failed';
export type LiveActivityKind = 'starting' | 'planning' | 'command' | 'editing' | 'searching'
  | 'connectedTool' | 'generating' | 'waiting' | 'checking' | 'responding' | 'working' | 'compacting';
export type AwaitingDesktopTurn = {
  text: string;
  previousActivityId: string;
  activityId: string;
  seen: boolean;
};
export type Approval = {
  source?: 'desktop';
  approvalId: string;
  threadId: string;
  kind?: string;
  summary?: string;
  actionable?: boolean;
};
export type OwnedTurn = { threadId: string; turnId: string; state: 'starting' | 'running' | 'cancelling' };
export type NativeDesktopState = { threadId: string; status: string; turnId: string | null; canStop: boolean;
  waitingOnApproval?: boolean; approvals?: Approval[]; model?: string; reasoningEffort?: string; serviceTier?: string };
export type PendingApprovals = { approvals: Approval[]; externalApproval?: Approval;
  desktopState?: { status: string; waitingOnApproval: boolean } & Partial<NativeDesktopState>; desktopStatusUnavailable?: boolean; activeTurn?: OwnedTurn | null };
export type BridgeMessage = {
  type: string;
  protocol?: ProtocolOffer | CurrentProtocol;
  challenge?: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  data?: unknown;
  devices?: string[];
  environments?: Array<{ id: string; label: string; online: boolean }>;
  event?: string;
  payload?: Record<string, unknown>;
};
export type HistoryPage = {
  questionReplies?: import('../../src/shared/async-questions').QuestionReply[];
  compactionStartedAt?: number | null;
  threadId: string;
  turns: Turn[];
  nextCursor: string | null;
  truncated?: boolean;
  source?: string;
  activityId?: string;
  activityKind?: LiveActivityKind;
  activityStartedAt?: number | null;
  activityUpdatedAt?: number | null;
  toolPurpose?: string;
  activityDetail?: string;
  turnProgress?: TurnProgress;
  contextUsage?: ContextUsage;
};
export type TurnStartResult = { threadId: string; delivery?: 'desktop' | 'appServer' };
export type PendingAttachment = { file: File; kind: 'image' | 'file'; transferPreview?: File; previewUrl: string };
export type DownloadedImage = { path: string; mimeType: string; size: number; data: string };
export type VisualizationDocument = { name: string; size: number; content?: string };
export type TextPreviewDocument = {
  name: string;
  size: number;
  content: string;
  kind: 'markdown' | 'code' | 'text';
  language: string;
};
export type TurnDiffDocument = {
  threadId: string;
  turnId: string;
  size: number;
  content: string;
  truncated: boolean;
};
export type OpenedDownload = { downloadId: string; downloadToken: string; name: string; size: number };
export type DownloadFileChunk = { offset: number; nextOffset: number; done: boolean; data: string };
export type FileDownloadState = {
  name: string;
  size: number;
  received: number;
  paused: boolean;
  pauseReason?: 'background' | 'connection';
  protection: 'checking' | 'screen-awake' | 'foreground-only';
};
