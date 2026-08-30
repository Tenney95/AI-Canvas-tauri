import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentScheduleResult } from '../../../src/services/chat/agentScheduler';

const schedulerMocks = vi.hoisted(() => {
  // 记录已入队的任务，让 isAgentExecutionScheduled 能反映真实调度器的去重行为
  const scheduledTaskIds = new Set<string>();
  return {
    activeTaskId: undefined as string | undefined,
    scheduledTaskIds,
    schedule: vi.fn((execution: { taskId: string }): AgentScheduleResult => {
      scheduledTaskIds.add(execution.taskId);
      return { state: 'started', position: 0 };
    }),
    isScheduled: vi.fn((taskId: string) => scheduledTaskIds.has(taskId)),
  };
});

const interjectionMocks = vi.hoisted(() => ({
  enqueue: vi.fn(() => true),
}));

vi.mock('../../../src/services/chat/agentScheduler', () => ({
  getActiveConversationAgentTaskId: () => schedulerMocks.activeTaskId,
  scheduleConversationAgentExecution: schedulerMocks.schedule,
  isAgentExecutionScheduled: schedulerMocks.isScheduled,
}));

vi.mock('../../../src/services/chat/agentInterjection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/chat/agentInterjection')>(),
  enqueueAgentInterjection: interjectionMocks.enqueue,
}));

vi.mock('../../../src/services/chat/tools', () => ({
  ensureAgentToolsRegistered: vi.fn(),
}));

import {
  resumeAgentTaskExecution,
  submitConversationMessage,
} from '../../../src/services/chat/conversationExecutionController';
import { useAppStore } from '../../../src/store/useAppStore';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';

function arrangeConversation(): void {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    activeConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Controller test',
      titleSource: 'auto',
      pinned: false,
      archived: false,
      agentMode: 'collaborative',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    }],
    messages: [],
    agentTasks: [],
  });
}

beforeEach(() => {
  arrangeConversation();
  schedulerMocks.activeTaskId = undefined;
  schedulerMocks.scheduledTaskIds.clear();
  schedulerMocks.schedule.mockReset();
  schedulerMocks.schedule.mockImplementation((execution: { taskId: string }) => {
    schedulerMocks.scheduledTaskIds.add(execution.taskId);
    return { state: 'started', position: 0 };
  });
  schedulerMocks.isScheduled.mockReset();
  schedulerMocks.isScheduled.mockImplementation(
    (taskId: string) => schedulerMocks.scheduledTaskIds.has(taskId),
  );
  interjectionMocks.enqueue.mockReset();
  interjectionMocks.enqueue.mockReturnValue(true);
});

describe('conversation execution controller', () => {
  it('creates the message pair and schedules one Agent task', () => {
    const result = submitConversationMessage({
      content: '  update the canvas  ',
      conversationId: 'conversation-1',
    });

    expect(result.status).toBe('started');
    const state = useAppStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))).toEqual([
      { role: 'user', content: 'update the canvas' },
      { role: 'assistant', content: '' },
    ]);
    expect(state.agentTasks).toHaveLength(1);
    expect(state.messages[1].agentTaskId).toBe(state.agentTasks[0].id);
    expect(schedulerMocks.schedule).toHaveBeenCalledWith(expect.objectContaining({
      taskId: state.agentTasks[0].id,
      conversationId: 'conversation-1',
    }));
  });

  it('captures explicit Skill content and tool restrictions when the task is created', () => {
    useAppStore.setState({
      userSkills: [{
        id: 'skill-1',
        name: 'Canvas audit',
        description: 'Audit the canvas',
        fileName: 'SKILL.md',
        content: '---\nname: Canvas audit\n---\n\n# Fixed audit rules',
        sourceType: 'file',
        manifest: {
          version: '2.0.0',
          allowedTools: ['canvas_get_state'],
        },
        createdAt: 1,
      }],
    });

    submitConversationMessage({
      content: '检查当前项目 @skill{skill-1|Canvas audit}',
      conversationId: 'conversation-1',
    });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.skillBindings).toEqual([{
      skillId: 'skill-1',
      name: 'Canvas audit',
      version: '2.0.0',
      content: '# Fixed audit rules',
      origin: 'user',
      allowedTools: ['canvas_get_state'],
    }]);
    expect(task.toolAllowlist).toEqual(['canvas_get_state']);
  });

  it('snapshots an explicitly selected AgentPackage Skill before the package is disabled', () => {
    useAppStore.setState({
      agentPackageSkills: [{
        id: 'ap-skill-1',
        name: '短剧分镜',
        description: '生成短剧分镜',
        fileName: 'SKILL.md',
        content: '---\nversion: 1.4.1\n---\n# 固定分镜规则',
        sourceType: 'agent-package',
        manifest: { version: '1.4.1', allowedTools: ['canvas_get_state'] },
        createdAt: 2,
        installationId: 'installation-1',
        packageId: 'legacy.drama',
        packageName: 'AI短剧知识库',
        packageVersion: '0.0.0-legacy',
        packageContentHash: 'a'.repeat(64),
        sourceId: 'source:opaque',
        entryPath: '04-分镜设计/storyboard-script/SKILL.md',
        skillRoot: '04-分镜设计/storyboard-script',
        contentHash: 'b'.repeat(64),
        branch: 'domestic',
        packageUserInvocable: true,
        packageAutoInvoke: false,
        mcpSkillReadEnabled: false,
        readOnly: true,
      }],
    });

    submitConversationMessage({
      content: '生成分镜 @skill{ap-skill-1|短剧分镜}',
      conversationId: 'conversation-1',
    });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.skillBindings).toEqual([expect.objectContaining({
      skillId: 'ap-skill-1',
      content: '# 固定分镜规则',
      origin: 'agent-package',
      packageName: 'AI短剧知识库',
      entryPath: '04-分镜设计/storyboard-script/SKILL.md',
      contentHash: 'b'.repeat(64),
    })]);
    useAppStore.setState({ agentPackageSkills: [] });
    expect(task.skillBindings?.[0].content).toBe('# 固定分镜规则');
  });

  it('rejects more explicit Skills than can be represented by the task snapshot', () => {
    useAppStore.setState({
      userSkills: Array.from({ length: 5 }, (_, index) => ({
        id: `skill-${index + 1}`,
        name: `Skill ${index + 1}`,
        description: 'Test skill',
        fileName: 'SKILL.md',
        content: `# Skill ${index + 1}`,
        sourceType: 'file' as const,
        createdAt: index + 1,
      })),
    });
    const refs = useAppStore.getState().userSkills
      .map((item) => `@skill{${item.id}|${item.name}}`)
      .join(' ');

    const result = submitConversationMessage({
      content: `检查画布 ${refs}`,
      conversationId: 'conversation-1',
    });

    expect(result).toMatchObject({ status: 'started', taskId: undefined });
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    expect(useAppStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'error',
      content: '处理失败: 单个任务最多注入 4 个 Skill',
    });
  });

  it('records an interjection without creating another assistant task', () => {
    schedulerMocks.activeTaskId = 'task-active';

    const result = submitConversationMessage({
      content: 'also use the selected nodes',
      conversationId: 'conversation-1',
      dispatchMode: 'interject',
    });

    expect(result).toEqual({ status: 'interjected', taskId: 'task-active' });
    expect(useAppStore.getState().messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'also use the selected nodes',
        agentTaskId: 'task-active',
      }),
    ]);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
  });
});

function arrangePausedTask(partial: Partial<AgentTask> = {}): AgentTask {
  const task: AgentTask = {
    id: 'task-paused',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-user',
    mode: 'autonomous',
    goal: 'keep going',
    status: 'paused',
    steps: [],
    modelRounds: 12,
    toolCallCount: 24,
    resumeCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET },
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
  useAppStore.setState({
    agentTasks: [task],
    messages: [{
      id: 'message-assistant',
      conversationId: 'conversation-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'done',
      agentTaskId: task.id,
    }],
  });
  return task;
}

describe('agent task resume budget', () => {
  it('counts the resume and widens the segment budget within the lifetime cap', () => {
    arrangePausedTask();

    expect(resumeAgentTaskExecution('task-paused')).toEqual({ ok: true });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.resumeCount).toBe(1);
    expect(task.budget).toMatchObject({ maxModelRounds: 24, maxToolCalls: 48 });
    expect(schedulerMocks.schedule).toHaveBeenCalledTimes(1);
  });

  it('refuses a second resume while the task is still queued', () => {
    arrangePausedTask();

    expect(resumeAgentTaskExecution('task-paused')).toEqual({ ok: true });
    expect(resumeAgentTaskExecution('task-paused')).toMatchObject({
      ok: false,
      errorCode: 'AGENT_RESUME_ALREADY_SCHEDULED',
    });

    // 第二次点击既不能重复入队，也不能再吃掉一次继续额度
    expect(schedulerMocks.schedule).toHaveBeenCalledTimes(1);
    const task = useAppStore.getState().agentTasks[0];
    expect(task.resumeCount).toBe(1);
    expect(task.budget.maxModelRounds).toBe(24);
  });

  it('marks a queued resume as queued so the UI stops offering 继续', () => {
    arrangePausedTask();
    schedulerMocks.schedule.mockImplementationOnce((execution: { taskId: string }) => {
      schedulerMocks.scheduledTaskIds.add(execution.taskId);
      return { state: 'queued', position: 1 };
    });

    expect(resumeAgentTaskExecution('task-paused')).toEqual({ ok: true });

    expect(useAppStore.getState().agentTasks[0].status).toBe('queued');
    expect(useAppStore.getState().messages[0].status).toBe('queued');
  });

  it('refuses to resume and stops widening the budget at the lifetime cap', () => {
    const spent = DEFAULT_AGENT_TASK_BUDGET.maxTotalModelRounds;
    arrangePausedTask({
      modelRounds: spent,
      resumeCount: 4,
      budget: { ...DEFAULT_AGENT_TASK_BUDGET, maxModelRounds: spent },
    });

    expect(resumeAgentTaskExecution('task-paused')).toMatchObject({
      ok: false,
      errorCode: 'AGENT_LIFETIME_BUDGET_EXHAUSTED',
    });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.resumeCount).toBe(4);
    expect(task.budget.maxModelRounds).toBe(spent);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
  });
});
