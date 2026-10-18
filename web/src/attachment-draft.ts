import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import type { PendingAttachment } from './app-types';
import { prepareAttachment } from './file-upload';

function discardAttachment(attachment: PendingAttachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

/** Only the latest selection may publish a result or an error. */
export function createAttachmentPreparation(
  prepare = prepareAttachment,
  discard = discardAttachment,
) {
  let generation = 0;
  return {
    invalidate() { generation++; },
    async choose(file: File | undefined, apply: (value: PendingAttachment) => void,
      onError: (error: unknown) => void, isCurrent = () => true) {
      if (!file) return;
      const version = ++generation;
      const current = () => version === generation && isCurrent();
      try {
        const result = await prepare(file);
        if (current()) apply(result);
        else discard(result);
      } catch (error) {
        if (current()) onError(error);
      }
    },
  };
}

export function useAttachmentDraft() {
  const [attachment, setValue] = useState<PendingAttachment | null>(null);
  const [preparation] = useState(createAttachmentPreparation);
  const setAttachment = useCallback((value: SetStateAction<PendingAttachment | null>) => {
    preparation.invalidate();
    setValue(value);
  }, [preparation]);
  const choose = useCallback((file: File | undefined, onError: (error: unknown) => void, isCurrent?: () => boolean) =>
    preparation.choose(file, setValue, onError, isCurrent), [preparation]);
  useEffect(() => () => preparation.invalidate(), [preparation]);
  useEffect(() => () => { if (attachment) discardAttachment(attachment); }, [attachment]);
  return { attachment, setAttachment, choose, invalidate: preparation.invalidate };
}
