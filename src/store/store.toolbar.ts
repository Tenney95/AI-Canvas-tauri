/**
 * store.toolbar.ts — Toolbar 自定义布局持久化
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { ToolbarLayout, ToolbarLayouts } from '../types';
import { saveToolbarLayout, loadToolbarLayouts } from '../services/storageService';
import { reportStorageError, StorageError, type StorageErrorCode } from '../services/storageDiagnostics';
import { areSettingsMutationsFrozen, registerSettingsPersistence } from '../services/configPersistenceQueue';

export interface ToolbarSlice {
  toolbarLayouts: ToolbarLayouts;
  toolbarLayoutsHydrated: boolean;
  toolbarPersistenceStatus: 'idle' | 'loading' | 'saving' | 'saved' | 'error';
  toolbarSaveErrors: Record<string, StorageErrorCode>;

  /** 保存某个 nodeType 的 Toolbar 布局到内存 + IndexedDB */
  setToolbarLayout: (nodeType: string, layout: ToolbarLayout, expected?: { baseline: ToolbarLayout | null }) => Promise<boolean>;
  reloadToolbarLayout: (nodeType: string) => Promise<boolean>;

  /** 重置某个 nodeType 的布局 */
  resetToolbarLayout: (nodeType: string) => Promise<boolean>;

  /** 从 IndexedDB 加载所有 Toolbar 布局 */
  loadToolbarLayouts: () => Promise<void>;
}

function validateLayouts(data: Record<string, unknown> | null): ToolbarLayouts {
  for (const value of Object.values(data ?? {})) {
    const layout = value as ToolbarLayout | null;
    if (!layout || !Number.isInteger(layout.version) || !Array.isArray(layout.zones)
      || !layout.zones.every((zone) => zone && typeof zone.id === 'string' && typeof zone.name === 'string'
        && Array.isArray(zone.buttonKeys) && zone.buttonKeys.every((key) => typeof key === 'string'))) {
      throw new StorageError('toolbar-read', 'corrupt');
    }
  }
  return (data ?? {}) as ToolbarLayouts;
}

export const createToolbarSlice: StateCreator<AppState, [], [], ToolbarSlice> = (set, get) => {
  // 连同内存提交一起排队，防止较早的加载回调覆盖新保存的布局。
  let tail: Promise<unknown> = Promise.resolve();
  const pendingLayouts = new Map<string, { layout: ToolbarLayout | null; expected?: { baseline: ToolbarLayout | null } }>();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  const persist = (nodeType: string, layout: ToolbarLayout | null, expected?: { baseline: ToolbarLayout | null }, retry = false) => {
    if (areSettingsMutationsFrozen() && !retry) return Promise.resolve(false);
    const snapshot = structuredClone(layout);
    const pending = { layout: snapshot, expected: structuredClone(expected) };
    pendingLayouts.set(nodeType, pending);
    return enqueue(async () => {
      try {
        if (!get().toolbarLayoutsHydrated) throw new StorageError('toolbar-write', 'unavailable');
        set({ toolbarPersistenceStatus: 'saving' });
        pending.expected ??= { baseline: structuredClone(get().toolbarLayouts[nodeType] ?? null) };
        await saveToolbarLayout(nodeType, snapshot, pending.expected);
        if (pendingLayouts.get(nodeType) === pending) pendingLayouts.delete(nodeType);
        set((state) => {
          const next = { ...state.toolbarLayouts };
          if (snapshot === null) delete next[nodeType];
          else Object.defineProperty(next, nodeType, { value: snapshot, enumerable: true, configurable: true, writable: true });
          const errors = { ...state.toolbarSaveErrors };
          delete errors[nodeType];
          return { toolbarLayouts: next, toolbarSaveErrors: errors,
            toolbarPersistenceStatus: Object.keys(errors).length ? 'error' : 'saved' };
        });
        return true;
      } catch (error) {
        const safe = reportStorageError('toolbar-write', error);
        set((state) => ({ toolbarPersistenceStatus: 'error', toolbarSaveErrors: { ...state.toolbarSaveErrors, [nodeType]: safe.code } }));
        get().showToast(safe.code === 'conflict' ? '其他窗口已修改此工具栏，编辑内容已保留，请重新加载后编辑' : '工具栏未保存，编辑内容已保留，请重试', 'error');
        return false;
      }
    });
  };
  registerSettingsPersistence('toolbar', {
    flush: async (retry) => {
      await tail;
      if (retry) {
        if (!get().toolbarLayoutsHydrated) await get().loadToolbarLayouts();
        for (const [type, pending] of [...pendingLayouts]) await persist(type, pending.layout, pending.expected, true);
      }
      await tail;
    },
    hasUnsaved: () => pendingLayouts.size > 0 || Object.keys(get().toolbarSaveErrors).length > 0,
  });
  return {
    toolbarLayouts: {},
    toolbarLayoutsHydrated: false,
    toolbarPersistenceStatus: 'idle',
    toolbarSaveErrors: {},
    setToolbarLayout: persist,
    resetToolbarLayout: (nodeType) => persist(nodeType, null),
    reloadToolbarLayout: (nodeType) => enqueue(async () => {
      try {
        const layouts = validateLayouts(await loadToolbarLayouts());
        pendingLayouts.delete(nodeType);
        set((state) => {
          const next = { ...state.toolbarLayouts };
          if (layouts[nodeType]) next[nodeType] = layouts[nodeType]; else delete next[nodeType];
          const errors = { ...state.toolbarSaveErrors };
          delete errors[nodeType];
          return { toolbarLayouts: next, toolbarSaveErrors: errors, toolbarPersistenceStatus: Object.keys(errors).length ? 'error' : 'idle' };
        });
        return true;
      } catch (error) {
        reportStorageError('toolbar-read', error);
        get().showToast('工具栏重新加载失败，编辑内容仍保留', 'error');
        return false;
      }
    }),
    loadToolbarLayouts: () => enqueue(async () => {
      set({ toolbarPersistenceStatus: 'loading' });
      try {
        const layouts = validateLayouts(await loadToolbarLayouts());
        set({ toolbarLayouts: layouts, toolbarLayoutsHydrated: true,
          toolbarPersistenceStatus: Object.keys(get().toolbarSaveErrors).length ? 'error' : 'idle' });
      } catch (error) {
        reportStorageError('toolbar-read', error);
        set({ toolbarLayoutsHydrated: false, toolbarPersistenceStatus: 'error' });
        get().showToast('工具栏设置读取失败，已保留原布局；长按工具栏可重试加载', 'error');
      }
    }),
  };
};
