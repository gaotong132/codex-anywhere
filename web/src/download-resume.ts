export type DownloadReadiness = {
  online: boolean;
  channelReady: boolean;
};

export function downloadCanContinue({ online, channelReady }: DownloadReadiness) {
  return online && channelReady;
}

type WaitForDownloadOptions = {
  signal: AbortSignal;
  isReady: () => boolean;
  onPause?: () => void;
  wait?: (signal: AbortSignal) => Promise<void>;
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
