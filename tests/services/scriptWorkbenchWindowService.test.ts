import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptWorkbenchRequest, ScriptWorkbenchSnapshot } from '../../src/types/scriptWorkbench';

const events = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  emitTo: vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: events.emitTo,
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    const listeners = events.listeners.get(name) ?? new Set();
    listeners.add(callback);
    events.listeners.set(name, listeners);
    return () => { listeners.delete(callback); };
  },
}));

import { connectScriptWorkbenchWindow } from '../../src/services/scriptWorkbenchWindowService';

const cleanups: Array<() => void> = [];
const deliver = (name: string, payload: unknown) => {
  for (const listener of events.listeners.get(name) ?? []) listener({ payload });
};
const frame = (sessionId: string, revision: number) => ({ sessionId, revision }) as ScriptWorkbenchSnapshot;

beforeEach(() => {
  events.listeners.clear();
  events.emitTo.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe('独立工作台客户端协议', () => {
  it('先安装状态/响应监听再握手，忽略其他会话与过期快照', async () => {
    events.emitTo.mockImplementation(async (_target, event) => {
      if (event === 'script-workbench:hello') {
        expect(events.listeners.get('script-workbench:state')?.size).toBe(1);
        expect(events.listeners.get('script-workbench:response')?.size).toBe(1);
      }
    });
    const onSnapshot = vi.fn();
    const bridge = await connectScriptWorkbenchWindow('session-workbench', onSnapshot);
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('different-session', 5));
    deliver('script-workbench:state', frame('session-workbench', 2));
    deliver('script-workbench:state', frame('session-workbench', 1));
    deliver('script-workbench:state', frame('session-workbench', 2));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });

  it('将最后一次草稿随保存请求交接，只有匹配会话与请求的回复才能完成保存', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-handoff', vi.fn());
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('session-handoff', 3));
    const handoff = { episodeId: 'episode-b', sequence: 7, draft: { outline: '集纲', script: '最后输入',
      creative: { task: '', coreConflict: '', openingHook: '', reversal: '', endingHook: '', beats: '',
        targetDurationSec: '90', sourceRange: '' } } };
    const saving = bridge.request({ revision: 3, episodeId: 'episode-b', action: { type: 'save' }, handoff });
    const sent = events.emitTo.mock.calls.find((call) => call[1] === 'script-workbench:request')?.[2] as ScriptWorkbenchRequest;
    expect(sent).toMatchObject({ sessionId: 'session-handoff', episodeId: 'episode-b', handoff });
    let completed = false;
    void saving.then(() => { completed = true; }, () => {});
    deliver('script-workbench:response', { sessionId: 'different-session', requestId: sent.requestId, value: true });
    await Promise.resolve();
    expect(completed).toBe(false);
    deliver('script-workbench:response', { sessionId: 'session-handoff', requestId: sent.requestId, value: true });
    await expect(saving).resolves.toBe(true);
  });

  it('传递主窗口保存错误，断开时取消未完成请求并清理监听', async () => {
    const bridge = await connectScriptWorkbenchWindow('session-errors', vi.fn());
    cleanups.push(bridge.dispose);
    deliver('script-workbench:state', frame('session-errors', 1));
    const failed = bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'save' } });
    const sent = events.emitTo.mock.calls.find((call) => call[1] === 'script-workbench:request')?.[2] as ScriptWorkbenchRequest;
    const failure = expect(failed).rejects.toThrow('原分集已变化');
    deliver('script-workbench:response', { sessionId: 'session-errors', requestId: sent.requestId, error: '原分集已变化' });
    await failure;
    const pending = bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'flush_draft' } });
    const canceled = expect(pending).rejects.toThrow('工作台窗口已关闭');
    bridge.dispose();
    await canceled;
    expect([...events.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await expect(bridge.request({ revision: 1, episodeId: 'episode-b', action: { type: 'save' } })).rejects.toThrow('尚未连接');
  });
});
