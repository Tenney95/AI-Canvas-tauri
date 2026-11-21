/**
 * canvasTools — 回归测试：canvas agent tools。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerCanvasAgentTools } from '../../../src/services/chat/tools/canvasTools';
import { validateAgentToolInput } from '../../../src/services/chat/agentToolSchemas';
import { clearAgentToolRegistryForTests, getAgentTool, type AgentToolContext } from '../../../src/services/chat/toolRegistry';
import type { BaseNodeData } from '../../../src/types';
import { emptyDramaAssetLibrary, type DramaAsset } from '../../../src/types/dramaAssets';
import type { AssetTextSnapshot } from '../../../src/services/fileService';
import type { ArchiveAssetDigest } from '../../../src/services/projectExchangeDomain';
import { registerNodeCreationTests } from './canvasTools/nodeCreation';

const executeGeneration = vi.hoisted(() => vi.fn<typeof import('../../../src/services/generationService').executeGeneration>().mockResolvedValue({ success: true }));
const loadGlobalAssets = vi.hoisted(() => vi.fn<() => Promise<DramaAsset[]>>());
const textFiles = vi.hoisted(() => ({ desktop: false, read: vi.fn(), save: vi.fn() }));
const cloudOutputRepair = vi.hoisted(() => ({ invoke: vi.fn(), directory: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...await original<typeof import('@tauri-apps/api/core')>(), invoke: cloudOutputRepair.invoke,
}));
vi.mock('../../../src/services/generationService', () => ({ executeGeneration }));
vi.mock('../../../src/services/globalDramaAssetService', () => ({ loadGlobalDramaAssetCards: loadGlobalAssets }));
vi.mock('../../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../../src/services/fileService')>(),
  isTauriEnv: () => textFiles.desktop, readAssetTextFile: textFiles.read, saveAssetTextFile: textFiles.save,
  getProjectDataDir: cloudOutputRepair.directory,
}));

function textSnapshot(content: string): AssetTextSnapshot {
  return { content, digest: `digest:${content}`, size: content.length, modified: null, bom: false, newline: 'LF' };
}

function node(
  id: string,
  overrides: Partial<BaseNodeData> = {},
  position = { x: 100, y: 100 },
): Node<BaseNodeData> {
  return {
    id,
    type: overrides.type ?? 'ai-image',
    position,
    data: {
      label: id,
      type: overrides.type ?? 'ai-image',
      status: 'idle',
      ...overrides,
    } as BaseNodeData,
  };
}

function context(): AgentToolContext {
  return {
    taskId: 'task-1',
    projectId: 'p1',
    conversationId: 'c1',
    mode: 'autonomous',
    signal: new AbortController().signal,
  } as AgentToolContext;
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  executeGeneration.mockClear();
  loadGlobalAssets.mockReset().mockResolvedValue([]);
  textFiles.desktop = false;
  textFiles.read.mockReset().mockResolvedValue(textSnapshot('原文'));
  textFiles.save.mockReset().mockImplementation(async (_path: string, _baseline: AssetTextSnapshot, content: string) => textSnapshot(content));
  cloudOutputRepair.invoke.mockReset();
  cloudOutputRepair.directory.mockReset().mockResolvedValue(null);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'p1',
    projectLoadStatus: 'ready',
    projects: [{ id: 'p1', name: '测试项目', createdAt: 1, updatedAt: 1 }],
    nodes: [
      node('n1', { displayId: 1, prompt: '一只猫', imageUrl: 'asset://localhost/D:/data/cat.png' }),
      node('n2', { displayId: 2, type: 'source-text', output: '剧本正文' }, { x: 500, y: 220 }),
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  });
  registerCanvasAgentTools();
});

const canvasCreationFixture = { node, context, loadGlobalAssets, executeGeneration };
export type CanvasCreationFixture = typeof canvasCreationFixture;

describe('canvas agent tools', () => {
  describe('显式修复缺失的云工作流单产物缓存', () => {
    const directory = 'D:/project';
    const primaryName = '沈松月1.png';
    const assets: ArchiveAssetDigest[] = [{ path: primaryName, bytes: 12, sha256: 'a'.repeat(64) }];

    beforeEach(() => {
      textFiles.desktop = true;
      cloudOutputRepair.directory.mockResolvedValue(directory);
      cloudOutputRepair.invoke.mockResolvedValue(assets);
      useAppStore.setState({ projectLoadStatus: 'ready', edges: [], nodes: [node('repair', {
        label: '沈松月1', displayId: 173, status: 'success', prompt: '保留原提示词',
        imageUrl: `asset://localhost/${directory}/${primaryName}`, filePath: `${directory}/${primaryName}`,
        assetId: 'primary-asset', relativePath: primaryName,
        runninghubOutputs: [{ kind: 'image', filePath: `${directory}/生成图像_4.png`, url: 'https://example.test/old-output.png' }],
        workflowApiOutputs: [{ kind: 'image', filePath: `${directory}/${primaryName}`, url: 'https://example.test/current-output.png' }],
      })] });
    });

    it('仅清除已缺失的 RunningHub 缓存，保留主图、身份及提示词，整批只提交一次', async () => {
      const before = useAppStore.getState();
      const source = before.nodes[0];
      const revision = before.getCurrentRevision();
      const commit = vi.spyOn(before, 'commitToHistory');
      const increment = vi.spyOn(before, 'incrementRevision');
      const tool = getAgentTool('canvas_update_nodes')!;
      const input = { nodeIds: ['repair'], repairMissingCloudOutputs: true };
      expect(tool.effect).toBe('canvas_write');
      expect(validateAgentToolInput(tool.inputSchema, input).valid).toBe(true);
      const result = await tool.execute({ ...context(), baseRevision: revision }, input);
      expect(result.status).toBe('success');
      expect(cloudOutputRepair.directory).toHaveBeenCalledExactlyOnceWith('p1');
      expect(cloudOutputRepair.invoke).toHaveBeenCalledExactlyOnceWith('inspect_project_archive_assets', { assetsDir: directory });
      expect(useAppStore.getState().nodes[0].data).toEqual({ ...source.data, runninghubOutputs: undefined });
      expect(useAppStore.getState().nodes[0].data.workflowApiOutputs).toBe(source.data.workflowApiOutputs);
      expect(commit).toHaveBeenCalledOnce();
      expect(increment).toHaveBeenCalledOnce();
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
      expect(useAppStore.getState().history[0].nodes[0].data.runninghubOutputs).toEqual(source.data.runninghubOutputs);
      expect(JSON.parse(result.modelContent)).toMatchObject({ affectedNodeIds: ['repair'], revision: revision + 1, nodes: [{
        nodeId: 'repair', label: '沈松月1', clearedFields: ['runninghubOutputs'], primaryStatus: 'exists',
        beforeCounts: { runninghubOutputs: 1, workflowApiOutputs: 1 }, afterCounts: { runninghubOutputs: 0, workflowApiOutputs: 1 },
      }] });
      expect(result.summary + result.modelContent).not.toMatch(/D:\/project|asset:\/\/|https:\/\/|生成图像_4\.png|保留原提示词/);
    });

    it('多产物缓存保持原样，不提交历史或递增版本', async () => {
      const source = useAppStore.getState().nodes[0];
      useAppStore.setState({ nodes: [{ ...source, data: { ...source.data, runninghubOutputs: [
        ...source.data.runninghubOutputs!, { kind: 'image', filePath: `${directory}/第二张旧图.png`, url: 'https://example.test/second.png' },
      ] } }] });
      const before = useAppStore.getState();
      const revision = before.getCurrentRevision();
      const commit = vi.spyOn(before, 'commitToHistory');
      const increment = vi.spyOn(before, 'incrementRevision');
      const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['repair'], repairMissingCloudOutputs: true });
      expect(result).toMatchObject({ status: 'success', summary: '未发现可安全清理的缺失单产物缓存，未修改节点' });
      expect(useAppStore.getState().nodes).toBe(before.nodes);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
      expect(commit).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
      expect(JSON.parse(result.modelContent)).toMatchObject({ affectedNodeIds: [], nodes: [{ clearedFields: [],
        beforeCounts: { runninghubOutputs: 2, workflowApiOutputs: 1 }, afterCounts: { runninghubOutputs: 2, workflowApiOutputs: 1 },
      }] });
    });

    it('拒绝混合普通编辑，也不接受调用方指定的路径或任意 data', async () => {
      const before = useAppStore.getState();
      const revision = before.getCurrentRevision();
      const commit = vi.spyOn(before, 'commitToHistory');
      const tool = getAgentTool('canvas_update_nodes')!;
      const input = { nodeIds: ['repair'], repairMissingCloudOutputs: true };
      expect(validateAgentToolInput(tool.inputSchema, { ...input, filePath: '/private/file.png' }).valid).toBe(false);
      expect(validateAgentToolInput(tool.inputSchema, { ...input, data: { runninghubOutputs: undefined } }).valid).toBe(false);
      const result = await tool.execute(context(), { ...input, label: '不得写入的名称' });
      expect(result).toMatchObject({ status: 'error', summary: '修复缺失产物缓存不能混合普通节点编辑，请分开调用' });
      expect(cloudOutputRepair.directory).not.toHaveBeenCalled();
      expect(cloudOutputRepair.invoke).not.toHaveBeenCalled();
      expect(useAppStore.getState().nodes).toBe(before.nodes);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
      expect(commit).not.toHaveBeenCalled();
    });

    it.each(['project', 'node-data', 'revision'] as const)('原生清单读取期间 %s 改变时不清理旧节点数据', async (change) => {
      let finishInspection!: (value: ArchiveAssetDigest[]) => void;
      let inspectionStarted!: () => void;
      const started = new Promise<void>((resolve) => { inspectionStarted = resolve; });
      cloudOutputRepair.invoke.mockImplementationOnce(() => new Promise<ArchiveAssetDigest[]>((resolve) => {
        finishInspection = resolve;
        inspectionStarted();
      }));
      const initial = useAppStore.getState();
      const commit = vi.spyOn(initial, 'commitToHistory');
      const pending = getAgentTool('canvas_update_nodes')!.execute({ ...context(), baseRevision: initial.getCurrentRevision() }, {
        nodeIds: ['repair'], repairMissingCloudOutputs: true,
      });
      await started;
      if (change === 'project') useAppStore.setState({ currentProjectId: 'p2' });
      if (change === 'node-data') useAppStore.getState().updateNodeDataTransient('repair', { prompt: '用户继续编辑' });
      if (change === 'revision') useAppStore.getState().incrementRevision();
      const beforeFinish = useAppStore.getState();
      const revision = beforeFinish.getCurrentRevision();
      finishInspection(assets);
      await expect(pending).rejects.toThrow('已变化');
      expect(useAppStore.getState().nodes).toBe(beforeFinish.nodes);
      expect(useAppStore.getState().nodes[0].data.runninghubOutputs).toEqual(initial.nodes[0].data.runninghubOutputs);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
      expect(commit).not.toHaveBeenCalled();
      expect(useAppStore.getState().history).toEqual([]);
    });
  });

  describe('显式移除父资产已不存在的精确剧集引用', () => {
    const missingId = 'deleted-character#missing-picture';
    const missingToken = `@drama{${missingId}:押运差头}`;
    const secondToken = `@drama{${missingId}:押运差头侧面}`;
    const validId = 'kept-character#kept-picture';
    const validToken = `@drama{${validId}:有效角色}`;
    const otherToken = '@drama{deleted-character#other-picture:尚未请求移除的引用}';
    const longPrompt = `${'前文应原样保留。'.repeat(80)}${missingToken}\n正文中段不可删\n${validToken}\n${otherToken}\n${missingToken}\n${'尾部完整保留。'.repeat(80)}长提示词结尾哨兵`;

    beforeEach(() => {
      const kept: DramaAsset = { id: 'kept-character', kind: 'character', name: '有效角色', key: 'kept', identity: '',
        summary: '', visualNotes: '', importance: 'supporting', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1,
        referenceImages: [{ id: 'kept-picture', kind: 'primary', imageUrl: 'https://example.test/kept.png', prompt: '', createdAt: 1, updatedAt: 1 }] };
      useAppStore.setState({ projectLoadStatus: 'ready', switchingProjectName: null, isCreatingProject: false, isReturningToStartPage: false,
        edges: [], dramaAssets: { ...emptyDramaAssetLibrary(), characters: [kept] }, nodes: [
        node('mention-a', { displayId: 93, label: '视频一', type: 'ai-video', prompt: longPrompt,
          videoUrl: 'asset://localhost/D:/project/result.mp4', filePath: 'D:/project/result.mp4', relativePath: 'result.mp4', assetId: 'result-asset' }),
        node('mention-b', { displayId: 97, label: '视频二', type: 'ai-video', prompt: `开始\n${secondToken}\n${validToken}\n完整结尾` }),
        node('unselected', { prompt: missingToken }),
      ] });
    });

    it('宿主完整替换指定精确 ID 的所有 token，保留长正文、有效引用与未选节点，批量只提交一次', async () => {
      const before = useAppStore.getState();
      const revision = before.getCurrentRevision();
      const commit = vi.spyOn(before, 'commitToHistory');
      const increment = vi.spyOn(before, 'incrementRevision');
      const result = await getAgentTool('canvas_update_nodes')!.execute({ ...context(), baseRevision: revision }, {
        nodeIds: ['mention-a', 'mention-b'], removeMissingDramaMentionIds: [missingId],
      });
      expect(result.status).toBe('success');
      const after = useAppStore.getState();
      expect(after.nodes[0].data).toEqual({ ...before.nodes[0].data, prompt: longPrompt.replaceAll(missingToken, '押运差头') });
      expect(after.nodes[1].data).toEqual({ ...before.nodes[1].data,
        prompt: before.nodes[1].data.prompt!.replaceAll(secondToken, '押运差头侧面') });
      expect(after.nodes[0].data.prompt).toContain(validToken);
      expect(after.nodes[0].data.prompt).toContain(otherToken);
      expect(after.nodes[0].data.prompt).toContain('长提示词结尾哨兵');
      expect(after.nodes[2]).toBe(before.nodes[2]);
      expect(after.edges).toBe(before.edges);
      expect(commit).toHaveBeenCalledOnce();
      expect(increment).toHaveBeenCalledOnce();
      expect(after.getCurrentRevision()).toBe(revision + 1);
      expect(after.history[0].nodes[0].data.prompt).toBe(longPrompt);
      expect(JSON.parse(result.modelContent)).toMatchObject({ affectedNodeIds: ['mention-a', 'mention-b'], removedCount: 3,
        revision: revision + 1, nodes: [{ nodeId: 'mention-a', removedCount: 2 }, { nodeId: 'mention-b', removedCount: 1 }] });
      expect(result.summary + result.modelContent).not.toMatch(/前文应原样保留|正文中段不可删|长提示词结尾哨兵|D:\/project|asset:\/\//);
    });

    it('再次移除已处理的精确 ID 不再写节点、历史或版本', async () => {
      const tool = getAgentTool('canvas_update_nodes')!;
      const input = { nodeIds: ['mention-a', 'mention-b'], removeMissingDramaMentionIds: [missingId] };
      expect((await tool.execute(context(), input)).status).toBe('success');
      const before = useAppStore.getState();
      const revision = before.getCurrentRevision();
      const commit = vi.spyOn(before, 'commitToHistory');
      const increment = vi.spyOn(before, 'incrementRevision');
      expect((await tool.execute(context(), input)).status).toBe('success');
      expect(useAppStore.getState().nodes).toBe(before.nodes);
      expect(useAppStore.getState().history).toBe(before.history);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
      expect(commit).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
    });

    it.each([
      { name: '项目切换', state: { switchingProjectName: '' } },
      { name: '项目创建', state: { isCreatingProject: true } },
      { name: '返回启动页', state: { isReturningToStartPage: true } },
    ])('$name期间拒绝清理引用，不修改节点或历史', async ({ state }) => {
      useAppStore.setState(state);
      const before = useAppStore.getState();
      const revision = before.getCurrentRevision();
      const commit = vi.spyOn(before, 'commitToHistory');
      const increment = vi.spyOn(before, 'incrementRevision');
      await expect(getAgentTool('canvas_update_nodes')!.execute(context(), {
        nodeIds: ['mention-a', 'mention-b'], removeMissingDramaMentionIds: [missingId],
      })).rejects.toThrow('不能清理资产引用');
      expect(useAppStore.getState().nodes).toBe(before.nodes);
      expect(useAppStore.getState().history).toBe(before.history);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
      expect(commit).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
    });

    it.each([
      { name: '嵌套花括号', label: '押运{差头}图片' },
      { name: '跨行显示名称', label: '押运\n差头' },
    ])('匹配 ID 的 token 含$name时保留原文，不产生历史', async ({ label }) => {
      const prompt = `完整前文 @drama{${missingId}:${label}} 完整后文`;
      useAppStore.setState({ nodes: [node('malformed', { prompt })] });
      const before = useAppStore.getState();
      const revision = before.getCurrentRevision();
      const commit = vi.spyOn(before, 'commitToHistory');
      const increment = vi.spyOn(before, 'incrementRevision');
      const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
        nodeIds: ['malformed'], removeMissingDramaMentionIds: [missingId],
      });
      expect(result.status).toBe('success');
      expect(JSON.parse(result.modelContent)).toMatchObject({ affectedNodeIds: [], removedCount: 0 });
      expect(useAppStore.getState().nodes).toBe(before.nodes);
      expect(useAppStore.getState().nodes[0].data.prompt).toBe(prompt);
      expect(useAppStore.getState().history).toBe(before.history);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
      expect(commit).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
    });

    it.each([validId, 'kept-character#already-deleted-pick', 'global/absent-character#pick'])('请求混入不允许移除的 %s 时整批失败', async (blockedId) => {
      const before = useAppStore.getState();
      const revision = before.getCurrentRevision();
      const commit = vi.spyOn(before, 'commitToHistory');
      const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
        nodeIds: ['mention-a', 'mention-b'], removeMissingDramaMentionIds: [missingId, blockedId],
      });
      expect(result.status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(before.nodes);
      expect(useAppStore.getState().history).toBe(before.history);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
      expect(commit).not.toHaveBeenCalled();
    });

    it.each([
      { name: '名称', fields: { label: '不得写入' } },
      { name: '完整提示词', fields: { prompt: '不能以此覆盖原文' } },
      { name: '其他修复', fields: { repairMissingCloudOutputs: true } },
    ])('拒绝与$name编辑混用，不部分移除引用', async ({ fields }) => {
      const before = useAppStore.getState();
      const revision = before.getCurrentRevision();
      const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
        nodeIds: ['mention-a'], removeMissingDramaMentionIds: [missingId], ...fields,
      });
      expect(result.status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(before.nodes);
      expect(useAppStore.getState().history).toBe(before.history);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    });

    it('参数只接受一至二十个精确引用 ID，不开放路径或任意 data', () => {
      const schema = getAgentTool('canvas_update_nodes')!.inputSchema;
      const input = { nodeIds: ['mention-a'], removeMissingDramaMentionIds: [missingId] };
      expect(validateAgentToolInput(schema, input).valid).toBe(true);
      expect(validateAgentToolInput(schema, { ...input, removeMissingDramaMentionIds: Array.from({ length: 20 }, (_, index) => `gone-${index}#pick`) }).valid).toBe(true);
      expect(validateAgentToolInput(schema, { ...input, removeMissingDramaMentionIds: [] }).valid).toBe(false);
      expect(validateAgentToolInput(schema, { ...input, removeMissingDramaMentionIds: Array.from({ length: 21 }, (_, index) => `gone-${index}#pick`) }).valid).toBe(false);
      expect(validateAgentToolInput(schema, { ...input, filePath: '/private/file' }).valid).toBe(false);
      expect(validateAgentToolInput(schema, { ...input, data: { prompt: '不接受任意数据' } }).valid).toBe(false);
    });
  });

  it.each(['ai-text', 'ai-markdown', 'source-text'] as const)('更新已有 %s 文件时使用真实磁盘基线 CAS，画布只提交一次', async (type) => {
    textFiles.desktop = true;
    const filePath = '/project/文稿.md';
    const baseline = textSnapshot('原文');
    textFiles.read.mockResolvedValue(baseline);
    useAppStore.setState({ nodes: [node('text', { type, output: '原文', filePath })] });
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['text'], content: '新正文' });
    expect(result.status).toBe('success');
    expect(textFiles.save).toHaveBeenCalledExactlyOnceWith(filePath, baseline, '新正文', expect.any(AbortSignal));
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ type, output: '新正文', filePath });
    expect(commit).toHaveBeenCalledOnce();
    expect(JSON.parse(result.modelContent).textFilePersistence).toMatchObject({ savedCount: 1, failedCount: 0 });
    expect(result.modelContent).not.toContain(filePath);
    expect(result.modelContent).not.toContain('新正文');
  });

  it('磁盘已是新正文时不重复写入，CRLF 旧正文按规范化内容比较', async () => {
    textFiles.desktop = true;
    useAppStore.setState({ nodes: [node('text', { type: 'ai-markdown', output: '旧文\r\n第二行', filePath: '/project/文稿.md' })] });
    textFiles.read.mockResolvedValueOnce(textSnapshot('新文\n第二行'));
    const tool = getAgentTool('canvas_update_nodes')!;
    const first = await tool.execute(context(), { nodeIds: ['text'], content: '新文\r\n第二行' });
    expect(first.status).toBe('success');
    expect(textFiles.save).not.toHaveBeenCalled();
    expect(JSON.parse(first.modelContent).textFilePersistence).toMatchObject({ unchangedCount: 1 });
    textFiles.read.mockResolvedValueOnce(textSnapshot('新文\n第二行'));
    expect((await tool.execute(context(), { nodeIds: ['text'], content: '' })).status).toBe('success');
    expect(textFiles.save).toHaveBeenCalledOnce();
    expect(useAppStore.getState().nodes[0].data.output).toBe('');
  });

  it('整批磁盘基线预读后才提交画布；磁盘冲突保留新草稿且不覆盖文件', async () => {
    textFiles.desktop = true;
    useAppStore.setState({ nodes: [
      node('a', { type: 'ai-markdown', output: '原文', filePath: '/project/a.md' }),
      node('b', { type: 'source-text', output: '原文', filePath: '/project/b.txt' }),
    ] });
    textFiles.read.mockImplementation(async (path: string) => {
      expect(useAppStore.getState().nodes.every((entry) => entry.data.output === '原文')).toBe(true);
      return textSnapshot(path.endsWith('a.md') ? '外部修改' : '原文');
    });
    textFiles.save.mockImplementation(async (_path: string, _baseline: AssetTextSnapshot, content: string) => {
      expect(textFiles.read).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState().nodes.every((entry) => entry.data.output === '保留的新草稿')).toBe(true);
      return textSnapshot(content);
    });
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['a', 'b'], content: '保留的新草稿' });
    expect(result).toMatchObject({ status: 'error', retryable: false, errorCode: 'TEXT_FILE_SAVE_INCOMPLETE' });
    expect(textFiles.save).toHaveBeenCalledExactlyOnceWith('/project/b.txt', expect.anything(), '保留的新草稿', expect.any(AbortSignal));
    expect(JSON.parse(result.modelContent).textFilePersistence).toMatchObject({ savedCount: 1, failedCount: 1,
      results: [{ nodeId: 'a', status: 'conflict' }, { nodeId: 'b', status: 'saved' }] });
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().nodes.every((entry) => entry.data.output === '保留的新草稿')).toBe(true);
    expect(result.modelContent).not.toContain('/project/');
  });

  it('部分文件写入失败只报告脱敏状态，不回滚草稿或重复写入已完成文件', async () => {
    textFiles.desktop = true;
    useAppStore.setState({ nodes: ['a', 'b'].map((id) => node(id, { type: 'ai-text', output: '原文', filePath: `/project/${id}.txt` })) });
    textFiles.save.mockImplementation(async (path: string, _baseline: AssetTextSnapshot, content: string) => {
      if (path.endsWith('b.txt')) throw new Error('/private/sensitive-path 权限失败');
      return textSnapshot(content);
    });
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['a', 'b'], content: '新稿' });
    expect(result.status).toBe('error');
    expect(textFiles.save).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.modelContent).textFilePersistence).toMatchObject({ savedCount: 1, failedCount: 1,
      results: [{ nodeId: 'a', status: 'saved' }, { nodeId: 'b', status: 'save_failed' }] });
    expect(result.modelContent + result.summary).not.toContain('sensitive-path');
    expect(useAppStore.getState().nodes.every((entry) => entry.data.output === '新稿')).toBe(true);
  });

  it('文件读取失败保留新草稿，不绕过权限或静默重建已有文件', async () => {
    textFiles.desktop = true;
    useAppStore.setState({ nodes: [node('text', { type: 'ai-markdown', output: '原文', filePath: '/private/existing.md' })] });
    textFiles.read.mockRejectedValueOnce(new Error('/private/existing.md 无读取权限'));
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['text'], content: '保留的草稿' });
    expect(result).toMatchObject({ status: 'error', retryable: false, errorCode: 'TEXT_FILE_SAVE_INCOMPLETE' });
    expect(JSON.parse(result.modelContent).textFilePersistence.results).toEqual([{ nodeId: 'text', status: 'read_failed' }]);
    expect(textFiles.save).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ output: '保留的草稿', filePath: '/private/existing.md' });
    expect(result.modelContent + result.summary).not.toContain('/private/');
  });

  it.each(['project', 'revision', 'output', 'path'])('预读磁盘期间 %s 变化时不提交旧正文或写入文件', async (change) => {
    textFiles.desktop = true;
    useAppStore.setState({ nodes: [node('text', { type: 'ai-text', output: '原文', filePath: '/project/文稿.txt' })] });
    let finishRead!: (snapshot: AssetTextSnapshot) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    textFiles.read.mockImplementationOnce(() => new Promise<AssetTextSnapshot>((resolve) => {
      finishRead = resolve;
      readStarted();
    }));
    const pending = getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['text'], content: '旧请求新稿' });
    const rejected = expect(pending).rejects.toThrow('已变化');
    await started;
    if (change === 'project') useAppStore.setState({ currentProjectId: 'p2' });
    if (change === 'revision') useAppStore.getState().incrementRevision();
    if (change === 'output') useAppStore.getState().updateNodeDataTransient('text', { output: '用户继续编辑' });
    if (change === 'path') useAppStore.getState().updateNodeDataTransient('text', { filePath: '/project/已移动.txt' });
    finishRead(textSnapshot('原文'));
    await rejected;
    expect(textFiles.save).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes[0].data.output).not.toBe('旧请求新稿');
  });

  it.each(['output', 'path', 'type'])('混合目标中无文件节点的 %s 在预读期间变化时不覆盖任何草稿', async (change) => {
    textFiles.desktop = true;
    useAppStore.setState({ nodes: [
      node('file', { type: 'ai-markdown', output: '有文件原文', filePath: '/project/file.md' }),
      node('draft', { type: 'source-text', output: '无文件原文' }),
    ] });
    const revision = useAppStore.getState().getCurrentRevision();
    let finishRead!: (snapshot: AssetTextSnapshot) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    textFiles.read.mockImplementationOnce(() => new Promise<AssetTextSnapshot>((resolve) => {
      finishRead = resolve;
      readStarted();
    }));
    const pending = getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['file', 'draft'], content: '旧请求的新文' });
    const rejected = expect(pending).rejects.toThrow('已变化');
    await started;
    if (change === 'output') useAppStore.getState().updateNodeDataTransient('draft', { output: '用户继续编辑' });
    if (change === 'path') useAppStore.getState().updateNodeDataTransient('draft', { filePath: '/project/restored.txt' });
    if (change === 'type') useAppStore.getState().updateNodeDataTransient('draft', { type: 'ai-markdown' });
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    finishRead(textSnapshot('有文件原文'));
    await rejected;
    expect(textFiles.save).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes.find((entry) => entry.id === 'file')?.data.output).toBe('有文件原文');
    expect(useAppStore.getState().nodes.find((entry) => entry.id === 'draft')?.data.output)
      .toBe(change === 'output' ? '用户继续编辑' : '无文件原文');
  });

  it('CAS 在途文件关联变化时中止并停止后续文件写入', async () => {
    textFiles.desktop = true;
    useAppStore.setState({ nodes: ['a', 'b'].map((id) => node(id, { type: 'ai-text', output: '原文', filePath: `/project/${id}.txt` })) });
    let finishWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    textFiles.save.mockImplementationOnce(async (_path: string, _baseline: AssetTextSnapshot, content: string, signal: AbortSignal) => {
      writeStarted();
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      signal.throwIfAborted();
      return textSnapshot(content);
    });
    const pending = getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['a', 'b'], content: '新稿' });
    await started;
    useAppStore.getState().updateNodeDataTransient('a', { filePath: '/project/moved.txt' });
    finishWrite();
    const result = await pending;
    expect(result.status).toBe('error');
    expect(textFiles.save).toHaveBeenCalledOnce();
    expect(JSON.parse(result.modelContent).textFilePersistence).toMatchObject({ stale: true, failedCount: 2 });
    expect(useAppStore.getState().nodes.every((entry) => entry.data.output === '新稿')).toBe(true);
  });

  registerNodeCreationTests(canvasCreationFixture);

  it('treats storyboard grids as image-cut results instead of generatable nodes', async () => {
    const createTool = getAgentTool('canvas_create_nodes')!;
    expect(createTool.inputSchema.properties).toMatchObject({
      nodes: { items: { properties: { type: { enum: expect.not.arrayContaining(['ai-storyboard']) } } } },
    });

    const created = await createTool.execute(context(), {
      nodes: [{ type: 'ai-storyboard', label: '九宫格', prompt: '生成九宫格分镜' }],
    });
    expect(created.status).toBe('error');
    expect(created.summary).toContain('只能由已有图片裁切产生');
    expect(useAppStore.getState().nodes).toHaveLength(2);

    useAppStore.setState({
      nodes: [
        ...useAppStore.getState().nodes,
        node('grid', { type: 'ai-storyboard', imageUrl: 'asset://localhost/D:/data/grid.png' }),
      ],
    });
    const updated = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['grid'],
      prompt: '不应写入宫格',
    });
    expect(updated.status).toBe('error');
    expect(updated.summary).toContain('不能设置生成提示词');
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBeUndefined();

    const run = await getAgentTool('canvas_run_nodes')!.execute(context(), { nodeIds: ['grid'] });
    expect(run.status).toBe('error');
    expect(run.summary).toContain('不能运行生成');
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('returns the default node name index without exposing prompt or media fields', async () => {
    const result = await getAgentTool('canvas_query')!.execute(context(), {});
    const data = JSON.parse(result.modelContent);
    expect(data).toMatchObject({ matchedCount: 2, returned: 2, hasMore: false });
    expect(data.nodes.map((item: { id: string }) => item.id)).toEqual(['n1', 'n2']);
    expect(data.affectedNodeIds).toEqual(['n1', 'n2']);
    expect(data.nodes.every((item: Record<string, unknown>) => !('prompt' in item) && !('outputText' in item) && !('imageUrl' in item))).toBe(true);
  });

  it.each([
    { nodeIds: ['missing'] }, { displayIds: [9999] }, { nodeType: 'ai-audio' },
    { selected: true }, { name: '没有这个镜头' }, { nodeIds: [], nodeType: 'ai-image' },
  ])('returns no nodes for an unmatched query instead of falling back to the whole canvas: %j', async (filter) => {
    const tool = getAgentTool('canvas_query')!;
    for (const detail of [false, true]) {
      const result = await tool.execute(context(), { ...filter, detail });
      expect(result.status).toBe('success');
      expect(JSON.parse(result.modelContent)).toMatchObject({ matchedCount: 0, returned: 0, hasMore: false, nodes: [] });
      expect(result.summary).toContain('没有找到匹配节点');
    }
    expect(loadGlobalAssets).not.toHaveBeenCalled();
  });

  it('matches visible names, file aliases and internal names without guessing between duplicates', async () => {
    useAppStore.setState({ nodes: [
      node('visible', { label: '镜头三', displayLabel: 'Ｒ０３' }),
      node('prefix', { label: 'R030' }),
      node('file', { label: '原名', fileName: 'r03' }),
    ] });
    const tool = getAgentTool('canvas_query')!;
    const read = async (input: Record<string, unknown>) => JSON.parse((await tool.execute(context(), input)).modelContent);
    expect((await read({ name: 'r03' })).nodes.map((item: { id: string }) => item.id)).toEqual(['visible', 'prefix', 'file']);
    expect((await read({ name: ' r03 ', nameMatch: 'exact' })).nodes.map((item: { id: string }) => item.id)).toEqual(['visible', 'file']);
    expect((await read({ name: '镜头三', nameMatch: 'exact' })).nodes.map((item: { id: string }) => item.id)).toEqual(['visible']);
    expect((await read({ name: 'R03', nodeIds: ['file'], nameMatch: 'exact' })).nodes.map((item: { id: string }) => item.id)).toEqual(['file']);
    expect((await read({ name: 'R03', nodeType: 'ai-video' })).nodes).toEqual([]);
    expect((await tool.execute(context(), { name: '   ' })).status).toBe('error');
  });

  it('pages a bounded name index and reports exhausted offsets without unrelated nodes', async () => {
    const ids = Array.from({ length: 67 }, (_, index) => `shot-${index}`);
    useAppStore.setState({ nodes: ids.map((id) => node(id, { prompt: 'private-prompt-index-marker', imageUrl: 'asset://private-file' })) });
    const tool = getAgentTool('canvas_query')!;
    const found: string[] = [];
    let offset = 0;
    while (true) {
      const result = await tool.execute(context(), { name: 'shot-', offset, limit: 20 });
      const data = JSON.parse(result.modelContent);
      expect(data).toMatchObject({ projectId: 'p1', matchedCount: 67, offset });
      expect(data.nodes.length).toBeLessThanOrEqual(20);
      expect(result.modelContent).not.toContain('private-prompt-index-marker');
      expect(result.modelContent).not.toContain('asset://private-file');
      found.push(...data.nodes.map((item: { id: string }) => item.id));
      if (!data.hasMore) break;
      expect(data.nextOffset).toBeGreaterThan(offset);
      offset = data.nextOffset;
    }
    expect(found).toEqual(ids);
    const exhausted = JSON.parse((await tool.execute(context(), { name: 'shot-', offset: 99, detail: true })).modelContent);
    expect(exhausted).toMatchObject({ matchedCount: 67, returned: 0, nodes: [], edges: [], hasMore: false });
    expect(exhausted.summary).toContain('offset=0');
    expect(validateAgentToolInput(tool.inputSchema, { name: 'shot-', nameMatch: 'exact', offset: 1, limit: 1 }).valid).toBe(true);
    expect(validateAgentToolInput(tool.inputSchema, { offset: -1 }).valid).toBe(false);
    expect(validateAgentToolInput(tool.inputSchema, { nameMatch: 'regex' }).valid).toBe(false);
    expect(validateAgentToolInput(getAgentTool('canvas_update_nodes')!.inputSchema, { name: 'shot-', prompt: '不允许按模糊名称写入' }).valid).toBe(false);
  });

  it('rejects cancelled index reads without writing history', async () => {
    const controller = new AbortController();
    controller.abort();
    const state = useAppStore.getState();
    await expect(getAgentTool('canvas_query')!.execute({ ...context(), signal: controller.signal }, {})).rejects.toMatchObject({ name: 'AbortError' });
    expect(useAppStore.getState().history).toBe(state.history);
  });

  it('returns structured node detail without leaking local media paths', async () => {
    const result = await getAgentTool('canvas_query')!.execute(context(), { detail: true });
    const payload = JSON.parse(result.modelContent);

    expect(result.status).toBe('success');
    expect(payload.nodes).toHaveLength(2);
    expect(payload.nodes[0]).toMatchObject({
      id: 'n1',
      displayId: 1,
      position: { x: 100, y: 100 },
      outputKind: 'image',
      prompt: { text: '一只猫', truncated: false },
    });
    // 媒体节点只报类型，绝对路径和 URL 都不能出现在回传内容里
    expect(result.modelContent).not.toContain('asset://');
    expect(result.modelContent).not.toContain('D:/data');
    expect(payload.nodes[1].outputText).toEqual({ text: '剧本正文', truncated: false });
    expect(payload.edges).toEqual([{
      id: 'e1', source: 'n1', target: 'n2', sourceHandle: null, targetHandle: null,
      layout: { sourceRightX: 380, targetLeftX: 500, horizontalGap: 120, recommendedMinGap: 48, warning: null },
    }]);
  });

  it.each<{ label: string; data: Partial<BaseNodeData>; outputKind: string | null }>([
    { label: 'video with thumbnail and poster', data: { type: 'ai-video', videoUrl: 'asset://clip.mp4', thumbnailUrl: 'asset://thumb.jpg', imageUrl: 'asset://poster.png' }, outputKind: 'video' },
    { label: 'audio with thumbnail and cover', data: { type: 'ai-audio', audioUrl: 'asset://audio.wav', thumbnailUrl: 'asset://thumb.jpg', imageUrl: 'asset://cover.png' }, outputKind: 'audio' },
    { label: 'image', data: { imageUrl: 'asset://image.png' }, outputKind: 'image' },
    { label: 'thumbnail-only image', data: { thumbnailUrl: 'asset://thumb.jpg' }, outputKind: 'image' },
    { label: 'text with thumbnail', data: { type: 'source-text', output: '实际正文', thumbnailUrl: 'asset://thumb.jpg' }, outputKind: 'text' },
    { label: 'text', data: { type: 'ai-text', output: '实际正文' }, outputKind: 'text' },
    { label: 'video type without a result', data: { type: 'ai-video', status: 'success' }, outputKind: null },
    { label: 'audio type without a result', data: { type: 'ai-audio' }, outputKind: null },
  ])('reports the actual primary output for $label without exposing media URLs', async ({ data, outputKind }) => {
    useAppStore.setState({ nodes: [node('result', data)], edges: [] });
    const result = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: ['result'], detail: true });
    expect(result.status).toBe('success');
    const detail = JSON.parse(result.modelContent).nodes[0];
    expect(detail.outputKind).toBe(outputKind);
    expect(detail.outputText).toEqual(outputKind === 'text' ? { text: '实际正文', truncated: false } : undefined);
    expect(result.modelContent).not.toContain('asset://');
  });

  it('shifts nodes with dx/dy and resizes them in one call', async () => {
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1', 'n2'],
      dx: 40,
      dy: -20,
      width: 400,
    });

    expect(result.status).toBe('success');
    const nodes = useAppStore.getState().nodes;
    expect(nodes.map((item) => item.position)).toEqual([
      { x: 140, y: 80 },
      { x: 540, y: 200 },
    ]);
    expect(nodes[0].data.nodeWidth).toBe(400);
    expect(result.display?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: 'n1',
        field: '位置 X',
        before: 100,
        after: 140,
      }),
      expect.objectContaining({
        targetId: 'n1',
        field: '宽度',
        before: 280,
        after: 400,
      }),
      expect.objectContaining({
        targetId: 'n2',
        field: '位置 Y',
        before: 220,
        after: 200,
      }),
    ]));
  });

  it('records before and after values for text changes', async () => {
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1'],
      label: '主视觉',
      prompt: '一只戴红围巾的猫',
      aspectRatio: '16:9',
    });

    expect(result.display?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: '名称', before: 'n1', after: '主视觉' }),
      expect.objectContaining({ field: '提示词', before: '一只猫', after: '一只戴红围巾的猫' }),
      expect.objectContaining({ field: '画面比例', before: undefined, after: '16:9' }),
    ]));
  });

  it('maps standardized video controls onto video node protocol fields', async () => {
    useAppStore.setState({
      nodes: [
        ...useAppStore.getState().nodes,
        node('n3', { displayId: 3, type: 'ai-video' }, { x: 800, y: 100 }),
      ],
    });

    const definition = getAgentTool('canvas_update_nodes')!;
    expect(definition.inputSchema.properties).toMatchObject({
      videoResolution: { type: 'string' },
      videoDuration: { type: 'number' },
    });
    const result = await definition.execute(context(), {
      nodeIds: ['n3'],
      videoResolution: '768P',
      videoDuration: 4,
    });

    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'n3')?.data).toMatchObject({
      seedanceResolution: '768P',
      seedanceDuration: 4,
    });
    expect(result.display?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: '视频分辨率', before: undefined, after: '768P' }),
      expect.objectContaining({ field: '视频时长', before: undefined, after: 4 }),
    ]));

    const queried = await getAgentTool('canvas_query')!.execute(context(), {
      nodeIds: ['n3'],
      detail: true,
    });
    expect(JSON.parse(queried.modelContent).nodes[0]).toMatchObject({
      videoResolution: '768P',
      videoDuration: 4,
    });

    const guarded = await definition.execute(context(), {
      nodeIds: ['n1'],
      videoDuration: 4,
    });
    expect(guarded.status).toBe('error');
    expect(guarded.summary).toContain('只能用于视频节点');
  });

  it('rejects absolute moves that target more than one node', async () => {
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1', 'n2'],
      x: 10,
      y: 10,
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('dx/dy');
    expect(useAppStore.getState().nodes[0].position).toEqual({ x: 100, y: 100 });
  });

  it('rewrites text node content but refuses media nodes', async () => {
    const definition = getAgentTool('canvas_update_nodes')!;

    // n1 是图片节点，output 存的是本地路径，不能被 content 覆盖
    const guarded = await definition.execute(context(), { nodeIds: ['n1'], content: '新正文' });
    expect(guarded.status).toBe('error');
    expect(useAppStore.getState().nodes[0].data.imageUrl).toContain('cat.png');

    const result = await definition.execute(context(), { nodeIds: ['n2'], content: '新正文' });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[1].data.output).toBe('新正文');
  });

  it('refuses model refs that are not configured', async () => {
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1'],
      model: 'made-up/model',
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('未配置');
    expect(useAppStore.getState().nodes[0].data.model).toBeUndefined();
  });

  it('refuses connections whose target is a source-only node', async () => {
    const definition = getAgentTool('canvas_connect_nodes')!;

    // n2 是 source-text，没有输入端；写反方向必须被挡下而不是画一条永远读不到的线
    const reversed = await definition.execute(context(), { sourceId: 'n1', targetId: 'n2' });
    expect(reversed.status).toBe('error');
    expect(reversed.summary).toContain('素材节点');
    expect(useAppStore.getState().edges).toHaveLength(1);

    const forward = await definition.execute(context(), { sourceId: 'n2', targetId: 'n1' });
    expect(forward.status).toBe('success');
    const created = useAppStore.getState().edges.at(-1);
    expect(created).toMatchObject({
      source: 'n2',
      target: 'n1',
      sourceHandle: 'right',
      targetHandle: 'left',
    });
  });

  it('connects an output list once, skips duplicates and restores the batch with one undo', async () => {
    const beforeEdges = [{ id: 'existing', source: 'image', target: 'target', sourceHandle: 'right', targetHandle: 'left' }];
    useAppStore.setState({ nodes: [
      node('image', { type: 'source-image' }, { x: 0, y: 0 }),
      node('brief', { type: 'source-text', output: '镜头说明' }, { x: 0, y: 250 }),
      node('target', { prompt: '原提示词' }, { x: 1000, y: 0 }),
    ], edges: beforeEdges });
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const revision = useAppStore.getState().getCurrentRevision();
    const tool = getAgentTool('canvas_connect_nodes')!;
    const result = await tool.execute(context(), { sourceIds: ['image', 'image', 'brief'], targetId: 'target' });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent)).toMatchObject({
      sourceIds: ['image', 'brief'], targetId: 'target', createdCount: 1, skippedCount: 2,
      connections: [
        { sourceId: 'image', targetId: 'target', alreadyConnected: true, sourceHandle: 'right', targetHandle: 'left' },
        { sourceId: 'brief', targetId: 'target', alreadyConnected: false, sourceHandle: 'right', targetHandle: 'left' },
      ],
    });
    expect(useAppStore.getState().edges).toHaveLength(2);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'target')!.data.prompt).toContain('@{brief:brief}');
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(commit).toHaveBeenCalledTimes(1);
    const repeated = await tool.execute(context(), { sourceIds: ['image', 'brief'], targetId: 'target' });
    expect(JSON.parse(repeated.modelContent)).toMatchObject({ createdCount: 0, skippedCount: 2 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().edges).toEqual(beforeEdges);
    await useAppStore.getState().redo();
    expect(useAppStore.getState().edges).toContainEqual(expect.objectContaining({
      source: 'brief', target: 'target', sourceHandle: 'right', targetHandle: 'left',
    }));
  });

  it('accepts one output in a list and keeps the old single-source result fields', async () => {
    const tool = getAgentTool('canvas_connect_nodes')!;
    expect(validateAgentToolInput(tool.inputSchema, { sourceIds: ['n2'], targetId: 'n1' }).valid).toBe(true);
    expect(validateAgentToolInput(tool.inputSchema, { sourceId: 'n2', targetId: 'n1' }).valid).toBe(true);
    expect(validateAgentToolInput(tool.inputSchema, { sourceIds: Array(51).fill('n2'), targetId: 'n1' }).valid).toBe(false);
    const result = await tool.execute(context(), { sourceIds: ['n2'], targetId: 'n1' });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent)).toMatchObject({
      sourceId: 'n2', targetId: 'n1', sourceHandle: 'right', targetHandle: 'left', createdCount: 1,
    });
  });

  it.each([
    { targetId: 'n1' },
    { sourceId: 'n2', sourceIds: ['n2'], targetId: 'n1' },
    { sourceIds: [], targetId: 'n1' },
    { sourceIds: ['n2', 'missing'], targetId: 'n1' },
    { sourceIds: ['n2', 'n1'], targetId: 'n1' },
    { sourceIds: ['n1'], targetId: 'n2' },
  ])('rejects an invalid output list without partial writes: %j', async (input) => {
    const before = useAppStore.getState();
    const revision = before.getCurrentRevision();
    const commit = vi.spyOn(before, 'commitToHistory');
    const result = await getAgentTool('canvas_connect_nodes')!.execute(context(), input);
    expect(result.status).toBe('error');
    expect(useAppStore.getState().edges).toBe(before.edges);
    expect(useAppStore.getState().nodes).toBe(before.nodes);
    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
  });

  it.each([
    ['director', 'ai-director', 'sourceId'], ['director', 'ai-director', 'sourceIds'],
    ['video', 'ai-video', 'sourceId'], ['video', 'ai-video', 'sourceIds'],
    ['voiceover', 'ai-audio', 'sourceId'], ['voiceover', 'ai-audio', 'sourceIds'],
  ] as const)('rejects %s production (%s) feeding its own shotlist through %s', async (kind, type, field) => {
    useAppStore.setState({ nodes: [
      node('sheet', { type: 'ai-shotlist' }),
      node('production', { type, shotlistProductionSource: { nodeId: 'sheet', rowId: 'row', kind } }),
      node('other'),
    ], edges: [] });
    const result = await getAgentTool('canvas_connect_nodes')!.execute(context(), {
      ...(field === 'sourceId' ? { sourceId: 'production' } : { sourceIds: ['other', 'production'] }), targetId: 'sheet',
    });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('分镜表 → 导演台');
    expect(result.summary).toContain('视频与配音成果通过镜头来源关联');
    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('rejects a collapsed batch source before writing any other connection', async () => {
    const source = { ...node('n2', { type: 'source-text' }), parentId: 'group' };
    useAppStore.setState({ nodes: [useAppStore.getState().nodes[0], source,
      node('other', { type: 'source-image' }), { ...node('group', { groupCollapsed: true }), type: 'group' },
    ], edges: [] });
    const result = await getAgentTool('canvas_connect_nodes')!.execute(context(), { sourceIds: ['other', 'n2'], targetId: 'n1' });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('展开分组');
    expect(useAppStore.getState().edges).toEqual([]);
  });

  it('removes only the edges matching the given endpoints', async () => {
    useAppStore.setState({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n1' },
      ],
    });
    const definition = getAgentTool('canvas_disconnect_nodes')!;

    // 两端都不给会清空整张图的连线，必须先被拒绝
    const guarded = await definition.execute(context(), {});
    expect(guarded.status).toBe('error');
    expect(useAppStore.getState().edges).toHaveLength(2);

    const result = await definition.execute(context(), { sourceId: 'n1' });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().edges.map((edge) => edge.id)).toEqual(['e2']);
  });

  it('reports backward layout even when connection ports are right-to-left, without moving nodes', async () => {
    const tool = getAgentTool('canvas_connect_nodes')!;
    const before = useAppStore.getState().nodes.map((item) => ({ ...item.position }));
    const result = await tool.execute(context(), { sourceId: 'n2', targetId: 'n1' });
    const payload = JSON.parse(result.modelContent);
    expect(payload).toMatchObject({ sourceHandle: 'right', targetHandle: 'left' });
    expect(payload.layout.horizontalGap).toBeLessThan(0);
    expect(payload.layout.warning).toContain('上游应放左');
    expect(useAppStore.getState().nodes.map((item) => item.position)).toEqual(before);
    const revision = useAppStore.getState().getCurrentRevision();
    const repeated = await tool.execute({ ...context(), baseRevision: revision }, { sourceId: 'n2', targetId: 'n1' });
    expect(JSON.parse(repeated.modelContent)).toMatchObject({ alreadyConnected: true, layout: payload.layout });
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
  });

  it('checks absolute grouped positions and returns actual ports in canvas detail', async () => {
    const parent = node('group', {}, { x: 1000, y: 0 });
    const source = { ...node('src', { type: 'source-image', nodeWidth: 400 }, { x: 100, y: 0 }), parentId: 'group' };
    const target = node('dst', {}, { x: 1548, y: 200 });
    useAppStore.setState({ nodes: [parent, source, target], edges: [] });
    const result = await getAgentTool('canvas_connect_nodes')!.execute(context(), { sourceId: 'src', targetId: 'dst' });
    const payload = JSON.parse(result.modelContent);
    expect(payload.layout).toEqual({ sourceRightX: 1500, targetLeftX: 1548, horizontalGap: 48, recommendedMinGap: 48, warning: null });
    const query = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: ['src'], detail: true });
    expect(JSON.parse(query.modelContent).edges[0]).toMatchObject({ sourceHandle: 'right', targetHandle: 'left', layout: payload.layout });
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === 'dst'
      ? { ...item, position: { ...item.position, x: 1547 } } : item) });
    const crowded = await getAgentTool('canvas_connect_nodes')!.execute(context(), { sourceId: 'src', targetId: 'dst' });
    expect(JSON.parse(crowded.modelContent).layout.warning).toContain('48');
  });

  it('runs matched nodes serially and skips ones already generating', async () => {
    useAppStore.setState({
      nodes: [
        node('n1', { displayId: 1, status: 'loading' }),
        node('n2', { displayId: 2 }),
      ],
    });
    const definition = getAgentTool('canvas_run_nodes')!;

    expect(definition.effect).toBe('media_generation');
    const result = await definition.execute(context(), { nodeIds: ['n1', 'n2'] });
    const payload = JSON.parse(result.modelContent);

    expect(executeGeneration).toHaveBeenCalledTimes(1);
    expect(executeGeneration).toHaveBeenCalledWith('n2', undefined, undefined, undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal), assertFresh: expect.any(Function) }));
    expect(payload.results).toEqual([
      { nodeId: 'n1', status: 'skipped', message: '节点正在生成中' },
      { nodeId: 'n2', status: 'success', message: undefined },
    ]);
  });

  it('native run freezes host leases after controlled reference metadata patches, including overlapping selected references', async () => {
    const references = [{ id: 'ref', kind: 'frame' as const, role: 'reference' as const, url: 'asset://localhost/project/ref.png' }];
    useAppStore.setState({ nodes: [node('n1', { videoReferences: references }), node('n2', { videoReferences: references })],
      edges: [{ id: 'reference', source: 'n2', target: 'n1' }],
      projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'native-run',
        projectId: 'owner', projectEpoch: 1, canvasId: 'p1', episodeId: null, canvasEpoch: 1, canvasRevision: 0 } });
    const normalize = vi.fn(async (nodeId: string) => {
      const state = useAppStore.getState(), target = state.nodes.find((item) => item.id === nodeId)!;
      if (target.data.videoReferences?.[0].assetId) return { targetPatch: {}, nodePatches: new Map<string, Partial<BaseNodeData>>() };
      const patch = { videoReferences: references.map((reference) => ({ ...reference, assetId: 'asset-ref' })) };
      useAppStore.setState({ nodes: state.nodes.map((item) => ({ ...item, data: { ...item.data, ...patch } })) });
      return { targetPatch: patch, nodePatches: new Map([['n1', patch], ['n2', patch]]) };
    });
    useAppStore.setState({ normalizeNativeMediaGenerationInputs: normalize });
    for (let count = 0; count < 2; count++) executeGeneration.mockImplementationOnce(async (nodeId, _prompt, _post, _data, lease) => {
      await normalize(nodeId); await lease?.assertFresh(); return { success: true };
    });
    const result = await getAgentTool('canvas_run_nodes')!.execute(context(), { nodeIds: ['n1', 'n2'] });
    expect(result.status).toBe('success'); expect(executeGeneration).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.modelContent).results.every((item: { status: string }) => item.status === 'success')).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(4);
  });

  it('native host preparation never accepts another selected node real edit as a fresh authorization baseline', async () => {
    const references = [{ id: 'ref', kind: 'frame' as const, role: 'reference' as const, url: 'asset://localhost/project/ref.png' }];
    useAppStore.setState({ nodes: [node('n1', { videoReferences: references }), node('n2', { prompt: '原授权提示词' })], edges: [],
      projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'native-run',
        projectId: 'owner', projectEpoch: 1, canvasId: 'p1', episodeId: null, canvasEpoch: 1, canvasRevision: 0 } });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const normalize = vi.fn(async () => {
      await gate;
      const patch = { videoReferences: references.map((reference) => ({ ...reference, assetId: 'asset-ref' })) };
      useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === 'n1' ? { ...item, data: { ...item.data, ...patch } } : item) });
      return { targetPatch: patch, nodePatches: new Map([['n1', patch]]) };
    });
    useAppStore.setState({ normalizeNativeMediaGenerationInputs: normalize });
    const pending = getAgentTool('canvas_run_nodes')!.execute(context(), { nodeIds: ['n1', 'n2'] });
    expect(normalize).toHaveBeenCalledOnce();
    useAppStore.getState().updateNodeDataTransient('n2', { prompt: '准备期间真实新输入' });
    finish();
    await expect(pending).rejects.toThrow(/输入已变化/);
    expect(executeGeneration).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes[1].data.prompt).toBe('准备期间真实新输入');
  });

  it('caps how many nodes one run call may generate', async () => {
    useAppStore.setState({
      nodes: Array.from({ length: 6 }, (_, index) => node(`n${index}`, { displayId: index + 1 })),
    });

    const result = await getAgentTool('canvas_run_nodes')!.execute(context(), {
      nodeType: 'ai-image',
    });

    expect(result.status).toBe('error');
    expect(executeGeneration).not.toHaveBeenCalled();
  });
});
