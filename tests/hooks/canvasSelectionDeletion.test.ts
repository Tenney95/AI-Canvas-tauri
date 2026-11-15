import type { EffectCallback } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  keydown: undefined as ((event: KeyboardEvent) => unknown) | undefined,
}));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: EffectCallback) => { driver.effects.push(effect); },
}));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({ unregisterAll: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => { throw new Error('非原生测试环境'); } }));

import { useAppStore } from '../../src/store/useAppStore';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';

let cleanup: ReturnType<EffectCallback>;
let blockedByDialog = false;
beforeEach(() => {
  driver.effects = [];
  driver.keydown = undefined;
  blockedByDialog = false;
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project', selectedNodeIds: ['selected'], deleteSelectedCanvasElements: vi.fn(() => true) });
  vi.stubGlobal('document', {
    addEventListener: (type: string, listener: (event: KeyboardEvent) => unknown) => {
      if (type === 'keydown') driver.keydown = listener;
    },
    removeEventListener: vi.fn(),
    querySelector: () => blockedByDialog ? {} : null,
  });
  useKeyboardShortcuts();
  cleanup = driver.effects[0]();
});
afterEach(() => {
  if (typeof cleanup === 'function') cleanup();
  vi.unstubAllGlobals();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

function keyEvent(key = 'Delete', tagName = 'DIV'): KeyboardEvent {
  return {
    key, code: key, target: { tagName, closest: () => null },
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe('键盘选区删除入口', () => {
  it.each(['Delete', 'Backspace'])('%s 先拦截事件，再委托唯一 Store Action', async (key) => {
    const event = keyEvent(key);
    await driver.keydown!(event);
    const remove = vi.mocked(useAppStore.getState().deleteSelectedCanvasElements);
    expect(remove).toHaveBeenCalledExactlyOnceWith();
    expect(vi.mocked(event.preventDefault).mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    expect(vi.mocked(event.stopPropagation).mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
  });

  it('纯边选区也委托 Store，不在 Hook 中裁剪节点数量或选择', async () => {
    useAppStore.setState({ selectedNodeIds: [], edges: [{ id: 'edge', source: 'a', target: 'b', selected: true }] });
    await driver.keydown!(keyEvent());
    expect(useAppStore.getState().deleteSelectedCanvasElements).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['empty', 'input', 'dialog', 'no-project'])('%s 情况不吞删除键或修改画布', async (condition) => {
    if (condition === 'empty') useAppStore.setState({ selectedNodeIds: [] });
    if (condition === 'no-project') useAppStore.setState({ currentProjectId: null });
    blockedByDialog = condition === 'dialog';
    const event = keyEvent('Delete', condition === 'input' ? 'INPUT' : 'DIV');
    await driver.keydown!(event);
    expect(useAppStore.getState().deleteSelectedCanvasElements).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
