/**
 * detachedChatSyncController — 回归测试：detached chat sync controller。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAction, ChatComposerHandoff } from '../../../src/services/chat/chatWindowService';

const conversationControllerMocks = vi.hoisted(() => ({
  submit: vi.fn(),
  resolveApproval: vi.fn(() => true),
  resume: vi.fn(() => ({ ok: true as const })),
}));
const closingMocks = vi.hoisted(() => ({
  finish: vi.fn<(sessionId: string) => Promise<void>>(),
  response: vi.fn<() => Promise<void>>(),
  failed: vi.fn<() => Promise<void>>(),
}));
vi.mock('../../../src/services/chat/chatWindowService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/chat/chatWindowService')>(),
  finishChatWindowClose: closingMocks.finish,
  emitChatSendResponse: closingMocks.response,
  emitChatCloseFailure: closingMocks.failed,
}));

vi.mock('../../../src/services/chat/conversationExecutionController', () => ({
  getAgentModeToast: vi.fn(() => 'mode changed'),
  resolveConversationAgentApproval: conversationControllerMocks.resolveApproval,
  resumeAgentTaskExecution: conversationControllerMocks.resume,
  submitConversationMessage: conversationControllerMocks.submit,
}));

import {
  buildDetachedChatSnapshot,
  buildChatModelCatalog,
  createDetachedChatSyncController,
  handleDetachedChatAction,
  projectChatNodes,
  executeManagedChatOperation,
} from '../../../src/services/chat/detachedChatSyncController';
import { applyChatStatePatch, beginChatWindowSession, createChatStatePatch, endChatWindowSession, getMainChatWindowSessionId, receiveChatStateSync, type ChatStateSync, type ChatWindowState } from '../../../src/services/chat/chatWindowService';
import { runAgentTask } from '../../../src/services/chat/agentTaskControl';
import { useAppStore } from '../../../src/store/useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../../src/services/chat/assistantScope';
import type { ProjectWindowFrame } from '../../../src/types/projectWindow';

function windowActions(handler: (action: ChatAction) => void, frame: () => ProjectWindowFrame | null | undefined) {
  let sequence = 0;
  return (action: ChatAction) => {
    const windowFrame = frame() ?? undefined;
    handler({ ...action, windowFrame, sequence: ++sequence,
      ...((action.type === 'dock_window' || action.type === 'close_window') && action.composerDraft
        ? { composerDraft: { ...action.composerDraft, windowFrame } } : {}) });
  };
}
const syncFrame = (sync?: ChatStateSync) => sync?.type === 'snapshot' ? sync.snapshot.windowFrame : sync?.patch.fields.windowFrame;

function arrangeDetachedState(): void {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    chatOpen: false,
    chatPanelDetached: true,
    projectLoadStatus: 'ready', switchingProjectName: null,
    currentProjectId: 'project-1',
    activeConversationId: 'conversation-1',
    projects: [{
      id: 'project-1',
      name: 'Detached project',
      createdAt: 1,
      updatedAt: 1,
    }],
    conversations: [{
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Detached conversation',
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
  closingMocks.finish.mockReset().mockImplementation(async (sessionId) => { endChatWindowSession(sessionId); });
  closingMocks.response.mockReset().mockResolvedValue(undefined);
  closingMocks.failed.mockReset().mockResolvedValue(undefined);
  beginChatWindowSession();
  arrangeDetachedState();
  conversationControllerMocks.submit.mockReset();
  conversationControllerMocks.resolveApproval.mockReset();
  conversationControllerMocks.resolveApproval.mockReturnValue(true);
  conversationControllerMocks.resume.mockReset();
  conversationControllerMocks.resume.mockReturnValue({ ok: true });
});

describe('独立助手关闭与草稿交接', () => {
  async function harness() {
    const emissions: ChatStateSync[] = [];
    let dispatch!: (action: ChatAction) => void;
    const controller = createDetachedChatSyncController({ enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { emissions.push(sync); },
      initListener: async (handler) => { dispatch = handler; return () => {}; } });
    await controller.start();
    return { controller, emissions, dispatch, frame: syncFrame(emissions[0])! };
  }

  it('收到草稿先保留独立模式与 nonce，原生销毁确认后才收回', async () => {
    const setup = await harness(), sessionId = getMainChatWindowSessionId()!;
    let finish!: () => void;
    closingMocks.finish.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = () => { endChatWindowSession(sessionId); resolve(); };
    }));
    try {
      setup.dispatch({ type: 'dock_window', requestId: 'dock-pending', sequence: 1, windowFrame: setup.frame,
        composerDraft: { conversationId: 'conversation-1', draft: '最后一笔', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(closingMocks.finish).toHaveBeenCalledWith(sessionId));
      expect(useAppStore.getState()).toMatchObject({ chatPanelDetached: true, chatComposerLiveDraft: '最后一笔' });
      expect(getMainChatWindowSessionId()).toBe(sessionId);
      finish();
      await vi.waitFor(() => expect(useAppStore.getState().chatPanelDetached).toBe(false));
    } finally { setup.controller.dispose(); }
  });

  it('超过六十四个流式快照后仍可交接旧会话草稿，普通旧帧写动作继续拒绝', async () => {
    const setup = await harness();
    try {
      for (let index = 0; index < 70; index += 1) {
        setup.controller.sync(true, true);
        await Promise.resolve(); await Promise.resolve();
      }
      useAppStore.setState((state) => ({ conversations: [...state.conversations, { ...state.conversations[0], id: 'conversation-2' }],
        activeConversationId: 'conversation-2', chatComposerLiveDraft: '新会话草稿', chatComposerDrafts: { 'conversation-2': '新会话草稿' } }));
      expect(setup.emissions.length).toBeGreaterThan(64);
      setup.dispatch({ type: 'set_panel_view', view: 'tasks', windowFrame: setup.frame, sequence: 1 });
      expect(useAppStore.getState().chatPanelView).toBe('chat');
      setup.dispatch({ type: 'dock_window', windowFrame: setup.frame, sequence: 2,
        composerDraft: { conversationId: 'conversation-1', draft: '旧会话尾部', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(useAppStore.getState().chatPanelDetached).toBe(false));
      expect(useAppStore.getState()).toMatchObject({ activeConversationId: 'conversation-2', chatComposerLiveDraft: '新会话草稿',
        chatComposerDrafts: { 'conversation-1': '旧会话尾部', 'conversation-2': '新会话草稿' } });
    } finally { setup.controller.dispose(); }
  });

  it('旧项目会话不在当前列表时，经数据库归属核验只保存到原会话', async () => {
    const { putChatConversation } = await import('../../../src/services/indexedDbService');
    await putChatConversation(useAppStore.getState().conversations[0]);
    const setup = await harness();
    try {
      useAppStore.setState((state) => ({ projects: [...state.projects, { ...state.projects[0], id: 'project-2' }], currentProjectId: 'project-2',
        conversations: [{ ...state.conversations[0], id: 'conversation-2', projectId: 'project-2' }], activeConversationId: 'conversation-2',
        chatComposerLiveDraft: '乙项目输入', chatComposerDrafts: { 'conversation-2': '乙项目输入' } }));
      setup.dispatch({ type: 'close_window', windowFrame: setup.frame, sequence: 1,
        composerDraft: { conversationId: 'conversation-1', draft: '甲项目输入', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(closingMocks.finish).toHaveBeenCalledOnce());
      expect(useAppStore.getState()).toMatchObject({ currentProjectId: 'project-2', activeConversationId: 'conversation-2',
        chatComposerLiveDraft: '乙项目输入', chatComposerDrafts: { 'conversation-1': '甲项目输入', 'conversation-2': '乙项目输入' } });
    } finally { setup.controller.dispose(); }
  });

  it('数据库查询期间原会话被删除时，不把迟到读取判为草稿已保存或继续关窗', async () => {
    const original = { ...useAppStore.getState().conversations[0], id: 'close-during-db-delete' };
    useAppStore.setState({ conversations: [original], activeConversationId: original.id });
    const setup = await harness();
    const repository = await import('../../../src/services/indexedDbService');
    let finishRead!: (rows: Awaited<ReturnType<typeof repository.getProjectConversations>>) => void;
    const read = vi.spyOn(repository, 'getProjectConversations').mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    try {
      useAppStore.setState({ conversations: [], activeConversationId: null });
      setup.dispatch({ type: 'close_window', requestId: 'deleted-during-read', sequence: 1, windowFrame: setup.frame,
        composerDraft: { conversationId: original.id, draft: '不能复活的草稿', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith('project-1'));
      useAppStore.getState().removeConversation(original.id);
      finishRead([original]);
      await vi.waitFor(() => expect(closingMocks.response).toHaveBeenCalledWith('deleted-during-read', false, setup.frame.sessionId));
      expect(useAppStore.getState().chatComposerDrafts[original.id]).toBeUndefined();
      expect(closingMocks.finish).not.toHaveBeenCalled();
      expect(useAppStore.getState().chatPanelDetached).toBe(true);
    } finally { read.mockRestore(); setup.controller.dispose(); }
  });

  it.each([false, true])('快速编辑沿用本客户端已接收的草稿，外部较新修改则拒绝（竞争：%s）', async (competing) => {
    const setup = await harness();
    try {
      setup.dispatch({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: 'a', windowFrame: setup.frame, sequence: 1 });
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('a');
      if (competing) useAppStore.getState().setChatComposerLiveDraft('主窗口较新输入', 'conversation-1');
      setup.dispatch({ type: 'close_window', requestId: 'quick-close', windowFrame: setup.frame, sequence: 2,
        composerDraft: { conversationId: 'conversation-1', draft: 'ab', windowFrame: setup.frame } });
      if (competing) {
        await vi.waitFor(() => expect(closingMocks.response).toHaveBeenCalledWith('quick-close', false, setup.frame.sessionId));
        expect(closingMocks.finish).not.toHaveBeenCalled();
        expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('主窗口较新输入');
      } else {
        await vi.waitFor(() => expect(closingMocks.finish).toHaveBeenCalledOnce());
        expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('ab');
      }
    } finally { setup.controller.dispose(); }
  });

  it.each([false, true])('发送 ACK 未返回时不恢复已发送的旧正文，原旧帧空草稿仍可关闭（首次发送：%s）', async (firstSend) => {
    if (firstSend) useAppStore.setState({ conversations: [], activeConversationId: null });
    const setup = await harness();
    let finishAck!: () => void;
    closingMocks.response.mockImplementationOnce(() => new Promise<void>((resolve) => { finishAck = resolve; }));
    conversationControllerMocks.submit.mockReturnValueOnce({ status: 'started', userMessageId: 'sent-user', assistantMessageId: 'sent-assistant' });
    try {
      setup.dispatch({ type: 'send_message', conversationId: setup.frame.conversationId ?? undefined, content: 'a',
        requestId: 'send-before-close', windowFrame: setup.frame, sequence: 1 });
      expect(useAppStore.getState().chatComposerLiveDraft).toBe('');
      setup.dispatch({ type: 'close_window', requestId: 'stale-sent-draft', windowFrame: setup.frame, sequence: 2,
        composerDraft: { conversationId: setup.frame.conversationId ?? null, draft: 'a', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(closingMocks.response).toHaveBeenCalledWith('stale-sent-draft', false, setup.frame.sessionId));
      expect(closingMocks.finish).not.toHaveBeenCalled();
      expect(useAppStore.getState().chatComposerLiveDraft).toBe('');
      expect(Object.values(useAppStore.getState().chatComposerDrafts)).not.toContain('a');
      expect(useAppStore.getState().chatPanelDetached).toBe(true);
      finishAck();
      setup.dispatch({ type: 'close_window', requestId: 'cleared-sent-draft', windowFrame: setup.frame, sequence: 3,
        composerDraft: { conversationId: setup.frame.conversationId ?? null, draft: '', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(closingMocks.finish).toHaveBeenCalledOnce());
    } finally { finishAck?.(); setup.controller.dispose(); }
  });

  it('发送前已同步的正文不能成为发送后旧草稿的编辑证明', async () => {
    const setup = await harness();
    conversationControllerMocks.submit.mockReturnValueOnce({ status: 'started', userMessageId: 'sent-user', assistantMessageId: 'sent-assistant' });
    try {
      setup.dispatch({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: 'a', windowFrame: setup.frame, sequence: 1 });
      setup.dispatch({ type: 'send_message', conversationId: 'conversation-1', content: 'a', windowFrame: setup.frame, sequence: 2 });
      setup.dispatch({ type: 'close_window', requestId: 'pre-send-edit', windowFrame: setup.frame, sequence: 3,
        composerDraft: { conversationId: 'conversation-1', draft: 'a', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(closingMocks.response).toHaveBeenCalledWith('pre-send-edit', false, setup.frame.sessionId));
      expect(closingMocks.finish).not.toHaveBeenCalled();
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBeUndefined();
      expect(useAppStore.getState().chatComposerLiveDraft).toBe('');
    } finally { setup.controller.dispose(); }
  });

  it.each([false, true])('发送后的新编辑可正常交接（使用新帧：%s）', async (newFrame) => {
    const setup = await harness();
    conversationControllerMocks.submit.mockReturnValueOnce({ status: 'started', userMessageId: 'sent-user', assistantMessageId: 'sent-assistant' });
    try {
      setup.dispatch({ type: 'send_message', conversationId: 'conversation-1', content: 'a', windowFrame: setup.frame, sequence: 1 });
      let frame = setup.frame;
      if (newFrame) {
        await vi.waitFor(() => expect(syncFrame(setup.emissions.at(-1))?.revision).toBeGreaterThan(setup.frame.revision));
        await Promise.resolve();
        frame = syncFrame(setup.emissions.at(-1))!;
      } else {
        // 尚未收到新快照，但 send 之后的合法 set_draft 足以证明这是新一轮编辑。
        setup.dispatch({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: 'b', windowFrame: frame, sequence: 2 });
      }
      setup.dispatch({ type: 'close_window', requestId: 'post-send-edit', windowFrame: frame, sequence: 3,
        composerDraft: { conversationId: 'conversation-1', draft: 'bc', windowFrame: frame } });
      await vi.waitFor(() => expect(closingMocks.finish).toHaveBeenCalledOnce());
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('bc');
    } finally { setup.controller.dispose(); }
  });

  it('被忽略的发送不消费草稿，旧帧仍可保存未发送内容并关闭', async () => {
    const setup = await harness();
    conversationControllerMocks.submit.mockReturnValueOnce({ status: 'ignored' });
    try {
      setup.dispatch({ type: 'send_message', conversationId: 'conversation-1', content: 'a', windowFrame: setup.frame, sequence: 1 });
      setup.dispatch({ type: 'close_window', windowFrame: setup.frame, sequence: 2,
        composerDraft: { conversationId: 'conversation-1', draft: 'a', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(closingMocks.finish).toHaveBeenCalledOnce());
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('a');
    } finally { setup.controller.dispose(); }
  });

  it('原生失败保留会话与独立模式，重试可关闭；迟到成功不收回新窗口', async () => {
    const setup = await harness();
    try {
      closingMocks.finish.mockRejectedValueOnce(new Error('native close failed'));
      setup.dispatch({ type: 'dock_window', sequence: 1, windowFrame: setup.frame });
      await vi.waitFor(() => expect(closingMocks.failed).toHaveBeenCalledWith(setup.frame.sessionId));
      expect(getMainChatWindowSessionId()).toBe(setup.frame.sessionId);
      expect(useAppStore.getState().chatPanelDetached).toBe(true);
      let finish!: () => void;
      closingMocks.finish.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
      setup.dispatch({ type: 'dock_window', sequence: 2, windowFrame: setup.frame });
      await vi.waitFor(() => expect(closingMocks.finish).toHaveBeenCalledTimes(2));
      const reopened = beginChatWindowSession();
      finish();
      await Promise.resolve(); await Promise.resolve();
      expect(getMainChatWindowSessionId()).toBe(reopened);
      expect(useAppStore.getState().chatPanelDetached).toBe(true);
    } finally { setup.controller.dispose(); }
  });

  it('无首帧且无草稿只凭固定窗口 session 可关闭，不借新帧授权旧草稿', async () => {
    const setup = await harness();
    try {
      setup.dispatch({ type: 'close_window', sessionId: setup.frame.sessionId, sequence: 1 });
      await vi.waitFor(() => expect(closingMocks.finish).toHaveBeenCalledWith(setup.frame.sessionId));
    } finally { setup.controller.dispose(); }
  });

  it('未建会话的旧项目草稿不能写入新项目的空输入区', async () => {
    useAppStore.setState({ activeConversationId: null, chatComposerLiveDraft: '' });
    const setup = await harness();
    try {
      useAppStore.setState((state) => ({ projects: [...state.projects, { ...state.projects[0], id: 'project-2' }],
        currentProjectId: 'project-2', activeConversationId: null, chatComposerLiveDraft: '新项目空输入' }));
      setup.dispatch({ type: 'close_window', requestId: 'old-scratch', sequence: 1, windowFrame: setup.frame,
        composerDraft: { conversationId: null, draft: '旧项目空输入', windowFrame: setup.frame } });
      await vi.waitFor(() => expect(closingMocks.response).toHaveBeenCalledWith('old-scratch', false, setup.frame.sessionId));
      expect(useAppStore.getState().chatComposerLiveDraft).toBe('新项目空输入');
      expect(closingMocks.finish).not.toHaveBeenCalled();
      expect(useAppStore.getState().chatPanelDetached).toBe(true);
    } finally { setup.controller.dispose(); }
  });
});

describe('detached chat sync controller', () => {
  it('旧窗已接收但尚未执行的异步请求不能在重开后获准执行', async () => {
    let releaseDigest!: (value: ArrayBuffer) => void;
    const hashing = new Promise<ArrayBuffer>((resolve) => { releaseDigest = resolve; });
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => hashing);
    const updateConfig = vi.spyOn(useAppStore.getState(), 'updateConfig');
    const emissions: ChatStateSync[] = [];
    let dispatch!: (action: ChatAction) => void;
    const controller = createDetachedChatSyncController({ enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { emissions.push(sync); },
      initListener: async (handler) => { dispatch = handler; return () => {}; } });
    await controller.start();
    try {
      const frame = syncFrame(emissions.at(-1))!;
      dispatch({ type: 'managed_request', requestId: 'delayed_old_window_request', scopeId: 'project-1', conversationId: 'conversation-1',
        windowFrame: frame, sequence: 1, operation: { kind: 'save_team_profile', profile: { version: 1, name: '旧窗配置',
          roles: { architect: '', writer: '', continuity: '', dialogue: '', director: '', storyboard: '', editor: '' }, maxCalls: 8, maxTotalTokens: 240000, maxOutputChars: 16000 } } });
      expect(digest).toHaveBeenCalledOnce();
      beginChatWindowSession();
      releaseDigest(new ArrayBuffer(32));
      await hashing;
      await Promise.resolve();
      expect(updateConfig).not.toHaveBeenCalled();
    } finally { releaseDigest(new ArrayBuffer(32)); digest.mockRestore(); updateConfig.mockRestore(); controller.dispose(); }
  });

  it.each(['close_window', 'dock_window'] as const)('编辑后 %s 再打开允许新窗从低序号操作，拒绝旧窗握手和迟到写入', async (closeType) => {
    const emissions: ChatStateSync[] = [];
    let dispatch!: (action: ChatAction) => void;
    let closed!: (draft?: ChatComposerHandoff, sessionId?: string) => void;
    const controller = createDetachedChatSyncController({ enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { emissions.push(sync); },
      initListener: async (onAction, onClosed) => { dispatch = onAction; closed = onClosed; return () => {}; } });
    await controller.start();
    try {
      await vi.waitFor(() => expect(syncFrame(emissions.at(-1))).toBeTruthy());
      const oldFrame = syncFrame(emissions.at(-1))!;
      dispatch({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: '原窗输入', windowFrame: oldFrame, sequence: 40 });
      dispatch({ type: 'request_sync', sessionId: oldFrame.sessionId });
      await vi.waitFor(() => expect(emissions.at(-1)?.acceptedSequence).toBe(40));
      expect(syncFrame(emissions.at(-1))?.sessionId).toBe(oldFrame.sessionId);
      dispatch({ type: closeType, windowFrame: oldFrame, sequence: 41,
        composerDraft: { conversationId: 'conversation-1', draft: '关闭前最后输入', windowFrame: oldFrame } });
      await vi.waitFor(() => expect(getMainChatWindowSessionId()).toBeUndefined());
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('关闭前最后输入');
      const sessionId = beginChatWindowSession();
      useAppStore.getState().setChatPanelDetached(true);
      await vi.waitFor(() => expect(syncFrame(emissions.at(-1))?.sessionId).toBe(sessionId));
      const nextFrame = syncFrame(emissions.at(-1))!;
      const count = emissions.length;
      dispatch({ type: 'request_sync', sessionId: oldFrame.sessionId });
      closed(undefined, oldFrame.sessionId);
      expect(emissions).toHaveLength(count);
      expect(getMainChatWindowSessionId()).toBe(sessionId);
      dispatch({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: '新窗输入', windowFrame: nextFrame, sequence: 1 });
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('新窗输入');
      dispatch({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: '旧窗迟到输入', windowFrame: oldFrame, sequence: 100 });
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('新窗输入');
      dispatch({ type: 'request_sync', sessionId });
      await vi.waitFor(() => expect(emissions.at(-1)?.acceptedSequence).toBe(1));
      dispatch({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: '同窗重复序号', windowFrame: nextFrame, sequence: 1 });
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('新窗输入');
    } finally { controller.dispose(); }
  });

  it('原生窗口入口拒绝旧协议和同 ID 替换后的迟到写入，保留原草稿', async () => {
    useAppStore.setState({ projectLoadStatus: 'ready', switchingProjectName: null,
      chatComposerLiveDraft: '保留草稿', chatComposerDrafts: { 'conversation-1': '保留草稿' } });
    const frames: ChatStateSync[] = [];
    let dispatch!: (action: ChatAction) => void;
    const controller = createDetachedChatSyncController({ enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { frames.push(sync); },
      initListener: async (onAction) => { dispatch = onAction; return () => {}; } });
    await controller.start();
    try {
      await Promise.resolve();
      const first = frames.find((item) => item.type === 'snapshot');
      if (!first || first.type !== 'snapshot' || !first.snapshot.windowFrame) throw new Error('missing published context');
      const captured = first.snapshot.windowFrame;
      dispatch({ type: 'send_message', conversationId: 'conversation-1', content: '旧协议' });
      expect(conversationControllerMocks.submit).not.toHaveBeenCalled();
      dispatch({ type: 'send_message', conversationId: 'conversation-1', content: '正常请求', windowFrame: captured, sequence: 1 });
      expect(conversationControllerMocks.submit).toHaveBeenCalledOnce();
      useAppStore.setState((state) => ({ projects: state.projects.map((item) => ({ ...item, exchangeEpoch: 1 })),
        chatComposerDrafts: { 'conversation-1': '替换后草稿' } }));
      dispatch({ type: 'send_message', conversationId: 'conversation-1', content: '迟到旧请求', windowFrame: captured, sequence: 2 });
      expect(conversationControllerMocks.submit).toHaveBeenCalledOnce();
      expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('替换后草稿');
    } finally { controller.dispose(); }
  });
  it('会话分集绑定经快照和补丁传递，但独立窗口发送不能声明或改绑目标', () => {
    const target = { seriesId: 'project-1', episodeId: 'episode-1' };
    useAppStore.setState({ projectLoadStatus: 'ready', isCreatingProject: false, isReturningToStartPage: false,
      switchingProjectName: null, projects: [...useAppStore.getState().projects,
        { id: 'episode-1', parentId: 'project-1', name: '第一集', createdAt: 1, updatedAt: 1 }] });
    const before = buildDetachedChatSnapshot(useAppStore.getState());
    useAppStore.getState().updateConversation('conversation-1', { workbenchTarget: target });
    const next = buildDetachedChatSnapshot(useAppStore.getState());
    expect(next.conversations[0].workbenchTarget).toEqual(target);
    expect(applyChatStatePatch(before, createChatStatePatch(before, next)).conversations[0].workbenchTarget).toEqual(target);
    handleDetachedChatAction({ type: 'send_message', conversationId: 'conversation-1', content: '继续检查',
      workbenchTarget: { seriesId: 'project-1', episodeId: 'forged-episode' } } as never, vi.fn());
    expect(conversationControllerMocks.submit).toHaveBeenCalledOnce();
    expect(conversationControllerMocks.submit.mock.calls[0][0]).not.toHaveProperty('workbenchTarget');
    expect(useAppStore.getState().conversations[0].workbenchTarget).toEqual(target);
  });

  it('projects profile options and previews without exposing full configuration', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, creationProfiles: [{ schemaVersion: 1, id: 'writing', version: '1.0.0', name: 'Writing',
      pluginRefs: [], agentPackageRefs: [], skillRefs: [], contextPolicyRef: 'project-default', toolAllowlist: ['web_search'] }] } }));
    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());
    expect(snapshot.creationProfiles).toEqual([{ id: 'writing', version: '1.0.0', name: 'Writing' }]);
    const preview = await executeManagedChatOperation({ kind: 'preview_creation_profile', profile: snapshot.creationProfiles![0] }, 'project-1', 'conversation-1') as { profile: unknown };
    expect(preview.profile).toEqual({ id: 'writing', version: '1.0.0', name: 'Writing' });
  });
  it('rejects stale scopes and non-whitelisted managed fields before actions', async () => {
    await expect(executeManagedChatOperation({ kind: 'refresh_external_agents' }, 'other-project', 'conversation-1')).rejects.toThrow('项目已变化');
    await expect(executeManagedChatOperation({ kind: 'refresh_external_agents', executable: 'arbitrary' } as never, 'project-1')).rejects.toThrow('参数无效');
    await expect(executeManagedChatOperation({ kind: 'resolve_dispatch', taskId: 'task', dispatchId: 'dispatch', decision: 'retry' } as never, 'project-1')).rejects.toThrow('核实结果');
  });
  it('immediately sends a complete snapshot when switching projects despite a long sync interval', async () => {
    const frames: ChatStateSync[] = [];
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 60_000, now: () => 1,
      emitSync: async (sync) => { frames.push(sync); },
      initListener: async () => () => undefined,
    });
    await controller.start();
    try {
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ type: 'snapshot', snapshot: { projectId: 'project-1', activeConversationId: 'conversation-1' } });
      useAppStore.setState((state) => ({
        currentProjectId: 'project-2',
        projects: [...state.projects, { id: 'project-2', name: 'Another project', createdAt: 2, updatedAt: 2 }],
      }));
      // 不推进计时器：项目切换必须越过普通节流，立即撤下旧窗口会话。
      expect(frames).toHaveLength(2);
      expect(frames[1]).toMatchObject({ type: 'snapshot', snapshot: {
        projectId: 'project-2', activeConversationId: null, conversations: [],
      } });
      expect(receiveChatStateSync(receiveChatStateSync(null, frames[0]), frames[1])?.snapshot.activeConversationId).toBeNull();
    } finally {
      controller.dispose();
    }
  });

  it('rejects a stale detached conversation selection even when the previous project remains cached', async () => {
    useAppStore.setState((state) => ({
      currentProjectId: 'project-2', activeConversationId: 'conversation-2',
      projects: [...state.projects, { id: 'project-2', name: 'Another project', createdAt: 2, updatedAt: 2 }],
      conversations: [...state.conversations, { ...state.conversations[0], id: 'conversation-2', projectId: 'project-2' }],
      messages: [{ id: 'message-2', conversationId: 'conversation-2', role: 'assistant', content: 'Current project', timestamp: 2, status: 'done' }],
    }));
    let finish!: () => void;
    const pendingRead = new Promise<void>((resolve) => { finish = resolve; });
    const loadMessages = vi.spyOn(useAppStore.getState(), 'loadConversationMessages').mockReturnValue(pendingRead);
    try {
      handleDetachedChatAction({ type: 'switch_conversation', conversationId: 'conversation-1' }, vi.fn());
      expect(loadMessages).toHaveBeenCalledWith('conversation-1');
      expect(useAppStore.getState().activeConversationId).toBe('conversation-2');
      finish();
      await pendingRead;
      expect(useAppStore.getState().activeConversationId).toBe('conversation-2');
      expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(['message-2']);
      expect(buildDetachedChatSnapshot(useAppStore.getState()).conversations.map((conversation) => conversation.id)).toEqual(['conversation-2']);
    } finally {
      finish();
      loadMessages.mockRestore();
    }
  });

  it('creates and sends the first general conversation through the main store on the start page', () => {
    useAppStore.setState({ currentProjectId: null, activeConversationId: null, conversations: [] });
    handleDetachedChatAction({ type: 'send_message', content: '帮我写一份提纲' }, vi.fn());
    const state = useAppStore.getState();
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].projectId).toBe(GENERAL_ASSISTANT_SCOPE_ID);
    expect(conversationControllerMocks.submit).toHaveBeenCalledWith(expect.objectContaining({
      projectId: GENERAL_ASSISTANT_SCOPE_ID, conversationId: state.conversations[0].id,
    }));
    expect(state.projects.map((project) => project.id)).toEqual(['project-1']);
  });

  it('keeps an image request bound to the active episode when its conversation belongs to the series', () => {
    useAppStore.setState({ currentProjectId: 'episode-1', projects: [
      ...useAppStore.getState().projects,
      { id: 'episode-1', parentId: 'project-1', episodeNo: 1, name: 'Episode', createdAt: 1, updatedAt: 1 },
    ] });
    handleDetachedChatAction({ type: 'send_message', conversationId: 'conversation-1', content: '看看', imageFileNames: [] }, vi.fn());
    expect(conversationControllerMocks.submit).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'episode-1' }));
  });

  it('retains detached text when image validation rejects the submission', () => {
    useAppStore.getState().setChatComposerLiveDraft('保留我的输入', 'conversation-1');
    conversationControllerMocks.submit.mockReturnValueOnce({ status: 'ignored' });
    handleDetachedChatAction({ type: 'send_message', content: '保留我的输入', conversationId: 'conversation-1',
      imageFileNames: ['chat-ref-11111111-1111-4111-8111-111111111111.png'] }, vi.fn());
    expect(conversationControllerMocks.submit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('保留我的输入');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('保留我的输入');
  });

  it('does not replace a newer detached draft with rejected submitted text', () => {
    useAppStore.getState().setChatComposerLiveDraft('发送后继续编辑', 'conversation-1');
    conversationControllerMocks.submit.mockReturnValueOnce({ status: 'ignored' });
    handleDetachedChatAction({ type: 'send_message', content: '之前发送的内容', conversationId: 'conversation-1',
      imageFileNames: ['chat-ref-11111111-1111-4111-8111-111111111111.png'] }, vi.fn());
    expect(useAppStore.getState().chatComposerDrafts['conversation-1']).toBe('发送后继续编辑');
  });

  it('synchronizes pending image metadata through snapshots and patches and routes removal to the main store', () => {
    const fileName = 'chat-ref-11111111-1111-4111-8111-111111111111.png';
    const before = buildDetachedChatSnapshot(useAppStore.getState());
    useAppStore.getState().addChatImageDraft('conversation-1', { fileName, label: '参考图.png', size: 4 });
    const withImage = buildDetachedChatSnapshot(useAppStore.getState());
    const patched = applyChatStatePatch(before, createChatStatePatch(before, withImage));
    expect(patched.imageDrafts).toEqual([{ fileName, label: '参考图.png', size: 4 }]);
    handleDetachedChatAction({ type: 'send_message', conversationId: 'conversation-1', content: '', imageFileNames: [fileName] }, vi.fn());
    expect(conversationControllerMocks.submit).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1', content: '', imageFileNames: [fileName],
    }));
    handleDetachedChatAction({ type: 'remove_image_attachment', conversationId: 'conversation-1', fileName }, vi.fn());
    const removed = buildDetachedChatSnapshot(useAppStore.getState());
    expect(applyChatStatePatch(patched, createChatStatePatch(withImage, removed)).imageDrafts).toEqual([]);
  });

  it('synchronizes submit shortcuts after config hydration and saves detached changes in the main store', async () => {
    const saveConfig = vi.fn(async () => undefined);
    useAppStore.setState((state) => ({
      config: { ...state.config, promptSubmitShortcut: 'alt-enter' },
      saveConfig,
    }));
    let mirror: ChatWindowState | null = null;
    const readMirror = (): ChatWindowState | null => mirror;
    let onAction!: (action: ChatAction) => void;
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { mirror = receiveChatStateSync(mirror, structuredClone(sync)); },
      initListener: async (handler) => { onAction = windowActions(handler, () => readMirror()?.snapshot.windowFrame); return () => undefined; },
    });
    await controller.start();
    try {
      await vi.waitFor(() => expect(readMirror()).not.toBeNull());
      expect(readMirror()?.snapshot.promptSubmitShortcut).toBeUndefined();
      useAppStore.setState({ configHydrated: true });
      await vi.waitFor(() => expect(readMirror()?.snapshot.promptSubmitShortcut).toBe('alt-enter'));

      onAction({ type: 'set_prompt_submit_shortcut', shortcut: 'ctrl-enter' });
      expect(useAppStore.getState().config.promptSubmitShortcut).toBe('ctrl-enter');
      expect(saveConfig).toHaveBeenCalledWith({ silent: true });
      await vi.waitFor(() => expect(readMirror()?.snapshot.promptSubmitShortcut).toBe('ctrl-enter'));

      useAppStore.setState({ configHydrated: false });
      await vi.waitFor(() => expect(readMirror()?.snapshot.promptSubmitShortcut).toBeUndefined());
    } finally {
      controller.dispose();
    }
  });

  it('rejects shortcut changes before config hydration and rejects unsupported event values', () => {
    const saveConfig = vi.fn(async () => undefined);
    const requestSync = vi.fn();
    useAppStore.setState({ saveConfig });
    const originalConfig = useAppStore.getState().config;
    handleDetachedChatAction({ type: 'set_prompt_submit_shortcut', shortcut: 'alt-enter' }, requestSync);
    expect(useAppStore.getState().config).toBe(originalConfig);

    useAppStore.setState({ configHydrated: true });
    handleDetachedChatAction({ type: 'set_prompt_submit_shortcut', shortcut: 'meta-enter' } as unknown as ChatAction, requestSync);
    expect(useAppStore.getState().config).toBe(originalConfig);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('独立窗口将 Skill 使用统一交给主窗口 Action 校验来源与可用性，仅提前拒绝非法 ID', async () => {
    const markSkillUsed = vi.fn(async () => undefined);
    const showToast = vi.fn();
    const requestSync = vi.fn();
    const uploaded = { id: 'uploaded-skill', name: '上传 Skill', description: '用途', fileName: 'SKILL.md',
      content: '只读正文', sourceType: 'file' as const, createdAt: 1 };
    useAppStore.setState({ markSkillUsed, showToast,
      userSkills: [uploaded, { ...uploaded, id: 'disabled-skill', manifest: { userInvocable: false } }] });

    handleDetachedChatAction({ type: 'mark_skill_used', skillId: 'uploaded-skill' }, requestSync);
    handleDetachedChatAction({ type: 'mark_skill_used', skillId: 'disabled-skill' }, requestSync);
    handleDetachedChatAction({ type: 'mark_skill_used', skillId: 'package-a-skill' }, requestSync);
    handleDetachedChatAction({ type: 'mark_skill_used', skillId: 'package-b-skill' }, requestSync);
    handleDetachedChatAction({ type: 'mark_skill_used', skillId: 'missing-skill' }, requestSync);
    handleDetachedChatAction({ type: 'mark_skill_used', skillId: 'x'.repeat(161) }, requestSync);
    handleDetachedChatAction({ type: 'mark_skill_used', skillId: 42 } as unknown as ChatAction, requestSync);
    await Promise.resolve();

    expect(markSkillUsed.mock.calls).toEqual([
      ['uploaded-skill'], ['disabled-skill'], ['package-a-skill'], ['package-b-skill'], ['missing-skill'],
    ]);
    expect(useAppStore.getState().userSkills[0]).toBe(uploaded);
    expect(requestSync).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();

    markSkillUsed.mockRejectedValueOnce(new Error('private storage detail'));
    handleDetachedChatAction({ type: 'mark_skill_used', skillId: 'uploaded-skill' }, requestSync);
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledExactlyOnceWith('最近 Skill 使用记录保存失败', 'error');
  });

  it('窗口会话更换后忽略旧帧发来的 Skill 使用记录', async () => {
    const markSkillUsed = vi.fn(async () => undefined);
    useAppStore.setState({ markSkillUsed, userSkills: [{ id: 'uploaded-skill', name: '上传 Skill', description: '用途',
      fileName: 'SKILL.md', content: '只读正文', sourceType: 'file', createdAt: 1 }] });
    const emissions: ChatStateSync[] = [];
    let dispatch!: (action: ChatAction) => void;
    const controller = createDetachedChatSyncController({ enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { emissions.push(sync); },
      initListener: async (handler) => { dispatch = handler; return () => undefined; } });
    await controller.start();
    try {
      const frame = syncFrame(emissions.at(-1))!;
      beginChatWindowSession();
      dispatch({ type: 'mark_skill_used', skillId: 'uploaded-skill', windowFrame: frame, sequence: 1 });
      expect(markSkillUsed).not.toHaveBeenCalled();
    } finally { controller.dispose(); }
  });

  it('uses the same branded and visible model options as the embedded chat, including workflows', () => {
    useAppStore.setState((state) => ({
      config: { ...state.config, providers: {
        cccapi: { name: 'CCC API', apiKey: 'do-not-sync-key', baseUrl: 'https://private.example/v1', catalogId: 'cccapi', visibleModelCategories: ['text', 'image'] },
      }, generalModels: [
        { id: 'text-1', name: '文本模型', modelId: 'text-model', category: 'text', providerConfigId: 'cccapi' },
        { id: 'image-1', name: '图片模型', modelId: 'image-model', category: 'image', providerConfigId: 'cccapi' },
        { id: 'hidden-video', name: '隐藏视频', modelId: 'video-model', category: 'video', providerConfigId: 'cccapi' },
      ] },
      workflows: [{ id: 'local-image', name: '本地图像工作流', category: 'ai-image', fileName: 'local.json', fileContent: 'PRIVATE_WORKFLOW_BODY', createdAt: 1 }],
    }));
    const state = useAppStore.getState();
    const catalog = buildChatModelCatalog(state);
    const snapshot = buildDetachedChatSnapshot(state);
    expect(snapshot.assistantModelGroups).toBe(catalog.assistantModelGroups);
    expect(snapshot.assistantModelGroups).toContainEqual(expect.objectContaining({
      id: 'general-provider-cccapi', models: [expect.objectContaining({ value: 'general/text-1' })],
    }));
    expect(snapshot.mediaModelOptions).toBe(catalog.mediaModelOptions);
    expect(snapshot.mediaModelOptions).toContainEqual(expect.objectContaining({ value: 'comfyui/local-image', workflowId: 'local-image' }));
    expect(snapshot.mediaModelOptions.some((option) => option.value === 'general/hidden-video')).toBe(false);
    expect(snapshot.mediaModelAvailability?.['comfyui/local-image']).toBe(true);
    for (const secret of ['do-not-sync-key', 'private.example', 'PRIVATE_WORKFLOW_BODY']) expect(JSON.stringify(snapshot)).not.toContain(secret);
    useAppStore.setState({ workflows: [] });
    expect(buildDetachedChatSnapshot(useAppStore.getState()).mediaModelOptions.some((option) => option.workflowId === 'local-image')).toBe(false);
  });

  it('receives only valid revision chains and ignores old snapshots without reverting progress', () => {
    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());
    const current = receiveChatStateSync(null, { type: 'snapshot', revision: 10, snapshot })!;
    useAppStore.getState().setChatPanelView('tasks');
    const nextSnapshot = buildDetachedChatSnapshot(useAppStore.getState());
    const patch = createChatStatePatch(snapshot, nextSnapshot);
    expect(receiveChatStateSync(null, { type: 'patch', baseRevision: 0, revision: 1, patch })).toBeNull();
    expect(receiveChatStateSync(current, { type: 'patch', baseRevision: 9, revision: 11, patch })).toBeNull();
    const next = receiveChatStateSync(current, { type: 'patch', baseRevision: 10, revision: 11, patch })!;
    expect(next.snapshot.panelView).toBe('tasks');
    expect(receiveChatStateSync(next, { type: 'snapshot', revision: 10, snapshot })).toBe(next);
    expect(receiveChatStateSync(next, { type: 'patch', baseRevision: 10, revision: 11, patch })).toBe(next);
  });

  it('keeps one running task and its streamed messages when docking and reopening', async () => {
    const task = useAppStore.getState().createAgentTask({
      projectId: 'project-1', conversationId: 'conversation-1', userMessageId: 'user-1',
      mode: 'collaborative', goal: '继续回答',
    });
    let finish!: (outcome: 'completed') => void;
    const executor = vi.fn((_signal: AbortSignal) => new Promise<'completed'>((resolve) => { finish = resolve; }));
    const running = runAgentTask(task.id, executor);
    let mirror: ChatWindowState | null = null;
    const readMirror = (): ChatWindowState | null => mirror;
    let onAction!: (action: ChatAction) => void;
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { mirror = receiveChatStateSync(mirror, structuredClone(sync)); },
      initListener: async (handler) => { onAction = windowActions(handler, () => readMirror()?.snapshot.windowFrame); return () => undefined; },
    });
    await controller.start();
    try {
      await vi.waitFor(() => expect(readMirror()?.snapshot.agentTasks[0].status).toBe('running'));
      useAppStore.setState({ messages: [{
        id: 'answer-1', conversationId: 'conversation-1', role: 'assistant',
        content: '开始回答', timestamp: 1, status: 'streaming', agentTaskId: task.id,
      }] });
      await vi.waitFor(() => expect(readMirror()?.snapshot.messages[0].content).toBe('开始回答'));
      onAction({ type: 'dock_window', composerDraft: { conversationId: 'conversation-1', draft: '追加问题' } });
      await vi.waitFor(() => expect(useAppStore.getState()).toMatchObject({ chatPanelDetached: false, chatComposerLiveDraft: '追加问题' }));
      expect(useAppStore.getState().agentTasks[0].status).toBe('running');
      expect(executor.mock.calls[0][0].aborted).toBe(false);
      useAppStore.setState((state) => ({ messages: state.messages.map((message) => ({ ...message, content: '回答继续更新' })) }));
      mirror = null;
      beginChatWindowSession();
      useAppStore.getState().setChatPanelDetached(true);
      await vi.waitFor(() => expect(readMirror()?.snapshot.messages[0].content).toBe('回答继续更新'));
      expect(readMirror()?.snapshot.composerDraft).toBe('追加问题');
      expect(readMirror()?.snapshot.agentTasks[0].status).toBe('running');
      finish('completed');
      await running;
      await vi.waitFor(() => expect(readMirror()?.snapshot.agentTasks[0].status).toBe('completed'));
      expect(executor).toHaveBeenCalledTimes(1);
    } finally {
      finish('completed');
      await running;
      controller.dispose();
    }
  });

  it('拒绝没有原帧的迟到草稿，当前会话的有效交接仍可收回', async () => {
    useAppStore.setState((state) => ({ conversations: [...state.conversations, { ...state.conversations[0], id: 'conversation-2' }] }));
    useAppStore.getState().setActiveConversation('conversation-2');
    useAppStore.getState().setChatComposerLiveDraft('乙的草稿');
    let onAction!: (action: ChatAction) => void;
    let rawAction!: (action: ChatAction) => void;
    let onClose!: (draft?: { conversationId: string | null; draft: string }) => void;
    let publishedFrame: ProjectWindowFrame | null | undefined;
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0, emitSync: async (sync) => { publishedFrame = sync.type === 'snapshot' ? sync.snapshot.windowFrame : sync.patch.fields.windowFrame; },
      initListener: async (action, close) => { rawAction = action; onAction = windowActions(action, () => publishedFrame); onClose = close; return () => undefined; },
    });
    await controller.start();
    rawAction({ type: 'set_composer_draft', conversationId: 'conversation-1', draft: '甲的迟到输入' });
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('乙的草稿');
    onClose({ conversationId: 'conversation-1', draft: '甲的最后一次输入' });
    expect(buildDetachedChatSnapshot(useAppStore.getState()).composerDrafts).toEqual({
      'conversation-2': '乙的草稿',
    });
    onAction({ type: 'set_panel_view', view: 'tasks' });
    onAction({ type: 'dock_window', composerDraft: { conversationId: 'conversation-2', draft: '' } });
    await vi.waitFor(() => expect(useAppStore.getState()).toMatchObject({ chatComposerLiveDraft: '', chatPanelView: 'tasks', chatPanelDetached: false }));
    controller.dispose();
  });

  it('uses a newer snapshot after a dock during an unfinished emission', async () => {
    let release!: () => void;
    const frames: ChatStateSync[] = [];
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => {
        frames.push(sync);
        if (frames.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      },
      initListener: async () => () => undefined,
    });
    await controller.start();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    useAppStore.getState().setChatPanelDetached(false);
    useAppStore.getState().setChatPanelView('tasks');
    useAppStore.getState().setChatPanelDetached(true);
    release();
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    const latest = frames[1];
    expect(latest.type).toBe('snapshot');
    expect(latest.revision).toBeGreaterThan(frames[0].revision);
    const mirror = receiveChatStateSync(null, latest)!;
    expect(mirror.snapshot.panelView).toBe('tasks');
    expect(receiveChatStateSync(mirror, frames[0])).toBe(mirror);
    useAppStore.getState().setChatPanelView('list');
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[2]).toMatchObject({ type: 'patch', baseRevision: latest.revision });
    expect(receiveChatStateSync(mirror, frames[2])?.snapshot.panelView).toBe('list');
    controller.dispose();
  });

  it('refreshes workflow model choices when workflows change without a config change', async () => {
    const frames: ChatStateSync[] = [];
    const controller = createDetachedChatSyncController({
      enabled: true, syncIntervalMs: 0,
      emitSync: async (sync) => { frames.push(sync); }, initListener: async () => () => undefined,
    });
    await controller.start();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const mirror = receiveChatStateSync(null, frames[0])!;
    const config = useAppStore.getState().config;
    useAppStore.setState({ workflows: [{ id: 'new-flow', name: '新工作流', category: 'ai-image', fileName: 'new.json', fileContent: 'PRIVATE_BODY', createdAt: 1 }] });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(useAppStore.getState().config).toBe(config);
    expect(receiveChatStateSync(mirror, frames[1])?.snapshot.mediaModelOptions).toContainEqual(expect.objectContaining({ workflowId: 'new-flow' }));
    expect(JSON.stringify(frames[1])).not.toContain('PRIVATE_BODY');
    controller.dispose();
  });

  it('publishes and updates the current project text model', async () => {
    const updateProjectSettings = vi.fn(async () => true);
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        settings: { defaultModels: { text: 'general/project-model' } },
      })),
      config: { ...state.config, assistantModelId: 'general/application-model' },
      updateProjectSettings,
    }));
    expect(buildDetachedChatSnapshot(useAppStore.getState()).assistantModelId)
      .toBe('general/project-model');

    let onAction: ((action: ChatAction) => void) | undefined;
    let publishedFrame: ProjectWindowFrame | null | undefined;
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync: vi.fn(async (sync: ChatStateSync) => { publishedFrame = syncFrame(sync); }),
      initListener: vi.fn(async (handler) => {
        onAction = windowActions(handler, () => publishedFrame);
        return () => undefined;
      }),
    });
    await controller.start();
    onAction?.({ type: 'select_model', category: 'text', modelId: 'general/next-model' });
    expect(updateProjectSettings).toHaveBeenCalledWith(expect.objectContaining({
      defaultModels: { text: 'general/next-model' },
    }));
    expect(useAppStore.getState().config.assistantModelId).toBe('general/application-model');
    controller.dispose();
  });

  it('publishes the bound workbench episode model while preserving canvas scope and rejects text model changes', () => {
    const updateSettings = vi.fn(async () => true);
    useAppStore.setState((state) => ({ currentProjectId: 'episode-a',
      projects: [...state.projects,
        { id: 'episode-a', parentId: 'project-1', name: '画布A', createdAt: 1, updatedAt: 1,
          settings: { defaultModels: { text: 'general/model-a' } } },
        { id: 'episode-b', parentId: 'project-1', name: '目标B', createdAt: 1, updatedAt: 1,
          settings: { defaultModels: { text: 'general/model-b' } } }],
      conversations: state.conversations.map((conversation) => ({ ...conversation,
        workbenchTarget: { seriesId: 'project-1', episodeId: 'episode-b' } })),
      updateProjectSettings: updateSettings,
    }));
    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());
    expect(snapshot.assistantModelId).toBe('general/model-b');
    expect(snapshot.projectId).toBe('episode-a');
    expect(snapshot.conversations[0].projectId).toBe('project-1');
    const beforeConfig = useAppStore.getState().config;
    handleDetachedChatAction({ type: 'select_model', category: 'text', modelId: 'general/other' }, vi.fn());
    expect(updateSettings).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toBe(beforeConfig);
    expect(useAppStore.getState().currentProjectId).toBe('episode-a');
  });

  it('projects configured text model groups without provider credentials', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          apimart: {
            name: 'APIMart',
            apiKey: 'provider-secret-key',
            baseUrl: 'https://private-gateway.example/v1',
            selectedModels: [{
              id: 'apimart/gpt-5.4',
              name: 'GPT-5.4',
              category: 'text',
              provider: 'apimart',
            }],
          },
        },
      },
    }));

    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());

    expect(snapshot.assistantModelGroups).toEqual([
      expect.objectContaining({
        id: 'apimart',
        models: [expect.objectContaining({ value: 'apimart/gpt-5.4' })],
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('provider-secret-key');
    expect(JSON.stringify(snapshot)).not.toContain('private-gateway.example');
  });

  it('emits an initial snapshot followed by revisioned patches', async () => {
    const emitSync = vi.fn(async (_sync: ChatStateSync) => undefined);
    const initListener = vi.fn(async () => () => undefined);
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync,
      initListener,
      now: () => 1,
    });

    await controller.start();
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(1));
    const initialRevision = emitSync.mock.calls[0][0].revision;
    expect(emitSync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'snapshot',
      revision: initialRevision,
    }));

    useAppStore.setState({
      messages: [{
        id: 'message-1',
        conversationId: 'conversation-1',
        role: 'user',
        content: 'hello',
        timestamp: 2,
        status: 'done',
      }],
    });

    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(2));
    expect(emitSync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'patch',
      baseRevision: initialRevision,
      revision: expect.any(Number),
    }));
    expect(emitSync.mock.calls[1][0].revision).toBeGreaterThan(initialRevision);
    controller.dispose();
  });

  it('routes detached actions, keeps detached mode on close, and only docks explicitly', async () => {
    let onAction: ((action: ChatAction) => void) | undefined;
    let onDetachClosed: ((draft?: ChatComposerHandoff, sessionId?: string) => void) | undefined;
    const emitSync = vi.fn(async (_sync: ChatStateSync) => undefined);
    const cleanup = vi.fn();
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync,
      initListener: vi.fn(async (actionHandler, closeHandler) => {
        onAction = windowActions(actionHandler, () => syncFrame(emitSync.mock.lastCall?.[0]));
        onDetachClosed = closeHandler;
        return cleanup;
      }),
      now: () => 1,
    });

    await controller.start();
    onAction?.({
      type: 'send_message',
      conversationId: 'conversation-1',
      content: 'from detached window',
      dispatchMode: 'interject',
    });
    expect(conversationControllerMocks.submit).toHaveBeenCalledWith({
      content: 'from detached window',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      mode: 'collaborative',
      dispatchMode: 'interject',
    });

    onAction?.({ type: 'request_sync', sessionId: getMainChatWindowSessionId() });
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalled());

    onDetachClosed?.(undefined, getMainChatWindowSessionId());
    expect(useAppStore.getState()).toMatchObject({
      chatOpen: false,
      chatPanelDetached: true,
      hoveredMentionNodeId: null,
    });

    beginChatWindowSession();
    await vi.waitFor(() => expect(syncFrame(emitSync.mock.lastCall?.[0])?.sessionId).toBe(getMainChatWindowSessionId()));
    onAction?.({ type: 'dock_window' });
    await vi.waitFor(() => expect(useAppStore.getState()).toMatchObject({
      chatOpen: true,
      chatPanelDetached: false,
      hoveredMentionNodeId: null,
    }));

    controller.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('projects task Skill bindings without syncing frozen bodies or package audit paths', () => {
    const task = {
      id: 'task-with-package-skill',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      mode: 'collaborative' as const,
      goal: '检查剧本',
      status: 'completed' as const,
      steps: [],
      modelRounds: 1,
      toolCallCount: 0,
      budget: {
        maxModelRounds: 12,
        maxToolCalls: 24,
        maxParallelReadTools: 3,
        maxReadRetries: 3,
      },
      skillBindings: [{
        skillId: 'ap-skill-secret',
        name: '短剧检查',
        version: '1.0.0',
        content: '冻结的任务 Skill 正文不应跨窗口',
        origin: 'agent-package' as const,
        packageId: 'com.example.secret',
        packageName: 'AI短剧知识库',
        packageVersion: '1.4.1',
        entryPath: '04-分镜设计/secret/SKILL.md',
        contentHash: 'binding-content-hash-secret',
        allowedTools: ['canvas_get_state'],
      }],
      createdAt: 1,
      updatedAt: 2,
    };
    useAppStore.setState({ agentTasks: [task] });

    const first = buildDetachedChatSnapshot(useAppStore.getState());
    expect(first.agentTasks[0].skillBindings).toEqual([{
      skillId: 'ap-skill-secret',
      name: '短剧检查',
      version: '1.0.0',
      content: '',
      allowedTools: ['canvas_get_state'],
    }]);
    const serialized = JSON.stringify(first.agentTasks);
    expect(serialized).not.toContain('冻结的任务 Skill 正文');
    expect(serialized).not.toContain('04-分镜设计/secret/SKILL.md');
    expect(serialized).not.toContain('binding-content-hash-secret');
    expect(serialized).not.toContain('com.example.secret');
    expect(serialized).not.toContain('AI短剧知识库');

    // Store 只换数组但任务对象未变时，沿用投影数组，避免无意义的时间线 patch。
    useAppStore.setState({ agentTasks: [task] });
    const second = buildDetachedChatSnapshot(useAppStore.getState());
    expect(second.agentTasks).toBe(first.agentTasks);
  });

  it('mirrors canvas slices to the detached window without leaking node bodies', async () => {
    useAppStore.setState({
      nodes: [{
        id: 'node-1',
        type: 'ai-image',
        position: { x: 120, y: 240 },
        data: {
          label: '主角立绘',
          type: 'ai-image',
          displayId: 3,
          thumbnailUrl: 'asset://thumb-1',
          prompt: '不应跨窗口传输的提示词',
        },
      }],
      chatComposerLiveDraft: '内嵌浮窗里没发出去的草稿',
      chatComposerDrafts: { 'conversation-1': '内嵌浮窗里没发出去的草稿' },
      userSkills: [{
        id: 'skill-1',
        name: '分镜脚本',
        description: '把剧本拆成分镜',
        fileName: 'storyboard.md',
        content: '技能正文很长，不该跨窗口传',
        sourceType: 'file',
        createdAt: 1,
      }],
      agentPackages: [{ id: 'agent-package-1', packageId: 'com.example.drama',
        manifest: { schemaVersion: 1, id: 'com.example.drama', name: 'AI短剧知识库', version: '1.4.1',
          entrypoints: { instructions: '01-国内短剧/开场钩子/SKILL.md' }, supportedScopes: ['global'], supportedSurfaces: ['assistant'],
          routing: { userInvocable: true, autoInvoke: false } },
        source: { sourceId: 'opaque-source-secret', sourceType: 'folder', displayName: 'AI短剧知识库' },
        entrypoints: ['01-国内短剧/开场钩子/SKILL.md'], skillCount: 1, fileCount: 1, totalBytes: 1, warnings: [],
        health: 'ready', contentHash: 'package-hash', enabled: true, mcpSkillReadEnabled: false, installedAt: 1, updatedAt: 1 }],
      agentPackageSkills: [{
        id: 'ap-skill-1',
        name: '短剧开场钩子',
        description: '为短剧设计前三秒钩子',
        fileName: 'SKILL.md',
        content: '智能体 Skill 正文不应跨窗口传输',
        sourceType: 'agent-package',
        createdAt: 2,
        installationId: 'agent-package-1',
        packageId: 'com.example.drama',
        packageName: 'AI短剧知识库',
        packageVersion: '1.4.1',
        packageContentHash: 'package-hash',
        sourceId: 'opaque-source-secret',
        entryPath: '01-国内短剧/开场钩子/SKILL.md',
        skillRoot: '01-国内短剧/开场钩子',
        contentHash: 'skill-hash',
        branch: 'domestic',
        packageUserInvocable: true,
        packageAutoInvoke: false,
        mcpSkillReadEnabled: false,
        readOnly: true,
      }],
    });

    const snapshot = buildDetachedChatSnapshot(useAppStore.getState());
    expect(snapshot.composerDraft).toBe('内嵌浮窗里没发出去的草稿');
    // 独立窗口只同步可选择元数据；用户与智能体 Skill 正文都留在主窗口。
    expect(snapshot.skillOptions).toEqual([
      {
        id: 'skill-1',
        name: '分镜脚本',
        description: '把剧本拆成分镜',
        fileName: 'storyboard.md',
        sourceKind: 'user',
        sourceGroupId: 'user-skills',
        sourceLabel: '我的 Skill',
      },
      {
        id: 'ap-skill-1',
        name: '短剧开场钩子',
        description: '为短剧设计前三秒钩子',
        fileName: 'SKILL.md',
        sourceKind: 'agent-package',
        sourceGroupId: 'agent-package-1',
        sourceLabel: 'AI短剧知识库',
      },
    ]);
    expect(snapshot).not.toHaveProperty('userSkills');
    expect(JSON.stringify(snapshot)).not.toContain('技能正文很长');
    expect(JSON.stringify(snapshot)).not.toContain('智能体 Skill 正文');
    expect(JSON.stringify(snapshot)).not.toContain('opaque-source-secret');
    expect(JSON.stringify(snapshot)).not.toContain('01-国内短剧/开场钩子/SKILL.md');
    expect(snapshot.nodes).toEqual([{
      id: 'node-1',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: '主角立绘',
        type: 'ai-image',
        displayId: 3,
        imageUrl: undefined,
        videoUrl: undefined,
        thumbnailUrl: 'asset://thumb-1',
      },
    }]);

    const emitSync = vi.fn(async (_sync: ChatStateSync) => undefined);
    let onAction: ((action: ChatAction) => void) | undefined;
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync,
      initListener: vi.fn(async (handler) => {
        onAction = windowActions(handler, () => syncFrame(emitSync.mock.lastCall?.[0]));
        return () => undefined;
      }),
      now: () => 1,
    });
    await controller.start();
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(1));

    // 智能体停用后运行时目录会移除包内 Skill，独立窗口应收到精简删除补丁。
    useAppStore.setState({ agentPackageSkills: [] });
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(2));
    const skillRemoval = emitSync.mock.calls[1][0];
    expect(skillRemoval.type).toBe('patch');
    if (skillRemoval.type !== 'patch') throw new Error('expected skill removal patch');
    const withoutPackageSkill = applyChatStatePatch(snapshot, skillRemoval.patch);
    expect(withoutPackageSkill.skillOptions.map((option) => option.id)).toEqual(['skill-1']);

    // 节点改名要作为补丁推到独立窗口
    useAppStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({
        ...node,
        data: { ...node.data, label: '主角立绘 v2' },
      })),
    }));
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(3));
    const third = emitSync.mock.calls[2][0];
    expect(third.type).toBe('patch');
    if (third.type !== 'patch') throw new Error('expected patch sync');
    const patched = applyChatStatePatch(withoutPackageSkill, third.patch);
    expect(patched.nodes[0].data.label).toBe('主角立绘 v2');

    // 独立窗口回写草稿，收回内嵌时接得上
    onAction?.({ type: 'set_composer_draft', draft: '独立窗口里改过的草稿' });
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('独立窗口里改过的草稿');

    controller.dispose();
  });

  it('projects playable video URLs and patches source changes without leaking file paths or bodies', () => {
    const node = (videoUrl: string, x = 0) => ({
      id: 'video-node', type: 'source-video', position: { x, y: 0 },
      data: { label: '源视频', type: 'source-video' as const, videoUrl, thumbnailUrl: 'asset://localhost/poster.png',
        filePath: 'PRIVATE_FILE_PATH', prompt: 'PRIVATE_PROMPT', output: 'PRIVATE_OUTPUT' },
    });
    useAppStore.setState({ nodes: [node('asset://localhost/first.mp4')] });
    const first = buildDetachedChatSnapshot(useAppStore.getState());
    expect(first.nodes[0].data.videoUrl).toBe('asset://localhost/first.mp4');
    expect(JSON.stringify(first.nodes)).not.toContain('PRIVATE_');
    useAppStore.setState({ nodes: [node('asset://localhost/first.mp4', 120)] });
    expect(buildDetachedChatSnapshot(useAppStore.getState()).nodes).toBe(first.nodes);
    useAppStore.setState({ nodes: [node('asset://localhost/second.mp4', 120)] });
    const next = buildDetachedChatSnapshot(useAppStore.getState());
    const patch = createChatStatePatch(first, next);
    expect(patch.nodes?.upserted[0].data.videoUrl).toBe('asset://localhost/second.mp4');
    expect(applyChatStatePatch(first, patch).nodes[0].data.videoUrl).toBe('asset://localhost/second.mp4');
    expect(JSON.stringify(patch.nodes)).not.toContain('PRIVATE_');
  });

  it('keeps the node projection stable across canvas drags', () => {
    const node = (id: string, label: string, x: number) => ({
      id,
      type: 'ai-image',
      position: { x, y: 0 },
      data: { label, type: 'ai-image' as const, displayId: 1 },
    });

    const first = projectChatNodes([node('a', '甲', 0), node('b', '乙', 0)]);
    // 拖动只换坐标与数组引用，投影必须原样返回，才能让补丁层的 Object.is 短路
    const dragged = projectChatNodes([node('a', '甲', 120), node('b', '乙', 40)]);
    expect(dragged).toBe(first);

    const renamed = projectChatNodes([node('a', '甲 v2', 120), node('b', '乙', 40)]);
    expect(renamed).not.toBe(first);
    expect(renamed[0].data.label).toBe('甲 v2');
    expect(renamed[1]).toBe(first[1]);

    // 顺序变化也算变化，否则 @ 列表会停在旧次序
    const reordered = projectChatNodes([node('b', '乙', 40), node('a', '甲 v2', 120)]);
    expect(reordered).not.toBe(renamed);
    expect(reordered.map((item) => item.id)).toEqual(['b', 'a']);

    const removed = projectChatNodes([node('b', '乙', 40)]);
    expect(removed).toHaveLength(1);
  });

  it('retries a failed emission with a newer revision as a full snapshot', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emitSync = vi.fn()
      .mockRejectedValueOnce(new Error('event bus unavailable'))
      .mockResolvedValue(undefined);
    const controller = createDetachedChatSyncController({
      enabled: true,
      syncIntervalMs: 0,
      emitSync,
      initListener: vi.fn(async () => () => undefined),
      now: () => 1,
    });

    await controller.start();
    await vi.waitFor(() => expect(emitSync).toHaveBeenCalledTimes(2));
    expect(emitSync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'snapshot',
      revision: expect.any(Number),
    }));
    expect(emitSync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'snapshot',
      revision: expect.any(Number),
    }));
    expect((emitSync.mock.calls[1][0] as ChatStateSync).revision).toBeGreaterThan((emitSync.mock.calls[0][0] as ChatStateSync).revision);

    controller.dispose();
    warning.mockRestore();
  });
});

it('includes bounded reasoning and independent errors in main-window snapshots and patches', () => {
  arrangeDetachedState();
  useAppStore.setState({ messages: [{ id: 'reasoning-msg', conversationId: 'conversation-1', role: 'assistant', content: 'partial answer', status: 'streaming', timestamp: 1, reasoning: 'sanitized summary', responseError: 'network error' }] });
  const first = buildDetachedChatSnapshot(useAppStore.getState());
  expect(first.messages[0]).toMatchObject({ reasoning: 'sanitized summary', responseError: 'network error' });
  useAppStore.getState().updateMessageTransient('reasoning-msg', { reasoning: 'updated summary', activity: 'compressing' });
  const next = buildDetachedChatSnapshot(useAppStore.getState());
  const patch = createChatStatePatch(first, next);
  expect(applyChatStatePatch(first, patch).messages[0]).toMatchObject({ reasoning: 'updated summary', content: 'partial answer', activity: 'compressing' });
});

it('reuses the newly created conversation for rapid MCP selections and projects no endpoint', () => {
  arrangeDetachedState();
  const makeConnection = (id: string) => ({ id, name: id, url: 'https://private.example/mcp', enabled: true, revision: 'rev-1', authHeader: 'authorization' as const, hasSecret: true, tools: { lookup: { access: 'read' as const, fingerprint: 'digest' } } });
  useAppStore.setState({ activeConversationId: null, conversations: [], config: { ...useAppStore.getState().config, mcpClientConnections: [makeConnection('one'), makeConnection('two')] } });
  const sync = vi.fn();
  handleDetachedChatAction({ type: 'set_mcp_connection', scopeId: 'project-1', serverId: 'one', enabled: true, draft: 'keep this draft' }, sync);
  handleDetachedChatAction({ type: 'set_mcp_connection', scopeId: 'project-1', serverId: 'two', enabled: true, draft: 'stale draft' }, sync);
  const state = useAppStore.getState();
  expect(state.conversations).toHaveLength(1);
  expect(state.conversations[0].mcpServerIds).toEqual(['one', 'two']);
  expect(state.chatComposerLiveDraft).toBe('keep this draft');
  const snapshot = buildDetachedChatSnapshot(state);
  expect(snapshot.mcpClientOptions).toEqual([{ id: 'one', name: 'one', toolCount: 1 }, { id: 'two', name: 'two', toolCount: 1 }]);
  expect(JSON.stringify(snapshot.mcpClientOptions)).not.toContain('private.example');
});


it('keeps unchanged entity arrays and applies only changed nodes, including ordering and removal', () => {
  const node = (id: string) => ({ id, type: 'ai-text', position: { x: 0, y: 0 }, data: { label: id, type: 'ai-text' as const } });
  useAppStore.setState({ nodes: [node('a'), node('b'), node('c')] });
  const first = buildDetachedChatSnapshot(useAppStore.getState());
  const unchanged = applyChatStatePatch(first, createChatStatePatch(first, first));
  expect(unchanged.messages).toBe(first.messages);
  expect(unchanged.conversations).toBe(first.conversations);
  expect(unchanged.agentTasks).toBe(first.agentTasks);
  expect(unchanged.nodes).toBe(first.nodes);
  useAppStore.setState({ nodes: [node('c'), { ...node('a'), data: { type: 'ai-text', label: '新名' } }, node('d')] });
  const next = buildDetachedChatSnapshot(useAppStore.getState());
  const patch = createChatStatePatch(first, next);
  expect(patch.fields.nodes).toBeUndefined();
  expect(patch.nodes?.upserted.map((item) => item.id)).toEqual(['a', 'd']);
  expect(patch.nodes?.removedIds).toEqual(['b']);
  expect(applyChatStatePatch(first, patch).nodes).toEqual(next.nodes);
  const oldPatch = createChatStatePatch(first, first);
  oldPatch.fields.nodes = [];
  expect(applyChatStatePatch(first, oldPatch).nodes).toEqual([]);
});

it('does not reparse unchanged historical message bodies on canvas or streaming updates', () => {
  const old = { id: 'old', conversationId: 'conversation-1', role: 'user' as const,
    status: 'done' as const, timestamp: 1, get content() { return '历史正文'; } };
  const read = vi.spyOn(old, 'content', 'get');
  const message = { id: 'stream', conversationId: 'conversation-1', role: 'assistant' as const,
    status: 'streaming' as const, timestamp: 2, content: '第一段' };
  useAppStore.setState({ messages: [old, message] });
  buildDetachedChatSnapshot(useAppStore.getState());
  const initial = read.mock.calls.length;
  buildDetachedChatSnapshot(useAppStore.getState());
  useAppStore.setState({ messages: [old, { ...message, content: '第一段，第二段' }] });
  buildDetachedChatSnapshot(useAppStore.getState());
  expect(read.mock.calls.length).toBe(initial);
  read.mockRestore();
});
