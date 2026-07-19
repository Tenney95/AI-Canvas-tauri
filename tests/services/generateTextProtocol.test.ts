import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from '../../src/services/ai/generateText';
import { useAppStore } from '../../src/store/useAppStore';
import type { ModelExecutionProfile } from '../../src/types/aiTypes';

const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('custom text model protocol', () => {
  it('uses the configured endpoint, request body and text result path', async () => {
    const executionProfile = {
      preset: 'custom',
      protocol: {
        version: 1,
        mode: 'sync',
        auth: { type: 'header', name: 'X-API-Key' },
        submit: {
          method: 'POST',
          path: '/v1/chat/',
          body: {
            model_name: '{{model}}',
            input: '{{prompt}}',
            messages: '{{messages}}',
          },
        },
        resultTextPath: 'result.answer',
      },
    } as unknown as ModelExecutionProfile;
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        generalModels: [{
          id: 'custom-text',
          name: '自定义文本',
          openaiUrl: 'https://gateway.example',
          anthropicUrl: '',
          modelId: 'vendor-chat',
          apiKey: 'secret',
          category: 'text',
          executionProfile,
        }],
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ result: { answer: '自定义结果' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateText({
      provider: 'general',
      model: 'general/custom-text',
      prompt: '你好',
    });

    expect(result).toBe('自定义结果');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/chat/');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-API-Key': 'secret' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model_name: 'vendor-chat',
      input: '你好',
    });
  });
});
