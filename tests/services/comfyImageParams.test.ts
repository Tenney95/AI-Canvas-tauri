import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  storeState: {
    config: { comfyUIUrl: 'http://comfy.test:8300' },
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

import { executeComfyUIGenerate } from '../../src/services/comfyWorkflowService';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function objectInfo(classType: string, inputs: Record<string, unknown>) {
  return { [classType]: { input: { required: inputs } } };
}

function registerNodes(nodes: Record<string, unknown>) {
  mocks.storeState.workflows = [{
    id: 'wf-image-params',
    name: '图片尺寸映射测试',
    category: 'ai-image',
    fileName: 'image-params.json',
    fileContent: JSON.stringify({
      ...nodes,
      save: { class_type: 'SaveImage', inputs: { images: ['output', 0] } },
    }),
    ioNodes: [],
    createdAt: 1,
  }];
}

function submittedWorkflow(): Record<string, { inputs: Record<string, unknown> }> {
  const call = mocks.corsSafeFetch.mock.calls.find(([url]) => String(url).endsWith('/prompt'));
  return JSON.parse(String((call?.[1] as RequestInit).body)).prompt;
}

let comfyPort = 8300;
let objectInfoByClass: Record<string, unknown> = {};

beforeEach(() => {
  vi.clearAllMocks();
  objectInfoByClass = {};
  mocks.storeState.config.comfyUIUrl = `http://comfy.test:${++comfyPort}`;
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
    const objectInfoMatch = /\/object_info\/(.+)$/.exec(String(url));
    if (objectInfoMatch) {
      const classType = decodeURIComponent(objectInfoMatch[1]);
      const info = objectInfoByClass[classType];
      return info ? jsonResponse(info) : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-image-1' });
    if (url.includes('/history/')) {
      return jsonResponse({
        'prompt-image-1': {
          status: { completed: true },
          outputs: { save: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
        },
      });
    }
    throw new Error(`未预期的请求：${url}`);
  });
});

const baseParams = {
  prompt: '测试图片',
  model: 'workflow',
  provider: 'comfyui',
  workflowId: 'wf-image-params',
};

describe('ComfyUI 图片尺寸参数注入', () => {
  it('更新数字宽高并按 8 对齐非整数比例', async () => {
    registerNodes({
      latent: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    });

    const result = await executeComfyUIGenerate({ ...baseParams, imageSize: '2K', aspectRatio: '16:9' });

    expect(submittedWorkflow().latent.inputs).toMatchObject({ width: 3640, height: 2048 });
    expect(result).toMatchObject({ width: 3640, height: 2048 });
  });

  it('按真实 CatPixel ratio_preset schema 切换比例并回报固定 preset 像素', async () => {
    registerNodes({
      '377': { class_type: 'KSampler', inputs: { latent_image: ['379', 2] } },
      '379': {
        class_type: 'ImageAspectRatioSelect',
        inputs: { ratio_preset: '9:16 - 720x1280' },
        _meta: { title: 'Cat像素 - 比例选择器' },
      },
    });
    objectInfoByClass.ImageAspectRatioSelect = objectInfo('ImageAspectRatioSelect', {
      ratio_preset: [[
        '1:1 - 1024x1024',
        '2:3 - 832x1248',
        '3:2 - 1248x832',
        '3:4 - 864x1152',
        '4:3 - 1152x864',
        '7:9 - 896x1152',
        '9:7 - 1152x896',
        '9:16 - 720x1280',
        '9:21 - 576x1344',
        '16:9 - 1280x720',
        '21:9 - 1344x576',
      ]],
    });

    const result = await executeComfyUIGenerate({ ...baseParams, imageSize: '2K', aspectRatio: '16:9' });

    expect(submittedWorkflow()['379'].inputs.ratio_preset).toBe('16:9 - 1280x720');
    expect(result).toMatchObject({ width: 1280, height: 720 });
  });

  it('按节点声明更新字符串化的成对别名，并遵守 step', async () => {
    registerNodes({
      canvas: {
        class_type: 'CustomImageCanvas',
        inputs: { target_width: '512', target_height: '512' },
      },
    });
    objectInfoByClass.CustomImageCanvas = objectInfo('CustomImageCanvas', {
      target_width: ['INT', { min: 64, max: 8192, step: 64 }],
      target_height: ['INT', { min: 64, max: 8192, step: 64 }],
    });

    await executeComfyUIGenerate({ ...baseParams, imageSize: '2K', aspectRatio: '16:9' });

    expect(submittedWorkflow().canvas.inputs).toMatchObject({ target_width: 3648, target_height: 2048 });
  });

  it('不把预处理节点的 target_width/target_height 当成生成分辨率', async () => {
    registerNodes({
      preprocess: {
        class_type: 'ResizeAndPadImage',
        inputs: { target_width: 768, target_height: 768 },
      },
    });
    objectInfoByClass.ResizeAndPadImage = objectInfo('ResizeAndPadImage', {
      target_width: ['INT', { min: 64, max: 8192, step: 8 }],
      target_height: ['INT', { min: 64, max: 8192, step: 8 }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await executeComfyUIGenerate({ ...baseParams, imageSize: '2K', aspectRatio: '16:9' });

    expect(submittedWorkflow().preprocess.inputs).toMatchObject({ target_width: 768, target_height: 768 });
    warn.mockRestore();
  });

  it('只在分辨率节点处于自定义模式时更新 custom_width/custom_height', async () => {
    registerNodes({
      selector: {
        class_type: 'MiniMaxImageResolution',
        inputs: { resolution: 'Custom', custom_width: '768', custom_height: '768' },
      },
    });
    objectInfoByClass.MiniMaxImageResolution = objectInfo('MiniMaxImageResolution', {
      resolution: [['Custom']],
      custom_width: ['INT', { min: 64, max: 8192, step: 64 }],
      custom_height: ['INT', { min: 64, max: 8192, step: 64 }],
    });

    await executeComfyUIGenerate({ ...baseParams, imageSize: '2K', aspectRatio: '9:16' });

    expect(submittedWorkflow().selector.inputs).toMatchObject({
      resolution: 'Custom',
      custom_width: 2048,
      custom_height: 3648,
    });
  });

  it('宽高通过连接供值时修改上游 Primitive，并保留原连接', async () => {
    registerNodes({
      width: { class_type: 'PrimitiveInt', inputs: { value: 512 } },
      height: { class_type: 'PrimitiveInt', inputs: { value: 512 } },
      latent: {
        class_type: 'EmptyLatentImage',
        inputs: { width: ['width', 0], height: ['height', 0] },
      },
    });

    await executeComfyUIGenerate({ ...baseParams, imageSize: '1K', aspectRatio: '9:16' });

    const submitted = submittedWorkflow();
    expect(submitted.width.inputs.value).toBe(1024);
    expect(submitted.height.inputs.value).toBe(1824);
    expect(submitted.latent.inputs).toMatchObject({ width: ['width', 0], height: ['height', 0] });
  });

  it('同一 Primitive 承担冲突宽高时保持原值', async () => {
    registerNodes({
      shared: { class_type: 'PrimitiveInt', inputs: { value: 512 } },
      latent: {
        class_type: 'EmptyLatentImage',
        inputs: { width: ['shared', 0], height: ['shared', 0] },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await executeComfyUIGenerate({ ...baseParams, imageSize: '1K', aspectRatio: '16:9' });

    expect(submittedWorkflow().shared.inputs.value).toBe(512);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('目标值冲突'),
      ['shared:value'],
    );
    warn.mockRestore();
  });

  it('按 object_info 的合法选项写入比例与分辨率档位', async () => {
    registerNodes({
      api: {
        class_type: 'CustomImageApi',
        inputs: { aspect_ratio: '1:1', resolution: '1K' },
      },
    });
    objectInfoByClass.CustomImageApi = objectInfo('CustomImageApi', {
      aspect_ratio: [['1:1', '16:9', '9:16']],
      resolution: [['1K', '2K', '4K']],
    });

    await executeComfyUIGenerate({ ...baseParams, imageSize: '2K', aspectRatio: '9:16' });

    expect(submittedWorkflow().api.inputs).toMatchObject({ aspect_ratio: '9:16', resolution: '2K' });
  });

  it('数字型图片 resolution 与数字 combo 都按所选图片档位的短边写入', async () => {
    registerNodes({
      api: { class_type: 'CustomImageApi', inputs: { resolution: 512 } },
      combo: { class_type: 'NumericResolutionCombo', inputs: { resolution: 512 } },
    });
    objectInfoByClass.CustomImageApi = objectInfo('CustomImageApi', {
      resolution: ['INT', { min: 64, max: 8192, step: 8 }],
    });
    objectInfoByClass.NumericResolutionCombo = objectInfo('NumericResolutionCombo', {
      resolution: [[512, 1024, 2048]],
    });

    await executeComfyUIGenerate({ ...baseParams, imageSize: '1K', aspectRatio: '16:9' });

    expect(submittedWorkflow().api.inputs.resolution).toBe(1024);
    expect(submittedWorkflow().combo.inputs.resolution).toBe(1024);
  });

  it('图片 ResolutionSelector 使用节点自己的比例标签与像素范围', async () => {
    registerNodes({
      selector: {
        class_type: 'CustomResolutionSelector',
        inputs: { aspect_ratio: 'square', megapixels: 0.5 },
      },
    });
    objectInfoByClass.CustomResolutionSelector = objectInfo('CustomResolutionSelector', {
      aspect_ratio: [['square', '9:16 portrait', '16:9 landscape']],
      megapixels: ['FLOAT', { min: 0.2, max: 2 }],
    });

    await executeComfyUIGenerate({ ...baseParams, imageSize: '1K', aspectRatio: '9:16' });

    expect(submittedWorkflow().selector.inputs).toMatchObject({
      aspect_ratio: '9:16 portrait',
      megapixels: 1.87,
    });
  });
});
