/**
 * agentRewindService — 回归测试：agent task canvas rewind。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLegacyCanvasContext } from '../../../src/services/projectExecutionContext';
import type { AgentTask } from '../../../src/types/agent';
import { rewindAgentTaskCanvas } from '../../../src/services/chat/agentRewindService';
import { useAppStore } from '../../../src/store/useAppStore';

function createTask(): AgentTask {
  return {
    id: 'task-rewind', projectId: 'project-1', conversationId: 'conversation-1',
    userMessageId: 'message-1', mode: 'autonomous', goal: 'write twice', status: 'completed',
    steps: [
      {
        id: 'step-1', taskId: 'task-rewind', index: 0, kind: 'tool', title: 'First write',
        status: 'succeeded', createdAt: 1, updatedAt: 1,
        toolCall: {
          callId: 'call-1', toolId: 'canvas_write', effect: 'canvas_write', retryCount: 0,
          canvasCheckpoint: { historyIndexBefore: 0, historyIndexAfter: 1, revisionBefore: 0, revisionAfter: 1 },
        },
      },
      {
        id: 'step-2', taskId: 'task-rewind', index: 1, kind: 'tool', title: 'Second write',
        status: 'succeeded', createdAt: 2, updatedAt: 2,
        toolCall: {
          callId: 'call-2', toolId: 'canvas_write', effect: 'canvas_write', retryCount: 0,
          canvasCheckpoint: { historyIndexBefore: 1, historyIndexAfter: 2, revisionBefore: 1, revisionAfter: 2 },
        },
      },
    ],
    modelRounds: 1, toolCallCount: 2,
    budget: { maxModelRounds: 12, maxToolCalls: 24, maxParallelReadTools: 3, maxReadRetries: 3 },
    createdAt: 1, updatedAt: 2,
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    projects: [{ id: 'project-1', name: '项目', createdAt: 1, updatedAt: 1 }],
    projectLoadStatus: 'ready',
    agentTasks: [createTask()],
    history: [
      { nodes: [], edges: [], groups: [] },
      { nodes: [], edges: [], groups: [] },
      { nodes: [], edges: [], groups: [] },
    ],
    historyIndex: 2,
    canvasRevision: 2,
  });
  useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, projectScope: captureLegacyCanvasContext(state)! })) }));
});
afterEach(() => vi.restoreAllMocks());

describe('agent task canvas rewind', () => {
  it('P4 缺原scope或同ID已换epoch时只允许查看检查点', async () => {
    useAppStore.setState((state) => ({ projects: state.projects.map((item) => ({ ...item, exchangeEpoch: 9 })) }));
    expect(await rewindAgentTaskCanvas('task-rewind')).toMatchObject({ ok: false, errorCode: 'AGENT_REWIND_CONTEXT_UNPROVEN' });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, projectScope: undefined })) }));
    expect(await rewindAgentTaskCanvas('task-rewind')).toMatchObject({ ok: false });
    expect(useAppStore.getState().historyIndex).toBe(2);
  });

  it('P4 原租约传到异步undo内部，失效后不推进新画布revision', async () => {
    vi.spyOn(useAppStore.getState(), 'undo').mockImplementationOnce(async (options) => {
      useAppStore.setState((state) => ({ projects: state.projects.map((item) => ({ ...item, exchangeEpoch: 9 })) }));
      return options?.isCurrent?.() !== false;
    });
    expect(await rewindAgentTaskCanvas('task-rewind')).toMatchObject({ ok: false, errorCode: 'AGENT_REWIND_CONTEXT_CHANGED' });
    expect(useAppStore.getState().canvasRevision).toBe(2);
  });

  it('rewinds a continuous task tail and advances revision once', async () => {
    const result = await rewindAgentTaskCanvas('task-rewind');
    expect(result).toMatchObject({ ok: true, undoCount: 2 });
    expect(useAppStore.getState()).toMatchObject({ historyIndex: 0, canvasRevision: 3 });
    expect(useAppStore.getState().agentTasks[0].events?.at(-1)?.type).toBe('canvas_rewind');
  });

  it('refuses to rewind when newer history exists', async () => {
    useAppStore.setState({ historyIndex: 1 });
    await expect(rewindAgentTaskCanvas('task-rewind')).resolves.toMatchObject({
      ok: false,
      errorCode: 'AGENT_REWIND_NOT_HISTORY_TAIL',
    });
  });
});
