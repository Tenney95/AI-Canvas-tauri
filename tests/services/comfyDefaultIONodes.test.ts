/**
 * comfyDefaultIONodes — 回归测试：ComfyUI 默认 IO 节点。
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

import { executeComfyUIGenerate, executeComfyUIVideoGenerate } from '../../src/services/comfyWorkflowService';
import { comfyWorkflowParameterKey } from '../../src/services/comfyWorkflowParameters';

/** 文生图工作流：两个 CLIPTextEncode（正/负）+ 一个 LoadImage */
const WORKFLOW_JSON = JSON.stringify({
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '正向占位' }, _meta: { title: 'CLIP文本编码' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '负向占位' }, _meta: { title: 'CLIP负面提示词' } },
  '10': { class_type: 'LoadImage', inputs: { image: 'example.png', upload: 'image' }, _meta: { title: '载入图像' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
});

const IO_NODES = [
  { nodeId: '6', title: 'CLIP文本编码', type: 'prompt' },
  { nodeId: '7', title: 'CLIP负面提示词', type: 'prompt' },
  { nodeId: '10', title: '载入图像', type: 'image' },
];

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function registerWorkflow(defaultNodes?: Record<string, string>) {
  mocks.storeState.workflows = [{
    id: 'wf-1',
    name: 'z-image',
    category: 'ai-image',
    fileName: 'z-image.json',
    fileContent: WORKFLOW_JSON,
    ioNodes: IO_NODES,
    defaultNodes,
    createdAt: 1,
  }];
}

function submittedWorkflow(): Record<string, { inputs: Record<string, unknown> }> {
  const call = mocks.corsSafeFetch.mock.calls.find(([url]) => String(url).endsWith('/prompt'));
  return JSON.parse(String((call?.[1] as RequestInit).body)).prompt;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/upload/image')) return jsonResponse({ name: 'upload_1.png', subfolder: '', type: 'input' });
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (url.includes('/history/')) {
      return jsonResponse({
        'prompt-1': {
          status: { completed: true },
          outputs: {
            '9': {
              images: [{ filename: 'out.png', subfolder: '', type: 'output' }],
              videos: [{ filename: 'out.mp4', subfolder: '', type: 'output' }],
            },
          },
        },
      });
    }
    throw new Error(`未预期的请求：${url}`);
  });
});

const baseParams = { prompt: '一只在屋顶的猫', model: 'wf', provider: 'comfyui', workflowId: 'wf-1' };

describe('ComfyUI 默认 IO 节点', () => {
  it.each(['image', 'video'] as const)('%s 本地普通参数按字段覆盖，优先于通用尺寸，不抑制正文兜底且不改原图', async (kind) => {
    registerWorkflow();
    const original = JSON.stringify({
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 't-1' } },
      '20': { class_type: 'ParameterTest', inputs: { steps: 8, cfg: 1, enabled: true, width: 64, height: 64 } },
      '21': { class_type: 'ParameterTest', inputs: { steps: ['20', 0] } },
    });
    mocks.storeState.workflows[0].fileContent = original;
    mocks.storeState.workflows[0].ioNodes = [{ nodeId: '6', title: '正文', type: 'prompt' }];
    const network = mocks.corsSafeFetch.getMockImplementation()!;
    mocks.corsSafeFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/view?')) {
        const header = new Uint8Array(24);
        header.set([0x89, 80, 78, 71, 13, 10, 26, 10]); header.set([73, 72, 68, 82], 12);
        const view = new DataView(header.buffer); view.setUint32(16, 512); view.setUint32(20, 768);
        return new Response(header, { status: 206, headers: { 'Content-Length': '24', 'Content-Type': 'image/png' } });
      }
      if (url.endsWith('/object_info/ParameterTest')) return jsonResponse({ ParameterTest: { input: { required: {
        steps: ['INT', { min: 1, max: 100 }], cfg: ['FLOAT', { min: 0, max: 100 }], enabled: ['BOOLEAN', {}],
        width: ['INT', { min: 64, max: 8192 }], height: ['INT', { min: 64, max: 8192 }],
      } } } });
      return network(url, init);
    });
    const workflowInputs = Object.fromEntries(Object.entries({ steps: '25', cfg: '0', enabled: 'false', width: '512', height: '768' })
      .map(([fieldName, value]) => [comfyWorkflowParameterKey({ nodeId: '20', fieldName }), value]));
    const params = { ...baseParams, workflowInputs, imageSize: '2K', aspectRatio: '16:9' };
    const result = kind === 'image' ? await executeComfyUIGenerate(params) : await executeComfyUIVideoGenerate(params);
    if (kind === 'image') {
      expect(result).toMatchObject({ width: 512, height: 768 });
      expect(mocks.corsSafeFetch.mock.calls.find(([url]) => String(url).includes('/view?'))?.[1]).toMatchObject({ headers: { Range: 'bytes=0-1048575' } });
    }
    const submitted = submittedWorkflow();
    expect(submitted['20'].inputs).toMatchObject({ steps: 25, cfg: 0, enabled: false, width: 512, height: 768 });
    expect(submitted['21'].inputs.steps).toEqual(['20', 0]);
    expect(submitted['6'].inputs.text).toBe(baseParams.prompt);
    expect(mocks.storeState.workflows[0].fileContent).toBe(original);
  });

  it('连线参数覆盖在上传参考图和提交任务前拒绝', async () => {
    registerWorkflow();
    mocks.storeState.workflows[0].fileContent = JSON.stringify({ '20': { class_type: 'ParameterTest', inputs: { steps: ['source', 0] } } });
    const field = comfyWorkflowParameterKey({ nodeId: '20', fieldName: 'steps' });
    await expect(executeComfyUIGenerate({ ...baseParams, workflowInputs: { [field]: '12' } }, undefined, ['data:image/png;base64,QUJD'])).rejects.toThrow('参数已失效');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it.each(['string', 'value'])('显式提示词与默认提示词都支持 %s 字段，并保留连线', async (key) => {
    registerWorkflow({ prompt: '6' });
    mocks.storeState.workflows[0].fileContent = JSON.stringify({
      '6': { class_type: 'PrimitiveString', inputs: { text: ['upstream', 0], [key]: '原值' } },
    });
    await executeComfyUIGenerate({ ...baseParams, workflowInputs: { '6': '显式文本' } });
    expect(submittedWorkflow()['6'].inputs).toEqual({ text: ['upstream', 0], [key]: '显式文本' });
    await executeComfyUIGenerate(baseParams);
    expect(submittedWorkflow()['6'].inputs[key]).toBe('显式文本');
    const calls = mocks.corsSafeFetch.mock.calls.filter(([url]) => String(url).endsWith('/prompt'));
    expect(JSON.parse(String(calls[1][1].body)).prompt['6'].inputs[key]).toBe(baseParams.prompt);
  });

  it.each(['video', 'file'])('显式视频写入 %s，普通视频引用继续填入其他槽', async (key) => {
    registerWorkflow({ video: '20' });
    mocks.storeState.workflows[0].ioNodes = [
      { nodeId: '20', type: 'video', title: '默认视频' },
      { nodeId: '21', type: 'video', title: '显式视频' },
    ];
    mocks.storeState.workflows[0].fileContent = JSON.stringify({
      '20': { class_type: 'LoadVideo', inputs: { file: 'keep.mp4' } },
      '21': { class_type: 'LoadVideo', inputs: { [key]: 'old.mp4', upload: 'video', text: 'keep text' } },
    });
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/upload/image')) return jsonResponse({ name: 'new.mp4', subfolder: 'clips' });
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
      if (url.includes('/history/')) return jsonResponse({ 'prompt-1': { status: { completed: true }, outputs: { '9': { videos: [{ filename: 'out.mp4' }] } } } });
      throw new Error(`未预期的请求：${url}`);
    });
    await executeComfyUIVideoGenerate({ ...baseParams, workflowInputs: { '21': `data:video/mp4;base64,${btoa(`explicit-${key}`)}` } }, undefined, [], { videoUrls: [`data:video/mp4;base64,${btoa(`ordinary-${key}`)}`] });
    expect(submittedWorkflow()['21'].inputs).toEqual({ [key]: 'clips/new.mp4', upload: 'video', text: 'keep text' });
    expect(submittedWorkflow()['20'].inputs.file).toBe('clips/new.mp4');
    const uploads = mocks.corsSafeFetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/image'));
    expect(uploads).toHaveLength(2);
    expect((uploads[0][1].body as FormData).get('image')).toMatchObject({ type: 'video/mp4' });
  });

  it('显式视频目标仅支持主机路径时，在上传及提交前拒绝', async () => {
    registerWorkflow();
    mocks.storeState.workflows[0].ioNodes = [{ nodeId: '20', type: 'video', title: '路径视频' }];
    mocks.storeState.workflows[0].fileContent = JSON.stringify({ '20': { class_type: 'VHS_LoadVideoPath', inputs: { video_path: 'keep' } } });
    await expect(executeComfyUIVideoGenerate({ ...baseParams, workflowInputs: { '20': 'data:video/mp4;base64,QUJD' } })).rejects.toThrow('不接受上传文件名');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('未上传的视频节点只连接 autogrow 可选槽时自动绕过', async () => {
    registerWorkflow();
    mocks.storeState.workflows[0].ioNodes = [
      { nodeId: '127', type: 'video', title: 'Load Video (Upload) from S3' },
    ];
    mocks.storeState.workflows[0].fileContent = JSON.stringify({
      '127': { class_type: 'LoadVideoUploadS3', inputs: { video: null } },
      '93': {
        class_type: 'ReferenceToVideo',
        inputs: {
          prompt: 'keep original prompt',
          'ref_video_audios.ref_video_audio_0': ['127', 2],
        },
      },
      '9': { class_type: 'SaveImage', inputs: { images: ['93', 0] } },
    });

    await executeComfyUIVideoGenerate(baseParams);

    const submitted = submittedWorkflow();
    expect(submitted['127']).toBeUndefined();
    expect(submitted['93'].inputs).toEqual({ prompt: 'keep original prompt' });
  });

  it('未上传的媒体节点连接普通 optional 输入时按节点声明绕过', async () => {
    registerWorkflow();
    mocks.storeState.workflows[0].ioNodes = [
      { nodeId: '20', type: 'image', title: '可选参考图' },
    ];
    mocks.storeState.workflows[0].fileContent = JSON.stringify({
      '20': { class_type: 'LoadImageCustom', inputs: { image: '' } },
      '21': { class_type: 'OptionalReferenceConsumer', inputs: { reference: ['20', 0], prompt: 'keep original prompt' } },
      '9': { class_type: 'SaveImage', inputs: { images: ['21', 0] } },
    });
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/OptionalReferenceConsumer')) {
        return jsonResponse({
          OptionalReferenceConsumer: {
            input: { optional: { reference: ['IMAGE', {}] }, required: { prompt: ['STRING', {}] } },
          },
        });
      }
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

    await executeComfyUIGenerate(baseParams);

    const submitted = submittedWorkflow();
    expect(submitted['20']).toBeUndefined();
    expect(submitted['21'].inputs).toEqual({ prompt: 'keep original prompt' });
  });

  it('未上传的媒体节点连接必填输入时不自动删除', async () => {
    registerWorkflow();
    mocks.storeState.workflows[0].ioNodes = [
      { nodeId: '20', type: 'image', title: '必填参考图' },
    ];
    mocks.storeState.workflows[0].fileContent = JSON.stringify({
      '20': { class_type: 'LoadImageCustom', inputs: { image: null } },
      '21': { class_type: 'RequiredReferenceConsumer', inputs: { reference: ['20', 0] } },
      '9': { class_type: 'SaveImage', inputs: { images: ['21', 0] } },
    });
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info/RequiredReferenceConsumer')) {
        return jsonResponse({
          RequiredReferenceConsumer: {
            input: { required: { reference: ['IMAGE', {}] } },
          },
        });
      }
      if (url.endsWith('/object_info/SaveImage')) {
        return jsonResponse({ SaveImage: { input: { required: { images: ['IMAGE', {}] } } } });
      }
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

    await executeComfyUIGenerate(baseParams);

    expect(submittedWorkflow()['20'].inputs.image).toBeNull();
  });

  it('显式提示词不能写入时报告映射错误，不覆盖连线', async () => {
    registerWorkflow();
    mocks.storeState.workflows[0].fileContent = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: ['source', 0] } } });
    await expect(executeComfyUIGenerate({ ...baseParams, workflowInputs: { '6': '新文本' } })).rejects.toThrow('没有可写的文本输入');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it('没 @ 文本节点时，提示词只写进默认的那个 CLIP 节点', async () => {
    registerWorkflow({ prompt: '6' });

    await executeComfyUIGenerate(baseParams);

    const submitted = submittedWorkflow();
    expect(submitted['6'].inputs.text).toBe('一只在屋顶的猫');
    // 负向提示词节点不是默认节点，保持原值
    expect(submitted['7'].inputs.text).toBe('负向占位');
  });

  it('没 @ 图片节点时，提示词框里的图片上传后写进默认 LoadImage 节点', async () => {
    registerWorkflow({ prompt: '6', image: '10' });

    await executeComfyUIGenerate(baseParams, undefined, ['data:image/png;base64,QUJD']);

    expect(submittedWorkflow()['10'].inputs.image).toBe('upload_1.png');
  });

  it('用户 @ 了同类型节点时，默认节点不再介入', async () => {
    registerWorkflow({ prompt: '6' });

    await executeComfyUIGenerate({ ...baseParams, workflowInputs: { '7': '手写的负面词' } });

    const submitted = submittedWorkflow();
    expect(submitted['7'].inputs.text).toBe('手写的负面词');
    expect(submitted['6'].inputs.text).toBe('正向占位');
  });

  it('没配默认节点时图片自动匹配，提示词沿用占位符兜底', async () => {
    registerWorkflow();

    await executeComfyUIGenerate(baseParams, undefined, ['data:image/png;base64,QUJD']);

    const submitted = submittedWorkflow();
    // 旧逻辑按“短占位符”猜测，正负两个文本节点都会被写成同一句
    expect(submitted['6'].inputs.text).toBe('一只在屋顶的猫');
    expect(submitted['7'].inputs.text).toBe('一只在屋顶的猫');
    // 未指定默认图片节点也会自动注入
    expect(submitted['10'].inputs.image).toBe('upload_1.png');
  });
});

describe('ComfyUI 三类媒体统一顺序分配', () => {
  let serial = 0;
  const kinds = ['image', 'video', 'audio'] as const;
  function install(defaults = false, explicit = false) {
    serial++;
    const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      '6': { class_type: 'PrimitiveString', inputs: { value: 'old' } },
    };
    const ios: Array<{ nodeId: string; type: string; title: string }> = [{ nodeId: '6', type: 'prompt', title: '提示词' }];
    const defaultNodes: Record<string, string> = { prompt: '6' };
    const refs = { image: [] as string[], video: [] as string[], audio: [] as string[] };
    const workflowInputs: Record<string, string> = {};
    for (const kind of kinds) {
      for (const index of [2, 1, 3]) {
        const id = `${kind}-${index}`;
        graph[id] = { class_type: kind === 'image' ? 'LoadImage' : kind === 'video' ? 'LoadVideo' : 'LoadAudio', inputs: { [kind === 'video' ? 'file' : kind]: null } };
        ios.push({ nodeId: id, type: kind, title: id });
      }
      if (defaults) defaultNodes[kind] = `${kind}-1`;
      const mime = kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav';
      refs[kind] = [1, 2, 3].map((i) => `data:${mime};base64,${btoa(`${serial}-${kind}-${i}`)}`);
      if (explicit) workflowInputs[`${kind}-1`] = refs[kind][0];
    }
    mocks.storeState.workflows = [{ id: 'wf-1', name: 'arbitrary', category: 'ai-video', fileContent: JSON.stringify(graph), ioNodes: ios, defaultNodes }];
    const uploaded: string[] = [];
    mocks.corsSafeFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/upload/image')) {
        const value = await ((init?.body as FormData).get('image') as Blob).text();
        uploaded.push(value);
        return jsonResponse({ name: value, subfolder: 'refs' });
      }
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
      if (url.includes('/history/')) return jsonResponse({ 'prompt-1': { status: { completed: true }, outputs: { '9': { videos: [{ filename: 'out.mp4' }] } } } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const run = () => executeComfyUIVideoGenerate({ ...baseParams, workflowInputs }, undefined, refs.audio, { imageUrls: refs.image, videoUrls: refs.video });
    return { graph, refs, workflowInputs, run, uploaded };
  }

  it.each([false, true])('三类各3份按IO顺序匹配，默认优先=%s，并保留上传子目录', async (defaults) => {
    const h = install(defaults);
    const before = mocks.storeState.workflows[0].fileContent;
    await h.run();
    const graph = submittedWorkflow();
    for (const kind of kinds) {
      const order = defaults ? [1, 2, 3] : [2, 1, 3];
      order.forEach((id, index) => expect(graph[`${kind}-${id}`].inputs[kind === 'video' ? 'file' : kind]).toBe(`refs/${serial}-${kind}-${index + 1}`));
    }
    expect(graph['6'].inputs.value).toBe(baseParams.prompt);
    expect(h.uploaded).toHaveLength(9);
    expect(mocks.storeState.workflows[0].fileContent).toBe(before);
  });

  it('显式槽不被覆盖，普通引用中的同一素材去重，其余填剩余槽', async () => {
    const h = install(false, true);
    await h.run();
    const graph = submittedWorkflow();
    for (const kind of kinds) {
      expect(graph[`${kind}-1`].inputs[kind === 'video' ? 'file' : kind]).toBe(`refs/${serial}-${kind}-1`);
      expect(graph[`${kind}-2`].inputs[kind === 'video' ? 'file' : kind]).toBe(`refs/${serial}-${kind}-2`);
    }
    expect(h.uploaded).toHaveLength(9);
  });

  it('最后一类素材溢出时也在任何上传或提交之前失败', async () => {
    const h = install();
    h.refs.audio.push('data:audio/wav;base64,ZXh0cmE=');
    await expect(h.run()).rejects.toThrow('音频上传槽不足');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('主机路径或连线输入不消耗顺序位置', async () => {
    const h = install();
    h.graph['video-2'] = { class_type: 'VHS_LoadVideoPath', inputs: { video: '/host/movie.mp4' } };
    h.graph['image-2'].inputs.image = ['other', 0];
    h.refs.video.pop(); h.refs.image.pop();
    mocks.storeState.workflows[0].fileContent = JSON.stringify(h.graph);
    await h.run();
    const graph = submittedWorkflow();
    expect(graph['video-1'].inputs.file).toBe(`refs/${serial}-video-1`);
    expect(graph['image-1'].inputs.image).toBe(`refs/${serial}-image-1`);
    expect(graph['video-2'].inputs.video).toBe('/host/movie.mp4');
    expect(graph['image-2'].inputs.image).toEqual(['other', 0]);
  });

  it('显式失效音频引用在上传前报错，不用其他音频替换', async () => {
    const h = install(); h.workflowInputs['audio-1'] = '@{missing:失效}';
    await expect(h.run()).rejects.toThrow('引用未解析');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });
});
