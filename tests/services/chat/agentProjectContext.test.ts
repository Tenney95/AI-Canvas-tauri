/** P4 原任务身份和零画布能力边界；本轮未执行。 */
import { describe, expect, it } from 'vitest';
import { assertAgentProjectContext, captureAgentProjectScope, isAgentToolProjectContextCompatible } from '../../../src/services/chat/agentProjectContext';
import { captureLegacyCanvasContext } from '../../../src/services/projectExecutionContext';
import type { ProjectExecutionContextState } from '../../../src/types/projectExecutionContext';
const state = (): ProjectExecutionContextState => ({ currentProjectId: 'A', projects: [
  { id: 'S', exchangeEpoch: 2 }, { id: 'A', parentId: 'S', exchangeEpoch: 3 }, { id: 'B', parentId: 'S', exchangeEpoch: 4 },
], projectLoadStatus: 'ready', getCurrentRevision: () => 8 });

describe('P4 Agent项目执行前提', () => {
  it('旧任务身份scope允许显式重启继续，原Canvas或owner epoch变更仍拒绝', () => {
    const current = state(), projectScope = captureAgentProjectScope(current, { projectId: 'A' })!;
    expect(() => assertAgentProjectContext(current, { projectScope: { ...projectScope, runtimeEpoch: 'old-process' } })).not.toThrow();
    expect(() => assertAgentProjectContext({ ...current, currentProjectId: 'B' }, { projectScope })).toThrow();
    expect(() => assertAgentProjectContext({ ...current, projects: current.projects!.map((item) => item.id === 'S' ? { ...item, exchangeEpoch: 9 } : item) }, { projectScope })).toThrow();
    expect(() => assertAgentProjectContext(current, { executionContext: { ...projectScope, modelGeneration: 1 } })).toThrow('尚未开放');
    expect(() => assertAgentProjectContext({ ...current, projectLoadStatus: 'loading' }, { projectId: 'A' })).toThrow();
  });
  it('显式v2条件不能借旧任务恢复语义跳过runtime/revision，工作台scope只给选中集正文', () => {
    const current = state(), canvas = captureLegacyCanvasContext(current)!;
    expect(() => assertAgentProjectContext(current, { executionContext: { ...canvas, runtimeEpoch: 'old-process' } })).toThrow();
    const workbench = captureAgentProjectScope(current, { projectId: 'S', workbenchTarget: { seriesId: 'S', episodeId: 'B' } })!;
    expect(() => assertAgentProjectContext(current, { projectScope: workbench })).not.toThrow();
    expect(isAgentToolProjectContextCompatible({ id: 'canvas_update_nodes', effect: 'canvas_write' }, { projectScope: workbench })).toBe(false);
    expect(isAgentToolProjectContextCompatible({ id: 'episode_update_script', effect: 'file_write' }, { projectScope: workbench }, { episodeId: 'A' })).toBe(false);
  });
  it('零Canvas连chat交付付费生成也拒绝，项目文本和启动导航保持可用', () => {
    const projectScope = { kind: 'project', schemaVersion: 2, modelGeneration: 0, projectId: 'S', projectEpoch: 2 } as const;
    expect(isAgentToolProjectContextCompatible({ id: 'media_generate_image', effect: 'media_generation' }, { projectScope }, { deliveryMode: 'chat' })).toBe(false);
    expect(isAgentToolProjectContextCompatible({ id: 'director_scene_read', effect: 'read' }, { projectScope })).toBe(false);
    expect(isAgentToolProjectContextCompatible({ id: 'series_update_script', effect: 'file_write' }, { projectScope })).toBe(true);
    expect(isAgentToolProjectContextCompatible({ id: 'project_open', effect: 'canvas_write' }, { projectScope })).toBe(true);
  });
});
