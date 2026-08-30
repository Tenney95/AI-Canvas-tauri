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
} from '../../src/services/ai/apimartGen';
import { buildApimartSeedanceRequest, isApimartSeedanceModel } from '../../src/services/ai/apimartVideoModels';
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
