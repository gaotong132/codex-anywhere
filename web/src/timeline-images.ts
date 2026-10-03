import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeRequest } from './bridge-request-manager';
import type { DownloadedImage } from './app-types';
import type { ImageAttachment } from './history-utils';
import { isValidImagePayload } from './image-utils';

/** Bound transfers so paging through image-heavy history cannot flood the socket. */
export async function loadTimelineImages(
  attachments: ImageAttachment[], request: BridgeRequest, signal: AbortSignal,
  publish: (path: string, url: string) => void,
) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(3, attachments.length) }, async () => {
    while (!signal.aborted && index < attachments.length) {
      const attachment = attachments[index++];
      try {
        const image = await request<DownloadedImage>('attachment.read', {
          path: attachment.path, source: attachment.source,
        }, { signal });
        if (!isValidImagePayload(image.mimeType, image.data)) throw new Error('attachment_content_mismatch');
        if (!signal.aborted) publish(attachment.path, `data:${image.mimeType};base64,${image.data}`);
      } catch {
        // Aborted/offline reads are not proof that the image has expired.
        if (!signal.aborted) publish(attachment.path, '');
      }
    }
  }));
}

export function useTimelineImages(
  scope: string, attachments: ImageAttachment[], online: boolean, epoch: number, request: BridgeRequest,
) {
  const [cache, setCache] = useState<{ scope: string; urls: Record<string, string> }>({ scope, urls: {} });
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const [retry, setRetry] = useState(0);
  const retryImages = useCallback(() => setRetry((value) => value + 1), []);
  const key = JSON.stringify(attachments.map(({ path, source }) => ({ path, source })));
  const stableAttachments: ImageAttachment[] = useMemo(() => JSON.parse(key), [key]);
  const rememberImage = useCallback((path: string, url: string) => {
    setCache((current) => ({ scope, urls: { ...(current.scope === scope ? current.urls : {}), [path]: url } }));
  }, [scope]);
  useEffect(() => {
    const resume = () => { if (document.visibilityState === 'visible') retryImages(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [retryImages]);
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    const urls = cacheRef.current.scope === scope ? cacheRef.current.urls : {};
    // Keep successful resources across reconnects. Failed resources get another
    // attempt on resume/reconnect or an explicit retry, not on every render.
    void loadTimelineImages(stableAttachments.filter((item) => !urls[item.path]), request, controller.signal, rememberImage);
    return () => controller.abort();
  }, [scope, online, epoch, retry, request, stableAttachments, rememberImage]);
  return { attachmentUrls: cache.scope === scope ? cache.urls : {}, rememberImage, retryImages };
}
