import { describe, expect, it } from 'vitest';
import {
  IMAGE_LOAD_RETRY_DELAYS_MS,
  getImageLoadRetryDelay,
  isRetryableImageSource,
} from '../../src/utils/imageLoadRetry';

describe('imageLoadRetry', () => {
  it('uses bounded backoff delays and then stops retrying', () => {
    expect(IMAGE_LOAD_RETRY_DELAYS_MS.map((_, attempt) => getImageLoadRetryDelay(attempt)))
      .toEqual([400, 1_200, 2_500]);
    expect(getImageLoadRetryDelay(3)).toBeNull();
    expect(getImageLoadRetryDelay(99)).toBeNull();
  });

  it('retries remote and Tauri asset sources but not complete in-memory data', () => {
    expect(isRetryableImageSource('https://cdn.example.com/generated.png?token=abc')).toBe(true);
    expect(isRetryableImageSource('http://asset.localhost/C%3A/project/generated.png')).toBe(true);
    expect(isRetryableImageSource('asset://localhost/generated.png')).toBe(true);
    expect(isRetryableImageSource('data:image/png;base64,abc')).toBe(false);
    expect(isRetryableImageSource('blob:http://localhost/id')).toBe(false);
  });
});
