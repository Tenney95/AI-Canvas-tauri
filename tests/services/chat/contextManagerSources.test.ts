import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../src/types/chat';
import {
  estimateConversationUsage,
  messageContentWithSources,
} from '../../../src/services/chat/contextManager';

const sourceMessage: Pick<ChatMessage, 'content' | 'sources'> = {
  content: '结论见 [S1]。',
  sources: [{
    id: 'source-1',
    citationId: 'S1',
    title: 'Example documentation',
    url: 'https://example.com/docs',
    domain: 'example.com',
    snippet: '不应跨轮注入的搜索摘要',
    fetchedAt: 1,
    sourceType: 'search',
  }],
};

describe('context source metadata', () => {
  it('injects citation metadata without snippets or page content', () => {
    const content = messageContentWithSources(sourceMessage);

    expect(content).toContain('[S1] Example documentation');
    expect(content).toContain('https://example.com/docs');
    expect(content).not.toContain('不应跨轮注入的搜索摘要');
  });

  it('includes citation metadata in conversation usage estimates', () => {
    const base = estimateConversationUsage([{
      role: 'assistant',
      content: sourceMessage.content,
      status: 'done',
      timestamp: 1,
    }], undefined, null);
    const withSources = estimateConversationUsage([{
      role: 'assistant',
      content: sourceMessage.content,
      sources: sourceMessage.sources,
      status: 'done',
      timestamp: 1,
    }], undefined, null);

    expect(withSources.estimatedTokens).toBeGreaterThan(base.estimatedTokens);
  });
});
