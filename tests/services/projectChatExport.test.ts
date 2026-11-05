/** 项目聊天导出批读：保持原读取范围、排序、预算及事务失败语义。 */
import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory,
  IDBIndex as FakeIDBIndex,
  IDBObjectStore as FakeIDBObjectStore,
} from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversationRecord, ChatMessageRecord, ProjectMemoryRecord } from '../../src/services/indexedDbService';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  vi.resetModules();
});

function conversation(id: string, overrides: Partial<ChatConversationRecord> = {}): ChatConversationRecord {
  return { id, projectId: 'p1', title: id, titleSource: 'auto', pinned: false, archived: false,
    agentMode: 'collaborative', createdAt: 1, updatedAt: 1, messageCount: 0, ...overrides };
}

function message(id: string, conversationId: string, sequence: number, projectId = 'p1'): ChatMessageRecord {
  return { id, projectId, conversationId, sequence, role: 'user', content: id,
    status: 'done', createdAt: 1, updatedAt: 1 };
}

function memory(id: string, updatedAt: number, projectId = 'p1'): ProjectMemoryRecord {
  return { id, projectId, kind: 'decision', content: id, enabled: true,
    source: { conversationId: 'foreign' }, createdAt: 1, updatedAt };
}

async function seedProject() {
  const service = await import('../../src/services/indexedDbService');
  await Promise.all([
    conversation('second', { updatedAt: 20 }), conversation('first', { updatedAt: 10 }),
    conversation('empty', { updatedAt: 15 }), conversation('archived', { archived: true, updatedAt: 30 }),
    conversation('deleted', { deletedAt: 10 }), conversation('foreign', { projectId: 'p2' }),
  ].map((record) => service.putChatConversation(record)));
  await Promise.all([
    message('first-last', 'first', 3), message('first-zero', 'first', 0),
    message('same-a', 'second', 1), message('same-z', 'second', 1), message('second-last', 'second', 2),
    message('negative', 'second', -1), message('archived-message', 'archived', 0),
    message('deleted-secret', 'deleted', 0), message('foreign-secret', 'foreign', 0, 'p2'),
    message('orphan', 'missing-conversation', 0),
  ].map((record) => service.putChatMessage(record)));
  await Promise.all([
    memory('new', 20), memory('old-z', 10), memory('old-a', 10), memory('foreign', 1, 'p2'),
  ].map((record) => service.putProjectMemory(record)));
  return service;
}

describe('getProjectChatForExport', () => {
  it('returns an empty project without unrelated records', async () => {
    const service = await seedProject();
    await expect(service.getProjectChatForExport('empty-project', 10))
      .resolves.toEqual({ conversations: [], messages: [], memories: [] });
  });

  it('matches the legacy readers for project scope, deleted conversations, empty chats and ordering', async () => {
    const service = await seedProject();
    const conversations = await service.getProjectConversations('p1');
    const groups = await Promise.all(conversations.map(async (record) => {
      const { messages } = await service.getConversationMessages(record.id, 0, 10);
      return messages.slice().sort((left, right) => left.sequence - right.sequence);
    }));
    const memories = await service.getProjectMemories('p1');

    const result = await service.getProjectChatForExport('p1', 10);

    expect(result).toEqual({ conversations, messages: groups.flat(), memories });
    expect(result.conversations.map((record) => record.id)).toEqual(['first', 'empty', 'second', 'archived']);
    expect(result.messages.map((record) => record.id))
      .toEqual(['first-zero', 'first-last', 'same-z', 'same-a', 'second-last', 'archived-message']);
    expect(result.memories.map((record) => record.id)).toEqual(['old-a', 'old-z', 'new']);
    // 记忆来源允许指向其他分集；这里只按记忆自己的项目归属读取。
    expect(result.memories.every((record) => record.source.conversationId === 'foreign')).toBe(true);
  });

  it('preserves inconsistent message ownership for the later archive relationship validation', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putChatConversation(conversation('chat'));
    const inconsistent = message('inconsistent', 'chat', 0, 'another-project');
    await service.putChatMessage(inconsistent);
    expect((await service.getProjectChatForExport('p1', 1)).messages).toEqual([inconsistent]);
  });

  it.each([2, 3])('enforces the per-conversation budget of %s without returning a partial payload', async (limit) => {
    const service = await import('../../src/services/indexedDbService');
    await service.putChatConversation(conversation('chat'));
    await Promise.all(Array.from({ length: 3 }, (_, index) => service.putChatMessage(message(`m${index}`, 'chat', index))));
    const result = service.getProjectChatForExport('p1', limit);
    if (limit === 2) await expect(result).rejects.toThrow('会话消息超过当前归档上限，请先拆分会话后重新导出');
    else expect((await result).messages.map((record) => record.id)).toEqual(['m0', 'm1', 'm2']);
  });

  it('does not read or enforce message budgets for deleted conversations', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putChatConversation(conversation('active'));
    await service.putChatConversation(conversation('deleted', { deletedAt: 1 }));
    await service.putChatMessage(message('visible', 'active', 0));
    await Promise.all(Array.from({ length: 3 }, (_, index) => service.putChatMessage(message(`hidden${index}`, 'deleted', index))));
    const result = await service.getProjectChatForExport('p1', 1);
    expect(result.messages.map((record) => record.id)).toEqual(['visible']);
  });

  it('uses one readonly transaction and bounded getAll requests without count or row cursors', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putChatConversation(conversation('one'));
    await service.putChatConversation(conversation('two'));
    await Promise.all(['one', 'two'].flatMap((id) => Array.from({ length: 20 }, (_, index) => (
      service.putChatMessage(message(`${id}-${index}`, id, index))
    ))));
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, 'transaction');
    const getAll = vi.spyOn(FakeIDBIndex.prototype, 'getAll');
    const count = vi.spyOn(FakeIDBIndex.prototype, 'count');
    const indexCursor = vi.spyOn(FakeIDBIndex.prototype, 'openCursor');
    const storeCursor = vi.spyOn(FakeIDBObjectStore.prototype, 'openCursor');

    expect((await service.getProjectChatForExport('p1', 50)).messages).toHaveLength(40);

    expect(transaction).toHaveBeenCalledExactlyOnceWith(['chatConversations', 'chatMessages', 'projectMemories'], 'readonly');
    expect(getAll).toHaveBeenCalledTimes(4);
    const messageReads = getAll.mock.calls.filter((_, index) => (getAll.mock.contexts[index] as IDBIndex).name === 'conversationId_sequence');
    expect(messageReads.map((call) => call[1])).toEqual([51, 51]);
    expect(count).not.toHaveBeenCalled();
    expect(indexCursor).not.toHaveBeenCalled();
    expect(storeCursor).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, 0xffff_ffff, Number.MAX_SAFE_INTEGER])('rejects an invalid budget %s before opening the database', async (limit) => {
    const service = await import('../../src/services/indexedDbService');
    const open = vi.spyOn(indexedDB, 'open');
    await expect(service.getProjectChatForExport('p1', limit)).rejects.toThrow('会话消息归档上限无效');
    expect(open).not.toHaveBeenCalled();
  });

  it('allows the largest limit whose extra sentinel still fits an IDB count', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putChatConversation(conversation('chat'));
    await service.putChatMessage(message('m', 'chat', 0));
    expect((await service.getProjectChatForExport('p1', 0xffff_fffe)).messages.map((record) => record.id)).toEqual(['m']);
  });

  it.each(['chatConversations', 'chatMessages', 'projectMemories'])('rejects when the %s read transaction is aborted', async (storeName) => {
    const service = await import('../../src/services/indexedDbService');
    await service.putChatConversation(conversation('chat'));
    await service.putChatMessage(message('m', 'chat', 0));
    await service.putProjectMemory(memory('memory', 1));
    const getAll = FakeIDBIndex.prototype.getAll;
    vi.spyOn(FakeIDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, query, count) {
      const request = getAll.call(this, query, count);
      if (this.objectStore.name === storeName) {
        request.addEventListener('success', () => queueMicrotask(() => request.transaction?.abort()), { once: true });
      }
      return request;
    });
    await expect(service.getProjectChatForExport('p1', 10)).rejects.toThrow('项目聊天归档读取失败');
  });

  it('rejects a failed message read without leaving the export promise pending', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putChatConversation(conversation('chat'));
    const getAll = FakeIDBIndex.prototype.getAll;
    vi.spyOn(FakeIDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, query, count) {
      if (this.objectStore.name === 'chatMessages') throw new DOMException('Read failed', 'UnknownError');
      return getAll.call(this, query, count);
    });
    await expect(service.getProjectChatForExport('p1', 10)).rejects.toMatchObject({ name: 'UnknownError' });
  });
});
