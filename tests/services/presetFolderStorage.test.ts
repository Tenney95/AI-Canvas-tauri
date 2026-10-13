import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresetFolder } from '../../src/types';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  vi.resetModules();
});

const folder: PresetFolder = { id: 'characters', nodeType: 'ai-image', name: '人物' };
const preset = { id: 'three-view', nodeType: 'ai-image', name: '三视图', description: '人物', promptTemplate: '完整原模板', triggerMode: 'direct', folderId: folder.id };

describe('快捷指令分类持久化', () => {
  it('复用 metadata 保存空文件夹，旧指令无需迁移', async () => {
    const db = await import('../../src/services/indexedDb/catalogRepository');
    expect(await db.loadPresetFoldersFromDb()).toEqual([]);
    await db.savePresetToDb({ ...preset, folderId: undefined });
    await db.savePresetFolderToDb(folder);
    expect(await db.loadPresetFoldersFromDb()).toEqual([folder]);
    expect((await db.getAllPresets())[0]).toMatchObject({ id: preset.id, promptTemplate: preset.promptTemplate });
  });

  it('改名保留分类 ID；移除文件夹同时解除指令关联并保留其他类型', async () => {
    const db = await import('../../src/services/indexedDb/catalogRepository');
    const other: PresetFolder = { id: 'videos', nodeType: 'ai-video', name: '人物' };
    await db.savePresetFolderToDb(folder); await db.savePresetFolderToDb(other);
    await db.savePresetToDb(preset);
    await db.savePresetToDb({ ...preset, id: 'video', nodeType: 'ai-video', folderId: other.id });
    await db.savePresetFolderToDb({ ...folder, name: '角色参考' });
    expect((await db.getAllPresets()).find((item) => item.id === preset.id)?.folderId).toBe(folder.id);
    await db.deletePresetFolderFromDb(folder.id);
    expect(await db.loadPresetFoldersFromDb()).toEqual([other]);
    const records = await db.getAllPresets();
    expect(records.find((item) => item.id === preset.id)).toMatchObject({ promptTemplate: preset.promptTemplate, folderId: undefined });
    expect(records.find((item) => item.id === 'video')?.folderId).toBe(other.id);
  });

  it('并发添加同类型同名文件夹只成功一次，拒绝空名与跨类型改名', async () => {
    const db = await import('../../src/services/indexedDb/catalogRepository');
    const results = await Promise.allSettled([db.savePresetFolderToDb(folder), db.savePresetFolderToDb({ ...folder, id: 'second' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.loadPresetFoldersFromDb()).toHaveLength(1);
    await expect(db.savePresetFolderToDb({ ...folder, id: 'blank', name: '  ' })).rejects.toThrow('名称');
    const stored = (await db.loadPresetFoldersFromDb())[0];
    await expect(db.savePresetFolderToDb({ ...stored, nodeType: 'ai-video' })).rejects.toThrow('所属类型');
  });

  it('删除事务中途失败时，文件夹与指令引用一同回滚', async () => {
    const repository = await import('../../src/services/indexedDb/catalogRepository');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    await repository.savePresetFolderToDb(folder); await repository.savePresetToDb(preset);
    const database = await openDB();
    const transaction = database.transaction.bind(database);
    const spy = vi.spyOn(database, 'transaction').mockImplementationOnce((stores, mode, options) => {
      const tx = transaction(stores, mode, options);
      const metadata = tx.objectStore('metadata');
      const put = metadata.put.bind(metadata);
      vi.spyOn(metadata, 'put').mockImplementation((value, key) => {
        const request = put(value, key);
        request.addEventListener('success', () => tx.abort());
        return request;
      });
      const objectStore = tx.objectStore.bind(tx);
      vi.spyOn(tx, 'objectStore').mockImplementation((name) => name === 'metadata' ? metadata : objectStore(name));
      return tx;
    });
    await expect(repository.deletePresetFolderFromDb(folder.id)).rejects.toBeDefined();
    spy.mockRestore();
    expect(await repository.loadPresetFoldersFromDb()).toEqual([folder]);
    expect((await repository.getAllPresets())[0]).toMatchObject(preset);
  });
});
