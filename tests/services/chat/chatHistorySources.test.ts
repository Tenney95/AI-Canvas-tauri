import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../src/types/chat';
import {
  clearConversationMessages,
  loadMessages,
  persistMessage,
} from '../../../src/services/chat/chatHistoryService';

describe('chat history web sources', () => {
  it('persists citation metadata without the extracted page body', async () => {
    const conversationId = `sources-${Date.now()}-${Math.random()}`;
    const message: ChatMessage = {
      id: `${conversationId}-message`,
      conversationId,
      role: 'assistant',
      content: '根据文档可得 [S1]。',
      timestamp: Date.now(),
      status: 'done',
      sources: [{
        id: 'page-1',
        citationId: 'S1',
        title: 'Public documentation',
        url: 'https://example.com/docs',
        domain: 'example.com',
        fetchedAt: 10,
        sourceType: 'page',
      }],
    };

    try {
      await persistMessage(message, 'project-1', conversationId);
      const loaded = await loadMessages(conversationId);

      expect(loaded.messages).toEqual([message]);
      expect(JSON.stringify(loaded.messages)).not.toContain('UNTRUSTED_PAGE_BODY');
    } finally {
      await clearConversationMessages(conversationId);
    }
  });
});
