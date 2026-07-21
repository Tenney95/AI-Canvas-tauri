import { beforeEach, describe, expect, it } from 'vitest';
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
    agentTasks: [createTask()],
    history: [
      { nodes: [], edges: [], groups: [] },
      { nodes: [], edges: [], groups: [] },
      { nodes: [], edges: [], groups: [] },
    ],
    historyIndex: 2,
    canvasRevision: 2,
  });
});

describe('agent task canvas rewind', () => {
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
