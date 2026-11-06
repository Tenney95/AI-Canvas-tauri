import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation } from '../../../src/types/chat';
const fixture = vi.hoisted(() => ({ conversations: [] as ChatConversation[] }));
vi.mock('../../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({
  conversations: fixture.conversations, currentProjectId: 'project', projects: [{ id: 'project' }],
}) } }));

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  vi.resetModules(); fixture.conversations = [];
});

async function seed(workbenchTarget?: ChatConversation['workbenchTarget']) {
  const db = await import('../../../src/services/indexedDbService');
  const source: ChatConversation = { id: 'conv-source', projectId: 'project', title: '来源', titleSource: 'user',
    pinned: false, archived: false, agentMode: 'collaborative', mcpServerIds: ['external'], workbenchTarget, createdAt: 1, updatedAt: 1, messageCount: 3 };
  fixture.conversations.push(source); await db.putChatConversation(source);
  for (const [id, role, content] of [['first', 'user', '开始 @image{chat-ref-x.png|图}'], ['boundary', 'assistant', '已完成'], ['future', 'user', '不应进入分支']] as const) {
    await db.putChatMessageWithSequence({ id, role, content, projectId: 'project', conversationId: source.id,
      sequence: 0, status: 'done', createdAt: 1, updatedAt: 1 });
  }
  return db;
}

describe('完成轮次的原子会话分支', () => {
  it('工作台会话分支继续保留原分集只读绑定', async () => {
    const target = { seriesId: 'project', episodeId: 'episode' };
    await seed(target);
    const service = await import('../../../src/services/chat/conversationBranchService');
    const branch = await service.createConversationBranch({ projectId: 'project', conversationId: 'conv-source', messageId: 'boundary' });
    expect(branch.conversation.workbenchTarget).toEqual(target);
  });

  it('只复制切点内资料，分配新ID并去掉执行和外部授权', async () => {
    const db = await seed();
    const service = await import('../../../src/services/chat/conversationBranchService');
    const branch = await service.createConversationBranch({ projectId: 'project', conversationId: 'conv-source', messageId: 'boundary' });
    expect(branch.messages.map((message) => message.content)).toEqual(['开始 [历史参考图，需重新上传]', '已完成']);
    expect(branch.messages.every((message) => !['first', 'boundary'].includes(message.id) && !message.agentTaskId)).toBe(true);
    expect(branch.conversation.mcpServerIds).toEqual([]);
    expect(branch.conversation.branchSource?.sequence).toBe(1);
    expect((await db.getProjectConversations('project')).map((item) => item.id)).toContain(branch.conversation.id);
    expect((await db.getConversationMessages('conv-source')).length).toBe(3);
  });

  it('拒绝用户消息切点，事务不留下半个新会话', async () => {
    const db = await seed(); const service = await import('../../../src/services/chat/conversationBranchService');
    await expect(service.createConversationBranch({ projectId: 'project', conversationId: 'conv-source', messageId: 'first' })).rejects.toThrow('已完成');
    expect(await db.getProjectConversations('project')).toHaveLength(1);
  });
});
