import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoEditorProjectRecord } from '../../src/types/videoEditor';
const mocks = vi.hoisted(() => ({
  sources: new Map<string, { nodeId: string; filePath?: string; sourceUrl?: string; assetId?: string; fileName: string }>(),
  nodes: [] as Array<{ id: string; type: string }>,
  input: { dispose: vi.fn(), getPrimaryAudioTrack: vi.fn() },
  bitmap: { width: 960, height: 540, close: vi.fn() },
  createInput: vi.fn(), probe: vi.fn(), frames: vi.fn(), render: vi.fn(), dimensions: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ nodes: mocks.nodes }) } }));
vi.mock('../../src/store/store.utils', () => ({ blobToDataUrl: async () => 'data:image/jpeg;base64,frame' }));
vi.mock('../../src/services/fileService', () => ({ getConvertFileSrc: () => (path: string) => `asset://${path}` }));
vi.mock('../../src/services/videoEditorControlService', () => ({
  assertVideoEditorContext: (context: { signal: AbortSignal }) => { if (context.signal.aborted) throw new Error('cancelled'); },
  bindVideoEditorMedia: (nodeId: string) => { const source = mocks.sources.get(nodeId); if (!source) throw new Error('missing'); return { ...source }; },
  DEFAULT_VIDEO_EDITOR_OUTPUT: { width: 1920, height: 1080, frameRate: 30 },
}));
vi.mock('../../src/services/videoEditorMediaService', () => ({ createVideoInput: mocks.createInput,
  probeVideoSource: mocks.probe, extractFramesAtTimestamps: mocks.frames }));
vi.mock('../../src/services/videoCompositor', () => ({ createClipRenderSource: mocks.render }));
vi.mock('../../src/services/rasterImageDimensions', () => ({ readRasterImageDimensions: mocks.dimensions }));
import { inspectControlledNode, probeControlledNode, validateInspectionTimes } from '../../src/services/videoEditorInspectionService';
import { prepareControlledRenderSources } from '../../src/services/videoEditorRenderSources';
import { createBudgetedRenderBitmap } from '../../src/services/videoEditorRenderBitmap';

const context = () => ({ projectId: 'p', signal: new AbortController().signal });
const record = (): VideoEditorProjectRecord => ({ id: 'e', schemaVersion: 1, projectId: 'p', nodeId: 'v', name: 'test', createdAt: 1, updatedAt: 1,
  tracks: [{ id: 'main', kind: 'video', name: '主轨', clips: [{ id: 'clip', kind: 'video', nodeId: 'v', fileName: 'v',
    filePath: 'v.mp4', timelineStart: 0, sourceIn: 0, sourceOut: 4 }] }] });
beforeEach(() => {
  mocks.sources.clear(); mocks.sources.set('v', { nodeId: 'v', filePath: 'v.mp4', fileName: 'v' });
  mocks.sources.set('i', { nodeId: 'i', filePath: 'i.png', fileName: 'i' }); mocks.nodes = [{ id: 'v', type: 'source-video' }];
  mocks.createInput.mockReset().mockResolvedValue(mocks.input); mocks.input.dispose.mockClear(); mocks.bitmap.close.mockClear();
  mocks.probe.mockReset().mockResolvedValue({ duration: 5, width: 1920, height: 1080, decodable: true, videoCodec: 'avc', audioCodec: null });
  mocks.render.mockReset().mockResolvedValue({ width: 1920, height: 1080, sink: {} });
  mocks.frames.mockReset().mockResolvedValue([]); mocks.dimensions.mockReset().mockResolvedValue({ width: 1920, height: 1080 });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) })));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => mocks.bitmap));
});

describe('媒体检查与解码生命周期', () => {
  it.each([[], [-1], [5], [2, 1], [1, 1], [NaN], [0, 1, 2, 3, 4, 4.5, 4.9]])('bounds explicit frame requests: %j', (...values) => {
    expect(() => validateInspectionTimes(values as number[], 5)).toThrow();
  });
  it('returns requested and actual sample positions separately and releases each canvas and decoder', async () => {
    const canvas = { width: 960, height: 540, convertToBlob: async () => new Blob(['frame'], { type: 'image/jpeg' }) };
    mocks.frames.mockResolvedValue([{ requestedTime: 1.02, actualTime: 1, duration: 1 / 30, width: 960, height: 540, canvas }]);
    const result = await inspectControlledNode(context(), 'v', [1.02]);
    expect(result.metadata.samples[0]).toMatchObject({ requestedTime: 1.02, actualTime: 1 });
    expect(result.images[0]).toMatchObject({ type: 'image', data: 'frame' });
    expect(canvas.width).toBe(1); expect(mocks.input.dispose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.metadata)).not.toContain('v.mp4');
  });
  it('disposes inputs when probing fails or a requested sample is missing', async () => {
    mocks.probe.mockRejectedValueOnce(new Error('decode'));
    await expect(probeControlledNode(context(), 'v')).rejects.toThrow('decode');
    mocks.frames.mockResolvedValueOnce([null]);
    await expect(inspectControlledNode(context(), 'v', [1])).rejects.toThrow('没有可解码');
    expect(mocks.input.dispose).toHaveBeenCalledTimes(2);
  });
  it('rejects post-decode source changes and cancellation without returning stale frames', async () => {
    mocks.probe.mockImplementationOnce(async () => { mocks.sources.get('v')!.filePath = 'changed.mp4'; return { duration: 5 }; });
    await expect(probeControlledNode(context(), 'v')).rejects.toThrow('素材已变化');
    const controller = new AbortController(); controller.abort();
    await expect(probeControlledNode({ ...context(), signal: controller.signal }, 'v')).rejects.toThrow('cancelled');
    expect(mocks.input.dispose).toHaveBeenCalledTimes(1);
  });
  it('refuses trims beyond real source duration and frees partially prepared inputs', async () => {
    const value = record(); value.tracks[0].clips[0].sourceOut = 6;
    await expect(prepareControlledRenderSources(value, () => undefined)).rejects.toThrow('真实时长');
    expect(mocks.input.dispose).toHaveBeenCalledTimes(1);
  });
  it('reuses one source across clips and detects media replacement even without a canvas revision change', async () => {
    const value = record(); value.tracks[0].clips.push({ ...value.tracks[0].clips[0], id: 'clip2' });
    const sources = await prepareControlledRenderSources(value, () => undefined);
    expect(mocks.createInput).toHaveBeenCalledTimes(1);
    mocks.sources.get('v')!.filePath = 'changed.mp4';
    expect(() => sources.assertFresh()).toThrow('素材已变化'); sources.dispose();
    expect(mocks.input.dispose).toHaveBeenCalledTimes(1);
  });
  it('closes an allocated image when later material preparation fails', async () => {
    const value = record(); value.tracks[0].clips.unshift({ id: 'image', kind: 'image', nodeId: 'i', fileName: 'i',
      filePath: 'i.png', timelineStart: 0, sourceIn: 0, sourceOut: 2 });
    mocks.createInput.mockRejectedValueOnce(new Error('read'));
    await expect(prepareControlledRenderSources(value, () => undefined)).rejects.toThrow('read');
    expect(mocks.bitmap.close).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized images before creating a bitmap', async () => {
    mocks.dimensions.mockResolvedValueOnce({ width: 30000, height: 30000 });
    await expect(createBudgetedRenderBitmap('asset://image', 0, { width: 1920, height: 1080 })).rejects.toThrow('256 MiB');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
