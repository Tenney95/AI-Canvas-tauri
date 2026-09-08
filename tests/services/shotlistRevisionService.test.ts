import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { createEpisodeShotlist, updateShotlistRows } from '../../src/services/shotlistService';
import { buildShotlistRevisionPrompt, getShotlistScriptChange, summarizeScriptChange } from '../../src/services/shotlistRevisionService';
import { registerShotlistAgentTools } from '../../src/services/chat/tools/shotlistTools';
import { clearAgentToolRegistryForTests, getAgentTool, type AgentToolContext } from '../../src/services/chat/toolRegistry';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', showToast: vi.fn(), projects: [
    { id: 'ep', parentId: 'series', name: '第 1 集', createdAt: 1, updatedAt: 1, episodeScript: '林夏在站台等列车。' },
  ] });
  clearAgentToolRegistryForTests();
});
function changeScript(script: string) {
  useAppStore.setState((state) => ({ projects: state.projects.map((project) => ({ ...project, episodeScript: script })) }));
}
describe('剧本改动复核', () => {
  it.each([
    ['abc', 'abc', false, '', ''], ['abc', 'abXc', true, '', 'X'], ['abc', 'ac', true, 'b', ''],
    ['林夏等列车。', '林夏追列车。', true, '等', '追'],
  ] as const)('正确定位插入、删除和替换 %s → %s', (before, after, changed, beforePreview, afterPreview) => {
    expect(summarizeScriptChange(before, after)).toMatchObject({ changed, beforePreview, afterPreview });
  });
  it('创建分镜记录来源引用；只准备选定镜头的调整请求，不修改快照和画布', () => {
    const created = createEpisodeShotlist({ projectId: 'ep' }, 'ep');
    expect(getShotlistScriptChange({ projectId: 'ep' }, created.shotlistId).changed).toBe(false);
    const rows = updateShotlistRows({ projectId: 'ep' }, created.shotlistId, 'append', [{ content: '等待' }, { content: '列车' }]);
    changeScript('林夏在站台追列车。');
    const before = structuredClone(useAppStore.getState().nodes);
    const prompt = buildShotlistRevisionPrompt({ projectId: 'ep' }, created.shotlistId, [rows[1].id]);
    expect(prompt).toContain(JSON.stringify([rows[1].id]));
    expect(prompt).not.toContain(rows[0].id);
    expect(prompt).toContain('画面绑定');
    expect(useAppStore.getState().nodes).toEqual(before);
    expect(getShotlistScriptChange({ projectId: 'ep' }, created.shotlistId)).toMatchObject({ beforePreview: '等', afterPreview: '追' });
  });
  it('空选择、失效镜头、未改稿、跨项目和快照缺失均拒绝', () => {
    const created = createEpisodeShotlist({ projectId: 'ep' }, 'ep');
    expect(() => buildShotlistRevisionPrompt({ projectId: 'ep' }, created.shotlistId, ['gone'])).toThrow('一致');
    changeScript('新剧本');
    expect(() => buildShotlistRevisionPrompt({ projectId: 'ep' }, created.shotlistId, [])).toThrow('请选择');
    expect(() => buildShotlistRevisionPrompt({ projectId: 'ep' }, created.shotlistId, ['gone'])).toThrow('请选择');
    expect(() => getShotlistScriptChange({ projectId: 'other' }, created.shotlistId)).toThrow();
    useAppStore.setState((state) => ({ nodes: state.nodes.filter((node) => node.id !== created.sourceNodeId) }));
    expect(() => getShotlistScriptChange({ projectId: 'ep' }, created.shotlistId)).toThrow('不可用');
  });
  it('没有明确来源引用的旧表不猜测；撤销重做保留新表引用', async () => {
    const created = createEpisodeShotlist({ projectId: 'ep' }, 'ep');
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toHaveLength(0);
    await useAppStore.getState().redo();
    expect(getShotlistScriptChange({ projectId: 'ep' }, created.shotlistId).changed).toBe(false);
    useAppStore.getState().updateNodeDataTransient(created.shotlistId, { shotlistScriptSource: undefined });
    expect(() => getShotlistScriptChange({ projectId: 'ep' }, created.shotlistId)).toThrow('没有可追溯');
  });
  it('助手/MCP 差异工具只读，预览有界且保留不可信资料标记', async () => {
    const created = createEpisodeShotlist({ projectId: 'ep' }, 'ep');
    changeScript('\u0001'.repeat(10000));
    registerShotlistAgentTools();
    const tool = getAgentTool('shotlist_script_changes')!;
    expect(tool.effect).toBe('read');
    const context = { projectId: 'ep', signal: new AbortController().signal } as AgentToolContext;
    const result = await tool.execute(context, { nodeId: created.shotlistId });
    expect(result.modelContent.length).toBeLessThan(18000);
    expect(JSON.parse(result.modelContent)).toMatchObject({ previewTruncated: true, changed: true });
    expect(result.modelContent).toContain('不可信');
  });
});
