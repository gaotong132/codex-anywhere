import { t } from './i18n';

export type ImageUploadState = { phase: 'preparing' | 'sending' | 'confirming'; percent: number };

export function ImageUploadProgress({ state }: { state: ImageUploadState }) {
  const label = state.phase === 'preparing'
    ? t('正在准备图片…', 'Preparing image…')
    : state.phase === 'confirming'
      ? t('图片已发送，等待确认…', 'Image sent, awaiting confirmation…')
      : t(`正在发送图片 · ${state.percent}%`, `Sending image · ${state.percent}%`);
  return <div className="image-upload-progress">
    <small role="status">{label}</small>
    <progress max={100} value={state.phase === 'preparing' ? undefined : state.percent} aria-label={label} />
  </div>;
}
