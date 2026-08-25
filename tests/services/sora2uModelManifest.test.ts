import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pollResolvedModelProtocol,
  previewModelProtocolRequest,
  submitModelProtocol,
  validateModelExecutionProtocol,
} from '../../src/services/ai/modelProtocol';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import {
  SORA2U_BASE_URL,
  SORA2U_MODEL_MANIFEST,
} from '../../src/services/ai/providers/sora2uModelManifest';
import type { ModelExecutionProtocol } from '../../src/types/aiTypes';

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

function protocolFor(modelId: string): ModelExecutionProtocol {
  const protocol = SORA2U_MODEL_MANIFEST.find((model) => model.id === modelId)
    ?.executionProfile?.protocol;
  if (!protocol) throw new Error(`模型 ${modelId} 没有自定义协议`);
  return protocol;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('Sora2U 内置模型清单', () => {
  it('注册独立厂商及文档当前公开的全部九个模型', () => {
    expect(getProviderDefinition('sora2u')).toMatchObject({
      id: 'sora2u',
      defaultBaseUrl: SORA2U_BASE_URL,
      modelsPath: '/api/v1/models',
      models: SORA2U_MODEL_MANIFEST,
      externalUrl: 'https://sora2u.com/?utm_source=tenney&utm_medium=canvas&utm_content=wx',
    });
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
      variables: {
        model: 'gemini-image',
        prompt: '雨后的霓虹街道',
        aspectRatio: '16:9',
        imageSize: '2K',
        imageUrls: ['https://assets.example/character.png'],
      },
    });

    expect(request).toMatchObject({
      method: 'POST',
      relativeUrl: '/api/v1/videos',
      body: {
        model: 'gemini-image',
        prompt: '雨后的霓虹街道',
        aspect_ratio: '16:9',
        resolution: '2K',
        reference_urls: ['https://assets.example/character.png'],
      },
    });
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
      url: 'https://sora2u.com/api/v1/videos/task-image',
      statusPath: 'task.status',
      resultUrlPath: 'task.image_url',
    });
    expect(video.poll).toMatchObject({
      url: 'https://sora2u.com/api/v1/videos/task-video',
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
