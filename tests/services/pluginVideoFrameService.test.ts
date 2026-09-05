import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({ open: vi.fn(), probe: vi.fn(), extract: vi.fn(), iterate: vi.fn(), dispose: vi.fn() }));
vi.mock('../../src/services/videoEditorMediaService', () => ({
  createVideoInput: media.open, probeVideoSource: media.probe,
  extractFramesAtTimestamps: media.extract, iterateVideoFrames: media.iterate,
}));

import {
  buildUniformFrameRequests,
  validateAnalysisFrameRequests,
  detectPluginVideoShots,
  inspectPluginVideoFrame,
  frameDifference,
  validateShotDetectionRange,
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

describe('plugin video shot operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    media.open.mockResolvedValue({ dispose: media.dispose });
    media.probe.mockResolvedValue({ duration: 1 });
    vi.stubGlobal('document', { createElement: () => {
      let color = 0;
      return { width: 64, height: 36,
        convertToBlob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
        getContext: () => ({
          drawImage: (canvas: { color?: number }) => { color = canvas.color ?? 0; },
          getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4).fill(color) }),
        }),
      };
    } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses VFR sample timestamps and steps back from the exclusive video end once', async () => {
    const times = [0, 0.0333667, 0.08, 0.13];
    media.probe.mockResolvedValue({ duration: 0.2 });
    media.extract.mockImplementation(async (_input: unknown, options: { timestamps: number[] }) => {
      const i = times.findLastIndex((time) => time <= options.timestamps[0]);
      return [{ actualTime: times[i], duration: (times[i + 1] ?? 0.2) - times[i], width: 64, height: 36, canvas: { width: 64, height: 36 } }];
    });
    expect(await inspectPluginVideoFrame({ url: 'video', time: 0.0333667, direction: 1 })).toMatchObject({ actualTime: 0.08 });
    expect(await inspectPluginVideoFrame({ url: 'video', time: 0.08, direction: -1 })).toMatchObject({ actualTime: 0.0333667 });
    expect(await inspectPluginVideoFrame({ url: 'video', time: 0.2, direction: -1 })).toMatchObject({ actualTime: 0.13 });
    await expect(inspectPluginVideoFrame({ url: 'video', time: 0, direction: -1 })).rejects.toThrow('第一帧');
    await expect(inspectPluginVideoFrame({ url: 'video', time: 0.13, direction: 1 })).rejects.toThrow('最后一帧');
    expect(await inspectPluginVideoFrame({ url: 'video', time: 0.13, direction: 1, boundary: true })).toMatchObject({ actualTime: 0.13, boundaryTime: 0.2 });
    expect(media.dispose).toHaveBeenCalledTimes(6);
  });

  function sequence(colors: number[]) {
    media.iterate.mockImplementation(async function* () {
      for (let i = 0; i < colors.length; i++) yield { actualTime: i * 0.04, duration: 0.04, canvas: { color: colors[i] } };
    });
  }
  it('detects a persistent hard cut and suppresses both edges of a single-frame flash', async () => {
    sequence([0, 0, 0, 255, 255, 255]);
    const hardCut = await detectPluginVideoShots({ url: 'video', start: 0, end: 0.24, minShotDuration: 0.04 });
    expect(hardCut.shots).toEqual([{ inPoint: 0, outPoint: 0.12, score: 0 }, { inPoint: 0.12, outPoint: 0.24, score: 1 }]);
    sequence([0, 0, 0, 255, 0, 0]);
    const flash = await detectPluginVideoShots({ url: 'video', start: 0, end: 0.24, minShotDuration: 0.04 });
    expect(flash.shots).toHaveLength(1);
    expect(media.dispose).toHaveBeenCalledTimes(2);
  });
  it('validates bounded ranges, differences and cancellation without returning partial cuts', async () => {
    expect(() => validateShotDetectionRange(0, 301, 400)).toThrow('300 秒');
    expect(() => validateShotDetectionRange(1, 0, 2)).toThrow('区间');
    expect(frameDifference(new Uint8ClampedArray([0, 0, 0, 255]), new Uint8ClampedArray([0, 0, 0, 255]))).toBe(0);
    sequence([0, 0]);
    const controller = new AbortController(); controller.abort();
    await expect(detectPluginVideoShots({ url: 'video', start: 0, end: 1, signal: controller.signal })).rejects.toThrow('取消');
    expect(media.dispose).toHaveBeenCalledOnce();
  });
});
