import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationAgentExecution } from '../../../src/services/chat/agentScheduler';
import type { AgentTeamRun } from '../../../src/types/agentTeam';
import type { CanvasProject } from '../../../src/types';

const runtime = vi.hoisted(() => ({
  capture: vi.fn(), prepare: vi.fn(), execute: vi.fn(), save: vi.fn(), load: vi.fn(),
  scheduled: [] as ConversationAgentExecution[],
}));

vi.mock('../../../src/services/chat/teams/teamRuntime', () => ({
  MAX_TEAM_INPUT_CHARS: 60000,
  captureTeamModelFingerprints: runtime.capture,
  prepareTeamRun: runtime.prepare,
  executeTeamRun: runtime.execute,
  amendTeamRun: vi.fn(), waitForTeamRunIdle: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/chat/teams/teamArtifactService', () => ({
  hashTeamText: async (text: string) => `test-digest:${text}`,
  readTeamArtifactText: vi.fn(async () => '正文'),
}));
vi.mock('../../../src/services/chat/agentTaskService', () => ({
  saveAgentTask: runtime.save, loadAgentTask: runtime.load,
}));
vi.mock('../../../src/services/chat/chatHistoryService', () => ({
  saveConversation: vi.fn(async () => {}),
  persistMessage: vi.fn(async () => {}),
  clearConversationMessages: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/chat/agentScheduler', () => ({
  scheduleConversationAgentExecution: (execution: ConversationAgentExecution) => {
    runtime.scheduled.push(execution); return { state: 'queued', position: 1 };
  },
  isAgentExecutionScheduled: () => false,
  cancelConversationAgentExecutions: () => [],
}));

import { useAppStore } from '../../../src/store/useAppStore';
import { pauseAgentTask } from '../../../src/services/chat/agentTaskControl';
import { createDefaultTeamProfile } from '../../../src/services/chat/teams/teamProfileService';
import { startTeamInvocation, submitTeamInvocation } from '../../../src/services/chat/teams/teamInvocationService';

function prepared(taskId: string): AgentTeamRun {
  const profile = createDefaultTeamProfile('general/test-model');
  return {
    version: 1, revision: 1, id: taskId, templateId: 'general', source: 'assistant', profile,
    inputArtifact: { id: 'input-test', kind: 'input', label: '材料', relativePath: 'agent-teams/input.json',
      sha256: 'a'.repeat(64), bytes: 20, createdAt: 1, parentArtifactIds: [] },
    modelFingerprints: { architect: 'a', writer: 'a', continuity: 'a', dialogue: 'a', editor: 'a' },
    stages: [], artifacts: [], callsUsed: 0, budgetTokensUsed: 0, usageKnown: false,
    usageReportedCalls: 0, unknownUsageCalls: 0, createdAt: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.scheduled.length = 0;
  runtime.capture.mockResolvedValue({ architect: 'a', writer: 'a', continuity: 'a', dialogue: 'a', editor: 'a' });
  runtime.prepare.mockImplementation(async (input: { taskId: string }) => prepared(input.taskId));
  runtime.execute.mockResolvedValue('completed');
  runtime.save.mockResolvedValue(undefined);
  runtime.load.mockResolvedValue(null);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-team', projectLoadStatus: 'ready', activeConversationId: 'conv-team',
    projects: [{ id: 'project-team', name: '团队测试', nodes: [], edges: [], createdAt: 1, updatedAt: 1 } as CanvasProject],
    conversations: [{ id: 'conv-team', projectId: 'project-team', title: '团队测试', titleSource: 'user',
      pinned: false, archived: false, agentMode: 'autonomous', createdAt: 1, updatedAt: 1, messageCount: 0 }],
    config: { ...useAppStore.getState().config, assistantModelId: undefined,
      agentTeamProfile: createDefaultTeamProfile('general/test-model') },
  });
});

describe('团队共用发起入口', () => {
  it('无普通助手模型也按角色准备，重复转发同一次请求只创建和排队一次', async () => {
    const input = { content: '共同审查开场结构', projectId: 'project-team', conversationId: 'conv-team',
      templateId: 'general' as const, requestId: 'request-team-duplicate' };
    const first = submitTeamInvocation(input);
    const second = await startTeamInvocation(input);
    expect(second.taskId).toBe(first.taskId);
    expect(runtime.prepare).toHaveBeenCalledTimes(1);
    expect(runtime.scheduled).toHaveLength(1);
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks).toHaveLength(1);
    expect(useAppStore.getState().config.assistantModelId).toBeUndefined();
    expect(useAppStore.getState().agentTasks[0].executionKind).toBe('team');
  });

  it('同一次请求身份不能更换内容，不能借去重键偷偷提交另一项任务', async () => {
    const input = { content: '处理原要求', projectId: 'project-team', conversationId: 'conv-team',
      templateId: 'general' as const, requestId: 'request-team-conflict' };
    const pending = startTeamInvocation(input);
    expect(() => submitTeamInvocation({ ...input, content: '完全不同的新要求' })).toThrow('同一请求身份');
    await pending;
    expect(runtime.prepare).toHaveBeenCalledTimes(1);
  });

  it('输入文件准备期间暂停后不得被迟到的准备回调启动', async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let release!: (run: AgentTeamRun) => void;
    runtime.prepare.mockImplementation(() => {
      signalEntered(); return new Promise<AgentTeamRun>((resolve) => { release = resolve; });
    });
    const requestId = 'request-team-pause';
    const pending = startTeamInvocation({ content: '准备期间暂停', projectId: 'project-team', conversationId: 'conv-team',
      templateId: 'general', requestId });
    await entered;
    pauseAgentTask(`team-${requestId}`);
    release(prepared(`team-${requestId}`));
    await pending;
    expect(runtime.scheduled).toHaveLength(0);
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].status).toBe('paused');
  });

  it('工作台没有显式继承来源模式时用B，不能借当前会话C提升写权限', async () => {
    const result = await startTeamInvocation({ content: '工作台候选', projectId: 'project-team', conversationId: 'conv-team',
      templateId: 'general', requestId: 'request-team-workbench-mode', context: { source: 'script-workbench' } });
    expect(useAppStore.getState().agentTasks.find((task) => task.id === result.taskId)?.mode).toBe('collaborative');
  });

  it('清空来源消息撤销尚未创建任务的准备，但不封锁该会话的新请求', async () => {
    let release!: (value: AgentTeamRun['modelFingerprints']) => void;
    runtime.capture.mockImplementationOnce(() => new Promise<AgentTeamRun['modelFingerprints']>((resolve) => { release = resolve; }));
    const pending = startTeamInvocation({ content: '清空前的准备', projectId: 'project-team', conversationId: 'conv-team',
      templateId: 'general', requestId: 'request-team-clear-preparation' });
    useAppStore.getState().clearMessages();
    release(prepared('unused').modelFingerprints);
    await pending;
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.scheduled).toHaveLength(0);
    expect(useAppStore.getState().messages).toHaveLength(0);
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    await startTeamInvocation({ content: '清空后新任务', projectId: 'project-team', conversationId: 'conv-team',
      templateId: 'general', requestId: 'request-team-after-clear' });
    expect(runtime.prepare).toHaveBeenCalledTimes(1);
    expect(runtime.scheduled).toHaveLength(1);
  });

  it('清空消息同步停止已排队团队，迟到队列回调不能调用模型', async () => {
    const result = await startTeamInvocation({ content: '排队后清空', projectId: 'project-team', conversationId: 'conv-team',
      templateId: 'general', requestId: 'request-team-clear-queued' });
    useAppStore.getState().clearMessages();
    await runtime.scheduled[0].run();
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks.find((task) => task.id === result.taskId)?.status).toBe('stopped');
  });

  it('工作台可为同剧集另一个明确分集发起团队，保留当前画布与节点', async () => {
    useAppStore.setState({
      currentProjectId: 'episode-canvas',
      projects: [
        { id: 'series-team', name: '剧集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-canvas', parentId: 'series-team', name: '画布当前集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-workbench', parentId: 'series-team', name: '工作台所选集', createdAt: 1, updatedAt: 1 },
      ],
    });
    useAppStore.getState().updateConversation('conv-team', { projectId: 'series-team' });
    const nodesBefore = useAppStore.getState().nodes;
    const result = await startTeamInvocation({ content: '处理工作台选中集', projectId: 'episode-workbench',
      conversationId: 'conv-team', templateId: 'general', requestId: 'request-team-workbench-sibling',
      context: { source: 'script-workbench', target: { kind: 'episode', seriesId: 'series-team',
        episodeId: 'episode-workbench', field: 'script', expectedHash: 'a'.repeat(64), label: '工作台所选集正文' } },
      materials: '已保存材料', originalText: '原稿',
    });
    expect(useAppStore.getState().currentProjectId).toBe('episode-canvas');
    expect(useAppStore.getState().nodes).toBe(nodesBefore);
    expect(useAppStore.getState().agentTasks.find((task) => task.id === result.taskId)?.projectId).toBe('episode-workbench');
    expect(runtime.prepare).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'episode-workbench' }));
  });

  it('普通助手不能借目标字段取得非当前分集权限，工作台也不能跨剧集', () => {
    useAppStore.setState({ projects: [
      ...useAppStore.getState().projects,
      { id: 'other-series', name: '其他剧集', createdAt: 1, updatedAt: 1 },
      { id: 'other-episode', parentId: 'other-series', name: '其他分集', createdAt: 1, updatedAt: 1 },
    ] });
    const target = { kind: 'episode' as const, seriesId: 'other-series', episodeId: 'other-episode',
      field: 'script' as const, expectedHash: 'a'.repeat(64), label: '其他分集正文' };
    for (const source of ['assistant', 'script-workbench'] as const) {
      expect(() => submitTeamInvocation({ content: '不得越界', projectId: 'other-episode',
        templateId: 'general', requestId: `request-team-invalid-${source}`,
        context: { source, target }, materials: '材料', originalText: '原稿',
      })).toThrow('请先打开');
    }
    expect(runtime.prepare).not.toHaveBeenCalled();
  });

  it('拒绝跨项目会话和超过总上限的材料，未进入模型准备或队列', () => {
    useAppStore.getState().updateConversation('conv-team', { projectId: 'other-project' });
    expect(() => submitTeamInvocation({ content: '不应发送', projectId: 'project-team', conversationId: 'conv-team',
      templateId: 'general', requestId: 'request-team-other-scope' })).toThrow('来源对话');
    useAppStore.getState().updateConversation('conv-team', { projectId: 'project-team' });
    expect(() => submitTeamInvocation({ content: '不截断材料', materials: '长'.repeat(60000), projectId: 'project-team',
      conversationId: 'conv-team', templateId: 'general', requestId: 'request-team-over-limit' })).toThrow('总上限');
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.scheduled).toHaveLength(0);
  });
});
