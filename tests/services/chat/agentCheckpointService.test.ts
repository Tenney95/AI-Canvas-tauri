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

const replayContext = {
  callId: 'new-call', projectId: 'project-1', historyIndex: 3, revision: 5,
  checkpointReplayStepIds: new Set(['step-0']),
};

describe('agent canvas checkpoints', () => {
  it('builds a bounded resume context from persisted step summaries', () => {
    const existing = step(0, {
      historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5,
    });
    existing.outputSummary = 'updated node #3';
    expect(buildAgentResumeContext(task([existing]))).toContain('updated node #3');
  });

  it('tells the model to drop the previous plan only when a replan was requested', () => {
    const existing = step(0, {
      historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5,
    });
    existing.outputSummary = 'updated node #3';
    const plainResume = buildAgentResumeContext(task([existing]));
    const replan = buildAgentResumeContext({
      ...task([existing]),
      replanRequest: { requestedAt: 10, reason: 'user_requested' },
    });

    expect(plainResume).not.toContain('放弃此前的计划');
    expect(replan).toContain('用户要求重新规划本任务');
    expect(replan).toContain('放弃此前的计划');
    expect(replan).not.toBe(plainResume);
    // 步骤摘要在两种恢复下都要保留
    expect(replan).toContain('updated node #3');
  });

  it('carries a replan request even when no step has finished yet', () => {
    expect(buildAgentResumeContext(task([]))).toBe('');
    expect(buildAgentResumeContext({
      ...task([]),
      replanRequest: { requestedAt: 10, reason: 'step_skipped' },
    })).toContain('被跳过的步骤不得重试');
  });

  it('creates the same fingerprint for semantically identical object key order', () => {
    expect(fingerprintToolInput('tool', { a: 1, b: { x: 2 } }))
      .toBe(fingerprintToolInput('tool', { b: { x: 2 }, a: 1 }));
  });

  it('finds a previously succeeded duplicate write', () => {
    const existing = step(0, {
      historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5,
    });
    expect(findSucceededDuplicateWrite(task([existing]), 'canvas_update_nodes', 'fingerprint-1', replayContext))
      .toBe(existing);
  });

  it('does not equate a new operation with identical parameters outside checkpoint recovery', () => {
    const existing = step(0, { historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5 });
    expect(findSucceededDuplicateWrite(task([existing]), 'canvas_update_nodes', 'fingerprint-1', {
      ...replayContext, checkpointReplayStepIds: undefined,
    })).toBeUndefined();
  });

  it('still suppresses replay of the same succeeded request identity', () => {
    const existing = step(0, { historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5 });
    expect(findSucceededDuplicateWrite(task([existing]), 'canvas_update_nodes', 'fingerprint-1', {
      ...replayContext, callId: 'call-0', checkpointReplayStepIds: undefined,
    })).toBe(existing);
  });

  it.each([
    { revision: 6 },
    { historyIndex: 4 },
    { projectId: 'project-2' },
    { excludeStepId: 'step-0' },
  ])('does not reuse an obsolete or inapplicable checkpoint: %j', (override) => {
    const existing = step(0, { historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5 });
    expect(findSucceededDuplicateWrite(task([existing]), 'canvas_update_nodes', 'fingerprint-1', {
      ...replayContext, ...override,
    })).toBeUndefined();
  });

  it('does not infer successful recovery from legacy records lacking checkpoint evidence', () => {
    const existing = step(0, { historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5 });
    delete existing.toolCall!.canvasCheckpoint;
    expect(findSucceededDuplicateWrite(task([existing]), 'canvas_update_nodes', 'fingerprint-1', replayContext))
      .toBeUndefined();
  });

  it('does not reuse a new media-generation request by matching its parameters', () => {
    const existing = step(0, { historyIndexBefore: 2, historyIndexAfter: 3, revisionBefore: 4, revisionAfter: 5 });
    existing.toolCall!.toolId = 'canvas_run_nodes';
    existing.toolCall!.effect = 'media_generation';
    expect(findSucceededDuplicateWrite(task([existing]), 'canvas_run_nodes', 'fingerprint-1', replayContext))
      .toBeUndefined();
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
