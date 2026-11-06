import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({ model: vi.fn(), schedule: vi.fn(), capture: vi.fn() }));

vi.mock('../../../src/services/ai/assistantStream', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/ai/assistantStream')>(),
  resolveAssistantModel: runtimeMocks.model,
}));
vi.mock('../../../src/services/chat/agentScheduler', () => ({
  getActiveConversationAgentTaskId: () => undefined,
  scheduleConversationAgentExecution: runtimeMocks.schedule,
  isAgentExecutionScheduled: () => false,
}));
vi.mock('../../../src/services/chat/tools', () => ({ ensureAgentToolsRegistered: vi.fn() }));
vi.mock('../../../src/services/creationProfiles/creationProfileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/creationProfiles/creationProfileService')>(),
  captureCreationProfile: runtimeMocks.capture,
}));
vi.mock('../../../src/services/chat/chatHistoryService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/chat/chatHistoryService')>(),
  loadMessages: vi.fn(async () => ({ messages: [], total: 0 })),
  persistMessage: vi.fn(async () => undefined),
}));

import { useAppStore } from '../../../src/store/useAppStore';
import { startWorkbenchAgentInvocation } from '../../../src/services/chat/workbenchAgentInvocationService';
import { WORKBENCH_AGENT_READ_TOOLS } from '../../../src/services/episodeWorkspaceScope';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'episode-a', projectLoadStatus: 'ready', isCreatingProject: false,
    isReturningToStartPage: false, switchingProjectName: null,
    projects: [
      { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-a', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-b', parentId: 'series', name: '第二集', createdAt: 1, updatedAt: 1 },
      { id: 'other-series', name: '另一剧集', createdAt: 1, updatedAt: 1 },
    ],
    activeConversationId: 'conv-prior',
    conversations: [{ id: 'conv-prior', projectId: 'series', title: '原对话', titleSource: 'user', pinned: false,
      archived: false, agentMode: 'autonomous', createdAt: 1, updatedAt: 1, messageCount: 0,
      creationProfile: { id: 'prior-profile', version: '1.0.0', sha256: 'a'.repeat(64) },
      executionSelection: { kind: 'team', templateId: 'review' } }],
    messages: [], agentTasks: [], chatComposerLiveDraft: '原对话未发送草稿',
    chatComposerDraft: '其他入口遗留的待发送草稿', chatComposerDrafts: { 'conv-prior': '原对话保留的草稿' },
  });
  runtimeMocks.model.mockReset().mockReturnValue({ selectionId: 'general/text' });
  // 只记录调度，不调用 execution.run；本组不触发模型 Runtime。
  runtimeMocks.schedule.mockReset().mockReturnValue({ state: 'started', position: 0 });
  runtimeMocks.capture.mockReset().mockResolvedValue({ skillBindings: [] });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('工作台智能调度入口', () => {
  it('在同剧集另一分集建立独立只读任务，不切画布或继承原对话配置', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = startWorkbenchAgentInvocation({ episodeId: 'episode-b', content: '检查本集节奏', mode: 'plan' });
    const state = useAppStore.getState();
    const conversation = state.conversations.find((entry) => entry.id === result.conversationId)!;
    const task = state.agentTasks.find((entry) => entry.id === result.taskId)!;
    expect(conversation).toMatchObject({ projectId: 'series', agentMode: 'plan', executionSelection: { kind: 'single' },
      workbenchTarget: { seriesId: 'series', episodeId: 'episode-b' } });
    expect(conversation.id).not.toBe('conv-prior');
    expect(conversation.creationProfile).toBeUndefined();
    expect(task).toMatchObject({ projectId: 'episode-b', conversationId: conversation.id,
      workbenchTarget: { seriesId: 'series', episodeId: 'episode-b' }, toolAllowlist: [...WORKBENCH_AGENT_READ_TOOLS] });
    expect(task.executionKind).toBeUndefined();
    expect(task.creationProfile).toBeUndefined();
    expect(state.currentProjectId).toBe('episode-a');
    expect(state.chatComposerDraft).toBeNull();
    expect(state.chatComposerDrafts['conv-prior']).toBe('原对话保留的草稿');
    expect(runtimeMocks.capture).not.toHaveBeenCalled();
    expect(runtimeMocks.schedule).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['queued', 'planning', 'running', 'waiting_tool', 'waiting_approval'] as const)(
    '重复点击时复用仍处于 %s 的同目标同内容同模式任务，只定位原会话', (status) => {
      const input = { episodeId: 'episode-b', content: '检查本集节奏', mode: 'plan' as const };
      const first = startWorkbenchAgentInvocation(input);
      const state = useAppStore.getState();
      state.updateAgentTask(first.taskId, { status });
      state.setActiveConversation('conv-prior');
      useAppStore.setState({ chatComposerDraft: '另一条待发送草稿' });
      const messagesBefore = useAppStore.getState().messages.length;
      const second = startWorkbenchAgentInvocation({ ...input, content: `  ${input.content}  ` });
      const latest = useAppStore.getState();
      expect(second).toEqual(first);
      expect(latest.agentTasks).toHaveLength(1);
      expect(latest.conversations).toHaveLength(2);
      expect(latest.messages).toHaveLength(messagesBefore);
      expect(latest.activeConversationId).toBe(first.conversationId);
      expect(latest.agentTaskFocus?.taskId).toBe(first.taskId);
      expect(latest.chatComposerDraft).toBeNull();
      expect(latest.chatComposerDrafts['conv-prior']).toBe('原对话保留的草稿');
      expect(latest.currentProjectId).toBe('episode-a');
      expect(runtimeMocks.schedule).toHaveBeenCalledOnce();
      expect(runtimeMocks.model).toHaveBeenCalledOnce();
    },
  );

  it('不同分集、不同内容或不同模式分别建立任务', () => {
    const input = { episodeId: 'episode-b', content: '检查本集节奏', mode: 'plan' as const };
    const first = startWorkbenchAgentInvocation(input);
    const otherContent = startWorkbenchAgentInvocation({ ...input, content: '检查本集对白' });
    const otherMode = startWorkbenchAgentInvocation({ ...input, mode: 'collaborative' });
    const otherEpisode = startWorkbenchAgentInvocation({ ...input, episodeId: 'episode-a' });
    expect(new Set([first.taskId, otherContent.taskId, otherMode.taskId, otherEpisode.taskId]).size).toBe(4);
    expect(runtimeMocks.schedule).toHaveBeenCalledTimes(4);
  });

  it.each(['completed', 'failed', 'stopped', 'paused'] as const)('原任务 %s 后允许明确再次发起', (status) => {
    const input = { episodeId: 'episode-b', content: '检查本集节奏' };
    const first = startWorkbenchAgentInvocation(input);
    useAppStore.getState().updateAgentTask(first.taskId, { status });
    const second = startWorkbenchAgentInvocation(input);
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(runtimeMocks.schedule).toHaveBeenCalledTimes(2);
  });

  it.each(['deleted', 'target-changed', 'mode-changed'] as const)('来源会话 %s 后不复用旧任务', (change) => {
    const input = { episodeId: 'episode-b', content: '检查本集节奏', mode: 'plan' as const };
    const first = startWorkbenchAgentInvocation(input);
    useAppStore.setState((state) => ({ conversations: state.conversations.map((conversation) => (
      conversation.id !== first.conversationId ? conversation : {
        ...conversation,
        ...(change === 'deleted' ? { deletedAt: 1 } : change === 'target-changed'
          ? { workbenchTarget: { seriesId: 'series', episodeId: 'episode-a' } } : { agentMode: 'autonomous' as const }),
      }
    )) }));
    const second = startWorkbenchAgentInvocation(input);
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(runtimeMocks.schedule).toHaveBeenCalledTimes(2);
  });

  it('缺少文本模型时先拒绝，不创建会话、消息或任务', () => {
    runtimeMocks.model.mockReturnValue(undefined);
    const createConversation = vi.spyOn(useAppStore.getState(), 'createConversation');
    expect(() => startWorkbenchAgentInvocation({ episodeId: 'episode-b', content: '检查本集' })).toThrow('文本模型');
    expect(createConversation).not.toHaveBeenCalled();
    expect(useAppStore.getState().conversations).toHaveLength(1);
    expect(useAppStore.getState().messages).toHaveLength(0);
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    expect(runtimeMocks.schedule).not.toHaveBeenCalled();
  });

  it('离开所属剧集后拒绝旧工作台目标，不创建新会话', () => {
    useAppStore.setState({ currentProjectId: 'other-series' });
    const createConversation = vi.spyOn(useAppStore.getState(), 'createConversation');
    expect(() => startWorkbenchAgentInvocation({ episodeId: 'episode-b', content: '检查本集' })).toThrow('分集已变化');
    expect(createConversation).not.toHaveBeenCalled();
    expect(runtimeMocks.model).not.toHaveBeenCalled();
    expect(runtimeMocks.schedule).not.toHaveBeenCalled();
  });

  it('工作台独立窗口不能冒充主窗口发起任务', () => {
    vi.stubGlobal('window', { location: { search: '?view=script-workbench' } });
    expect(() => startWorkbenchAgentInvocation({ episodeId: 'episode-b', content: '检查本集' })).toThrow('主窗口');
    expect(useAppStore.getState().conversations).toHaveLength(1);
    expect(runtimeMocks.model).not.toHaveBeenCalled();
    expect(runtimeMocks.schedule).not.toHaveBeenCalled();
  });
});
