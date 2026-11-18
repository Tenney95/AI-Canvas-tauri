/**
 * sora2uModelManifest — 回归测试：Sora2U 旧模型与协议。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pollResolvedModelProtocol,
  previewModelProtocolRequest,
  submitModelProtocol,
  validateModelExecutionProtocol,
} from '../../src/services/ai/modelProtocol';
import { getProviderDefinition, getProviderDefinitions, isProviderModelVisible } from '../../src/services/ai/providerCatalogService';
import { getCategoryProtocolVariables, resolveProtocolFieldTemplate } from '../../src/services/ai/modelProtocolVariables';
import {
  SORA2U_BASE_URL,
  SORA2U_INLINE_REFERENCE_MAX_BYTES,
  SORA2U_MODEL_MANIFEST,
  resolveSora2uImageExecutionProfile,
  sora2uImageVariables,
  usesSora2uModelProtocol,
  withSora2uReferenceLimits,
} from '../../src/services/ai/providers/sora2uModelManifest';
import type { NormalizedModelExecutionProtocol, ProtocolJsonValue } from '../../src/types/aiTypes';

const EXPECTED_MODELS = [
  'seedance-1.5',
  'seedance-2.0',
  'seedance-2.0-character',
  'seedance-2.0-character-mono',
  'seedance-2.5',
  'seedance-2.5-character',
  'seedance-2.5-character-mono',
  'gemini-image',
  'kontext-image',
];
const TRACKING_QUERY = 'utm_source=tenney&utm_medium=canvas&utm_content=wx';

function protocolFor(modelId: string): NormalizedModelExecutionProtocol {
  const protocol = SORA2U_MODEL_MANIFEST.find((model) => model.id === modelId)
    ?.executionProfile?.protocol;
  if (!protocol || protocol.version !== 2) throw new Error(`模型 ${modelId} 没有 V2 自定义协议`);
  return protocol;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('Sora2U 历史模型清单', () => {
  it('复用型号基线仍保留各 SKU 的完整旧能力，未确认的输出与模式不继承', () => {
    for (const id of EXPECTED_MODELS.filter((value) => value.startsWith('seedance-2.'))) {
      const is25 = id.startsWith('seedance-2.5');
      const mono = id.endsWith('-mono');
      const expected = {
        durations: Array.from({ length: (is25 ? 30 : 15) - 4 }, (_, index) => index + 5),
        minDuration: 5, maxDuration: is25 ? 30 : 15, defaultDuration: is25 ? 15 : 5,
        supportsAudio: true, supportsStandaloneAudio: true,
        maxImageReferences: is25 ? 30 : 9, maxVideoReferences: is25 && !mono ? 10 : 3,
        maxAudioReferences: is25 && !mono ? 10 : 3,
        inputConstraints: {
          promptMinCharacters: 10, maxBase64DecodedBytes: 20 * 1024 * 1024,
          referenceVideo: { width: { min: 300 }, durationSeconds: { max: 15, maxExclusive: true } },
          referenceAudio: { durationSeconds: { min: 3, max: 15, maxExclusive: true } },
        },
        ...(is25 ? { requiresReference: true } : mono ? {} : { maxVideoAudioReferences: 3 }),
      };
      expect(SORA2U_MODEL_MANIFEST.find((model) => model.id === id)?.videoCapability, id).toEqual(expected);
    }
    for (const id of ['gemini-image', 'kontext-image']) {
      expect(SORA2U_MODEL_MANIFEST.find((model) => model.id === id)).not.toHaveProperty('imageCapability');
    }
  });

  it('联合名额只补已核对的两个 SKU，显式远端值与 mono 语义保持', () => {
    expect(withSora2uReferenceLimits('seedance-2.0', undefined)).toEqual({ maxVideoAudioReferences: 3 });
    expect(withSora2uReferenceLimits('seedance-2.0-character', {})).toEqual({ maxVideoAudioReferences: 3 });
    expect(withSora2uReferenceLimits('seedance-2.0-character-mono', {})).toEqual({});
    expect(withSora2uReferenceLimits('seedance-2.5', {})).toEqual({});
    expect(withSora2uReferenceLimits('seedance-2.0', { maxVideoAudioReferences: 1 }))
      .toEqual({ maxVideoAudioReferences: 1 });
    expect(withSora2uReferenceLimits('unknown', undefined)).toBeUndefined();
  });

  it('内置目录移除 Sora2U，保存过的连接保留旧协议与原查询参数', () => {
    expect(getProviderDefinitions().some((definition) => definition.id === 'sora2u')).toBe(false);
    expect(getProviderDefinition('sora2u')).toBeUndefined();
    const savedDefinition = getProviderDefinition('saved-connection', { catalogId: 'sora2u' });
    expect(savedDefinition).toMatchObject({
      id: 'sora2u',
      retired: true,
      defaultBaseUrl: SORA2U_BASE_URL,
      requestQuery: {
        utm_source: 'tenney',
        utm_medium: 'canvas',
        utm_content: 'wx',
      },
    });
    expect(savedDefinition?.externalUrl).toBeUndefined();
    expect(savedDefinition?.connectionTestPath).toBeUndefined();
    expect(savedDefinition?.models?.find((model) => model.id === 'gemini-image')?.executionProfile?.protocol)
      .toEqual(protocolFor('gemini-image'));
    expect(EXPECTED_MODELS.every((model) => !isProviderModelVisible('sora2u', model))).toBe(true);
    expect(SORA2U_MODEL_MANIFEST.map((model) => model.id)).toEqual(EXPECTED_MODELS);
    expect(SORA2U_MODEL_MANIFEST.filter((model) => model.category === 'video')).toHaveLength(7);
    expect(SORA2U_MODEL_MANIFEST.filter((model) => model.category === 'image')).toHaveLength(2);
  });

  it('所有图片和视频协议都通过本地 schema 校验', () => {
    for (const model of SORA2U_MODEL_MANIFEST) {
      expect(validateModelExecutionProtocol(model.executionProfile?.protocol), model.id).toEqual([]);
    }
  });

  it('渲染图片任务并把参考图传到统一生成端点', () => {
    const request = previewModelProtocolRequest({
      baseUrl: SORA2U_BASE_URL,
      protocol: protocolFor('gemini-image'),
      variables: sora2uImageVariables({
        model: 'gemini-image',
        prompt: '雨后的霓虹街道',
        aspectRatio: '16:9',
        imageSize: '2K',
        imageUrls: ['https://assets.example/character.png'],
      }),
    });

    expect(request).toMatchObject({
      method: 'POST',
      relativeUrl: `/api/v1/videos?${TRACKING_QUERY}`,
      body: {
        model: 'gemini-image',
        prompt: '雨后的霓虹街道',
        aspect_ratio: '16:9',
        resolution: '2K',
        reference_urls: ['https://assets.example/character.png'],
      },
    });
    expect(request.body).not.toHaveProperty('references');
  });

  it.each(['gemini-image', 'kontext-image'])('%s 的新旧内置图片协议只为本轮提交投影', (modelId) => {
    const current = { preset: 'custom' as const, protocol: structuredClone(protocolFor(modelId)) };
    const legacy = structuredClone(current);
    legacy.protocol.submit.body = { ...(legacy.protocol.submit.body as Record<string, ProtocolJsonValue>), reference_urls: '{{imageUrls}}' };
    delete (legacy.protocol.submit.body as Record<string, ProtocolJsonValue>).references;
    const saved = structuredClone(legacy);

    for (const profile of [current, legacy]) {
      expect(usesSora2uModelProtocol(modelId, profile)).toBe(true);
      expect(resolveSora2uImageExecutionProfile(modelId, profile)).toEqual(current);
      expect(resolveSora2uImageExecutionProfile(modelId, profile)).not.toBe(profile);
    }
    expect(legacy).toEqual(saved);
    const variables = sora2uImageVariables({ model: modelId, prompt: '保留参考图的主体',
      imageUrls: ['https://assets.example/first.png', 'data:image/png;base64,AQ==', 'data:image/webp;base64,AgM='],
      n: 1, imageTransparent: false });
    expect(variables.imageUrls).toEqual(['https://assets.example/first.png', 'data:image/png;base64,AQ==', 'data:image/webp;base64,AgM=']);
    expect(variables.imageTransparent).toBe(false);
    const request = previewModelProtocolRequest({ baseUrl: SORA2U_BASE_URL, protocol: current.protocol!, variables });
    expect(request.body).toMatchObject({ model: modelId, reference_urls: ['https://assets.example/first.png'],
      references: ['data:image/png;base64,AQ==', 'data:image/webp;base64,AgM='] });
  });

  it.each(['path', 'body', 'query', 'poll'] as const)('不投影用户修改过 %s 的同名 Sora 图片协议', (field) => {
    const profile = { preset: 'custom' as const, protocol: structuredClone(protocolFor('gemini-image')) };
    if (field === 'path') profile.protocol!.submit!.path = '/api/v1/my-images';
    if (field === 'body') profile.protocol!.submit!.body = { model: '{{model}}', image: '{{imageUrls}}' };
    if (field === 'query') profile.protocol!.submit!.query = { owner: 'my-workspace' };
    if (field === 'poll') profile.protocol!.poll!.response!.result = { urlPath: 'task.my_image' };
    expect(usesSora2uModelProtocol('gemini-image', profile)).toBe(false);
    expect(resolveSora2uImageExecutionProfile('gemini-image', profile)).toBe(profile);
  });

  it('只识别清单型号，保留视频完整协议与无配置状态', () => {
    const video = { preset: 'custom' as const, protocol: protocolFor('seedance-2.0') };
    expect(usesSora2uModelProtocol('seedance-2.0', video)).toBe(true);
    expect(resolveSora2uImageExecutionProfile('seedance-2.0', video)).toBe(video);
    expect(usesSora2uModelProtocol('unknown', video)).toBe(false);
    expect(usesSora2uModelProtocol('gemini-image', undefined)).toBe(false);
    expect(resolveSora2uImageExecutionProfile('gemini-image', undefined)).toBeUndefined();
    expect(sora2uImageVariables({ prompt: '无参考图' })).toEqual({ prompt: '无参考图', referenceUrls: undefined, inlineReferences: undefined });
  });

  it('图片联合上限为四张，HTTP 和非图片内联素材不能混进 HTTPS 字段', () => {
    const https = 'https://assets.example/image.png';
    expect(() => sora2uImageVariables({ imageUrls: [https, https, https, https] })).not.toThrow();
    expect(() => sora2uImageVariables({ imageUrls: [https, https, https, https, https] })).toThrow('最多支持 4 张');
    for (const imageUrls of ['invalid', [null], ['http://assets.example/image.png'],
      ['https://asset.localhost/sora-reference.png'], ['data:video/mp4;base64,AQ==']]) {
      expect(() => sora2uImageVariables({ imageUrls })).toThrow();
    }
  });

  it('图片编辑器列出真实供应的别名，但不把普通图片导入字段自动映射到 Sora 数组', () => {
    expect(getCategoryProtocolVariables('image')).toEqual(expect.arrayContaining(['referenceUrls', 'inlineReferences']));
    expect(resolveProtocolFieldTemplate('reference_urls', ['https://assets.example/image.png'], 'image')).toBeUndefined();
    expect(resolveProtocolFieldTemplate('references', ['data:image/png;base64,AQ=='], 'image')).toBeUndefined();
    expect(resolveProtocolFieldTemplate('reference_urls', ['https://assets.example/image.png'], 'video')).toBe('{{referenceUrls}}');
    expect(resolveProtocolFieldTemplate('references', ['data:image/png;base64,AQ=='], 'video')).toBe('{{inlineReferences}}');
    expect(resolveProtocolFieldTemplate('images', ['https://assets.example/image.png'], 'image')).toBe('{{imageUrls}}');
  });

  it('内联图片解码后合计 20 MiB 可提交，超限不截断或转图床', () => {
    const image = (bytes: number) => `data:image/png;base64,${'A'.repeat(Math.floor(bytes / 3) * 4)}${bytes % 3 === 1 ? 'AA==' : bytes % 3 === 2 ? 'AAA=' : ''}`;
    expect(() => sora2uImageVariables({ imageUrls: [image(SORA2U_INLINE_REFERENCE_MAX_BYTES)] })).not.toThrow();
    expect(() => sora2uImageVariables({ imageUrls: [image(SORA2U_INLINE_REFERENCE_MAX_BYTES), 'data:image/png;base64,AQ=='] }))
      .toThrow('解码后合计不能超过 20 MiB');
  });

  it('渲染包含图片、视频和音频引用的视频任务', () => {
    const request = previewModelProtocolRequest({
      baseUrl: SORA2U_BASE_URL,
      protocol: protocolFor('seedance-2.0'),
      variables: {
        model: 'seedance-2.0',
        prompt: '保持角色一致并跟随音乐节奏运镜',
        duration: 12,
        aspectRatio: '9:16',
        seedanceResolution: '720p',
        disableAudio: true,
        referenceUrls: [
          'https://assets.example/character.png',
          'https://assets.example/motion.mp4',
          'https://assets.example/voice.mp3',
        ],
      },
    });

    expect(request.body).toEqual({
      model: 'seedance-2.0',
      prompt: '保持角色一致并跟随音乐节奏运镜',
      duration: 12,
      aspect_ratio: '9:16',
      resolution: '720p',
      disable_audio: true,
      reference_urls: [
        'https://assets.example/character.png',
        'https://assets.example/motion.mp4',
        'https://assets.example/voice.mp3',
      ],
    });
  });

  it('从 task.id 构建同源轮询并分别读取图片和视频结果', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: 'task-image' } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: 'task-video' } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const image = await submitModelProtocol({
      apiKey: 'sk_sora_secret',
      baseUrl: SORA2U_BASE_URL,
      protocol: protocolFor('kontext-image'),
      variables: { model: 'kontext-image', prompt: '产品海报' },
    });
    const video = await submitModelProtocol({
      apiKey: 'sk_sora_secret',
      baseUrl: SORA2U_BASE_URL,
      protocol: protocolFor('seedance-2.0'),
      variables: { model: 'seedance-2.0', prompt: '海边日落延时摄影' },
    });

    expect(image.poll).toMatchObject({
      url: `https://sora2u.com/api/v1/videos/task-image?${TRACKING_QUERY}`,
      statusPath: 'task.status',
      resultUrlPath: 'task.image_url',
    });
    expect(video.poll).toMatchObject({
      url: `https://sora2u.com/api/v1/videos/task-video?${TRACKING_QUERY}`,
      statusPath: 'task.status',
      resultUrlPath: 'task.video_url',
    });
  });

  it('轮询终态时返回对应媒体，并透传清洗后的失败原因', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: 'task-image' } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task: {
          status: 'completed',
          image_url: 'https://sora2u.com/api/files/images/result.png?token=safe',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: 'task-video' } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task: { status: 'failed', error: '参考音频时长不足 3 秒' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const image = await submitModelProtocol({
      apiKey: 'sk_sora_secret',
      baseUrl: SORA2U_BASE_URL,
      protocol: protocolFor('gemini-image'),
      variables: { model: 'gemini-image', prompt: '产品海报' },
    });
    expect(await pollResolvedModelProtocol(
      image.poll!,
      'sk_sora_secret',
      undefined,
      SORA2U_BASE_URL,
    )).toEqual({
      urls: ['https://sora2u.com/api/files/images/result.png?token=safe'],
    });

    const video = await submitModelProtocol({
      apiKey: 'sk_sora_secret',
      baseUrl: SORA2U_BASE_URL,
      protocol: protocolFor('seedance-2.0'),
      variables: { model: 'seedance-2.0', prompt: '让角色按节奏说话' },
    });
    await expect(pollResolvedModelProtocol(
      video.poll!,
      'sk_sora_secret',
      undefined,
      SORA2U_BASE_URL,
    )).rejects.toThrow('模型任务失败：参考音频时长不足 3 秒');
  });
});
