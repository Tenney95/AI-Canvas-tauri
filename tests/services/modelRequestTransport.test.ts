import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
}));

vi.mock('../../src/services/ai/httpTransport', () => transportMocks);

import { streamAssistantReply } from '../../src/services/ai/assistantStream';
import { generateImagesBatch } from '../../src/services/ai/generateImage';
import { generateText } from '../../src/services/ai/generateText';
import { reversePromptAndTags } from '../../src/services/ai/reversePrompt';
import { generateVideo } from '../../src/services/ai/generateVideo';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import VideoParamSelector from '../../src/components/nodes/shared/VideoParamSelector';
import { parseResponseError } from '../../src/services/ai/httpUtils';
import { resolveImageDataUrlArray } from '../../src/services/ai/imageUtils';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { generateImageStandard } from '../../src/services/ai/providers/standardImage';
import { analyzeModelProtocolExamples } from '../../src/services/ai/modelProtocolImport';
import { useAppStore } from '../../src/store/useAppStore';
import { createImageQuickAdaptTemplate } from '../../src/services/ai/imageModelTemplates';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  transportMocks.corsSafeFetch.mockReset();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('image quick template request transport', () => {
  function configureTemplate(templateId: string) {
    useAppStore.getState().saveProviderConfig('custom-template', {
      name: 'Custom images', catalogId: 'custom-openai', apiKey: 'template-fixture', baseUrl: 'https://images.example/v1',
      selectedModels: [{ id: 'actual-model-id', name: 'User model name', category: 'image', provider: 'custom-template',
        ...createImageQuickAdaptTemplate(templateId) }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-template')!;
    return { provider: 'general', model: `general/${model.id}`, prompt: 'Edit the reference images' };
  }

  it.each([
    { id: 'banana-pro:google', path: '/v1/models/actual-model-id:generateContent', auth: { 'x-goog-api-key': 'template-fixture' }, field: 'responseFormat' },
    { id: 'banana-pro:gemini-relay', path: '/v1beta/models/actual-model-id:generateContent', auth: { Authorization: 'Bearer template-fixture' }, field: 'imageConfig' },
  ])('sends every prepared reference in the selected $id native contract', async ({ id, path, auth, field }) => {
    const params = configureTemplate(id);
    const references = ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==', 'data:image/png;base64,Yw=='];
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { parts: [
      { text: 'Description' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ] } }] }));
    const result = await generateImagesBatch({ ...params, image_urls: references, imageSize: '2K', aspectRatio: '16:9' }, 1);
    expect(result.results[0].url).toBe('data:image/png;base64,aW1hZ2U=');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(`https://images.example${path}`);
    expect(init.headers).toMatchObject(auth);
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts[0].text).toContain(params.prompt);
    expect(body.contents[0].parts[0].text).toContain('3 张参考图');
    expect(body.contents[0].parts[0].text).toContain('16:9');
    expect(body.contents[0].parts).toEqual([{ text: expect.any(String) }, ...references.map((reference) => ({
      inlineData: { mimeType: 'image/png', data: reference.split(',')[1] },
    }))]);
    expect(body.generationConfig[field]).toEqual(field === 'imageConfig'
      ? { aspectRatio: '16:9', imageSize: '2K' } : { image: { aspectRatio: '16:9', imageSize: '2K' } });
  });

  it('blocks references beyond the visible native transport budget before reading or submitting', async () => {
    const params = configureTemplate('banana-pro:google');
    await expect(generateImagesBatch({ ...params, image_urls: Array.from({ length: 7 }, (_, index) =>
      `https://cdn.example/reference-${index}.png`) }, 1)).rejects.toThrow('最多支持 6');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('replaces an older native reference mode when saving a URL-based gateway template', async () => {
    configureTemplate('banana-pro:google');
    const params = configureTemplate('gpt-2:images-json');
    expect(useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'custom-template')!
      .imageReferenceRequestMode).toBe('generation-json-image-urls');
    const references = Array.from({ length: 7 }, (_, index) => `https://cdn.example/reference-${index}.png`);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ ...params, image_urls: references }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body)).images).toEqual(references);
  });

  it.each(['gpt-2:openai', 'gpt-2.5:images-json'])('uses explicit 4K pixels and numeric counts for %s', async (id) => {
    const params = configureTemplate(id);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [
      { url: 'https://cdn.example/result-one.png' }, { url: 'https://cdn.example/result-two.png' },
    ] }));
    const result = await generateImagesBatch({ ...params, imageSize: '4K', aspectRatio: '16:9' }, 2);
    expect(result.results).toHaveLength(2);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://images.example/v1/images/generations');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'actual-model-id', size: '3840x2160', n: 2 });
    await expect(generateImagesBatch({ ...params, imageSize: '4K', aspectRatio: '8:1' }, 1)).rejects.toThrow('不支持比例');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('uses official multipart edits with the same selected pixel table', async () => {
    const params = configureTemplate('gpt-2:openai');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('reference', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    await generateImagesBatch({ ...params, image_urls: ['data:image/png;base64,YQ=='], imageSize: '1K', aspectRatio: '3:2' }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://images.example/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('size')).toBe('1536x1024');
    expect(init.body.getAll('image[]')).toHaveLength(1);
  });

  it('submits APIMart once, then queries the returned task with the connection key', async () => {
    const params = configureTemplate('gpt-2.5:apimart');
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'task-123', status: 'submitted' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'completed', progress: 100,
        result: { images: [{ url: ['https://cdn.example/result.png'] }] } } }));
    const result = await generateImagesBatch({ ...params, imageSize: '2k', aspectRatio: '3:2',
      image_urls: ['https://cdn.example/reference.png'] }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/result.png');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const [submitUrl, submit] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(submitUrl).toBe('https://images.example/v1/images/generations');
    const submitted = JSON.parse(String(submit.body));
    expect(submitted.prompt).toContain(params.prompt);
    expect(submitted.prompt).toContain('1 张参考图');
    expect(submitted.prompt).toContain('3:2');
    expect(submitted).toEqual({ model: 'actual-model-id', prompt: expect.any(String),
      size: '3:2', resolution: '2k', n: 1, image_urls: ['https://cdn.example/reference.png'] });
    const [pollUrl, poll] = transportMocks.corsSafeFetch.mock.calls[1];
    expect(pollUrl).toBe('https://images.example/v1/tasks/task-123');
    expect(poll.headers).toMatchObject({ Authorization: 'Bearer template-fixture' });
  });
});

describe('model request transport boundary', () => {
  it('uses custom image defaults and blocks unsupported tiers before submission', async () => {
    useAppStore.getState().saveProviderConfig('custom-image-parameters', {
      name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
      selectedModels: [{ id: 'image', name: 'Image', category: 'image', provider: 'custom-image-parameters',
        imageCapability: { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], defaultRatio: '1:1',
          supportsBatch: true, maxBatchCount: 2, supportsImageReference: false },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync', auth: { type: 'bearer' },
          submit: { method: 'POST', path: '/images/generations', body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: '{{n}}' } },
          response: { type: 'json', result: { urlPath: 'data.0.url' } } } },
      }],
    });
    const model = useAppStore.getState().config.generalModels![0];
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'cat' };
    for (const invalid of [{ imageSize: '4K' }, { aspectRatio: '16:9' }, { image_urls: ['https://cdn.example/ref.png'] }]) {
      await expect(generateImagesBatch({ ...params, ...invalid }, 1)).rejects.toThrow();
    }
    await expect(generateImagesBatch(params, 3)).rejects.toThrow('最多生成 2');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch(params, 1);
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body)).toMatchObject({ size: '1024x1024', n: 1 });
  });
  it.each([undefined, '   ', 'https://custom.example/v1/'])('reverses images and chats with the selected CCC group when its address is %s', async (baseUrl) => {
    for (const group of ['pro', 'discount']) useAppStore.getState().saveProviderConfig(`cccapi-${group}`, {
      name: 'CCC', catalogId: 'cccapi', cccGroup: group, apiKey: `${group}-fixture`, baseUrl,
      selectedModels: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', category: 'text', provider: `cccapi-${group}`,
        inputModalities: ['text', 'image'], executionProfile: { preset: 'openai-chat' } }],
    });
    const result = { prompt: '窗台上的橘猫', tags: ['橘猫', '窗台'] };
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
    const expectedUrl = `${baseUrl?.trim().replace(/\/+$/, '') || 'https://cccapi.cn/v1'}/chat/completions`;
    for (const model of useAppStore.getState().config.generalModels!) {
      await expect(reversePromptAndTags({ provider: 'general', model: `general/${model.id}`, imageUrls: ['data:image/png;base64,Y2F0'] })).resolves.toEqual(result);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      expect(url).toBe(expectedUrl);
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${useAppStore.getState().config.providers[model.providerConfigId].apiKey}` });
      expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: expect.arrayContaining([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,Y2F0' } },
      ]) }] });
      useAppStore.getState().updateConfig({ assistantModelId: model.id });
      await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', nonStream: true, onEvent: vi.fn() })).resolves.toBe(JSON.stringify(result));
      const [chatUrl, chatInit] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      expect(chatUrl).toBe(expectedUrl);
      expect(chatInit.headers).toMatchObject({ Authorization: `Bearer ${useAppStore.getState().config.providers[model.providerConfigId].apiKey}` });
    }
    useAppStore.getState().setProviderKey('cccapi-discount', '');
    transportMocks.corsSafeFetch.mockClear();
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'cccapi-discount')!;
    await expect(reversePromptAndTags({ provider: 'general', model: `general/${model.id}`, imageUrls: ['data:image/png;base64,Y2F0'] })).rejects.toThrow();
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('still rejects an unconfigured custom connection address instead of borrowing a built-in URL', async () => {
    useAppStore.getState().saveProviderConfig('custom-cccapi', { name: '自定义', catalogId: 'custom-openai', apiKey: 'fixture',
      selectedModels: [{ id: 'gpt-5.6-sol', name: 'GPT', category: 'text', provider: 'custom-cccapi' }],
    });
    const model = useAppStore.getState().config.generalModels![0];
    await expect(generateText({ provider: 'general', model: `general/${model.id}`, prompt: '你好' })).rejects.toThrow('未配置接口地址');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each(['text', 'image'] as const)('routes identical CCC %s model IDs through the selected group Key', async (category) => {
    const modelId = category === 'text' ? 'gpt-5' : 'gpt-image-2';
    for (const group of ['free', 'stable']) {
      useAppStore.getState().saveProviderConfig(`cccapi-${group}`, {
        name: 'CCC', catalogId: 'cccapi', cccGroup: group, apiKey: `${group}-fixture`, baseUrl: 'https://cccapi.cn/v1',
        selectedModels: [{ id: modelId, name: modelId, category, provider: `cccapi-${group}`,
          executionProfile: { preset: category === 'text' ? 'openai-chat' : 'openai-image' } }],
      });
    }
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse(category === 'text'
      ? { choices: [{ message: { content: '回复' }, finish_reason: 'stop' }] }
      : { data: [{ url: 'https://cdn.example/image.png' }] }));
    const models = useAppStore.getState().config.generalModels!;
    expect(new Set(models.map((model) => model.id)).size).toBe(2);
    for (const model of models) {
      const params = { provider: 'general', model: `general/${model.id}`, prompt: '测试' };
      if (category === 'text') await expect(generateText(params)).resolves.toBe('回复');
      else expect((await generateImagesBatch(params, 1)).results).toHaveLength(1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      const key = useAppStore.getState().config.providers[model.providerConfigId].apiKey;
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${key}` });
      expect(url).toBe(`https://cccapi.cn/v1/${category === 'text' ? 'chat/completions' : 'images/generations'}`);
      expect(JSON.parse(init.body).model).toBe(modelId);
    }
    useAppStore.getState().setProviderKey('cccapi-stable', '');
    transportMocks.corsSafeFetch.mockClear();
    const model = models.find((item) => item.providerConfigId === 'cccapi-stable')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: '测试' };
    if (category === 'text') await expect(generateText(params)).rejects.toThrow();
    else await expect(generateImagesBatch({ ...params, image_urls: ['https://cdn.example/reference.png'] }, 1)).rejects.toThrow('CCC API');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it('routes a GRSAI H3 selection from the video entry into its native asynchronous adapter', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'h3-task', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/h3.mp4' }] }));
    await expect(generateVideo({ provider: 'grsai', model: 'grsai/minimax-h3', prompt: '写实短片', seedanceResolution: '768p', seedanceRatio: '9:16', seedanceDuration: 12 }))
      .resolves.toEqual({ url: 'https://cdn.example/h3.mp4' });
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://grsai.dakka.com.cn/v1/api/generate', 'https://grsai.dakka.com.cn/v1/api/result?id=h3-task',
    ]);
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body)).toMatchObject({ aspectRatio: 'portrait', resolution: '768p', duration: 12, replyType: 'async' });
  });

  it('shows GRSAI H3 resolution and duration without unsupported audio toggle', () => {
    const html = renderToStaticMarkup(createElement(VideoParamSelector, { provider: 'grsai', selectedModel: 'grsai/minimax-h3', seedanceResolution: '1080p', seedanceDuration: 15 }));
    expect(html).toContain('1080p');
    expect(html).toContain('10s');
    expect(html).not.toContain('15s');
  });
  it.each(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.8-flash'])('uses GRSAI shared chat transport for %s', async (modelId) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '回复' }, finish_reason: 'stop' }] }));
    await expect(generateText({ provider: 'grsai', model: `grsai/${modelId}`, prompt: '你好' })).resolves.toBe('回复');
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/chat/completions');
    expect(JSON.parse(init.body)).toMatchObject({ model: modelId, stream: false });
  });

  it.each(['nano-banana-2.1', 'nano-banana-2-lite', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])('submits GRSAI %s through its native image contract', async (modelId) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/image.png' }] }));
    const result = await generateImagesBatch({ provider: 'grsai', model: `grsai/${modelId}`, prompt: '海报', imageSize: '4K', aspectRatio: '16:9' }, 1);
    expect(result.results).toHaveLength(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: modelId, replyType: 'json', images: [] });
    expect(body).not.toHaveProperty('resolution');
    if (modelId === 'nano-banana-2-lite') expect(body.imageSize).toBe('1K');
    else if (modelId === 'nano-banana-2.1') expect(body.imageSize).toBe('4K');
    else expect(body).toMatchObject({ aspectRatio: modelId === 'gpt-image-2.5' ? '16:9' : '3840x2160', quality: modelId === 'gpt-image-2.5' ? 'auto' : 'medium' });
  });
  it.each(['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-Flash', 'mI MiMo-V2.5',
    'Hy3', 'claude-sonnet-4-6', 'gemini-3.5-flash', 'grok-4.5'])('uses shared OpenAI chat requests for CCC %s in nodes and conversations', async (modelId) => {
    const catalogModel = getProviderDefinition('cccapi')!.models!.find((model) => model.id === modelId)!;
    useAppStore.setState((state) => ({ config: {
      ...state.config, assistantModelId: 'ccc-text',
      providers: { ...state.config.providers, cccapi: {
        name: 'CCC', apiKey: 'fixture-key', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
      } },
      generalModels: [{ id: 'ccc-text', name: modelId, modelId, category: 'text',
        providerConfigId: 'cccapi', executionProfile: catalogModel.executionProfile }],
    } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({
      choices: [{ message: { content: 'CCC 回复' }, finish_reason: 'stop' }],
    }));
    await expect(generateText({ provider: 'general', model: 'general/ccc-text', prompt: '你好' }))
      .resolves.toBe('CCC 回复');
    await expect(streamAssistantReply({ systemPrompt: '系统', userMessage: '你好',
      nonStream: true, onEvent: vi.fn(),
    })).resolves.toBe('CCC 回复');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of transportMocks.corsSafeFetch.mock.calls as [string, RequestInit][]) {
      expect(url).toBe('https://cccapi.cn/v1/chat/completions');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
      expect(JSON.parse(String(init.body))).toMatchObject({ model: modelId, stream: false,
        messages: expect.arrayContaining([{ role: 'user', content: '你好' }]),
      });
    }
    transportMocks.corsSafeFetch.mockClear();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"CCC 流式回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '系统', userMessage: '你好', onEvent }))
      .resolves.toBe('CCC 流式回复');
    expect(onEvent).toHaveBeenCalledWith({ type: 'text.delta', delta: 'CCC 流式回复' });
    const [streamUrl, streamInit] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(streamUrl).toBe('https://cccapi.cn/v1/chat/completions');
    expect(JSON.parse(String(streamInit.body))).toMatchObject({ model: modelId, stream: true });
  });

  it.each(['gemini-3-pro-image-preview', 'gemini-3-pro-image', 'gemini-3.1-flash-image',
    'gemini-2.5-flash-image', 'nano-banana2', 'nano-banana-pro'])('uses CCC native Gemini image requests and Base64 results for %s', async (modelId) => {
    const catalogModel = getProviderDefinition('cccapi')!.models!.find((model) => model.id === modelId)!;
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: {
        name: 'CCC', apiKey: 'fixture-key', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
      } },
      generalModels: [{ id: 'ccc-native-image', name: modelId, modelId, category: 'image',
        providerConfigId: 'cccapi', executionProfile: catalogModel.executionProfile }],
    } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ candidates: [{
      content: { parts: [{ text: '图片说明' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] },
    }] }));
    const params = { provider: 'general', model: 'general/ccc-native-image', prompt: '画一只猫',
      imageSize: '4K', aspectRatio: '16:9' };
    await expect(generateImagesBatch(params, 1))
      .resolves.toMatchObject({ results: [{ url: 'data:image/png;base64,aW1hZ2U=' }] });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://cccapi.cn/v1beta/models/${modelId}:generateContent`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
    expect(JSON.parse(String(init.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: '画一只猫' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: {
        aspectRatio: '16:9', ...(modelId === 'gemini-2.5-flash-image' ? {} : { imageSize: '4K' }),
      } },
    });

    // 未接入的参考图必须在提交前报错，不能悄悄丢图。
    transportMocks.corsSafeFetch.mockClear();
    await expect(generateImagesBatch({ ...params, image_urls: ['https://cdn.example/ref.png'] }, 1))
      .rejects.toThrow('参考图');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(generateImagesBatch(params, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();

    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ candidates: [{
      content: { parts: [{ text: '无法生成图片' }] },
    }] }));
    await expect(generateImagesBatch(params, 1)).rejects.toThrow('未找到配置的结果');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    transportMocks.corsSafeFetch.mockClear();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: '上游生图超时' },
    }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
    await expect(generateImagesBatch(params, 1)).rejects.toThrow('上游生图超时');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the gateway JSON preset when an older model still has a reference request mode', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, gateway: {
        name: '图片网关', apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1',
        catalogId: 'custom-openai',
      } },
      generalModels: [{ id: 'gateway-image', name: 'GPT Image 中转', modelId: 'gpt-image-2',
        category: 'image', providerConfigId: 'gateway',
        imageReferenceRequestMode: 'edits-multipart',
        executionProfile: { preset: 'gpt-image-gateway-json' },
      }],
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ provider: 'general', model: 'general/gateway-image',
      prompt: '按参考图创作', image_urls: ['https://cdn.example/reference.png'],
    }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/images/generations');
    expect(JSON.parse(String(init.body)).images).toEqual(['https://cdn.example/reference.png']);
  });
  it.each([
    { provider: 'grsai', referenceCount: 2 },
    { provider: 'saved-grsai', referenceCount: 3 },
    { provider: 'general', referenceCount: 3 },
  ])('sends GRSAI native references from local assets in order ($provider)', async ({ provider, referenceCount }) => {
    const connectionId = provider === 'general' ? 'saved-grsai' : provider;
    const legacyModel = {
      id: 'grsai-ref', name: 'Nano Banana 2', modelId: 'nano-banana-2', category: 'image' as const,
      providerConfigId: connectionId, imageReferenceRequestMode: 'edits-multipart' as const,
      executionProfile: { preset: 'openai-image' as const },
    };
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, [connectionId]: {
        name: 'GRSAI', catalogId: 'grsai', apiKey: 'secret', baseUrl: 'https://grsai.dakka.com.cn/v1',
        selectedModels: [{ id: 'nano-banana-2', name: 'Nano Banana 2', provider: 'grsai', category: 'image', imageReferenceRequestMode: 'edits-multipart' }],
      } },
      generalModels: [legacyModel],
    }, nodes: Array.from({ length: referenceCount }, (_, index) => ({
      id: `grs-ref-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `参考${index}`, imageUrl: `asset://localhost/grs-${index}.png`, sourceUrl: `https://expired.example/grs-${index}.png` },
    })) }));
    const savedConfig = structuredClone(useAppStore.getState().config);
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
      new Response(String(url), { headers: { 'Content-Type': 'image/png' } })
    ));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/grs-result.png' }] }));
    const result = await generateImagesBatch({
      provider, model: provider === 'general' ? 'general/grsai-ref' : `${provider}/nano-banana-2`,
      prompt: `${Array.from({ length: referenceCount }, (_, index) => `@{grs-ref-${index}:参考${index}}`).join('')} 合影`,
      imageSize: '2K', aspectRatio: '16:9',
    }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/grs-result.png');
    expect(localFetch).toHaveBeenCalledTimes(referenceCount);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['aspectRatio', 'imageSize', 'images', 'model', 'prompt', 'replyType']);
    expect(body).toMatchObject({ model: 'nano-banana-2', aspectRatio: '16:9', imageSize: '2K', replyType: 'json' });
    expect(body.images.map((dataUrl: string) => atob(dataUrl.split(',')[1]))).toEqual(
      Array.from({ length: referenceCount }, (_, index) => `asset://localhost/grs-${index}.png`),
    );
    expect(body.prompt).not.toContain('@{');
    expect(useAppStore.getState().config).toEqual(savedConfig);
  });

  it('uses the GRSAI default base URL and native GPT size fields for text-only requests', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } },
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/gpt.png' }] }));
    const result = await generateImagesBatch({ provider: 'grsai', model: 'grsai/gpt-image-2-vip', prompt: '海报', imageSize: '4K', aspectRatio: '16:9' }, 1);
    expect(result.results[0]).toEqual({ url: 'https://cdn.example/gpt.png', width: 3840, height: 2160 });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    expect(JSON.parse(init.body)).toEqual({ model: 'gpt-image-2-vip', prompt: '海报', images: [], aspectRatio: '3840x2160', quality: 'medium', replyType: 'json' });
  });

  it.each([
    { status: 400, payload: { error: 'reference image rejected' }, message: 'reference image rejected' },
    { status: 504, payload: { error: 'gateway timeout' }, message: '504' },
    { status: 200, payload: { status: 'failed', error: 'generation failed' }, message: 'generation failed' },
    { status: 200, payload: { status: 'violation', error: 'request rejected' }, message: 'request rejected' },
    { status: 200, payload: { status: 'running', id: 'unfinished-task' }, message: '不要重复提交' },
    { status: 200, payload: { status: 'succeeded', results: [] }, message: '未找到配置的结果' },
  ])('does not resubmit GRSAI on failed/unknown responses ($message)', async ({ status, payload, message }) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValue(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
    await expect(generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 3)).rejects.toThrow(message);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps GRSAI batch successes and stops submitting when a later item fails', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/first.png' }] }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: 'failed' }));
    const result = await generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 3);
    expect(result.results.map((item) => item.url)).toEqual(['https://cdn.example/first.png']);
    expect(result.failedCount).toBe(2);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('cancels GRSAI without starting a second batch request', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    const controller = new AbortController();
    transportMocks.corsSafeFetch.mockImplementation(async (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      return jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/late.png' }] });
    });
    await expect(generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 2, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated node references: A B B uploads two images, A B C uploads three', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: { name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1' } },
    }, nodes: ['a', 'b', 'c'].map((id) => ({
      id, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: id, imageUrl: `asset://localhost/${id}.png` },
    })) }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('png', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    for (const [prompt, count] of [['@{a:a}@{b:b}@{b:b}', 2], ['@{a:a}@{b:b}@{c:c}', 3]] as const) {
      await generateImagesBatch({ provider: 'cccapi', model: 'cccapi/gpt-image-2', prompt: `${prompt} 合影` }, 1);
      const body = transportMocks.corsSafeFetch.mock.calls.at(-1)![1].body as FormData;
      expect(body.getAll('image[]')).toHaveLength(count);
    }
  });

  it('includes actual model, reference count, transfer size and elapsed time on transport failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockRejectedValue(new Error('connection reset'));
    const error = await generateImageStandard({
      apiKey: 'secret', baseUrl: 'https://gateway.example/v1', modelName: 'gpt-image-2', prompt: 'private prompt',
      dimensions: { width: 1024, height: 1024 }, imageReferenceRequestMode: 'edits-multipart',
      imageUrls: ['asset://localhost/private.png'],
    }).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('connection reset');
    expect(message).toContain('模型 gpt-image-2；参考图 1 张，共 0.00 MiB；输出 1024x1024；等待');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('private');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('submits four CCC prompt references once in order and does not retry a gateway 504', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: { name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1' } },
      generalModels: [{ id: 'ccc-four', name: 'GPT Image 2', modelId: 'gpt-image-2', category: 'image', providerConfigId: 'cccapi' }],
    }, nodes: Array.from({ length: 4 }, (_, index) => ({
      id: `ref-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `参考${index}`, imageUrl: `asset://localhost/reference-${index}.png`, sourceUrl: `https://expired.example/${index}.png` },
    })) }));
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
      new Response(String(url), { headers: { 'Content-Type': 'image/png' } })
    ));
    transportMocks.corsSafeFetch.mockResolvedValue(new Response('<html><body>504 Gateway Time-out nginx</body></html>', {
      status: 504, headers: { 'Content-Type': 'text/html' },
    }));
    await expect(generateImagesBatch({
      provider: 'general', model: 'general/ccc-four',
      prompt: '@{ref-0:参考0}@{ref-1:参考1}@{ref-2:参考2}@{ref-3:参考3} 他们两个人一起合影',
    }, 1)).rejects.toThrow('网关等待上游响应超时');
    expect(localFetch).toHaveBeenCalledTimes(4);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/images/edits');
    const body = init.body as FormData;
    const files = body.getAll('image[]') as File[];
    expect(files).toHaveLength(4);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(
      Array.from({ length: 4 }, (_, index) => `asset://localhost/reference-${index}.png`),
    );
    expect(body.get('n')).toBe('1');
  });

  it.each(['cccapi', 'legacy-ccc', 'general'])('uses CCC catalog multipart before uploading references (%s)', async (provider) => {
    const connectionId = provider === 'general' ? 'legacy-ccc' : provider;
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, [connectionId]: {
        name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1',
        ...(provider === 'cccapi' ? {} : { catalogId: 'cccapi' }),
      } },
      generalModels: [{ id: 'old-image', name: 'GPT Image 2', modelId: 'gpt-image-2',
        category: 'image', providerConfigId: connectionId }],
    } }));
    const localUrl = 'asset://localhost/D%3A%2Fproject%2Freference.png';
    useAppStore.setState({ nodes: [{ id: 'ref', type: 'ai-image', position: { x: 0, y: 0 }, data: {
      label: 'reference', type: 'ai-image', imageUrl: localUrl, sourceUrl: 'https://expired.example/old.png',
    } }] });
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url !== localUrl) throw new Error('Unexpected upload');
      return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
    });
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    const params = { provider, model: provider === 'general' ? 'general/old-image' : `${provider}/gpt-image-2`, prompt: 'edit' };
    for (let attempt = 0; attempt < 2; attempt++) {
      await generateImagesBatch(attempt === 0 ? { ...params, image_urls: [localUrl] }
        : { ...params, prompt: '@{ref:reference} edit' }, 1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)! as [string, RequestInit];
      expect(url).toBe('https://cccapi.cn/v1/images/edits');
      expect((init.body as FormData).getAll('image[]')).toHaveLength(1);
    }
    expect(localFetch).toHaveBeenCalledTimes(2);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    await generateImagesBatch(params, 1);
    expect(transportMocks.corsSafeFetch.mock.calls.at(-1)![0]).toBe('https://cccapi.cn/v1/images/generations');
  });

  it.each([true, false])('respects a custom gateway JSON reference mode (explicit mode: %s)', async (explicitMode) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers, gateway: { name: 'gateway', apiKey: 'secret', baseUrl: 'https://gateway.example/v1', catalogId: 'custom-openai',
        selectedModels: explicitMode ? [{ id: 'gpt-image-2', name: 'image', provider: 'gateway', category: 'image', imageReferenceRequestMode: 'generation-json-image-urls' }] : [],
      },
    } } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ provider: 'gateway', model: 'gateway/gpt-image-2', prompt: 'edit', image_urls: ['https://cdn.example/ref.png'] }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/images/generations');
    expect(JSON.parse(init.body as string).image_urls).toEqual(['https://cdn.example/ref.png']);
  });

  it.each([
    { referenceCount: 2, legacyMode: 'generation-json-image-urls' as const, legacyPreset: 'custom' as const },
    { referenceCount: 3, legacyMode: 'generation-json-image-data-urls' as const, legacyPreset: 'openai-image' as const },
  ])('uses the CCC Sunburst standard contract despite legacy settings ($referenceCount references)', async ({ referenceCount, legacyMode, legacyPreset }) => {
    const modelId = 'gpt-image-2.5-sunburst';
    const legacyProfile = {
      preset: legacyPreset,
      protocol: {
        version: 2 as const,
        mode: 'sync' as const,
        submit: { method: 'POST' as const, path: '/images/generations', body: {
          model: '{{model}}', prompt: '{{prompt}}', image_urls: '{{imageUrls}}', resolution: '{{imageSize}}',
        } },
        response: { type: 'json' as const, result: { urlPath: 'data.*.url' } },
      },
    };
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, ccc: {
        name: 'CCC API', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
        selectedModels: [{ id: modelId, name: modelId, category: 'image', provider: 'cccapi',
          imageReferenceRequestMode: legacyMode, executionProfile: legacyProfile }],
      } },
      generalModels: [{ id: modelId, name: modelId, modelId, category: 'image', providerConfigId: 'ccc',
        imageReferenceRequestMode: legacyMode, executionProfile: legacyProfile }],
    }, nodes: Array.from({ length: referenceCount }, (_, index) => ({
      id: `person-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `人物${index + 1}`, imageUrl: `asset://localhost/person-${index}.png`,
        sourceUrl: `https://expired.example/person-${index}.png` },
    })) }));
    const savedConfig = useAppStore.getState().config;
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!String(url).startsWith('asset://localhost/person-')) throw new Error('Unexpected upload');
      return new Response(String(url), { headers: { 'Content-Type': 'image/png' } });
    });
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));

    const params = { provider: 'general', model: `general/${modelId}`, imageSize: '2K', aspectRatio: '16:9',
      prompt: Array.from({ length: referenceCount }, (_, index) => `@{person-${index}:人物${index + 1}}`).join('') + '一起合影' };
    await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({
      results: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/images/edits');
    const body = init.body as FormData;
    expect([...new Set(body.keys())].sort()).toEqual(['image[]', 'model', 'n', 'prompt', 'size']);
    expect(body.get('model')).toBe(modelId);
    expect(body.get('n')).toBe('1');
    expect(body.get('size')).toBe('3648x2048');
    expect(body.get('prompt')).toContain(`本次请求附带 ${referenceCount} 张参考图`);
    const files = body.getAll('image[]') as File[];
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(
      Array.from({ length: referenceCount }, (_, index) => `asset://localhost/person-${index}.png`),
    );
    expect(localFetch).toHaveBeenCalledTimes(referenceCount);

    await expect(generateImagesBatch({ ...params, prompt: '风景' }, 1)).resolves.toMatchObject({
      results: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
    const [generationUrl, generationInit] = transportMocks.corsSafeFetch.mock.calls[1] as [string, RequestInit];
    expect(generationUrl).toBe('https://cccapi.cn/v1/images/generations');
    expect(JSON.parse(generationInit.body as string)).toEqual({ model: modelId, prompt: '风景', n: 1, size: '3648x2048' });
    expect(useAppStore.getState().config).toBe(savedConfig);
    expect(savedConfig.generalModels?.[0].executionProfile).toEqual(legacyProfile);
  });

  it.each([
    { catalogId: 'custom-openai', modelId: 'gpt-image-2.5-sunburst' },
    { catalogId: 'cccapi', modelId: 'vendor-image' },
    { catalogId: 'custom-openai', modelId: 'nano-banana-2' },
    { catalogId: 'grsai', modelId: 'vendor-image' },
  ])('preserves the explicit protocol outside documented built-in image contracts ($catalogId/$modelId)', async ({ catalogId, modelId }) => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, custom: {
        name: '自定义接口', apiKey: 'secret', baseUrl: 'https://gateway.example/v1', catalogId,
      } },
      generalModels: [{ id: 'custom-image', name: modelId, modelId, category: 'image', providerConfigId: 'custom',
        executionProfile: { preset: 'custom', protocol: {
          version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/vendor/image-render', body: {
            model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}',
          } },
          response: { type: 'json', result: { urlPath: 'output.image' } },
        } },
      }],
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ output: { image: 'https://cdn.example/result.png' } }));
    await expect(generateImagesBatch({
      provider: 'general', model: 'general/custom-image', prompt: 'edit', image_urls: ['https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/result.png' }] });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/vendor/image-render');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: modelId, images: ['https://cdn.example/reference.png'] });
  });

  it.each([false, true])('submits the current ratio after editing an image node (drag duplicate: %s)', async (duplicate) => {
    const reference = 'data:image/png;base64,iVBORw==';
    useAppStore.setState((state) => ({
      config: { ...state.config,
        providers: { ...state.config.providers, ccc: {
          name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
        } },
        generalModels: [{ id: 'ccc-image', name: 'GPT Image 2', modelId: 'gpt-image-2',
          category: 'image', providerConfigId: 'ccc', imageReferenceRequestMode: 'edits-multipart',
        }],
      },
      nodes: [
        { id: 'reference', type: 'ai-image', position: { x: 0, y: 0 },
          data: { type: 'ai-image', label: '参考图', imageUrl: reference } },
        { id: 'image', type: 'ai-image', position: { x: 300, y: 0 },
          data: { type: 'ai-image', label: '生成图', model: 'general/ccc-image', provider: 'general',
            prompt: '@{reference:参考图} 新场景', imageSize: '2K', aspectRatio: '16:9',
            imageUrl: reference, imageWidth: 1024, imageHeight: 1024, nodeWidth: 280, nodeHeight: 280,
          } },
      ],
    }));
    if (duplicate) useAppStore.getState().duplicateNode('image');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } },
    ));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({
      data: [{ url: 'https://cdn.example/result.png' }],
    }));
    for (const [ratio, size, orientation] of [['16:9', '3648x2048', '横屏'], ['9:16', '2048x3648', '竖屏'], ['3:4', '2048x2736', '竖屏'], ['1:1', '2048x2048', '正方形']]) {
      useAppStore.getState().updateNodeData('image', { aspectRatio: ratio, prompt: '@{reference:参考图} 修改后的场景' });
      const data = useAppStore.getState().nodes.find((node) => node.id === 'image')!.data;
      await generateImagesBatch({ prompt: data.prompt!, model: data.model!, provider: data.provider!,
        imageSize: data.imageSize, aspectRatio: data.aspectRatio, nodeId: 'image',
      }, 1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)! as [string, RequestInit];
      expect(url).toBe('https://cccapi.cn/v1/images/edits');
      const body = init.body as FormData;
      expect(body.get('size')).toBe(size);
      expect(body.getAll('image[]')).toHaveLength(1);
      expect(body.get('prompt')).toContain(`${ratio}（${orientation}，宽:高）`);
      expect(body.get('prompt')).toContain('不继承参考图或旧图的宽高比');
      expect(body.get('prompt')).not.toContain('复制版式、构图与设计语言时以对应参考图为准');
    }
    await generateImagesBatch({ prompt: '@{reference:参考图} 修改后的场景',
      model: 'general/ccc-image', provider: 'general', aspectRatio: '自适应', nodeId: 'image',
    }, 1);
    const adaptive = transportMocks.corsSafeFetch.mock.calls.at(-1)![1].body as FormData;
    expect(adaptive.get('prompt')).not.toContain('【输出画幅】');
  });

  it.each([true, false])('preserves a custom multipart endpoint and response mapping (explicit mode: %s)', async (explicitMode) => {
    const imported = analyzeModelProtocolExamples({
      submitRequest: `curl https://gateway.example/v1/custom/images/edit
        -H 'Authorization: Bearer sk-placeholder'
        -F 'model=custom-image' -F 'prompt=edit'
        -F 'images=@/private/reference.png'`,
      submitResponse: '{"output":{"url":"https://cdn.example/custom-result.png"}}',
    });
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, custom: {
        name: '自定义接口', apiKey: 'secret', baseUrl: imported.baseUrl!, catalogId: 'custom-openai',
      } },
      generalModels: [{ id: 'custom-image', name: '自定义图片', modelId: 'custom-image',
        category: 'image', providerConfigId: 'custom',
        imageReferenceRequestMode: explicitMode ? 'edits-multipart' : undefined,
        executionProfile: { preset: 'custom', protocol: imported.protocol! },
      }],
    } }));
    const nativeFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected upload'));
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url === 'https://cdn.example/reference.png') return new Response(
        Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } },
      );
      if (url === 'https://gateway.example/v1/custom/images/edit') return jsonResponse({
        output: { url: 'https://cdn.example/custom-result.png' },
      });
      throw new Error('Unexpected endpoint');
    });
    const controller = new AbortController();
    const params = { provider: 'general', model: 'general/custom-image', prompt: 'edit',
      image_urls: ['data:image/jpeg;base64,aGVsbG8=', 'https://cdn.example/reference.png'] };
    await expect(generateImagesBatch(params, 1, controller.signal)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/custom-result.png' }],
    });
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const init = transportMocks.corsSafeFetch.mock.calls[1][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    const body = new TextDecoder().decode(init.body as ArrayBuffer);
    expect(body.split('name="images"; filename=')).toHaveLength(3);
    expect(body).toContain('Content-Type: image/jpeg');
    expect(body).toContain('Content-Type: image/png');
    controller.abort();
    await expect(generateImagesBatch(params, 1, controller.signal)).rejects.toThrow();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('reproduces the reference-field warning for a text-only custom protocol despite an edits mode setting', async () => {
    const imported = analyzeModelProtocolExamples({
      submitRequest: `curl https://gateway.example/v1/images/generations
        -H 'Content-Type: application/json'
        -d '{"model":"gpt-image-2","prompt":"draw"}'`,
      submitResponse: '{"data":[{"url":"https://cdn.example/result.png"}]}',
    });
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, wm: { name: 'WM', apiKey: 'secret', baseUrl: imported.baseUrl! } },
      generalModels: [{ id: 'wm-image', name: 'gpt-image-2', modelId: 'gpt-image-2', category: 'image',
        providerConfigId: 'wm', imageReferenceRequestMode: 'edits-multipart',
        executionProfile: { preset: 'custom', protocol: imported.protocol! },
      }],
    } }));
    await expect(generateImagesBatch({ provider: 'general', model: 'general/wm-image', prompt: 'edit',
      image_urls: ['https://cdn.example/ref.png'],
    }, 1)).rejects.toThrow('没有完整接收参考图');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('adds actionable guidance to ambiguous API Key errors', async () => {
    const response = new Response(JSON.stringify({
      error: { message: 'apikey error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    await expect(parseResponseError(response, '图片生成失败 (400)')).rejects.toThrow(
      'apikey error（请确认使用模型 API Key，而非账户令牌；若密钥正确，请检查账户权限和积分余额）',
    );
  });

  it('reads the top-level error string used by the new GRSAI generation API', async () => {
    const response = new Response(JSON.stringify({
      id: '',
      status: 'failed',
      error: 'insufficient credits',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    await expect(parseResponseError(response, '图片生成失败 (400)')).rejects.toThrow(
      'insufficient credits',
    );
  });

  it('routes ordinary text generation through the shared transport', async () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          apimart: { name: 'APIMart', apiKey: 'secret', baseUrl: 'https://gateway.example/v1' },
        },
      },
    }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '文本结果' } }],
    }));

    await expect(generateText({
      provider: 'apimart',
      model: 'apimart/vendor-chat',
      prompt: '你好',
    })).resolves.toBe('文本结果');

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('routes standard image generation through the shared transport', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/image.png' }],
    }));

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'gpt-image-1',
      prompt: '一张图片',
      dimensions: { width: 1024, height: 1024 },
      imageReferenceRequestMode: 'edits-multipart',
    })).resolves.toMatchObject({ url: 'https://cdn.example/image.png' });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps JSON image_urls generation for compatible reference-image providers', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/generated.png' }],
    }));

    await generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'gpt-image-2',
      prompt: '参考角色生成场景',
      dimensions: { width: 1536, height: 1024 },
      imageUrls: ['https://cdn.example/reference.png'],
      imageReferenceRequestMode: 'generation-json-image-urls',
    });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-image-2',
      image_urls: ['https://cdn.example/reference.png'],
    });
  });

  it('sends base64 reference arrays through the JSON image field', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/generated.png' }],
    }));
    const image = 'data:image/png;base64,iVBORw0KGgo=';

    await generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'custom-image-model',
      prompt: '参考角色生成场景',
      dimensions: { width: 1024, height: 1024 },
      imageUrls: [image],
      imageReferenceRequestMode: 'generation-json-image-data-urls',
    });

    const [, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'custom-image-model',
      image: [image],
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('image_urls');
  });

  it('converts remote reference images into base64 data URLs', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      Uint8Array.from([137, 80, 78, 71]),
      { status: 200, headers: { 'Content-Type': 'image/png' } },
    ));

    await expect(resolveImageDataUrlArray([
      'https://cdn.example/reference.png',
    ])).resolves.toEqual([
      'data:image/png;base64,iVBORw==',
    ]);
  });

  it('keeps data URL references in a configured async image protocol', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          rightapi: {
            name: 'RightAPI',
            apiKey: 'secret',
            baseUrl: 'https://www.right.codes/draw/v1',
          },
        },
        generalModels: [{
          id: 'rightapi-image',
          name: 'RightAPI 图片',
          modelId: 'nano-banana-fast',
          category: 'image',
          providerConfigId: 'rightapi',
          imageReferenceRequestMode: 'generation-json-image-data-urls',
          executionProfile: {
            preset: 'custom',
            protocol: {
              version: 2,
              mode: 'async',
              submit: {
                method: 'POST',
                path: '/images/generations',
                body: {
                  model: '{{model}}',
                  prompt: '{{prompt}}',
                  n: '{{n}}',
                  size: '{{aspectRatio}}',
                  imageSize: '{{imageSize}}',
                  async: true,
                  image: '{{imageUrls}}',
                },
              },
              response: { type: 'json', taskIdPath: 'task_id' },
              poll: {
                method: 'GET',
                path: '/v1/tasks/{{submit.task_id}}',
                pathMode: 'origin',
                response: {
                  statusPath: 'status',
                  successValues: ['completed'],
                  failureValues: ['failed'],
                  result: { urlPath: 'data.*.url' },
                  errorPath: 'error.message',
                  progressPath: 'progress',
                },
                intervalMs: 1000,
              },
            },
          },
        }],
      },
    }));
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-123', status: 'processing' }))
      .mockResolvedValueOnce(jsonResponse({
        task_id: 'task-123',
        status: 'completed',
        progress: 100,
        data: [{ url: 'https://cdn.example/result.png' }],
      }));

    await expect(generateImagesBatch({
      provider: 'general',
      model: 'general/rightapi-image',
      prompt: '改成赛博朋克风格',
      imageSize: '1K',
      aspectRatio: '16:9',
      image_urls: [image],
    }, 1)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/result.png' }],
    });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const [submitUrl, submitInit] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe('https://www.right.codes/draw/v1/images/generations');
    expect(JSON.parse(String(submitInit.body))).toMatchObject({
      model: 'nano-banana-fast',
      async: true,
      image: [image],
    });
    expect(transportMocks.corsSafeFetch.mock.calls[1]?.[0]).toBe(
      'https://www.right.codes/v1/tasks/task-123',
    );
  });

  it('explains when an image endpoint returns an HTML page instead of JSON', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      '<!doctype html><html><body>gateway homepage</body></html>',
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    ));

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://realmrouter.cn',
      modelName: 'gpt-image-1',
      prompt: '一张图片',
      dimensions: { width: 1024, height: 1024 },
    })).rejects.toThrow('图片接口返回了 HTML 页面，请检查连接地址是否指向 API 根路径（常见需要追加 /v1）');
  });

  it('uploads configured reference images as multipart files to image edits', async () => {
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://cdn.example/reference-')) {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return jsonResponse({ data: [{ url: 'https://cdn.example/edited.png' }] });
    });

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://realmrouter.cn/v1',
      modelName: 'gpt-image-2',
      prompt: '保持两个人物设定生成新场景',
      dimensions: { width: 1536, height: 1024 },
      imageUrls: [
        'https://cdn.example/reference-1.png',
        'https://cdn.example/reference-2.png',
      ],
      imageReferenceRequestMode: 'edits-multipart',
    })).resolves.toMatchObject({ url: 'https://cdn.example/edited.png' });

    const editsCall = transportMocks.corsSafeFetch.mock.calls.find(
      ([url]) => url === 'https://realmrouter.cn/v1/images/edits',
    ) as [string, RequestInit] | undefined;
    expect(editsCall).toBeDefined();
    const editsInit = editsCall?.[1];
    expect(editsInit?.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(editsInit?.body).toBeInstanceOf(FormData);
    const body = editsInit?.body as FormData;
    expect(body.get('model')).toBe('gpt-image-2');
    expect(body.get('prompt')).toBe('保持两个人物设定生成新场景');
    expect(body.get('size')).toBe('1536x1024');
    expect(body.getAll('image[]')).toHaveLength(2);
    expect(body.getAll('image')).toHaveLength(0);
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalledWith(
      'https://realmrouter.cn/v1/images/generations',
      expect.anything(),
    );
  });

  it.each([
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5',
    'gpt-image-2',
  ])('routes CCC API %s references through image edits while keeping text-only generations', async (modelId) => {
    const cccModel = (getProviderDefinition('cccapi')?.models ?? [])
      .find((item) => item.id === modelId);
    expect(cccModel?.imageReferenceRequestMode).toBe('edits-multipart');
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'cccapi-image': {
            name: 'CCC API 图片',
            apiKey: 'secret',
            baseUrl: 'https://cccapi.cn/v1',
            catalogId: 'cccapi',
          },
        },
        generalModels: [{
          id: `cccapi-${modelId}`,
          name: cccModel?.name ?? modelId,
          modelId: cccModel?.id ?? modelId,
          category: 'image',
          providerConfigId: 'cccapi-image',
          imageReferenceRequestMode: cccModel?.imageReferenceRequestMode,
        }],
      },
    }));
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url === 'https://cdn.example/reference.png') {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      if (url === 'https://cccapi.cn/v1/images/edits') {
        return jsonResponse({ data: [{ url: 'https://cdn.example/edited.png' }] });
      }
      return jsonResponse({ data: [{ url: 'https://cdn.example/generated.png' }] });
    });

    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '保持人物设定生成新场景',
      imageSize: '1K',
      aspectRatio: '1:1',
      image_urls: ['https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/edited.png' }] });

    const editsCall = transportMocks.corsSafeFetch.mock.calls.find(
      ([url]) => url === 'https://cccapi.cn/v1/images/edits',
    ) as [string, RequestInit] | undefined;
    expect(editsCall?.[1].body).toBeInstanceOf(FormData);
    expect((editsCall?.[1].body as FormData).getAll('image[]')).toHaveLength(1);

    // 本地图片应直接读取后随 multipart 提交，不上传第三方图床。
    const localReference = 'data:image/png;base64,iVBORw==';
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input !== localReference) throw new Error('Unexpected external upload');
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      });
    });
    transportMocks.corsSafeFetch.mockClear();
    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '结合本地和远程参考图生成场景',
      imageSize: '1K',
      aspectRatio: '1:1',
      image_urls: [localReference, 'https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/edited.png' }] });
    expect(localFetch).toHaveBeenCalledTimes(1);
    expect(localFetch).toHaveBeenCalledWith(localReference, expect.any(Object));
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.example/reference.png',
      'https://cccapi.cn/v1/images/edits',
    ]);
    const mixedBody = transportMocks.corsSafeFetch.mock.calls[1][1].body as FormData;
    const files = mixedBody.getAll('image[]') as File[];
    expect(files).toHaveLength(2);
    expect(files.map((file) => [file.type, file.size])).toEqual([
      ['image/png', 4], ['image/png', 4],
    ]);

    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '纯文本生成一张图',
      imageSize: '1K',
      aspectRatio: '1:1',
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/generated.png' }] });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://cccapi.cn/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('routes assistant streaming requests through the shared transport', async () => {
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
          executionProfile: { preset: 'openai-chat' },
        }],
      },
    }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '助手结果' }, finish_reason: 'stop' }],
    }));

    await expect(streamAssistantReply({
      systemPrompt: '系统',
      userMessage: '你好',
      nonStream: true,
      onEvent: vi.fn(),
    })).resolves.toBe('助手结果');

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
  });
});
