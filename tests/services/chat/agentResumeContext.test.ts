import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import type { CanvasContext } from '../../../src/types/project';
import type { ProjectExecutionContextState } from '../../../src/types/projectExecutionContext';
import { nativeAgentResumeContext } from '../../../src/services/chat/agentResumeContext';
import { findSucceededDuplicateWrite } from '../../../src/services/chat/agentCheckpointService';

const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'old-run',
  projectId: 'p', projectEpoch: 2, episodeId: 'e', canvasId: 'c', canvasEpoch: 4, canvasRevision: 8 };
const state = (): ProjectExecutionContextState => ({ currentProjectId: 'c', projectLoadStatus: 'ready',
  getCurrentRevision: () => 8, projectExecutionContext: { ...context, runtimeEpoch: 'new-run' } });
const task = (): AgentTask => ({ id: 'task', projectId: 'c', projectScope: context, resumeCount: 2, modelRounds: 5,
  conversationId: 'conversation', userMessageId: 'message', mode: 'autonomous', goal: '继续', status: 'paused',
  budget: { ...DEFAULT_AGENT_TASK_BUDGET }, createdAt: 1, updatedAt: 1,
  toolCallCount: 7, steps: [], dispatches: [{ id: 'original-dispatch', kind: 'model', phase: 'settled', preparedAt: 1, outcome: 'succeeded' }] });

describe('显式继续新项目 Agent 任务', () => {
  it('只绑定新运行租约，不改变原身份/计数/回执，也不修改原对象', () => {
    const original = task(), before = structuredClone(original);
    expect(nativeAgentResumeContext(state(), original)).toEqual({ projectScope: { ...context, runtimeEpoch: 'new-run' } });
    expect(original).toEqual(before);
  });
  it('拒绝其他分集、退役后新身份和持久代际变化', () => {
    for (const change of [{ canvasId: 'other' }, { episodeId: 'other' }, { projectEpoch: 3 }, { canvasEpoch: 5 }]) {
      expect(() => nativeAgentResumeContext({ ...state(), projectExecutionContext: { ...context, ...change, runtimeEpoch: 'new-run' } }, task())).toThrow();
    }
  });
  it('普通 scope 可在原画布修改后继续，显式请求的原 revision 仍需满足', () => {
    const current = { ...state(), projectExecutionContext: { ...context, canvasRevision: 9, runtimeEpoch: 'new-run' } };
    expect(nativeAgentResumeContext(current, task()).projectScope?.runtimeEpoch).toBe('new-run');
    expect(() => nativeAgentResumeContext(current, { ...task(), executionContext: context })).toThrow();
  });
  it('重绑定后不能凭数值碰巧相同的旧历史检查点复用新请求', () => {
    const original = task();
    original.projectScope = { ...context, runtimeEpoch: 'new-run' };
    original.steps = [{ id: 'step', taskId: 'task', index: 0, kind: 'tool', title: '写入', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { toolId: 'canvas_update_nodes', callId: 'old-call', retryCount: 0,
      effect: 'canvas_write', inputFingerprint: 'fingerprint', canvasCheckpoint: { runtimeEpoch: 'old-run',
        revisionBefore: 7, revisionAfter: 8, historyIndexBefore: 0, historyIndexAfter: 1 } } }];
    expect(findSucceededDuplicateWrite(original, 'canvas_update_nodes', 'fingerprint', { callId: 'new-call',
      projectId: 'c', historyIndex: 1, revision: 8, checkpointReplayStepIds: new Set(['step']) })).toBeUndefined();
  });
});
