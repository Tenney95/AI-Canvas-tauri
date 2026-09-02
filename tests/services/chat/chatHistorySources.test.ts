import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../../src/types/chat';

const { persistMediaUrlToProjectData } = vi.hoisted(() => ({
  persistMediaUrlToProjectData: vi.fn(async () => ({
    filePath: '/project/data/chat-image.png',
    assetUrl: 'asset:///project/data/chat-image.png',
    mediaUrl: 'asset:///project/data/chat-image.png',
    sourceUrl: 'asset:///project/data/chat-image.png',
  })),
}));

vi.mock('../../../src/services/fileService', () => ({
  isTransientMediaUrl: (url?: string) => Boolean(url && (/^data:/i.test(url) || /^blob:/i.test(url))),
  persistMediaUrlToProjectData,
}));
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

  it('migrates inline media before persisting a chat message', async () => {
    const conversationId = `media-${Date.now()}-${Math.random()}`;
    const inline = 'data:image/png;base64,AQID';
    const message: ChatMessage = {
      id: `${conversationId}-message`,
      conversationId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'done',
      mediaResult: {
        id: 'artifact-1',
        kind: 'image',
        deliveryMode: 'chat',
        url: inline,
        sourceUrl: inline,
        persistence: 'failed',
        prompt: '一只猫',
        modelId: 'custom-image',
        provider: 'general',
        createdAt: Date.now(),
      },
    };

    try {
      await persistMessage(message, 'project-1', conversationId);
      const loaded = await loadMessages(conversationId);

      expect(loaded.messages[0].mediaResult).toMatchObject({
        url: 'asset:///project/data/chat-image.png',
        sourceUrl: 'asset:///project/data/chat-image.png',
        filePath: '/project/data/chat-image.png',
        persistence: 'saved',
      });
      expect(JSON.stringify(loaded.messages[0])).not.toContain('data:image');
    } finally {
      await clearConversationMessages(conversationId);
    }
  });
});
