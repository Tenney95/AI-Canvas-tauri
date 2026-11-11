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
const chatWindowMocks = vi.hoisted(() => ({
  close: vi.fn<(sessionId?: string) => Promise<void>>(),
  sessionId: vi.fn<() => string | undefined>(),
}));

vi.mock('../../src/services/chat/chatHistoryService', () => historyMocks);
vi.mock('../../src/services/chat/chatWindowService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/chat/chatWindowService')>(),
  emitCloseChatWindow: chatWindowMocks.close,
  getMainChatWindowSessionId: chatWindowMocks.sessionId,
}));

import { useAppStore } from '../../src/store/useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../src/services/chat/assistantScope';
import { MCP_SETTINGS_CONVERSATION_ID, MCP_SETTINGS_SCOPE_ID } from '../../src/services/mcp/mcpSettingsScope';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasImport } from '../../src/services/canvasDerivationGuard';

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
  chatWindowMocks.close.mockReset().mockResolvedValue(undefined);
  chatWindowMocks.sessionId.mockReset().mockReturnValue('old-window-session');
});

describe('新项目画布版本与派生结果', () => {
  it('编辑后同步运行时上下文，使旧结果失效且新操作仍可登记', () => {
    useAppStore.setState({ currentProjectId: 'canvas-a', projectLoadStatus: 'ready', switchingProjectName: null,
      isCreatingProject: false, isReturningToStartPage: false, canvasRevision: 3, globalCanvasRevision: 10,
      projects: [{ id: 'canvas-a', name: '画布', createdAt: 1, updatedAt: 1 }],
      projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'runtime',
        projectId: 'project-a', projectEpoch: 1, episodeId: 'episode-a', canvasId: 'canvas-a', canvasEpoch: 1, canvasRevision: 3 } });
    const previous = registerCanvasImport(useAppStore.getState())!;
    expect(previous).not.toBeNull();
    useAppStore.getState().incrementRevision();
    expect(isCanvasDerivationFresh(previous, useAppStore.getState())).toBe(false);
    const current = registerCanvasImport(useAppStore.getState())!;
    expect(current?.expectedContext?.canvasRevision).toBe(4);
    expect(isCanvasDerivationFresh(current, useAppStore.getState())).toBe(true);
    completeCanvasDerivation(previous); completeCanvasDerivation(current);
  });

  it('按当前画布的版本模式同步，且不修改其他画布的上下文', () => {
    const context = { kind: 'canvas' as const, schemaVersion: 2 as const, modelGeneration: 1, runtimeEpoch: 'runtime',
      projectId: 'project-a', projectEpoch: 1, episodeId: null, canvasId: 'canvas-a', canvasEpoch: 1, canvasRevision: 10 };
    useAppStore.setState({ currentProjectId: 'canvas-a', canvasRevision: 3, globalCanvasRevision: 10,
      projects: [{ id: 'canvas-a', name: '画布', createdAt: 1, updatedAt: 1, revisionScope: 'global' }], projectExecutionContext: context });
    useAppStore.getState().setCanvasRevision(8);
    expect(useAppStore.getState().projectExecutionContext).toEqual(context);
    useAppStore.getState().setGlobalCanvasRevision(12);
    expect(useAppStore.getState().projectExecutionContext).toMatchObject({ canvasRevision: 12 });
    useAppStore.setState({ currentProjectId: 'canvas-b' });
    useAppStore.getState().incrementRevision();
    expect(useAppStore.getState().projectExecutionContext).toMatchObject({ canvasId: 'canvas-a', canvasRevision: 12 });
  });

  it('切换过程中拒绝登记和写回当前新画布的派生操作', () => {
    useAppStore.setState({ currentProjectId: 'canvas-a', projectLoadStatus: 'ready', switchingProjectName: null,
      isCreatingProject: false, isReturningToStartPage: false, canvasRevision: 3,
      projects: [{ id: 'canvas-a', name: '画布', createdAt: 1, updatedAt: 1 }],
      projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'runtime',
        projectId: 'project-a', projectEpoch: 1, episodeId: null, canvasId: 'canvas-a', canvasEpoch: 1, canvasRevision: 3 } });
    const pending = registerCanvasImport(useAppStore.getState())!;
    expect(pending).not.toBeNull();
    useAppStore.setState({ switchingProjectName: '另一项目' });
    expect(registerCanvasImport(useAppStore.getState())).toBeNull();
    expect(isCanvasDerivationFresh(pending, useAppStore.getState())).toBe(false);
    completeCanvasDerivation(pending);
  });
});

describe('工作台会话持久范围', () => {
  const target = { seriesId: 'project-1', episodeId: 'episode-a' };
  beforeEach(() => {
    historyMocks.saveConversation.mockClear();
    useAppStore.setState({ projectLoadStatus: 'ready', isCreatingProject: false, isReturningToStartPage: false,
      switchingProjectName: null, projects: [
        { id: 'project-1', name: '剧集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-a', parentId: 'project-1', name: '第一集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-b', parentId: 'project-1', name: '第二集', createdAt: 1, updatedAt: 1 },
      ], conversations: [conversation('conv-workbench', 1)], activeConversationId: 'conv-workbench' });
  });

  it('首次绑定只接受当前剧集分集，后续元数据更新和任务清理都保留目标', () => {
    const state = useAppStore.getState();
    state.updateConversation('conv-workbench', { workbenchTarget: target });
    useAppStore.setState({ agentTasks: [] });
    state.updateConversation('conv-workbench', { title: '新标题', workbenchTarget: undefined,
      id: 'forged-id', projectId: 'forged-project' });
    expect(useAppStore.getState().conversations[0]).toMatchObject({ id: 'conv-workbench', projectId: 'project-1',
      title: '新标题', workbenchTarget: target });
    expect(historyMocks.saveConversation).toHaveBeenLastCalledWith(expect.objectContaining({ workbenchTarget: target }));
    expect(() => state.updateConversation('conv-workbench', { workbenchTarget: { ...target, episodeId: 'episode-b' } }))
      .toThrow('不能更换');
    expect(useAppStore.getState().conversations[0].workbenchTarget).toEqual(target);
  });

  it('错误归属、已离开的剧集或不存在的分集不能建立绑定', () => {
    const state = useAppStore.getState();
    expect(() => state.updateConversation('conv-workbench', { workbenchTarget: { ...target, seriesId: 'other-series' } }))
      .toThrow('目标无效');
    expect(() => state.updateConversation('conv-workbench', { workbenchTarget: { ...target, episodeId: 'missing' } }))
      .toThrow('范围已变化');
    useAppStore.setState({ currentProjectId: null });
    expect(() => state.updateConversation('conv-workbench', { workbenchTarget: target })).toThrow('范围已变化');
    expect(useAppStore.getState().conversations[0].workbenchTarget).toBeUndefined();
  });

  it('其他产品入口的新草稿进入普通会话，保留原工作台会话与其草稿', () => {
    const state = useAppStore.getState();
    state.updateConversation('conv-workbench', { workbenchTarget: target });
    state.setChatComposerLiveDraft('工作台尚未发送的要求', 'conv-workbench');
    state.openChatWithDraft('读取全剧并拆分章节');
    const latest = useAppStore.getState();
    expect(latest.activeConversationId).not.toBe('conv-workbench');
    expect(latest.conversations.find((entry) => entry.id === latest.activeConversationId)?.workbenchTarget).toBeUndefined();
    expect(latest.conversations.find((entry) => entry.id === 'conv-workbench')?.workbenchTarget).toEqual(target);
    expect(latest.chatComposerDrafts['conv-workbench']).toBe('工作台尚未发送的要求');
    expect(latest.chatComposerDraft).toBe('读取全剧并拆分章节');
    expect(latest.chatOpen).toBe(true);
  });
});

describe('外部草稿的独立窗口交接', () => {
  beforeEach(() => {
    useAppStore.setState({ chatOpen: true, chatPanelDetached: true, chatComposerDraft: null,
      projectLoadStatus: 'ready', switchingProjectName: null, isCreatingProject: false, isReturningToStartPage: false,
      projects: [{ id: 'project-1', name: '项目一', createdAt: 1, updatedAt: 1 }],
      conversations: [conversation('conv-first', 1), conversation('conv-second', 2)], activeConversationId: 'conv-first',
      chatComposerLiveDraft: '原有草稿', chatComposerDrafts: { 'conv-first': '原有草稿', 'conv-second': '另一会话草稿' },
      showToast: vi.fn() });
  });

  it('真实关窗完成前保留独立显示，连续请求只交接一次并采用最后草稿', async () => {
    let finish!: () => void;
    chatWindowMocks.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const state = useAppStore.getState();
    state.openChatWithDraft('第一份外部草稿');
    state.openChatWithDraft('最后一份外部草稿');
    await vi.waitFor(() => expect(chatWindowMocks.close).toHaveBeenCalledOnce());
    expect(useAppStore.getState()).toMatchObject({ chatPanelDetached: true, chatComposerDraft: null, activeConversationId: 'conv-first' });
    state.setChatComposerLiveDraft('独立窗口末次输入', 'conv-first');
    finish();

    await vi.waitFor(() => expect(useAppStore.getState().chatPanelDetached).toBe(false));
    expect(useAppStore.getState()).toMatchObject({ chatOpen: true, chatComposerDraft: '最后一份外部草稿',
      chatComposerDrafts: { 'conv-first': '独立窗口末次输入', 'conv-second': '另一会话草稿' } });
    expect(chatWindowMocks.close).toHaveBeenCalledOnce();
    expect(chatWindowMocks.close).toHaveBeenCalledWith('old-window-session');
  });

  it('交接失败不显示内嵌面板、不覆盖草稿，错误不暴露原始细节', async () => {
    chatWindowMocks.close.mockRejectedValueOnce(new Error('untrusted native failure details'));
    useAppStore.getState().openChatWithDraft('不能填入的新草稿');
    await vi.waitFor(() => expect(useAppStore.getState().showToast)
      .toHaveBeenCalledWith('独立窗口尚未完成草稿交接，未打开内嵌助手', 'error'));
    expect(useAppStore.getState()).toMatchObject({ chatPanelDetached: true, chatComposerDraft: null,
      chatComposerLiveDraft: '原有草稿', chatComposerDrafts: { 'conv-first': '原有草稿' } });
  });

  it('正式交接尚未开始就出现新窗口时，不向新实例发送关闭请求', async () => {
    useAppStore.getState().openChatWithDraft('旧窗口请求的草稿');
    chatWindowMocks.sessionId.mockReturnValue('new-window-session');
    await vi.waitFor(() => expect(useAppStore.getState().showToast).toHaveBeenCalledWith('项目或会话已变化，未填入助手草稿', 'info'));
    expect(chatWindowMocks.close).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({ chatPanelDetached: true, chatComposerDraft: null, chatComposerLiveDraft: '原有草稿' });
  });

  it.each(['project', 'conversation', 'revision', 'navigation', 'context', 'new-window'])('交接期间 %s 变化后取消注入，保留原会话交接草稿', async (change) => {
    let finish!: () => void;
    chatWindowMocks.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const state = useAppStore.getState();
    state.openChatWithDraft('过期的外部草稿');
    await vi.waitFor(() => expect(chatWindowMocks.close).toHaveBeenCalledOnce());
    if (change === 'project') useAppStore.setState({ currentProjectId: 'project-2', activeConversationId: 'conv-other',
      conversations: [{ ...conversation('conv-other', 3), projectId: 'project-2' }], chatComposerLiveDraft: '新项目草稿' });
    if (change === 'conversation') state.setActiveConversation('conv-second');
    if (change === 'revision') state.incrementRevision();
    if (change === 'navigation') {
      state.setActiveConversation('conv-second');
      state.setActiveConversation('conv-first');
    }
    if (change === 'context') useAppStore.setState({ projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1,
      projectId: 'owner', projectEpoch: 1, canvasId: 'project-1', canvasEpoch: 1, canvasRevision: 0, episodeId: null, runtimeEpoch: 'new-runtime' } });
    if (change === 'new-window') chatWindowMocks.sessionId.mockReturnValue('new-window-session');
    state.setChatComposerLiveDraft('独立窗口末次输入', 'conv-first', 'project-1');
    finish();

    await vi.waitFor(() => expect(useAppStore.getState().showToast).toHaveBeenCalledWith('项目或会话已变化，未填入助手草稿', 'info'));
    expect(useAppStore.getState().chatPanelDetached).toBe(true);
    expect(useAppStore.getState().chatComposerDraft).toBeNull();
    expect(useAppStore.getState().chatComposerDrafts['conv-first']).toBe('独立窗口末次输入');
    if (change === 'project') expect(useAppStore.getState().chatComposerLiveDraft).toBe('新项目草稿');
    if (change === 'conversation') expect(useAppStore.getState().chatComposerLiveDraft).toBe('另一会话草稿');
  });

  it('仅核验过归属的已离开会话可保存草稿，不切换当前输入或活动会话', () => {
    const state = useAppStore.getState();
    expect(state.setChatComposerLiveDraft('未经核验的旧输入', 'conv-prior-project')).toBe(false);
    expect(useAppStore.getState().chatComposerDrafts).not.toHaveProperty('conv-prior-project');
    expect(state.setChatComposerLiveDraft('已核验旧会话末次输入', 'conv-prior-project', 'prior-project')).toBe(true);
    expect(useAppStore.getState().chatComposerDrafts['conv-prior-project']).toBe('已核验旧会话末次输入');
    expect(useAppStore.getState()).toMatchObject({ activeConversationId: 'conv-first', chatComposerLiveDraft: '原有草稿' });
  });

  it('软删除尚未提交时也拒绝迟到的旧 owner 核验草稿，不复活删除记录', () => {
    const removed = conversation('conv-removed-pending-delete', 3);
    let finish!: (result: ChatConversation) => void;
    historyMocks.softDeleteConversation.mockImplementationOnce(() => new Promise<ChatConversation>((resolve) => { finish = resolve; }));
    useAppStore.setState((state) => ({ conversations: [...state.conversations, removed], activeConversationId: removed.id,
      chatComposerLiveDraft: '删除前草稿', chatComposerDrafts: { ...state.chatComposerDrafts, [removed.id]: '删除前草稿' } }));
    const state = useAppStore.getState();
    state.removeConversation(removed.id);
    state.setActiveConversation('conv-second');

    expect(state.setChatComposerLiveDraft('持久化查询仍看到的旧输入', removed.id, removed.projectId)).toBe(false);
    expect(state.setChatComposerLiveDraft('', removed.id, removed.projectId)).toBe(false);
    expect(useAppStore.getState().chatComposerDrafts).not.toHaveProperty(removed.id);
    expect(useAppStore.getState()).toMatchObject({ activeConversationId: 'conv-second', chatComposerLiveDraft: '另一会话草稿' });
    finish({ ...removed, deletedAt: 4 });
  });

  it.each(['deleted', 'wrong-owner'])('已核验交接也不能覆盖当前列表中 %s 的会话', (change) => {
    useAppStore.setState((state) => ({ conversations: state.conversations.map((item) => item.id === 'conv-first'
      ? { ...item, ...(change === 'deleted' ? { deletedAt: 1 } : {}) } : item) }));
    expect(useAppStore.getState().setChatComposerLiveDraft('不允许覆盖', 'conv-first', change === 'wrong-owner' ? 'other-project' : 'project-1')).toBe(false);
    expect(useAppStore.getState().chatComposerDrafts['conv-first']).toBe('原有草稿');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('原有草稿');
  });
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
    expect(store.setChatComposerLiveDraft('甲的草稿')).toBe(true);
    store.setActiveConversation('b');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('');
    store.setChatComposerLiveDraft('乙的草稿');
    store.setChatComposerLiveDraft('甲的最后一次输入', 'a');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('乙的草稿');
    store.setActiveConversation('a');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('甲的最后一次输入');
    expect(store.setChatComposerLiveDraft('')).toBe(true);
    expect(useAppStore.getState().chatComposerDrafts).toEqual({ b: '乙的草稿' });
    expect(store.setChatComposerLiveDraft('不存在的会话', 'missing')).toBe(false);
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
