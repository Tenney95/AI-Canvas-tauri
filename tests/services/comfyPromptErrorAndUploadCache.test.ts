import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  storeState: {
    config: { comfyUIUrl: 'http://comfy.test:8188' },
    currentProjectId: 'p1',
    workflows: [] as Array<Record<string, unknown>>,
  },
  cancelNodePolling: vi.fn(),
  getPendingTasksForProject: vi.fn(),
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
  cancelNodePolling: mocks.cancelNodePolling,
  getPendingTasksForProject: mocks.getPendingTasksForProject,
}));
vi.mock('../../src/services/nodeReferenceService', () => ({
  resolveNodeReferences: (value: string) => value,
}));

import {
  cancelComfyUINodeTask,
  executeComfyUIGenerate,
  formatComfyPromptError,
} from '../../src/services/comfyWorkflowService';

/** 两个 LoadImage 共用同一张参考图，用来看重复上传 */
const WORKFLOW_JSON = JSON.stringify({
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '占位' } },
  '10': { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } },
  '11': { class_type: 'LoadImage', inputs: { image: 'b.png', upload: 'image' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['10', 0] } },
});

const IO_NODES = [
  { nodeId: '6', title: '提示词', type: 'prompt' },
  { nodeId: '10', title: '参考图 A', type: 'image' },
  { nodeId: '11', title: '参考图 B', type: 'image' },
];

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function registerWorkflow() {
  mocks.storeState.workflows = [{
    id: 'wf-1',
    name: '双参考图',
    category: 'ai-image',
    fileName: 'two-refs.json',
    fileContent: WORKFLOW_JSON,
    ioNodes: IO_NODES,
    defaultNodes: { prompt: '6', image: '10' },
    createdAt: 1,
  }];
}

function uploadCalls() {
  return mocks.corsSafeFetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/image'));
}

beforeEach(() => {
  vi.clearAllMocks();
  registerWorkflow();
  mocks.getPendingTasksForProject.mockReturnValue([]);
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/upload/image')) return jsonResponse({ name: 'upload_x.png', subfolder: '', type: 'input' });
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (url.includes('/history/')) {
      return jsonResponse({
        'prompt-1': {
          status: { completed: true },
          outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
        },
      });
    }
    throw new Error(`未预期的请求：${url}`);
  });
});

describe('ComfyUI 任务终止', () => {
  const pendingTask = {
    nodeId: 'node-1',
    projectId: 'p1',
    nodeType: 'ai-image',
    provider: 'comfyui',
    taskId: 'prompt-1',
    taskType: 'comfyui',
    baseUrl: 'http://comfy.test:8188/',
    submitted: true,
  };

  it('优先调用按 prompt_id 原子终止的 job API', async () => {
    mocks.getPendingTasksForProject.mockReturnValue([pendingTask]);
    mocks.corsSafeFetch.mockResolvedValue(jsonResponse({ cancelled: true }));

    await cancelComfyUINodeTask('node-1');

    expect(mocks.cancelNodePolling).toHaveBeenCalledWith('node-1');
    expect(mocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(mocks.corsSafeFetch).toHaveBeenCalledWith(
      'http://comfy.test:8188/api/jobs/prompt-1/cancel',
      { method: 'POST' },
    );
  });

  it('旧版 ComfyUI 的排队任务只按 id 从队列删除', async () => {
    mocks.getPendingTasksForProject.mockReturnValue([pendingTask]);
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/jobs/')) return { ok: false, status: 404, text: async () => '' };
      if (url.endsWith('/queue')) {
        const call = mocks.corsSafeFetch.mock.calls.at(-1);
        const init = call?.[1] as RequestInit | undefined;
        if (init?.method === 'POST') return jsonResponse({});
        return jsonResponse({ queue_running: [], queue_pending: [[0, 'prompt-1', {}]] });
      }
      throw new Error(`未预期的请求：${url}`);
    });

    await cancelComfyUINodeTask('node-1');

    const deleteCall = mocks.corsSafeFetch.mock.calls.find(([url, init]) => (
      String(url).endsWith('/queue') && (init as RequestInit | undefined)?.method === 'POST'
    ));
    expect(JSON.parse(String((deleteCall?.[1] as RequestInit).body))).toEqual({ delete: ['prompt-1'] });
    expect(mocks.corsSafeFetch.mock.calls.some(([url]) => String(url).endsWith('/interrupt'))).toBe(false);
  });

  it('旧版 ComfyUI 仅在目标任务确实运行时发送定向 interrupt', async () => {
    mocks.getPendingTasksForProject.mockReturnValue([pendingTask]);
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/jobs/')) return { ok: false, status: 404, text: async () => '' };
      if (url.endsWith('/queue')) {
        return jsonResponse({ queue_running: [[0, 'prompt-1', {}]], queue_pending: [] });
      }
      if (url.endsWith('/interrupt')) return jsonResponse({});
      throw new Error(`未预期的请求：${url}`);
    });

    await cancelComfyUINodeTask('node-1');

    const interruptCall = mocks.corsSafeFetch.mock.calls.find(([url]) => String(url).endsWith('/interrupt'));
    expect(JSON.parse(String((interruptCall?.[1] as RequestInit).body))).toEqual({ prompt_id: 'prompt-1' });
  });

  it('尚未提交到 ComfyUI 时只终止本地请求', async () => {
    mocks.getPendingTasksForProject.mockReturnValue([{ ...pendingTask, taskId: '', submitted: false }]);

    await cancelComfyUINodeTask('node-1');

    expect(mocks.cancelNodePolling).toHaveBeenCalledWith('node-1');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });
});

const baseParams = { prompt: '一只猫', model: 'wf', provider: 'comfyui', workflowId: 'wf-1' };

describe('ComfyUI 上传缓存', () => {
  it('同一份媒体喂给两个节点只上传一次', async () => {
    // 唯一内容，避免和别的用例共用缓存条目
    const image = 'data:image/png;base64,' + btoa('upload-cache-same-media');

    await executeComfyUIGenerate(baseParams, undefined, [image, image]);

    expect(uploadCalls()).toHaveLength(1);
    // 两个节点都拿到同一个上传结果
    const submitted = JSON.parse(String((mocks.corsSafeFetch.mock.calls
      .find(([url]) => String(url).endsWith('/prompt'))?.[1] as RequestInit).body)).prompt;
    expect(submitted['10'].inputs.image).toBe('upload_x.png');
    expect(submitted['11'].inputs.image).toBe('upload_x.png');
  });

  it('重复生成不再重传同一张参考图', async () => {
    const image = 'data:image/png;base64,' + btoa('upload-cache-across-runs');

    await executeComfyUIGenerate(baseParams, undefined, [image]);
    expect(uploadCalls()).toHaveLength(1);

    vi.clearAllMocks();
    await executeComfyUIGenerate(baseParams, undefined, [image]);
    expect(uploadCalls()).toHaveLength(0);
  });

  it('内容不同就照常各传各的', async () => {
    const first = 'data:image/png;base64,' + btoa('upload-cache-distinct-1');
    const second = 'data:image/png;base64,' + btoa('upload-cache-distinct-2');

    await executeComfyUIGenerate(baseParams, undefined, [first, second]);

    expect(uploadCalls()).toHaveLength(2);
  });
});

describe('ComfyUI 任务消失', () => {
  /** history 查不到、queue 里也没有：ComfyUI 重启过或队列被清空 */
  function stubVanishedTask() {
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
      if (url.includes('/history/')) return jsonResponse({});
      if (url.endsWith('/queue')) return jsonResponse({ queue_running: [], queue_pending: [] });
      throw new Error(`未预期的请求：${url}`);
    });
  }

  it('连续几轮查不到就判失败，不再干等到一小时超时', async () => {
    stubVanishedTask();
    vi.useFakeTimers();
    try {
      const pending = executeComfyUIGenerate(baseParams).then(
        () => null,
        (error: Error) => error,
      );
      // 首轮立即执行，之后每 3 秒一轮；跑满确认轮次即可
      await vi.advanceTimersByTimeAsync(3000 * 5);
      const error = await pending;
      expect(error?.message).toContain('找不到该任务');
    } finally {
      vi.useRealTimers();
    }
  });

  it('还在队列里就继续等，不误判', async () => {
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
      if (url.includes('/history/')) return jsonResponse({});
      // 队列项形如 [优先级, prompt_id, ...]
      if (url.endsWith('/queue')) return jsonResponse({ queue_running: [[0, 'prompt-1', {}]], queue_pending: [] });
      throw new Error(`未预期的请求：${url}`);
    });
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = executeComfyUIGenerate(baseParams).then(
        () => { settled = true; return null; },
        (error: Error) => { settled = true; return error; },
      );
      await vi.advanceTimersByTimeAsync(3000 * 5);
      expect(settled).toBe(false);
      // 收尾：别把没结束的轮询留到下个用例
      mocks.corsSafeFetch.mockImplementation(async (url: string) => {
        if (url.includes('/history/')) {
          return jsonResponse({
            'prompt-1': {
              status: { completed: true },
              outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
            },
          });
        }
        return jsonResponse({});
      });
      await vi.advanceTimersByTimeAsync(3000 * 2);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatComfyPromptError', () => {
  it('把 node_errors 翻成哪个节点的哪个输入不行', () => {
    const body = JSON.stringify({
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
      node_errors: {
        '14': {
          class_type: 'CheckpointLoaderSimple',
          errors: [{
            type: 'value_not_in_list',
            message: 'Value not in list',
            details: "ckpt_name: 'sd_xl.safetensors' not in []",
            extra_info: { input_name: 'ckpt_name' },
          }],
        },
      },
    });

    const message = formatComfyPromptError(400, body);

    expect(message).toContain('Prompt outputs failed validation');
    expect(message).toContain('节点 #14 CheckpointLoaderSimple');
    expect(message).toContain('ckpt_name');
    expect(message).toContain('Value not in list');
  });

  it('节点太多时只列前 5 个并给出剩余数量', () => {
    const nodeErrors: Record<string, unknown> = {};
    for (let index = 1; index <= 7; index += 1) {
      nodeErrors[String(index)] = { class_type: 'X', errors: [{ message: '坏了' }] };
    }
    const message = formatComfyPromptError(400, JSON.stringify({ node_errors: nodeErrors }));

    expect(message).toContain('节点 #5');
    expect(message).not.toContain('节点 #6');
    expect(message).toContain('还有 2 个节点报错');
  });

  it('返回的不是 JSON 时退回原文截断', () => {
    expect(formatComfyPromptError(502, '<html>Bad Gateway</html>')).toContain('Bad Gateway');
    expect(formatComfyPromptError(500, '')).toBe('ComfyUI 拒绝了工作流 (500)');
  });
});

describe('ComfyUI 参考媒体取回通道', () => {
  it('http(s) 参考图走 Rust 通道，不用会被 CORS 拦掉的裸 fetch', async () => {
    const remote = `http://comfy.test:8188/view?filename=up-${Date.now()}.png&type=output`;
    const nativeFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', nativeFetch);

    const previous = mocks.corsSafeFetch.getMockImplementation()!;
    mocks.corsSafeFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === remote) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'image/png' }),
          blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        };
      }
      return previous(url, init);
    });

    try {
      await executeComfyUIGenerate(baseParams, undefined, [remote]);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(nativeFetch).not.toHaveBeenCalled();
    expect(uploadCalls()).toHaveLength(1);
  });
});
