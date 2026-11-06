/**
 * subAgentTools — 回归测试：可用性与权限边界。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSubAgentMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/chat/subAgentService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/chat/subAgentService')>(),
  runSubAgent: runSubAgentMock,
}));

import { useAppStore } from '../../../src/store/useAppStore';
import { buildSubAgentCatalogPrompt } from '../../../src/services/chat/subAgentProfileService';
import { registerSubAgentAgentTools } from '../../../src/services/chat/tools/subAgentTools';
import { buildAssistantSystemPrompt } from '../../../src/services/ai/assistantStream';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  getAvailableAgentTools,
  prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import type { SubAgentProfile } from '../../../src/types/subAgent';
import { GENERAL_ASSISTANT_SCOPE_ID, resolveAssistantToolAllowlist } from '../../../src/services/chat/assistantScope';

const context: AgentToolContext = {
  taskId: 'parent-1',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  mode: 'collaborative',
  signal: new AbortController().signal,
};

function parentTask(partial: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'parent-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    mode: 'collaborative',
    goal: '分析 @{node-a:剧本}',
    status: 'running',
    steps: [],
    modelRounds: 1,
    toolCallCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET },
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  } as AgentTask;
}

function customProfile(partial: Partial<SubAgentProfile> = {}): SubAgentProfile {
  return {
    id: 'custom-1',
    name: '台词润色师',
    description: '润色台词',
    instructions: '润色台词',
    materials: ['mentioned_nodes'],
    maxRounds: 2,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

async function run(input: unknown, override: Partial<AgentToolContext> = {}) {
  return getAgentTool('agent_run_sub_agent')!.execute({ ...context, ...override }, input);
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  registerSubAgentAgentTools();
  runSubAgentMock.mockReset().mockResolvedValue({
    childTaskId: 'child-1',
    result: '分镜表内容',
    truncated: false,
  });
  useAppStore.setState({ agentTasks: [parentTask()], subAgentProfiles: [] });
});

afterEach(() => {
  clearAgentToolRegistryForTests();
});

describe('可用性与权限边界', () => {
  it('工具是 read effect，Plan 模式下可用', () => {
    expect(getAgentTool('agent_run_sub_agent')?.effect).toBe('read');
    expect(getAvailableAgentTools({ ...context, mode: 'plan' }).map((item) => item.id))
      .toContain('agent_run_sub_agent');
  });

  it('内置典范存在时工具始终可用', () => {
    expect(getAvailableAgentTools(context).map((item) => item.id))
      .toContain('agent_run_sub_agent');
  });

  it('通用助手可发现并授权只读子智能体工具', () => {
    const general = { ...context, projectId: GENERAL_ASSISTANT_SCOPE_ID, conversationId: 'conv-general',
      toolAllowlist: resolveAssistantToolAllowlist(GENERAL_ASSISTANT_SCOPE_ID) };
    useAppStore.setState({ agentTasks: [parentTask({ projectId: general.projectId, conversationId: general.conversationId })] });
    expect(getAvailableAgentTools(general).map((item) => item.id)).toContain('agent_run_sub_agent');
    expect(getAgentTool('agent_run_sub_agent')?.authorize?.(general, {
      profileId: 'built-in:script-analyst', assignment: '分析',
    })?.allowed).toBe(true);
  });

  it('项目身份与父任务不一致时拒绝派遣', () => {
    expect(getAgentTool('agent_run_sub_agent')?.authorize?.({ ...context, projectId: 'other-project' }, {
      profileId: 'built-in:script-analyst', assignment: '分析',
    })?.allowed).toBe(false);
  });

  it('父任务 toolAllowlist 不含该工具时不可用', () => {
    const scoped = { ...context, toolAllowlist: ['canvas_query'] };
    expect(getAvailableAgentTools(scoped).map((item) => item.id))
      .not.toContain('agent_run_sub_agent');
    const prepared = prepareAgentToolCall(
      {
        callId: 'call-1',
        toolId: 'agent_run_sub_agent',
        input: { profileId: 'built-in:script-analyst', assignment: '分析' },
      },
      scoped,
    );
    expect(prepared.ok).toBe(false);
  });

  it('子任务不能再派子智能体', () => {
    useAppStore.setState({
      agentTasks: [parentTask({ parentTaskId: 'grandparent', expertDepth: 1 })],
    });
    const authorized = getAgentTool('agent_run_sub_agent')?.authorize?.(context, {
      profileId: 'built-in:script-analyst',
      assignment: '分析',
    });
    expect(authorized?.allowed).toBe(false);
    expect(authorized?.reason).toContain('不能再派出');
  });

  it('父任务上下文失效时拒绝', () => {
    useAppStore.setState({ agentTasks: [] });
    expect(getAgentTool('agent_run_sub_agent')?.authorize?.(context, {
      profileId: 'built-in:script-analyst',
      assignment: '分析',
    })?.allowed).toBe(false);
  });

  it('profileId 不存在时拒绝', () => {
    expect(getAgentTool('agent_run_sub_agent')?.authorize?.(context, {
      profileId: 'nope',
      assignment: '分析',
    })?.allowed).toBe(false);
  });
});

describe('执行', () => {
  it('返回产出并标注只读与落地责任', async () => {
    const result = await run({ profileId: 'built-in:storyboard-artist', assignment: '做分镜' });
    expect(result.status).toBe('success');
    expect(result.modelContent).toContain('分镜表内容');
    expect(result.modelContent).toContain('只读');
    expect(result.modelContent).toContain('用户确认');
  });

  it('不修改父任务的 toolAllowlist', async () => {
    const scoped: AgentToolContext = { ...context, toolAllowlist: ['agent_run_sub_agent'] };
    await run({ profileId: 'built-in:script-analyst', assignment: '分析' }, scoped);
    expect(scoped.toolAllowlist).toEqual(['agent_run_sub_agent']);
    const parent = useAppStore.getState().agentTasks.find((task) => task.id === 'parent-1');
    expect(parent?.toolAllowlist).toBeUndefined();
  });

  it('运行失败时返回带错误码的结果而不是抛错', async () => {
    runSubAgentMock.mockRejectedValue(new Error('子智能体执行失败'));
    const result = await run({ profileId: 'built-in:script-analyst', assignment: '分析' });
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('SUB_AGENT_ERROR');
  });

  it('取消时向上抛出，不吞掉中止信号', async () => {
    const controller = new AbortController();
    controller.abort();
    runSubAgentMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(run(
      { profileId: 'built-in:script-analyst', assignment: '分析' },
      { signal: controller.signal },
    )).rejects.toThrow();
  });

  it('摘要里的名称与分派内容被压成单行', async () => {
    useAppStore.setState({
      subAgentProfiles: [customProfile({ name: '台词\n润色师' })],
    });
    const summary = getAgentTool('agent_run_sub_agent')?.summarizeInput?.({
      profileId: 'custom-1',
      assignment: '润色\n第一场',
    });
    expect(summary).toContain('台词 润色师');
    expect(summary?.split('\n')).toHaveLength(1);
  });
});

describe('系统提示词索引', () => {
  it('列出内置典范与自定义配置', () => {
    useAppStore.setState({ subAgentProfiles: [customProfile()] });
    const prompt = buildSubAgentCatalogPrompt();
    expect(prompt).toContain('剧本分析师');
    expect(prompt).toContain('分镜师');
    expect(prompt).toContain('台词润色师');
    expect(prompt).toContain('profileId: custom-1');
    expect(prompt).toContain('不可信');
  });

  it('注入到 Agent 分支的系统提示词并附带使用规则', () => {
    const prompt = buildAssistantSystemPrompt({ agentTools: true });
    expect(prompt).toContain('可用子智能体');
    expect(prompt).toContain('agent_run_sub_agent');
    expect(prompt).toContain('同一轮内发起多次调用即可并行');
    expect(prompt).toContain('由你自己调用画布工具，按当前模式处理确认');
  });

  it('旧命令分支不注入子智能体索引', () => {
    expect(buildAssistantSystemPrompt()).not.toContain('可用子智能体');
  });
});
