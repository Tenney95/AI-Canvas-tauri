import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAssistantFunctionTools,
  clearAgentToolRegistryForTests,
  getAgentTool,
  prepareAgentToolCall,
  registerAgentTool,
  type AgentToolContext,
  type AgentToolDefinition,
} from '../../../src/services/chat/toolRegistry';
import {
  ensureAgentToolsRegistered,
  resetAgentToolsRegistrationForTests,
} from '../../../src/services/chat/tools';

const context: Omit<AgentToolContext, 'signal'> = {
  taskId: 'task-1',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  mode: 'collaborative',
  baseRevision: 2,
};

function createTool(partial: Partial<AgentToolDefinition> = {}): AgentToolDefinition {
  return {
    id: 'canvas_query_test',
    title: 'Query canvas',
    description: 'Query canvas',
    effect: 'read',
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1 } },
    },
    execute: vi.fn(async () => ({
      status: 'success' as const,
      summary: 'ok',
      modelContent: 'ok',
    })),
    ...partial,
  };
}

afterEach(() => {
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
});

describe('Agent tool registry', () => {
  it('rejects unregistered tools', () => {
    expect(prepareAgentToolCall({
      callId: 'call-1',
      toolId: 'missing_tool',
      input: {},
    }, context)).toEqual({
      ok: false,
      result: {
        callId: 'call-1',
        toolId: 'missing_tool',
        status: 'denied',
        summary: '工具不可用或未注册: missing_tool',
        truncated: false,
      },
    });
  });

  it('rejects unavailable tools and excludes them from the model contract', () => {
    registerAgentTool(createTool({ isAvailable: () => false }));

    expect(buildAssistantFunctionTools(context)).toEqual([]);
    expect(prepareAgentToolCall({
      callId: 'call-1',
      toolId: 'canvas_query_test',
      input: { query: 'failed nodes' },
    }, context)).toMatchObject({ ok: false });
  });

  it('rejects unknown input fields before execution', () => {
    const tool = createTool();
    registerAgentTool(tool);

    const result = prepareAgentToolCall({
      callId: 'call-1',
      toolId: tool.id,
      input: { query: 'failed nodes', requiresConfirm: false },
    }, context);

    expect(result).toMatchObject({
      ok: false,
      result: { status: 'error' },
    });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('returns a prepared call only after local schema validation', () => {
    const tool = createTool();
    registerAgentTool(tool);

    const result = prepareAgentToolCall({
      callId: 'call-1',
      toolId: tool.id,
      input: { query: 'failed nodes' },
    }, context);

    expect(result).toEqual({
      ok: true,
      prepared: {
        definition: tool,
        input: { query: 'failed nodes' },
      },
    });
  });

  it('rejects duplicate tool registrations', () => {
    registerAgentTool(createTool());

    expect(() => registerAgentTool(createTool())).toThrow('Agent 工具已注册');
  });

  it('can dispose and re-register built-in tools during hot reload', () => {
    ensureAgentToolsRegistered();
    const firstDefinition = getAgentTool('canvas_query');

    expect(firstDefinition).toBeDefined();
    expect(() => ensureAgentToolsRegistered()).not.toThrow();
    expect(getAgentTool('canvas_query')).toBe(firstDefinition);
    resetAgentToolsRegistrationForTests();
    expect(getAgentTool('canvas_query')).toBeUndefined();

    ensureAgentToolsRegistered();
    expect(getAgentTool('canvas_query')).toBeDefined();
    expect(getAgentTool('canvas_query')).not.toBe(firstDefinition);
  });

  it('rolls back completed tool groups after a later registration error', () => {
    const unregisterConflict = registerAgentTool(createTool({ id: 'media_generate' }));

    expect(() => ensureAgentToolsRegistered()).toThrow('Agent 工具已注册: media_generate');
    expect(getAgentTool('canvas_query')).toBeUndefined();

    unregisterConflict();
    expect(() => ensureAgentToolsRegistered()).not.toThrow();
    expect(getAgentTool('canvas_query')).toBeDefined();
  });

  it('applies a task tool allowlist as a visibility ceiling', () => {
    registerAgentTool(createTool());
    registerAgentTool(createTool({ id: 'preset_list' }));

    const restricted = { ...context, toolAllowlist: ['preset_list'] };
    expect(buildAssistantFunctionTools(restricted).map((tool) => tool.function.name))
      .toEqual(['preset_list']);
    expect(prepareAgentToolCall({
      callId: 'call-1',
      toolId: 'canvas_query_test',
      input: { query: 'failed nodes' },
    }, restricted)).toMatchObject({ ok: false, result: { status: 'denied' } });
  });

  it('only exposes read tools in plan mode', () => {
    registerAgentTool(createTool());
    registerAgentTool(createTool({ id: 'canvas_update_test', effect: 'canvas_write' }));

    const planContext = { ...context, mode: 'plan' as const };
    expect(buildAssistantFunctionTools(planContext).map((tool) => tool.function.name))
      .toEqual(['canvas_query_test']);
    expect(prepareAgentToolCall({
      callId: 'call-1',
      toolId: 'canvas_update_test',
      input: { query: 'update node' },
    }, planContext)).toMatchObject({ ok: false, result: { status: 'denied' } });
  });
});
