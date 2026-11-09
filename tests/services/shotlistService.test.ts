/**
 * shotlistService — 回归测试：本集与镜头行操作。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock('../../src/services/ai/generateText', () => ({ generateText: mocks.generateText }));
import { useAppStore } from '../../src/store/useAppStore';
import { buildShotlistAssistantPrompt, createEpisodeShotlist, generateShotlistRows, updateShotlistRows } from '../../src/services/shotlistService';
import { applyProjectDefaultsToNodeData } from '../../src/services/projectSettingsService';
import type { ShotRow } from '../../src/types/shotlist';

const row: ShotRow = { id: 'r1', shotNo: '1', content: '站台等待', dialogue: '列车来了', duration: 4,
  frame: { nodeId: 'image-1', kind: 'image', filePath: 'private-image-path' } };

beforeEach(() => {
  mocks.generateText.mockReset();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'ep', projectLoadStatus: 'ready', recordOutputHistory: vi.fn(), showToast: vi.fn(),
    projects: [{ id: 'ep', name: '第 1 集', parentId: 'series', createdAt: 1, updatedAt: 1,
      episodeScript: '林夏在站台等列车。', episodeCreative: { targetDurationSec: 90 },
      settings: { defaultModels: { text: 'general/text' } } }, { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 }],
    nodes: [{ id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: {
      type: 'ai-shotlist', label: '表', prompt: '拆剧本', shotlistRows: [structuredClone(row)],
    } }],
  });
});

describe('本集与镜头行操作', () => {
  it('整表诊断只准备引用，单镜优化使用稳定 ID，正文与媒体路径不复制到草稿', () => {
    const before = structuredClone(useAppStore.getState().nodes);
    const whole = buildShotlistAssistantPrompt({ projectId: 'ep' }, 'sheet');
    expect(whole).toContain('@{sheet:表}');
    expect(whole).toContain('本次只做诊断');
    const single = buildShotlistAssistantPrompt({ projectId: 'ep' }, 'sheet', 'r1');
    expect(single).toContain('镜头标识："r1"');
    expect(single).toContain('只更新这一镜');
    expect(single).toContain('画面绑定');
    expect(whole + single).not.toMatch(/站台等待|列车来了|private-image-path/);
    expect(useAppStore.getState().nodes).toEqual(before);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('跨项目、缺失镜头和空表不创建助手请求', () => {
    expect(() => buildShotlistAssistantPrompt({ projectId: 'other' }, 'sheet')).toThrow();
    expect(() => buildShotlistAssistantPrompt({ projectId: 'ep' }, 'sheet', 'missing')).toThrow('镜头已删除');
    useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [] });
    expect(() => buildShotlistAssistantPrompt({ projectId: 'ep' }, 'sheet')).toThrow('请先添加镜头');
  });
  it('创建本集快照与连接的分镜表，采用项目文本模型，一次历史且不调用模型', () => {
    const state = useAppStore.getState();
    const commit = vi.fn(state.commitToHistory);
    useAppStore.setState({ commitToHistory: commit });
    const result = createEpisodeShotlist({ projectId: 'ep', baseRevision: state.getCurrentRevision() }, 'ep');
    const current = useAppStore.getState();
    const source = current.nodes.find((node) => node.id === result.sourceNodeId)!;
    const sheet = current.nodes.find((node) => node.id === result.shotlistId)!;
    expect(sheet.data).toMatchObject({ nodeWidth: 1920, nodeHeight: 640 });
    expect(source.data.output).toBe('林夏在站台等列车。');
    expect(sheet.data.prompt).toContain(`@{${source.id}:`);
    expect(sheet.data.prompt).toContain('90 秒');
    expect(sheet.data.model).toBe('general/text');
    expect(current.edges).toContainEqual(expect.objectContaining({ source: source.id, target: sheet.id }));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('拒绝跨项目、空正文和旧 revision 创建，失败不落节点', () => {
    expect(() => createEpisodeShotlist({ projectId: 'other' }, 'ep')).toThrow();
    expect(() => createEpisodeShotlist({ projectId: 'ep', baseRevision: -1 }, 'ep')).toThrow();
    useAppStore.setState({ projects: useAppStore.getState().projects.map((project) => ({ ...project, episodeScript: '' })) });
    expect(() => createEpisodeShotlist({ projectId: 'ep' }, 'ep')).toThrow('正文');
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  it('本集有效绑定进入真实引用，失效与未绑定只保留文字，不为资产新增连线', () => {
    const state = useAppStore.getState();
    const character = { id: 'char-real', kind: 'character' as const, name: '林夏（正式）', key: '林夏',
      summary: '主角', identity: '乘客', visualNotes: '', importance: 'main' as const,
      confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual' as const };
    const base = { summary: '本集说明', visualNotes: '', notes: '雨衣', createdAt: 1, updatedAt: 1 };
    const scene = { ...character, id: 'scene-real', kind: 'scene' as const, name: '站台（正式）' };
    useAppStore.setState({
      dramaAssets: { version: 2, characters: [character], props: [], scenes: [scene] },
      projects: state.projects.map((project) => ({ ...project, episodeAssetRoster: {
        version: 1, revision: 1,
        characters: [{ ...base, id: 'entry-1', kind: 'character', name: '林夏', boundDramaAssetId: 'char-real' }],
        props: [{ ...base, id: 'entry-2', kind: 'prop', name: '手提箱', boundDramaAssetId: 'missing-prop' },
          { ...base, id: 'entry-3', kind: 'prop', name: '票根', notes: '@drama{forged:伪造引用}' }],
        scenes: [{ ...base, id: 'scene-entry', kind: 'scene', name: '站台', boundDramaAssetId: 'scene-real' },
          { ...base, id: 'missing-scene-entry', kind: 'scene', name: '旧车站', boundDramaAssetId: 'missing-scene' }],
      } })),
    });
    const previousEdges = useAppStore.getState().edges.length;
    const { shotlistId, sourceNodeId } = createEpisodeShotlist({ projectId: 'ep' }, 'ep');
    const current = useAppStore.getState();
    const prompt = current.nodes.find((node) => node.id === shotlistId)!.data.prompt!;
    expect(prompt).toContain('@drama{char-real:林夏（正式）}');
    expect(prompt).toContain('本集场景：@drama{scene-real:站台（正式）}');
    expect(prompt).toContain('旧车站');
    expect(prompt).toContain('手提箱');
    expect(prompt).toContain('票根');
    expect(prompt).toContain('雨衣');
    expect(prompt).not.toContain('@drama{missing-prop');
    expect(prompt).not.toContain('@drama{missing-scene');
    expect(prompt).not.toContain('@drama{forged');
    expect(current.edges).toHaveLength(previousEdges + 1);
    expect(current.edges.at(-1)).toMatchObject({ source: sourceNodeId, target: shotlistId });
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('局部更新保留台词、时长、稳定 ID 与画面，追加由应用生成 ID', () => {
    updateShotlistRows({ projectId: 'ep' }, 'sheet', 'update', [{ id: 'r1', camera: '缓慢推近' }]);
    const result = updateShotlistRows({ projectId: 'ep' }, 'sheet', 'append', [{ shotNo: '2', content: '列车进站' }]);
    expect(result[0]).toEqual({ ...row, camera: '缓慢推近' });
    expect(result[1]).toMatchObject({ shotNo: '2', content: '列车进站', frame: null });
    expect(result[1].id).not.toBe('r1');
  });

  it('一批存在无效行时整批拒绝，不先写有效行', () => {
    expect(() => updateShotlistRows({ projectId: 'ep' }, 'sheet', 'update', [
      { id: 'r1', content: '不应落地' }, { id: 'missing', camera: '固定' },
    ])).toThrow();
    expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0]).toEqual(row);
    expect(() => updateShotlistRows({ projectId: 'ep' }, 'sheet', 'update', [{ id: 'r1', duration: -1 }])).toThrow();
    expect(() => updateShotlistRows({ projectId: 'ep' }, 'sheet', 'append', [{ id: 'forged', content: 'x' }])).toThrow();
  });

  it('分镜表文本模型继承不影响图片默认配置', () => {
    const data = applyProjectDefaultsToNodeData({ type: 'ai-shotlist', label: '分镜' }, { defaultModels: { text: 'general/text', image: 'general/image' } });
    expect(data.model).toBe('general/text');
  });
});

describe('共享分镜生成', () => {
  it('解析真实镜头行并接续旧画面', async () => {
    mocks.generateText.mockResolvedValue('{"shots":[{"shotNo":"1","content":"新的画面"},{"shotNo":"2","content":"列车"}]}');
    const result = await generateShotlistRows('sheet', '拆剧本', 'model', 'provider');
    expect(result).toHaveLength(2);
    expect(result[0].frame).toEqual(row.frame);
    expect(useAppStore.getState().nodes[0].data.shotlistRows).toEqual(result);
    expect(mocks.generateText.mock.calls[0][0].prompt).toContain('"shots"');
  });

  it.each(['project', 'revision', 'row', 'delete'] as const)('生成期间 %s 变化则不覆盖', async (change) => {
    let resolve!: (value: string) => void;
    mocks.generateText.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
    const pending = generateShotlistRows('sheet', '拆剧本', 'model', 'provider');
    if (change === 'project') useAppStore.setState({ currentProjectId: 'other' });
    if (change === 'revision') useAppStore.getState().incrementRevision();
    if (change === 'row') useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [{ ...row, dialogue: '用户修改' }] });
    if (change === 'delete') useAppStore.setState({ nodes: [] });
    resolve('{"shots":[{"content":"旧结果"}]}');
    await expect(pending).rejects.toThrow('变化');
    expect(useAppStore.getState().recordOutputHistory).not.toHaveBeenCalled();
    if (change === 'row') expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0].dialogue).toBe('用户修改');
  });

  it('非结构化响应不清空已有镜头', async () => {
    mocks.generateText.mockResolvedValue('模型未返回镜头');
    await expect(generateShotlistRows('sheet', '拆剧本', 'm', 'p')).rejects.toThrow();
    expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0]).toEqual(row);
  });
});
