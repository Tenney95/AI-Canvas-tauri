import { describe, expect, it } from 'vitest';

import {
  buildUniformFrameRequests,
  validateAnalysisFrameRequests,
} from '../../src/services/plugins/pluginVideoFrameService';

describe('pluginVideoFrameService request boundaries', () => {
  it('builds stable, monotonically increasing preview requests without sampling the exact end', () => {
    expect(buildUniformFrameRequests(8, 4)).toEqual([
      { key: 'preview-1', time: 0 },
      { key: 'preview-2', time: 2 },
      { key: 'preview-3', time: 4 },
      { key: 'preview-4', time: 6 },
    ]);
  });

  it('accepts up to 24 explicit analysis frames and preserves caller keys', () => {
    const samples = Array.from({ length: 24 }, (_, index) => ({
      key: `frame-${index + 1}`,
      time: index / 2,
    }));
    expect(validateAnalysisFrameRequests(samples, 12)).toEqual(samples);
  });

  it('rejects duplicate keys, non-increasing times, overflow, and out-of-range samples', () => {
    expect(() => validateAnalysisFrameRequests([
      { key: 'frame-1', time: 1 },
      { key: 'frame-1', time: 2 },
    ], 3)).toThrow('key 无效或重复');
    expect(() => validateAnalysisFrameRequests([
      { key: 'frame-1', time: 2 },
      { key: 'frame-2', time: 1 },
    ], 3)).toThrow('严格递增');
    expect(() => validateAnalysisFrameRequests([
      { key: 'frame-1', time: 4 },
    ], 3)).toThrow('超出视频范围');
    expect(() => validateAnalysisFrameRequests(Array.from({ length: 25 }, (_, index) => ({
      key: `frame-${index}`,
      time: index,
    })), 30)).toThrow('1-24');
  });
});
