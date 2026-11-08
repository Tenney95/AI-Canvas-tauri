/** 新代际任务必须绑定已激活画布的真实运行租约。 */
import { afterEach, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { createAgentSlice } from '../../src/store/store.agent';
import * as taskService from '../../src/services/chat/agentTaskService';
import type { CanvasContext } from '../../src/types/project';
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(useAppStore.getInitialState(), true); });

it('拒绝缺少运行租约或不可用宿主的任务，不先创建任务或持久化', () => {
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
  expect(() => slice.createAgentTask({ ...input, executionContext: context })).toThrow();
  expect(persist).not.toHaveBeenCalled();
});

it('当前新画布可建立带原身份和预算的任务，错误代际或画布不能借此创建', () => {
  const persist = vi.spyOn(taskService, 'saveAgentTask').mockResolvedValue();
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'run-a',
    projectId: 'p', projectEpoch: 2, canvasId: 'c', episodeId: null, canvasEpoch: 3, canvasRevision: 0 };
  const state = { ...useAppStore.getInitialState(), currentProjectId: 'c', projectLoadStatus: 'ready' as const,
    projects: [{ id: 'c', name: '新画布', createdAt: 1, updatedAt: 1 }], projectExecutionContext: context };
  const slice = createAgentSlice(useAppStore.setState, () => state, useAppStore);
  const input = { projectId: 'c', conversationId: 'conv-c', userMessageId: 'msg-c', mode: 'autonomous' as const, goal: '保留原请求' };
  const task = slice.createAgentTask(input);
  expect(task.projectScope).toEqual(context);
  expect(task.budget.maxModelRounds).toBeGreaterThan(0);
  expect(persist).toHaveBeenCalledOnce();
  expect(() => slice.createAgentTask({ ...input, projectId: 'other' })).toThrow();
  expect(() => slice.createAgentTask({ ...input, executionContext: { ...context, canvasEpoch: 4 } })).toThrow();
});
