import { beforeEach, describe, expect, it, vi } from 'vitest';

const pollingMocks = vi.hoisted(() => ({
  cleanupNodePolling: vi.fn(),
  registerNodePolling: vi.fn(() => new AbortController().signal),
  removePendingTask: vi.fn(),
  savePendingTask: vi.fn(),
  updatePendingTask: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  storeState: {
    config: {
      providers: {
        apimart: {
          apiKey: 'api-key',
          baseUrl: 'https://api.example.com',
        },
      },
    },
    currentProjectId: 'project-1',
  },
  uploadToRemote: vi.fn(),
}));

vi.mock('../../src/services/pollManager', () => pollingMocks);
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => serviceMocks.storeState },
}));
vi.mock('../../src/services/uploadService', () => ({
  isLocalImageUrl: (url: string) => url.startsWith('asset:') || url.includes('asset.localhost'),
  uploadToRemote: serviceMocks.uploadToRemote,
  resolveMediaReferenceUrl: async (url: string) => url,
}));

import {
  executeGeneralAsyncTask,
  generateApimartImagesBatch,
  generateApimartVideo,
} from '../../src/services/ai/apimartGen';
import { buildApimartSeedanceRequest, isApimartSeedanceModel } from '../../src/services/ai/apimartVideoModels';
import { apimartMediaProviderAdapter } from '../../src/services/ai/providers/apimartMedia';
import { APIMART_OMNI_MODELS, getApimartSeedanceCapability } from '../../src/services/ai/apimartVideoModels';
import { fetchProviderModelCatalog } from '../../src/services/ai/providerCatalogService';
import { assertVideoInputConstraints } from '../../src/services/ai/videoInputValidation';
import { buildImageCapabilityRequest } from '../../src/services/ai/mediaModelCapabilities';
import { getMediaModelOptions } from '../../src/components/nodes/shared/defaultModels';

describe('APIMart Omni 视频合同', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    pollingMocks.registerNodePolling.mockReturnValue(new AbortController().signal);
    serviceMocks.uploadToRemote.mockResolvedValue('https://upload.example/reference.png');
  });

  it.each(APIMART_OMNI_MODELS.map((model) => model.id))('提交 %s 到视频端点并读取轮询产物', async (model) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ task_id: 'omni-task', status: 'submitted' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: {
        status: 'completed', result: { videos: [{ url: ['https://cdn.example/omni.mp4'] }] },
      } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartVideo('api-key', 'https://api.example/v1', model, 'prompt', undefined, {
      duration: 6, resolution: '720p', ratio: '9:16',
    })).resolves.toEqual({ url: 'https://cdn.example/omni.mp4' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://api.example/v1/videos/generations', 'https://api.example/v1/tasks/omni-task?language=zh',
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ model, resolution: '720p', aspect_ratio: '9:16' });
    if (model.endsWith('-ext')) expect(body.duration).toBe(6);
    else expect(body).not.toHaveProperty('duration');
    expect(body).not.toHaveProperty('generate_audio');
  });

  it('Flash 首尾帧与参考图共存，合计上限含首尾帧', () => {
    const params = { firstFrameUrl: 'https://cdn.example/first.png', lastFrameUrl: 'https://cdn.example/last.png',
      imageUrls: ['https://cdn.example/ref.png'], resolution: '4K', duration: 5 };
    expect(buildApimartSeedanceRequest('gemini-omni-1.1-flash', '', params)).toEqual({
      model: 'gemini-omni-1.1-flash', prompt: '', resolution: '4k', aspect_ratio: '16:9',
      first_frame_image: params.firstFrameUrl, last_frame_image: params.lastFrameUrl, image_urls: params.imageUrls,
    });
    expect(() => buildApimartSeedanceRequest('gemini-omni-1.1-flash', '', {
      ...params, imageUrls: Array(9).fill('https://cdn.example/ref.png'),
    })).toThrow('合计最多 10 张');
    expect(() => buildApimartSeedanceRequest('gemini-omni-1.1-flash', '', {
      lastFrameUrl: params.lastFrameUrl,
    })).toThrow('必须同时提供首帧');
  });

  it('Ext 分开首帧和参考模式；视频输入省略时长；旧 ID 映射到新模型', () => {
    expect(buildApimartSeedanceRequest('apimart/Omni-Flash-Ext', 'prompt', {
      firstFrameUrl: 'https://cdn.example/first.png', duration: 8,
    })).toMatchObject({ model: 'gemini-omni-1.1-flash-ext', generation_type: 'frame', duration: 8,
      image_urls: ['https://cdn.example/first.png'] });
    const body = buildApimartSeedanceRequest('gemini-omni-1.1-flash-ext', 'prompt', {
      imageUrls: Array(3).fill('https://cdn.example/ref.png'),
      videoUrls: ['https://cdn.example/ref.mp4'], duration: 5,
    });
    expect(body).toMatchObject({ generation_type: 'reference', video_urls: ['https://cdn.example/ref.mp4'] });
    expect(body).not.toHaveProperty('duration');
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(() => buildApimartSeedanceRequest('gemini-omni-1.1-flash-ext', 'prompt', { duration: 5 })).toThrow('4 / 6 / 8 / 10');
    expect(() => buildApimartSeedanceRequest('gemini-omni-1.1-flash-ext', 'prompt', {
      imageUrls: Array(2).fill('https://cdn.example/ref.png'),
    })).toThrow('1 张或 3 张');
  });

  it('Preview 限制分辨率、图片数、视频数和音频输入', () => {
    const model = 'gemini-omni-flash-preview';
    expect(buildApimartSeedanceRequest(model, '', { imageUrls: Array(16).fill('https://cdn.example/ref.png') }))
      .toMatchObject({ resolution: '720p' });
    expect(() => buildApimartSeedanceRequest(model, 'prompt', { resolution: '1080p' })).toThrow('分辨率仅支持');
    expect(() => buildApimartSeedanceRequest(model, 'prompt', { imageUrls: Array(17).fill('https://cdn.example/ref.png') })).toThrow('最多 16 张');
    expect(() => buildApimartSeedanceRequest(model, 'prompt', { videoUrls: ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4'] })).toThrow('1 个参考视频');
    expect(() => buildApimartSeedanceRequest(model, 'prompt', { audioUrls: ['https://cdn.example/1.mp3'] })).toThrow('不支持参考音频');
    expect(() => buildApimartSeedanceRequest(model, 'prompt', { ratio: '1:1' })).toThrow('16:9 / 9:16');
  });

  it('经 Adapter 上传本地首尾帧并保留参考图，复用任务失败处理', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ task_id: 'omni-task' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { status: 'failed', error: { message: 'Omni failed' } } }));
    vi.stubGlobal('fetch', fetchMock);
    const referenceMedia = [
      { kind: 'image' as const, url: 'asset://localhost/first.png', origin: 'prompt' as const, role: 'first_frame' as const },
      { kind: 'image' as const, url: 'https://cdn.example/last.png', origin: 'prompt' as const, role: 'last_frame' as const },
      { kind: 'image' as const, url: 'https://cdn.example/ref.png', origin: 'prompt' as const, role: 'reference' as const },
    ];
    await expect(apimartMediaProviderAdapter.generateVideo?.({
      params: { provider: 'apimart', model: 'gemini-omni-1.1-flash', prompt: 'prompt', referenceMedia },
      prompt: 'prompt', resolveReferenceInput: async () => ({
        prompt: 'prompt', operation: 'image-to-video', imageUrls: referenceMedia.map((ref) => ref.url),
        videoUrls: [], audioUrls: [], references: referenceMedia,
      }),
    })).rejects.toThrow('Omni failed');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      first_frame_image: 'https://upload.example/reference.png', last_frame_image: 'https://cdn.example/last.png',
      image_urls: ['https://cdn.example/ref.png'],
    });
  });

  it('取消 Omni 提交时传播信号并清理任务', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = generateApimartVideo('key', 'https://api.example/v1', 'gemini-omni-1.1-flash', 'prompt', 'node-omni', {}, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(pollingMocks.cleanupNodePolling).toHaveBeenCalledWith('node-omni');
  });

  it.each([
    ['gemini-omni-1.1-flash', 11], ['gemini-omni-flash-preview', 25],
  ] as const)('按 %s 文档限制参考视频时长', async (model, durationSeconds) => {
    const capability = getApimartSeedanceCapability(model)!;
    await expect(assertVideoInputConstraints({
      prompt: 'prompt', operation: 'video-to-video', videoUrls: ['https://cdn.example/ref.mp4'], imageUrls: [], audioUrls: [],
    }, { inputConstraints: capability.inputConstraints }, model, {
      probeMediaMetadata: async () => ({ durationSeconds }),
    })).rejects.toThrow('不能超过');
  });

  it('远端旧目录不使新模型消失，Gemini 视频不误判成文本', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [
      { id: 'Omni-Flash-Ext' }, { id: 'gemini-omni-1.1-flash' },
    ] })));
    const result = await fetchProviderModelCatalog({ providerId: 'apimart', fallbackModels: [...APIMART_OMNI_MODELS], config: {
      name: 'APIMart', catalogId: 'apimart', apiKey: 'key', baseUrl: 'https://api.example/v1',
    } });
    expect(result.models.map((model) => model.id)).toEqual(APIMART_OMNI_MODELS.map((model) => model.id));
    expect(result.models.every((model) => model.category === 'video')).toBe(true);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('APIMart image polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    pollingMocks.registerNodePolling.mockReturnValue(new AbortController().signal);
    serviceMocks.uploadToRemote.mockResolvedValue('https://upload.example/reference.png');
  });

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])(
    '将 %s 从媒体目录路由到原生批量接口并收集四张图片',
    async (model) => {
      const option = getMediaModelOptions().find((item) => item.value === `apimart/${model}`);
      expect(option).toMatchObject({ provider: 'apimart', mediaKind: 'image' });
      if (!option) throw new Error('缺少内置模型');
      const imageUrls = Array.from({ length: 16 }, (_, index) => `https://ref.example/${index}.png`);
      const outputUrls = Array.from({ length: 4 }, (_, index) => `https://img.example/${index}.png`);
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ status: 'submitted', task_id: 'gpt-25-task' }] }))
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: {
          status: 'completed', result: { images: [{ url: outputUrls }] },
        } }));
      vi.stubGlobal('fetch', fetchMock);

      const batch = await apimartMediaProviderAdapter.generateImage?.({
        params: { model: option.value, provider: option.provider, prompt: '保留商品并替换背景', imageSize: '4K', aspectRatio: '16:9' },
        prompt: '保留商品并替换背景', imageUrls, requestedCount: 4,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/images/generations');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
        model, prompt: '保留商品并替换背景', resolution: '4k', size: '16:9', n: 4, image_urls: imageUrls,
      });
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/tasks/gpt-25-task?language=zh');
      expect(batch).toEqual({
        requestedCount: 4, failedCount: 0,
        results: outputUrls.map((url) => ({ url, width: 3840, height: 2160 })),
      });
    },
  );

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])(
    '%s 文生图保留自适应尺寸并将原生数量限制为四张',
    (model) => {
      const request = buildImageCapabilityRequest(`apimart/${model}`, '风景', {
        ratio: '自适应', resolution: '2K', count: 8,
      });
      expect(request?.body).toEqual({ model, prompt: '风景', size: 'auto', resolution: '2k', n: 4 });
      expect(request?.requestedCount).toBe(4);
    },
  );

  it.each([
    ['1K', '4:3', 1024, 768],
    ['2K', '3:2', 2048, 1360],
    ['4K', '1:1', 2880, 2880],
    ['4K', '9:21', 1648, 3840],
  ])('GPT Image 2.5 使用 %s / %s 对应的官方像素尺寸', (resolution, ratio, width, height) => {
    expect(buildImageCapabilityRequest('gpt-image-2.5-flare', '风景', {
      resolution: String(resolution), ratio: String(ratio),
    })?.dimensions).toEqual({ width, height });
  });

  it('GPT Image 2.5 在提交前拒绝超过十六张参考图', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartImagesBatch(
      'api-key', 'https://api.example.com', 'gpt-image-2.5-sunburst', '编辑',
      '2K', '1:1', { width: 2048, height: 2048 },
      Array.from({ length: 17 }, (_, index) => `https://ref.example/${index}.png`),
    )).rejects.toThrow('最多支持 16 张参考图');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops polling immediately when the task fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: [{ task_id: 'task-failed', status: 'submitted' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: {
          id: 'task-failed',
          status: 'failed',
          progress: 100,
          error: {
            code: 'task_failed',
            message: '安全违规：上游图像生成请求被拒绝',
            type: 'task_failed',
          },
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateApimartImagesBatch(
      'api-key',
      'https://api.example.com',
      'gpt-image',
      'prompt',
      '2K',
      '1:1',
      { width: 2048, height: 2048 },
    )).rejects.toThrow('APIMart 图片生成失败: 安全违规：上游图像生成请求被拒绝');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collects multiple images returned by one native batch task', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/images/generations')) {
        return jsonResponse({
          code: 200,
          data: [{ task_id: 'native-batch-task', status: 'submitted' }],
        });
      }
      return jsonResponse({
        code: 200,
        data: {
          status: 'completed',
          result: {
            images: [{ url: ['https://img.example/1.png', 'https://img.example/2.png'] }],
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const batch = await generateApimartImagesBatch(
      'api-key',
      'https://api.example.com',
      'qwen-image-2.0',
      'prompt',
      '2K',
      '1:1',
      { width: 2048, height: 2048 },
      [],
      2,
    );

    expect(batch.results.map((result) => result.url)).toEqual([
      'https://img.example/1.png',
      'https://img.example/2.png',
    ]);
    expect(batch.failedCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('polls every task id returned by one native batch submission', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/images/generations')) {
        return jsonResponse({
          code: 200,
          data: [
            { task_id: 'native-task-1', status: 'submitted' },
            { task_id: 'native-task-2', status: 'submitted' },
          ],
        });
      }
      const taskNumber = url.includes('native-task-2') ? 2 : 1;
      return jsonResponse({
        code: 200,
        data: {
          status: 'completed',
          result: { images: [{ url: `https://img.example/${taskNumber}.png` }] },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const batch = await generateApimartImagesBatch(
      'api-key',
      'https://api.example.com',
      'qwen-image-2.0',
      'prompt',
      '2K',
      '1:1',
      { width: 2048, height: 2048 },
      [],
      2,
      'node-1',
    );

    expect(batch.results.map((result) => result.url)).toEqual([
      'https://img.example/1.png',
      'https://img.example/2.png',
    ]);
    expect(pollingMocks.updatePendingTask).toHaveBeenCalledWith('node-1', {
      taskId: 'native-task-1',
      taskIds: ['native-task-1', 'native-task-2'],
      submitted: true,
    });
  });

  it('splits multi-image requests into independent tasks when the model has no native batch support', async () => {
    let submissionCount = 0;
    const submittedBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/images/generations')) {
        submissionCount += 1;
        submittedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({
          code: 200,
          data: [{ task_id: `split-task-${submissionCount}`, status: 'submitted' }],
        });
      }
      const taskNumber = url.includes('split-task-2') ? 2 : 1;
      return jsonResponse({
        code: 200,
        data: {
          status: 'completed',
          result: { images: [{ url: [`https://img.example/split-${taskNumber}.png`] }] },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const batch = await generateApimartImagesBatch(
      'api-key',
      'https://api.example.com',
      'gpt-image-2',
      'prompt',
      '1K',
      '1:1',
      { width: 1024, height: 1024 },
      [],
      2,
    );

    expect(submittedBodies).toHaveLength(2);
    expect(submittedBodies.every((body) => body.n === 1)).toBe(true);
    expect(batch.requestedCount).toBe(2);
    expect(batch.results.map((result) => result.url)).toEqual([
      'https://img.example/split-1.png',
      'https://img.example/split-2.png',
    ]);
    expect(batch.failedCount).toBe(0);
  });

  it('cleans up node polling when cancellation interrupts task submission', async () => {
    const controller = new AbortController();
    let submitSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      submitSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        submitSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const generation = generateApimartImagesBatch(
      'api-key',
      'https://api.example.com',
      'gpt-image',
      'prompt',
      '2K',
      '1:1',
      { width: 2048, height: 2048 },
      [],
      1,
      'node-1',
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    controller.abort();

    await expect(generation).rejects.toMatchObject({ name: 'AbortError' });
    expect(submitSignal?.aborted).toBe(true);
    expect(pollingMocks.cleanupNodePolling).toHaveBeenCalledWith('node-1');
    expect(pollingMocks.removePendingTask).toHaveBeenCalledWith('node-1');
  });
});

describe('APIMart video polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    pollingMocks.registerNodePolling.mockReturnValue(new AbortController().signal);
    serviceMocks.uploadToRemote.mockResolvedValue('https://upload.example/reference.png');
  });

  it('uses the documented Seedance 2.0 defaults while preserving an explicit audio opt-out', () => {
    expect(buildApimartSeedanceRequest(
      'apimart/doubao-seedance-2.0-fast',
      'prompt',
      { ratio: 'adaptive' },
    )).toEqual({
      model: 'doubao-seedance-2.0-fast',
      prompt: 'prompt',
      duration: 5,
      resolution: '720p',
      size: 'adaptive',
      generate_audio: true,
    });

    expect(buildApimartSeedanceRequest(
      'doubao-seedance-2.0-fast',
      'prompt',
      { resolution: '1080p', generateAudio: false },
    )).toMatchObject({
      resolution: '720p',
      generate_audio: false,
    });
  });

  it('uploads local references and stops polling immediately when the task fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: [{ task_id: 'task-video-failed', status: 'submitted' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: {
          id: 'task-video-failed',
          status: 'failed',
          progress: 100,
          error: {
            code: 'invalid_reference_image',
            message: '参考图片无法访问',
            type: 'task_failed',
          },
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apimartMediaProviderAdapter.generateVideo?.({
      params: {
        prompt: 'prompt',
        model: 'apimart/doubao-seedance-2.0-fast',
        provider: 'apimart',
        seedanceResolution: '720p',
        seedanceRatio: '16:9',
        seedanceDuration: 10,
        generateAudio: true,
      },
      prompt: 'prompt',
      resolveReferenceInput: async () => ({
        prompt: 'prompt',
        imageUrls: ['asset://localhost/reference.png'],
        videoUrls: ['https://cdn.example/reference.mp4'],
        audioUrls: ['https://cdn.example/reference.mp3'],
        operation: 'video-to-video',
      }),
    })).rejects.toThrow('APIMart 视频生成失败: 参考图片无法访问');

    expect(serviceMocks.uploadToRemote).toHaveBeenCalledWith(
      'asset://localhost/reference.png',
      'apimart',
      'image',
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const submitBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(submitBody).toMatchObject({
      model: 'doubao-seedance-2.0-fast',
      image_urls: ['https://upload.example/reference.png'],
      video_urls: ['https://cdn.example/reference.mp4'],
      audio_urls: ['https://cdn.example/reference.mp3'],
      resolution: '720p',
      size: '16:9',
      duration: 10,
      generate_audio: true,
    });
  });

  it('validates Seedance 2.0 video and audio reference limits', () => {
    expect(() => buildApimartSeedanceRequest(
      'doubao-seedance-2.0',
      'prompt',
      { videoUrls: ['1.mp4', '2.mp4', '3.mp4', '4.mp4'] },
    )).toThrow('最多支持 3 个参考视频');

    expect(() => buildApimartSeedanceRequest(
      'doubao-seedance-2.0-mini',
      'prompt',
      { audioUrls: ['1.mp3', '2.mp3', '3.mp3', '4.mp3'] },
    )).toThrow('最多支持 3 个参考音频');
  });

  it('rejects video-to-video for Seedance generations without that capability', () => {
    expect(() => buildApimartSeedanceRequest(
      'doubao-seedance-1-5-pro',
      'prompt',
      { videoUrls: ['reference.mp4'], operation: 'video-to-video' },
    )).toThrow('不支持 video-to-video');
  });
});

describe('APIMart Seedance 2.5 video', () => {
  it('clamps duration to 30s and keeps resolution within 480p/720p', () => {
    expect(buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      { resolution: '1080p', duration: 30 },
    )).toMatchObject({
      model: 'doubao-seedance-2.5',
      duration: 30,
      resolution: '720p',
      watermark: false,
    });
  });

  it('allows up to 30 images / 10 videos / 10 audio references', () => {
    const body = buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      {
        imageUrls: Array.from({ length: 30 }, (_, i) => `https://cdn.example/img${i}.png`),
        videoUrls: Array.from({ length: 10 }, (_, i) => `https://cdn.example/video${i}.mp4`),
        audioUrls: Array.from({ length: 10 }, (_, i) => `https://cdn.example/audio${i}.mp3`),
      },
    );
    expect(body?.image_urls).toHaveLength(30);
    expect(body?.video_urls).toHaveLength(10);
    expect(body?.audio_urls).toHaveLength(10);
  });

  it('rejects more than 30 image references', () => {
    expect(() => buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      { imageUrls: Array.from({ length: 31 }, (_, i) => `https://cdn.example/img${i}.png`) },
    )).toThrow('最多支持 30 张参考图');
  });

  it('supports standalone audio reference (no image or video)', () => {
    expect(buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      { audioUrls: ['https://cdn.example/bgm.mp3'] },
    )).toMatchObject({
      model: 'doubao-seedance-2.5',
      audio_urls: ['https://cdn.example/bgm.mp3'],
    });
  });

  it('writes first/last frame into image_with_roles instead of image_urls', () => {
    const body = buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      {
        imageWithRoles: [
          { url: 'https://cdn.example/first.jpg', role: 'first_frame' },
          { url: 'https://cdn.example/last.jpg', role: 'last_frame' },
        ],
      },
    );
    expect(body).toMatchObject({
      model: 'doubao-seedance-2.5',
      image_with_roles: [
        { url: 'https://cdn.example/first.jpg', role: 'first_frame' },
        { url: 'https://cdn.example/last.jpg', role: 'last_frame' },
      ],
    });
    expect(body).not.toHaveProperty('image_urls');
  });

  it('keeps first frame and plain reference images together in image_with_roles', () => {
    const body = buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      {
        imageWithRoles: [
          { url: 'https://cdn.example/first.jpg', role: 'first_frame' },
          { url: 'https://cdn.example/role.png', role: 'reference_image' },
        ],
      },
    );
    expect(body).toMatchObject({
      image_with_roles: [
        { url: 'https://cdn.example/first.jpg', role: 'first_frame' },
        { url: 'https://cdn.example/role.png', role: 'reference_image' },
      ],
    });
    expect(body).not.toHaveProperty('image_urls');
  });

  it('rejects mixing image_with_roles with reference media', () => {
    expect(() => buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      {
        imageWithRoles: [{ url: 'https://cdn.example/first.jpg', role: 'first_frame' }],
        imageUrls: ['https://cdn.example/ref.png'],
      },
    )).toThrow('首尾帧与参考素材不能同时使用');
  });

  it('defaults size to adaptive (2.5 文档默认值)', () => {
    expect(buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      {},
    )).toMatchObject({ size: 'adaptive' });
  });
});

describe('APIMart MiniMax-H3 video', () => {
  it('builds a text-to-video request with H3-specific resolution and watermark', () => {
    expect(buildApimartSeedanceRequest(
      'MiniMax-H3',
      'prompt',
      { resolution: '768P', ratio: '9:16' },
    )).toEqual({
      model: 'MiniMax-H3',
      prompt: 'prompt',
      duration: 5,
      resolution: '768P',
      aspect_ratio: '9:16',
      watermark: false,
    });
  });

  it('maps first/last frame fields and reference images for MiniMax-H3', () => {
    expect(buildApimartSeedanceRequest(
      'apimart/MiniMax-H3',
      'prompt',
      { firstFrameUrl: 'https://cdn.example/start.png', lastFrameUrl: 'https://cdn.example/end.png' },
    )).toMatchObject({
      model: 'MiniMax-H3',
      first_frame_image: 'https://cdn.example/start.png',
      last_frame_image: 'https://cdn.example/end.png',
    });
  });

  it('supports multimodal reference (image + video + audio) for MiniMax-H3', () => {
    expect(buildApimartSeedanceRequest(
      'MiniMax-H3-Context-IR',
      'prompt',
      {
        imageUrls: ['https://cdn.example/char.png'],
        videoUrls: ['https://cdn.example/motion.mp4'],
        audioUrls: ['https://cdn.example/voice.mp3'],
      },
    )).toMatchObject({
      model: 'MiniMax-H3-Context-IR',
      image_urls: ['https://cdn.example/char.png'],
      video_urls: ['https://cdn.example/motion.mp4'],
      audio_urls: ['https://cdn.example/voice.mp3'],
    });
  });

  it('rejects mixing first/last frame with reference media for MiniMax-H3', () => {
    expect(() => buildApimartSeedanceRequest(
      'MiniMax-H3',
      'prompt',
      { firstFrameUrl: 'https://cdn.example/start.png', imageUrls: ['https://cdn.example/char.png'] },
    )).toThrow('首尾帧与参考素材不能同时使用');
  });

  it('rejects standalone audio references for MiniMax-H3', () => {
    expect(() => buildApimartSeedanceRequest(
      'MiniMax-H3-Regeneration',
      'prompt',
      { audioUrls: ['https://cdn.example/voice.mp3'] },
    )).toThrow('参考音频不能单独使用');
  });

  it('normalizes MiniMax-H3 model id case-insensitively', () => {
    expect(isApimartSeedanceModel('minimax-h3')).toBe(true);
    expect(isApimartSeedanceModel('MiniMax-H3')).toBe(true);
    expect(isApimartSeedanceModel('apimart/MiniMax-H3-Regeneration')).toBe(true);
  });
});

describe('legacy general media requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['videos', '/videos/generations'],
    ['audios', '/audio/generations'],
  ] as const)('submits %s to the matching media endpoint', async (resultField, endpoint) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      [resultField]: [{ url: `https://cdn.example/${resultField}` }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeGeneralAsyncTask(
      'api-key',
      'https://api.example.com/v1',
      'model-id',
      'prompt',
      resultField,
      'general-provider',
    )).resolves.toEqual({ url: `https://cdn.example/${resultField}` });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.com/v1${endpoint}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
