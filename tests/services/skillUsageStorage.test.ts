/** 最近 Skill 使用偏好的持久化边界；不修改 Skill 内容。 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  vi.resetModules();
});

describe('最近使用 Skill 持久化', () => {
  it('空库正常读取，保存后按使用顺序去重并只保留五项，不修改 Skill 内容', async () => {
    const usage = await import('../../src/services/indexedDb/skillUsageRepository');
    const skills = await import('../../src/services/indexedDb/catalogRepository');
    const skill = { id: 'a', name: '分镜', description: '生成分镜', fileName: 'SKILL.md', content: '原正文', sourceType: 'file', createdAt: 1 };
    await skills.saveSkillToDb(skill);
    expect(await usage.loadRecentSkillIds()).toEqual([]);

    await usage.saveRecentSkillIds(['c', 'b', 'c', 'a', 'd', 'e', 'f']);

    expect(await usage.loadRecentSkillIds()).toEqual(['c', 'b', 'a', 'd', 'e']);
    expect(await skills.getAllSkills()).toEqual([skill]);
  });

  it('读取过滤无效 ID，超大数组或超长 ID 拒绝而不覆盖已有记录', async () => {
    const usage = await import('../../src/services/indexedDb/skillUsageRepository');
    const { openDB, STORE_METADATA } = await import('../../src/services/indexedDb/schema');
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_METADATA, 'readwrite');
      tx.objectStore(STORE_METADATA).put({ id: usage.RECENT_SKILL_IDS_KEY, skillIds: ['a', '', 'a', null, ' ', 'b'] });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    expect(await usage.loadRecentSkillIds()).toEqual(['a', 'b']);
    await expect(usage.saveRecentSkillIds(Array.from({ length: 101 }, (_, index) => `skill-${index}`))).rejects.toThrow('格式异常');
    await expect(usage.saveRecentSkillIds(['x'.repeat(257)])).rejects.toThrow('格式异常');
    expect(await usage.loadRecentSkillIds()).toEqual(['a', 'b']);
  });

  it('损坏或超大的持久化记录不能伪装为空历史', async () => {
    const usage = await import('../../src/services/indexedDb/skillUsageRepository');
    const { openDB, STORE_METADATA } = await import('../../src/services/indexedDb/schema');
    const database = await openDB();
    for (const skillIds of ['a', Array.from({ length: 101 }, () => 'a'), ['x'.repeat(257)], [{ nested: 'invalid' }]]) {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE_METADATA, 'readwrite');
        tx.objectStore(STORE_METADATA).put({ id: usage.RECENT_SKILL_IDS_KEY, skillIds });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      await expect(usage.loadRecentSkillIds()).rejects.toThrow('格式异常');
    }
  });

  it('保存请求成功后事务中止仍报告失败，原最近记录保持完整', async () => {
    const usage = await import('../../src/services/indexedDb/skillUsageRepository');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    await usage.saveRecentSkillIds(['old']);
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
    await expect(usage.saveRecentSkillIds(['new'])).rejects.toBeDefined();
    spy.mockRestore();
    expect(await usage.loadRecentSkillIds()).toEqual(['old']);
  });
});
