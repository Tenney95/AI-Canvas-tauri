import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoEditorProjectRecord } from '../../src/types/videoEditor';
const mocks = vi.hoisted(() => ({
  store: { currentProjectId: 'p', nodes: [{ id: 'anchor', position: { x: 10, y: 20 } }], getCurrentRevision: (): number => 1,
    addNodesWithEdges: vi.fn(), incrementRevision: vi.fn() },
  record: {} as VideoEditorProjectRecord,
  version: 'a'.repeat(64),
  prepare: vi.fn(), encode: vi.fn(), save: vi.fn(), inputDispose: vi.fn(), sourceDispose: vi.fn(),
  windows: vi.fn(async (): Promise<void> => undefined),
  audioTrack: vi.fn(), audioCanDecode: vi.fn(), audioBuffers: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.store } }));
vi.mock('../../src/services/videoEditorControlService', () => ({
  DEFAULT_VIDEO_EDITOR_OUTPUT: { width: 1920, height: 1080, frameRate: 30 },
  assertEditorWindowClosed: mocks.windows, bindVideoEditorTracks: vi.fn(), validateVideoEditorOutput: vi.fn(),
  assertVideoEditorContext: (context: { projectId: string; signal: AbortSignal }) => {
    if (context.signal.aborted || context.projectId !== mocks.store.currentProjectId) throw new Error('stale');
  },
  readControlledEditor: async () => mocks.record,
  videoEditorVersion: async () => mocks.version,
}));
vi.mock('../../src/services/videoEditorRenderSources', () => ({ prepareControlledRenderSources: mocks.prepare }));
vi.mock('../../src/services/fileService', () => ({ saveBinaryToProjectData: mocks.save }));
vi.mock('../../src/services/videoEditorMediaService', () => ({ exportComposite: mocks.encode,
  createVideoInput: async () => ({ dispose: mocks.inputDispose, getPrimaryAudioTrack: mocks.audioTrack }),
  probeVideoSource: async () => ({ decodable: true, duration: 24, width: 1920, height: 1080 }),
}));
vi.mock('mediabunny', () => ({ AudioBufferSink: class { buffers = mocks.audioBuffers; } }));
vi.mock('../../src/services/videoCompositor', () => ({ renderFrameAt: vi.fn() }));
vi.mock('../../src/services/videoEditorInspectionService', () => ({ inspectionImage: vi.fn(), validateInspectionTimes: vi.fn() }));
import { cancelControlledExport, getControlledExport, startControlledExport } from '../../src/services/videoEditorExportService';
import { cancelProjectCanvasDerivations } from '../../src/services/canvasDerivationGuard';

let sequence = 0;
const context = () => ({ projectId: 'p', signal: new AbortController().signal });
const request = () => ({ editorId: 'editor', expectedVersion: 'a'.repeat(64), requestKey: `request-${++sequence}` });
const completed = async (jobId: string) => {
  await vi.waitFor(() => expect(getControlledExport(context(), jobId).finishedAt).toBeTypeOf('number'));
  return getControlledExport(context(), jobId);
};
beforeEach(() => {
  mocks.store.currentProjectId = 'p'; mocks.store.getCurrentRevision = () => 1;
  mocks.version = 'a'.repeat(64);
  mocks.record = { id: 'editor', projectId: 'p', nodeId: 'anchor', schemaVersion: 1, name: '宣传片', createdAt: 1, updatedAt: 1,
    tracks: [{ id: 'main', kind: 'video', name: '主轨', clips: [{ id: 'c', kind: 'image', fileName: 'image',
      nodeId: 'anchor', sourceIn: 0, sourceOut: 24, timelineStart: 0 }] }] };
  mocks.store.addNodesWithEdges.mockClear(); mocks.store.incrementRevision.mockClear();
  mocks.sourceDispose.mockClear(); mocks.inputDispose.mockClear(); mocks.windows.mockReset().mockResolvedValue(undefined);
  mocks.prepare.mockReset().mockResolvedValue({ assertFresh: vi.fn(), dispose: mocks.sourceDispose, resolveVideo: () => undefined, resolveAudio: () => undefined });
  mocks.encode.mockReset().mockImplementation(async (options) => {
    options.onAudioMode('none'); options.onProgress(1); return new Uint8Array([1, 2, 3]);
  });
  mocks.save.mockReset().mockResolvedValue({ filePath: 'G:/private/output.mp4', assetUrl: 'asset://private/output' });
  mocks.audioTrack.mockReset().mockResolvedValue(null); mocks.audioCanDecode.mockReset().mockResolvedValue(true);
  mocks.audioBuffers.mockReset().mockImplementation(async function* () { yield { buffer: { length: 48_000, numberOfChannels: 2 } }; });
});

describe('MCP 后台合成', () => {
  it('validates and saves one output, atomically adds one node and returns no media locations', async () => {
    const job = await startControlledExport(context(), request());
    const result = await completed(job.jobId);
    expect(result).toMatchObject({ status: 'succeeded', duration: 24, width: 1920, height: 1080, frameRate: 30, progress: 1 });
    expect(mocks.save).toHaveBeenCalledTimes(1); expect(mocks.store.addNodesWithEdges).toHaveBeenCalledTimes(1);
    expect(mocks.store.incrementRevision).toHaveBeenCalledTimes(1);
    expect(mocks.inputDispose).toHaveBeenCalledTimes(1); expect(mocks.sourceDispose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/private|asset:|filePath/);
  });
  it('deduplicates repeated request keys before and after completion, and rejects changed versions under a used key', async () => {
    const input = request(); const first = await startControlledExport(context(), input);
    const again = await startControlledExport(context(), input); expect(again.jobId).toBe(first.jobId);
    await completed(first.jobId);
    expect((await startControlledExport(context(), input)).jobId).toBe(first.jobId);
    expect(mocks.encode).toHaveBeenCalledTimes(1);
    await expect(startControlledExport(context(), { ...input, expectedVersion: 'b'.repeat(64) })).rejects.toThrow('requestKey');
  });
  it('serializes concurrent submissions before asynchronous preflight', async () => {
    let release!: () => void;
    mocks.windows.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = startControlledExport(context(), request());
    await expect(startControlledExport(context(), request())).rejects.toThrow('正在运行');
    release(); await completed((await first).jobId);
  });
  it('supports explicit cancellation and does not publish an encoded result afterward', async () => {
    let finish!: () => void;
    mocks.encode.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => { finish = () => resolve(new Uint8Array([1])); }));
    const job = await startControlledExport(context(), request());
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    cancelControlledExport(context(), job.jobId); finish();
    expect((await completed(job.jobId)).status).toBe('cancelled');
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.sourceDispose).toHaveBeenCalledTimes(1);
  });
  it('cancels project derivations and keeps foreign-project polling isolated', async () => {
    let finish!: () => void;
    mocks.encode.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => { finish = () => resolve(new Uint8Array([1])); }));
    const job = await startControlledExport(context(), request());
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    mocks.store.currentProjectId = 'other'; cancelProjectCanvasDerivations('p');
    expect(() => getControlledExport({ ...context(), projectId: 'other' }, job.jobId)).toThrow('当前项目');
    finish(); mocks.store.currentProjectId = 'p';
    expect((await completed(job.jobId)).status).toBe('cancelled'); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('refuses publishing when the canvas or editor changes during encoding', async () => {
    mocks.encode.mockImplementationOnce(async () => { mocks.store.getCurrentRevision = () => 2; return new Uint8Array([1]); });
    const first = await startControlledExport(context(), request());
    expect((await completed(first.jobId)).status).toBe('failed'); expect(mocks.save).not.toHaveBeenCalled();
    mocks.store.getCurrentRevision = () => 1;
    mocks.encode.mockImplementationOnce(async () => { mocks.version = 'b'.repeat(64); return new Uint8Array([1]); });
    const second = await startControlledExport(context(), request());
    expect((await completed(second.jobId)).status).toBe('failed'); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('handles a switch while saving without attaching to the wrong canvas, and describes a retained file honestly', async () => {
    mocks.save.mockImplementationOnce(async () => {
      mocks.store.getCurrentRevision = () => 2;
      return { filePath: 'G:/private/output.mp4', assetUrl: 'asset://private/output' };
    });
    const job = await startControlledExport(context(), request());
    const result = await completed(job.jobId);
    expect(result.status).toBe('failed'); expect(result.error).toContain('文件已保存');
    expect(mocks.store.addNodesWithEdges).not.toHaveBeenCalled();
  });
  it('reports native failures without leaking the exception or retrying writes', async () => {
    mocks.save.mockRejectedValueOnce(new Error('G:/private/secrets/token: auth confidential'));
    const job = await startControlledExport(context(), request()); const result = await completed(job.jobId);
    expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toMatch(/secrets|confidential/);
    expect(mocks.save).toHaveBeenCalledTimes(1); expect(mocks.sourceDispose).toHaveBeenCalledTimes(1);
  });
  it('verifies a required original audio track is present and actually decodable before saving', async () => {
    mocks.record.tracks.push({ id: 'original-sound', kind: 'audio', name: '原声', clips: [
      { id: 'audio', kind: 'video', fileName: 'original', nodeId: 'anchor', sourceIn: 0, sourceOut: 24, timelineStart: 0 },
    ] });
    const missing = await startControlledExport(context(), request());
    expect((await completed(missing.jobId)).error).toContain('音轨缺失'); expect(mocks.save).not.toHaveBeenCalled();
    mocks.audioTrack.mockResolvedValue({ canDecode: mocks.audioCanDecode });
    mocks.audioCanDecode.mockResolvedValue(false);
    const undecodable = await startControlledExport(context(), request());
    expect((await completed(undecodable.jobId)).status).toBe('failed'); expect(mocks.save).not.toHaveBeenCalled();
    mocks.audioCanDecode.mockResolvedValue(true);
    mocks.audioBuffers.mockImplementationOnce(async function* () { /* No decoded samples. */ });
    const empty = await startControlledExport(context(), request());
    expect((await completed(empty.jobId)).error).toContain('没有可解码音频'); expect(mocks.save).not.toHaveBeenCalled();
    const valid = await startControlledExport(context(), request());
    expect((await completed(valid.jobId)).status).toBe('succeeded'); expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.audioBuffers).toHaveBeenLastCalledWith(0, 1);
  });
  it('allows intentional silent exports when all audio tracks are muted', async () => {
    mocks.record.tracks.push({ id: 'muted-sound', kind: 'audio', name: '静音', muted: true, clips: [
      { id: 'audio', kind: 'video', fileName: 'original', nodeId: 'anchor', sourceIn: 0, sourceOut: 24, timelineStart: 0 },
    ] });
    const result = await completed((await startControlledExport(context(), request())).jobId);
    expect(result.status).toBe('succeeded'); expect(mocks.audioTrack).not.toHaveBeenCalled();
  });
  it('binds an optional caller lease to export cancellation without changing ordinary exports', async () => {
    let finish!: () => void;
    mocks.encode.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => { finish = () => resolve(new Uint8Array([1])); }));
    const controller = new AbortController();
    const job = await startControlledExport(context(), request(), { signal: controller.signal, assertFresh: () => undefined });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort(); finish();
    expect((await completed(job.jobId)).status).toBe('cancelled'); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('refuses publishing if the caller identity changes after save', async () => {
    let live = true;
    mocks.save.mockImplementationOnce(async () => { live = false; return { filePath: 'G:/private/retained.mp4', assetUrl: 'asset://retained' }; });
    const job = await startControlledExport(context(), request(), { assertFresh: () => { if (!live) throw new Error('stale private identity'); } });
    const result = await completed(job.jobId);
    expect(result.status).toBe('failed'); expect(result.error).toContain('文件已保存'); expect(mocks.store.addNodesWithEdges).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private identity');
  });
});
