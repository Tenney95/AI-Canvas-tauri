import { describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }),
  emit: vi.fn(async () => undefined),
}));

import {
  CHAT_ACTION_EVENT,
  initMainWindowListener,
} from '../../../src/services/chat/chatWindowService';

describe('initMainWindowListener', () => {
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
