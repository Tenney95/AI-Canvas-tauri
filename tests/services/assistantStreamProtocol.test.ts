import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveAssistantModel,
  streamAssistantReply,
} from '../../src/services/ai/assistantStream';
import { runAssistantPipeline } from '../../src/services/chat/assistantService';
import { useAppStore } from '../../src/store/useAppStore';
import type { ModelExecutionProfile } from '../../src/types/aiTypes';

const configureAssistant = (executionProfile: ModelExecutionProfile) => {
  useAppStore.setState((state) => ({
    config: {
      ...state.config,
      assistantModelId: 'assistant-model',
      providers: {
        ...state.config.providers,
        'custom-assistant': {
          name: '自定义助手连接',
          apiKey: 'secret',
          baseUrl: 'https://gateway.example/v1',
          catalogId: 'custom-openai',
        },
      },
      generalModels: [{
        id: 'assistant-model',
        name: '自定义助手',
        modelId: 'vendor-chat',
        category: 'text',
        providerConfigId: 'custom-assistant',
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
  it('resolves a configured built-in provider text model selected by model value', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        assistantModelId: 'apimart/gpt-5.4',
        providers: {
          ...state.config.providers,
          apimart: {
            name: 'APIMart',
            apiKey: 'secret',
            catalogId: 'apimart',
            selectedModels: [{
              id: 'gpt-5.4',
              name: 'GPT-5.4',
              category: 'text',
              provider: 'apimart',
            }],
          },
        },
      },
    }));

    expect(resolveAssistantModel()).toMatchObject({
      baseUrl: 'https://api.apib.ai/v1',
      apiKey: 'secret',
      modelName: 'gpt-5.4',
      protocol: { streamFormat: 'openai-sse' },
    });
  });

  it('returns an explicit model-selection message instead of generic canvas help', async () => {
    const result = await runAssistantPipeline('帮我分析这个接口文档', 'conversation-1');

    expect(result.reply).toContain('未选择可用的对话文本模型');
    expect(result.reply).not.toContain('当前画布共有');
  });

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

  it('uses the current provider credential after key rotation', () => {
    configureAssistant({ preset: 'openai-chat' });
    useAppStore.getState().setProviderKey('custom-assistant', 'rotated-secret');

    expect(resolveAssistantModel()).toMatchObject({
      apiKey: 'rotated-secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'vendor-chat',
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
