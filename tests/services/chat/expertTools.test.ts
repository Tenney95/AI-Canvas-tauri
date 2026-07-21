import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentExpertRole, AgentTask } from '../../../src/types/agent';

const streamAssistantReplyMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/ai/assistantStream', () => ({
  streamAssistantReply: streamAssistantReplyMock,
}));

import {
  buildExpertCanvasSnapshot,
  ExpertTaskError,
  runExpertReview,
} from '../../../src/services/chat/expertTaskService';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerExpertAgentTools } from '../../../src/services/chat/tools/expertTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
} from '../../../src/services/chat/toolRegistry';
import { validateTaskResumable } from '../../../src/services/chat/agentRuntime';

function task(id: string, partial: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    mode: 'autonomous',
    goal: 'Review canvas',
    status: 'running',
    steps: [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: {
      maxModelRounds: 4,
      maxToolCalls: 4,
      maxParallelReadTools: 1,
      maxReadRetries: 0,
    },
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    agentTasks: [task('parent-1')],
    nodes: [{
      id: 'node-1',
      type: 'source-image',
      position: { x: 0, y: 0 },
      data: {
        type: 'source-image',
        label: 'Source C:\\private\\asset.png',
        status: 'success',
        displayId: 7,
        prompt: 'authorization: very-secret',
        filePath: 'C:\\private\\asset.png',
        model: 'private-model',
      },
    }],
    edges: [{ id: 'edge-1', source: 'node-1', target: 'node-1' }],
  });
  streamAssistantReplyMock.mockReset();
  streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
    onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5 });
    return '结构清晰，未发现阻断。';
  });
});

describe('expertTaskService', () => {
  it('registers one read-only expert tool with a closed role enum', () => {
    const unregister = registerExpertAgentTools()[0];
    const definition = getAgentTool('agent_run_expert_review');

    expect(definition?.effect).toBe('read');
    expect(definition?.inputSchema).toMatchObject({
      required: ['role'],
      additionalProperties: false,
      properties: {
        role: { enum: ['canvas_structure', 'workflow_risk', 'asset_reuse'] },
      },
    });
    unregister();
  });

  it('builds a bounded snapshot without node body, model, asset, or path fields', () => {
    const snapshot = buildExpertCanvasSnapshot('project-1');
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.nodes[0]).toEqual({
      id: 'node-1',
      displayId: 7,
      type: 'source-image',
      label: 'Source [本地路径]',
      status: 'success',
    });
    expect(serialized).not.toContain('very-secret');
    expect(serialized).not.toContain('private-model');
    expect(serialized).not.toContain('filePath');
    expect(serialized).not.toContain('asset.png');
  });

  it('runs a separate one-round model call with tools disabled and persists the child result', async () => {
    const result = await runExpertReview(
      'parent-1',
      'canvas_structure',
      new AbortController().signal,
    );

    expect(streamAssistantReplyMock).toHaveBeenCalledWith(expect.objectContaining({
      tools: [],
      trackAbort: false,
      userMessage: expect.not.stringContaining('very-secret'),
    }));
    const child = useAppStore.getState().agentTasks.find((item) => item.id === result.childTaskId);
    expect(child).toMatchObject({
      parentTaskId: 'parent-1',
      expertRole: 'canvas_structure',
      expertDepth: 1,
      mode: 'plan',
      status: 'completed',
      modelRounds: 1,
      toolCallCount: 0,
      toolAllowlist: [],
      resultSummary: '结构清晰，未发现阻断。',
    });
    expect(child?.budget).toMatchObject({ maxModelRounds: 1, maxToolCalls: 0 });
    expect(child?.metrics).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('rejects unknown roles and nested experts', async () => {
    await expect(runExpertReview(
      'parent-1',
      'unknown' as AgentExpertRole,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'EXPERT_ROLE_INVALID' });

    useAppStore.setState({
      agentTasks: [
        task('parent-1'),
        task('child-1', { parentTaskId: 'parent-1', expertDepth: 1 }),
      ],
    });
    await expect(runExpertReview(
      'child-1',
      'workflow_risk',
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining<Partial<ExpertTaskError>>({
      code: 'EXPERT_NESTING_DENIED',
    }));
    expect(streamAssistantReplyMock).not.toHaveBeenCalled();
  });

  it('enforces three expert tasks per parent', async () => {
    useAppStore.setState({
      agentTasks: [
        task('parent-1'),
        ...Array.from({ length: 3 }, (_, index) => task(`child-${index}`, {
          parentTaskId: 'parent-1',
          expertDepth: 1,
          expertRole: 'asset_reuse',
        })),
      ],
    });

    await expect(runExpertReview(
      'parent-1',
      'asset_reuse',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'EXPERT_TASK_LIMIT' });
    expect(streamAssistantReplyMock).not.toHaveBeenCalled();
  });

  it('does not resume an expert child independently after restart', () => {
    useAppStore.setState({
      agentTasks: [task('child-1', {
        parentTaskId: 'parent-1',
        expertDepth: 1,
        expertRole: 'canvas_structure',
        status: 'paused',
      })],
    });

    expect(validateTaskResumable('child-1')).toEqual({
      ok: false,
      errorCode: 'AGENT_EXPERT_CHILD_NOT_RESUMABLE',
      message: '专家子任务不能单独继续，请从上级任务重新规划',
    });
  });
});
