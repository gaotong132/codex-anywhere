import type { TimelineItem } from './history-utils';

// A terminal error can arrive both as an error event and in turn/completed.
export function appendTimelineNotice(items: TimelineItem[], next: TimelineItem): TimelineItem[] {
  if (next.historyTurnId && next.notice?.kind === 'turnStatus' && next.notice.status !== 'aborted') {
    const notice = next.notice;
    const index = items.findIndex((item) => item.historyTurnId === next.historyTurnId
      && item.notice?.kind === 'turnStatus' && item.notice.status !== 'aborted');
    if (index >= 0) return items.map((item, i) => i === index ? {
      ...item, notice: { ...notice, detail: notice.detail || (item.notice?.kind === 'turnStatus' ? item.notice.detail : '') },
    } : item);
  }
  return [...items, next];
}
