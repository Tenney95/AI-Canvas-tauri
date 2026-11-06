import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation } from '../../../src/types/chat';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  vi.resetModules();
});

const conversation = (): ChatConversation => ({ id: 'conv-workbench', projectId: 'series', title: '本集创作', titleSource: 'user',
  pinned: false, archived: false, agentMode: 'collaborative', createdAt: 1, updatedAt: 1, messageCount: 0,
  workbenchTarget: { seriesId: 'series', episodeId: 'episode-b' } });

describe('工作台会话持久绑定', () => {
  it('保存和恢复会话目标不依赖任务记录，旧元数据快照不会清除绑定', async () => {
    const history = await import('../../../src/services/chat/chatHistoryService');
    const db = await import('../../../src/services/indexedDbService');
    const source = conversation();
    await history.saveConversation(source);
    await db.putChatConversation({ ...source, title: '异步更新标题', workbenchTarget: undefined });
    expect((await history.loadProjectConversations('series'))[0]).toMatchObject({ title: '异步更新标题', workbenchTarget: source.workbenchTarget });
  });

  it('持久化层拒绝对已有会话改绑分集', async () => {
    const db = await import('../../../src/services/indexedDbService');
    const source = conversation();
    await db.putChatConversation(source);
    await expect(db.putChatConversation({ ...source, workbenchTarget: { seriesId: 'series', episodeId: 'episode-a' } }))
      .rejects.toThrow('不能更换');
    expect((await db.getProjectConversations('series'))[0].workbenchTarget).toEqual(source.workbenchTarget);
  });

  it('非法绑定失败关闭，不删除目标后保存成普通会话', async () => {
    const history = await import('../../../src/services/chat/chatHistoryService');
    await expect(history.saveConversation({ ...conversation(), workbenchTarget: { seriesId: 'other-series', episodeId: 'episode-b' } }))
      .rejects.toThrow('目标无效');
    expect(await history.loadProjectConversations('series')).toEqual([]);
  });

  it('损坏的已有绑定读取失败，也不能被普通元数据写入抹去', async () => {
    const schema = await import('../../../src/services/indexedDb/schema');
    const database = await schema.openDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(schema.STORE_CHAT_CONVERSATIONS, 'readwrite');
      transaction.objectStore(schema.STORE_CHAT_CONVERSATIONS).put({ ...conversation(), workbenchTarget: null });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const history = await import('../../../src/services/chat/chatHistoryService');
    const db = await import('../../../src/services/indexedDbService');
    await expect(history.loadProjectConversations('series')).rejects.toThrow('目标无效');
    await expect(db.putChatConversation({ ...conversation(), workbenchTarget: undefined })).rejects.toThrow('目标无效');
  });
});
