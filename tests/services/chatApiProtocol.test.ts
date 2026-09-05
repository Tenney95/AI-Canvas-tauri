import { describe, expect, it } from 'vitest';
import {
  buildChatApiRequest,
  parseChatApiResponse,
  resolveChatApiProtocol,
} from '../../src/services/ai/chatApiProtocol';

const tools = [{
  type: 'function' as const,
  function: {
    name: 'canvas_query',
    description: '读取画布',
    parameters: { type: 'object', properties: {} },
  },
}];

describe('chat API protocol adapter', () => {
  it('keeps old connections on OpenAI-compatible requests', () => {
    expect(resolveChatApiProtocol(undefined)).toBe('openai-compatible');
    const request = buildChatApiRequest({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1/',
      model: 'vendor-chat',
      messages: [{ role: 'user', content: '你好' }],
      tools,
      stream: true,
    });

    expect(request.url).toBe('https://gateway.example/v1/chat/completions');
    expect(request.init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
    });
    expect(JSON.parse(String(request.init.body))).toEqual({
      model: 'vendor-chat',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
      tools,
      tool_choice: 'auto',
    });
  });

  it('maps messages, vision and tools to Anthropic Messages', () => {
    const request = buildChatApiRequest({
      protocol: 'anthropic-compatible',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      model: 'claude-sonnet',
      messages: [
        { role: 'system', content: '系统规则' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } },
          ],
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'canvas_query', arguments: '{"detail":true}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"nodes":2}' },
      ],
      tools,
      stream: true,
    });

    expect(request.url).toBe('https://gateway.example/v1/messages');
    expect(request.init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
    });
    const body = JSON.parse(String(request.init.body));
    expect(body).toMatchObject({
      model: 'claude-sonnet',
      max_tokens: 4096,
      system: '系统规则',
      stream: true,
      tools: [{ name: 'canvas_query', input_schema: tools[0].function.parameters }],
    });
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJDRA==' } },
      ],
    });
    expect(body.messages[1].content[0]).toEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'canvas_query',
      input: { detail: true },
    });
    expect(body.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call-1',
    });
  });

  it('maps messages, vision and tools to Gemini generateContent', () => {
    const request = buildChatApiRequest({
      protocol: 'gemini-native',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1beta',
      model: 'models/gemini-2.5-pro',
      messages: [
        { role: 'system', content: '系统规则' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJDRA==' } },
          ],
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'canvas_query', arguments: '{"detail":true}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"nodes":2}' },
      ],
      tools,
      stream: true,
    });

    expect(request.url).toBe(
      'https://gateway.example/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(request.init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'secret',
    });
    const body = JSON.parse(String(request.init.body));
    expect(body.systemInstruction).toEqual({ parts: [{ text: '系统规则' }] });
    expect(body.contents[0]).toEqual({
      role: 'user',
      parts: [
        { text: '看图' },
        { inlineData: { mimeType: 'image/jpeg', data: 'QUJDRA==' } },
      ],
    });
    expect(body.contents[1].parts[0].functionCall).toEqual({
      id: 'call-1',
      name: 'canvas_query',
      args: { detail: true },
    });
    expect(body.contents[2].parts[0].functionResponse).toEqual({
      id: 'call-1',
      name: 'canvas_query',
      response: { nodes: 2 },
    });
    expect(body.tools[0].functionDeclarations[0].name).toBe('canvas_query');
  });

  it('normalizes non-stream responses and tool calls', () => {
    expect(parseChatApiResponse({
      content: [
        { type: 'text', text: '完成' },
        { type: 'tool_use', id: 'call-a', name: 'canvas_query', input: { detail: true } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 7 },
    }, 'anthropic-compatible')).toEqual({
      text: '完成',
      toolCalls: [{ callId: 'call-a', toolId: 'canvas_query', input: { detail: true } }],
      inputTokens: 11,
      outputTokens: 7,
      finishReason: 'stop',
    });

    expect(parseChatApiResponse({
      candidates: [{
        content: { parts: [{ text: '完成' }, { functionCall: { id: 'call-g', name: 'canvas_query', args: {} } }] },
        finishReason: 'MAX_TOKENS',
      }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5 },
    }, 'gemini-native')).toEqual({
      text: '完成',
      toolCalls: [{ callId: 'call-g', toolId: 'canvas_query', input: {} }],
      inputTokens: 9,
      outputTokens: 5,
      finishReason: 'length',
    });
  });
});
