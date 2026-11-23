import { afterEach, describe, expect, it, vi } from 'vitest';
import { KLING_BASE_URL, KLING_IMAGE_MODEL_MANIFEST, getProviderDefinition, usesKlingImageProtocol } from '../../src/services/ai/providerCatalogService';
import { buildModelProtocolRequest, executeModelProtocol, resolveModelExecutionProfile, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocol';
import { resolveImageExecutionCapability, resolveImageOutputsPerJob } from '../../src/services/ai/mediaModelCapabilities';
import { assertModelCapabilityProtocol, resolveConfiguredImageParameters } from '../../src/services/ai/modelCapabilityValidation';
import type { AppConfig } from '../../src/types';
import { assertKlingImageResponse, getKlingImageQueryTaskId } from '../../src/services/ai/providers/klingImageResponse';
import { resolvePoll, pollResolvedModelProtocol } from '../../src/services/ai/modelProtocolPoll';
import { ModelProtocolHttpError } from '../../src/services/ai/modelProtocolHttp';

afterEach(() => vi.unstubAllGlobals());

describe('Kling Image 4.0 官方合同', () => {
  it('业务错误和空查询结果立即停止等待，原任务不被判为失败', async () => {
    const protocol = resolveModelExecutionProfile(KLING_IMAGE_MODEL_MANIFEST[0].executionProfile)!;
    const poll = resolvePoll(KLING_BASE_URL, protocol.poll!, protocol.auth, { submit: { data: { id: 'original' } } });
    expect(getKlingImageQueryTaskId(poll)).toBe('original');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 1001, message: 'invalid key' })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(pollResolvedModelProtocol(poll, 'fixture', undefined, KLING_BASE_URL))
      .rejects.toMatchObject({ name: 'ModelProtocolHttpError', definitiveFailure: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(() => assertKlingImageResponse({ code: 5000, message: 'internal error' })).toThrow(ModelProtocolHttpError);
    expect(() => assertKlingImageResponse({ message: 'unknown' })).toThrow('状态码');
  });

  it.each([
    { data: [], error: '原任务状态' },
    { data: [{ id: 'wrong', status: 'failed' }], error: '原任务状态' },
    { data: [{ id: 'original', status: 'working' }], error: '未知任务状态' },
    { data: [{ id: 'original', status: 'succeeded' }, { id: 'original', status: 'failed' }], error: '重复的原任务 ID' },
  ])('保存的查询回执遇到异常响应时退出本轮并保留原任务', async ({ data, error }) => {
    const protocol = resolveModelExecutionProfile(KLING_IMAGE_MODEL_MANIFEST[0].executionProfile)!;
    const poll = resolvePoll(KLING_BASE_URL, protocol.poll!, protocol.auth, { submit: { data: { id: 'original' } } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(pollResolvedModelProtocol(poll, 'fixture', undefined, KLING_BASE_URL)).rejects.toThrow(error);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('保存地址中的任务 ID 与原回执不同时不发网络请求', async () => {
    const protocol = resolveModelExecutionProfile(KLING_IMAGE_MODEL_MANIFEST[0].executionProfile)!;
    const poll = resolvePoll(KLING_BASE_URL, protocol.poll!, protocol.auth, { submit: { data: { id: 'wrong' } } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(pollResolvedModelProtocol(poll, 'fixture', undefined, KLING_BASE_URL, undefined, undefined, 'original'))
      .rejects.toThrow('与原任务回执的 ID 不一致');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('旧回执可使用兼容代理，其他 /tasks 查询协议仍按自定义映射解析', async () => {
    const protocol = resolveModelExecutionProfile(KLING_IMAGE_MODEL_MANIFEST[0].executionProfile)!;
    const baseUrl = 'https://gateway.example';
    const poll = resolvePoll(baseUrl, protocol.poll!, protocol.auth, { submit: { data: { id: 'original' } } });
    expect(getKlingImageQueryTaskId(poll)).toBe('original');
    expect(getKlingImageQueryTaskId({ ...poll, resultTextPath: 'data.0.text' })).toBeUndefined();

    const customPoll = { ...poll, url: `${baseUrl}/tasks?id=original` };
    const url = 'https://cdn.example/result.png';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ status: 'succeeded', outputs: [{ url }] }],
    })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(pollResolvedModelProtocol(customPoll, 'fixture', undefined, baseUrl)).resolves.toMatchObject({ urls: [url] });
  });

  it.each(KLING_IMAGE_MODEL_MANIFEST)('$id 映射官方路径、内容、Bearer 和数组型任务结果', async (model) => {
    const protocol = resolveModelExecutionProfile(model.executionProfile)!;
    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
    const options = { apiKey: 'kling-fixture', baseUrl: `${KLING_BASE_URL}/v1`, protocol,
      variables: { model: model.id, prompt: 'Use @image1', imageUrls: ['https://cdn.example/ref.png'],
        imageSize: '8k', aspectRatio: '21:9', n: 9 } };
    const request = buildModelProtocolRequest(options);
    expect(request.url).toBe(`${KLING_BASE_URL}/image-generation/kling-4.0`);
    expect(new Headers(request.init.headers).get('Authorization')).toBe('Bearer kling-fixture');
    const body = JSON.parse(String(request.init.body));
    expect(body.contents).toEqual([{ type: 'prompt', text: 'Use @image1' },
      { type: 'refer_image', url: 'https://cdn.example/ref.png', id: 'image1' }]);
    expect(body.settings).toEqual(model.id.endsWith('-series')
      ? { result_type: 'series', series_amount: 10, resolution: '8k', aspect_ratio: '21:9' }
      : { result_type: 'single', n: 9, resolution: '8k', aspect_ratio: '21:9' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { id: 'original-task', status: 'submitted' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: [
        { id: 'other-task', status: 'succeeded', outputs: [{ type: 'image', url: 'https://cdn.example/wrong.png' }] },
        { id: 'original-task', status: 'succeeded', outputs: [{ type: 'image', url: 'https://cdn.example/result.png' }] },
      ] })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeModelProtocol(options)).resolves.toMatchObject({ urls: ['https://cdn.example/result.png'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${KLING_BASE_URL}/tasks?task_ids=original-task`);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('组图保留十个产物，仅官方连接和完整原协议具有固定产物数量', () => {
    const model = KLING_IMAGE_MODEL_MANIFEST[1];
    const config: AppConfig = { theme: 'dark', providers: { official: { name: 'Kling', apiKey: '', catalogId: 'kling' } },
      generalModels: [{ id: 'series', modelId: model.id, name: model.name, category: 'image',
        providerConfigId: 'official', executionProfile: model.executionProfile }] };
    expect(getProviderDefinition('official', config.providers.official)?.policy.syncGeneralModels).toBe(true);
    expect(resolveImageOutputsPerJob('general/series', 'general', config)).toBe(10);
    expect(resolveImageExecutionCapability('general/series', 'general', config)).toMatchObject({
      promptMaxCharacters: 50_000, promptMaxNonAsciiCharacters: 21_000, maxImageReferences: 10 });
    expect(() => resolveConfiguredImageParameters(model.imageCapability!, { count: 2 })).toThrow('最多生成 1');
    config.providers.official.catalogId = 'custom-openai';
    expect(resolveImageOutputsPerJob('general/series', 'general', config)).toBe(1);
    expect(usesKlingImageProtocol(model.id, { preset: 'openai-image' })).toBe(false);
    const protocol = resolveModelExecutionProfile(model.executionProfile)!;
    expect(usesKlingImageProtocol(model.id, { preset: 'custom',
      protocol: { ...protocol, poll: { ...protocol.poll!, intervalMs: 8_000 } } })).toBe(true);
    expect(usesKlingImageProtocol(model.id, { preset: 'custom',
      protocol: { ...protocol, poll: { ...protocol.poll!, path: '/other' } } })).toBe(false);
  });
});
