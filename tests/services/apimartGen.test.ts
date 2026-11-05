/**
 * apimartGen — 回归测试：APIMart 错误凭据隔离。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pollingMocks = vi.hoisted(() => {
  const receipts = new Map<string, { projectId: string; nodeId: string; taskId: string; attemptId: string }>();
  const removePendingTask = vi.fn((nodeId: string, _taskId?: string, _attemptId?: string) => { receipts.delete(nodeId); });
  return {
  receipts,
  cleanupNodePolling: vi.fn(() => true),
  VIDEO_POLL_MAX_DURATION_MS: 30 * 60 * 1000,
  pauseMediaTask: vi.fn((receipt: { taskId: string }, _error?: unknown, reason?: string) => Object.assign(new Error('任务查询已暂停'),
    { name: 'MediaTaskPausedError', taskReceipt: receipt, reason: reason ?? 'query_interrupted' })),
  getMediaTaskReceipt: vi.fn((nodeId: string) => receipts.get(nodeId)),
  registerNodePolling: vi.fn(() => new AbortController().signal),
  removePendingTask,
  removeFailedMediaTask: vi.fn((receipt: { nodeId: string; taskId: string; attemptId: string }) => {
    removePendingTask(receipt.nodeId, receipt.taskId, receipt.attemptId);
  }),
  savePendingTask: vi.fn((task: { nodeId: string; projectId: string; taskId: string }) => {
    const receipt = { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: 'attempt' };
    receipts.set(task.nodeId, receipt); return receipt;
  }),
  updatePendingTask: vi.fn((nodeId: string, patch: { taskId?: string }) => {
    const current = receipts.get(nodeId); if (!current) return undefined;
    const receipt = { ...current, ...(patch.taskId === undefined ? {} : { taskId: patch.taskId }) };
    receipts.set(nodeId, receipt); return receipt;
  }),
}; });

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
  fetchApimartTask,
  generateApimartImagesBatch,
  generateApimartVideo,
} from '../../src/services/ai/apimartGen';
import { buildApimartSeedanceRequest, isApimartSeedanceModel } from '../../src/services/ai/apimartVideoModels';
import { apimartMediaProviderAdapter } from '../../src/services/ai/providers/apimartMedia';
import { APIMART_OMNI_MODELS, APIMART_UPDATED_VIDEO_MODELS, getApimartSeedanceCapability } from '../../src/services/ai/apimartVideoModels';
import { fetchProviderModelCatalog } from '../../src/services/ai/providerCatalogService';
import { assertVideoInputConstraints } from '../../src/services/ai/videoInputValidation';
import { buildImageCapabilityRequest } from '../../src/services/ai/mediaModelCapabilities';
import { getMediaModelOptions } from '../../src/components/nodes/shared/defaultModels';
import { resolveMediaDownloadRequest } from '../../src/services/ai/mediaDownloadAccess';

describe('APIMart 错误凭据隔离', () => {
  const apiKey = 'fixture~! private/key=';
  const echoed = () => [apiKey, encodeURIComponent(apiKey), new URLSearchParams({ key: apiKey }).toString().slice(4)].join(' | ');
  const calls = {
    image: (nodeId?: string) => generateApimartImagesBatch(apiKey, 'https://api.example/v1', 'gpt-image-2', 'prompt',
      '1K', '1:1', { width: 1024, height: 1024 }, [], 1, nodeId),
    video: (nodeId?: string) => generateApimartVideo(apiKey, 'https://api.example/v1', 'seedance-2.5', 'prompt', nodeId),
    general: (nodeId?: string) => executeGeneralAsyncTask(apiKey, 'https://api.example/v1', 'video-model', 'prompt', 'videos', 'apimart', nodeId),
  };
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); pollingMocks.receipts.clear(); });

  it.each(['image', 'video', 'general'] as const)('%s 的 HTTP 拒绝先脱敏再截断，且不重发提交', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`${'x'.repeat(197)}${apiKey}`, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await calls[kind]('rejected-node').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`${'x'.repeat(197)}[RE`);
    expect((error as Error).message).not.toContain('fixture');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pollingMocks.removePendingTask).toHaveBeenCalledWith('rejected-node', '', 'attempt');
  });

  it.each(['image', 'video', 'general'] as const)('%s 的网络错误在进入暂停回执前脱敏，保持未知提交语义', async (kind) => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(`Failed to fetch ${echoed()}`));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calls[kind]('unknown-node')).rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    const safeError = pollingMocks.pauseMediaTask.mock.calls[0][1] as Error;
    expect(safeError).toBeInstanceOf(TypeError);
    expect(safeError.message).toContain('[REDACTED]');
    expect(safeError.message).not.toContain(apiKey);
    expect(safeError.message).not.toContain(encodeURIComponent(apiKey));
    expect(safeError.message).not.toContain(new URLSearchParams({ key: apiKey }).toString().slice(4));
    expect(pollingMocks.receipts.get('unknown-node')).toMatchObject({ taskId: '', attemptId: 'attempt' });
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['image', 'video', 'general'] as const)('%s 收到明确限流拒绝时直接失败，不保留空任务', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'rate_limit_exceeded', message: echoed() } }, 429));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calls[kind]('rejected-node')).rejects.toMatchObject({ status: 429, definitiveFailure: true });
    expect(pollingMocks.removeFailedMediaTask).toHaveBeenCalledWith({
      projectId: 'project-1', nodeId: 'rejected-node', taskId: '', attemptId: 'attempt',
    });
    expect(pollingMocks.pauseMediaTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['image', 'video', 'general'] as const)('%s 的 HTTP 200 failed 响应直接失败且不查询或重发', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'failed', error: { message: echoed() } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calls[kind]('failed-node')).rejects.toMatchObject({ definitiveFailure: true, message: expect.stringContaining('[REDACTED]') });
    expect(pollingMocks.removeFailedMediaTask).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'failed-node', taskId: '', attemptId: 'attempt' }));
    expect(pollingMocks.pauseMediaTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['image', 'video'] as const)('APIMart %s 的专有业务拒绝码直接失败', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 402, message: '余额不足' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calls[kind]('business-node')).rejects.toMatchObject({ definitiveFailure: true, message: '余额不足' });
    expect(pollingMocks.removeFailedMediaTask).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'business-node', taskId: '' }));
    expect(pollingMocks.pauseMediaTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('通用自定义接口不把未声明的数字 code 当成确定拒绝', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 402, message: '自定义状态' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calls.general('custom-node')).rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    expect(pollingMocks.removeFailedMediaTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['image', 'video'] as const)('APIMart %s 的服务端业务码不证明请求未受理', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 503, message: '服务暂时不可用' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calls[kind]('server-node')).rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    expect(pollingMocks.removeFailedMediaTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['image', 'video', 'general'] as const)('%s 的网关超时即使正文含 failed 也保留未知状态', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'failed', error: { code: 'invalid_request_error' } }, 504));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calls[kind]('timeout-node')).rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    expect(pollingMocks.removeFailedMediaTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['root', 'data'] as const)('查询器在返回 %s 终态错误对象前脱敏，不携带任意错误属性', async (shape) => {
    const task = { status: 'failed', error: { message: echoed(), code: `code ${apiKey}`, type: 'task_failed', private: apiKey } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(shape === 'data' ? { code: 200, data: task } : task)));
    const result = await fetchApimartTask(apiKey, 'https://api.example/v1', 'original-task');
    expect(result).toMatchObject({ status: 'failed', error: { code: 'code [REDACTED]', type: 'task_failed' } });
    expect(JSON.stringify(result.error)).not.toContain(apiKey);
    expect(JSON.stringify(result.error)).not.toContain(encodeURIComponent(apiKey));
    expect(result.error).not.toHaveProperty('private');
  });

  it.each(['network', 'http', 'terminal'] as const)('视频 %s 查询错误不泄露凭据，保持原任务身份与终态语义', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'original-task' }] }));
    if (kind === 'network') fetchMock.mockRejectedValueOnce(new TypeError(echoed()));
    else if (kind === 'http') fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: echoed() } }, 401));
    else fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: 'failed', error: { message: echoed() } } }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await calls.video('query-node').catch((value: unknown) => value);
    if (kind === 'terminal') {
      expect(error).toMatchObject({ name: 'PollTaskFailedError', message: expect.stringContaining('[REDACTED]') });
      expect(pollingMocks.removePendingTask).toHaveBeenCalledWith('query-node', 'original-task', 'attempt');
    } else {
      expect(error).toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: { taskId: 'original-task', attemptId: 'attempt' } });
      const detail = pollingMocks.pauseMediaTask.mock.calls[0][1] as Error;
      expect(detail.message).toContain('[REDACTED]');
      expect(detail.message).not.toContain(apiKey);
      expect(pollingMocks.receipts.get('query-node')).toMatchObject({ taskId: 'original-task', attemptId: 'attempt' });
    }
    expect((error as Error).message).not.toContain(apiKey);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

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
    })).resolves.toEqual({ url: 'https://cdn.example/omni.mp4',
      mediaDownloadAccess: { providerConfigId: 'apimart', origin: 'https://api.example', auth: { type: 'bearer' } } });
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

  it('取消 Omni 提交时传播信号并保留提交未知记录', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = generateApimartVideo('key', 'https://api.example/v1', 'gemini-omni-1.1-flash', 'prompt', 'node-omni', {}, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    expect(pollingMocks.cleanupNodePolling).toHaveBeenCalledWith('node-omni', expect.any(AbortSignal));
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('APIMart image polling', () => {
  it('Grok 官方 2.0 使用稳定响应版本和独立幂等键，保持多图参考顺序', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ task_id: 'grok-image' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { status: 'completed', result: { images: [{ url: ['https://cdn.example/result.png'] }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    const refs = ['https://cdn.example/a.png', 'https://cdn.example/b.png'];
    await generateApimartImagesBatch('key', 'https://api.example/v1', 'grok-imagine-image-2.0', 'edit', '2K', '16:9', { width: 100, height: 100 }, refs);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-APIMart-Response-Version': '2026-07-27', 'Idempotency-Key': expect.any(String) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'grok-imagine-image-2.0', image_urls: refs, aspect_ratio: '16:9', resolution: '2k' });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    pollingMocks.registerNodePolling.mockReturnValue(new AbortController().signal);
    serviceMocks.uploadToRemote.mockResolvedValue('https://upload.example/reference.png');
  });

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])(
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
        params: { model: option.value, provider: option.provider, prompt: '保留商品并替换背景',
          imageSize: '4K', aspectRatio: '16:9', imageBackground: 'transparent' },
        prompt: '保留商品并替换背景', imageUrls, requestedCount: 4,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/images/generations');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
        model, prompt: '保留商品并替换背景', resolution: '4k', size: '16:9', n: 4, image_urls: imageUrls,
        quality: 'auto', background: 'transparent', output_format: 'png',
      });
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/tasks/gpt-25-task?language=zh');
      const mediaDownloadAccess = { providerConfigId: 'apimart', origin: 'https://api.example.com', auth: { type: 'bearer' } };
      expect(batch).toEqual({
        requestedCount: 4, failedCount: 0, allTasksSettled: true,
        mediaDownloadAccess,
        results: outputUrls.map((url) => ({ url, width: 3840, height: 2160, mediaDownloadAccess })),
      });
    },
  );

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])(
    '%s 文生图保留自适应尺寸并将原生数量限制为四张',
    (model) => {
      const request = buildImageCapabilityRequest(`apimart/${model}`, '风景', {
        ratio: '自适应', resolution: '2K', count: 8,
      });
      expect(request?.body).toEqual({ model, prompt: '风景', size: 'auto', resolution: '2k', quality: 'auto', n: 4 });
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

  it.each(['gpt-image-2.5-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])('%s 在提交前拒绝超过十六张参考图', async (model) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartImagesBatch(
      'api-key', 'https://api.example.com', model, '编辑',
      '2K', '1:1', { width: 2048, height: 2048 },
      Array.from({ length: 17 }, (_, index) => `https://ref.example/${index}.png`),
    )).rejects.toThrow('最多支持 16 张参考图');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])('%s 发送用户质量，默认不添加背景或格式参数，并沿原任务查询', async (model) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ task_id: 'gpt-26-task' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { status: 'completed',
        result: { images: [{ url: ['https://cdn.example/result.png'] }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    await generateApimartImagesBatch('gpt-26-fixture', 'https://api.example.com', model, 'portrait',
      '2K', '9:16', { width: 1, height: 1 }, [], 1, undefined, undefined, 'max');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      model, prompt: 'portrait', n: 1, size: '9:16', resolution: '2k', quality: 'max',
    });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer gpt-26-fixture' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/tasks/gpt-26-task?language=zh');
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
    }, '', 'attempt');
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

    await expect(generation).rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    expect(submitSignal?.aborted).toBe(true);
    expect(pollingMocks.cleanupNodePolling).toHaveBeenCalledWith('node-1', expect.any(AbortSignal));
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
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
  it('supports the updated 1080p tier and 30 second duration', () => {
    expect(buildApimartSeedanceRequest(
      'doubao-seedance-2.5',
      'prompt',
      { resolution: '1080p', duration: 30 },
    )).toMatchObject({
      model: 'doubao-seedance-2.5',
      duration: 30,
      resolution: '1080p',
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

describe('APIMart 新视频模型', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it.each(APIMART_UPDATED_VIDEO_MODELS.map((model) => model.id))('%s 通过 Adapter 提交视频端点并轮询', async (model) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ task_id: 'new-video', status: 'submitted' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { status: 'completed', result: { videos: [{ url: ['https://cdn.example/result.mp4'] }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateVideo?.({
      params: { provider: 'apimart', model: `apimart/${model}`, prompt: 'prompt' }, prompt: 'prompt',
      resolveReferenceInput: async () => ({ prompt: 'prompt', imageUrls: [], videoUrls: [], audioUrls: [], operation: 'text-to-video' }),
    })).resolves.toEqual({ url: 'https://cdn.example/result.mp4',
      mediaDownloadAccess: { providerConfigId: 'apimart', origin: 'https://api.example.com', auth: { type: 'bearer' } } });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['https://api.example.com/videos/generations', 'https://api.example.com/tasks/new-video?language=zh']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model });
  });

  it('FLUX 3 映射分辨率与单个续写视频，不发送错误的 video_urls 字段', () => {
    const request = buildApimartSeedanceRequest('flux-3-video', 'continue', { resolution: '1080p', duration: 20, videoUrls: ['https://cdn.example/source.mp4'], generateAudio: false });
    expect(request).toMatchObject({ resolution: 'fhd', duration: 20, video_url: 'https://cdn.example/source.mp4', audio: false });
    expect(request).not.toHaveProperty('video_urls');
    expect(() => buildApimartSeedanceRequest('flux-3-video', 'prompt', { duration: 21 })).toThrow('时长');
  });

  it('HappyHorse 编辑省略时长与比例，1.1 拒绝视频输入', () => {
    const request = buildApimartSeedanceRequest('happyhorse-1.0', 'edit', { videoUrls: ['https://cdn.example/source.mp4'] });
    expect(request).toMatchObject({ video_url: 'https://cdn.example/source.mp4' });
    expect(request).not.toHaveProperty('duration');
    expect(request).not.toHaveProperty('aspect_ratio');
    expect(() => buildApimartSeedanceRequest('happyhorse-1.1', 'edit', { videoUrls: ['https://cdn.example/source.mp4'] })).toThrow('参考视频');
  });

  it('Wan 3 保留普通图片参考语义与显式帧角色，拒绝混用', () => {
    expect(buildApimartSeedanceRequest('wan3.0-video', 'prompt', { imageUrls: ['https://cdn.example/ref.png'], duration: -1 }))
      .toMatchObject({ generation_type: 'reference', duration: -1, image_urls: ['https://cdn.example/ref.png'] });
    expect(buildApimartSeedanceRequest('wan3.0-video-prime', 'prompt', { imageWithRoles: [{ url: 'https://cdn.example/first.png', role: 'first_frame' }] }))
      .toMatchObject({ image_with_roles: [{ url: 'https://cdn.example/first.png', role: 'first_frame' }] });
    expect(() => buildApimartSeedanceRequest('wan3.0-video', 'prompt', { firstFrameUrl: 'https://cdn.example/first.png', imageUrls: ['https://cdn.example/ref.png'] })).toThrow('不能同时使用');
  });

  it('Kling Turbo 只接受显式首帧，Pixverse 首尾帧只接受 5/8 秒', () => {
    expect(() => buildApimartSeedanceRequest('kling-3.0-turbo', 'prompt', { imageUrls: ['https://cdn.example/ref.png'] })).toThrow('设置为首帧');
    expect(buildApimartSeedanceRequest('kling-3.0-turbo', '', { firstFrameUrl: 'https://cdn.example/first.png' }))
      .toMatchObject({ first_frame_image: 'https://cdn.example/first.png' });
    const frames = { firstFrameUrl: 'https://cdn.example/first.png', lastFrameUrl: 'https://cdn.example/last.png' };
    expect(() => buildApimartSeedanceRequest('pixverse-v6', 'prompt', { ...frames, duration: 6 })).toThrow('5 或 8');
    expect(buildApimartSeedanceRequest('pixverse-v6', 'prompt', { imageUrls: ['https://cdn.example/ref.png'] }))
      .toHaveProperty('img_references', ['https://cdn.example/ref.png']);
  });

  it('Seedance 新 ID 支持自动时长，旧 ID 保持可用', () => {
    expect(buildApimartSeedanceRequest('seedance-2.5', 'prompt', { duration: -1, resolution: '1080p' }))
      .toMatchObject({ model: 'seedance-2.5', duration: -1, resolution: '1080p' });
    expect(isApimartSeedanceModel('apimart/doubao-seedance-2.5')).toBe(true);
  });

  it('新视频模型失败不重提，保留服务端错误', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ task_id: 'failed-task' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { status: 'failed', error: { message: '素材不合法' } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartVideo('key', 'https://api.example/v1', 'wan3.0-video', 'prompt')).rejects.toThrow('素材不合法');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('通过 Adapter 保留 Wan 3 首尾帧角色和普通图片的参考语义', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ task_id: 'wan-frame' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { status: 'completed', result: { videos: [{ url: ['https://cdn.example/result.mp4'] }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    const referenceMedia = [
      { kind: 'image' as const, role: 'first_frame' as const, url: 'https://cdn.example/first.png', origin: 'prompt' as const },
      { kind: 'image' as const, role: 'last_frame' as const, url: 'https://cdn.example/last.png', origin: 'prompt' as const },
    ];
    await apimartMediaProviderAdapter.generateVideo?.({ params: { provider: 'apimart', model: 'apimart/wan3.0-video', prompt: 'prompt', referenceMedia }, prompt: 'prompt',
      resolveReferenceInput: async () => ({ prompt: 'prompt', imageUrls: referenceMedia.map((ref) => ref.url), videoUrls: [], audioUrls: [], operation: 'image-to-video', references: referenceMedia }),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).image_with_roles).toEqual([
      { url: referenceMedia[0].url, role: 'first_frame' }, { url: referenceMedia[1].url, role: 'last_frame' },
    ]);
  });

  it('取消新视频任务后停止轮询，不再次付费提交', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(() => { controller.abort(); return Promise.resolve(jsonResponse({ code: 200, data: [{ task_id: 'new-video' }] })); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartVideo('key', 'https://api.example/v1', 'flux-3-video', 'prompt', undefined, {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      'MiniMax-H3',
      'prompt',
      {
        imageUrls: ['https://cdn.example/char.png'],
        videoUrls: ['https://cdn.example/motion.mp4'],
        audioUrls: ['https://cdn.example/voice.mp3'],
      },
    )).toMatchObject({
      model: 'MiniMax-H3',
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
      'MiniMax-H3',
      'prompt',
      { audioUrls: ['https://cdn.example/voice.mp3'] },
    )).toThrow('参考音频不能单独使用');
  });

  it('normalizes MiniMax-H3 model id case-insensitively', () => {
    expect(isApimartSeedanceModel('minimax-h3')).toBe(true);
    expect(isApimartSeedanceModel('MiniMax-H3')).toBe(true);
    // 旧配置仍保留底层兼容能力，但新目录不会再把特殊操作展示为普通视频模型。
    expect(isApimartSeedanceModel('apimart/MiniMax-H3-Regeneration')).toBe(true);
  });
});

describe('媒体任务交付回执', () => {
  beforeEach(() => { vi.clearAllMocks(); pollingMocks.receipts.clear(); vi.unstubAllGlobals(); });

  it('图片拿到结果后保留真实 ID，等待调用方保存和回填确认', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'image-delivery' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'completed', result: { images: [{ url: ['https://cdn.example/image.png'] }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateApimartImagesBatch('key', 'https://api.example/v1', 'gpt-image', 'prompt', '2K', '1:1',
      { width: 2048, height: 2048 }, [], 1, 'image-node');
    expect(result.taskReceipt).toMatchObject({ nodeId: 'image-node', taskId: 'image-delivery', attemptId: 'attempt' });
    expect(result.results[0].taskReceipt).toEqual(result.taskReceipt);
    const mediaDownloadAccess = { providerConfigId: 'apimart', origin: 'https://api.example', auth: { type: 'bearer' } };
    expect(result.mediaDownloadAccess).toEqual(mediaDownloadAccess);
    expect(result.results[0].mediaDownloadAccess).toEqual(mediaDownloadAccess);
    expect(pollingMocks.savePendingTask).toHaveBeenCalledWith(expect.objectContaining({ mediaDownloadAccess }));
    expect(result.allTasksSettled).toBe(true);
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
    expect(pollingMocks.updatePendingTask).toHaveBeenCalledWith('image-node', { mediaRecoveryState: 'delivery_pending' }, 'image-delivery', 'attempt');
  });

  it('批量图片保留原连接描述，外部 CDN 下载不附厂商凭据', async () => {
    const urls = ['https://upload.apimart.ai/f/image/first.png', 'https://cdn.example/second.png'];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'batch-delivery' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'completed', result: { images: [{ url: urls }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateApimartImagesBatch('private-fixture-key', 'https://api.apimart.ai/v1', 'gpt-image', 'prompt',
      '2K', '1:1', { width: 2048, height: 2048 }, [], 2, 'image-node');
    const mediaDownloadAccess = { providerConfigId: 'apimart', origin: 'https://api.apimart.ai', auth: { type: 'bearer' } };
    expect(result.results.map((item) => item.mediaDownloadAccess)).toEqual([mediaDownloadAccess, mediaDownloadAccess]);
    expect(pollingMocks.savePendingTask).toHaveBeenCalledWith(expect.objectContaining({ mediaDownloadAccess }));
    for (const item of result.results) {
      await expect(resolveMediaDownloadRequest(item.url, item.mediaDownloadAccess)).resolves.toEqual({ url: item.url });
    }
    expect(JSON.stringify(result)).not.toContain('private-fixture-key');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('视频首次交付和待续任务保留同一下载连接身份', async () => {
    const url = 'https://api.example/v1/videos/original/content';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'video-delivery' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'completed', result: { videos: [{ url: [url] }] } } })));
    const result = await generateApimartVideo('private-fixture-key', 'https://api.example/v1', 'doubao-seedance-2.5', 'prompt', 'video-node');
    const mediaDownloadAccess = { providerConfigId: 'apimart', origin: 'https://api.example', auth: { type: 'bearer' } };
    expect(result).toMatchObject({ url, mediaDownloadAccess, taskReceipt: { taskId: 'video-delivery' } });
    expect(pollingMocks.savePendingTask).toHaveBeenCalledWith(expect.objectContaining({ mediaDownloadAccess }));
    expect(JSON.stringify(result)).not.toContain('private-fixture-key');
  });

  it.each(['sync', 'async'] as const)('通用 %s 结果使用真实连接 ID 和来源域名', async (mode) => {
    const url = 'https://custom.example/result.mp4';
    const fetchMock = mode === 'sync'
      ? vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ url }] }))
      : vi.fn().mockResolvedValueOnce(jsonResponse({ task_id: 'general-delivery' }))
        .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { videos: [{ url }] } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await executeGeneralAsyncTask('private-fixture-key', 'https://custom.example/v1', 'video', 'prompt', 'videos',
      'original-custom-connection', 'video-node');
    const mediaDownloadAccess = { providerConfigId: 'original-custom-connection', origin: 'https://custom.example', auth: { type: 'bearer' } };
    expect(result).toMatchObject({ url, mediaDownloadAccess });
    expect(pollingMocks.savePendingTask).toHaveBeenCalledWith(expect.objectContaining({
      providerConfigId: 'original-custom-connection', mediaDownloadAccess,
    }));
    expect(JSON.stringify(result)).not.toContain('private-fixture-key');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('图片查询断网保留原任务，不自动重提', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'image-network' }] }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartImagesBatch('key', 'https://api.example/v1', 'gpt-image', 'prompt', '2K', '1:1',
      { width: 2048, height: 2048 }, [], 1, 'image-node')).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'image-network' },
    });
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('批次中其他任务还未确认时不交付成功子集，也不清除恢复记录', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ task_id: 'ready' }, { task_id: 'disconnected' }] });
      if (url.includes('/disconnected?')) throw new TypeError('Failed to fetch');
      return jsonResponse({ data: { status: 'completed', result: { images: [{ url: ['https://cdn.example/ready.png'] }] } } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartImagesBatch('key', 'https://api.example/v1', 'gpt-image', 'prompt', '2K', '1:1',
      { width: 2048, height: 2048 }, [], 2, 'image-node')).rejects.toMatchObject({ name: 'MediaTaskPausedError' });
    expect(pollingMocks.updatePendingTask).toHaveBeenCalledWith('image-node', expect.objectContaining({ taskIds: ['ready', 'disconnected'] }), '', 'attempt');
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/images/generations'))).toHaveLength(1);
  });

  it('一个查询断网时中止同批慢查询的本地等待，保留全部上游任务', async () => {
    let slowSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/images/generations')) return Promise.resolve(jsonResponse({ data: [{ task_id: 'slow' }, { task_id: 'offline' }] }));
      if (url.includes('/offline?')) return Promise.reject(new TypeError('Failed to fetch'));
      slowSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('本地查询已中止', 'AbortError')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartImagesBatch('key', 'https://api.example/v1', 'gpt-image', 'prompt', '2K', '1:1',
      { width: 2048, height: 2048 }, [], 2, 'image-node')).rejects.toMatchObject({ name: 'MediaTaskPausedError' });
    expect(slowSignal?.aborted).toBe(true);
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});

describe('legacy general media requests', () => {
  it('retains a known video task on query HTTP 504 without sending another POST', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ task_id: 'slow-task' }))
      .mockResolvedValueOnce(new Response('', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeGeneralAsyncTask('key', 'https://api.example/v1', 'video', 'prompt', 'videos', 'custom', 'node'))
      .rejects.toMatchObject({ name: 'MediaTaskPausedError' });
    expect(pollingMocks.updatePendingTask).toHaveBeenCalledWith('node', { taskId: 'slow-task', submitted: true }, '', 'attempt');
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('retains an APIMart task when its query times out', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'apimart-slow' }] }))
      .mockResolvedValueOnce(new Response('', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateApimartVideo('key', 'https://api.example/v1', 'wan3.0-video', 'prompt', 'node'))
      .rejects.toMatchObject({ name: 'MediaTaskPausedError' });
    expect(pollingMocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
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
    )).resolves.toEqual({ url: `https://cdn.example/${resultField}`,
      mediaDownloadAccess: { providerConfigId: 'general-provider', origin: 'https://api.example.com', auth: { type: 'bearer' } } });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.com/v1${endpoint}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
