import { useCallback } from 'react';
import type { BridgeRequest } from './bridge-request-manager';
import type { TextPreviewDocument, TurnDiffDocument, VisualizationDocument } from './app-types';

export function validPreviewText(content: unknown, size: unknown, maximumBytes: number) {
  return typeof content === 'string' && !content.includes('\0')
    && Number.isSafeInteger(size) && Number(size) >= 0 && Number(size) <= maximumBytes
    && new Blob([content]).size === size;
}

export function validateTextPreview(result: TextPreviewDocument) {
  if (!result || typeof result.name !== 'string' || !validPreviewText(result.content, result.size, 2 * 1024 * 1024)
    || !['markdown', 'code', 'text'].includes(result.kind)
    || typeof result.language !== 'string' || !/^[a-z0-9-]{1,32}$/.test(result.language)) {
    throw new Error('text_preview_content_invalid');
  }
  return result;
}

export function useFilePreviews(request: BridgeRequest, threadId: string | null) {
  const readVisualization = useCallback(async (path: string) => {
    const result = await request<VisualizationDocument>('visualization.read', { path });
    if (!result?.content || !validPreviewText(result.content, result.size, 2 * 1024 * 1024)) {
      throw new Error('visualization_content_invalid');
    }
    return URL.createObjectURL(new Blob([result.content], { type: 'text/html' }));
  }, [request]);

  const readTextFile = useCallback(async (path: string) => (
    validateTextPreview(await request<TextPreviewDocument>('file.text.read', { path }))
  ), [request]);

  const readTurnDiff = useCallback(async (turnId: string) => {
    const selectedThreadId = String(threadId || '').trim();
    const selectedTurnId = String(turnId || '').trim();
    if (!selectedThreadId || !selectedTurnId) throw new Error('turn_diff_unavailable');
    const result = await request<TurnDiffDocument>('session.turn.diff.read', {
      threadId: selectedThreadId, turnId: selectedTurnId,
    });
    if (!result || result.threadId !== selectedThreadId || result.turnId !== selectedTurnId
      || !result.size || !validPreviewText(result.content, result.size, 512 * 1024)
      || typeof result.truncated !== 'boolean') throw new Error('turn_diff_content_invalid');
    return result;
  }, [request, threadId]);
  return { readVisualization, readTextFile, readTurnDiff };
}
