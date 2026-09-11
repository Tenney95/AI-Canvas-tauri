import { describe, expect, it } from 'vitest';
import type { StateCreator } from 'zustand';
import { createOrRefreshHotStore } from '../../src/store/store.hotReload';

interface State { tasks: string[]; value: number; add: (id: string) => void; bump: () => void; addedField?: string }
const initial: StateCreator<State> = (set, get) => ({ tasks: [], value: 0,
  add: (id) => set({ tasks: [...get().tasks, id] }), bump: () => set({ value: get().value + 1 }),
});
describe('开发热更新 Store 身份', () => {
  it('keeps old bridge listeners and newly imported executors on the same task collection', () => {
    const hotData = {};
    const oldBridge = createOrRefreshHotStore(initial, hotData);
    oldBridge.getState().add('before');
    // 故意不触发 dispose，模拟仅 React 边界收到更新时的依赖模块求值。
    const newExecutor = createOrRefreshHotStore(initial, hotData);
    oldBridge.getState().add('during');
    expect(newExecutor).toBe(oldBridge);
    expect(newExecutor.getState().tasks).toEqual(['before', 'during']);
  });
  it('refreshes action code against the existing store while preserving state and subscriptions', () => {
    const old = createOrRefreshHotStore(initial); old.getState().bump();
    let notifications = 0; old.subscribe(() => { notifications++; });
    const refreshed: StateCreator<State> = (set, get, api) => ({ ...initial(set, get, api), addedField: 'new default',
      bump: () => set({ value: get().value + 10 }),
    });
    const next = createOrRefreshHotStore(refreshed, { appStore: old });
    expect(next.getState().value).toBe(1); expect(next.getState().addedField).toBe('new default');
    next.getState().bump(); expect(old.getState().value).toBe(11); expect(notifications).toBe(2);
  });
  it('creates isolated stores when no HMR state exists, as in separate production windows', () => {
    const left = createOrRefreshHotStore(initial); const right = createOrRefreshHotStore(initial);
    left.getState().add('private'); expect(right.getState().tasks).toEqual([]);
  });
});
