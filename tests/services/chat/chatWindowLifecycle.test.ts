/**
 * chatWindowLifecycle — 回归测试：detached chat window lifecycle。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const nativeWindow = vi.hoisted(() => ({ getByLabel: vi.fn(async () => null as object | null) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: nativeWindow.getByLabel } }));
const windowEvents = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: { payload: unknown }) => void>>() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    const listeners = windowEvents.listeners.get(name) ?? new Set();
    listeners.add(callback); windowEvents.listeners.set(name, listeners);
    return () => listeners.delete(callback);
  }),
  emitTo: vi.fn(async () => undefined),
  emit: vi.fn(async () => undefined),
}));

import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { useAppStore } from '../../../src/store/useAppStore';
import { openDetachedChatWindow } from '../../../src/services/chat/chatWindowLifecycle';
import { CHAT_CLOSE_EVENT, emitCloseChatWindow, endChatWindowSession, finishChatWindowClose, getMainChatWindowSessionId } from '../../../src/services/chat/chatWindowService';

describe('detached chat window lifecycle', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(emitTo).mockClear();
    windowEvents.listeners.clear();
    endChatWindowSession(getMainChatWindowSessionId());
    nativeWindow.getByLabel.mockReset().mockResolvedValue(null);
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({
      activeConversationId: 'conversation-1', chatComposerLiveDraft: '未发送的草稿',
      chatPanelView: 'tasks',
    });
  });

  it('enables snapshot synchronization before invoking and deduplicates simultaneous entries', async () => {
    let complete!: () => void;
    vi.mocked(invoke).mockImplementation(() => {
      expect(useAppStore.getState().chatPanelDetached).toBe(true);
      return new Promise<void>((resolve) => { complete = resolve; });
    });
    const first = openDetachedChatWindow();
    const second = openDetachedChatWindow();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('open_chat_window', { sessionId: getMainChatWindowSessionId() }));
    complete();
    await first;
    expect(useAppStore.getState()).toMatchObject({
      chatPanelDetached: true, activeConversationId: 'conversation-1',
      chatComposerLiveDraft: '未发送的草稿', chatPanelView: 'tasks',
    });
  });

  it('真实重开分配新会话，已有窗口重复入口保持原 nonce', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await openDetachedChatWindow();
    const firstSession = getMainChatWindowSessionId();
    nativeWindow.getByLabel.mockResolvedValue({});
    await openDetachedChatWindow();
    expect(getMainChatWindowSessionId()).toBe(firstSession);
    expect(vi.mocked(invoke).mock.lastCall).toEqual(['open_chat_window', { sessionId: firstSession, reuseExisting: true }]);
    nativeWindow.getByLabel.mockResolvedValue(null);
    await openDetachedChatWindow();
    expect(getMainChatWindowSessionId()).not.toBe(firstSession);
    expect(vi.mocked(invoke).mock.lastCall).toEqual(['open_chat_window', { sessionId: getMainChatWindowSessionId() }]);
  });

  it('等待窗口查询时被收回，随后重新置位也不复活旧打开请求', async () => {
    let resolveWindow!: (window: object | null) => void;
    nativeWindow.getByLabel.mockImplementationOnce(() => new Promise((resolve) => { resolveWindow = resolve; }));
    const opening = openDetachedChatWindow();
    const cancelled = expect(opening).rejects.toThrow('打开已取消');
    await vi.waitFor(() => expect(nativeWindow.getByLabel).toHaveBeenCalled());
    useAppStore.getState().setChatPanelDetached(false);
    useAppStore.getState().setChatPanelDetached(true);
    resolveWindow(null);
    await cancelled;
    expect(invoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().chatPanelDetached).toBe(false);
  });

  it('原生创建尚未结束时收回，撤销会话并回收迟到的新窗口', async () => {
    let created!: () => void;
    vi.mocked(invoke).mockImplementation((command) => command === 'open_chat_window'
      ? new Promise<void>((resolve) => { created = resolve; }) : Promise.resolve(undefined));
    const opening = openDetachedChatWindow();
    const cancelled = expect(opening).rejects.toThrow('打开已取消');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_chat_window', { sessionId: getMainChatWindowSessionId() }));
    useAppStore.getState().setChatPanelDetached(false);
    const closingSession = getMainChatWindowSessionId();
    expect(closingSession).toBeTruthy();
    created();
    await cancelled;
    expect(invoke).toHaveBeenLastCalledWith('close_chat_window', { sessionId: closingSession });
    expect(useAppStore.getState().chatPanelDetached).toBe(false);
  });

  it('已有原生窗口的打开失败保留会话和独立显示，不同时恢复内嵌助手', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await openDetachedChatWindow();
    const sessionId = getMainChatWindowSessionId();
    nativeWindow.getByLabel.mockResolvedValue({});
    vi.mocked(invoke).mockRejectedValueOnce(new Error('focus failed'));
    await expect(openDetachedChatWindow()).rejects.toThrow('focus failed');
    expect(getMainChatWindowSessionId()).toBe(sessionId);
    expect(useAppStore.getState().chatPanelDetached).toBe(true);
  });

  it('查询后的旧窗口已经消失时不复用旧 nonce 创建新实例', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await openDetachedChatWindow();
    const oldSession = getMainChatWindowSessionId();
    nativeWindow.getByLabel.mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('原窗口已关闭'));
    await expect(openDetachedChatWindow()).rejects.toThrow('原窗口已关闭');
    expect(vi.mocked(invoke).mock.lastCall).toEqual(['open_chat_window', { sessionId: oldSession, reuseExisting: true }]);
    expect(getMainChatWindowSessionId()).toBeUndefined();
    expect(useAppStore.getState().chatPanelDetached).toBe(false);
  });

  it('重开等待同 session 原生销毁，不把正在关闭的旧窗口复用为新窗口', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await openDetachedChatWindow();
    const oldSession = getMainChatWindowSessionId()!;
    let finish!: () => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const closing = finishChatWindowClose(oldSession);
    const opening = openDetachedChatWindow();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('close_chat_window', { sessionId: oldSession }));
    expect(invoke).toHaveBeenCalledTimes(2);
    finish();
    await Promise.all([closing, opening]);
    expect(getMainChatWindowSessionId()).not.toBe(oldSession);
    expect(vi.mocked(invoke).mock.lastCall).toEqual(['open_chat_window', { sessionId: getMainChatWindowSessionId() }]);
  });

  it('原生创建尚未注册标签时，外部关闭等待创建完成，不提前撤销其 session', async () => {
    let created = false, finishOpen!: () => void;
    nativeWindow.getByLabel.mockImplementation(async () => created ? {} : null);
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'open_chat_window') return new Promise<void>((resolve) => { finishOpen = () => { created = true; resolve(); }; });
      if (command === 'close_chat_window') { created = false; return Promise.resolve(undefined); }
      return Promise.resolve(undefined);
    });
    const opening = openDetachedChatWindow();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_chat_window', expect.anything()));
    const sessionId = getMainChatWindowSessionId()!;
    const closing = emitCloseChatWindow(sessionId);
    await Promise.resolve(); await Promise.resolve();
    expect(getMainChatWindowSessionId()).toBe(sessionId);
    expect(useAppStore.getState().chatPanelDetached).toBe(true);
    expect(emitTo).not.toHaveBeenCalled();
    finishOpen();
    await opening;
    await vi.waitFor(() => expect(vi.mocked(emitTo).mock.calls.some((call) => call[1] === CHAT_CLOSE_EVENT)).toBe(true));
    const request = vi.mocked(emitTo).mock.calls.find((call) => call[1] === CHAT_CLOSE_EVENT)![2] as { requestId: string };
    for (const callback of windowEvents.listeners.get('chat:close-ack') ?? []) callback({ payload: { requestId: request.requestId, sessionId, accepted: true } });
    await closing;
    expect(invoke).toHaveBeenLastCalledWith('close_chat_window', { sessionId });
    expect(getMainChatWindowSessionId()).toBeUndefined();
    expect(created).toBe(false);
  });

  it('打开尚未分配 nonce 时的关闭不借用后来创建的会话，窗口仍可正常复用', async () => {
    let finishOpen!: () => void, created = false;
    nativeWindow.getByLabel.mockImplementation(async () => created ? {} : null);
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { finishOpen = () => { created = true; resolve(); }; }))
      .mockResolvedValue(undefined);
    const opening = openDetachedChatWindow();
    const closing = emitCloseChatWindow();
    const rejected = expect(closing).rejects.toThrow('会话已失效');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    finishOpen();
    await opening; await rejected;
    const sessionId = getMainChatWindowSessionId()!;
    expect(sessionId).toBeTruthy();
    expect(useAppStore.getState().chatPanelDetached).toBe(true);
    expect(vi.mocked(invoke).mock.calls.some((call) => call[0] === 'close_chat_window')).toBe(false);
    await openDetachedChatWindow();
    expect(invoke).toHaveBeenLastCalledWith('open_chat_window', { sessionId, reuseExisting: true });
  });

  it.each([false, true])('recovers the docked panel after opening fails (previously detached: %s)', async (detached) => {
    useAppStore.setState({ chatPanelDetached: detached });
    vi.mocked(invoke).mockRejectedValue('创建对话窗口失败: 0x8007139F');
    await expect(openDetachedChatWindow()).rejects.toThrow('0x8007139F');
    expect(useAppStore.getState()).toMatchObject({
      chatOpen: true, chatPanelDetached: false, activeConversationId: 'conversation-1',
      chatComposerLiveDraft: '未发送的草稿', chatPanelView: 'tasks',
    });
    vi.mocked(invoke).mockResolvedValue(undefined);
    await openDetachedChatWindow();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().chatPanelDetached).toBe(true);
  });

  it('bounds and sanitizes native diagnostic details before returning them to the UI', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error(`创建失败 C:\\Users\\private\\profile api_key=secret-value ${'x'.repeat(900)}`));
    const error = await openDetachedChatWindow().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const detail = (error as Error).message;
    expect(detail.length).toBeLessThanOrEqual(320);
    expect(detail).not.toContain('C:\\Users');
    expect(detail).not.toContain('secret-value');
    expect(useAppStore.getState().chatOpen).toBe(true);
  });
});
