import type { Turn } from './history-utils';

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
};
export type BridgeMessage = {
  type: string;
  challenge?: string;
  deviceAuth?: string;
  deviceId?: string;
  identityId?: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  data?: unknown;
  devices?: string[];
  event?: string;
  payload?: Record<string, unknown>;
};
export type DeviceRole = 'client' | 'connector';
export type ApprovedDevice = {
  id: string;
  publicKey: string;
  role: DeviceRole;
  routeDeviceId?: string;
  label: string;
  approvedAt: number;
};
export type PendingDevice = {
  requestId: string;
  id: string;
  publicKey: string;
  role: DeviceRole;
  routeDeviceId?: string;
  label: string;
  address: string;
  requestedAt: number;
};
export type DeviceInventory = {
  currentDeviceId: string | null;
  approved: ApprovedDevice[];
  pending: PendingDevice[];
};
export type HistoryPage = {
  threadId: string;
  turns: Turn[];
  nextCursor: string | null;
  truncated?: boolean;
  source?: string;
  activityId?: string;
  toolPurpose?: string;
};
export type TurnStartResult = { threadId: string; delivery?: 'desktop' | 'appServer' };
export type PendingImage = { file: File; transferPreview?: File; previewUrl: string };
export type DownloadedImage = { path: string; mimeType: string; size: number; data: string };
export type OpenedDownload = { downloadId: string; downloadToken: string; name: string; size: number };
export type DownloadFileChunk = { offset: number; nextOffset: number; done: boolean; data: string };
export type FileDownloadState = { name: string; size: number; received: number };
