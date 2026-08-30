export const IMAGE_LOAD_RETRY_DELAYS_MS = [400, 1_200, 2_500] as const;

/**
 * Returns the delay before the next image load attempt.
 * `failedAttempts` is the number of retries that have already been scheduled.
 */
export function getImageLoadRetryDelay(failedAttempts: number): number | null {
  return IMAGE_LOAD_RETRY_DELAYS_MS[failedAttempts] ?? null;
}

/** Data URLs are already complete in memory; retry only sources that can be temporarily unavailable. */
export function isRetryableImageSource(src: string): boolean {
  return /^(?:https?:|asset:)/i.test(src);
}
