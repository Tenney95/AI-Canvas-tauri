import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatComposerHandoff, ChatStateSnapshot, ChatStateSync } from '../../src/services/chat/chatWindowService';
import type { ProjectWindowFrame } from '../../src/types/projectWindow';

const mocks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>, effects: [] as Array<() => void | (() => void)>,
  stateIndex: 0, refIndex: 0,
  initListener: vi.fn(), requestClose: vi.fn<(action: unknown, frame: unknown) => Promise<boolean>>(),
  invoke: vi.fn(async () => undefined),
  frame: { schemaVersion: 2, sessionId: 'chat-close-session', revision: 1, conversationId: 'conversation-1',
    context: { schemaVersion: 2, target: { kind: 'global', schemaVersion: 2, modelGeneration: 1, catalogRevision: 1 }, canvas: null } },
}));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect); },
  useRef: (initial: unknown) => {
    const index = mocks.refIndex++;
    return mocks.refs[index] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.states)) mocks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [mocks.states[index], (value: unknown) => { mocks.states[index] = value; }];
  },
}));
vi.mock('../../src/components/chat/ChatPanel', () => ({ default: function ChatPanelMock() { return null; } }));
vi.mock('../../src/hooks/useTooltipAutoPlacement', () => ({ useTooltipAutoPlacement: () => {} }));
vi.mock('../../src/i18n', () => ({ setLocale: () => {}, useT: () => (text: string) => text }));
vi.mock('../../src/services/fileService', () => ({ loadConfigWithoutSecrets: async () => null }));
vi.mock('../../src/services/appearance/appearanceRuntime', () => ({ applyAppearanceTheme: () => {}, installSystemAppearanceListener: () => () => {} }));
vi.mock('../../src/services/appearance/appearanceMigration', () => ({ getAppearanceForConfig: () => ({}) }));
vi.mock('../../src/services/performanceModeRuntime', () => ({ syncPerformanceModeRuntime: () => {} }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { setState: vi.fn() } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) }));
vi.mock('../../src/services/chat/chatWindowService', () => ({
  emitAction: async () => {}, emitCloseRequest: async () => {}, emitChatCloseAcknowledgement: async () => {},
  initChatWindowListener: mocks.initListener, requestChatMessage: mocks.requestClose,
  getChatClientSessionId: () => mocks.frame.sessionId, setChatReferenceWindowFrame: () => {},
  receiveChatStateSync: (_current: unknown, sync: ChatStateSync) => sync.type === 'snapshot'
    ? { revision: sync.revision, sessionId: sync.sessionId, snapshot: sync.snapshot }
    : ({ revision: 1, sessionId: mocks.frame.sessionId, snapshot: {
    nodes: [], dramaAssets: { characters: [], scenes: [], props: [] }, projectId: null,
    composerDraft: '', composerDrafts: {}, windowFrame: mocks.frame,
  } }),
}));

import ChatWindow from '../../src/components/chat/ChatWindow';

interface ElementLike { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown): ElementLike[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree) || !('type' in tree)) return [];
  const element = tree as ElementLike;
  return [element, ...elements(element.props.children)];
}
function render() {
  mocks.stateIndex = 0; mocks.refIndex = 0; mocks.effects = [];
  const tree = elements(ChatWindow());
  const panel = tree.find((element) => typeof element.type === 'function' && element.type.name === 'ChatPanelMock')!;
  return { tree, panel, close: elements(panel.props.detachedHeaderActions).find((element) => element.props['aria-label'] === '关闭独立窗口')! };
}

let cleanups: Array<() => void> = [];
beforeEach(() => {
  mocks.states = []; mocks.refs = []; mocks.effects = [];
  mocks.initListener.mockReset().mockResolvedValue(() => {});
  mocks.requestClose.mockReset().mockResolvedValue(true);
  mocks.invoke.mockClear();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', { documentElement: { toggleAttribute: vi.fn(), removeAttribute: vi.fn() } });
});
afterEach(() => { for (const cleanup of cleanups) cleanup(); cleanups = []; vi.unstubAllGlobals(); });

async function initializedWindow() {
  const first = render();
  expect(first.panel.props.composerDisabled).toBe(true);
  cleanups = mocks.effects.map((effect) => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
  await vi.waitFor(() => expect(mocks.initListener).toHaveBeenCalledOnce());
  (mocks.initListener.mock.calls[0][0] as (sync: ChatStateSync) => void)({} as ChatStateSync);
  return render();
}

function projectFrame(projectId: string, revision: number, conversationId: string | null = null): ProjectWindowFrame {
  const canvas = { kind: 'canvas' as const, schemaVersion: 2 as const, modelGeneration: 0 as const,
    runtimeEpoch: 'chat-window-runtime', projectId, projectEpoch: 0, canvasId: projectId,
    episodeId: null, canvasEpoch: 0, canvasRevision: 0 };
  return { schemaVersion: 2, sessionId: mocks.frame.sessionId, revision, conversationId,
    context: { schemaVersion: 2, target: canvas, canvas } };
}

function syncSnapshot(frame: ProjectWindowFrame | null, projectId: string | null, fields: Partial<ChatStateSnapshot> = {}) {
  const snapshot: ChatStateSnapshot = {
    conversations: [], activeConversationId: frame?.conversationId ?? null, messages: [], agentTasks: [],
    projectId, projectName: projectId ?? undefined, nodes: [], generalModels: [], assistantModelGroups: [],
    mediaModelOptions: [], skillOptions: [], dramaAssets: { characters: [], scenes: [], props: [] },
    composerDraft: '', composerDrafts: {}, panelView: 'chat', ...fields, windowFrame: frame,
  };
  (mocks.initListener.mock.calls[0][0] as (sync: ChatStateSync) => void)({
    type: 'snapshot', revision: frame?.revision ?? 100, sessionId: mocks.frame.sessionId, snapshot,
  });
  return render();
}

function editDraft(panel: ElementLike, frame: ProjectWindowFrame, draft: string) {
  (panel.props.onComposerDraftChange as (handoff: ChatComposerHandoff) => void)({
    windowFrame: frame, conversationId: frame.conversationId ?? null, draft,
  });
}

describe('独立助手关闭时输入交接', () => {
  it('等待交接时输入只读并显示状态，重复点击合并；拒绝后恢复编辑并显示原因', async () => {
    const ready = await initializedWindow();
    expect(ready.panel.props.composerDisabled).toBe(false);
    let finish!: (accepted: boolean) => void;
    const waiting = new Promise<boolean>((resolve) => { finish = resolve; });
    mocks.requestClose.mockReturnValue(waiting);
    (ready.close.props.onClick as () => void)();
    (ready.close.props.onClick as () => void)();
    const pending = render();
    expect(pending.panel.props.composerDisabled).toBe(true);
    expect(pending.tree.some((element) => element.props.role === 'status')).toBe(true);
    expect(mocks.requestClose).toHaveBeenCalledOnce();
    finish(false); await waiting; await Promise.resolve();
    const failed = render();
    expect(failed.panel.props.composerDisabled).toBe(false);
    expect(failed.tree.some((element) => element.props.role === 'alert')).toBe(true);
    expect(failed.tree.some((element) => element.props.role === 'status')).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('草稿已接收但原生关闭失败时，恢复编辑而不由子窗口再次调用原生命令', async () => {
    const ready = await initializedWindow();
    (ready.close.props.onClick as () => void)();
    await Promise.resolve();
    expect(render().panel.props.composerDisabled).toBe(true);
    (mocks.initListener.mock.calls[0][2] as () => void)();
    const failed = render();
    expect(failed.panel.props.composerDisabled).toBe(false);
    expect(failed.tree.some((element) => element.props.role === 'alert')).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('项目 A、项目 B 与主页跟随宿主快照，加载空帧期间只读，恢复有效帧后可编辑', async () => {
    await initializedWindow();
    const first = syncSnapshot(projectFrame('project-a', 2), 'project-a');
    expect((first.panel.props.detachedSnapshot as ChatStateSnapshot).projectId).toBe('project-a');
    expect(first.panel.props.composerDisabled).toBe(false);
    const loading = syncSnapshot(null, 'project-a');
    expect(loading.panel.props.composerDisabled).toBe(true);
    const second = syncSnapshot(projectFrame('project-b', 3), 'project-b', { panelView: 'list' });
    expect((second.panel.props.detachedSnapshot as ChatStateSnapshot).projectId).toBe('project-b');
    expect((second.panel.props.detachedSnapshot as ChatStateSnapshot).panelView).toBe('list');
    expect(second.panel.props.composerDisabled).toBe(false);
    const home = syncSnapshot({ ...mocks.frame, revision: 4, conversationId: null } as ProjectWindowFrame, null);
    expect((home.panel.props.detachedSnapshot as ChatStateSnapshot).projectId).toBeNull();
    expect(home.panel.props.composerDisabled).toBe(false);
    expect(mocks.requestClose).not.toHaveBeenCalled();
  });

  it('健康新项目清除旧关闭失败提示，原项目未确认草稿仍保护后续关闭', async () => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2), frameB = projectFrame('project-b', 3);
    const first = syncSnapshot(frameA, 'project-a');
    editDraft(first.panel, frameA, '项目 A 尚未确认');
    mocks.requestClose.mockResolvedValue(false);
    (first.close.props.onClick as () => void)();
    await Promise.resolve(); await Promise.resolve();
    expect(render().tree.some((element) => element.props.role === 'alert')).toBe(true);
    const second = syncSnapshot(frameB, 'project-b');
    expect(second.tree.some((element) => element.props.role === 'alert')).toBe(false);
    expect(second.panel.props.composerDisabled).toBe(false);
    editDraft(second.panel, frameB, '项目 B 新草稿');
    (second.close.props.onClick as () => void)();
    expect(mocks.requestClose).toHaveBeenCalledOnce();
    expect(render().tree.some((element) => element.props.role === 'alert')).toBe(true);
  });

  it('多页未确认草稿不被新输入覆盖；只认原上下文原会话正文 ACK，全部确认后才正常关闭', async () => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2), frameB = projectFrame('project-b', 3);
    const draftA = `A-${crypto.randomUUID()}`, draftB = `B-${crypto.randomUUID()}`;
    const first = syncSnapshot(frameA, 'project-a');
    editDraft(first.panel, frameA, '项目 A 的较旧输入');
    editDraft(first.panel, frameA, draftA);
    const second = syncSnapshot(frameB, 'project-b');
    editDraft(second.panel, frameB, draftB);
    (second.close.props.onClick as () => void)();
    expect(mocks.requestClose).not.toHaveBeenCalled();
    expect(render().panel.props.composerDisabled).toBe(false);

    const wrongConversation = { ...frameA, revision: 4, conversationId: 'other-conversation' };
    const mismatched = syncSnapshot(wrongConversation, 'project-a', { composerDraft: draftA });
    (mismatched.close.props.onClick as () => void)();
    expect(mocks.requestClose).not.toHaveBeenCalled();

    syncSnapshot({ ...frameA, revision: 5 }, 'project-a', { composerDraft: draftA });
    const confirmed = syncSnapshot({ ...frameB, revision: 6 }, 'project-b', { composerDraft: draftB });
    (confirmed.close.props.onClick as () => void)();
    expect(mocks.requestClose).toHaveBeenCalledOnce();
    expect(mocks.requestClose).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close_window', composerDraft: undefined,
    }), expect.objectContaining({ revision: 6 }));
  });

  it('单个旧项目已绑定会话草稿仍交给宿主按原归属确认，不改绑当前项目', async () => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2, 'conversation-a'), frameB = projectFrame('project-b', 3);
    const first = syncSnapshot(frameA, 'project-a');
    editDraft(first.panel, frameA, '旧会话草稿');
    const second = syncSnapshot(frameB, 'project-b');
    (second.close.props.onClick as () => void)();
    expect(mocks.requestClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      composerDraft: { windowFrame: frameA, conversationId: 'conversation-a', draft: '旧会话草稿' },
    }), frameA);
  });

  it.each(['', '会话 A 已确认正文'])('同项目已绑定会话 A 草稿 %j 按宿主真实空值语义确认，切到 B 不造成额外关闭阻塞', async (draftA) => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2, 'conversation-a');
    const frameB = projectFrame('project-a', 3, 'conversation-b');
    const first = syncSnapshot(frameA, 'project-a');
    editDraft(first.panel, frameA, draftA);
    const second = syncSnapshot(frameB, 'project-a');
    editDraft(second.panel, frameB, '会话 B 待交接');
    let confirmed = second;
    // store.chat.ts:417-418 清空时删除键；只有非空正文需要显式键回显。
    if (draftA) {
      (second.close.props.onClick as () => void)();
      expect(mocks.requestClose).not.toHaveBeenCalled();
      confirmed = syncSnapshot({ ...frameB, revision: 4 }, 'project-a', {
        composerDrafts: { 'conversation-a': draftA },
      });
    }
    (confirmed.close.props.onClick as () => void)();
    expect(mocks.requestClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      composerDraft: { windowFrame: frameB, conversationId: 'conversation-b', draft: '会话 B 待交接' },
    }), frameB);
  });

  it('A 清空后宿主删键，切 B 再清空后也删键，不积累空交接阻止正常关闭', async () => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2, 'conversation-a');
    const frameB = projectFrame('project-b', 4, 'conversation-b');
    const first = syncSnapshot(frameA, 'project-a');
    editDraft(first.panel, frameA, 'A 清空前正文');
    editDraft(first.panel, frameA, '');
    syncSnapshot({ ...frameA, revision: 3 }, 'project-a', { composerDrafts: {} });
    const second = syncSnapshot(frameB, 'project-b');
    editDraft(second.panel, frameB, 'B 清空前正文');
    editDraft(second.panel, frameB, '');
    const confirmed = syncSnapshot({ ...frameB, revision: 5 }, 'project-b', { composerDrafts: {} });
    (confirmed.close.props.onClick as () => void)();
    expect(mocks.requestClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      composerDraft: undefined,
    }), expect.objectContaining({ revision: 5 }));
  });

  it('全局草稿表已保存 A/B 时快速切到 C，不把已保存原项目正文继续算作多稿阻塞', async () => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2, 'conversation-a');
    const frameB = projectFrame('project-b', 3, 'conversation-b');
    const frameC = projectFrame('project-c', 4, 'conversation-c');
    const first = syncSnapshot(frameA, 'project-a');
    editDraft(first.panel, frameA, 'A 已保存正文');
    const second = syncSnapshot(frameB, 'project-b', { composerDrafts: { 'conversation-a': 'A 已保存正文' } });
    editDraft(second.panel, frameB, 'B 已保存正文');
    const third = syncSnapshot(frameC, 'project-c', {
      composerDrafts: { 'conversation-a': 'A 已保存正文', 'conversation-b': 'B 已保存正文' },
    });
    editDraft(third.panel, frameC, 'C 待交接正文');
    (third.close.props.onClick as () => void)();
    expect(mocks.requestClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      composerDraft: { windowFrame: frameC, conversationId: 'conversation-c', draft: 'C 待交接正文' },
    }), frameC);
  });

  it('全局表中缺少非空 A/B 正文时仍保护原稿，不能因切到其他项目把它们误认作空稿', async () => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2, 'conversation-a');
    const frameB = projectFrame('project-b', 3, 'conversation-b');
    const first = syncSnapshot(frameA, 'project-a');
    editDraft(first.panel, frameA, 'A 未保存正文');
    const second = syncSnapshot(frameB, 'project-b', { composerDrafts: {} });
    editDraft(second.panel, frameB, 'B 未保存正文');
    const third = syncSnapshot(projectFrame('project-c', 4, 'conversation-c'), 'project-c', { composerDrafts: {} });
    (third.close.props.onClick as () => void)();
    expect(mocks.requestClose).not.toHaveBeenCalled();
    expect(render().panel.props.composerDisabled).toBe(false);
  });

  it('首次发送 ACK 消费原未绑定草稿后，切到 B 的新稿仍可单稿关闭', async () => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2), frameB = projectFrame('project-b', 3);
    const first = syncSnapshot(frameA, 'project-a');
    const draftA = `已发送-${crypto.randomUUID()}`;
    editDraft(first.panel, frameA, draftA);
    (first.panel.props.onComposerDraftConsumed as ((draft: ChatComposerHandoff) => void) | undefined)?.({
      windowFrame: frameA, conversationId: null, draft: draftA,
    });
    const second = syncSnapshot(frameB, 'project-b');
    editDraft(second.panel, frameB, '项目 B 待保存');
    (second.close.props.onClick as () => void)();
    expect(mocks.requestClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      composerDraft: { windowFrame: frameB, conversationId: null, draft: '项目 B 待保存' },
    }), frameB);
  });

  it('旧正文迟到发送 ACK 不消费同上下文继续编辑的新稿，多页未确认输入仍阻止关闭', async () => {
    await initializedWindow();
    const frameA = projectFrame('project-a', 2), frameB = projectFrame('project-b', 3);
    const first = syncSnapshot(frameA, 'project-a');
    editDraft(first.panel, frameA, '较旧已发送内容');
    editDraft(first.panel, frameA, '发送后继续编辑的新稿');
    (first.panel.props.onComposerDraftConsumed as ((draft: ChatComposerHandoff) => void) | undefined)?.({
      windowFrame: frameA, conversationId: null, draft: '较旧已发送内容',
    });
    const second = syncSnapshot(frameB, 'project-b');
    editDraft(second.panel, frameB, '项目 B 待保存');
    (second.close.props.onClick as () => void)();
    expect(mocks.requestClose).not.toHaveBeenCalled();
    expect(render().panel.props.composerDisabled).toBe(false);
  });
});
