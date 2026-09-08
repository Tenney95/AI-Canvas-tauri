import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), persist: vi.fn() }));
vi.mock('../../src/services/ai/generateImage', () => ({ generateImage: mocks.generate }));
vi.mock('../../src/components/nodes/shared/defaultModels', () => ({
  findMediaModelOption: (value: string) => value === 'image/model' ? { value, provider: 'image', mediaKind: 'image' } : undefined,
}));
vi.mock('../../src/services/fileService', () => ({
  persistMediaUrlToProjectData: mocks.persist,
  waitForPendingNodeFileDeletions: vi.fn(async () => undefined),
}));
import { useAppStore } from '../../src/store/useAppStore';
import { generateShotlistFrames } from '../../src/services/shotlistFrameService';
import { cancelProjectCanvasDerivations } from '../../src/services/canvasDerivationGuard';
import type { ShotRow } from '../../src/types/shotlist';

const initialRows: ShotRow[] = [
  { id: 'bound', shotNo: '1', content: '已有画面', frame: { nodeId: 'old', kind: 'image', url: 'old-image' } },
  { id: 'r1', shotNo: '2', content: '@drama{hero:林夏} 站在月台', frame: null },
  { id: 'r2', shotNo: '3', content: '列车到站', frame: null },
];
const input = { projectId: 'ep', nodeId: 'sheet', rowIds: ['bound', 'r1', 'r2'], modelRef: 'image/model' };
const rows = () => useAppStore.getState().nodes.find((node) => node.id === 'sheet')?.data.shotlistRows ?? [];

beforeEach(() => {
  cancelProjectCanvasDerivations('ep');
  mocks.generate.mockReset().mockResolvedValue({ url: 'generated', width: 100, height: 100 });
  mocks.persist.mockReset().mockResolvedValue({ mediaUrl: 'local-image', sourceUrl: 'generated', filePath: 'private-media-path' });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'ep', projectLoadStatus: 'ready', recordOutputHistory: vi.fn(), showToast: vi.fn(),
    projects: [{ id: 'ep', name: '第1集', createdAt: 1, updatedAt: 1,
      settings: { generation: { imageAspectRatio: '9:16', imageSize: '1K' } } }],
    nodes: [{ id: 'sheet', type: 'ai-shotlist', position: { x: 500, y: 0 }, data: {
      type: 'ai-shotlist', label: '分镜', shotlistRows: structuredClone(initialRows),
    } }],
  });
});

describe('补空镜', () => {
  it('跳过已绑画面，按项目参数生成并批量创建真实节点，一次历史且不自动重试', async () => {
    const commit = vi.fn(useAppStore.getState().commitToHistory);
    useAppStore.setState({ commitToHistory: commit });
    const result = await generateShotlistFrames(input);
    expect(result.map((item) => item.status)).toEqual(['skipped', 'success', 'success']);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({ imageSize: '1K', aspectRatio: '9:16' });
    expect(mocks.generate.mock.calls[0][0].prompt).toContain('@drama{hero:林夏}');
    expect(rows()[0]).toEqual(initialRows[0]);
    expect(rows().slice(1).every((row) => row.frame?.nodeId)).toBe(true);
    expect(useAppStore.getState().nodes).toHaveLength(3);
    expect(commit).toHaveBeenCalledTimes(1);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toHaveLength(1);
    expect(rows()).toEqual(initialRows);
  });

  it('一镜失败继续下一镜，失败不自动重试且不绑定', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('provider failure'));
    const result = await generateShotlistFrames({ ...input, rowIds: ['r1', 'r2'] });
    expect(result.map((item) => item.status)).toEqual(['error', 'success']);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(rows()[1].frame).toBeNull();
    expect(rows()[2].frame?.nodeId).toBe(result[1].nodeId);
  });

  it('取消后保留成功镜头，不提交剩余请求', async () => {
    const controller = new AbortController();
    const result = await generateShotlistFrames({ ...input, rowIds: ['r1', 'r2'], signal: controller.signal,
      onProgress: (completed) => { if (completed === 1) controller.abort(); },
    });
    expect(result.map((item) => item.status)).toEqual(['success', 'cancelled']);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(rows()[1].frame).not.toBeNull();
    expect(rows()[2].frame).toBeNull();
  });

  it('同表重复启动被拒绝，不重复创建或计费', async () => {
    let resolve!: (value: { url: string }) => void;
    mocks.generate.mockReturnValueOnce(new Promise<{ url: string }>((done) => { resolve = done; }));
    const pending = generateShotlistFrames({ ...input, rowIds: ['r1'] });
    await expect(generateShotlistFrames({ ...input, rowIds: ['r1'] })).rejects.toThrow('正在补图');
    expect(useAppStore.getState().nodes).toHaveLength(2);
    resolve({ url: 'image' });
    await pending;
  });

  it('生成期间镜头改变，保留生成图片但不覆盖该镜头', async () => {
    let resolve!: (value: { url: string }) => void;
    mocks.generate.mockReturnValueOnce(new Promise<{ url: string }>((done) => { resolve = done; }));
    const pending = generateShotlistFrames({ ...input, rowIds: ['r1'] });
    useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: rows().map((row) => row.id === 'r1' ? { ...row, content: '新剧情' } : row) });
    resolve({ url: 'image' });
    const result = await pending;
    expect(result[0].status).toBe('stale');
    expect(rows()[1]).toMatchObject({ content: '新剧情', frame: null });
    expect(useAppStore.getState().nodes[1].data.imageUrl).toBe('local-image');
  });

  it('切走再返回同项目仍拒绝旧结果，不持久化或绑定', async () => {
    let resolve!: (value: { url: string }) => void;
    mocks.generate.mockReturnValueOnce(new Promise<{ url: string }>((done) => { resolve = done; }));
    const pending = generateShotlistFrames({ ...input, rowIds: ['r1'] });
    cancelProjectCanvasDerivations('ep');
    useAppStore.setState({ currentProjectId: 'other' });
    useAppStore.setState({ currentProjectId: 'ep' });
    resolve({ url: 'image' });
    const result = await pending;
    expect(result[0].status).toBe('cancelled');
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(rows()[1].frame).toBeNull();
  });

  it('保存图片期间 revision 改变，不写回旧结果', async () => {
    let persisted!: (value: { mediaUrl: string }) => void;
    mocks.persist.mockImplementationOnce(() => new Promise<{ mediaUrl: string }>((done) => { persisted = done; }));
    const pending = generateShotlistFrames({ ...input, rowIds: ['r1'] });
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalled());
    useAppStore.getState().incrementRevision();
    persisted({ mediaUrl: 'old-result' });
    const result = await pending;
    expect(result[0].status).toBe('stale');
    expect(rows()[1].frame).toBeNull();
    expect(useAppStore.getState().nodes[1].data.imageUrl).toBeUndefined();
    expect(useAppStore.getState().nodes[1].data.status).toBe('idle');
  });

  it('保留单镜主动换画面能力，失败时原图保持绑定', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('failed'));
    await generateShotlistFrames({ ...input, rowIds: ['bound'], replaceExisting: true });
    expect(rows()[0].frame).toEqual(initialRows[0].frame);
    const result = await generateShotlistFrames({ ...input, rowIds: ['bound'], replaceExisting: true });
    expect(rows()[0].frame?.nodeId).toBe(result[0].nodeId);
  });

  it('供应商不响应取消时立即结束本批，续做成功后旧响应不能覆盖', async () => {
    let resolve!: (value: { url: string }) => void;
    mocks.generate.mockReturnValueOnce(new Promise<{ url: string }>((done) => { resolve = done; }));
    const controller = new AbortController();
    let finished = false;
    const pending = generateShotlistFrames({ ...input, rowIds: ['r1'], signal: controller.signal }).then((value) => {
      finished = true;
      return value;
    });
    controller.abort();
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 150 });
      expect((await pending)[0].status).toBe('cancelled');
      const resumed = await generateShotlistFrames({ ...input, rowIds: ['r1'] });
      expect(resumed[0].status).toBe('success');
      resolve({ url: 'late-image' });
      await Promise.resolve();
      expect(rows()[1].frame?.nodeId).toBe(resumed[0].nodeId);
      expect(mocks.persist).toHaveBeenCalledTimes(1);
    } finally { resolve({ url: 'late-image' }); await pending; }
  });

  it('排队节点的模型被修改后跳过该镜，不用批次旧模型替用户生成', async () => {
    let resolve!: (value: { url: string }) => void;
    mocks.generate.mockReturnValueOnce(new Promise<{ url: string }>((done) => { resolve = done; }));
    const pending = generateShotlistFrames({ ...input, rowIds: ['r1', 'r2'] });
    const queued = useAppStore.getState().nodes[2];
    useAppStore.getState().updateNodeDataTransient(queued.id, { model: 'user-selected-model' });
    resolve({ url: 'first-image' });
    const result = await pending;
    expect(result.map((item) => item.status)).toEqual(['success', 'stale']);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(rows()[2].frame).toBeNull();
  });

  it.each([{ aspectRatio: '1:1' }, { imageSize: '4K' }, { workflowInputs: { seed: '42' } }])('生成参数被修改后不回填旧画面: %j', async (patch) => {
    let resolve!: (value: { url: string }) => void;
    mocks.generate.mockReturnValueOnce(new Promise<{ url: string }>((done) => { resolve = done; }));
    const pending = generateShotlistFrames({ ...input, rowIds: ['r1'] });
    useAppStore.getState().updateNodeDataTransient(useAppStore.getState().nodes[1].id, patch);
    resolve({ url: 'old-image' });
    expect((await pending)[0].status).toBe('stale');
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(rows()[1].frame).toBeNull();
    expect(useAppStore.getState().nodes[1].data.status).toBe('idle');
  });

  it('图片保存未结束时取消也释放批次，迟到保存不回填', async () => {
    let resolve!: (value: { mediaUrl: string }) => void;
    mocks.persist.mockReturnValueOnce(new Promise<{ mediaUrl: string }>((done) => { resolve = done; }));
    const controller = new AbortController();
    const pending = generateShotlistFrames({ ...input, rowIds: ['r1'], signal: controller.signal });
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    controller.abort();
    expect((await pending)[0].status).toBe('cancelled');
    expect(useAppStore.getState().nodes[1].data.status).toBe('idle');
    const resumed = await generateShotlistFrames({ ...input, rowIds: ['r1'] });
    resolve({ mediaUrl: 'late-file' });
    await Promise.resolve();
    expect(rows()[1].frame?.nodeId).toBe(resumed[0].nodeId);
    expect(rows()[1].frame?.url).toBe('local-image');
  });

  it('无效模型、重复 ID、超量、跨项目均在创建节点前拒绝', async () => {
    await expect(generateShotlistFrames({ ...input, modelRef: 'bad' })).rejects.toThrow();
    await expect(generateShotlistFrames({ ...input, rowIds: ['r1', 'r1'] })).rejects.toThrow();
    await expect(generateShotlistFrames({ ...input, rowIds: Array.from({ length: 13 }, (_, i) => `r${i}`) })).rejects.toThrow();
    await expect(generateShotlistFrames({ ...input, projectId: 'wrong' })).rejects.toThrow();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });
});
