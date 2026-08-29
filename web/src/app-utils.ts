import { dateLocale, t } from './i18n';
import type { ExecutionState, FollowState, Session } from './app-types';

export const makeId = () => crypto.randomUUID();

export function presenceLabel(online: boolean, state: ExecutionState, fallback: string) {
  if (!online) return fallback || t('本机连接器离线', 'Local connector offline');
  if (state === 'waiting') return t('正在等待桌面会话空闲', 'Waiting for the desktop session');
  if (state === 'running') return t('Codex 正在执行', 'Codex is running');
  if (state === 'failed') return t('本轮执行失败', 'Run failed');
  if (state === 'completed') return t('本轮执行完成', 'Run completed');
  return fallback || t('已连接', 'Connected');
}

export function followLabel(state: FollowState) {
  if (state === 'following') return t('实时跟随', 'Following live');
  if (state === 'checking') return t('检查进度', 'Checking progress');
  if (state === 'error') return t('跟随重试中', 'Retrying follow');
  return t('已同步', 'Synced');
}

export function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || t('请求失败', 'Request failed'));
  if (message === 'connector_offline') return t('本机连接器离线，请确认电脑已开机且连接器正在运行。', 'The local connector is offline. Make sure the computer and connector are running.');
  if (message === 'another_turn_is_active') return t('当前已有一个任务在运行，请等待完成或先停止。', 'Another task is running. Wait for it to finish or stop it first.');
  if (message === 'project_directory_required') return t('新会话必须选择或填写项目目录。', 'Choose or enter a project directory for the new session.');
  if (message === 'session_project_directory_unavailable') return t('该会话没有可用的项目目录，无法通过连接器继续。', 'This session has no project directory available to the connector.');
  if (message === 'workspace_outside_allowed_root') return t('该目录不在连接器允许访问的范围内。', 'This directory is outside the connector allowed roots.');
  if (message === 'request_timeout') return t('请求超过 30 秒没有响应，请稍后重试。', 'The request timed out after 30 seconds. Try again shortly.');
  if (message === 'turn_start_timeout') return t('等待原会话可写超时，消息没有发送，已恢复到输入框。', 'Timed out waiting for the session to become writable. The message was not sent and has been restored.');
  if (message === 'desktop_app_unavailable') return t('桌面 Codex 当前不可用，请打开桌面应用后重试。', 'Codex Desktop is unavailable. Open it and try again.');
  if (message === 'desktop_delivery_timeout') return t('桌面 Codex 没有及时确认接收，消息已恢复到输入框，请确认后再重试。', 'Codex Desktop did not confirm receipt in time. The message was restored; verify the desktop app before retrying.');
  if (message === 'desktop_required_for_large_session') return t('这是一个超大会话，需要桌面 Codex 打开后才能安全发送到原会话。', 'This large session requires Codex Desktop to be open before a message can be delivered safely.');
  if (message === 'attachment_type_not_allowed') return t('只支持 JPG、PNG 和 WebP 图片。', 'Only JPG, PNG, and WebP images are supported.');
  if (message === 'attachment_too_large') return t('图片处理后仍超过 4 MB，请换一张更小的图片。', 'The processed image is still larger than 4 MB. Choose a smaller image.');
  if (message === 'attachment_invalid_base64' || message === 'attachment_size_mismatch' || message === 'attachment_content_mismatch') {
    return t('图片内容校验失败，请重新选择后再试。', 'Image validation failed. Select the image again and retry.');
  }
  if (message === 'download_file_not_found') return t('本机文件不存在，可能已被移动或删除。', 'The local file does not exist; it may have been moved or deleted.');
  if (message === 'download_not_a_file') return t('该链接不是可下载的普通文件。', 'This link does not point to a downloadable regular file.');
  if (message === 'download_path_not_allowed') return t('该文件不在连接器允许下载的目录中。', 'The file is outside the connector download roots.');
  if (message === 'download_file_changed') return t('文件在下载过程中发生变化，请重新点击下载。', 'The file changed during download. Click the link again.');
  if (message === 'download_capability_invalid') return t('下载授权已失效或不属于当前页面，请重新点击文件链接。', 'The download permission expired or belongs to another page. Click the file link again.');
  if (message === 'download_rate_limited') return t('下载请求过快，请稍后重新点击文件链接。', 'Download requests are too frequent. Wait and click the file link again.');
  if (message === 'download_confirmation_required') return t('需要在当前页面确认后才能下载本机文件。', 'Confirm the download on this page first.');
  if (message.startsWith('download_')) return t('本机文件下载失败，请检查电脑连接后重试。', 'Local file download failed. Check the computer connection and retry.');
  if (message.startsWith('desktop_delivery_failed:')) {
    const detail = message.slice('desktop_delivery_failed:'.length);
    return t(`桌面 Codex 未接收这条消息：${detail}`, `Codex Desktop did not receive this message: ${detail}`);
  }
  if (message === 'thread_active_writer_timeout') {
    return t('等待原会话可写已超时，消息没有发送，也没有创建 fork。请确认桌面任务已经结束后重试。', 'Timed out waiting for the original session. The message was not sent and no fork was created. Ensure the desktop task has ended, then retry.');
  }
  if (/already has an active writer/i.test(message)) {
    return t('这个会话当前正由桌面 Codex 占用，不能同时从手机写入。请先让桌面任务结束并关闭该会话，再重试；系统不会自动创建 fork。', 'Codex Desktop is currently writing to this session, so the phone cannot write at the same time. Finish and close the desktop task before retrying; no fork will be created automatically.');
  }
  return message;
}

export function isConnectionInterruption(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^(?:连接已断开|连接未建立|Connection closed|Connection is not established)$/i.test(message.trim());
}

export function replayPendingFrames(
  pending: Iterable<{ frame: Record<string, unknown> }>,
  send: (frame: Record<string, unknown>) => boolean,
) {
  let replayed = 0;
  for (const item of pending) {
    if (!send(item.frame)) break;
    replayed += 1;
  }
  return replayed;
}

export function shortId(value: string) {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

export function isSessionRunning(status?: string) {
  return /^(?:active|running|inProgress|waiting)$/i.test(String(status || ''));
}

export type SessionAttentionState = Record<string, 'running' | 'unread'>;

export function reconcileSessionAttention(
  current: SessionAttentionState,
  sessions: Session[],
  activeThreadId: string | null,
  locallyRunningThreadId: string | null = null,
) {
  const next: SessionAttentionState = {};
  for (const session of sessions) {
    const previous = current[session.id];
    const running = isSessionRunning(session.status) || session.id === locallyRunningThreadId;
    if (running) next[session.id] = 'running';
    else if (previous === 'running' && session.id !== activeThreadId) next[session.id] = 'unread';
    else if (previous === 'unread') next[session.id] = 'unread';
  }
  const currentEntries = Object.entries(current);
  const nextEntries = Object.entries(next);
  return currentEntries.length === nextEntries.length
    && nextEntries.every(([id, state]) => current[id] === state) ? current : next;
}

export function markSessionAttentionRead(current: SessionAttentionState, threadId: string) {
  if (current[threadId] !== 'unread') return current;
  const next = { ...current };
  delete next[threadId];
  return next;
}

export function canStopOwnedTurn(running: boolean, ownedThreadId: string | null, selectedThreadId: string | null) {
  return running && Boolean(ownedThreadId) && ownedThreadId === selectedThreadId;
}

export function isNearScrollBottom(
  metrics: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = 180,
) {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold;
}

export function sessionUpdatedAt(value: Session['updatedAt']) {
  if (!value) return 0;
  const numeric = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value;
  const timestamp = new Date(numeric).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function projectLabel(path: string) {
  const normalized = path.replace(/[\\/]+$/, '');
  const name = normalized.split(/[\\/]/).at(-1) || normalized;
  return name && name !== path ? `${name} — ${path}` : path;
}

export function sessionProjectName(path?: string) {
  const value = String(path || '').trim();
  if (!value || isTemporaryProjectPath(value)) return '';
  const normalized = value.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).at(-1) || normalized;
}

export function isTemporaryProjectPath(path: string) {
  const normalized = String(path || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
  if (!normalized) return false;
  return /\/documents\/codex\/\d{4}-\d{2}-\d{2}(?:\/|$)/.test(normalized)
    || /\/\.codex\/(?:tmp|temp|worktrees|visualizations)(?:\/|$)/.test(normalized)
    || /\/appdata\/local\/temp(?:\/|$)/.test(normalized)
    || /\/(?:windows\/)?temp(?:\/|$)/.test(normalized);
}

export function formatDate(value: Session['updatedAt']) {
  if (!value) return t('未知时间', 'Unknown time');
  const numeric = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return t('最近更新', 'Recently updated');
  return new Intl.DateTimeFormat(dateLocale, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
