import { describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  logAiResponse: vi.fn(),
}));

vi.mock('../../../src/services/ai/httpTransport', () => transportMocks);

import { generateImagesBatch } from '../../../src/services/ai/generateImage';
import { generateVideo } from '../../../src/services/ai/generateVideo';
import { generateText } from '../../../src/services/ai/generateText';
import { streamAssistantReply } from '../../../src/services/ai/assistantStream';
import { KLING_BASE_URL, KLING_VIDEO_MODEL_MANIFEST } from '../../../src/services/ai/providerCatalogService';
import { REPLICATE_BASE_URL, REPLICATE_MODEL_MANIFEST } from '../../../src/services/ai/providers/replicateModelManifest';
import { resolveVideoModelCapability } from '../../../src/services/ai/videoModelCapabilityResolver';
import { useAppStore } from '../../../src/store/useAppStore';
import { jsonResponse, setupTransportFixture } from './transportFixture';

setupTransportFixture(transportMocks.corsSafeFetch);

describe('Replicate 官方 Prediction 通用执行入口', () => {
  it.each(REPLICATE_MODEL_MANIFEST)('$id 根据模型能力构建请求并只查询提交返回的 ID', async (model) => {
    const key = 'replicate-fixture';
    useAppStore.getState().saveProviderConfig('replicate-test', { name: 'Replicate', catalogId: 'replicate',
      apiKey: key, selectedModels: [model] });
    const general = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'replicate-test')!;
    const out = model.category === 'image'
      ? ['https://replicate.delivery/a.png', 'https://replicate.delivery/b.png'] : 'https://replicate.delivery/clip.mp4';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'original', status: 'starting' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'original', status: 'succeeded', output: out }));
    const params = { model: 'general/' + general.id, provider: 'general', prompt: 'a landscape' };
    if (model.category === 'image') {
      const result = await generateImagesBatch({ ...params, aspectRatio: '21:9' }, 2);
      expect(result.results.map((item) => item.url)).toEqual(out);
    } else {
      const result = await generateVideo({ ...params, seedanceDuration: 6, seedanceRatio: '16:9', seedanceResolution: '720p' });
      expect(result.url).toBe(out);
    }
    const [submit, poll] = transportMocks.corsSafeFetch.mock.calls;
    expect(submit[0]).toBe(REPLICATE_BASE_URL + '/models/' + model.id + '/predictions');
    expect(poll[0]).toBe(REPLICATE_BASE_URL + '/predictions/original');
    expect(new Headers(submit[1].headers).get('Authorization')).toBe('Bearer ' + key);
    expect(JSON.parse(String(submit[1].body)).input).toMatchObject(model.category === 'image'
      ? { num_outputs: 2, aspect_ratio: '21:9' } : { duration: 6, resolution: '720p' });
  });
});

describe('Kling 官方视频统一入口', () => {
  function configureFlash(mode: 'text' | 'first-frame', override = false) {
    const model = structuredClone(KLING_VIDEO_MODEL_MANIFEST.find((entry) => entry.id === `kling-video-4.0-flash-${mode}`)!);
    if (override) model.videoCapability = { ...model.videoCapability, maxImageReferences: 10, resolutions: ['720p', '1080p'],
      defaultResolution: '1080p', durations: [20, 21], minDuration: 20, maxDuration: 21, defaultDuration: 21 };
    useAppStore.getState().saveProviderConfig('kling-flash', { name: 'Kling', catalogId: 'kling',
      apiKey: 'flash-fixture', selectedModels: [model] });
    const selected = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'kling-flash')!;
    return { model: `general/${selected.id}`, provider: 'general', prompt: 'A sunrise' };
  }

  it.each(['text', 'first-frame'] as const)('Flash %s 发出官方请求并按原回执查询', async (mode) => {
    const params = configureFlash(mode);
    const header = Buffer.from('89504e470d0a1a0a0000000d494844520000012c0000012c0806000000', 'hex').toString('base64');
    const local = `data:image/png;base64,${header}`;
    const referenceMedia = mode === 'first-frame' ? [{ kind: 'image' as const, origin: 'connection' as const,
      role: 'reference' as const, url: local }] : [];
    const prompt = (mode === 'text' ? 'a' : '春').repeat(mode === 'text' ? 26_000 : 11_000);
    const resultUrl = 'https://cdn.example/flash.mp4';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'flash-original' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [
        { id: 'other-task', status: 'failed' },
        { id: 'flash-original', status: 'succeeded', outputs: [{ url: resultUrl }] },
      ] }));
    await expect(generateVideo({ ...params, prompt, seedanceDuration: 20, referenceMedia })).resolves.toMatchObject({ url: resultUrl });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const [[submitUrl, submit], [pollUrl, poll]] = transportMocks.corsSafeFetch.mock.calls;
    const endpoint = mode === 'text' ? 'text-to-video' : 'image-to-video';
    expect(submitUrl).toBe(`${KLING_BASE_URL}/${endpoint}/kling-4.0-flash`);
    expect(new Headers(submit.headers).get('Authorization')).toBe('Bearer flash-fixture');
    expect(JSON.parse(String(submit.body))).toEqual(mode === 'text'
      ? { prompt, settings: { resolution: '720p', duration: 20, aspect_ratio: '16:9' } }
      : { contents: [{ type: 'prompt', text: prompt }, { type: 'first_frame', url: header }],
        settings: { resolution: '720p', duration: 20 } });
    expect(pollUrl).toBe(`${KLING_BASE_URL}/tasks?task_ids=flash-original`);
    expect(poll.method).toBe('GET');
  });

  it('Flash 首帧模型在网络请求前拒绝旧设置扩大的能力、尾帧与过长提示词', async () => {
    const params = configureFlash('first-frame', true);
    const first = { kind: 'image' as const, origin: 'connection' as const,
      role: 'first_frame' as const, url: 'https://cdn.example/first.png' };
    const last = { ...first, role: 'last_frame' as const, url: 'https://cdn.example/last.png' };
    const valid = { ...params, seedanceDuration: 20, referenceMedia: [first] };
    expect(resolveVideoModelCapability(params.model, useAppStore.getState().config)).toMatchObject({
      maxImageReferences: 1, durations: [20], defaultDuration: 20, resolutions: ['720p'], defaultResolution: '720p',
    });
    await expect(generateVideo({ ...valid, seedanceDuration: 21 })).rejects.toMatchObject({ code: 'UNSUPPORTED_DURATION' });
    await expect(generateVideo({ ...valid, seedanceResolution: '1080p' })).rejects.toMatchObject({ code: 'UNSUPPORTED_RESOLUTION' });
    await expect(generateVideo({ ...valid, referenceMedia: [first, last] })).rejects.toMatchObject({ code: 'REFERENCE_LIMIT_EXCEEDED' });
    await expect(generateVideo({ ...valid, referenceMedia: [last] })).rejects.toThrow('仅支持首帧');
    await expect(generateVideo({ ...valid, referenceMedia: [] })).rejects.toMatchObject({ code: 'REQUIRED_REFERENCE' });
    await expect(generateVideo({ ...valid, prompt: '春'.repeat(11_001) })).rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('实际时长只能取官方档位与连接设置的交集，超限不发请求', async () => {
    const model = structuredClone(KLING_VIDEO_MODEL_MANIFEST[0]);
    model.videoCapability = { ...model.videoCapability, durations: [29, 30, 31], minDuration: 29, maxDuration: 31,
      defaultDuration: 31, automaticDurationValue: -1, promptMaxCharacters: 100_000, promptMaxNonAsciiCharacters: 50_000 };
    const state = useAppStore.getState();
    useAppStore.setState({ config: { ...state.config, providers: {
      official: { name: 'Kling', apiKey: 'kling-fixture', catalogId: 'kling', baseUrl: KLING_BASE_URL, selectedModels: [model] },
    }, generalModels: [{ id: 'bounded-video', name: model.name, modelId: model.id, category: 'video', providerConfigId: 'official',
      executionProfile: model.executionProfile, videoCapability: model.videoCapability }] } });
    const ref = 'general/bounded-video';
    expect(resolveVideoModelCapability(ref, useAppStore.getState().config)).toMatchObject({
      durations: [29, 30], minDuration: 29, maxDuration: 30, defaultDuration: 29, automaticDurationValue: undefined,
      promptMaxCharacters: 26_000, promptMaxNonAsciiCharacters: 11_000,
    });
    const params = { model: ref, provider: 'general', prompt: 'Spring' };
    await expect(generateVideo({ ...params, seedanceDuration: 31 })).rejects.toMatchObject({ code: 'UNSUPPORTED_DURATION' });
    await expect(generateVideo({ ...params, seedanceDuration: 30, prompt: '春'.repeat(11_001) })).rejects.toThrow('提示词最多支持 11000 个字符');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('按实际传输顺序绑定首、中、尾帧，包括内联本地帧', async () => {
    const model = KLING_VIDEO_MODEL_MANIFEST[1];
    useAppStore.getState().saveProviderConfig('kling-video-fixture', { name: 'Kling', catalogId: 'kling',
      apiKey: 'video-fixture', selectedModels: [model] });
    const selected = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'kling-video-fixture')!;
    const header = Buffer.from('89504e470d0a1a0a0000000d494844520000012c0000012c0806000000', 'hex').toString('base64');
    const middle = 'data:image/png;base64,' + header;
    const first = 'https://cdn.example/first.png';
    const last = 'https://cdn.example/last.png';
    useAppStore.setState({ nodes: [
      { id: 'last', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '尾帧', imageUrl: last } },
      { id: 'middle', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '中间帧', imageUrl: middle } },
      { id: 'first', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '首帧', imageUrl: first } },
    ] });
    const resultUrl = 'https://cdn.example/generated.mp4';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'keyframes' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'keyframes', status: 'succeeded', outputs: [{ url: resultUrl }] }] }));
    await expect(generateVideo({ model: 'general/' + selected.id, provider: 'general', seedanceDuration: 30,
      prompt: '从 @{first:首帧} 经 @{middle:中间帧} 到 @{last:尾帧}',
      referenceMedia: [
        { kind: 'image', origin: 'prompt', role: 'last_frame', sourceNodeId: 'last', url: last },
        { kind: 'image', origin: 'prompt', role: 'first_frame', sourceNodeId: 'first', url: first },
      ],
    })).resolves.toMatchObject({ url: resultUrl });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(KLING_BASE_URL + '/image-to-video/kling-4.0');
    const body = JSON.parse(String(init.body));
    expect(body.settings).toEqual({ resolution: '1080p', duration: 30 });
    expect(body.contents[0].text).toContain('从 @frame_1 经 @frame_2 到 @frame_3');
    expect(body.contents.slice(1)).toEqual([
      { type: 'first_frame', id: 'frame_1', url: first },
      { type: 'middle_frame', id: 'frame_2', url: header },
      { type: 'last_frame', id: 'frame_3', url: last },
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('Magpie 文本请求合同', () => {
  it('Magpie 文本节点和助手的显式 Chat 预设使用同一目录输出预算', async () => {
    const provider = 'magpie-transport';
    const modelId = 'upstream/model';
    const model = { id: modelId, name: 'Model', category: 'text' as const, provider,
      executionProfile: { preset: 'openai-chat' as const } };
    useAppStore.getState().saveProviderConfig(provider, {
      name: 'Gateway', catalogId: 'magpie', apiKey: 'fixture', baseUrl: 'https://magpie.example',
      selectedModels: [model], catalogModels: [{ ...model,
        catalogTextLimits: { source: 'magpie', contextWindow: 32_000, maxOutputTokens: 1_024 },
      }],
    });
    const id = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === provider)!.id;
    useAppStore.setState((state) => ({ config: { ...state.config, assistantModelId: id } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({
      choices: [{ message: { content: '预算生效' }, finish_reason: 'stop' }],
    }));
    await expect(generateText({ provider: 'general', model: `general/${id}`, prompt: '你好' })).resolves.toBe('预算生效');
    await expect(streamAssistantReply({ systemPrompt: '系统', userMessage: '你好',
      nonStream: true, onEvent: vi.fn(),
    })).resolves.toBe('预算生效');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    for (const [url, request] of transportMocks.corsSafeFetch.mock.calls) {
      expect(url).toBe('https://magpie.example/v1/chat/completions');
      expect(JSON.parse(String(request.body))).toMatchObject({ model: modelId, max_completion_tokens: 1_024 });
    }
  });
});
