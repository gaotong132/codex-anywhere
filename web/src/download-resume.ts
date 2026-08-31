export type DownloadReadiness = {
  visible: boolean;
  online: boolean;
  channelReady: boolean;
};

export function downloadCanContinue({ visible, online, channelReady }: DownloadReadiness) {
  return visible && online && channelReady;
}

type WaitForDownloadOptions = {
  signal: AbortSignal;
  isReady: () => boolean;
  onPause?: () => void;
  wait?: (signal: AbortSignal) => Promise<void>;
};

type ResumableDownloadRequestOptions<T> = WaitForDownloadOptions & {
  request: () => Promise<T>;
  onResume?: () => void;
};

export async function waitForDownloadReady({
  signal,
  isReady,
  onPause,
  wait = waitForResumeCheck,
}: WaitForDownloadOptions) {
  let paused = false;
  while (!isReady()) {
    if (signal.aborted) throw new Error('download_cancelled');
    if (!paused) {
      paused = true;
      onPause?.();
    }
    await wait(signal);
  }
  if (signal.aborted) throw new Error('download_cancelled');
}

export async function runResumableDownloadRequest<T>({
  signal,
  isReady,
  request,
  onPause,
  onResume,
  wait = waitForResumeCheck,
}: ResumableDownloadRequestOptions<T>) {
  let recovering = false;
  while (true) {
    if (!isReady()) recovering = true;
    await waitForDownloadReady({ signal, isReady, onPause, wait });
    if (recovering) {
      recovering = false;
      onResume?.();
    }
    try {
      return await request();
    } catch (error) {
      if (signal.aborted) throw new Error('download_cancelled');
      if (!isRetryableDownloadInterruption(error)) throw error;
      onPause?.();
      recovering = true;
      await wait(signal);
    }
  }
}

export function isRetryableDownloadInterruption(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^(?:request_timeout|secure_channel_not_ready|secure_channel_failed|download_in_progress|连接已断开|连接未建立|Connection closed|Connection is not established)$/i
    .test(message.trim());
}

function waitForResumeCheck(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('download_cancelled'));
    };
    function finish() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(finish, 400);
  });
}
