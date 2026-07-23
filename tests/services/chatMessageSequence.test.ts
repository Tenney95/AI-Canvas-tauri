import { IDBFactory } from 'fake-indexeddb';
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
    }

    await svc.deleteProjectFromDb('p1');

    expect(await svc.getProjectById('p1')).toBeUndefined();
    expect(await svc.getProjectConversations('p1')).toEqual([]);
    expect((await svc.getConversationMessages('c-p1', 0, 20)).messages).toEqual([]);
    expect(await svc.getProjectAgentTasks('p1')).toEqual([]);
    expect(await svc.getProjectMemories('p1')).toEqual([]);

    expect(await svc.getProjectById('p2')).toBeDefined();
    expect(await svc.getProjectConversations('p2')).toHaveLength(1);
    expect((await svc.getConversationMessages('c-p2', 0, 20)).messages).toHaveLength(1);
    expect(await svc.getProjectAgentTasks('p2')).toHaveLength(1);
    expect(await svc.getProjectMemories('p2')).toHaveLength(1);
  });
});
