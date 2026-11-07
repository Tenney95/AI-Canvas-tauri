/**
 * chatWindowLifecycle — 回归测试：detached chat window lifecycle。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const nativeWindow = vi.hoisted(() => ({ getByLabel: vi.fn(async () => null as object | null) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: nativeWindow.getByLabel } }));

import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../../src/store/useAppStore';
import { openDetachedChatWindow } from '../../../src/services/chat/chatWindowLifecycle';
import { getMainChatWindowSessionId } from '../../../src/services/chat/chatWindowService';

describe('detached chat window lifecycle', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
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
    expect(getMainChatWindowSessionId()).toBeUndefined();
    created();
    await cancelled;
    expect(invoke).toHaveBeenLastCalledWith('close_chat_window');
    expect(useAppStore.getState().chatPanelDetached).toBe(false);
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
