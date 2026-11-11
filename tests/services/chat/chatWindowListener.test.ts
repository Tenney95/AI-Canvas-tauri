/**
 * chatWindowListener — 回归测试：initMainWindowListener。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWindowFrame } from '../../../src/types/projectWindow';

const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
const nativeWindow = vi.hoisted(() => ({ getByLabel: vi.fn(async () => ({} as object | null)) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: nativeWindow.getByLabel } }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }),
  emit: vi.fn(async () => undefined),
  emitTo: vi.fn(async () => undefined),
}));

import { emit, emitTo } from '@tauri-apps/api/event';

import {
  CHAT_ACTION_EVENT,
  CHAT_CLOSE_REQUEST,
  CHAT_CLOSE_EVENT,
  emitCloseChatWindow,
  emitCloseRequest,
  initMainWindowListener,
  requestManagedChatOperation,
  CHAT_MANAGED_RESPONSE_EVENT,
  CHAT_SEND_RESPONSE_EVENT,
  CHAT_SYNC_EVENT,
  beginChatWindowSession,
  emitAction,
  getMainChatWindowSessionId,
  initChatWindowListener,
  requestChatMessage,
} from '../../../src/services/chat/chatWindowService';

beforeEach(() => {
  listeners.clear();
  vi.mocked(emitTo).mockClear();
  nativeWindow.getByLabel.mockReset().mockResolvedValue({});
  beginChatWindowSession();
});

describe('initMainWindowListener', () => {
  it('收回窗口等待草稿交接 ack，拒绝时保留窗口；已关闭窗口不等待不存在的回执', async () => {
    const closing = emitCloseChatWindow();
    const rejected = expect(closing).rejects.toThrow('草稿仍保留');
    await vi.waitFor(() => expect(vi.mocked(emitTo).mock.calls.some((call) => call[1] === CHAT_CLOSE_EVENT)).toBe(true));
    const sent = vi.mocked(emitTo).mock.calls.find((call) => call[1] === CHAT_CLOSE_EVENT)![2] as { requestId: string; sessionId: string };
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    for (const handler of listeners.get('chat:close-ack') ?? []) handler({ payload: { requestId: sent.requestId, sessionId: 'old-window-session', accepted: true } });
    await Promise.resolve();
    expect(settled).toBe(false);
    for (const handler of listeners.get('chat:close-ack') ?? []) handler({ payload: { requestId: sent.requestId, sessionId: sent.sessionId, accepted: false } });
    await rejected;
    expect(listeners.get('chat:close-ack')?.size).toBe(0);
    nativeWindow.getByLabel.mockResolvedValueOnce(null);
    await expect(emitCloseChatWindow()).resolves.toBeUndefined();
    vi.mocked(emitTo).mockClear();
  });
  it('只接受 URL 固定会话快照，同窗重连沿用已接受序号，旧窗 request_sync 不换 nonce', async () => {
    const sessionId = getMainChatWindowSessionId()!;
    vi.stubGlobal('window', { location: { search: `?view=chat&session=${sessionId}` } });
    const onSync = vi.fn();
    const dispose = await initChatWindowListener(onSync, vi.fn());
    try {
      for (const handler of listeners.get(CHAT_SYNC_EVENT) ?? []) {
        handler({ payload: { type: 'snapshot', sessionId: 'old-window-session', acceptedSequence: 999999, revision: 1, snapshot: {} } });
        handler({ payload: { type: 'snapshot', sessionId, acceptedSequence: 999999, revision: 2, snapshot: { windowFrame: { sessionId: 'other-window-session' } } } });
        handler({ payload: { type: 'snapshot', sessionId, acceptedSequence: 10000, revision: 2, snapshot: {} } });
      }
      expect(onSync).toHaveBeenCalledOnce();
      await emitAction({ type: 'request_sync' });
      expect(vi.mocked(emitTo).mock.lastCall?.[2]).toMatchObject({ type: 'request_sync', sessionId });
      expect((vi.mocked(emitTo).mock.lastCall?.[2] as { sequence: number }).sequence).toBeGreaterThan(10000);
      expect(getMainChatWindowSessionId()).toBe(sessionId);
    } finally { dispose(); vi.unstubAllGlobals(); }
  });
  it('新窗同一请求 ID 不接受旧窗迟到发送回执', async () => {
    const frame = { sessionId: 'new-window-session' } as ProjectWindowFrame;
    let completed = false;
    const pending = requestChatMessage({ type: 'send_message', content: '保留输入', requestId: 'same-request-id' }, frame)
      .then((accepted) => { completed = true; return accepted; });
    await vi.waitFor(() => expect(listeners.get(CHAT_SEND_RESPONSE_EVENT)?.size).toBe(1));
    for (const handler of listeners.get(CHAT_SEND_RESPONSE_EVENT) ?? []) handler({ payload: { requestId: 'same-request-id', sessionId: 'old-window-session', accepted: true } });
    await Promise.resolve(); expect(completed).toBe(false);
    for (const handler of listeners.get(CHAT_SEND_RESPONSE_EVENT) ?? []) handler({ payload: { requestId: 'same-request-id', sessionId: frame.sessionId, accepted: false } });
    await expect(pending).resolves.toBe(false);
  });
  it('waits for the matching main-window acknowledgement before reporting saved', async () => {
    let completed = false;
    const sessionId = 'new-managed-window';
    const pending = requestManagedChatOperation('project-1', 'conversation-1', { kind: 'save_team_profile',
      profile: { version: 1, name: 'team', roles: { architect: '', writer: '', continuity: '', dialogue: '', director: '', storyboard: '', editor: '' }, maxCalls: 8, maxTotalTokens: 240000, maxOutputChars: 16000 } }, undefined, { sessionId } as ProjectWindowFrame)
      .then(() => { completed = true; });
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalled());
    const args = vi.mocked(emitTo).mock.lastCall!;
    const request = args[2] as { requestId: string };
    expect(args[0]).toBe('main');
    expect(completed).toBe(false);
    for (const handler of listeners.get(CHAT_MANAGED_RESPONSE_EVENT) ?? []) handler({ payload: { requestId: request.requestId, scopeId: 'other', conversationId: 'conversation-1', value: true } });
    await Promise.resolve(); expect(completed).toBe(false);
    for (const handler of listeners.get(CHAT_MANAGED_RESPONSE_EVENT) ?? []) handler({ payload: { requestId: request.requestId, sessionId: 'old-managed-window', scopeId: 'project-1', conversationId: 'conversation-1', value: true } });
    await Promise.resolve(); expect(completed).toBe(false);
    for (const handler of listeners.get(CHAT_MANAGED_RESPONSE_EVENT) ?? []) handler({ payload: { requestId: request.requestId, sessionId, scopeId: 'project-1', conversationId: 'conversation-1', value: true } });
    await pending; expect(completed).toBe(true);
    expect(listeners.get(CHAT_MANAGED_RESPONSE_EVENT)?.size).toBe(0);
  });
  it('carries the last composer edit with the close request', async () => {
    const onClose = vi.fn();
    const dispose = await initMainWindowListener(vi.fn(), onClose);
    const composerDraft = { conversationId: 'conversation-1', draft: '还没来得及防抖的输入' };
    await emitCloseRequest(composerDraft);
    expect(emit).toHaveBeenCalledWith(CHAT_CLOSE_REQUEST, { composerDraft, sessionId: undefined });
    for (const handler of listeners.get(CHAT_CLOSE_REQUEST) ?? []) handler({ payload: { composerDraft } });
    expect(onClose).toHaveBeenCalledWith(composerDraft, undefined);
    dispose();
  });
  it('re-registers after a disposed mount (StrictMode double-invoke)', async () => {
    // 第一次挂载：注册后立即被 cleanup 掉，模拟 StrictMode 的 mount → cleanup
    const staleAction = vi.fn();
    const disposeFirst = await initMainWindowListener(staleAction, vi.fn());
    disposeFirst();

    // 第二次挂载必须能重新拿到监听，否则独立窗口的 request_sync 无人接收
    const liveAction = vi.fn();
    const disposeSecond = await initMainWindowListener(liveAction, vi.fn());

    for (const handler of listeners.get(CHAT_ACTION_EVENT) ?? []) {
      handler({ payload: { type: 'request_sync' } });
    }

    expect(liveAction).toHaveBeenCalledWith({ type: 'request_sync' });
    expect(staleAction).not.toHaveBeenCalled();
    disposeSecond();
  });
});
