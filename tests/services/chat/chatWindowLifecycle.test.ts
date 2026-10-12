import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../../src/store/useAppStore';
import { openDetachedChatWindow } from '../../../src/services/chat/chatWindowLifecycle';

describe('detached chat window lifecycle', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
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
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_chat_window');
    complete();
    await first;
    expect(useAppStore.getState()).toMatchObject({
      chatPanelDetached: true, activeConversationId: 'conversation-1',
      chatComposerLiveDraft: '未发送的草稿', chatPanelView: 'tasks',
    });
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
