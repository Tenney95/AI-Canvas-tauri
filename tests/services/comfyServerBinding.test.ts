import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  storeState: {
    config: {
      comfyUIUrl: 'http://image-server:8188',
      comfyServers: [] as Array<{ id: string; name: string; url: string }>,
    },
    currentProjectId: 'p1',
    workflows: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('../../src/services/ai/httpTransport', () => ({
  corsSafeFetch: mocks.corsSafeFetch,
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => mocks.storeState },
}));
vi.mock('../../src/services/pollManager', () => ({
  savePendingTask: vi.fn(),
  updatePendingTask: vi.fn(),
  removePendingTask: vi.fn(),
  registerNodePolling: vi.fn(() => undefined),
  cleanupNodePolling: vi.fn(),
}));
vi.mock('../../src/services/nodeReferenceService', () => ({
  resolveNodeReferences: (value: string) => value,
}));

import { comfyBaseUrlFor, probeComfyServer } from '../../src/services/comfyServers';
import { executeComfyUIVideoGenerate } from '../../src/services/comfyWorkflowService';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeState.config.comfyUIUrl = 'http://image-server:8188';
  mocks.storeState.config.comfyServers = [
    { id: 'video-1', name: '视频服务器', url: 'http://video-server:8189/' },
  ];
  mocks.storeState.workflows = [
    {
      id: 'wf-video',
      name: '出片',
      category: 'ai-video',
      fileName: 'wan.json',
      fileContent: JSON.stringify({
        '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
        '3': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: 30 } },
      }),
      ioNodes: [{ nodeId: '1', title: '正向提示词', type: 'prompt' }],
      serverId: 'video-1',
      createdAt: 1,
    },
    { id: 'wf-image', name: '出图', category: 'ai-image', fileName: 'sd.json', fileContent: '{}', createdAt: 1 },
  ];
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/object_info/')) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    if (String(url).endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (String(url).includes('/history/')) {
      return jsonResponse({
        'prompt-1': {
          status: { completed: true },
          outputs: { '3': { gifs: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] } },
        },
      });
    }
    throw new Error(`未预期的请求：${url}`);
  });
});

describe('工作流绑定的 ComfyUI 服务端', () => {
  it('绑定了服务端就用绑定的地址，末尾斜杠去掉', () => {
    expect(comfyBaseUrlFor('wf-video')).toBe('http://video-server:8189');
  });

  it('没绑定、绑定的服务端已删除、或没传工作流时都回落到默认地址', () => {
    expect(comfyBaseUrlFor('wf-image')).toBe('http://image-server:8188');
    expect(comfyBaseUrlFor()).toBe('http://image-server:8188');
    // 服务端被删掉后，绑过它的工作流不能因为找不到地址就报错
    mocks.storeState.config.comfyServers = [];
    expect(comfyBaseUrlFor('wf-video')).toBe('http://image-server:8188');
  });

  it('提交与轮询都走绑定的那台服务端，不碰默认地址', async () => {
    await executeComfyUIVideoGenerate({
      prompt: '海边日落',
      model: 'wf',
      provider: 'comfyui',
      workflowId: 'wf-video',
      videoResolution: 480,
      seedanceRatio: '16:9',
      videoFps: 16,
      videoFrames: 81,
    });

    const urls = mocks.corsSafeFetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url === 'http://video-server:8189/prompt')).toBe(true);
    expect(urls.every((url) => !url.includes('image-server'))).toBe(true);
  });

  it('通过 system_stats 探测 ComfyUI 服务，并规范化末尾斜杠', async () => {
    mocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ system: {}, devices: [] }));

    await expect(probeComfyServer('  http://video-server:8189/  ')).resolves.toBe(true);
    expect(mocks.corsSafeFetch).toHaveBeenCalledWith(
      'http://video-server:8189/system_stats',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
    );
  });

  it('非法地址、非成功响应或请求失败都判定为不可用', async () => {
    await expect(probeComfyServer('')).resolves.toBe(false);
    await expect(probeComfyServer('file:///tmp/comfyui')).resolves.toBe(false);
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();

    mocks.corsSafeFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => '',
    });
    await expect(probeComfyServer('http://video-server:8189')).resolves.toBe(false);

    mocks.corsSafeFetch.mockRejectedValueOnce(new Error('offline'));
    await expect(probeComfyServer('http://video-server:8189')).resolves.toBe(false);

    mocks.corsSafeFetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => (
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    ));
    await expect(probeComfyServer('http://video-server:8189', { timeoutMs: 1 })).resolves.toBe(false);
  });
});
