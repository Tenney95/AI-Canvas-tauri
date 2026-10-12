import { describe, expect, it } from 'vitest';
import { parseStream, parseNonStream } from '../../src/services/ai/streamParsers';
import type { AssistantStreamEvent } from '../../src/types/chat';
import type { ChatApiProtocol } from '../../src/types';

describe('provider reasoning stays outside the answer', () => {
  const samples: Array<{ protocol: ChatApiProtocol; chunks: unknown[]; body: unknown }> = [
    { protocol: 'openai-compatible', chunks: [
      { choices: [{ delta: { reasoning_content: 'inspect' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ], body: { choices: [{ message: { content: 'answer', reasoning_content: 'inspect' } }] } },
    { protocol: 'anthropic-compatible', chunks: [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'inspect' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
      { type: 'message_stop' },
    ], body: { content: [{ type: 'thinking', thinking: 'inspect' }, { type: 'text', text: 'answer' }] } },
    { protocol: 'gemini-native', chunks: [
      { candidates: [{ content: { parts: [{ text: 'inspect', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }] },
    ], body: { candidates: [{ content: { parts: [{ text: 'inspect', thought: true }, { text: 'answer' }] } }] } },
  ];
  for (const sample of samples) {
    it(`splits ${sample.protocol} streaming and JSON responses`, async () => {
      for (const streaming of [true, false]) {
        const events: AssistantStreamEvent[] = [];
        const body = streaming ? sample.chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') : JSON.stringify(sample.body);
        const response = new Response(body);
        const onEvent = (event: AssistantStreamEvent) => events.push(event);
        const text = streaming
          ? await parseStream(response, { protocol: sample.protocol, requestId: 'r', modelId: 'm', onEvent })
          : await parseNonStream(response, { protocol: sample.protocol, onEvent });
        expect(text).toBe('answer');
        expect(events.filter((event) => event.type === 'text.delta').map((event) => event.delta).join('')).toBe('answer');
        expect(events.filter((event) => event.type === 'reasoning.delta').map((event) => event.delta).join('')).toBe('inspect');
      }
    });
  }
});
