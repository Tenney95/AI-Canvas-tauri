/**
 * videoBatchGeneration — 回归测试：uses each node duration and waits for output history before completing。
 */
import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), persist: vi.fn() }));
vi.mock('../../src/services/aiService', () => ({ generateVideo: mocks.generate }));
vi.mock('../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../src/services/fileService')>(), persistMediaUrlToProjectData: mocks.persist,
}));
import { useAppStore } from '../../src/store/useAppStore';
import { executeGeneration } from '../../src/services/generationService';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p', projectLoadStatus: 'ready',
    projects: [{ id: 'p', name: '项目', createdAt: 1, updatedAt: 1 }, { id: 'other', name: '另一项目', createdAt: 1, updatedAt: 1 }],
    showToast: vi.fn(), recordOutputHistory: vi.fn(async () => {}),
    nodes: [{ id: 'v', type: 'ai-video', position: { x: 0, y: 0 }, data: {
      type: 'ai-video', label: 'SH001', prompt: '动作', model: 'general/test', provider: 'general', seedanceDuration: 9,
    } }] });
  mocks.generate.mockReset().mockResolvedValue({ url: 'new.mp4' });
  mocks.persist.mockReset().mockResolvedValue({ mediaUrl: 'saved.mp4', sourceUrl: 'saved.mp4' });
});
it('uses each node duration and waits for output history before completing', async () => {
  let finish!: () => void;
  const history = vi.fn(async () => { await new Promise<void>((r) => { finish = r; }); });
  useAppStore.setState({ recordOutputHistory: history });
  let done = false;
  const task = executeGeneration('v').then((r) => { done = true; return r; });
  await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(1));
  expect(done).toBe(false);
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ seedanceDuration: 9 }));
  finish(); expect((await task).success).toBe(true);
  expect(useAppStore.getState().nodes[0].data.videoBatchFingerprint).toBeTruthy();
});
it('forwards the captured H3 settings proof and node override without adding them to ordinary node output data', async () => {
  useAppStore.getState().updateNodeDataTransient('v', { comfyH3MemoryPreset: 'safe12' });
  const result = await executeGeneration('v', undefined, undefined, undefined, undefined, { comfyH3ExpectedSettings: 'checked-h3-proof' });
  expect(result.success).toBe(true);
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
    comfyH3MemoryPreset: 'safe12', comfyH3ExpectedSettings: 'checked-h3-proof',
  }));
  expect(useAppStore.getState().nodes[0].data).not.toHaveProperty('comfyH3ExpectedSettings');
});
it('does not overwrite another project if it switches during persistence', async () => {
  mocks.persist.mockImplementation(async () => {
    useAppStore.setState({ currentProjectId: 'other', nodes: [{ id: 'v', position: { x: 0, y: 0 }, data: { type: 'ai-video', label: '他集', videoUrl: 'keep.mp4' } }] });
    return { mediaUrl: 'wrong.mp4', sourceUrl: 'wrong.mp4' };
  });
  expect((await executeGeneration('v')).success).toBe(false);
  expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('keep.mp4');
});
it('preserves imported old video before generation and stops if its history cannot persist', async () => {
  useAppStore.getState().updateNodeDataTransient('v', { videoUrl: 'old.mp4' });
  const history = vi.fn(async (): Promise<void> => { throw new Error('history storage failed'); });
  // Error reporting is the second, optional history call.
  history.mockRejectedValueOnce(new Error('history storage failed')).mockResolvedValue(undefined);
  useAppStore.setState({ recordOutputHistory: history });
  expect((await executeGeneration('v')).success).toBe(false);
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('old.mp4');
  expect(history.mock.calls[0]).toEqual(['v', expect.objectContaining({ mediaUrl: 'old.mp4' }), true]);
});

it('expands the selected shot with camera, dialogue and the actual video duration before submission', async () => {
  const state = useAppStore.getState();
  useAppStore.setState({ nodes: [...state.nodes, { id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: {
    type: 'ai-shotlist', label: '分镜', shotlistRows: [
      { id: 'r1', shotNo: '1', shotSize: '特写', camera: '缓慢推近', content: '她合上书', dialogue: '小绘：等一下。', duration: 4 },
      { id: 'r2', shotNo: '2', content: '无关镜头' },
    ],
  } }] });
  state.updateNodeDataTransient('v', { prompt: '@{sheet/shot/r1:镜1}\n补充：暖光', seedanceDuration: 12 });
  expect((await executeGeneration('v')).success).toBe(true);
  const params = mocks.generate.mock.calls[0][0];
  expect(params.seedanceDuration).toBe(12);
  for (const value of ['景别：特写', '运镜：缓慢推近', '小绘：等一下。', '镜头时长：12秒', '补充：暖光']) expect(params.prompt).toContain(value);
  expect(params.prompt).not.toMatch(/无关镜头|\/shot\//);
});

it('checks the actual override shot again before submitting and does not leave an edited shot loading', async () => {
  useAppStore.setState({ nodes: [...useAppStore.getState().nodes, { id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: {
    type: 'ai-shotlist', label: '分镜', shotlistRows: [{ id: 'r', shotNo: '1', content: '本次提交画面' }],
  } }] });
  mocks.generate.mockImplementation(async (params, _signal, beforeSubmit) => {
    expect(params.prompt).toContain('本次提交画面');
    useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [{ id: 'r', shotNo: '1', content: '上传期间已修改' }] });
    useAppStore.getState().incrementRevision();
    await beforeSubmit();
    return { url: 'must-not-be-used.mp4' };
  });
  expect((await executeGeneration('v', '@{sheet/shot/r:镜1}')).success).toBe(false);
  expect(mocks.persist).not.toHaveBeenCalled();
  const video = useAppStore.getState().nodes.find((node) => node.id === 'v')!;
  expect(video.data.status).toBe('error');
  expect(video.data.videoUrl).toBeUndefined();
});

it('rejects a deleted shot before starting generation', async () => {
  expect((await executeGeneration('v', '@{missing/shot/r:已删除}')).success).toBe(false);
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(useAppStore.getState().nodes[0].data.status).not.toBe('loading');
});

it('guards a shot reference supplied only through workflow inputs before the paid submit', async () => {
  useAppStore.setState({ nodes: [...useAppStore.getState().nodes, { id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: {
    type: 'ai-shotlist', label: '分镜', shotlistRows: [{ id: 'r', shotNo: '1', camera: '固定机位', content: '书桌前' }],
  } }] });
  useAppStore.getState().updateNodeDataTransient('v', { workflowInputs: { prompt: '@{sheet/shot/r:镜1}' } });
  mocks.generate.mockImplementation(async (_params, _signal, beforeSubmit) => {
    useAppStore.getState().updateNodeDataTransient('sheet', {
      shotlistRows: [{ id: 'r', shotNo: '1', camera: '缓慢推近', content: '书桌前' }],
    });
    await beforeSubmit();
    return { url: 'must-not-be-used.mp4' };
  });
  expect((await executeGeneration('v')).success).toBe(false);
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(useAppStore.getState().nodes.find((node) => node.id === 'v')?.data.status).toBe('error');
});
