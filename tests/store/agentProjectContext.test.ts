/** P4 隔离新代际不能创建默认DB27任务；本轮未执行。 */
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentSlice } from '../../src/store/store.agent';
import { useAppStore } from '../../src/store/useAppStore';
import * as taskService from '../../src/services/chat/agentTaskService';
import type { CanvasContext } from '../../src/types/project';
afterEach(() => vi.restoreAllMocks());

it('拒绝显式或宿主提供的新generation以及不可用宿主，不先创建任务或持久化', () => {
  const persist = vi.spyOn(taskService, 'saveAgentTask');
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1,
    projectId: 'A', projectEpoch: 1, canvasId: 'A', episodeId: null, canvasEpoch: 1, canvasRevision: 0 };
  const input = { projectId: 'A', conversationId: 'conv-A', userMessageId: 'msg-A', mode: 'autonomous' as const, goal: '保留原请求' };
  for (const projectExecutionContext of [context, null]) {
    const state = { ...useAppStore.getInitialState(), currentProjectId: 'A', projectLoadStatus: 'ready' as const,
      projects: [{ id: 'A', name: '隔离样本', createdAt: 1, updatedAt: 1 }], projectExecutionContext };
    const slice = createAgentSlice(useAppStore.setState, () => state, useAppStore);
    expect(() => slice.createAgentTask(input)).toThrow();
  }
  const slice = createAgentSlice(useAppStore.setState, useAppStore.getState, useAppStore);
  expect(() => slice.createAgentTask({ ...input, executionContext: context })).toThrow('尚未开放');
  expect(persist).not.toHaveBeenCalled();
});
