/**
 * chatMessageSequence — 回归测试：putChatMessageWithSequence。
 */
import {
  IDBCursor as FakeIDBCursor,
  IDBFactory,
  IDBIndex as FakeIDBIndex,
  IDBObjectStore as FakeIDBObjectStore,
} from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageRecord } from '../../src/services/indexedDbService';
import type { AgentTask } from '../../src/types/agent';
import type { ProjectMemory } from '../../src/types/memory';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

function record(id: string, overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id,
    projectId: 'p1',
    conversationId: 'c1',
    sequence: 0,
    role: 'user',
    content: id,
    status: 'done',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function projectMemory(id: string, projectId = 'p1'): ProjectMemory {
  return { id, projectId, kind: 'decision', content: id, enabled: true,
    source: { conversationId: `c-${projectId}` }, createdAt: 1, updatedAt: 1 };
}

async function seedRecords(storeName: string, values: unknown[]): Promise<void> {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    for (const value of values) tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

async function readRecord(storeName: string, key: IDBValidKey): Promise<unknown> {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

describe('putChatMessageWithSequence', () => {
  it('assigns incrementing sequences to new messages and keeps them on read', async () => {
    const svc = await import('../../src/services/indexedDbService');
    expect(await svc.putChatMessageWithSequence(record('a'))).toBe(0);
    expect(await svc.putChatMessageWithSequence(record('b'))).toBe(1);
    expect(await svc.putChatMessageWithSequence(record('c'))).toBe(2);

    const { messages } = await svc.getConversationMessages('c1', 0, 50);
    // 倒序返回；序号严格递增无重复
    expect(messages.map((m) => m.sequence)).toEqual([2, 1, 0]);
  });

  it('preserves an existing message sequence on update (no reordering)', async () => {
    const svc = await import('../../src/services/indexedDbService');
    await svc.putChatMessageWithSequence(record('a')); // seq 0
    await svc.putChatMessageWithSequence(record('b')); // seq 1
    await svc.putChatMessageWithSequence(record('c')); // seq 2

    // 更新最早的消息：sequence 必须保持 0，不能被重排到末尾
    const seq = await svc.putChatMessageWithSequence(record('a', { content: 'edited' }));
    expect(seq).toBe(0);

    const { messages } = await svc.getConversationMessages('c1', 0, 50);
    const a = messages.find((m) => m.id === 'a');
    expect(a?.sequence).toBe(0);
    expect(a?.content).toBe('edited');
  });

  it('gives concurrent inserts distinct sequences (no duplicates)', async () => {
    const svc = await import('../../src/services/indexedDbService');
    // 用户消息与助手占位并发落盘：事务串行化应产生 0 和 1，而非两个 0
    const seqs = await Promise.all([
      svc.putChatMessageWithSequence(record('user')),
      svc.putChatMessageWithSequence(record('assistant')),
    ]);
    expect([...seqs].sort()).toEqual([0, 1]);
  });

  it('reads only the last index key when assigning a new sequence', async () => {
    const svc = await import('../../src/services/indexedDbService');
    await svc.putChatMessage(record('last', { sequence: 20, content: 'large message '.repeat(1000) }));
    await svc.putChatMessage(record('other', { conversationId: 'other', sequence: 100 }));
    const valueCursor = vi.spyOn(FakeIDBIndex.prototype, 'openCursor');
    const keyCursor = vi.spyOn(FakeIDBIndex.prototype, 'openKeyCursor');

    expect(await svc.putChatMessageWithSequence(record('new'))).toBe(21);
    expect(valueCursor).not.toHaveBeenCalled();
    expect(keyCursor).toHaveBeenCalledTimes(1);
    expect(keyCursor.mock.calls[0][1]).toBe('prev');

    expect(await svc.putChatMessageWithSequence(record('new', { content: 'edited' }))).toBe(21);
    expect(keyCursor).toHaveBeenCalledTimes(1);
  });
});

async function seedMessages() {
  const svc = await import('../../src/services/indexedDbService');
  await Promise.all(Array.from({ length: 5 }, (_, sequence) => (
    svc.putChatMessage(record(`m${sequence}`, { sequence }))
  )));
  await svc.putChatMessage(record('other', { conversationId: 'other', sequence: 100 }));
  return svc;
}

describe('getConversationMessages pagination', () => {
  it.each([
    [0, 2, ['m4', 'm3']],
    [2, 2, ['m2', 'm1']],
    [4, 2, ['m0']],
    [5, 2, []],
    [2 ** 32, 2, []],
    [Infinity, 2, []],
    [-2, 2, ['m4', 'm3']],
    [NaN, 2, ['m4', 'm3']],
    [1.2, 1.2, ['m2', 'm1']],
    [0, 0, []],
    [0, -1, []],
    [0, NaN, []],
    [0, Infinity, ['m4', 'm3', 'm2', 'm1', 'm0']],
  ] as const)('keeps pagination semantics for offset %s and limit %s', async (offset, limit, ids) => {
    const svc = await seedMessages();
    const page = await svc.getConversationMessages('c1', offset, limit);
    expect(page.total).toBe(5);
    expect(page.messages.map((message) => message.id)).toEqual(ids);
  });

  it('skips the prefix with one advance and stops at the last requested row', async () => {
    const svc = await seedMessages();
    const advance = vi.spyOn(FakeIDBCursor.prototype, 'advance');
    const next = vi.spyOn(FakeIDBCursor.prototype, 'continue');

    const page = await svc.getConversationMessages('c1', 2, 2);
    expect(page.messages.map((message) => message.id)).toEqual(['m2', 'm1']);
    expect(advance).toHaveBeenCalledExactlyOnceWith(2);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not open a value cursor for empty or out-of-range pages', async () => {
    const svc = await seedMessages();
    const cursor = vi.spyOn(FakeIDBIndex.prototype, 'openCursor');
    expect(await svc.getConversationMessages('empty')).toEqual({ messages: [], total: 0 });
    expect(await svc.getConversationMessages('c1', 0, 0)).toEqual({ messages: [], total: 5 });
    expect(await svc.getConversationMessages('c1', Infinity, 1)).toEqual({ messages: [], total: 5 });
    expect(cursor).not.toHaveBeenCalled();
  });

  it('rejects an aborted transaction even after the requested page has been read', async () => {
    const svc = await seedMessages();
    const openCursor = FakeIDBIndex.prototype.openCursor;
    vi.spyOn(FakeIDBIndex.prototype, 'openCursor').mockImplementationOnce(function (this: IDBIndex, query, direction) {
      const request = openCursor.call(this, query, direction);
      request.addEventListener('success', () => queueMicrotask(() => request.transaction?.abort()), { once: true });
      return request;
    });
    await expect(svc.getConversationMessages('c1', 0, 1)).rejects.toThrow('会话消息读取失败');
  });
});

describe('conversation message deletion', () => {
  it.each(['messages', 'conversation'] as const)('deletes %s using message keys and keeps other conversations', async (mode) => {
    const svc = await seedMessages();
    for (const id of ['c1', 'other']) {
      await svc.putChatConversation({ id, projectId: 'p1', title: id, titleSource: 'auto', pinned: false,
        archived: false, agentMode: 'collaborative', createdAt: 1, updatedAt: 1, messageCount: 1 });
    }
    const valueCursor = vi.spyOn(FakeIDBIndex.prototype, 'openCursor');
    const keyCursor = vi.spyOn(FakeIDBIndex.prototype, 'openKeyCursor');
    if (mode === 'messages') await svc.deleteConversationMessages('c1');
    else await svc.permanentlyDeleteConversation('c1');

    expect((valueCursor.mock.contexts as IDBIndex[]).filter((index) => index.name === 'conversationId_sequence')).toEqual([]);
    expect(keyCursor).toHaveBeenCalledTimes(1);
    valueCursor.mockRestore();
    expect(await svc.getConversationMessages('c1')).toEqual({ messages: [], total: 0 });
    expect((await svc.getConversationMessages('other')).messages.map((message) => message.id)).toEqual(['other']);
    expect((await svc.getProjectConversations('p1')).map((conversation) => conversation.id).sort())
      .toEqual(mode === 'messages' ? ['c1', 'other'] : ['other']);
  });

  it.each(['messages', 'conversation'] as const)('rejects and rolls back aborted %s deletion', async (mode) => {
    const svc = await seedMessages();
    await svc.putChatConversation({ id: 'c1', projectId: 'p1', title: 'c1', titleSource: 'auto', pinned: false,
      archived: false, agentMode: 'collaborative', createdAt: 1, updatedAt: 1, messageCount: 5 });
    const remove = FakeIDBObjectStore.prototype.delete;
    let abortScheduled = false;
    const deletion = vi.spyOn(FakeIDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = remove.call(this, key);
      if (this.name === 'chatMessages' && !abortScheduled) {
        abortScheduled = true;
        request.addEventListener('success', () => queueMicrotask(() => request.transaction?.abort()), { once: true });
      }
      return request;
    });
    const operation = mode === 'messages' ? svc.deleteConversationMessages('c1') : svc.permanentlyDeleteConversation('c1');
    await expect(operation).rejects.toBeInstanceOf(Error);
    deletion.mockRestore();
    expect((await svc.getConversationMessages('c1')).messages).toHaveLength(5);
    expect((await svc.getProjectConversations('p1')).map((conversation) => conversation.id)).toEqual(['c1']);
  });
});

describe('deleteProjectFromDb', () => {
  it('atomically removes conversations, messages, tasks, and memories for the project', async () => {
    const svc = await import('../../src/services/indexedDbService');
    for (const projectId of ['p1', 'p2']) {
      await svc.saveProjectToDb({
        id: projectId,
        name: projectId,
        createdAt: 1,
        updatedAt: 1,
        nodes: [],
        edges: [],
      });
      await svc.putChatConversation({
        id: `c-${projectId}`,
        projectId,
        title: projectId,
        titleSource: 'auto',
        pinned: false,
        archived: false,
        agentMode: 'collaborative',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
      });
      await svc.putChatMessageWithSequence(record(`m-${projectId}`, {
        projectId,
        conversationId: `c-${projectId}`,
      }));
      await svc.putAgentTask({
        id: `task-${projectId}`,
        projectId,
        conversationId: `c-${projectId}`,
        userMessageId: `m-${projectId}`,
        mode: 'collaborative',
        goal: projectId,
        status: 'completed',
        steps: [],
        budget: {
          maxModelRounds: 12,
          maxToolCalls: 24,
          maxParallelReadTools: 3,
          maxReadRetries: 3,
        },
        modelRounds: 0,
        toolCallCount: 0,
        createdAt: 1,
        updatedAt: 1,
      } as AgentTask);
      await svc.putProjectMemory({
        id: `memory-${projectId}`,
        projectId,
        kind: 'decision',
        content: projectId,
        enabled: true,
        source: { conversationId: `c-${projectId}`, messageId: `m-${projectId}` },
        createdAt: 1,
        updatedAt: 1,
      } as ProjectMemory);
      await svc.putHistoryEntry({ id: `history-${projectId}`, projectId, nodeId: 'node', nodeLabel: 'node',
        timestamp: 1, prompt: 'prompt', output: '', nodeType: 'ai-image', model: 'image-model', provider: 'provider', status: 'success' });
      await svc.putProjectVisualDescription({ id: `visual-${projectId}`, projectId, fingerprint: 'fingerprint',
        description: '图片', modelId: 'general/vision', promptVersion: 'visual-description/v1',
        createdAt: 1, updatedAt: 1, lastUsedAt: 1 });
    }
    await svc.putChatMessage(record('orphan-p1', { projectId: 'p1', conversationId: 'missing' }));
    await svc.putChatMessage(record('orphan-p2', { projectId: 'p2', conversationId: 'missing' }));
    const bindings = ['p1', 'p2'].map((projectId) => ({
      id: `binding-${projectId}`, kind: 'mcp-operation-binding', projectId,
    }));
    await seedRecords('metadata', [...bindings, { id: 'unrelated', kind: 'other', projectId: 'p1' }]);
    const valueCursor = vi.spyOn(FakeIDBIndex.prototype, 'openCursor');
    const keyCursor = vi.spyOn(FakeIDBIndex.prototype, 'openKeyCursor');
    const storeCursor = vi.spyOn(FakeIDBObjectStore.prototype, 'openCursor');

    await svc.deleteProjectFromDb('p1');

    expect(valueCursor).not.toHaveBeenCalled();
    expect(keyCursor.mock.contexts.map((index) => (index as IDBIndex).objectStore.name))
      .toEqual(['chatConversations', 'agentTasks', 'projectMemories', 'history', 'projectVisualDescriptions']);
    // 孤儿消息归属和 MCP binding 类型/项目仍需读取正文，不能改成仅按会话键删除。
    expect(storeCursor.mock.contexts.map((store) => (store as IDBObjectStore).name).sort()).toEqual(['chatMessages', 'metadata']);
    valueCursor.mockRestore();
    keyCursor.mockRestore();
    storeCursor.mockRestore();
    expect(await svc.getProjectById('p1')).toBeUndefined();
    expect(await svc.getProjectConversations('p1')).toEqual([]);
    expect((await svc.getConversationMessages('c-p1', 0, 20)).messages).toEqual([]);
    expect(await svc.getProjectAgentTasks('p1')).toEqual([]);
    expect(await svc.getProjectMemories('p1')).toEqual([]);
    expect(await svc.getHistoryEntryCount('p1')).toBe(0);
    expect(await svc.getProjectVisualDescription('p1', 'fingerprint')).toBeUndefined();
    expect(await readRecord('metadata', 'binding-p1')).toBeUndefined();

    expect(await svc.getProjectById('p2')).toBeDefined();
    expect(await svc.getProjectConversations('p2')).toHaveLength(1);
    expect((await svc.getConversationMessages('c-p2', 0, 20)).messages).toHaveLength(1);
    expect(await svc.getProjectAgentTasks('p2')).toHaveLength(1);
    expect(await svc.getProjectMemories('p2')).toHaveLength(1);
    expect(await svc.getHistoryEntryCount('p2')).toBe(1);
    expect(await svc.getProjectVisualDescription('p2', 'fingerprint')).toBeDefined();
    expect((await svc.getConversationMessages('missing')).messages.map((message) => message.id)).toEqual(['orphan-p2']);
    expect(await readRecord('metadata', 'binding-p2')).toEqual(bindings[1]);
    expect(await readRecord('metadata', 'unrelated')).toEqual({ id: 'unrelated', kind: 'other', projectId: 'p1' });
  });

  it.each(['project', 'memories'] as const)('rolls back aborted %s deletion including earlier project and binding changes', async (mode) => {
    const svc = await import('../../src/services/indexedDbService');
    await svc.saveProjectToDb({ id: 'p1', name: 'Project', createdAt: 1, updatedAt: 1, nodes: [], edges: [] });
    await svc.putProjectMemory(projectMemory('m1'));
    await svc.putProjectMemory(projectMemory('m2'));
    const binding = { id: 'binding', kind: 'mcp-operation-binding', projectId: 'p1' };
    await seedRecords('metadata', [binding]);
    const remove = FakeIDBObjectStore.prototype.delete;
    let scheduled = false;
    const deletion = vi.spyOn(FakeIDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = remove.call(this, key);
      if (this.name === 'projectMemories' && !scheduled) {
        scheduled = true;
        request.addEventListener('success', () => queueMicrotask(() => request.transaction?.abort()), { once: true });
      }
      return request;
    });
    await expect(mode === 'project' ? svc.deleteProjectFromDb('p1') : svc.deleteProjectMemories('p1'))
      .rejects.toBeInstanceOf(Error);
    deletion.mockRestore();
    expect(await svc.getProjectById('p1')).toBeDefined();
    expect((await svc.getProjectMemories('p1')).map((memory) => memory.id)).toEqual(['m1', 'm2']);
    expect(await readRecord('metadata', 'binding')).toEqual(binding);
    expect(await readRecord('metadata', 'project-deleted:p1')).toBeUndefined();
  });

  it('deletes project memories using keys while keeping another project memories', async () => {
    const svc = await import('../../src/services/indexedDbService');
    await svc.putProjectMemory(projectMemory('m1'));
    await svc.putProjectMemory(projectMemory('m2', 'p2'));
    const valueCursor = vi.spyOn(FakeIDBIndex.prototype, 'openCursor');
    const keyCursor = vi.spyOn(FakeIDBIndex.prototype, 'openKeyCursor');
    await svc.deleteProjectMemories('p1');
    expect(valueCursor).not.toHaveBeenCalled();
    expect(keyCursor).toHaveBeenCalledTimes(1);
    expect(await svc.getProjectMemories('p1')).toEqual([]);
    expect((await svc.getProjectMemories('p2')).map((memory) => memory.id)).toEqual(['m2']);
  });
});
