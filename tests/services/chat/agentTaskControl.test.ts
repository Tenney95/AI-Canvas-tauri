/**
 * agentTaskControl — 回归测试：agent replan requests。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTask, AgentTaskStatus } from '../../../src/types/agent';
import {
  consumeAgentReplanRequest,
  prepareAgentTaskResume,
  requestAgentReplan,
  runAgentTask,
  skipAgentStep,
  stopConversationAgentTasks,
  stopProjectAgentTasks,
  validateTaskResumable,
  waitForAgentApproval,
  resolveAgentApproval,
} from '../../../src/services/chat/agentTaskControl';
import { MCP_SETTINGS_CONVERSATION_ID, MCP_SETTINGS_SCOPE_ID, MCP_SETTINGS_TOOL_NAMES } from '../../../src/services/mcp/mcpSettingsScope';
import { DEFAULT_AGENT_TASK_BUDGET } from '../../../src/types/agent';
import {
  getConversationAgentQueueTaskIds,
  resetAgentSchedulerForTests,
  scheduleConversationAgentExecution,
} from '../../../src/services/chat/agentScheduler';
import { useAppStore } from '../../../src/store/useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../../src/services/chat/assistantScope';
import { createDefaultTeamProfile } from '../../../src/services/chat/teams/teamProfileService';

function createTask(
  id: string,
  projectId: string,
  conversationId: string,
  status: AgentTaskStatus = 'queued',
): AgentTask {
  return {
    id,
    projectId,
    conversationId,
    userMessageId: `message-${id}`,
    mode: 'autonomous',
    goal: `goal-${id}`,
    status,
    steps: [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: {
      maxModelRounds: 12,
      maxToolCalls: 24,
      maxParallelReadTools: 3,
      maxReadRetries: 3,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  resetAgentSchedulerForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
  resetAgentSchedulerForTests();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function arrangeTask(task: AgentTask): AgentTask {
  useAppStore.setState({
    currentProjectId: task.projectId,
    agentTasks: [task],
    conversations: [{
      id: task.conversationId,
      projectId: task.projectId,
      title: 'Resume test',
      titleSource: 'auto',
      pinned: false,
      archived: false,
      agentMode: 'autonomous',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    }],
  });
  return task;
}

function readTask(id: string): AgentTask {
  return useAppStore.getState().agentTasks.find((task) => task.id === id)!;
}

describe('工作台绑定分集的任务控制范围', () => {
  function arrangeSiblingTeam(status: AgentTaskStatus = 'paused'): AgentTask {
    const task = createTask('workbench-team', 'episode-b', 'conv-workbench', status);
    task.executionKind = 'team';
    task.teamRun = { version: 1, revision: 1, id: task.id, templateId: 'script', source: 'script-workbench',
      target: { kind: 'episode', seriesId: 'series-workbench', episodeId: 'episode-b', field: 'script',
        expectedHash: 'a'.repeat(64), label: '第二集正文' },
      profile: createDefaultTeamProfile('general/test'),
      inputArtifact: { id: 'input', kind: 'input', label: '材料', relativePath: 'input.json',
        sha256: 'a'.repeat(64), bytes: 1, createdAt: 1, parentArtifactIds: [] },
      modelFingerprints: { architect: '', writer: '', continuity: '', dialogue: '', editor: '' },
      artifacts: [], stages: [], callsUsed: 0, budgetTokensUsed: 0, usageKnown: false,
      usageReportedCalls: 0, unknownUsageCalls: 0, createdAt: 1,
    };
    arrangeTask(task);
    useAppStore.setState({ currentProjectId: 'episode-a', projectLoadStatus: 'ready',
      activeConversationId: task.conversationId, projects: [
        { id: 'series-workbench', name: '剧集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-a', parentId: 'series-workbench', name: '第一集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-b', parentId: 'series-workbench', name: '第二集', createdAt: 1, updatedAt: 1 },
      ] });
    useAppStore.getState().updateConversation(task.conversationId, { projectId: 'series-workbench' });
    return task;
  }

  it('同剧集工作台任务可继续，普通助手任务和其他剧集仍被拒绝', () => {
    const task = arrangeSiblingTeam();
    expect(validateTaskResumable(task.id).ok).toBe(true);
    useAppStore.setState({ agentTasks: [{ ...task, teamRun: { ...task.teamRun!, source: 'assistant' } }] });
    expect(validateTaskResumable(task.id).errorCode).toBe('AGENT_RESUME_PROJECT_NOT_ACTIVE');
    useAppStore.setState({ agentTasks: [task], projects: [
      ...useAppStore.getState().projects,
      { id: 'unrelated-project', name: '其他项目', createdAt: 1, updatedAt: 1 },
    ], currentProjectId: 'unrelated-project' });
    expect(validateTaskResumable(task.id).errorCode).toBe('AGENT_RESUME_PROJECT_NOT_ACTIVE');
  });

  it('审批例外只允许原团队成果保存，不能批准其他画布工具', async () => {
    for (const toolId of ['agent_team_apply_result', 'canvas_create_nodes']) {
      const task = arrangeSiblingTeam('waiting_approval');
      task.steps = [{ id: 'workbench-step', taskId: task.id, index: 0, kind: 'approval', title: '保存团队候选',
        status: 'waiting_approval', createdAt: 1, updatedAt: 1,
        approval: { id: 'workbench-approval', kind: 'file_write', status: 'pending', summary: '保存', requestedAt: 1 },
        toolCall: { callId: 'workbench-call', toolId, effect: 'file_write', inputSummary: '保存候选', retryCount: 0 },
      }];
      useAppStore.setState({ agentTasks: [task] });
      const controller = new AbortController();
      const pending = waitForAgentApproval('workbench-approval', controller.signal);
      const accepted = resolveAgentApproval('workbench-approval', { approved: true });
      expect(accepted).toBe(toolId === 'agent_team_apply_result');
      if (accepted) await expect(pending).resolves.toMatchObject({ approved: true });
      else { controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); }
      expect(useAppStore.getState().currentProjectId).toBe('episode-a');
    }
  });
});

it('allows global settings choices only from their active conversation and approved tool scope', async () => {
  const task = { ...createTask('global-choice', MCP_SETTINGS_SCOPE_ID, MCP_SETTINGS_CONVERSATION_ID, 'waiting_approval'),
    toolAllowlist: [...MCP_SETTINGS_TOOL_NAMES], steps: [{
      id: 'choice-step', taskId: 'global-choice', index: 0, kind: 'tool' as const, title: 'Choose', status: 'waiting_approval' as const,
      createdAt: 1, updatedAt: 1, approval: { id: 'global-approval', kind: 'user_choice' as const, status: 'pending' as const, summary: 'Choose', requestedAt: 1 },
      toolCall: { callId: 'choice', toolId: 'provider_models_select', effect: 'user_choice' as const, inputSummary: 'Choose', retryCount: 0 },
    }] };
  useAppStore.setState({ currentProjectId: null, activeConversationId: 'other-conversation', agentTasks: [task] });
  const controller = new AbortController();
  const pending = waitForAgentApproval('global-approval', controller.signal);
  expect(resolveAgentApproval('global-approval', { approved: true })).toBe(false);
  useAppStore.setState({ activeConversationId: MCP_SETTINGS_CONVERSATION_ID });
  useAppStore.getState().updateAgentTask(task.id, { toolAllowlist: [...MCP_SETTINGS_TOOL_NAMES, 'canvas_update'] });
  expect(resolveAgentApproval('global-approval', { approved: true })).toBe(false);
  useAppStore.getState().updateAgentTask(task.id, { toolAllowlist: [...MCP_SETTINGS_TOOL_NAMES] });
  expect(resolveAgentApproval('global-approval', { approved: true })).toBe(true);
  await expect(pending).resolves.toEqual({ approved: true });
});

describe('agent replan requests', () => {
  it('keeps the replan request until the runtime consumes it', () => {
    arrangeTask(createTask('task-replan', 'project-1', 'conversation-1', 'paused'));

    requestAgentReplan('task-replan');
    expect(readTask('task-replan')).toMatchObject({
      status: 'paused',
      pausedReason: 'replan_requested',
      replanRequest: { reason: 'user_requested' },
    });

    // 继续前的清理会抹掉 pausedReason，重新规划要求必须活到组装模型上下文时
    prepareAgentTaskResume('task-replan');
    expect(readTask('task-replan').pausedReason).toBeUndefined();
    expect(readTask('task-replan').replanRequest).toMatchObject({ reason: 'user_requested' });

    consumeAgentReplanRequest('task-replan');
    expect(readTask('task-replan').replanRequest).toBeUndefined();
  });

  it('requests a replan when a pending step is skipped', () => {
    const task = createTask('task-skip', 'project-1', 'conversation-1', 'running');
    arrangeTask({
      ...task,
      steps: [{
        id: 'step-1',
        taskId: task.id,
        index: 0,
        kind: 'tool',
        title: 'Write canvas',
        status: 'waiting_approval',
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    skipAgentStep('task-skip', 'step-1');

    expect(readTask('task-skip')).toMatchObject({
      status: 'paused',
      pausedReason: 'step_skipped_replan_required',
      replanRequest: { reason: 'step_skipped' },
    });
  });
});

describe('agent resume validation', () => {
  it('can resume a general conversation without opening a project', () => {
    const task = createTask('general-paused', GENERAL_ASSISTANT_SCOPE_ID, 'conv-general', 'paused');
    arrangeTask(task);
    useAppStore.setState({ currentProjectId: null });
    expect(validateTaskResumable(task.id)).toEqual({ ok: true });
  });

  it('allows resuming a paused task below the lifetime cap', () => {
    arrangeTask(createTask('task-fresh', 'project-1', 'conversation-1', 'paused'));
    expect(validateTaskResumable('task-fresh')).toEqual({ ok: true });
  });

  it('refuses to resume a task that is already running or queued', () => {
    arrangeTask(createTask('task-queued', 'project-1', 'conversation-1', 'paused'));
    const running = deferred();
    scheduleConversationAgentExecution({
      taskId: 'other-task',
      conversationId: 'conversation-1',
      run: () => running.promise,
    });
    scheduleConversationAgentExecution({
      taskId: 'task-queued',
      conversationId: 'conversation-1',
      run: async () => undefined,
    });

    // 会话内有任务在跑，被恢复的任务只是排队，状态仍是 paused
    expect(readTask('task-queued').status).toBe('paused');
    expect(validateTaskResumable('task-queued')).toMatchObject({
      ok: false,
      errorCode: 'AGENT_RESUME_ALREADY_SCHEDULED',
    });

    running.resolve();
  });

  it('refuses to resume once the lifetime budget is exhausted', () => {
    arrangeTask({
      ...createTask('task-spent', 'project-1', 'conversation-1', 'paused'),
      modelRounds: DEFAULT_AGENT_TASK_BUDGET.maxTotalModelRounds,
    });

    expect(validateTaskResumable('task-spent')).toMatchObject({
      ok: false,
      errorCode: 'AGENT_LIFETIME_BUDGET_EXHAUSTED',
    });
  });

  it('refuses to resume after the maximum number of resumes', () => {
    arrangeTask({
      ...createTask('task-looped', 'project-1', 'conversation-1', 'failed'),
      resumeCount: DEFAULT_AGENT_TASK_BUDGET.maxResumes,
    });

    expect(validateTaskResumable('task-looped')).toMatchObject({
      ok: false,
      errorCode: 'AGENT_LIFETIME_BUDGET_EXHAUSTED',
    });
  });
});

describe('agent task control', () => {
  it('resolves a general file approval only from its active conversation and retained tool scope', async () => {
    const task = { ...createTask('general-approval-task', GENERAL_ASSISTANT_SCOPE_ID, 'conv-general', 'waiting_approval'),
      toolAllowlist: ['file_write_text'], steps: [{
        id: 'general-step', taskId: 'general-approval-task', index: 0, kind: 'approval' as const, title: 'Save',
        status: 'waiting_approval' as const, createdAt: 1, updatedAt: 1,
        approval: { id: 'general-save-approval', kind: 'file_write' as const, status: 'pending' as const, summary: 'Save', requestedAt: 1 },
        toolCall: { callId: 'general-save', toolId: 'file_write_text', effect: 'file_write' as const, inputSummary: 'Save', retryCount: 0 },
      }] };
    arrangeTask(task);
    useAppStore.setState({ currentProjectId: null, activeConversationId: 'another-conversation' });
    const pending = waitForAgentApproval('general-save-approval', new AbortController().signal);
    expect(resolveAgentApproval('general-save-approval', { approved: true })).toBe(false);
    useAppStore.setState({ activeConversationId: task.conversationId });
    useAppStore.getState().updateAgentTask(task.id, { toolAllowlist: [] });
    expect(resolveAgentApproval('general-save-approval', { approved: true })).toBe(false);
    useAppStore.getState().updateAgentTask(task.id, { toolAllowlist: ['file_write_text'] });
    expect(resolveAgentApproval('general-save-approval', { approved: true })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true });
  });

  it('synchronously aborts active work and clears queued work for a deleted conversation', async () => {
    const conversationId = 'conversation-target';
    useAppStore.setState({
      agentTasks: [
        createTask('task-active', 'project-1', conversationId),
        createTask('task-queued', 'project-1', conversationId),
      ],
    });

    let activeSignal: AbortSignal | undefined;
    const running = runAgentTask('task-active', async (signal) => {
      activeSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return 'paused';
    });

    let releaseScheduledExecution: (() => void) | undefined;
    scheduleConversationAgentExecution({
      taskId: 'task-active',
      conversationId,
      run: () => new Promise<void>((resolve) => {
        releaseScheduledExecution = resolve;
      }),
    });
    scheduleConversationAgentExecution({
      taskId: 'task-queued',
      conversationId,
      run: async () => undefined,
    });

    expect(getConversationAgentQueueTaskIds(conversationId)).toEqual(['task-queued']);

    stopConversationAgentTasks(conversationId);

    expect(activeSignal?.aborted).toBe(true);
    expect(getConversationAgentQueueTaskIds(conversationId)).toEqual([]);
    expect(useAppStore.getState().agentTasks.map((task) => [task.id, task.status])).toEqual([
      ['task-active', 'stopped'],
      ['task-queued', 'stopped'],
    ]);

    releaseScheduledExecution?.();
    await running;
  });

  it('stops only non-terminal tasks in the deleted project', () => {
    useAppStore.setState({
      agentTasks: [
        createTask('target-running', 'project-target', 'conversation-a', 'running'),
        createTask('target-completed', 'project-target', 'conversation-b', 'completed'),
        createTask('other-queued', 'project-other', 'conversation-c'),
      ],
    });

    stopProjectAgentTasks('project-target');

    expect(useAppStore.getState().agentTasks.map((task) => [task.id, task.status])).toEqual([
      ['target-running', 'stopped'],
      ['target-completed', 'completed'],
      ['other-queued', 'queued'],
    ]);
  });
});
