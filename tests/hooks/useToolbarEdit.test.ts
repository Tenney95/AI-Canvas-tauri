import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolbarLayout } from '../../src/types';
import type { UseToolbarEditReturn } from '../../src/hooks/useToolbarEdit';

// 与现有组件测试一致，用可重渲染的 hook 槽执行真实事件处理及异步保存流程。
const harness = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[], effectCursor: 0,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
}));
const state = vi.hoisted(() => ({
  toolbarLayouts: {} as Record<string, ToolbarLayout>, toolbarLayoutsHydrated: true,
  toolbarSaveErrors: {} as Record<string, string>, reloadToolbarLayout: vi.fn(), ask: vi.fn(),
  installedPlugins: [], setToolbarLayout: vi.fn(), loadToolbarLayouts: vi.fn(),
}));
vi.mock('react', () => {
  const memo = <T>(fn: () => T, deps: readonly unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.slots[index] as { value: T; deps: readonly unknown[] } | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) harness.slots[index] = { value: fn(), deps };
    return (harness.slots[index] as { value: T }).value;
  };
  return {
  useState: <T>(initial: T) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (value: T | ((old: T) => T)) => {
      harness.slots[index] = typeof value === 'function' ? (value as (old: T) => T)(harness.slots[index] as T) : value;
    }];
  },
  useRef: <T>(initial: T) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  },
  useCallback: <T>(fn: T, deps: readonly unknown[]) => memo(() => fn, deps),
  useMemo: memo,
  useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = harness.effectCursor++;
    const previous = harness.effects[index];
    if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    harness.pending.push(() => {
      previous?.cleanup?.();
      harness.effects[index] = { deps, cleanup: fn() ?? undefined };
    });
  },
  };
});
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }),
}));
vi.mock('../../src/components/nodes/shared/toolbar/toolbarRegistry', () => ({
  getButtonRegistry: () => [], getPluginToolbarButtonRegistry: () => [],
  getDefaultLayout: () => ({ version: 1, zones: [{ id: 'main', name: '默认', buttonKeys: ['copy'] }] }),
  migrateToolbarLayout: (_type: string, layout: ToolbarLayout) => layout,
}));
import { useToolbarEdit } from '../../src/hooks/useToolbarEdit';
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: state.ask }));
import { prepareSettingsClose, resumeSettingsPersistence } from '../../src/services/configPersistenceQueue';

let edit: UseToolbarEditReturn;
let cleanups: Array<() => void> = [];
function HookHarness() {
  return useToolbarEdit({ nodeType: 'text' });
}
function renderHook() {
  harness.cursor = 0; harness.effectCursor = 0;
  edit = HookHarness();
  harness.pending.splice(0).forEach((effect) => effect());
  cleanups = harness.effects.map((effect) => effect.cleanup).filter((fn): fn is () => void => typeof fn === 'function');
}
async function longPress() {
  edit.longPressHandlers.onMouseDown({} as React.MouseEvent);
  await vi.advanceTimersByTimeAsync(600);
  renderHook();
}
beforeEach(() => {
  vi.useFakeTimers();
  harness.slots = []; harness.effects = []; harness.pending = [];
  resumeSettingsPersistence();
  state.toolbarLayouts = {}; state.toolbarLayoutsHydrated = true;
  state.toolbarSaveErrors = {}; state.ask.mockReset().mockResolvedValue(false); state.reloadToolbarLayout.mockReset();
  state.setToolbarLayout.mockReset().mockResolvedValue(true);
  state.loadToolbarLayouts.mockReset().mockResolvedValue(true);
  renderHook();
});
afterEach(() => { cleanups.forEach((fn) => fn()); resumeSettingsPersistence(); vi.useRealTimers(); });

describe('toolbar edit save lifecycle', () => {
  it('preserves a conflicted draft on cancel and replaces it only after confirmed successful reload', async () => {
    await longPress(); edit.renameZone('main', '我的草稿'); renderHook();
    state.toolbarSaveErrors.text = 'conflict';
    state.setToolbarLayout.mockResolvedValue(false);
    await edit.exitEdit(); renderHook();
    expect(edit.layout.zones[0].name).toBe('我的草稿');
    expect(state.reloadToolbarLayout).not.toHaveBeenCalled();
    state.ask.mockResolvedValue(true);
    state.reloadToolbarLayout.mockImplementation(async () => {
      state.toolbarLayouts.text = { version: 1, zones: [{ id: 'main', name: '最新布局', buttonKeys: [] }] };
      return true;
    });
    await edit.exitEdit(); renderHook();
    expect(edit.isEditing).toBe(true);
    expect(edit.layout.zones[0].name).toBe('最新布局');
    expect(state.setToolbarLayout.mock.calls[0][2]).toEqual({ baseline: null });
  });

  it('leaves conflict decisions to the application close flow while closing', async () => {
    await longPress(); state.toolbarSaveErrors.text = 'conflict'; state.setToolbarLayout.mockResolvedValue(false);
    expect(await prepareSettingsClose()).toBe(false);
    expect(state.ask).not.toHaveBeenCalled();
  });

  it('does not silently retry an in-flight failed save while closing', async () => {
    await longPress();
    let finish!: (ok: boolean) => void;
    state.setToolbarLayout.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = edit.exitEdit();
    const closing = prepareSettingsClose();
    finish(false); await first;
    await expect(closing).resolves.toBe(false);
    expect(state.setToolbarLayout).toHaveBeenCalledOnce();
    resumeSettingsPersistence(); renderHook();
    expect(edit.isEditing).toBe(true);
  });

  it('collects an open toolbar draft before application close', async () => {
    await longPress();
    edit.renameZone('main', '退出前编辑'); renderHook();
    await expect(prepareSettingsClose()).resolves.toBe(true);
    expect(state.setToolbarLayout).toHaveBeenCalledOnce();
    expect(state.setToolbarLayout.mock.calls[0][1].zones[0].name).toBe('退出前编辑');
  });

  it('waits for an active save and then collects the later toolbar draft', async () => {
    await longPress();
    let finish!: (ok: boolean) => void;
    state.setToolbarLayout.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = edit.exitEdit();
    edit.renameZone('main', '稍后修改'); renderHook();
    const closing = prepareSettingsClose();
    expect(state.setToolbarLayout).toHaveBeenCalledOnce();
    finish(true); await first;
    await expect(closing).resolves.toBe(true);
    expect(state.setToolbarLayout.mock.calls[1][1].zones[0].name).toBe('稍后修改');
  });

  it('keeps the draft open on failure and closes only after a successful retry', async () => {
    await longPress();
    edit.renameZone('main', '用户编辑'); renderHook();
    state.setToolbarLayout.mockResolvedValueOnce(false);
    await edit.exitEdit(); renderHook();
    expect(edit.isEditing).toBe(true);
    expect(edit.layout.zones[0].name).toBe('用户编辑');
    await edit.exitEdit(); renderHook();
    expect(edit.isEditing).toBe(false);
    expect(state.setToolbarLayout.mock.calls[1][1].zones[0].name).toBe('用户编辑');
  });

  it('does not discard new edits or double-submit during an earlier save', async () => {
    await longPress();
    let finish!: (ok: boolean) => void;
    state.setToolbarLayout.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const saving = edit.exitEdit();
    await edit.exitEdit();
    edit.renameZone('main', '后续编辑'); renderHook();
    finish(true); await saving; renderHook();
    expect(state.setToolbarLayout).toHaveBeenCalledOnce();
    expect(edit.isEditing).toBe(true);
    expect(edit.layout.zones[0].name).toBe('后续编辑');
    await edit.exitEdit(); renderHook();
    expect(edit.isEditing).toBe(false);
  });

  it('retries failed hydration before opening and edits the recovered layout', async () => {
    state.toolbarLayoutsHydrated = false;
    state.loadToolbarLayouts.mockResolvedValueOnce(false);
    await longPress();
    expect(edit.isEditing).toBe(false);
    expect(state.setToolbarLayout).not.toHaveBeenCalled();
    state.loadToolbarLayouts.mockImplementationOnce(async () => {
      state.toolbarLayoutsHydrated = true;
      state.toolbarLayouts = { text: { version: 1, zones: [{ id: 'main', name: '恢复值', buttonKeys: [] }] } };
      return true;
    });
    await longPress();
    expect(edit.isEditing).toBe(true);
    expect(edit.layout.zones[0].name).toBe('恢复值');
  });

  it('does not toggle away an unsaved draft on a second long press', async () => {
    await longPress();
    edit.renameZone('main', '保留草稿'); renderHook();
    await longPress();
    expect(edit.isEditing).toBe(true);
    expect(edit.layout.zones[0].name).toBe('保留草稿');
    expect(state.setToolbarLayout).not.toHaveBeenCalled();
  });

  it('does not start a second hydration or enter editing after unmount', async () => {
    state.toolbarLayoutsHydrated = false;
    let finish!: () => void;
    state.loadToolbarLayouts.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await longPress();
    await longPress();
    expect(state.loadToolbarLayouts).toHaveBeenCalledOnce();
    cleanups.forEach((fn) => fn());
    state.toolbarLayoutsHydrated = true;
    finish();
    await vi.advanceTimersByTimeAsync(0);
    renderHook();
    expect(edit.isEditing).toBe(false);
  });
});
