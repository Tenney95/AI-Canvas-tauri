/**
 * chat — 回归测试：chat conversation restoration。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ChatMessage } from '../../src/types/chat';

const historyMocks = vi.hoisted(() => ({
  saveConversation: vi.fn(async () => undefined),
  softDeleteConversation: vi.fn(async (conversation: ChatConversation) => conversation),
  loadProjectConversations: vi.fn<() => Promise<ChatConversation[]>>(),
  loadMessages: vi.fn<() => Promise<{ messages: ChatMessage[]; total: number }>>(),
  persistMessage: vi.fn(async () => undefined),
  clearConversationMessages: vi.fn(async () => undefined),
  repairInterruptedMessages: vi.fn(async () => [] as string[]),
}));

vi.mock('../../src/services/chat/chatHistoryService', () => historyMocks);

import { useAppStore } from '../../src/store/useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../src/services/chat/assistantScope';
import { MCP_SETTINGS_CONVERSATION_ID, MCP_SETTINGS_SCOPE_ID } from '../../src/services/mcp/mcpSettingsScope';

const storageValues = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
  removeItem: vi.fn((key: string) => storageValues.delete(key)),
  clear: vi.fn(() => storageValues.clear()),
  key: vi.fn((index: number) => [...storageValues.keys()][index] ?? null),
  get length() {
    return storageValues.size;
  },
} satisfies Storage;

function conversation(id: string, updatedAt: number): ChatConversation {
  return {
    id,
    projectId: 'project-1',
    title: id,
    titleSource: 'auto',
    pinned: false,
    archived: false,
    agentMode: 'collaborative',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
  };
}

function message(id: string, conversationId: string): ChatMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    content: id,
    timestamp: 1,
    status: 'done',
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', localStorageMock);
  storageValues.clear();
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1' });
  historyMocks.loadProjectConversations.mockReset();
  historyMocks.loadMessages.mockReset();
});

describe('chat conversation restoration', () => {
  it('rejects a delayed selection from another project without replacing the current draft', () => {
    const old = conversation('conv-old-project', 1);
    const current = { ...conversation('conv-current-project', 2), projectId: 'project-2' };
    useAppStore.setState({ currentProjectId: 'project-2', conversations: [old, current], activeConversationId: current.id,
      chatComposerLiveDraft: '当前草稿', chatComposerDrafts: { [old.id]: '旧草稿', [current.id]: '当前草稿' } });

    useAppStore.getState().setActiveConversation(old.id);
    useAppStore.getState().setActiveConversation('missing-conversation');

    expect(useAppStore.getState()).toMatchObject({ activeConversationId: current.id, chatComposerLiveDraft: '当前草稿' });
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('clears the previous project before loading and stays scoped when history fails', async () => {
    const old = conversation('conv-old-project', 1);
    const background = conversation('conv-background-project', 1);
    useAppStore.setState({ currentProjectId: 'project-2', conversations: [old, background], activeConversationId: old.id,
      chatComposerLiveDraft: '旧项目草稿', chatComposerDrafts: { [old.id]: '旧项目草稿' },
      messages: [message('old-answer', old.id), message('background-answer', background.id)],
      operationLogs: [{ id: 'old-log', projectId: old.projectId, conversationId: old.id, timestamp: 1,
        commandId: 'query', summary: '旧项目查询', targetNodeIds: [], parseSource: 'rule', status: 'success', undoable: false }],
      agentTasks: [{ id: 'background-task', projectId: background.projectId, conversationId: background.id,
        userMessageId: 'background-user', mode: 'autonomous', goal: '后台任务', status: 'running', steps: [],
        modelRounds: 0, toolCallCount: 0, budget: { maxModelRounds: 1, maxToolCalls: 1, maxParallelReadTools: 1, maxReadRetries: 0 },
        createdAt: 1, updatedAt: 1 }],
    });
    let fail!: (reason: Error) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const loading = useAppStore.getState().loadConversationsForProject('project-2');
      expect(useAppStore.getState()).toMatchObject({ conversations: [], activeConversationId: null,
        chatComposerLiveDraft: '', operationLogs: [] });
      expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['background-answer']);
      expect(useAppStore.getState().chatComposerDrafts[old.id]).toBe('旧项目草稿');

      fail(new Error('history unavailable'));
      await loading;
      expect(useAppStore.getState()).toMatchObject({ conversations: [], activeConversationId: null, chatComposerLiveDraft: '' });
      expect(historyMocks.loadMessages).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it('ignores old conversation messages that arrive while the next project history is loading', async () => {
    const old = conversation('conv-old-project', 1);
    const next = { ...conversation('conv-next-project', 2), projectId: 'project-2' };
    useAppStore.setState({ conversations: [old], activeConversationId: old.id });
    let finishOld!: (page: { messages: ChatMessage[]; total: number }) => void;
    historyMocks.loadMessages.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ messages: [message('next-answer', next.id)], total: 1 });
    const oldLoading = useAppStore.getState().loadConversationMessages(old.id);
    useAppStore.setState({ currentProjectId: 'project-2' });
    let finishNext!: (conversations: ChatConversation[]) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((resolve) => { finishNext = resolve; }));
    const nextLoading = useAppStore.getState().loadConversationsForProject('project-2');

    finishOld({ messages: [message('late-old-answer', old.id)], total: 1 });
    await oldLoading;
    expect(useAppStore.getState().activeConversationId).toBeNull();
    expect(useAppStore.getState().messages).toEqual([]);
    finishNext([next]);
    await nextLoading;
    expect(useAppStore.getState().activeConversationId).toBe(next.id);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['next-answer']);
  });

  it('keeps a conversation created in the new project while its older history is loading', async () => {
    const old = conversation('conv-old-project', 1);
    useAppStore.setState({ currentProjectId: 'project-2', conversations: [old], activeConversationId: old.id });
    let finish!: (conversations: ChatConversation[]) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });
    const loading = useAppStore.getState().loadConversationsForProject('project-2');
    const id = useAppStore.getState().createConversation('project-2');
    useAppStore.getState().setChatComposerLiveDraft('新项目草稿');
    useAppStore.getState().addMessage(message('new-project-answer', id));

    finish([{ ...conversation('conv-older-project-2', 1), projectId: 'project-2' }]);
    await loading;
    expect(useAppStore.getState()).toMatchObject({ activeConversationId: id, chatComposerLiveDraft: '新项目草稿' });
    expect(useAppStore.getState().conversations.every((item) => item.projectId === 'project-2')).toBe(true);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['new-project-answer']);
  });

  it('preserves the shared series conversation and draft while loading another episode', async () => {
    const shared = { ...conversation('conv-series', 1), projectId: 'series-1' };
    useAppStore.setState({ currentProjectId: 'ep-2', projects: [
      { id: 'series-1', name: 'Series', createdAt: 1, updatedAt: 1 },
      { id: 'ep-1', name: 'E1', parentId: 'series-1', createdAt: 1, updatedAt: 1 },
      { id: 'ep-2', name: 'E2', parentId: 'series-1', createdAt: 1, updatedAt: 1 },
    ], conversations: [shared], activeConversationId: shared.id,
    chatComposerLiveDraft: '剧集共享草稿', chatComposerDrafts: { [shared.id]: '剧集共享草稿' },
    messages: [message('series-answer', shared.id)] });
    let finish!: (conversations: ChatConversation[]) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });
    const loading = useAppStore.getState().loadConversationsForProject('ep-2');

    expect(historyMocks.loadProjectConversations).toHaveBeenCalledWith('series-1');
    expect(useAppStore.getState()).toMatchObject({ activeConversationId: shared.id, chatComposerLiveDraft: '剧集共享草稿' });
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['series-answer']);
    finish([shared]);
    await loading;
    expect(useAppStore.getState()).toMatchObject({ activeConversationId: shared.id, chatComposerLiveDraft: '剧集共享草稿' });
  });

  it('does not let a stale project load clear the current project conversation', async () => {
    const current = { ...conversation('conv-current-project', 2), projectId: 'project-2' };
    useAppStore.setState({ currentProjectId: 'project-2', conversations: [current], activeConversationId: current.id,
      chatComposerLiveDraft: '当前项目草稿', messages: [message('current-answer', current.id)] });
    historyMocks.loadProjectConversations.mockResolvedValue([]);

    await useAppStore.getState().loadConversationsForProject('project-1');

    expect(historyMocks.loadProjectConversations).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({ conversations: [current], activeConversationId: current.id,
      chatComposerLiveDraft: '当前项目草稿', messages: [message('current-answer', current.id)] });
  });

  it('preserves the active global MCP audit conversation while a project history loads', async () => {
    const global = { ...conversation(MCP_SETTINGS_CONVERSATION_ID, 1), projectId: MCP_SETTINGS_SCOPE_ID };
    const old = conversation('conv-old-project', 1);
    useAppStore.setState({ currentProjectId: 'project-2', conversations: [old, global], activeConversationId: global.id,
      messages: [message('old-answer', old.id), message('global-choice', global.id)] });
    let finish!: (conversations: ChatConversation[]) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });
    const loading = useAppStore.getState().loadConversationsForProject('project-2');

    expect(useAppStore.getState()).toMatchObject({ conversations: [global], activeConversationId: global.id });
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['global-choice']);
    finish([{ ...conversation('conv-project-2', 2), projectId: 'project-2' }]);
    await loading;
    expect(useAppStore.getState().activeConversationId).toBe(global.id);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['global-choice']);
  });

  it('does not let a late general-history load replace an opened project conversation', async () => {
    useAppStore.setState({ currentProjectId: null });
    let finish!: (conversations: ChatConversation[]) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const loading = useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    useAppStore.setState({ currentProjectId: 'project-1', activeConversationId: 'project-conversation',
      conversations: [conversation('project-conversation', 2)] });
    finish([{ ...conversation('conv-general', 1), projectId: GENERAL_ASSISTANT_SCOPE_ID }]);
    await loading;
    expect(useAppStore.getState().activeConversationId).toBe('project-conversation');
    expect(useAppStore.getState().conversations.map((item) => item.id)).toEqual(['project-conversation']);
  });

  it('restores general history on the start page without creating a canvas project', async () => {
    const general = { ...conversation('conv-general', 1), projectId: GENERAL_ASSISTANT_SCOPE_ID };
    useAppStore.setState({ currentProjectId: null, projects: [] });
    historyMocks.loadProjectConversations.mockResolvedValue([general]);
    historyMocks.loadMessages.mockResolvedValue({ messages: [message('general-answer', general.id)], total: 1 });
    await useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    expect(useAppStore.getState().activeConversationId).toBe(general.id);
    expect(useAppStore.getState().messages[0].content).toBe('general-answer');
    expect(useAppStore.getState().projects).toEqual([]);
  });

  it('keeps a new general conversation and its live message when an older list finishes loading', async () => {
    useAppStore.setState({ currentProjectId: null });
    let finish!: (conversations: ChatConversation[]) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });
    const loading = useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    const id = useAppStore.getState().createConversation(GENERAL_ASSISTANT_SCOPE_ID);
    useAppStore.getState().addMessage(message('just-created', id));
    finish([]);
    await loading;
    expect(useAppStore.getState().activeConversationId).toBe(id);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['just-created']);
  });

  it('does not replace an unbound general draft with a restored conversation', async () => {
    useAppStore.setState({ currentProjectId: null, chatComposerLiveDraft: '我正在输入的新问题' });
    historyMocks.loadProjectConversations.mockResolvedValue([{ ...conversation('conv-old', 1), projectId: GENERAL_ASSISTANT_SCOPE_ID }]);
    await useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    expect(useAppStore.getState().activeConversationId).toBeNull();
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('我正在输入的新问题');
    expect(historyMocks.loadMessages).not.toHaveBeenCalled();
  });

  it('keeps per-conversation drafts and does not apply a delayed draft to the newly selected conversation', () => {
    useAppStore.setState({ conversations: [conversation('a', 1), conversation('b', 2)] });
    const store = useAppStore.getState();
    store.setActiveConversation('a');
    store.setChatComposerLiveDraft('甲的草稿');
    store.setActiveConversation('b');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('');
    store.setChatComposerLiveDraft('乙的草稿');
    store.setChatComposerLiveDraft('甲的最后一次输入', 'a');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('乙的草稿');
    store.setActiveConversation('a');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('甲的最后一次输入');
    store.setChatComposerLiveDraft('');
    expect(useAppStore.getState().chatComposerDrafts).toEqual({ b: '乙的草稿' });
    store.setChatComposerLiveDraft('不存在的会话', 'missing');
    expect(useAppStore.getState().chatComposerDrafts).not.toHaveProperty('missing');
  });

  it('keeps drafts and the active view when toggling between embedded and detached chat', () => {
    useAppStore.setState({ conversations: [conversation('a', 1)] });
    const store = useAppStore.getState();
    store.setActiveConversation('a');
    store.setChatComposerLiveDraft('还没发出去');
    store.setChatPanelView('tasks');
    store.setChatPanelDetached(true);
    store.closeChat();
    store.setChatPanelDetached(false);
    store.openChat();
    expect(useAppStore.getState()).toMatchObject({ chatComposerLiveDraft: '还没发出去', chatPanelView: 'tasks', activeConversationId: 'a' });
  });

  it('restores the selected conversation and loads its messages after restart', async () => {
    const conversations = [conversation('conversation-newest', 2), conversation('conversation-selected', 1)];
    useAppStore.setState({ conversations });
    useAppStore.getState().setActiveConversation('conversation-selected');

    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ currentProjectId: 'project-1' });
    historyMocks.loadProjectConversations.mockResolvedValue(conversations);
    historyMocks.loadMessages.mockResolvedValue({
      messages: [message('restored-message', 'conversation-selected')],
      total: 1,
    });

    await useAppStore.getState().loadConversationsForProject('project-1');

    expect(useAppStore.getState().activeConversationId).toBe('conversation-selected');
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['restored-message']);
    expect(historyMocks.loadMessages).toHaveBeenCalledWith('conversation-selected', 0, 200);
  });

  it('scopes an episode to its series owner for load and create', async () => {
    // series-1 是剧集，ep-2 是它的分集（parentId 指向 series-1）
    useAppStore.setState({
      projects: [
        { id: 'series-1', name: 'S', createdAt: 1, updatedAt: 1 },
        { id: 'ep-2', name: 'E2', createdAt: 1, updatedAt: 1, parentId: 'series-1', episodeNo: 2 },
      ],
      currentProjectId: 'ep-2',
    });
    historyMocks.loadProjectConversations.mockResolvedValue([]);
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });

    await useAppStore.getState().loadConversationsForProject('ep-2');
    expect(historyMocks.loadProjectConversations).toHaveBeenCalledWith('series-1');

    const id = useAppStore.getState().createConversation('ep-2');
    expect(useAppStore.getState().conversations.find((c) => c.id === id)?.projectId).toBe('series-1');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'ai-canvas.chat.active-conversation:series-1',
      id,
    );
  });

  it('keeps a normal top-level project scoped to itself', async () => {
    useAppStore.setState({
      projects: [{ id: 'project-1', name: 'P', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-1',
    });
    historyMocks.loadProjectConversations.mockResolvedValue([]);
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });

    await useAppStore.getState().loadConversationsForProject('project-1');
    expect(historyMocks.loadProjectConversations).toHaveBeenCalledWith('project-1');
    const id = useAppStore.getState().createConversation('project-1');
    expect(useAppStore.getState().conversations.find((c) => c.id === id)?.projectId).toBe('project-1');
  });

  it('falls back to the first available conversation when the saved one no longer exists', async () => {
    localStorageMock.setItem(
      'ai-canvas.chat.active-conversation:project-1',
      'conversation-deleted',
    );
    historyMocks.loadProjectConversations.mockResolvedValue([
      conversation('conversation-fallback', 2),
    ]);
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });

    await useAppStore.getState().loadConversationsForProject('project-1');

    expect(useAppStore.getState().activeConversationId).toBe('conversation-fallback');
    expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
      'ai-canvas.chat.active-conversation:project-1',
      'conversation-fallback',
    );
  });
});
