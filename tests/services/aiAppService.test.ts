/**
 * aiAppService — 回归测试：AI 应用定义生命周期。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import type { AiAppDefinition } from '../../src/types/aiApp';
import { useAppStore } from '../../src/store/useAppStore';
import { getProjectDataDir } from '../../src/services/fileService';
import { readBoundedProjectFile, readVerifiedProjectFile, sha256Hex, writeImmutableProjectFile } from '../../src/services/fs/projectFiles';
import { validateAiAppCandidate } from '../../src/services/aiApps/aiAppRuntime';
import {
  captureAiAppResources, createAiAppNode, describeAiApp, getAiAppNode,
  loadAiAppDefinition, readAiAppImage, saveAiAppState, updateAiAppNode,
} from '../../src/services/aiApps/aiAppService';

vi.mock('../../src/services/aiApps/aiAppRuntime', () => ({ validateAiAppCandidate: vi.fn() }));
vi.mock('../../src/services/fs/projectFiles', async (original) => ({
  ...await original<typeof import('../../src/services/fs/projectFiles')>(),
  readVerifiedProjectFile: vi.fn(), writeImmutableProjectFile: vi.fn(), readBoundedProjectFile: vi.fn(),
}));
vi.mock('../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../src/services/fileService')>(),
  getProjectDataDir: vi.fn(async (projectId: string) => `/projects/${projectId}`),
}));

const context = { projectId: 'project-a' };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const files = new Map<string, Uint8Array>();

function definition(title = '素材筛选器'): AiAppDefinition {
  return {
    version: 1, title, description: '按关键词筛选素材', html: '<button>筛选</button>', css: '',
    code: 'app.registerAction("scan", () => ({ count: 1 }));',
    actions: [{ id: 'scan', title: '筛选', inputSchema: { type: 'object', additionalProperties: false } }],
  };
}

function inputNode(id = 'input'): Node<BaseNodeData> {
  return { id, type: 'source-text', position: { x: 0, y: 0 }, data: { type: 'source-text', label: '绑定素材', output: '原始文本' } };
}

async function create() {
  return createAiAppNode({ definition: definition(), inputNodeIds: ['input'], state: { keyword: '' } }, context);
}

beforeEach(() => {
  vi.resetAllMocks();
  files.clear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: context.projectId, projectLoadStatus: 'ready',
    projects: [{ id: context.projectId, name: '测试项目', createdAt: 1, updatedAt: 1 }], nodes: [inputNode()] });
  vi.mocked(validateAiAppCandidate).mockResolvedValue(undefined);
  vi.mocked(getProjectDataDir).mockImplementation(async (projectId) => `/projects/${projectId}`);
  vi.mocked(writeImmutableProjectFile).mockImplementation(async ({ projectId, reference, data }) => {
    expect(await sha256Hex(data)).toBe(reference.sha256);
    files.set(`${projectId}/${reference.relativePath}`, Uint8Array.from(data));
    return { ...reference, created: true };
  });
  vi.mocked(readVerifiedProjectFile).mockImplementation(async ({ projectId, reference }) => {
    const bytes = files.get(`${projectId}/${reference.relativePath}`);
    if (!bytes || bytes.byteLength !== reference.bytes || await sha256Hex(bytes) !== reference.sha256) throw new Error('文件校验失败');
    return Uint8Array.from(bytes);
  });
  vi.mocked(readBoundedProjectFile).mockResolvedValue(png);
});

describe('AI 应用定义生命周期', () => {
  it('创建前验证并读回不可变文件，只把引用写入节点且仅提交一次历史', async () => {
    const revision = useAppStore.getState().getCurrentRevision();
    const id = await create();
    const { app, node } = getAiAppNode(id);
    expect(app).toMatchObject({ instanceId: id, revision: 1, inputNodeIds: ['input'], savedState: { keyword: '' } });
    expect(app.definition.relativePath).toBe(`ai-apps/${app.definition.sha256}.json`);
    expect(node.type).toBe('ai-app');
    expect(node.data).not.toHaveProperty('code');
    expect(JSON.stringify(node)).not.toContain('registerAction');
    expect(writeImmutableProjectFile).toHaveBeenCalledOnce();
    expect(readVerifiedProjectFile).toHaveBeenCalledOnce();
    expect(validateAiAppCandidate).toHaveBeenCalledOnce();
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(await loadAiAppDefinition(context.projectId, app)).toEqual(definition());
    expect(describeAiApp(id)).not.toHaveProperty('definition');
  });

  it.each(['candidate', 'write', 'readback'])('创建 %s 失败时不递增画布版本', async (failure) => {
    const revision = useAppStore.getState().getCurrentRevision();
    if (failure === 'candidate') vi.mocked(validateAiAppCandidate).mockRejectedValueOnce(new Error('候选应用失败'));
    if (failure === 'write') vi.mocked(writeImmutableProjectFile).mockRejectedValueOnce(new Error('磁盘写入失败'));
    if (failure === 'readback') vi.mocked(readVerifiedProjectFile).mockRejectedValueOnce(new Error('读回校验失败'));
    await expect(create()).rejects.toThrow();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    expect(useAppStore.getState().nodes.some((node) => node.type === 'ai-app')).toBe(false);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it.each(['project', 'revision', 'epoch', 'input', 'removed'])('创建期间 %s 变化后丢弃迟到结果', async (change) => {
    vi.mocked(validateAiAppCandidate).mockImplementationOnce(async () => {
      if (change === 'project') useAppStore.setState({ currentProjectId: 'project-b' });
      if (change === 'revision') useAppStore.getState().incrementRevision();
      if (change === 'epoch') useAppStore.setState({ projects: useAppStore.getState().projects.map((project) => ({ ...project, exchangeEpoch: 1 })) });
      if (change === 'input') useAppStore.getState().updateNodeDataTransient('input', { output: '已修改' });
      if (change === 'removed') useAppStore.setState({ nodes: [] });
    });
    await expect(create()).rejects.toThrow();
    expect(useAppStore.getState().nodes.some((node) => node.type === 'ai-app')).toBe(false);
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('写盘后仍检查版本，失败的创建不会发布节点', async () => {
    const write = vi.mocked(writeImmutableProjectFile).getMockImplementation()!;
    vi.mocked(writeImmutableProjectFile).mockImplementationOnce(async (input) => {
      const result = await write(input);
      useAppStore.getState().incrementRevision();
      return result;
    });
    await expect(create()).rejects.toThrow('画布已变化');
    expect(useAppStore.getState().nodes.some((node) => node.type === 'ai-app')).toBe(false);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it.each(['candidate', 'write', 'readback'])('更新 %s 失败时保留旧定义、版本和状态', async (failure) => {
    const id = await create();
    const previous = structuredClone(getAiAppNode(id).app);
    const revision = useAppStore.getState().getCurrentRevision();
    if (failure === 'candidate') vi.mocked(validateAiAppCandidate).mockRejectedValueOnce(new Error('候选应用失败'));
    if (failure === 'write') vi.mocked(writeImmutableProjectFile).mockRejectedValueOnce(new Error('磁盘写入失败'));
    if (failure === 'readback') vi.mocked(readVerifiedProjectFile).mockRejectedValueOnce(new Error('读回校验失败'));
    await expect(updateAiAppNode(id, { definition: definition('新版筛选器') }, context)).rejects.toThrow();
    expect(getAiAppNode(id).app).toEqual(previous);
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
  });

  it('更新发布新版本、保留状态，并支持撤销与重做', async () => {
    const id = await create();
    const previous = getAiAppNode(id).app;
    const revision = useAppStore.getState().getCurrentRevision();
    await updateAiAppNode(id, { definition: definition('新版筛选器') }, context);
    const updated = getAiAppNode(id).app;
    expect(updated.revision).toBe(2);
    expect(updated.definition.sha256).not.toBe(previous.definition.sha256);
    expect(updated.savedState).toEqual(previous.savedState);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(getAiAppNode(id).app).toEqual(previous);
    expect(getAiAppNode(id).node.data.label).toBe(previous.title);
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(getAiAppNode(id).app).toEqual(updated);
    expect(getAiAppNode(id).node.data.label).toBe(updated.title);
  });

  it.each(['project', 'revision', 'input', 'app-version', 'removed'])('更新期间 %s 变化后不会覆盖新状态', async (change) => {
    const id = await create();
    const previous = structuredClone(getAiAppNode(id).app);
    vi.mocked(validateAiAppCandidate).mockImplementationOnce(async () => {
      if (change === 'project') useAppStore.setState({ currentProjectId: 'project-b' });
      if (change === 'revision') useAppStore.getState().incrementRevision();
      if (change === 'input') useAppStore.getState().updateNodeDataTransient('input', { output: '已修改' });
      if (change === 'app-version') saveAiAppState(id, { userEdit: true }, undefined, 1, context);
      if (change === 'removed') useAppStore.setState({ nodes: [inputNode()] });
    });
    await expect(updateAiAppNode(id, { definition: definition('迟到定义') }, context)).rejects.toThrow();
    const live = useAppStore.getState().nodes.find((node) => node.id === id)?.data.aiApp;
    if (live) expect(live.definition).toEqual(previous.definition);
    expect(writeImmutableProjectFile).toHaveBeenCalledOnce();
  });

  it('保存状态与结果纳入历史，并拒绝旧应用版本和错误项目', async () => {
    const id = await create();
    const revision = useAppStore.getState().getCurrentRevision();
    saveAiAppState(id, { keyword: '镜头' }, { count: 2 }, 1, context);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(getAiAppNode(id).app).toMatchObject({ revision: 2, savedState: { keyword: '镜头' }, savedResult: { count: 2 } });
    expect(() => saveAiAppState(id, {}, {}, 1, context)).toThrow('应用版本已变化');
    expect(() => saveAiAppState(id, {}, {}, 2, { projectId: 'project-b' })).toThrow('当前未加载');
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(getAiAppNode(id).app).toMatchObject({ revision: 1, savedState: { keyword: '' } });
    expect(getAiAppNode(id).app.savedResult).toBeUndefined();
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(getAiAppNode(id).app.savedResult).toEqual({ count: 2 });
  });

  it('读取定义时拒绝损坏文件和节点摘要不一致', async () => {
    const id = await create();
    const app = getAiAppNode(id).app;
    await expect(loadAiAppDefinition(context.projectId, { ...app, title: '伪造摘要' })).rejects.toThrow('摘要不匹配');
    files.set(`${context.projectId}/${app.definition.relativePath}`, new Uint8Array([1]));
    await expect(loadAiAppDefinition(context.projectId, app)).rejects.toThrow('文件校验失败');
  });
});

describe('AI 应用资源授权', () => {
  it('素材快照裁剪文本，不暴露本地路径和媒体地址', () => {
    useAppStore.getState().updateNodeDataTransient('input', { output: '界'.repeat(2001), imageUrl: '/private/image.png' });
    const { snapshots } = captureAiAppResources(['input']);
    expect(snapshots[0]).toMatchObject({ text: '界'.repeat(2000), truncated: true, hasImage: true });
    expect(JSON.stringify(snapshots)).not.toContain('/private/');
  });

  it('绑定拒绝其他项目、缺失、重复、分组和自身，删除后现有引用失效', async () => {
    await expect(createAiAppNode({ definition: definition(), inputNodeIds: ['other-project-node'] }, context)).rejects.toThrow('失效');
    await expect(createAiAppNode({ definition: definition(), inputNodeIds: ['input', 'input'] }, context)).rejects.toThrow('重复');
    useAppStore.setState((state) => ({ nodes: [...state.nodes, { ...inputNode('group'), type: 'group' }] }));
    expect(() => captureAiAppResources(['group'])).toThrow('失效');
    const id = await create();
    await expect(updateAiAppNode(id, { inputNodeIds: [id] }, context)).rejects.toThrow('失效');
    useAppStore.setState((state) => ({ nodes: state.nodes.filter((node) => node.id !== 'input') }));
    expect(() => captureAiAppResources(getAiAppNode(id).app.inputNodeIds, id)).toThrow('失效');
  });

  it('图片必须属于当前项目和绑定范围，读取明确传递 2 MiB 上限', async () => {
    useAppStore.getState().updateNodeDataTransient('input', { imageUrl: 'asset://localhost/projects/project-a/images/input.png' });
    expect(await readAiAppImage(context.projectId, ['input'], 'input')).toMatch(/^data:image\/png;base64,/);
    expect(readBoundedProjectFile).toHaveBeenCalledWith({ projectId: context.projectId, relativePath: 'images/input.png', maxBytes: 2 * 1024 * 1024 });
    await expect(readAiAppImage('project-b', ['input'], 'input')).rejects.toThrow('授权范围');
    await expect(readAiAppImage(context.projectId, [], 'input')).rejects.toThrow('授权范围');
  });

  it.each(['/projects/project-b/input.png', '/projects/project-a-other/input.png', '/etc/private.png', 'https://example.com/image.png'])(
    '外部图片路径 %s 不会进入项目读取器', async (imageUrl) => {
      useAppStore.getState().updateNodeDataTransient('input', { imageUrl });
      await expect(readAiAppImage(context.projectId, ['input'], 'input')).rejects.toThrow('当前项目');
      expect(readBoundedProjectFile).not.toHaveBeenCalled();
    },
  );

  it('读取器拒绝超额数据时向上传递失败，不产生图片结果', async () => {
    useAppStore.getState().updateNodeDataTransient('input', { imageUrl: '/projects/project-a/large.png' });
    vi.mocked(readBoundedProjectFile).mockRejectedValueOnce(new Error('项目素材超过读取上限'));
    await expect(readAiAppImage(context.projectId, ['input'], 'input')).rejects.toThrow('读取上限');
  });

  it('内嵌图片检查文件头，拒绝非图片、SVG 和超过 2 MiB 的数据', async () => {
    const valid = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
    useAppStore.getState().updateNodeDataTransient('input', { imageUrl: valid });
    expect(await readAiAppImage(context.projectId, ['input'], 'input')).toBe(valid);
    for (const imageUrl of ['data:text/plain;base64,YQ==', 'data:image/png;base64,YQ==', 'data:image/svg+xml;base64,YQ==', `data:image/png;base64,${'A'.repeat(2_796_208)}`]) {
      useAppStore.getState().updateNodeDataTransient('input', { imageUrl });
      await expect(readAiAppImage(context.projectId, ['input'], 'input')).rejects.toThrow();
    }
    expect(readBoundedProjectFile).not.toHaveBeenCalled();
  });
});
