const nextRequestAt = new Map<string, number>();
const INTERVAL_MS = 3_100;

export async function waitForSandRequest(origin: string, lane: 'create' | 'query' | 'upload', signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const key = `${origin}:${lane}`;
  const now = performance.now();
  const slot = Math.max(now, nextRequestAt.get(key) ?? now);
  if (slot - now > 8 * INTERVAL_MS) throw new Error('Sand AI 请求队列已满，请稍候');
  nextRequestAt.set(key, slot + INTERVAL_MS);
  if (slot === now) return;
  let cleanup: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(resolve, slot - now);
      signal?.addEventListener('abort', stop, { once: true });
      cleanup = () => signal?.removeEventListener('abort', stop);
    });
    signal?.throwIfAborted();
  } finally {
    cleanup?.();
  }
}
