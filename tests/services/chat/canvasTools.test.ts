/**
 * canvasTools — 回归测试：canvas agent tools。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerCanvasAgentTools } from '../../../src/services/chat/tools/canvasTools';
import { registerShotlistAgentTools } from '../../../src/services/chat/tools/shotlistTools';
import { validateAgentToolInput } from '../../../src/services/chat/agentToolSchemas';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import type { BaseNodeData } from '../../../src/types';
import { emptyDramaAssetLibrary, type DramaAsset } from '../../../src/types/dramaAssets';
import type { AssetTextSnapshot } from '../../../src/services/fileService';
import type { ArchiveAssetDigest } from '../../../src/services/projectExchangeDomain';

const executeGeneration = vi.hoisted(() => vi.fn(async () => ({ success: true })));
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

  it('MCP 创建、查询和更新图片质量背景及视频帧率音轨，保留自动时长和 false', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, video: { name: '视频连接', catalogId: 'custom-openai', apiKey: 'fixture' } },
      generalModels: [
        { id: 'image-options', name: '图片模型', modelId: 'image-options', category: 'image', providerConfigId: 'video',
          imageCapability: { qualities: ['low', 'high'], backgrounds: ['opaque', 'transparent'] } },
        { id: 'video-auto', name: '视频模型', modelId: 'video-auto', category: 'video', providerConfigId: 'video',
          videoCapability: { operations: ['text-to-video'], automaticDurationValue: -1, frameRates: [24], supportsAudio: true } },
      ],
    } }));
    const create = getAgentTool('canvas_create_nodes')!;
    const input = { nodes: [
      { type: 'ai-image', label: '透明图', model: 'general/image-options', imageQuality: 'high', imageBackground: 'transparent' },
      { type: 'ai-video', label: '视频', model: 'general/video-auto', videoDuration: -1, videoFps: 24, generateAudio: false },
    ] };
    expect(validateAgentToolInput(create.inputSchema, input).valid).toBe(true);
    expect((await create.execute(context(), input)).status).toBe('success');
    const image = useAppStore.getState().nodes.find((item) => item.data.label === '透明图')!;
    const video = useAppStore.getState().nodes.find((item) => item.data.label === '视频')!;
    expect(image.data).toMatchObject({ imageQuality: 'high', imageBackground: 'transparent' });
    expect(video.data).toMatchObject({ seedanceDuration: -1, videoFps: 24, generateAudio: false });
    const update = getAgentTool('canvas_update_nodes')!;
    const patch = { nodeIds: [image.id], imageBackground: '' };
    expect(validateAgentToolInput(update.inputSchema, patch).valid).toBe(true);
    expect((await update.execute(context(), patch)).status).toBe('success');
    const query = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [image.id, video.id], detail: true });
    const nodes = JSON.parse(query.modelContent).nodes;
    expect(nodes.find((item: { id: string }) => item.id === image.id)).toMatchObject({ imageQuality: 'high', imageBackground: '' });
    expect(nodes.find((item: { id: string }) => item.id === video.id)).toMatchObject({ videoDuration: -1, videoFps: 24, generateAudio: false });
    expect((await update.execute(context(), { nodeIds: [video.id], videoFps: 30 })).status).toBe('error');
    expect((await update.execute(context(), { nodeIds: [image.id], imageQuality: 'max' })).status).toBe('error');
    expect(useAppStore.getState().nodes.find((item) => item.id === video.id)?.data.videoFps).toBe(24);
    expect(useAppStore.getState().nodes.find((item) => item.id === image.id)?.data.imageQuality).toBe('high');
    // 即使节点在别处被改成不受当前模型支持的值，运行入口也不能静默丢弃后调用模型。
    useAppStore.getState().updateNodeDataTransient(image.id, { imageQuality: 'max' });
    const run = await getAgentTool('canvas_run_nodes')!.execute(context(), { nodeIds: [image.id] });
    expect(run.status).toBe('error');
    expect(JSON.parse(run.modelContent).results[0].message).toContain('质量');
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('拒绝未声明的自动时长及跨类型参数，不写入画布', async () => {
    const before = useAppStore.getState().nodes;
    const tool = getAgentTool('canvas_create_nodes')!;
    expect((await tool.execute(context(), { nodes: [{ type: 'ai-video', label: '视频', videoDuration: -1 }] })).status).toBe('error');
    expect((await tool.execute(context(), { nodes: [{ type: 'ai-image', label: '图片', videoFps: 24 }] })).status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('创建前拒绝把疑似凭据放进媒体参数，错误不回显原值', () => {
    const secret = 'sk-test-secret-fixture';
    const result = prepareAgentToolCall({ callId: 'unsafe', toolId: 'canvas_create_nodes', input: { nodes: [
      { type: 'ai-image', label: '图片', imageQuality: secret },
    ] } }, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.summary).not.toContain(secret);
    expect(useAppStore.getState().nodes).toHaveLength(2);
  });

  it('routes ready video bindings to the generated-video column and images to frame without replacing either reference', async () => {
    const frame = { nodeId: 'old-image', kind: 'image' as const, url: 'old.png' };
    useAppStore.setState({ nodes: [node('sheet', { type: 'ai-shotlist', shotlistRows: [{ id: 'r', shotNo: '1', frame, duration: 4 }] }),
      node('video', { type: 'source-video', videoUrl: 'ready.mp4', videoDuration: 8 }),
      node('image', { imageUrl: 'new.png' }), node('pending', { type: 'ai-video' })] });
    const tool = getAgentTool('canvas_bind_shotlist_frame')!;
    const bound = await tool.execute(context(), { shotlistId: 'sheet', rowId: 'r', sourceNodeId: 'video' });
    expect(bound.status).toBe('success');
    expect(JSON.parse(bound.modelContent)).toMatchObject({ target: 'video', reused: false, sourceNodeId: 'video' });
    expect(useAppStore.getState().nodes[0].data.shotlistRows![0]).toMatchObject({ frame, duration: 4,
      video: { nodeId: 'video', kind: 'video', url: 'ready.mp4' } });
    const revision = useAppStore.getState().getCurrentRevision();
    const repeated = await tool.execute(context(), { shotlistId: 'sheet', rowId: 'r', sourceNodeId: 'video' });
    expect(JSON.parse(repeated.modelContent)).toMatchObject({ target: 'video', reused: true, revision });
    const image = await tool.execute(context(), { shotlistId: 'sheet', rowId: 'r', sourceNodeId: 'image' });
    expect(image.status).toBe('success');
    expect(JSON.parse(image.modelContent).target).toBe('frame');
    expect(useAppStore.getState().nodes[0].data.shotlistRows![0]).toMatchObject({ frame: { nodeId: 'image' }, video: { nodeId: 'video' } });
    const pending = await tool.execute(context(), { shotlistId: 'sheet', rowId: 'r', sourceNodeId: 'pending' });
    expect(pending.status).toBe('error');
    expect(useAppStore.getState().nodes[0].data.shotlistRows![0].video?.nodeId).toBe('video');
    expect(useAppStore.getState().edges).toEqual([{ id: 'e1', source: 'n1', target: 'n2' }]);
  });

  it('MCP 冷查询、创建与更新可优先使用已存全局场景，且不要求先打开库', async () => {
    const global: DramaAsset = { id: 'global-scene', kind: 'scene', name: '全局街道', key: 'street', summary: '', visualNotes: '',
      importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1,
      imageUrl: useAppStore.getState().nodes[0].data.imageUrl };
    loadGlobalAssets.mockResolvedValue([global]);
    const mcp = { ...context(), conversationId: 'mcp-control-p1' };
    const queried = await getAgentTool('canvas_query')!.execute(mcp, { nodeIds: ['n1'], detail: true });
    expect(JSON.parse(queried.modelContent).nodes[0].preferredMention).toBe('@drama{global/global-scene:全局街道}');
    expect(useAppStore.getState().globalScenes).toEqual([]);
    expect((await getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [
      { type: 'ai-video', label: '镜头', prompt: '@{n1:场景} @{n2:剧本}' },
    ] })).status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.data.prompt).toBe('@drama{global/global-scene:全局街道} @{n2:剧本}');
    expect(useAppStore.getState().edges.filter((edge) => edge.target === created.id).map((edge) => edge.source)).toEqual(['n2']);
    await getAgentTool('canvas_update_nodes')!.execute(mcp, { nodeIds: [created.id], prompt: '@{n1:新引用}' });
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBe('@drama{global/global-scene:全局街道}');
  });

  it('全局目录读取失败仍可查询画布，并保留原节点引用与真实连线', async () => {
    loadGlobalAssets.mockRejectedValue(new Error('private-path-do-not-expose'));
    const mcp = { ...context(), conversationId: 'mcp-control-p1' };
    const queried = await getAgentTool('canvas_query')!.execute(mcp, { nodeIds: ['n1'], detail: true });
    expect(queried.status).toBe('success');
    expect(JSON.parse(queried.modelContent).nodes[0].preferredMention).toBeUndefined();
    expect(queried.modelContent).not.toContain('private-path');
    expect((await getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [
      { type: 'ai-video', label: '镜头', prompt: '@{n1:原节点}' },
    ] })).status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.data.prompt).toBe('@{n1:原节点}');
    expect(useAppStore.getState().edges.some((edge) => edge.target === created.id && edge.source === 'n1')).toBe(true);
  });

  it.each(['project', 'revision'] as const)('全局目录读取期间 %s 变化阻止旧 MCP 请求写入', async (change) => {
    let finish!: (assets: DramaAsset[]) => void;
    loadGlobalAssets.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const mcp = { ...context(), conversationId: 'mcp-control-p1' };
    const operation = getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [
      { type: 'ai-video', label: '旧请求', prompt: '@{n1:场景}' },
    ] });
    // 让动态 import 进入已登记的读取，随后才切换项目或画布版本。
    await vi.waitFor(() => expect(loadGlobalAssets).toHaveBeenCalledTimes(1));
    if (change === 'project') useAppStore.setState({ currentProjectId: 'p2' });
    else useAppStore.getState().incrementRevision();
    const nodes = useAppStore.getState().nodes;
    finish([]);
    await expect(operation).rejects.toThrow('项目或画布已变化');
    expect(useAppStore.getState().nodes).toBe(nodes);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('creates a video from a stable shot reference with one real sheet edge and respects explicit duration', async () => {
    useAppStore.setState({ projectLoadStatus: 'ready', nodes: [node('sheet', {
      type: 'ai-shotlist', label: '分镜', shotlistRows: [{ id: 'r', shotNo: '1', content: '她合上书', duration: 4.3 }],
    })], edges: [] });
    const tool = getAgentTool('canvas_create_nodes')!;
    expect((await tool.execute(context(), { nodes: [
      { type: 'ai-video', label: '跟随分镜', prompt: '@{sheet/shot/r:镜1}' },
      { type: 'ai-video', label: '手动时长', prompt: '@{sheet/shot/r:镜1}', videoDuration: 12 },
    ] })).status).toBe('success');
    const videos = useAppStore.getState().nodes.filter((item) => item.data.type === 'ai-video');
    expect(videos[0].data).toMatchObject({ prompt: '@{sheet/shot/r:镜1}', seedanceDuration: 5,
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'r', kind: 'video', durationSync: 'auto' } });
    expect(videos[1].data).toMatchObject({ seedanceDuration: 12, shotlistProductionSource: { durationSync: 'manual' } });
    expect(useAppStore.getState().edges.map((edge) => [edge.source, edge.target])).toEqual(videos.map((video) => ['sheet', video.id]));
    useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [{ id: 'r', shotNo: '1', content: '她合上书', duration: 8.1 }] });
    const current = useAppStore.getState().nodes.filter((item) => item.data.type === 'ai-video');
    expect(current.map((video) => video.data.seedanceDuration)).toEqual([9, 12]);
  });

  it('rejects a batch containing a deleted shot reference without writing partial nodes', async () => {
    useAppStore.setState({ nodes: [node('sheet', { type: 'ai-shotlist', shotlistRows: [{ id: 'r', shotNo: '1', content: '有效镜头' }] })], edges: [] });
    const before = useAppStore.getState().nodes;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-video', label: '有效镜头', prompt: '@{sheet/shot/r:镜1}' },
      { type: 'ai-video', label: '已删镜头', prompt: '@{sheet/shot/deleted:镜2}' },
    ] });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(before);
    expect(useAppStore.getState().edges).toEqual([]);
  });

  it('prefers exact library images in MCP prompts and avoids their automatic edges while preserving other dependencies', async () => {
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), props: [{
      id: 'prop-1', kind: 'prop', name: '茶壶', key: '茶壶', summary: '', visualNotes: '',
      importance: 'supporting', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1, imageNodeId: 'n1',
    }] } });
    const mcp = { ...context(), conversationId: 'mcp-control-p1' };
    const queried = await getAgentTool('canvas_query')!.execute(mcp, { nodeIds: ['n1'], detail: true });
    expect(JSON.parse(queried.modelContent).nodes[0].preferredMention).toBe('@drama{prop-1:茶壶}');
    const result = await getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [{
      type: 'ai-video', label: '镜头', prompt: 'Picture 1: @{n1:茶壶}\n说明 @{n2:剧本}',
    }] });
    expect(result.status).toBe('success');
    const video = useAppStore.getState().nodes.at(-1)!;
    expect(video.data.prompt).toBe('Picture 1: @drama{prop-1:茶壶}\n说明 @{n2:剧本}');
    expect(useAppStore.getState().edges.filter((edge) => edge.target === video.id).map((edge) => edge.source)).toEqual(['n2']);
    const update = await getAgentTool('canvas_update_nodes')!.execute(mcp, {
      nodeIds: [video.id], prompt: 'Picture 1: @{n1:旧节点名}',
    });
    expect(update.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBe('Picture 1: @drama{prop-1:茶壶}');
    const normal = await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: [video.id], prompt: '@{n1:显式节点}' });
    expect(normal.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBe('@{n1:显式节点}');
    await getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [{
      type: 'source-text', label: '定稿正文', prompt: '保留 @{n1:原始引用}',
    }] });
    expect(useAppStore.getState().nodes.at(-1)?.data.output).toBe('保留 @{n1:原始引用}');
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it.each(['scene', 'prop', 'character'] as const)('links new %s reference images to an existing project asset before generation', async (kind) => {
    const asset = { id: 'asset-1', kind, name: '参考资产', key: '参考资产', summary: '', visualNotes: '',
      importance: 'supporting' as const, confirmed: true, source: 'manual' as const, createdAt: 1, updatedAt: 1, identity: '' };
    useAppStore.getState().upsertDramaAsset(asset as DramaAsset);
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [{
      type: 'ai-image', label: '参考图', prompt: '纯色背景参考图', dramaAssetId: asset.id,
    }] });
    expect(result.status).toBe('success');
    const image = useAppStore.getState().nodes.at(-1)!;
    expect(image.data).toMatchObject({ dramaAssetId: asset.id, dramaAssetKind: kind, status: 'idle' });
    useAppStore.getState().updateNodeDataTransient(image.id, { imageUrl: 'generated.png', status: 'success' });
    useAppStore.getState().syncDramaAssetImageFromNode(image.id, 'generated.png');
    const library = useAppStore.getState().dramaAssets;
    expect([...library.characters, ...library.scenes, ...library.props][0]).toMatchObject({ imageNodeId: image.id, imageUrl: 'generated.png' });
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('rejects invalid asset links before writing any nodes in a batch', async () => {
    const before = useAppStore.getState().nodes;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '正常图片' },
      { type: 'ai-image', label: '无效绑定', dramaAssetId: 'missing' },
    ] });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('keeps canvas queries usable when an imported AI application is malformed', async () => {
    useAppStore.setState({ nodes: [
      ...useAppStore.getState().nodes,
      node('broken-app', { type: 'ai-app', aiApp: {} as BaseNodeData['aiApp'] }),
    ] });
    const result = await getAgentTool('canvas_query')!.execute(context(), { detail: true });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent).nodes.find((item: { id: string }) => item.id === 'broken-app'))
      .toMatchObject({ aiApp: { unavailable: true } });
  });

  it('connects the shotlist and per-shot briefs into downstream directors', async () => {
    registerShotlistAgentTools();
    useAppStore.setState({ projectLoadStatus: 'ready' });
    const created = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-shotlist', label: '雨夜分镜', prompt: '雨夜车站重逢', x: 1000, y: 1000 },
    ] });
    expect(created.status).toBe('success');
    const sheetId = JSON.parse(created.modelContent).nodes[0].id;
    const edited = await getAgentTool('shotlist_update_rows')!.execute(context(), {
      nodeId: sheetId, mode: 'append', rows: [
        { content: '旅人走入车站', duration: 5 },
        { content: '两人重逢', duration: 7 },
      ],
    });
    expect(edited.status).toBe('success');
    const rowIds = useAppStore.getState().nodes.find((item) => item.id === sheetId)!.data.shotlistRows!.map((row) => row.id);
    const prepared = await getAgentTool('shotlist_prepare_production')!.execute(context(), {
      nodeId: sheetId, rowIds, kind: 'director',
    });
    expect(prepared.status).toBe('success');
    const state = useAppStore.getState();
    const directors = state.nodes.filter((item) => item.type === 'ai-director');
    expect(directors).toHaveLength(2);
    for (const director of directors) {
      expect(state.edges).toContainEqual(expect.objectContaining({
        source: sheetId, target: director.id, sourceHandle: 'right', targetHandle: 'left',
      }));
      const incoming = state.edges.filter((edge) => edge.target === director.id);
      expect(incoming).toHaveLength(2);
      const brief = state.nodes.find((item) => item.id === incoming.find((edge) => edge.source !== sheetId)!.source)!;
      expect(brief.type).toBe('source-text');
      expect(brief.position.x + brief.data.nodeWidth!).toBeLessThanOrEqual(director.position.x - 80);
      expect(director.data.shotlistProductionSource?.nodeId).toBe(sheetId);
    }
    expect(state.edges.some((edge) => edge.target === sheetId && directors.some((director) => director.id === edge.source))).toBe(false);
    expect(state.nodes.find((item) => item.id === sheetId)!.data.prompt).toBe('雨夜车站重逢');
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('creates wider shotlists and keeps mixed batches apart', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-shotlist', label: '雨夜分镜' },
      { type: 'ai-text', label: '镜头说明', content: '蓝衣旅人走向等候者。' },
      { type: 'ai-shotlist', label: '重逢分镜' },
      { type: 'ai-shotlist', label: '下一行分镜' },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    for (const sheet of created.filter((item) => item.type === 'ai-shotlist')) {
      expect(sheet.data).toMatchObject({ nodeWidth: 1920, nodeHeight: 640 });
    }
    const read = await getAgentTool('canvas_query')!.execute(context(), {
      nodeIds: created.map((item) => item.id), detail: true,
    });
    const reported = JSON.parse(read.modelContent).nodes;
    expect(reported[0].size).toEqual({ width: 1920, height: 640 });
    for (const [index, item] of created.entries()) {
      for (const other of created.slice(index + 1)) {
        const separated = item.position.x + item.data.nodeWidth! <= other.position.x
          || other.position.x + other.data.nodeWidth! <= item.position.x
          || item.position.y + item.data.nodeHeight! <= other.position.y
          || other.position.y + other.data.nodeHeight! <= item.position.y;
        expect(separated).toBe(true);
      }
    }
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('keeps mixed batches compact without letting a large node enlarge every column and row', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-text', label: '说明一' },
      { type: 'ai-image', label: '方图', aspectRatio: '1:1' },
      { type: 'ai-text', label: '说明二' },
      { type: 'ai-shotlist', label: '大分镜表' },
      { type: 'ai-text', label: '说明三' },
      { type: 'ai-text', label: '说明四' },
      { type: 'ai-text', label: '说明五' },
      { type: 'ai-text', label: '说明六' },
      { type: 'ai-text', label: '说明七' },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    // 大表位于第一列、第二行，不能影响第二列的宽度与第一行的高度。
    expect(created[2].position.x - (created[1].position.x + created[1].data.nodeWidth!)).toBe(48);
    expect(created[3].position.y - (created[1].position.y + created[1].data.nodeHeight!)).toBe(40);
    expect(created[6].position.y - (created[3].position.y + created[3].data.nodeHeight!)).toBe(40);
    const right = Math.max(...created.map((item) => item.position.x + item.data.nodeWidth!));
    const left = Math.min(...created.map((item) => item.position.x));
    // 分镜表加宽 640，其他普通列仍保持紧凑，不能全部跟随大表宽度。
    expect(right - left).toBeLessThan(2640);
    expect(created[3].data).toMatchObject({ nodeWidth: 1920, nodeHeight: 640 });
  });

  it.each(['assistant', 'mcp'] as const)('anchors %s creation beside actual prompt dependencies instead of distant unrelated nodes', async (channel) => {
    const existing = [
      node('source', { type: 'source-image', nodeWidth: 280, nodeHeight: 160 }),
      node('far', {}, { x: 30_000, y: 10_000 }),
    ];
    useAppStore.setState({ nodes: existing, edges: [] });
    const ctx = { ...context(), ...(channel === 'mcp' ? { conversationId: 'mcp-control-p1' } : {}) };
    const result = await getAgentTool('canvas_create_nodes')!.execute(ctx, { nodes: [
      { type: 'ai-image', label: '参考图变体', prompt: '依据 @{source:参考图} 调整构图' },
    ] });
    expect(result.status).toBe('success');
    const state = useAppStore.getState();
    const created = state.nodes.at(-1)!;
    expect(created.position.x - (existing[0].position.x + existing[0].data.nodeWidth!)).toBe(48);
    expect(created.position.y).toBe(100);
    expect(state.nodes.slice(0, 2).map((item) => item.position)).toEqual(existing.map((item) => item.position));
    expect(state.edges).toContainEqual(expect.objectContaining({ source: 'source', target: created.id }));
    expect(state.history).toHaveLength(1);
  });

  it('uses nearby vertical space when the dependency column is occupied', async () => {
    useAppStore.setState({ nodes: [
      node('source', { type: 'source-image', nodeWidth: 280, nodeHeight: 160 }),
      node('occupied', { nodeWidth: 280, nodeHeight: 160 }, { x: 428, y: 100 }),
      node('far', {}, { x: 30_000, y: 10_000 }),
    ], edges: [] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '相邻变体', prompt: '@{source:参考图}' },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.position.x).toBe(428);
    expect(Math.abs(created.position.y - 100)).toBe(200);
    const below = created.position.y >= 100 + 160 + 40;
    const above = created.position.y + created.data.nodeHeight! <= 100 - 40;
    expect(below || above).toBe(true);
  });

  it('preserves explicit positions and avoids them while placing automatic nodes in the same batch', async () => {
    useAppStore.setState({ nodes: [node('source', { type: 'source-image', nodeWidth: 280, nodeHeight: 160 })], edges: [] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '指定坐标', x: 428, y: 100 },
      { type: 'ai-image', label: '自动坐标', prompt: '@{source:参考图}' },
    ] });
    expect(result.status).toBe('success');
    const [fixed, automatic] = useAppStore.getState().nodes.slice(1);
    expect(fixed.position).toEqual({ x: 428, y: 100 });
    expect(automatic.position.x).toBe(fixed.position.x);
    expect(Math.abs(automatic.position.y - fixed.position.y)).toBe(200);
  });

  it('preserves a single explicit axis while avoiding obstacles on that actual axis', async () => {
    useAppStore.setState({ nodes: [node('source', { nodeWidth: 280, nodeHeight: 160 })], edges: [] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '固定横坐标', x: 100 },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.position.x).toBe(100);
    expect(Math.abs(created.position.y - 100)).toBe(200);
  });

  it('rejects conflicting partial coordinates before creating overlapping nodes', async () => {
    const before = useAppStore.getState().nodes;
    await expect(getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '同列一', x: 100 },
      { type: 'ai-image', label: '同列二', x: 100 },
    ] })).rejects.toThrow('无法在保留指定坐标的同时避免节点重叠');
    expect(useAppStore.getState().nodes).toEqual(before);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('creates image, video and audio nodes with explicit generation settings and reads them back', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '竖屏分镜', prompt: '小满在酒馆门口', aspectRatio: '9:16', imageSize: '2K', batchCount: 2 },
      { type: 'ai-video', label: '镜头', prompt: '小满回头', aspectRatio: '9:16', videoLongSide: 832, videoDuration: 8.1 },
      { type: 'ai-audio', label: '旁白', prompt: '请进来', audioPurpose: 'speech', audioFormat: 'flac',
        audioSpeechSettings: { voiceStyle: 'girl', pace: 2, duration: 9 } },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    expect(created[0].data).toMatchObject({ aspectRatio: '9:16', imageSize: '2K', batchCount: 2 });
    expect(created[1].data).toMatchObject({ seedanceRatio: '9:16', videoResolution: 832, seedanceDuration: 9 });
    expect(created[2].data).toMatchObject({ audioPurpose: 'speech', audioFormat: 'flac',
      audioSpeechSettings: { voiceStyle: 'girl', pace: 2, duration: 9 } });
    const read = await getAgentTool('canvas_query')!.execute(context(), {
      nodeIds: created.map((item) => item.id), detail: true,
    });
    expect(JSON.parse(read.modelContent).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ imageSize: '2K', batchCount: 2 }),
      expect.objectContaining({ videoResolution: '832', videoLongSide: 832, videoDuration: 9 }),
      expect.objectContaining({ audioPurpose: 'speech', audioFormat: 'flac',
        audioSpeechSettings: { voiceStyle: 'girl', pace: 2, duration: 9 } }),
    ]));
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('maps legacy numeric resolution to the local long side and keeps API quality presets separate', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-video', label: '旧客户端长边', videoResolution: '832' },
      { type: 'ai-video', label: 'API 档位', videoResolution: '720p' },
    ] });
    expect(result.status).toBe('success');
    const [local, api] = useAppStore.getState().nodes.slice(2);
    expect(local.data).toMatchObject({ videoResolution: 832 });
    expect(local.data.seedanceResolution).not.toBe('832');
    expect(api.data).toMatchObject({ seedanceResolution: '720p' });
    const update = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: [api.id], videoLongSide: 640,
    });
    expect(update.status).toBe('success');
    expect(useAppStore.getState().nodes.find((node) => node.id === api.id)?.data.videoResolution).toBe(640);
  });

  it('rejects a mixed invalid media batch without creating any nodes', async () => {
    const before = useAppStore.getState().nodes;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '有效图片', imageSize: '2K' },
      { type: 'ai-audio', label: '错误音频', videoResolution: '832' },
    ] });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('只能用于视频节点');
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('keeps explicit image controls on an empty-prompt node despite project defaults', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { imageAspectRatio: '16:9', imageSize: '1K' } } }] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '待写提示词的竖屏图', aspectRatio: '9:16', imageSize: '2K' },
    ] });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({ aspectRatio: '9:16', imageSize: '2K' });
  });

  it('rejects an unconfigured model before creating any nodes', async () => {
    const before = useAppStore.getState().nodes;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '有效图片' },
      { type: 'ai-video', label: '无效模型', model: 'unknown/workflow' },
    ] });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('未配置');
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('updates audio settings but rejects applying them to images', async () => {
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes,
      node('audio1', { type: 'ai-audio' }, { x: 800, y: 100 })] });
    const update = getAgentTool('canvas_update_nodes')!;
    const result = await update.execute(context(), { nodeIds: ['audio1'], audioPurpose: 'music',
      musicDuration: 90, musicBpm: 120, autoGenerateLyrics: false });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'audio1')?.data).toMatchObject({
      audioPurpose: 'music', musicDuration: 90, musicBpm: 120, autoGenerateLyrics: false,
    });
    const beforeImage = useAppStore.getState().nodes[0].data;
    const invalid = await update.execute(context(), { nodeIds: ['n1'], musicDuration: 90 });
    expect(invalid.status).toBe('error');
    expect(useAppStore.getState().nodes[0].data).toBe(beforeImage);
  });

  it('creates and updates a configured general voice ID and MP3 without resetting its model', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, 'libapi-voice': { name: 'LibAPI', catalogId: 'libapi',
        apiKey: 'fixture', baseUrl: 'https://libapi.cc/v1' } },
      generalModels: [{ id: 'libapi-voice', name: 'LibAPI TTS', modelId: 'speech-2.8',
        category: 'audio', providerConfigId: 'libapi-voice' }],
    } }));
    const create = getAgentTool('canvas_create_nodes')!;
    const input = { nodes: [{ type: 'ai-audio', label: '旁白', model: 'general/libapi-voice',
      audioPurpose: 'speech', audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25 }] };
    expect(validateAgentToolInput(create.inputSchema, input).valid).toBe(true);
    expect((await create.execute(context(), input)).status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.data).toMatchObject({ model: 'general/libapi-voice', provider: 'general',
      audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25 });

    const update = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: [created.id], audioVoice: 'user_cloned_voice_02', audioSpeed: 0.8,
    });
    expect(update.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({ model: 'general/libapi-voice',
      audioVoice: 'user_cloned_voice_02', audioFormat: 'mp3', audioSpeed: 0.8 });
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('rejects unsafe voice IDs and keeps the existing voice restriction for other providers', async () => {
    useAppStore.setState({ nodes: [node('legacy-audio', { type: 'ai-audio', provider: 'apimart',
      model: 'apimart/gpt-4o-mini-tts', audioVoice: 'alloy' })] });
    const update = getAgentTool('canvas_update_nodes')!;
    const before = useAppStore.getState().nodes;
    for (const audioVoice of ['Zephyr', 'voice\nID', 'voice\u0085ID', 'x'.repeat(257)]) {
      expect((await update.execute(context(), { nodeIds: ['legacy-audio'], audioVoice })).status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(before);
    }
  });

  it('keeps title and lyrics on audio placeholders so later node generation uses the same settings', () => {
    const intent = { kind: 'audio' as const, prompt: '轻柔民谣', modelRef: 'general/music-model', deliveryMode: 'both' as const,
      audioPurpose: 'music' as const, musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走' };
    const id = useAppStore.getState().createMediaPlaceholder(intent, { x: 1000, y: 100 });
    expect(useAppStore.getState().nodes.find((item) => item.id === id)?.data).toMatchObject({
      type: 'ai-audio', model: 'general/music-model', audioPurpose: 'music',
      musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走',
    });
  });

  it('导入分镜小数秒写入实际视频时长，并优先于项目默认值', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoDuration: 5 } } }] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-video', label: '镜1', videoDuration: 8.1 },
      { type: 'ai-video', label: '镜2', videoDuration: 4 },
      { type: 'ai-video', label: '镜3' },
    ] });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.slice(2).map((n) => n.data.seedanceDuration)).toEqual([9, 4, 5]);
    const read = await getAgentTool('canvas_query')!.execute(context(), { nodeType: 'ai-video', detail: true });
    expect(JSON.parse(read.modelContent).nodes.map((n: { videoDuration: number }) => n.videoDuration)).toEqual([9, 4, 5]);
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('无效分镜秒数或非视频字段拒绝整个导入批次', async () => {
    const before = useAppStore.getState().nodes;
    for (const invalid of [0, -1, NaN, Infinity, 3600.1]) {
      const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
        { type: 'ai-video', label: '有效', videoDuration: 8.1 },
        { type: 'ai-video', label: '无效', videoDuration: invalid },
      ] });
      expect(result.status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(before);
    }
    expect((await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-image', label: '图片', videoDuration: 5 }],
    })).status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(before);
  });
  it('renames visible media titles and text labels with one history snapshot', async () => {
    const media = node('n1', {
      type: 'source-image', fileName: 'mcp-upload-original.png',
      filePath: 'D:/data/original.png', imageUrl: 'asset://localhost/D:/data/original.png',
      prompt: '保留角色提示词',
    });
    useAppStore.setState({ nodes: [media, useAppStore.getState().nodes[1]] });
    const beforeNodes = useAppStore.getState().nodes;
    const beforeEdges = useAppStore.getState().edges;
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1', 'n2'], label: '  角色｜小满｜白底全身  ',
    });
    expect(result.status).toBe('success');
    const [renamedMedia, renamedText] = useAppStore.getState().nodes;
    expect(renamedMedia.data).toEqual({
      ...media.data, label: '角色｜小满｜白底全身', fileName: '角色｜小满｜白底全身',
    });
    expect(renamedText.data.label).toBe('角色｜小满｜白底全身');
    expect(renamedText.data.fileName).toBeUndefined();
    expect(useAppStore.getState().edges).toEqual(beforeEdges);
    const queried = await getAgentTool('canvas_query')!.execute(context(), { detail: true });
    expect(JSON.parse(queried.modelContent).nodes.map((item: { displayLabel: string }) => item.displayLabel))
      .toEqual(['角色｜小满｜白底全身', '角色｜小满｜白底全身']);
    expect(queried.modelContent).not.toContain('D:/data');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().history[0].nodes).toEqual(beforeNodes);
  });

  it('preserves a media display alias when editing only its prompt', async () => {
    useAppStore.setState({ nodes: [node('n1', { fileName: 'original.png' })] });
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1'], prompt: 'new prompt',
    });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[0].data.fileName).toBe('original.png');
  });

  it('registers advanced canvas operations with closed schemas', () => {
    const ids = [
      'canvas_duplicate_node',
      'canvas_update_note',
      'canvas_move_note_layer',
      'canvas_convert_image_kind',
      'canvas_rename_group',
      'canvas_fill_storyboard_cell',
      'canvas_bind_shotlist_frame',
    ];
    for (const id of ids) {
      expect(getAgentTool(id), id).toMatchObject({ effect: 'canvas_write' });
      expect(getAgentTool(id)?.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('duplicates a node and converts an unconnected image into a canvas note', async () => {
    const duplicated = await getAgentTool('canvas_duplicate_node')!.execute(context(), { nodeId: 'n1' });
    expect(duplicated.status).toBe('success');
    expect(useAppStore.getState().nodes).toHaveLength(3);

    useAppStore.setState({ edges: [] });
    const converted = await getAgentTool('canvas_convert_image_kind')!.execute({
      ...context(),
      baseRevision: useAppStore.getState().getCurrentRevision(),
    }, { nodeId: 'n1' });
    expect(converted.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'n1')?.type).toBe('canvas-note');
  });

  it('describes requested and actual details for created nodes', async () => {
    const definition = getAgentTool('canvas_create_nodes')!;
    const input = {
      nodes: [{
        type: 'ai-video',
        label: '开场镜头',
        prompt: '夜晚城市航拍',
        x: 320,
        y: 180,
      }],
    };

    expect(definition.buildInputDisplay?.(input, context())).toMatchObject({
      entities: [{
        title: '开场镜头',
        fields: [
          { label: '类型', value: 'ai-video' },
          { label: '位置', value: '(320, 180)', source: 'user' },
        ],
        preview: '夜晚城市航拍',
      }],
    });

    const result = await definition.execute(context(), input);
    expect(result.display).toMatchObject({
      entities: [{
        title: '开场镜头',
        fields: [
          { label: '类型', value: 'ai-video' },
          { label: '位置', value: '(320, 180)', source: 'resolved' },
        ],
      }],
    });
  });

  it('sizes created nodes from aspect ratio and text length instead of one fixed box', async () => {
    const script = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [
        { type: 'ai-image', label: '角色·林默', prompt: '冷白皮肤，及肩黑发', aspectRatio: '3:4' },
        { type: 'ai-video', label: '场景·雨夜街道', prompt: '霓虹倒影', aspectRatio: '16:9' },
        { type: 'source-text', label: '剧本 第一集全文', prompt: script },
        { type: 'ai-text', label: '分镜文案', prompt: '拆解为镜头表' },
      ],
    });

    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    expect(created.map((item) => item.data.nodeHeight)).toEqual([
      372, // 3:4 竖构图撑高
      158, // 视频框按实际 16:9 比例计算，不套图片框的边框和最小高度
      600, // 30 行正文按行数撑高，封顶 600
      160, // 还没有正文的生成型文本节点保持默认
    ]);
    expect(created[0].data.aspectRatio).toBe('3:4');
    // 比例只对视觉节点有意义，文本节点不该被塞上 aspectRatio
    expect(created[2].data.aspectRatio).toBeUndefined();
  });

  it('sets the actual video ratio on creation and update, including mixed node batches', async () => {
    const created = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-video', label: '竖屏镜头', prompt: '参考 @{n1:分镜图}', aspectRatio: '9:16' }],
    });
    expect(created.status).toBe('success');
    const video = useAppStore.getState().nodes.at(-1)!;
    expect(video.data).toMatchObject({ aspectRatio: '9:16', seedanceRatio: '9:16' });
    expect(useAppStore.getState().edges.some((edge) => edge.source === 'n1' && edge.target === video.id)).toBe(true);

    useAppStore.getState().updateNodeDataTransient(video.id, { seedanceRatio: '16:9' });
    const queriedBefore = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [video.id], detail: true });
    expect(JSON.parse(queriedBefore.modelContent).nodes[0].aspectRatio).toBe('16:9');
    useAppStore.getState().updateNodeDataTransient(video.id, { seedanceRatio: undefined });
    const legacy = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [video.id], detail: true });
    expect(JSON.parse(legacy.modelContent).nodes[0].aspectRatio).toBeUndefined();

    const updated = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: [video.id, 'n1'], aspectRatio: '9:16',
    });
    expect(updated.status).toBe('success');
    const nodes = useAppStore.getState().nodes;
    expect(nodes.find((item) => item.id === video.id)?.data).toMatchObject({
      aspectRatio: '9:16', seedanceRatio: '9:16',
    });
    expect(nodes.find((item) => item.id === 'n1')?.data.seedanceRatio).toBeUndefined();
    const queriedAfter = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [video.id], detail: true });
    expect(JSON.parse(queriedAfter.modelContent).nodes[0].aspectRatio).toBe('9:16');
  });

  it.each([
    ['16:9', 158], ['9:16', 498], ['1:1', 280], ['4:3', 210], ['3:4', 373], ['21:9', 120],
  ])('creates %s video frames with matching generation controls despite project defaults', async (aspectRatio, height) => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoAspectRatio: '1:1' } } }] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-video', label: '空视频', aspectRatio }],
    });
    expect(result.status).toBe('success');
    const video = useAppStore.getState().nodes.at(-1)!;
    expect(video.data).toMatchObject({ aspectRatio, seedanceRatio: aspectRatio, nodeWidth: 280, nodeHeight: height });
    const queried = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [video.id], detail: true });
    expect(JSON.parse(queried.modelContent).nodes[0]).toMatchObject({ aspectRatio, size: { width: 280, height } });
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('lays out inherited portrait video frames using their final size', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoAspectRatio: '9:16' } } }] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: Array.from({ length: 4 }, (_, index) => ({ type: 'ai-video', label: `镜头${index}` })),
    });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    for (const video of created) {
      expect(video.data).toMatchObject({ aspectRatio: '9:16', seedanceRatio: '9:16', nodeWidth: 280, nodeHeight: 498 });
    }
    expect(created[3].position.y).toBeGreaterThan(created[0].position.y + created[0].data.nodeHeight!);
  });

  it('repairs legacy video frames on MCP ratio updates and shares the linkage with UI parameter writes', async () => {
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes,
      node('legacy-video', { type: 'ai-video', aspectRatio: '1:1', seedanceRatio: '16:9', nodeWidth: 420, nodeHeight: 420 }),
    ] });
    const updated = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['legacy-video', 'n1'], aspectRatio: '16:9',
    });
    expect(updated.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'legacy-video')?.data).toMatchObject({
      aspectRatio: '16:9', seedanceRatio: '16:9', nodeWidth: 420, nodeHeight: 236,
    });
    expect(useAppStore.getState().nodes[0].data.seedanceRatio).toBeUndefined();
    useAppStore.getState().updateNodeData('legacy-video', { seedanceRatio: '9:16' });
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({
      aspectRatio: '9:16', seedanceRatio: '9:16', nodeWidth: 420, nodeHeight: 747,
    });
    // 手动缩放或仅改提示词不能被比例联动反复覆盖。
    useAppStore.getState().updateNodeDataTransient('legacy-video', { nodeHeight: 500 });
    useAppStore.getState().updateNodesDataBatch(['legacy-video'], { prompt: '新提示词' });
    expect(useAppStore.getState().nodes.at(-1)?.data.nodeHeight).toBe(500);
    const resized = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['legacy-video'], width: 560, height: 560, aspectRatio: '16:9',
    });
    expect(resized.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({ nodeWidth: 560, nodeHeight: 315 });
  });

  it('does not infer an adaptive frame or resize produced and imported videos', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoAspectRatio: '1:1' } } }] });
    await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-video', label: '自适应', aspectRatio: 'adaptive' }],
    });
    const adaptive = useAppStore.getState().nodes.at(-1)!;
    expect(adaptive.data).toMatchObject({ seedanceRatio: 'adaptive', nodeWidth: 280, nodeHeight: 160 });
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes,
      node('produced', { type: 'ai-video', videoUrl: 'asset://localhost/movie.mp4', nodeWidth: 320, nodeHeight: 180 }),
      node('imported', { type: 'ai-video', role: 'source', nodeWidth: 180, nodeHeight: 320 }),
    ] });
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: [adaptive.id, 'produced', 'imported'], aspectRatio: '9:16',
    });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === adaptive.id)?.data.nodeHeight).toBe(498);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'produced')?.data).toMatchObject({ nodeWidth: 320, nodeHeight: 180 });
    expect(useAppStore.getState().nodes.find((item) => item.id === 'imported')?.data).toMatchObject({ nodeWidth: 180, nodeHeight: 320 });
    await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: [adaptive.id], aspectRatio: 'adaptive' });
    expect(useAppStore.getState().nodes.find((item) => item.id === adaptive.id)?.data.nodeHeight).toBe(498);
  });

  it('puts finished text in the node body and generation instructions in the prompt', async () => {
    const script = '场景一：剧本正文\n场景二：更多正文';
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [
        { type: 'ai-text', label: '剧本·第一集全文', content: script },
        { type: 'ai-text', label: '分镜文案', prompt: '把这集拆成镜头表' },
      ],
    });

    expect(result.status).toBe('success');
    const [body, generator] = useAppStore.getState().nodes.slice(2);
    // 定稿正文进节点正文，建完就能看见，也能被下游 @ 引用
    expect(body.data).toMatchObject({ output: script, role: 'source', status: 'success' });
    expect(body.data.prompt).toBeUndefined();
    // 生成指令仍然只进提示词，节点正文留空等用户点生成
    expect(generator.data).toMatchObject({ prompt: '把这集拆成镜头表', role: 'generator', status: 'idle' });
    expect(generator.data.output).toBeUndefined();
  });

  it('materializes prompt mentions as de-duplicated edges in the same history entry', async () => {
    useAppStore.setState({
      nodes: [
        ...useAppStore.getState().nodes,
        node('grid', { type: 'ai-storyboard', label: '分镜宫格' }, { x: 800, y: 100 }),
      ],
    });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [
        {
          type: 'ai-image',
          label: '合成画面',
          prompt: '参考 @{n1:主图}，再次参考 @{n1:主图副本}，并使用 @{grid/cell/2:第三格}',
        },
        {
          type: 'ai-text',
          label: '改写结果',
          prompt: '根据 @{n2:剧本正文} 改写',
        },
        {
          type: 'source-text',
          label: '引用说明',
          content: '正文中提到 @{n1:主图}，但它不是生成依赖',
        },
      ],
    });

    expect(result.status).toBe('success');
    expect(result.summary).toContain('自动连接 3 条引用');
    const created = useAppStore.getState().nodes.slice(3);
    const addedEdges = useAppStore.getState().edges.slice(1);
    expect(addedEdges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    }))).toEqual([
      { source: 'n1', target: created[0].id, sourceHandle: 'right', targetHandle: 'left' },
      { source: 'grid', target: created[0].id, sourceHandle: 'right', targetHandle: 'left' },
      { source: 'n2', target: created[1].id, sourceHandle: 'right', targetHandle: 'left' },
    ]);
    expect(JSON.parse(result.modelContent).edges).toEqual(addedEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })));

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2', 'grid']);
    expect(useAppStore.getState().edges.map((edge) => edge.id)).toEqual(['e1']);
  });

  it('rejects missing prompt references before creating any nodes or edges', async () => {
    const beforeNodes = useAppStore.getState().nodes;
    const beforeEdges = useAppStore.getState().edges;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{
        type: 'ai-image',
        label: '坏引用节点',
        prompt: '使用 @{missing-node:已删除节点} 作为参考',
      }],
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('missing-node');
    expect(useAppStore.getState().nodes).toBe(beforeNodes);
    expect(useAppStore.getState().edges).toBe(beforeEdges);
  });

  it('refuses to write content into media nodes whose output holds a path', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-image', label: '角色·林默', content: '不该写进图片节点' }],
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('content 只能用于文本类节点');
    expect(useAppStore.getState().nodes).toHaveLength(2);
  });

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
