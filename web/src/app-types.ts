import type { Turn } from './history-utils';
import type { CurrentProtocol, ProtocolOffer } from '../../src/shared/protocol-contract';

export type Session = {
  id: string;
  title: string;
  preview?: string;
  cwd?: string;
  updatedAt?: number | string | null;
  status?: string;
  canStartNewSession?: boolean;
};

export type FollowState = 'idle' | 'checking' | 'following' | 'synced' | 'error';
export type ExecutionState = 'idle' | 'waiting' | 'running' | 'completed' | 'failed';
export type LiveActivityKind = 'starting' | 'planning' | 'command' | 'editing' | 'searching'
  | 'connectedTool' | 'generating' | 'waiting' | 'checking' | 'responding' | 'working';
export type AwaitingDesktopTurn = {
  text: string;
  previousActivityId: string;
  activityId: string;
  seen: boolean;
};
export type Approval = {
  approvalId: string;
  threadId: string;
  kind?: string;
  summary?: string;
  actionable?: boolean;
};
export type PendingApprovals = { approvals: Approval[]; externalApproval?: Approval };
export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  frame: Record<string, unknown>;
  acknowledged: boolean;
};
export type BridgeMessage = {
  type: string;
  protocol?: ProtocolOffer | CurrentProtocol;
  authMode?: 'token' | 'device' | 'pairing';
  challenge?: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  data?: unknown;
  devices?: string[];
  event?: string;
  payload?: Record<string, unknown>;
};
export type HistoryPage = {
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
};
export type TurnStartResult = { threadId: string; delivery?: 'desktop' | 'appServer'; queued?: boolean };
export type PendingImage = { file: File; transferPreview?: File; previewUrl: string };
export type DownloadedImage = { path: string; mimeType: string; size: number; data: string };
export type VisualizationDocument = { name: string; size: number; content?: string };
export type OpenedDownload = { downloadId: string; downloadToken: string; name: string; size: number };
export type DownloadFileChunk = { offset: number; nextOffset: number; done: boolean; data: string };
export type FileDownloadState = { name: string; size: number; received: number };
