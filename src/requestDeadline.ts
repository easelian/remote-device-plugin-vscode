import { REQUEST_TIMEOUT_MS } from './authConfig';

export class RequestDeadlineError extends Error {
  constructor(stage: string) {
    super(`${stage} timed out`);
  }
}

export function abortable<T>(
  work: Thenable<T>,
  signal: AbortSignal,
  stage: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  let cleanup = () => {};
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    const timer = setTimeout(() => reject(new RequestDeadlineError(stage)), timeoutMs);
    cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      aborted();
    }
    Promise.resolve(work).then(resolve, reject);
  }).finally(() => cleanup());
}

// Some transports do not settle when their signal aborts. The deadline
// bounds the caller's wait as well as requesting cancellation of the I/O.
export async function withRequestDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  stage: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  controller = new AbortController(),
): Promise<T> {
  try {
    controller.signal.throwIfAborted();
    return await abortable(run(controller.signal), controller.signal, stage, timeoutMs);
  } finally {
    controller.abort();
  }
}
