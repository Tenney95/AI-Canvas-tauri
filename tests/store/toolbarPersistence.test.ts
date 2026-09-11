import { IDBFactory } from 'fake-indexeddb';
import { createStore, type StateCreator } from 'zustand/vanilla';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolbarLayout } from '../../src/types';
import type { ToolbarSlice } from '../../src/store/store.toolbar';

async function hydrate(store: { getState: () => ToolbarSlice }): Promise<boolean> {
  await store.getState().loadToolbarLayouts();
  return store.getState().toolbarLayoutsHydrated;
}

const layout = (name: string): ToolbarLayout => ({ version: 1, zones: [{ id: 'main', name, buttonKeys: ['copy'] }] });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function fixture() {
  const { createToolbarSlice } = await import('../../src/store/store.toolbar');
  const storage = await import('../../src/services/storageService');
  const dbService = await import('../../src/services/indexedDbService');
  const { openDB, STORE_TOOLBAR_LAYOUTS } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  type State = ToolbarSlice & { showToast: ReturnType<typeof vi.fn> };
  const makeStore = () => createStore<State>()((set, get, api) => ({
    ...(createToolbarSlice as unknown as StateCreator<State, [], [], ToolbarSlice>)(set, get, api),
    showToast: vi.fn(),
  }));
  return { storage, dbService, db, storeName: STORE_TOOLBAR_LAYOUTS, makeStore };
}

describe('toolbar persistence failure protection', () => {
  it('rejects a same-type conflict including close retry and reloads only after the user discards that draft', async () => {
    const { makeStore, dbService } = await fixture();
    await dbService.saveToolbarLayoutsToDb({ text: layout('原布局') });
    const first = makeStore(); const second = makeStore();
    await hydrate(first); await hydrate(second);
    expect(await first.getState().setToolbarLayout('text', layout('另一个窗口'))).toBe(true);
    expect(await second.getState().setToolbarLayout('text', layout('我的草稿'))).toBe(false);
    expect(second.getState().toolbarSaveErrors.text).toBe('conflict');
    const queue = await import('../../src/services/configPersistenceQueue');
    expect(await queue.prepareSettingsClose(true)).toBe(false);
    expect(await dbService.loadToolbarLayoutsFromDb()).toMatchObject({ text: layout('另一个窗口') });
    queue.resumeSettingsPersistence();
    expect(await second.getState().reloadToolbarLayout('text')).toBe(true);
    expect(second.getState().toolbarLayouts.text).toEqual(layout('另一个窗口'));
    expect(second.getState().toolbarSaveErrors).toEqual({});
    expect(await second.getState().setToolbarLayout('text', layout('重新编辑'))).toBe(true);
  });

  it('rejects a stale editor baseline even if the Store has reloaded, and serializes current local changes', async () => {
    const { makeStore, dbService } = await fixture();
    await dbService.saveToolbarLayoutsToDb({ text: layout('旧布局') });
    const store = makeStore(); await hydrate(store);
    await dbService.saveToolbarLayoutsToDb({ text: layout('新布局') });
    await hydrate(store);
    expect(await store.getState().setToolbarLayout('text', layout('旧编辑器'), { baseline: layout('旧布局') })).toBe(false);
    await store.getState().reloadToolbarLayout('text');
    expect(await Promise.all([store.getState().setToolbarLayout('text', layout('先改')), store.getState().setToolbarLayout('text', layout('后改'))])).toEqual([true, true]);
    expect(await dbService.loadToolbarLayoutsFromDb()).toMatchObject({ text: layout('后改') });
  });

  it('blocks writes until a successful load and preserves other layouts after retry', async () => {
    const { dbService, storage, makeStore } = await fixture();
    await dbService.saveToolbarLayoutsToDb({ video: layout('原视频') });
    const store = makeStore();
    vi.spyOn(storage, 'loadToolbarLayouts').mockRejectedValueOnce(new Error('private-path'));
    expect(await hydrate(store)).toBe(false);
    expect(await store.getState().setToolbarLayout('text', layout('新文本'))).toBe(false);
    expect(await dbService.loadToolbarLayoutsFromDb()).toEqual({ video: layout('原视频') });
    expect(await hydrate(store)).toBe(true);
    expect(await store.getState().setToolbarLayout('text', layout('新文本'))).toBe(true);
    expect(await dbService.loadToolbarLayoutsFromDb()).toEqual({ video: layout('原视频'), text: layout('新文本') });
    expect(store.getState().toolbarSaveErrors).toEqual({});
  });

  it('retains the last loaded values if a later load fails', async () => {
    const { dbService, storage, makeStore } = await fixture();
    await dbService.saveToolbarLayoutsToDb({ text: layout('原布局') });
    const store = makeStore();
    await hydrate(store);
    vi.spyOn(storage, 'loadToolbarLayouts').mockRejectedValueOnce(new Error('read failed'));
    expect(await hydrate(store)).toBe(false);
    expect(store.getState().toolbarLayouts).toEqual({ text: layout('原布局') });
    expect(store.getState().toolbarLayoutsHydrated).toBe(false);
  });

  it('merges writes from separately loaded stores and resets only the requested type', async () => {
    const { dbService, makeStore } = await fixture();
    const first = makeStore();
    const second = makeStore();
    await Promise.all([first.getState().loadToolbarLayouts(), second.getState().loadToolbarLayouts()]);
    expect(await Promise.all([
      first.getState().setToolbarLayout('text', layout('文本')),
      second.getState().setToolbarLayout('video', layout('视频')),
    ])).toEqual([true, true]);
    expect(await dbService.loadToolbarLayoutsFromDb()).toEqual({ text: layout('文本'), video: layout('视频') });
    await first.getState().resetToolbarLayout('text');
    expect(await dbService.loadToolbarLayoutsFromDb()).toEqual({ video: layout('视频') });
  });

  it('does not publish memory success when a write transaction aborts after put', async () => {
    const { dbService, db, makeStore } = await fixture();
    await dbService.saveToolbarLayoutsToDb({ text: layout('原布局') });
    const store = makeStore();
    await hydrate(store);
    const transaction = db.transaction.bind(db);
    const fault = vi.spyOn(db, 'transaction').mockImplementationOnce((...args: Parameters<IDBDatabase['transaction']>) => {
      const tx = transaction(...args);
      const objectStore = tx.objectStore.bind(tx);
      vi.spyOn(tx, 'objectStore').mockImplementation((name) => {
        const os = objectStore(name);
        const put = os.put.bind(os);
        vi.spyOn(os, 'put').mockImplementation((...putArgs: Parameters<IDBObjectStore['put']>) => {
          const request = put(...putArgs);
          request.addEventListener('success', () => tx.abort());
          return request;
        });
        return os;
      });
      return tx;
    });
    expect(await store.getState().setToolbarLayout('text', layout('新布局'))).toBe(false);
    fault.mockRestore();
    expect(store.getState().toolbarLayouts.text).toEqual(layout('原布局'));
    expect(store.getState().toolbarPersistenceStatus).toBe('error');
    expect(await dbService.loadToolbarLayoutsFromDb()).toEqual({ text: layout('原布局') });
    expect(await store.getState().setToolbarLayout('text', layout('新布局'))).toBe(true);
  });

  it('serializes a late load with queued saves and captures the submitted layout', async () => {
    const { storage, makeStore, dbService } = await fixture();
    await dbService.saveToolbarLayoutsToDb({ text: layout('旧值') });
    const store = makeStore();
    let resolve!: (value: Record<string, unknown>) => void;
    vi.spyOn(storage, 'loadToolbarLayouts').mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const loading = hydrate(store);
    await Promise.resolve();
    const submitted = layout('提交时');
    const saving = store.getState().setToolbarLayout('text', submitted);
    submitted.zones[0].name = '提交后修改';
    resolve({ text: layout('旧值') });
    expect(await loading).toBe(true);
    expect(await saving).toBe(true);
    expect(store.getState().toolbarLayouts.text).toEqual(layout('提交时'));
  });

  it('propagates read failures safely and retries only transient reads', async () => {
    const { storage, db } = await fixture();
    const fault = vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('G:/private sk-sensitive', 'AbortError');
    });
    expect(await storage.loadToolbarLayouts()).toBeNull();
    expect(fault).toHaveBeenCalledTimes(2);
    fault.mockImplementationOnce(() => { throw new DOMException('G:/private sk-sensitive', 'SecurityError'); });
    const error = await storage.loadToolbarLayouts().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'permission' });
    expect(String(error)).not.toContain('private');
  });

  it('rejects corrupt stored data instead of treating it as empty', async () => {
    const { dbService, makeStore, db, storeName } = await fixture();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put({ id: 'layouts', data: 'broken' });
      tx.oncomplete = () => resolve();
    });
    const store = makeStore();
    expect(await hydrate(store)).toBe(false);
    await expect(dbService.saveToolbarLayoutToDb('text', layout('新布局'))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('waits for readonly transaction completion even after a successful get', async () => {
    const { storage, db, dbService } = await fixture();
    await dbService.saveToolbarLayoutsToDb({ text: layout('原布局') });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((...args: Parameters<IDBDatabase['transaction']>) => {
      const tx = transaction(...args);
      const objectStore = tx.objectStore.bind(tx);
      vi.spyOn(tx, 'objectStore').mockImplementation((name) => {
        const os = objectStore(name);
        const get = os.get.bind(os);
        vi.spyOn(os, 'get').mockImplementation((key) => {
          const request = get(key);
          request.addEventListener('success', () => tx.abort());
          return request;
        });
        return os;
      });
      return tx;
    });
    await expect(storage.loadToolbarLayouts()).rejects.toMatchObject({ code: 'interrupted', attempt: 3 });
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });
});
