import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import {
  MAX_AGENT_EVENTS,
  addAgentTaskMetrics,
  appendAgentEvent,
  sanitizeAgentEventData,
} from '../../../src/services/chat/agentJournal';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    agentTasks: [{
      id: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      mode: 'collaborative',
      goal: 'test',
      status: 'running',
      steps: [],
      modelRounds: 0,
      toolCallCount: 0,
      budget: { maxModelRounds: 12, maxToolCalls: 24, maxParallelReadTools: 3, maxReadRetries: 3 },
      createdAt: 1,
      updatedAt: 1,
    }],
  });
});

describe('agent journal', () => {
  it('keeps only whitelisted, sanitized diagnostic data', () => {
    const data = sanitizeAgentEventData({
      toolId: 'canvas_read',
      errorCode: 'C:\\Users\\name\\secret.txt',
      unknown: 'sk-secretsecretsecret' as never,
    } as never);
    expect(data).toEqual({ toolId: 'canvas_read', errorCode: '[local-path]' });
  });

  it('assigns monotonic sequences and caps retained events', () => {
    for (let index = 0; index < MAX_AGENT_EVENTS + 5; index += 1) {
      appendAgentEvent('task-1', 'model_round_start', { durationMs: index });
    }
    const events = useAppStore.getState().agentTasks[0].events ?? [];
    expect(events).toHaveLength(MAX_AGENT_EVENTS);
    expect(events[0].sequence).toBe(5);
    expect(events.at(-1)?.sequence).toBe(MAX_AGENT_EVENTS + 4);
  });

  it('accumulates non-negative task metrics', () => {
    addAgentTaskMetrics('task-1', { inputTokens: 20, modelDurationMs: 15 });
    addAgentTaskMetrics('task-1', { inputTokens: 5, modelDurationMs: -10 });
    expect(useAppStore.getState().agentTasks[0].metrics).toMatchObject({
      inputTokens: 25,
      modelDurationMs: 15,
    });
  });
});

