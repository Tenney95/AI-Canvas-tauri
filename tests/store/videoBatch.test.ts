/**
 * videoBatch — 回归测试：requires H3 service preflight and rejects a changed inherited policy before persisting a batch。
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { VideoBatch } from '../../src/types/videoBatch';
import type { ComfyH3MemorySettings } from '../../src/types/comfyLaunch';
import { comfyH3MemoryFingerprint, DEFAULT_COMFY_H3_MEMORY_SETTINGS } from '../../src/types/comfyLaunch';

const mocks = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<VideoBatch[]> => []), write: vi.fn(async () => {}),
  execute: vi.fn(async () => ({ success: true })),
  resolveH3: vi.fn(async (): Promise<ComfyH3MemorySettings | undefined> => undefined),
  probe: vi.fn(async () => true),
}));
vi.mock('../../src/services/videoBatchRepository', () => ({ readVideoBatches: mocks.read, writeVideoBatches: mocks.write }));
vi.mock('../../src/services/generationService', () => ({ executeGeneration: mocks.execute }));
vi.mock('../../src/services/comfyH3Memory', async (original) => ({
  ...await original<typeof import('../../src/services/comfyH3Memory')>(), resolveComfyH3MemorySettings: mocks.resolveH3,
}));
vi.mock('../../src/services/comfyServers', async (original) => ({
  ...await original<typeof import('../../src/services/comfyServers')>(), probeComfyServer: mocks.probe,
}));
import { useAppStore } from '../../src/store/useAppStore';
import { checkVideoServices, inspectVideoNode } from '../../src/services/videoBatchPlanning';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project', showToast: vi.fn(), nodes: [1, 2].map((n) => ({
    id: `v${n}`, type: 'ai-video', position: { x: 0, y: 0 },
    data: { type: 'ai-video', label: `SH${n}`, model: 'general/test', provider: 'general', prompt: '动作', seedanceDuration: n * 3 },
  })) });
  mocks.read.mockReset().mockResolvedValue([]); mocks.write.mockReset().mockResolvedValue(); mocks.execute.mockReset().mockResolvedValue({ success: true });
  mocks.resolveH3.mockReset().mockResolvedValue(undefined); mocks.probe.mockReset().mockResolvedValue(true);
});
const inspect = () => useAppStore.getState().nodes.map((n) => inspectVideoNode(n, useAppStore.getState()));

function configureH3Batch() {
  const state = useAppStore.getState();
  useAppStore.setState({
    config: { ...state.config, comfyUIUrl: 'http://127.0.0.1:8188' },
    workflows: [{ id: 'h3', name: 'H3', category: 'ai-video', fileName: 'h3.json', createdAt: 1,
      fileContent: JSON.stringify({ '1': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {} } }) }],
    nodes: state.nodes.map((node) => ({ ...node, data: { ...node.data, provider: 'comfyui', workflowId: 'h3', comfyH3MemoryPreset: 'inherit' as const } })),
  });
}

it('requires H3 service preflight and rejects a changed inherited policy before persisting a batch', async () => {
  configureH3Batch();
  await expect(useAppStore.getState().startVideoBatch('project', inspect())).rejects.toThrow('尚未检查');
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(useAppStore.getState().videoBatches.project ?? []).toEqual([]);
  const state = useAppStore.getState();
  const checked = await checkVideoServices(inspect(), state);
  mocks.resolveH3.mockResolvedValue({ ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'safe12' });
  await expect(state.startVideoBatch('project', checked)).rejects.toThrow('H3 显存设置或服务已变化');
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(useAppStore.getState().videoBatches.project ?? []).toEqual([]);
});

it('persists only the checked H3 digest and forwards the same proof to every queued execution', async () => {
  configureH3Batch();
  const settings = { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'custom' as const, referenceImageMaxSize: 768 };
  mocks.resolveH3.mockResolvedValue(settings);
  const checked = await checkVideoServices(inspect(), useAppStore.getState());
  const expected = comfyH3MemoryFingerprint(settings);
  mocks.execute.mockImplementationOnce(async () => {
    mocks.resolveH3.mockResolvedValue({ ...settings, referenceImageMaxSize: 1024 });
    return { success: true };
  });
  const result = await useAppStore.getState().startVideoBatch('project', checked);
  expect(result.items.map((item) => item.comfyH3SettingsFingerprint)).toEqual([expected, expected]);
  expect(mocks.execute).toHaveBeenNthCalledWith(1, 'v1', undefined, undefined, undefined, undefined, { comfyH3ExpectedSettings: expected });
  expect(mocks.execute).toHaveBeenNthCalledWith(2, 'v2', undefined, undefined, undefined, undefined, { comfyH3ExpectedSettings: expected });
  expect(JSON.stringify(result)).not.toMatch(/attentionHeadChunks|referenceImageMaxSize|127\.0\.0\.1/);
});

it.each(['success', 'error', 'unknown'] as const)('returns the final %s batch outcome once execution settles without resubmitting', async (status) => {
  if (status === 'error') mocks.execute.mockResolvedValueOnce({ success: false });
  if (status === 'unknown') mocks.execute.mockRejectedValueOnce(new Error('提交后连接中断'));
  const result = await useAppStore.getState().startVideoBatch('project', [inspect()[0]]);
  expect(result).toBe(useAppStore.getState().videoBatches.project[0]);
  expect(result.items[0].status).toBe(status);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(useAppStore.getState().videoBatchBusy).toBe(false);
});

it('persists independent durations and statuses, rejects a duplicate click synchronously', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  mocks.execute.mockImplementationOnce(async () => { await gate; return { success: true }; });
  const items = inspect();
  const run = useAppStore.getState().startVideoBatch('project', items);
  await expect(useAppStore.getState().startVideoBatch('project', items)).rejects.toThrow('正在执行');
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
  release(); await run;
  const batch = useAppStore.getState().videoBatches.project[0];
  expect(batch.items.map((i) => i.duration)).toEqual([3, 6]);
  expect(batch.items.every((i) => i.status === 'success')).toBe(true);
  expect(JSON.stringify(batch)).not.toContain('动作');
  expect(useAppStore.getState().videoBatchBusy).toBe(false);
});
it('forwards the optional runtime lease without persisting its signal or callback', async () => {
  const lease = { signal: new AbortController().signal, assertFresh: vi.fn(async () => {}) };
  const result = await useAppStore.getState().startVideoBatch('project', [inspect()[0]], lease);
  expect(mocks.execute).toHaveBeenCalledWith('v1', undefined, undefined, undefined, lease);
  expect(result.items[0].status).toBe('success');
  expect(mocks.write).toHaveBeenCalledWith('project', expect.any(Array));
  expect(JSON.stringify(mocks.write.mock.calls)).not.toMatch(/assertFresh|signal|AbortController/);
});

it('requires confirmation for the exact unresolved batch item before a new submission', async () => {
  const prior: VideoBatch = { id: 'prior', projectId: 'project', createdAt: 1,
    items: [{ nodeId: 'v1', label: 'SH1', fingerprint: 'old', status: 'delivery_pending' }] };
  mocks.read.mockResolvedValue([prior]);
  const state = useAppStore.getState();
  const items = [inspect()[0]];
  await expect(state.startVideoBatch('project', items)).rejects.toThrow('核对');
  expect(mocks.execute).not.toHaveBeenCalled();

  const current = useAppStore.getState().videoBatches.project[0].items[0];
  await expect(state.startVideoBatch('project', items, undefined, new Map([['v1', { ...current }]]))).rejects.toThrow('核对');
  expect(mocks.execute).not.toHaveBeenCalled();
  await state.startVideoBatch('project', items, undefined, new Map([['v1', current]]));
  expect(mocks.execute).toHaveBeenCalledOnce();
});
it('rejects an already cancelled lease before creating or submitting a batch', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(useAppStore.getState().startVideoBatch('project', [inspect()[0]], { signal: controller.signal, assertFresh: vi.fn() }))
    .rejects.toThrow('已取消');
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  expect(useAppStore.getState().videoBatches.project).toBeUndefined();
});
it('holds the busy lock while global assets load and rejects a cancelled batch before submission', async () => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => { release = resolve; });
  const loadGlobalDramaAssets = vi.fn(() => loaded);
  useAppStore.setState({ loadGlobalDramaAssets });
  useAppStore.getState().updateNodeDataTransient('v1', { prompt: '@drama{global/scene-1:客厅} 运镜' });
  const items = [inspect()[0]];
  const controller = new AbortController();
  const run = useAppStore.getState().startVideoBatch('project', items, { signal: controller.signal, assertFresh: vi.fn() });
  expect(loadGlobalDramaAssets).toHaveBeenCalledOnce();
  expect(useAppStore.getState().videoBatchBusy).toBe(true);
  await expect(useAppStore.getState().startVideoBatch('project', items)).rejects.toThrow('正在执行');
  controller.abort();
  release();
  await expect(run).rejects.toThrow('已取消');
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(useAppStore.getState().videoBatchBusy).toBe(false);
});
it('rechecks the material fingerprint after loading global asset metadata', async () => {
  useAppStore.getState().updateNodeDataTransient('v1', { prompt: '@drama{global/scene-1:客厅} 运镜' });
  const items = [inspect()[0]];
  useAppStore.setState({ loadGlobalDramaAssets: vi.fn(async () => {
    useAppStore.setState({ globalScenes: [{ id: 'scene-1', kind: 'scene', name: '客厅', key: '客厅', summary: '', visualNotes: '',
      importance: 'main', source: 'manual', confirmed: true, createdAt: 1, updatedAt: 1, imageUrl: 'data:image/png;base64,AA==' }] });
  }) });
  await expect(useAppStore.getState().startVideoBatch('project', items)).rejects.toThrow('已变化');
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(useAppStore.getState().videoBatchBusy).toBe(false);
});
it('cancel waiting never interrupts the active request or submits the next one', async () => {
  let release!: () => void;
  mocks.execute.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return { success: true }; });
  const run = useAppStore.getState().startVideoBatch('project', inspect());
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
  await useAppStore.getState().cancelWaitingVideos('project', useAppStore.getState().videoBatches.project[0].id);
  release(); await run;
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(useAppStore.getState().videoBatches.project[0].items.map((i) => i.status)).toEqual(['success', 'cancelled']);
});
it('stale preflight and non-video inputs cannot be submitted', async () => {
  const items = inspect();
  useAppStore.getState().updateNodeDataTransient('v1', { seedanceDuration: 9 });
  await expect(useAppStore.getState().startVideoBatch('project', items)).rejects.toThrow('已变化');
  useAppStore.getState().updateNodeDataTransient('v1', { type: 'ai-image' });
  await expect(useAppStore.getState().startVideoBatch('project', inspect())).rejects.toThrow('已变化');
  expect(mocks.execute).not.toHaveBeenCalled();
});
it('switching away and back still stops the remaining queue', async () => {
  let release!: () => void;
  mocks.execute.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return { success: true }; });
  const run = useAppStore.getState().startVideoBatch('project', inspect());
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
  useAppStore.setState({ currentProjectId: 'other' });
  useAppStore.setState({ currentProjectId: 'project' });
  release(); await run;
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(useAppStore.getState().videoBatches.project[0].items.map((i) => i.status)).toEqual(['unknown', 'cancelled']);
});
it('does not submit if durable batch creation fails', async () => {
  mocks.write.mockRejectedValue(new Error('quota'));
  await expect(useAppStore.getState().startVideoBatch('project', inspect())).rejects.toThrow('quota');
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(useAppStore.getState().videoBatchBusy).toBe(false);
  expect(useAppStore.getState().videoBatches.project[0].items.every((i) => i.status === 'cancelled')).toBe(true);
});
it('restores unfinished tasks for review without executing them', async () => {
  mocks.read.mockResolvedValue([{ id: 'old', projectId: 'project', createdAt: 1, items: [{ nodeId: 'v1', label: '镜头', fingerprint: 'f', status: 'running' }] }]);
  await useAppStore.getState().loadVideoBatches('project');
  expect(useAppStore.getState().videoBatches.project[0].items[0].status).toBe('unknown');
  expect(mocks.execute).not.toHaveBeenCalled();
});

it('layout is one undoable operation and retains content and edges', async () => {
  const state = useAppStore.getState();
  const nodes = [{ id: 'group', type: 'group', position: { x: 0, y: 0 }, data: { type: 'comment' as const, label: 'SH001', groupId: 'group' } },
    ...state.nodes.map((n) => ({ ...n, parentId: 'group' }))];
  useAppStore.setState({ nodes, groups: [{ id: 'group', name: 'SH001', nodeIds: ['v1', 'v2'], color: '#aaa', createdAt: 1 }], edges: [{ id: 'edge', source: 'v1', target: 'v2' }] });
  const before = useAppStore.getState();
  before.layoutEpisodeGroups();
  expect(useAppStore.getState().nodes[1].position).not.toEqual(nodes[1].position);
  expect(useAppStore.getState().edges).toBe(before.edges);
  await useAppStore.getState().undo();
  expect(useAppStore.getState().nodes.map((n) => n.position)).toEqual(nodes.map((n) => n.position));
  expect(useAppStore.getState().nodes[1].data.prompt).toBe('动作');
});
