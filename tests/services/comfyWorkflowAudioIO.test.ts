/**
 * comfyWorkflowAudioIO — 回归测试：ComfyUI audio IO injection。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  storeState: {
    config: { comfyUIUrl: 'http://comfy.test:8188' },
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
  resolveNodeReferencesAsync: async (value: string) => value,
}));

import { executeComfyUIAudioGenerate } from '../../src/services/comfyWorkflowService';

/** 只含一个内置 LoadAudio 与一个 SaveAudio 的 API 格式工作流 */
function workflowJson(audioInputs: Record<string, unknown> = { audio: 'placeholder.mp3' }) {
  return JSON.stringify({
    '1': { class_type: 'LoadAudio', inputs: audioInputs, _meta: { title: '参考音色' } },
    '2': { class_type: 'SaveAudio', inputs: { audio: ['1', 0] } },
  });
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function registerWorkflow(fileContent: string, ioNodes: Array<{ nodeId: string; title: string; type: string }>) {
  mocks.storeState.workflows = [{
    id: 'wf-1',
    name: '音色克隆',
    category: 'ai-audio',
    fileName: 'clone.json',
    fileContent,
    ioNodes,
    createdAt: 1,
  }];
}

/** 依次应答：/upload/image → /prompt → /history/:id */
function stubComfyEndpoints() {
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/upload/image')) {
      return jsonResponse({ name: 'upload_123.mp3', subfolder: '', type: 'input' });
    }
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (url.includes('/history/')) {
      return jsonResponse({
        'prompt-1': {
          status: { completed: true },
          // 内置 SaveAudio 输出的是单数 audio 键
          outputs: { '2': { audio: [{ filename: 'out.flac', subfolder: '', type: 'output' }] } },
        },
      });
    }
    throw new Error(`未预期的请求：${url}`);
  });
}

function submittedWorkflow(): Record<string, { inputs: Record<string, unknown> }> {
  const call = mocks.corsSafeFetch.mock.calls.find(([url]) => String(url).endsWith('/prompt'));
  return JSON.parse(String((call?.[1] as RequestInit).body)).prompt;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeState.config.comfyUIUrl = 'http://comfy.test:8188';
  stubComfyEndpoints();
});

describe('ComfyUI audio IO injection', () => {
  it('uploads connected audio and writes the filename into the LoadAudio node', async () => {
    registerWorkflow(workflowJson(), [{ nodeId: '1', title: '参考音色', type: 'audio' }]);

    const result = await executeComfyUIAudioGenerate(
      { prompt: '你终于来了。', model: 'wf', provider: 'comfyui', workflowId: 'wf-1' },
      undefined,
      ['data:audio/mpeg;base64,QUJD'],
    );

    expect(result).toEqual({ url: expect.stringContaining('out.flac') });
    // 音频走 ComfyUI 唯一的通用上传路由，落到 input 目录
    expect(mocks.corsSafeFetch).toHaveBeenCalledWith(
      'http://comfy.test:8188/upload/image',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(submittedWorkflow()['1'].inputs.audio).toBe('upload_123.mp3');
  });

  it('deduplicates an explicit audio also present in ordinary references', async () => {
    registerWorkflow(workflowJson(), [{ nodeId: '1', title: '参考音色', type: 'audio' }]);

    await executeComfyUIAudioGenerate(
      {
        prompt: '台词',
        model: 'wf',
        provider: 'comfyui',
        workflowId: 'wf-1',
        workflowInputs: { '1': 'data:audio/wav;base64,QUJD' },
      },
      undefined,
      ['data:audio/wav;base64,QUJD'],
    );

    const uploadCalls = mocks.corsSafeFetch.mock.calls.filter(
      ([url]) => String(url).endsWith('/upload/image'),
    );
    // 显式赋值只上传一次，兜底音频不再重复注入
    expect(uploadCalls).toHaveLength(1);
    // 上传的是显式赋值的 wav，而不是兜底的 mp3
    const uploaded = (uploadCalls[0][1] as RequestInit).body as FormData;
    expect((uploaded.get('image') as File).name).toMatch(/\.wav$/);
    expect(submittedWorkflow()['1'].inputs.audio).toBe('upload_123.mp3');
  });

  it('rejects audio references when only host-path inputs exist', async () => {
    registerWorkflow(
      workflowJson({ audio_file: '/host/path/voice.wav' }),
      [{ nodeId: '1', title: 'VHS 路径音频', type: 'audio' }],
    );

    await expect(executeComfyUIAudioGenerate(
      { prompt: '台词', model: 'wf', provider: 'comfyui', workflowId: 'wf-1' },
      undefined, ['data:audio/mpeg;base64,QUJD'],
    )).rejects.toThrow('音频上传槽不足');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('infers audio upload IO from API JSON when the saved IO list is absent', async () => {
    registerWorkflow(workflowJson(), []);

    await executeComfyUIAudioGenerate(
      { prompt: '台词', model: 'wf', provider: 'comfyui', workflowId: 'wf-1' },
      undefined,
      ['data:audio/mpeg;base64,QUJD'],
    );

    expect(submittedWorkflow()['1'].inputs.audio).toBe('upload_123.mp3');
  });
});

it('无音频加载槽时不静默丢弃音频', async () => {
  registerWorkflow(JSON.stringify({ '2': { class_type: 'SaveAudio', inputs: {} } }), []);
  await expect(executeComfyUIAudioGenerate({ prompt: '台词', model: 'wf', provider: 'comfyui', workflowId: 'wf-1' }, undefined,
    ['data:audio/wav;base64,YQ=='])).rejects.toThrow('音频上传槽不足');
  expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
});

it('音频流程拒绝只有封面的输出，保留视频容器的已有兼容', async () => {
  registerWorkflow(JSON.stringify({ '2': { class_type: 'SaveAudio', inputs: {} } }), []);
  let filename = 'cover.png';
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (url.includes('/history/')) return jsonResponse({ 'prompt-1': {
      status: { completed: true }, outputs: { '2': { images: [{ filename, type: 'output' }] } },
    } });
    if (url.includes('/object_info')) return jsonResponse({});
    throw new Error(`未预期的请求：${url}`);
  });
  const params = { prompt: '台词', model: 'wf', provider: 'comfyui', workflowId: 'wf-1' };
  await expect(executeComfyUIAudioGenerate(params)).rejects.toMatchObject({ name: 'ComfyOutputUnavailableError' });
  filename = 'with-audio.mp4';
  await expect(executeComfyUIAudioGenerate(params)).resolves.toMatchObject({ url: expect.stringContaining('with-audio.mp4') });
});
