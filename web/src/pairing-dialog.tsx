import { FormEvent, useEffect, useRef, useState } from 'react';
import type QrScanner from 'qr-scanner';
import {
  parseBrowserPairingCredential,
  type BrowserPairingCredential,
} from '../../src/shared/pairing-auth';
import { t } from './i18n';

type PairingDialogProps = {
  open: boolean;
  value: string;
  onValueChange: (value: string) => void;
  pairing: boolean;
  status: string;
  error: string;
  onCancel: () => void;
  onClose: () => void;
  onPair: (credential: BrowserPairingCredential) => void;
};

export function PairingDialog({ open, value, onValueChange, pairing, status, error: connectionError, onCancel, onClose, onPair }: PairingDialogProps) {
  const [error, setError] = useState('');
  const [hasCamera, setHasCamera] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [readingImage, setReadingImage] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const scanGenerationRef = useRef(0);

  const stopCamera = () => {
    scanGenerationRef.current += 1;
    scannerRef.current?.destroy();
    scannerRef.current = null;
    setCameraActive(false);
    setReadingImage(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  useEffect(() => {
    if (!open) return undefined;
    setError('');
    void import('qr-scanner')
      .then(({ default: Scanner }) => Scanner.hasCamera())
      .then(setHasCamera)
      .catch(() => setHasCamera(false));
    return stopCamera;
  }, [open]);

  useEffect(() => {
    setError('');
    stopCamera();
  }, [value, pairing]);

  const accept = (input: string) => {
    if (pairing) return;
    try {
      const credential = parseBrowserPairingCredential(input);
      setError('');
      stopCamera();
      onPair(credential);
    } catch {
      setError(t('没有识别到有效的 Codex Anywhere 配对码', 'No valid Codex Anywhere pairing code was found'));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    accept(value);
  };

  const startCamera = async () => {
    if (!videoRef.current) return;
    setError('');
    stopCamera();
    const generation = scanGenerationRef.current;
    try {
      const { default: Scanner } = await import('qr-scanner');
      if (generation !== scanGenerationRef.current || !videoRef.current) return;
      const scanner = new Scanner(videoRef.current, (result) => {
        if (generation === scanGenerationRef.current) accept(result.data);
      }, {
        preferredCamera: 'environment',
        highlightScanRegion: true,
        highlightCodeOutline: true,
        returnDetailedScanResult: true,
      });
      scannerRef.current = scanner;
      setCameraActive(true);
      await scanner.start();
    } catch {
      if (generation !== scanGenerationRef.current) return;
      stopCamera();
      setError(t('无法使用摄像头，请粘贴链接或上传二维码截图', 'Camera unavailable. Paste the link or upload a QR screenshot.'));
    }
  };

  const readImage = async (file: File | undefined) => {
    if (!file) return;
    stopCamera();
    const generation = scanGenerationRef.current;
    setReadingImage(true);
    setError('');
    try {
      const { default: Scanner } = await import('qr-scanner');
      const result = await Scanner.scanImage(file, {
        returnDetailedScanResult: true,
        alsoTryWithoutScanRegion: true,
      });
      if (generation === scanGenerationRef.current) accept(result.data);
    } catch {
      if (generation === scanGenerationRef.current) {
        setError(t('图片中没有识别到有效二维码', 'No valid QR code was found in the image'));
      }
    } finally {
      if (generation === scanGenerationRef.current) {
        setReadingImage(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    }
  };

  if (!open) return null;
  return (
    <div className="pairing-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) { stopCamera(); onClose(); }
    }}>
      <section className="pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <header>
          <div>
            <p className="eyebrow">SECURE PAIRING</p>
            <h2 id="pairing-title">{t('配对这台设备', 'Pair this device')}</h2>
          </div>
          <button type="button" aria-label={t('关闭', 'Close')} onClick={() => { stopCamera(); onClose(); }}>×</button>
        </header>
        <form onSubmit={submit}>
          <label htmlFor="pairing-value">{t('配对链接或代码', 'Pairing link or code')}</label>
          <div className="pairing-value-row">
            <input
              id="pairing-value"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              disabled={pairing}
              onChange={(event) => { setError(''); onValueChange(event.target.value); }}
              placeholder={t('粘贴一次性配对链接', 'Paste the one-time pairing link')}
            />
            <button type="submit" className="primary" disabled={pairing || !value.trim()}>{pairing ? t('配对中…', 'Pairing…') : t('配对', 'Pair')}</button>
          </div>
        </form>
        {pairing && <div className="pairing-attempt" role="status">
          <span>{status}</span>
          <button type="button" onClick={onCancel}>{t('取消配对', 'Cancel pairing')}</button>
        </div>}
        <div className="pairing-alternatives">
          <input
            ref={fileRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            onChange={(event) => void readImage(event.target.files?.[0])}
          />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={readingImage || pairing}>
            {readingImage ? t('正在识别…', 'Reading…') : t('上传二维码截图', 'Upload QR screenshot')}
          </button>
          {hasCamera && (
            <button type="button" disabled={pairing} onClick={() => cameraActive ? stopCamera() : void startCamera()}>
              {cameraActive ? t('关闭摄像头', 'Stop camera') : t('使用摄像头扫描', 'Scan with camera')}
            </button>
          )}
        </div>
        <div className={`pairing-camera ${cameraActive ? 'active' : ''}`}>
          <video ref={videoRef} muted playsInline />
        </div>
        <p className="pairing-help">{t(
          '摄像头不是必需的：可以粘贴链接，或上传二维码截图。图片只在当前浏览器中识别。',
          'A camera is optional: paste the link or upload a QR screenshot. Images are decoded only in this browser.',
        )}</p>
        {(error || connectionError) && <p className="pairing-error" role="alert">{error || connectionError}</p>}
      </section>
    </div>
  );
}
