import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  createProgress: vi.fn(),
  waitUntilReady: vi.fn(),
  bindPrompt: vi.fn(),
  closeProgress: vi.fn(),
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
  getPendingTasksForProject: vi.fn(() => []),
}));
vi.mock('../../src/services/nodeReferenceService', () => ({
  resolveNodeReferences: (value: string) => value,
}));
vi.mock('../../src/services/comfyProgress', () => ({
  createComfyProgressSession: mocks.createProgress,
}));

import { executeComfyUIVideoGenerate } from '../../src/services/comfyWorkflowService';

/** 提示词节点 + Wan 风格 latent 节点（width/height/length）+ 合成节点（frame_rate） */
function registerWorkflow() {
  mocks.storeState.workflows = [{
    id: 'wf-1',
    name: '本地出片',
    category: 'ai-video',
    fileName: 'wan.json',
    fileContent: JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 't-1' }, _meta: { title: '正向提示词' } },
      // 默认值刻意和用例里选的参数都不一样，漏注入就会被断言抓到
      '2': { class_type: 'WanImageToVideo', inputs: { width: 1280, height: 720, length: 33 } },
      '3': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: 30 } },
    }),
    ioNodes: [{ nodeId: '1', title: '正向提示词', type: 'prompt' }],
    createdAt: 1,
  }];
}

/** 用别的节点组合覆盖默认工作流 */
function registerNodes(nodes: Record<string, unknown>) {
  mocks.storeState.workflows = [{
    id: 'wf-1',
    name: '本地出片',
    category: 'ai-video',
    fileName: 'x.json',
    fileContent: JSON.stringify(nodes),
    ioNodes: [],
    createdAt: 1,
  }];
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/** /object_info/{class} 的返回：输入声明是 { 名字: [类型, 配置] }，combo 的类型就是可选值数组 */
function objectInfo(classType: string, inputs: Record<string, unknown>) {
  return { [classType]: { input: { required: inputs } } };
}

function submittedWorkflow(): Record<string, { inputs: Record<string, unknown> }> {
  const call = mocks.corsSafeFetch.mock.calls.find(([url]) => String(url).endsWith('/prompt'));
  return JSON.parse(String((call?.[1] as RequestInit).body)).prompt;
}

/** 按类型登记 /object_info/{class} 的应答；没登记的类型一律 404，等价于问不到 */
let objectInfoByClass: Record<string, unknown> = {};
/** 节点声明在服务里按 baseUrl 缓存，每个用例换个地址免得互相串味 */
let comfyPort = 8188;

beforeEach(() => {
  vi.clearAllMocks();
  registerWorkflow();
  objectInfoByClass = {};
  mocks.storeState.config.comfyUIUrl = `http://comfy.test:${++comfyPort}`;
  mocks.waitUntilReady.mockResolvedValue(undefined);
  mocks.createProgress.mockReturnValue({
    clientId: 'test-client', requestId: 'test-request',
    waitUntilReady: mocks.waitUntilReady, bindPrompt: mocks.bindPrompt, close: mocks.closeProgress,
  });
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
    const objectInfoMatch = /\/object_info\/(.+)$/.exec(String(url));
    if (objectInfoMatch) {
      const classType = decodeURIComponent(objectInfoMatch[1]);
      const info = objectInfoByClass[classType];
      return info ? jsonResponse(info) : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (url.includes('/history/')) {
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

describe('ComfyUI checks the caller lease immediately before /prompt', () => {
  it.each((['upload', 'paramspec', 'progressready'] as const)
    .flatMap((stage) => (['stale', 'abort'] as const).map((failure) => ({ stage, failure }))))(
    'blocks submission after $failure during $stage', async ({ stage, failure }) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let waiting = false;
      let stale = false;
      const controller = new AbortController();
      const beforeSubmit = vi.fn(async () => { if (stale) throw new Error('caller input lease revoked'); });
      const defaultFetch = mocks.corsSafeFetch.getMockImplementation()!;
      mocks.corsSafeFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (stage === 'upload' && url.endsWith('/upload/image')) {
          waiting = true; await gate;
          return jsonResponse({ name: 'reference.mp4', subfolder: '', type: 'input' });
        }
        if (stage === 'paramspec' && url.endsWith('/object_info/WanImageToVideo')) {
          waiting = true; await gate;
        }
        return defaultFetch(url, init);
      });
      if (stage === 'progressready') mocks.waitUntilReady.mockImplementationOnce(async () => { waiting = true; await gate; });
      if (stage === 'upload') {
        const workflow = mocks.storeState.workflows[0];
        const workflowObj = JSON.parse(workflow.fileContent as string);
        workflowObj['4'] = { class_type: 'VHS_LoadVideo', inputs: { video: 'old.mp4' } };
        workflow.fileContent = JSON.stringify(workflowObj);
        workflow.ioNodes = [
          { nodeId: '1', title: '正向提示词', type: 'prompt' },
          { nodeId: '4', title: '参考视频', type: 'video' },
        ];
      }
      const generation = executeComfyUIVideoGenerate({
        prompt: '保留运镜', model: 'wf', provider: 'comfyui', workflowId: 'wf-1', nodeId: 'replica-segment',
        videoFps: 24, videoFrames: 121, seedanceDuration: 5,
      }, controller.signal, [], stage === 'upload' ? { videoUrls: ['data:video/mp4;base64,YQ=='] } : {}, beforeSubmit);
      await vi.waitFor(() => expect(waiting).toBe(true));
      if (failure === 'abort') controller.abort(); else stale = true;
      release();
      await expect(generation).rejects.toThrow(failure === 'abort' ? /取消|abort/iu : 'caller input lease revoked');
      expect(beforeSubmit).toHaveBeenCalledTimes(failure === 'abort' ? 0 : 1);
      expect(mocks.corsSafeFetch.mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
      expect(mocks.corsSafeFetch.mock.calls.some(([url]) => String(url).includes('/history/'))).toBe(false);
      expect(mocks.bindPrompt).not.toHaveBeenCalled();
    },
  );

  it('checks cancellation again after an asynchronous caller lease callback', async () => {
    const controller = new AbortController();
    const beforeSubmit = vi.fn(async () => { await Promise.resolve(); controller.abort(); });
    await expect(executeComfyUIVideoGenerate({
      prompt: '保留运镜', model: 'wf', provider: 'comfyui', workflowId: 'wf-1', nodeId: 'replica-segment',
    }, controller.signal, [], {}, beforeSubmit)).rejects.toThrow(/取消|abort/iu);
    expect(beforeSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.corsSafeFetch.mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
    expect(mocks.closeProgress).toHaveBeenCalledTimes(1);
  });

  it('keeps the injected workflow and returned video when the caller lease succeeds', async () => {
    const beforeSubmit = vi.fn(async () => undefined);
    await expect(executeComfyUIVideoGenerate({
      prompt: '海边日落', model: 'wf', provider: 'comfyui', workflowId: 'wf-1', nodeId: 'replica-segment',
      videoResolution: 480, seedanceRatio: '16:9', videoFps: 16, videoFrames: 81,
    }, undefined, [], {}, beforeSubmit)).resolves.toEqual({ url: expect.stringContaining('/view?filename=out.mp4') });
    expect(beforeSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntilReady.mock.invocationCallOrder[0]).toBeLessThan(beforeSubmit.mock.invocationCallOrder[0]);
    const promptCallIndex = mocks.corsSafeFetch.mock.calls.findIndex(([url]) => String(url).endsWith('/prompt'));
    expect(beforeSubmit.mock.invocationCallOrder[0]).toBeLessThan(mocks.corsSafeFetch.mock.invocationCallOrder[promptCallIndex]);
    const submitted = submittedWorkflow();
    expect(submitted['1'].inputs.text).toBe('海边日落');
    expect(submitted['2'].inputs).toMatchObject({ width: 480, height: 272, length: 81 });
    expect(submitted['3'].inputs.frame_rate).toBe(16);
    expect(mocks.bindPrompt).toHaveBeenCalledWith('prompt-1');
    expect(mocks.closeProgress).toHaveBeenCalledTimes(1);
  });
});

describe('ComfyUI 视频参数注入', () => {
  it('@ 了提示词节点也照样把分辨率、帧率、帧数写进工作流', async () => {
    await executeComfyUIVideoGenerate({
      prompt: '海边日落',
      model: 'wf',
      provider: 'comfyui',
      workflowId: 'wf-1',
      // 用户 @ 了提示词 IO 节点：以前会导致参数节点被整个跳过
      workflowInputs: { '1': '海边日落' },
      videoResolution: 480,
      seedanceRatio: '16:9',
      videoFps: 16,
      videoFrames: 81,
    });

    const submitted = submittedWorkflow();
    expect(submitted['1'].inputs.text).toBe('海边日落');
    // 480 是长边，短边按 16:9 换算并对齐到 8
    expect(submitted['2'].inputs).toMatchObject({ width: 480, height: 272, length: 81 });
    expect(submitted['3'].inputs.frame_rate).toBe(16);
  });

  it('自定义长边按比例换算后注入', async () => {
    await executeComfyUIVideoGenerate({
      prompt: '竖屏',
      model: 'wf',
      provider: 'comfyui',
      workflowId: 'wf-1',
      videoResolution: 384,
      seedanceRatio: '9:16',
      videoFps: 24,
      videoFrames: 121,
    });

    expect(submittedWorkflow()['2'].inputs).toMatchObject({ width: 216, height: 384, length: 121 });
  });

  it('num_frames / video_frames 也算帧数字段', async () => {
    registerNodes({
      // WanVideoWrapper 全家都用 num_frames
      '1': { class_type: 'WanVideoEmptyEmbeds', inputs: { width: 832, height: 480, num_frames: 81 } },
      // SVD 用 video_frames，且 fps 是数字
      '2': { class_type: 'SVD_img2vid_Conditioning', inputs: { width: 1024, height: 576, video_frames: 14, fps: 6 } },
    });

    await executeComfyUIVideoGenerate({
      prompt: 'p', model: 'wf', provider: 'comfyui', workflowId: 'wf-1',
      videoResolution: 640, seedanceRatio: '16:9', videoFps: 20, videoFrames: 101,
    });

    const submitted = submittedWorkflow();
    expect(submitted['1'].inputs).toMatchObject({ width: 640, height: 360, num_frames: 101 });
    expect(submitted['2'].inputs).toMatchObject({ video_frames: 101, fps: 20 });
  });

  it('连线过来的帧率不会被数字冲掉', async () => {
    registerNodes({
      '1': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: ['9', 0] } },
      '2': { class_type: 'CreateVideo', inputs: { fps: 24 } },
    });

    await executeComfyUIVideoGenerate({
      prompt: 'p', model: 'wf', provider: 'comfyui', workflowId: 'wf-1',
      videoResolution: 640, videoFps: 30, videoFrames: 61,
    });

    const submitted = submittedWorkflow();
    expect(submitted['1'].inputs.frame_rate).toEqual(['9', 0]);
    expect(submitted['2'].inputs.fps).toBe(30);
  });

  it('输入素材节点和裁剪节点上的同名参数不动', async () => {
    registerNodes({
      '1': { class_type: 'VHS_LoadVideo', inputs: { force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0 } },
      '2': { class_type: 'Video Slice', inputs: { start_time: 0, duration: 0 } },
    });
    objectInfoByClass['Video Slice'] = objectInfo('Video Slice', { duration: ['FLOAT', { min: 0 }] });

    await executeComfyUIVideoGenerate({
      prompt: 'p', model: 'wf', provider: 'comfyui', workflowId: 'wf-1',
      videoResolution: 1280, videoFps: 24, videoFrames: 121, seedanceDuration: 5,
    });

    const submitted = submittedWorkflow();
    expect(submitted['1'].inputs).toMatchObject({ force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0 });
    expect(submitted['2'].inputs.duration).toBe(0);
  });

  it('API 节点的比例、档位、时长按节点声明的可选值写', async () => {
    registerNodes({
      '1': {
        class_type: 'KlingTextToVideoNode',
        inputs: { aspect_ratio: '1:1', resolution: '720p', duration: 5 },
      },
    });
    objectInfoByClass.KlingTextToVideoNode = objectInfo('KlingTextToVideoNode', {
      aspect_ratio: [['16:9', '9:16', '1:1']],
      resolution: [['540p', '720p', '1080p']],
      duration: [[5, 10]],
    });

    await executeComfyUIVideoGenerate({
      prompt: 'p', model: 'wf', provider: 'comfyui', workflowId: 'wf-1',
      videoResolution: 1920, seedanceRatio: '9:16', videoFps: 24, videoFrames: 241, seedanceDuration: 9,
    });

    // 1080p 是长边 1920 最近的一档；9 秒不在可选值里，退到最近的 10
    expect(submittedWorkflow()['1'].inputs).toMatchObject({
      aspect_ratio: '9:16', resolution: '1080p', duration: 10,
    });
  });

  it('问不到节点声明时，比例和档位一律不写', async () => {
    registerNodes({
      '1': { class_type: 'SomeVendorVideoNode', inputs: { aspect_ratio: '1:1', resolution: '720p' } },
    });

    await executeComfyUIVideoGenerate({
      prompt: 'p', model: 'wf', provider: 'comfyui', workflowId: 'wf-1',
      videoResolution: 1920, seedanceRatio: '9:16', videoFps: 24, videoFrames: 121,
    });

    expect(submittedWorkflow()['1'].inputs).toMatchObject({ aspect_ratio: '1:1', resolution: '720p' });
  });

  it('ResolutionSelector 的比例按节点自己的档位写法写', async () => {
    registerNodes({
      '1': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '1:1 (Square)', megapixels: 0.4 } },
    });
    objectInfoByClass.ResolutionSelector = objectInfo('ResolutionSelector', {
      aspect_ratio: [['1:1 (Square)', '16:9 (Widescreen)', '9:16 (Portrait Widescreen)']],
      megapixels: ['FLOAT', { min: 0.1, max: 16 }],
    });

    await executeComfyUIVideoGenerate({
      prompt: 'p', model: 'wf', provider: 'comfyui', workflowId: 'wf-1',
      videoResolution: 832, seedanceRatio: '16:9', videoFps: 24, videoFrames: 121,
    });

    // 832×464 ≈ 0.39MP
    expect(submittedWorkflow()['1'].inputs).toMatchObject({
      aspect_ratio: '16:9 (Widescreen)', megapixels: 0.39,
    });
  });

  it('duration_seconds 这类纯数字时长直接写秒数', async () => {
    registerNodes({
      '1': { class_type: 'VeoVideoGenerationNode', inputs: { duration_seconds: 5 } },
    });
    objectInfoByClass.VeoVideoGenerationNode = objectInfo('VeoVideoGenerationNode', {
      duration_seconds: ['INT', { min: 5, max: 8 }],
    });

    await executeComfyUIVideoGenerate({
      prompt: 'p', model: 'wf', provider: 'comfyui', workflowId: 'wf-1',
      videoResolution: 1280, videoFps: 24, videoFrames: 289, seedanceDuration: 12,
    });

    // 节点声明最多 8 秒，超出的按上限收
    expect(submittedWorkflow()['1'].inputs.duration_seconds).toBe(8);
  });
});
