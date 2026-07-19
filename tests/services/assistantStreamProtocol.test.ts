import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamAssistantReply } from '../../src/services/ai/assistantStream';
import { useAppStore } from '../../src/store/useAppStore';
import type { ModelExecutionProfile } from '../../src/types/aiTypes';

const configureAssistant = (executionProfile: ModelExecutionProfile) => {
  useAppStore.setState((state) => ({
    config: {
      ...state.config,
      assistantModelId: 'assistant-model',
      generalModels: [{
        id: 'assistant-model',
        name: '自定义助手',
        openaiUrl: 'https://gateway.example/v1',
        anthropicUrl: '',
        modelId: 'vendor-chat',
        apiKey: 'secret',
        category: 'text',
        executionProfile,
      }],
    },
  }));
};

beforeEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('assistant custom protocol boundary', () => {
  it('uses an explicitly OpenAI SSE compatible custom endpoint', async () => {
    configureAssistant({
      preset: 'custom',
      protocol: {
        version: 1,
        mode: 'sync',
        streamFormat: 'openai-sse',
        submit: {
          method: 'POST',
          path: '/chat/',
          body: {
            model: '{{model}}',
            messages: '{{messages}}',
            stream: '{{stream}}',
            tools: '{{tools}}',
            tool_choice: '{{toolChoice}}',
          },
        },
        resultTextPath: 'choices.0.message.content',
      },
    } as unknown as ModelExecutionProfile);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await streamAssistantReply({
      systemPrompt: '系统',
      userMessage: '你好',
      nonStream: true,
      onEvent: vi.fn(),
    });

    expect(result).toBe('完成');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/chat/');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'vendor-chat',
      messages: [
        { role: 'system', content: '系统' },
        { role: 'user', content: '你好' },
      ],
      stream: false,
    });
  });

  it('rejects a custom text protocol that does not declare OpenAI SSE compatibility', async () => {
    configureAssistant({
      preset: 'custom',
      protocol: {
        version: 1,
        mode: 'sync',
        submit: { method: 'POST', path: '/respond', body: { prompt: '{{prompt}}' } },
        resultTextPath: 'answer',
      },
    } as unknown as ModelExecutionProfile);

    await expect(streamAssistantReply({
      systemPrompt: '',
      userMessage: '你好',
      nonStream: true,
      onEvent: vi.fn(),
    })).rejects.toThrow('OpenAI SSE');
  });
});
