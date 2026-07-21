import { describe, expect, it } from 'vitest';
import type { AgentCanvasCheckpoint, AgentStep, AgentTask } from '../../../src/types/agent';
import {
  buildAgentResumeContext,
  findSucceededDuplicateWrite,
  fingerprintToolInput,
  validateAgentTaskCanvasRewind,
} from '../../../src/services/chat/agentCheckpointService';

function step(index: number, checkpoint: AgentCanvasCheckpoint): AgentStep {
  return {
    id: `step-${index}`,
    taskId: 'task-1',
    index,
    kind: 'tool',
    title: 'Canvas write',
    status: 'succeeded',
    createdAt: index,
    updatedAt: index,
    toolCall: {
      callId: `call-${index}`,
      toolId: 'canvas_update_nodes',
      retryCount: 0,
      effect: 'canvas_write',
      inputFingerprint: 'fingerprint-1',
      canvasCheckpoint: checkpoint,
    },
  };
}

function task(steps: AgentStep[]): AgentTask {
  return {
    id: 'task-1', projectId: 'project-1', conversationId: 'conversation-1',
    userMessageId: 'message-1', mode: 'autonomous', goal: 'update', status: 'completed',
    steps, modelRounds: 1, toolCallCount: steps.length,
    budget: { maxModelRounds: 12, maxToolCalls: 24, maxParallelReadTools: 3, maxReadRetries: 3 },
    createdAt: 1, updatedAt: 1,
  };
}

describe('agent canvas checkpoints', () => {
  it('builds a bounded resume context from persisted step summaries', () => {
    const existing = step(0, {
      historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5,
    });
    existing.outputSummary = 'updated node #3';
    expect(buildAgentResumeContext(task([existing]))).toContain('updated node #3');
  });

  it('creates the same fingerprint for semantically identical object key order', () => {
    expect(fingerprintToolInput('tool', { a: 1, b: { x: 2 } }))
      .toBe(fingerprintToolInput('tool', { b: { x: 2 }, a: 1 }));
  });

  it('finds a previously succeeded duplicate write', () => {
    const existing = step(0, {
      historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5,
    });
    expect(findSucceededDuplicateWrite(task([existing]), 'canvas_update_nodes', 'fingerprint-1'))
      .toBe(existing);
  });

  it('allows rewind only for a continuous current history tail', () => {
    const value = task([
      step(0, { historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5 }),
      step(1, { historyIndexBefore: 3, historyIndexAfter: 4, revisionBefore: 5, revisionAfter: 6 }),
    ]);
    expect(validateAgentTaskCanvasRewind(value, 'project-1', 4, 6)).toMatchObject({
      ok: true,
      undoCount: 2,
    });
    expect(validateAgentTaskCanvasRewind(value, 'project-1', 5, 6)).toMatchObject({
      ok: false,
      errorCode: 'AGENT_REWIND_NOT_HISTORY_TAIL',
    });
  });

  it('rejects interleaved checkpoint chains', () => {
    const value = task([
      step(0, { historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5 }),
      step(1, { historyIndexBefore: 4, historyIndexAfter: 5, revisionBefore: 6, revisionAfter: 7 }),
    ]);
    expect(validateAgentTaskCanvasRewind(value, 'project-1', 5, 7)).toMatchObject({
      ok: false,
      errorCode: 'AGENT_REWIND_HISTORY_INTERLEAVED',
    });
  });
});
