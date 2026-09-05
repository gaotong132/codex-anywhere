import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { localFileName, safeDownloadName } from './file-utils';
import { downloadCanContinue, runResumableDownloadRequest, waitForDownloadReady } from './download-resume';
import { decodeDownloadChunk, validateDownloadCapability } from './download-validation';
import { DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS, type BridgeRequest } from './bridge-request-manager';
import { environmentShortName } from './execution-environments';
import { t } from './i18n';
import type { FileDownloadState, OpenedDownload, DownloadFileChunk } from './app-types';

type ScreenWakeLockSentinel = { released: boolean; release(): Promise<void> };
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<ScreenWakeLockSentinel> };
};

type FileTransferOptions = {
  online: boolean;
  request: BridgeRequest;
  reportTimelineError: (error: unknown) => void;
  environmentIdRef: RefObject<string>;
  selectedRequestRef: RefObject<number>;
  connectorOnlineRef: RefObject<boolean>;
  secureChannelRef: RefObject<{ isReady(): boolean } | null>;
};

export function useFileTransfer({
  online, request, reportTimelineError, environmentIdRef, selectedRequestRef, connectorOnlineRef, secureChannelRef,
}: FileTransferOptions) {
  const [fileDownload, setFileDownload] = useState<FileDownloadState | null>(null);
  const fileDownloadRef = useRef(false);
  const fileDownloadCancelRef = useRef(false);
  const fileDownloadAbortRef = useRef<AbortController | null>(null);
  const downloadWakeLockRef = useRef<ScreenWakeLockSentinel | null>(null);
  const wakeLockRequestRef = useRef(false);
  const acquireDownloadWakeLock = useCallback(async () => {
    if (!fileDownloadRef.current || document.visibilityState !== 'visible'
      || wakeLockRequestRef.current || (downloadWakeLockRef.current && !downloadWakeLockRef.current.released)) return;
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (!wakeLock?.request) {
      setFileDownload((current) => (current ? { ...current, protection: 'foreground-only' } : current));
      return;
    }
    const owner = fileDownloadAbortRef.current;
    wakeLockRequestRef.current = true;
    try {
      const sentinel = await wakeLock.request('screen');
      if (!fileDownloadRef.current || fileDownloadAbortRef.current !== owner) {
        await sentinel.release().catch(() => {});
        return;
      }
      downloadWakeLockRef.current = sentinel;
      setFileDownload((current) => (current ? { ...current, protection: 'screen-awake' } : current));
    } catch {
      if (fileDownloadAbortRef.current === owner) setFileDownload((current) => (current ? { ...current, protection: 'foreground-only' } : current));
    } finally { wakeLockRequestRef.current = false; }
  }, []);

  const releaseDownloadWakeLock = useCallback(async () => {
    const sentinel = downloadWakeLockRef.current;
    downloadWakeLockRef.current = null;
    if (sentinel && !sentinel.released) await sentinel.release().catch(() => {});
  }, []);

  useEffect(() => {
    if (!fileDownloadRef.current) return;
    const paused = !downloadCanContinue({
      visible: document.visibilityState === 'visible',
      online,
      channelReady: Boolean(secureChannelRef.current?.isReady()),
    });
    setFileDownload((current) => (current ? {
      ...current,
      paused,
      pauseReason: paused
        ? (document.visibilityState === 'visible' ? 'connection' : 'background')
        : undefined,
    } : current));
  }, [online]);

  useEffect(() => {
    const syncDownloadVisibility = () => {
      if (!fileDownloadRef.current) return;
      if (document.visibilityState === 'visible') {
        void acquireDownloadWakeLock();
        return;
      }
      setFileDownload((current) => (current ? {
        ...current, paused: true, pauseReason: 'background',
      } : current));
    };
    document.addEventListener('visibilitychange', syncDownloadVisibility);
    return () => document.removeEventListener('visibilitychange', syncDownloadVisibility);
  }, [acquireDownloadWakeLock]);

  const downloadLocalFile = useCallback(async (path: string) => {
    if (fileDownloadRef.current) return;
    const sourceEnvironmentId = environmentIdRef.current;
    const selectionVersion = selectedRequestRef.current;
    const wakeLockSupported = Boolean((navigator as WakeLockNavigator).wakeLock?.request);
    const sourceName = environmentShortName(environmentIdRef.current);
    const accepted = window.confirm(
      t(
        `是否从${sourceName}下载以下文件？\n\n${path}\n\n${wakeLockSupported ? '下载期间会保持屏幕常亮。若手动息屏或切到后台，下载会安全暂停，回到本页后自动续传。' : '当前浏览器无法保证后台下载，请保持屏幕亮起；若息屏中断，回到本页后会自动续传。'}`,
        `Download this file from ${sourceName}?\n\n${path}\n\n${wakeLockSupported ? 'The screen will stay awake during the download. If you lock it or leave the page, the transfer pauses safely and resumes when you return.' : 'This browser cannot guarantee background downloads. Keep the screen awake; if interrupted, the transfer resumes when you return.'}`,
      ),
    );
    if (!accepted) return;
    fileDownloadRef.current = true;
    fileDownloadCancelRef.current = false;
    const abortController = new AbortController();
    fileDownloadAbortRef.current = abortController;
    const initiallyPaused = !downloadCanContinue({
      visible: document.visibilityState === 'visible',
      online,
      channelReady: Boolean(secureChannelRef.current?.isReady()),
    });
    setFileDownload({
      name: localFileName(path),
      size: 0,
      received: 0,
      paused: initiallyPaused,
      pauseReason: initiallyPaused
        ? (document.visibilityState === 'visible' ? 'connection' : 'background')
        : undefined,
      protection: 'checking',
    });
    void acquireDownloadWakeLock();
    let opened: OpenedDownload | null = null;
    try {
      const isReady = () => downloadCanContinue({
        visible: document.visibilityState === 'visible',
        online: connectorOnlineRef.current
          && environmentIdRef.current === sourceEnvironmentId
          && selectedRequestRef.current === selectionVersion,
        channelReady: Boolean(secureChannelRef.current?.isReady()),
      });
      const pauseDownload = () => setFileDownload((current) => (current ? {
        ...current,
        paused: true,
        pauseReason: document.visibilityState === 'visible' ? 'connection' : 'background',
      } : current));
      const resumeDownload = () => setFileDownload((current) => (current ? {
        ...current, paused: false, pauseReason: undefined,
      } : current));
      const resilientRequest = async <T,>(action: string, payload: Record<string, unknown>) => (
        runResumableDownloadRequest<T>({
          signal: abortController.signal,
          isReady,
          onPause: pauseDownload,
          onResume: resumeDownload,
          request: () => request<T>(action, payload, {
            timeoutMs: DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
            signal: abortController.signal,
          }),
        })
      );
      opened = await resilientRequest<OpenedDownload>(
        'file.download.open',
        { path, confirmed: true },
      );
      validateDownloadCapability(opened);
      setFileDownload((current) => ({
        name: opened!.name,
        size: opened!.size,
        received: 0,
        paused: false,
        protection: current?.protection || 'checking',
      }));
      const parts: BlobPart[] = [];
      let offset = 0;
      while (true) {
        if (fileDownloadCancelRef.current) throw new Error('download_cancelled');
        const chunk = await resilientRequest<DownloadFileChunk>('file.download.chunk', {
          downloadId: opened.downloadId,
          downloadToken: opened.downloadToken,
          offset,
        });
        if (fileDownloadCancelRef.current) throw new Error('download_cancelled');
        const bytes = decodeDownloadChunk(chunk, offset, opened.size);
        parts.push(bytes);
        offset = chunk.nextOffset;
        const transferPaused = !isReady();
        setFileDownload((current) => (current ? {
          ...current,
          name: opened!.name,
          size: opened!.size,
          received: offset,
          paused: transferPaused,
          pauseReason: transferPaused
            ? (document.visibilityState === 'visible' ? 'connection' : 'background')
            : undefined,
        } : current));
        if (chunk.done) break;
      }
      await waitForDownloadReady({
        signal: abortController.signal,
        isReady: () => document.visibilityState === 'visible'
          && environmentIdRef.current === sourceEnvironmentId
          && selectedRequestRef.current === selectionVersion,
        onPause: pauseDownload,
      });
      if (fileDownloadCancelRef.current
        || environmentIdRef.current !== sourceEnvironmentId
        || selectedRequestRef.current !== selectionVersion) {
        throw new Error('download_cancelled');
      }
      resumeDownload();
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = safeDownloadName(opened.name);
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      if (!(error instanceof Error && error.message === 'download_cancelled')) {
        reportTimelineError(error);
      }
    } finally {
      const ownsDownload = fileDownloadAbortRef.current === abortController;
      if (opened && environmentIdRef.current === sourceEnvironmentId) {
        void request('file.download.close', {
          downloadId: opened.downloadId,
          downloadToken: opened.downloadToken,
        }).catch(() => {});
      }
      if (ownsDownload) {
        fileDownloadRef.current = false;
        fileDownloadCancelRef.current = false;
        fileDownloadAbortRef.current = null;
        setFileDownload(null);
        await releaseDownloadWakeLock();
      }
    }
  }, [acquireDownloadWakeLock, online, releaseDownloadWakeLock, reportTimelineError, request]);

  const cancelFileDownload = useCallback(() => {
    fileDownloadCancelRef.current = true;
    fileDownloadAbortRef.current?.abort();
  }, []);

  useEffect(() => () => {
    fileDownloadCancelRef.current = true;
    fileDownloadAbortRef.current?.abort();
    void releaseDownloadWakeLock();
  }, [releaseDownloadWakeLock]);
  return { fileDownload, downloadLocalFile, cancelFileDownload };
}
