/**
 * googleModelManifest — 回归测试：Google Gemini 官方模型清单。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeModelProtocol,
  previewModelProtocolRequest,
  submitModelProtocol,
  validateModelExecutionProtocol,
} from '../../src/services/ai/modelProtocol';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import {
  GOOGLE_GEMINI_BASE_URL,
  GOOGLE_MODEL_MANIFEST,
} from '../../src/services/ai/providers/googleModelManifest';
import type { ModelExecutionProtocol } from '../../src/types/aiTypes';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { resolveImageTemplateDimensions } from '../../src/services/ai/imageModelTemplates';

function protocolFor(modelId: string): ModelExecutionProtocol {
  const protocol = GOOGLE_MODEL_MANIFEST.find((model) => model.id === modelId)
    ?.executionProfile?.protocol;
  if (!protocol) throw new Error(`模型 ${modelId} 没有自定义协议`);
  return protocol;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('Google Gemini 官方模型清单', () => {
  it('注册文本、图片、视频和音频模型', () => {
    expect(getProviderDefinition('google')).toMatchObject({
      id: 'google',
      defaultBaseUrl: GOOGLE_GEMINI_BASE_URL,
      catalogAdapter: 'local-manifest',
      models: GOOGLE_MODEL_MANIFEST,
    });
    expect(GOOGLE_MODEL_MANIFEST.map((model) => model.category)).toEqual([
      'text',
      'text',
      'image',
      'image',
      'image',
      'video',
      'video',
      'audio',
    ]);
  });

  it('所有 Google 媒体协议都通过本地 schema 校验', () => {
    for (const model of GOOGLE_MODEL_MANIFEST.filter((item) => item.category !== 'text')) {
      expect(validateModelExecutionProtocol(model.executionProfile?.protocol), model.id).toEqual([]);
    }
  });

  it('仅给精确 3 Pro 型号挂接完整官方尺寸，不把 Flash Lite 或未核对的 512 表当作同一型号', () => {
    const pro = GOOGLE_MODEL_MANIFEST.find((model) => model.id === 'gemini-3-pro-image')!;
    expect(pro.imageCapability).toMatchObject({
      resolutions: ['1K', '2K', '4K'], supportsBatch: false, supportsImageReference: false,
    });
    expect(() => assertModelCapabilityProtocol(pro)).not.toThrow();
    expect(resolveImageTemplateDimensions(pro.imageCapability, '4K', '16:9')).toEqual({ width: 5504, height: 3072 });
    expect(GOOGLE_MODEL_MANIFEST.find((model) => model.id === 'gemini-3.1-flash-lite-image')?.imageCapability).toBeUndefined();
    expect(GOOGLE_MODEL_MANIFEST.find((model) => model.id === 'gemini-3.1-flash-image')?.imageCapability).toBeUndefined();
  });

  it('从 OpenAI 兼容基址向同源 Interactions API 生成图片请求', () => {
    const request = previewModelProtocolRequest({
      baseUrl: GOOGLE_GEMINI_BASE_URL,
      protocol: protocolFor('gemini-3.1-flash-image'),
      variables: {
        model: 'gemini-3.1-flash-image',
        prompt: '水墨风格的山谷',
        aspectRatio: '16:9',
        imageSize: '2K',
      },
    });

    expect(request).toMatchObject({
      method: 'POST',
      relativeUrl: '/v1beta/interactions',
      headers: { 'x-goog-api-key': '********' },
      body: {
        model: 'gemini-3.1-flash-image',
        input: '水墨风格的山谷',
        response_format: { type: 'image', aspect_ratio: '16:9', image_size: '2K' },
      },
    });
  });

  it('将只支持 1K 的 Flash Lite Image 固定为官方允许的尺寸', () => {
    const request = previewModelProtocolRequest({
      baseUrl: GOOGLE_GEMINI_BASE_URL,
      protocol: protocolFor('gemini-3.1-flash-lite-image'),
      variables: {
        model: 'gemini-3.1-flash-lite-image',
        prompt: '产品海报',
        aspectRatio: '1:1',
        imageSize: '4K',
      },
    });

    expect(request.body).toMatchObject({
      response_format: { type: 'image', aspect_ratio: '1:1', image_size: '1K' },
    });
  });

  it('把 Google TTS 的 24kHz 单声道 PCM 封装成有效 WAV', async () => {
    const pcm = Uint8Array.from([0, 0, 255, 127]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      steps: [{ type: 'model_output', content: [{ type: 'audio', data: btoa(String.fromCharCode(...pcm)) }] }],
    })));

    const result = await submitModelProtocol({
      apiKey: 'secret',
      baseUrl: GOOGLE_GEMINI_BASE_URL,
      protocol: protocolFor('gemini-3.1-flash-tts-preview'),
      variables: { model: 'gemini-3.1-flash-tts-preview', prompt: '你好' },
    });
    const encoded = result.urls?.[0]?.split(',')[1] ?? '';
    const wav = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const view = new DataView(wav.buffer);

    expect(result.urls?.[0]).toMatch(/^data:audio\/wav;base64,/);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect([...wav.slice(44)]).toEqual([...pcm]);
  });

  it('轮询 Veo 并使用同一 Google 鉴权下载完成的视频', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ name: 'models/veo-3.1-generate-preview/operations/op-1' }))
      .mockResolvedValueOnce(jsonResponse({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{
              video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/video-1:download' },
            }],
          },
        },
      }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([0, 1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: GOOGLE_GEMINI_BASE_URL,
      protocol: protocolFor('veo-3.1-generate-preview'),
      variables: {
        model: 'veo-3.1-generate-preview',
        prompt: '海边日落的延时摄影',
        aspectRatio: '16:9',
      },
    });

    expect(result.urls).toEqual(['data:video/mp4;base64,AAECAw==']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('x-goog-api-key')).toBe('secret');
  });

  it('拒绝把 Google API Key 发送到响应注入的跨域结果地址', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ name: 'models/veo-3.1-generate-preview/operations/op-2' }))
      .mockResolvedValueOnce(jsonResponse({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: 'https://evil.example/video.mp4' } }],
          },
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeModelProtocol({
      apiKey: 'secret',
      baseUrl: GOOGLE_GEMINI_BASE_URL,
      protocol: protocolFor('veo-3.1-generate-preview'),
      variables: {
        model: 'veo-3.1-generate-preview',
        prompt: '测试',
        aspectRatio: '16:9',
      },
    })).rejects.toThrow('结果下载地址与厂商连接地址不同源');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
