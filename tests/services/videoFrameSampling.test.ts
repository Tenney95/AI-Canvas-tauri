import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  yielded: [] as Array<{
    canvas: { width: number; height: number };
    timestamp: number;
    duration: number;
  } | null>,
  sinkOptions: undefined as Record<string, unknown> | undefined,
  receivedTimestamps: [] as number[],
}));

vi.mock('mediabunny', () => {
  class EmptyClass {}
  class CanvasSink {
    constructor(_track: unknown, options: Record<string, unknown>) {
      mocks.sinkOptions = options;
    }

    async *canvasesAtTimestamps(timestamps: Iterable<number>) {
      mocks.receivedTimestamps = [...timestamps];
      for (const item of mocks.yielded) yield item;
    }
  }
  return {
    ALL_FORMATS: [],
    AudioBufferSource: EmptyClass,
    BlobSource: EmptyClass,
    BufferTarget: EmptyClass,
    CanvasSink,
    CanvasSource: EmptyClass,
    CustomSource: EmptyClass,
    EncodedAudioPacketSource: EmptyClass,
    EncodedPacketSink: EmptyClass,
    EncodedVideoPacketSource: EmptyClass,
    Input: EmptyClass,
    Mp4OutputFormat: EmptyClass,
    Output: EmptyClass,
    QUALITY_HIGH: 0.9,
    QUALITY_MEDIUM: 0.7,
  };
});

import { extractFramesAtTimestamps } from '../../src/services/videoEditorMediaService';

describe('video editor ordered frame sampling', () => {
  it('uses one ordered CanvasSink pipeline and preserves requested versus actual timestamps', async () => {
    mocks.yielded = [
      { canvas: { width: 320, height: 180 }, timestamp: 0.96, duration: 0.04 },
      null,
      { canvas: { width: 320, height: 180 }, timestamp: 2.04, duration: 0.04 },
    ];
    const input = {
      getPrimaryVideoTrack: vi.fn(async () => ({ canDecode: vi.fn(async () => true) })),
    };

    const result = await extractFramesAtTimestamps(input as never, {
      timestamps: [1, 1.5, 2],
      height: 180,
    });

    expect(mocks.receivedTimestamps).toEqual([1, 1.5, 2]);
    expect(mocks.sinkOptions).toEqual({ height: 180, fit: 'contain', poolSize: 0 });
    expect(result[0]).toMatchObject({ requestedTime: 1, actualTime: 0.96, duration: 0.04 });
    expect(result[1]).toBeNull();
    expect(result[2]).toMatchObject({ requestedTime: 2, actualTime: 2.04 });
  });

  it('rejects non-monotonic input before constructing the sink', async () => {
    const input = { getPrimaryVideoTrack: vi.fn() };
    await expect(extractFramesAtTimestamps(input as never, {
      timestamps: [2, 1],
      height: 180,
    })).rejects.toThrow('单调递增');
    expect(input.getPrimaryVideoTrack).not.toHaveBeenCalled();
  });
});
