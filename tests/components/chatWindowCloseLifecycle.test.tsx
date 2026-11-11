import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStateSync } from '../../src/services/chat/chatWindowService';

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
  receiveChatStateSync: () => ({ revision: 1, sessionId: mocks.frame.sessionId, snapshot: {
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
});
