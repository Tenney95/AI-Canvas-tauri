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
}));

import {
  executeGeneralAsyncTask,
  generateApimartImagesBatch,
} from '../../src/services/ai/apimartGen';
import { apimartMediaProviderAdapter } from '../../src/services/ai/providers/apimartMedia';

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
      }),
    })).rejects.toThrow('APIMart 视频生成失败: 参考图片无法访问');

    expect(serviceMocks.uploadToRemote).toHaveBeenCalledWith(
      'asset://localhost/reference.png',
      'apimart',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const submitBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(submitBody).toMatchObject({
      model: 'doubao-seedance-2.0-fast',
      image_urls: ['https://upload.example/reference.png'],
      resolution: '720p',
      size: '16:9',
      duration: 10,
      generate_audio: true,
    });
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
