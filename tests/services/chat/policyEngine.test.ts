import { describe, expect, it, vi } from 'vitest';
import { evaluateAgentToolPolicy } from '../../../src/services/chat/policyEngine';
import type {
  AgentToolDefinition,
  AgentToolEffect,
} from '../../../src/services/chat/toolRegistry';
import type { AgentMode } from '../../../src/types/agent';

function createTool(
  effect: AgentToolEffect,
  authorize?: AgentToolDefinition['authorize'],
): AgentToolDefinition {
  return {
    id: `test_${effect}`,
    title: effect,
    description: effect,
    effect,
    authorize,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: vi.fn(async () => ({
      status: 'success' as const,
      summary: 'ok',
      modelContent: 'ok',
    })),
  };
}

function context(mode: AgentMode) {
  return {
    mode,
    projectId: 'project-1',
    conversationId: 'conversation-1',
    taskId: 'task-1',
    baseRevision: 3,
  };
}

describe('evaluateAgentToolPolicy', () => {
  it.each<AgentMode>(['collaborative', 'autonomous', 'plan'])(
    'allows read tools automatically in %s mode',
    (mode) => {
      expect(evaluateAgentToolPolicy(createTool('read'), {}, context(mode))).toMatchObject({
        outcome: 'allow',
      });
    },
  );

  it('requires approval for canvas writes in collaborative mode', () => {
    expect(
      evaluateAgentToolPolicy(createTool('canvas_write'), {}, context('collaborative')),
    ).toEqual(expect.objectContaining({
      outcome: 'require_approval',
      approvalKind: 'canvas_write',
    }));
  });

  it('allows canvas writes in autonomous mode', () => {
    expect(
      evaluateAgentToolPolicy(createTool('canvas_write'), {}, context('autonomous')),
    ).toMatchObject({ outcome: 'allow' });
  });

  it.each<Exclude<AgentToolEffect, 'read'>>([
    'canvas_write',
    'file_write',
    'permanent_delete',
    'media_generation',
    'memory_write',
    'config_write',
  ])('denies %s independently in plan mode', (effect) => {
    expect(evaluateAgentToolPolicy(createTool(effect), {}, context('plan'))).toEqual({
      outcome: 'deny',
      reason: 'Plan 模式只允许使用只读工具',
      errorCode: 'AGENT_PLAN_MODE_READ_ONLY',
    });
  });

  it.each<AgentToolEffect>([
    'file_write',
    'permanent_delete',
    'media_generation',
    'memory_write',
    'config_write',
  ])('always requires approval for %s', (effect) => {
    for (const mode of ['collaborative', 'autonomous'] as const) {
      expect(evaluateAgentToolPolicy(createTool(effect), {}, context(mode))).toEqual(
        expect.objectContaining({
          outcome: 'require_approval',
          approvalKind: effect,
        }),
      );
    }
  });

  it('denies unauthorized tools before applying mode permissions', () => {
    const tool = createTool('read', () => ({ allowed: false, reason: 'grant revoked' }));

    expect(evaluateAgentToolPolicy(tool, {}, context('autonomous'))).toEqual({
      outcome: 'deny',
      reason: 'grant revoked',
      errorCode: 'AGENT_TOOL_UNAUTHORIZED',
    });
  });
});
