/**
 * builtinWorkflows — 回归测试：内置 MiniMax H3 工作流。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import legacyTextToVideo from '../../src/assets/comfyWorkflows/minimax-h3-t2v.json?raw';
import legacyReferenceToVideo from '../../src/assets/comfyWorkflows/minimax-h3-r2v.json?raw';
import legacyReferenceToVideoTurbo from '../../src/assets/comfyWorkflows/minimax-h3-r2v-turbo.json?raw';

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
  generateId: () => 'id-1',
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

import { isRetiredBuiltInWorkflow, pendingBuiltInWorkflows, resetBuiltInWorkflows, withBuiltInEditableContent } from '../../src/services/builtinWorkflows';
import { executeComfyUIGenerate, executeComfyUIAudioGenerate, executeComfyUIVideoGenerate } from '../../src/services/comfyWorkflowService';
import { extractComfyUIIONodes } from '../../src/services/comfyUIWindowService';
import { resolveVideoSubmissionControls } from '../../src/services/ai/videoRequestResolver';
import type { WorkflowDefinition } from '../../src/types';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/** 新请求在上传前读取种子合同；其余声明继续由各用例提供。 */
function seedSchemaResponse(url: string) {
  const classType = url.split('/object_info/')[1];
  return classType ? jsonResponse({ [decodeURIComponent(classType)]: { input: { required: {
    seed: ['INT', { min: 0, max: Number.MAX_SAFE_INTEGER }],
    noise_seed: ['INT', { min: 0, max: Number.MAX_SAFE_INTEGER }],
    random_seed: ['INT', { min: 0, max: Number.MAX_SAFE_INTEGER }],
  } } } }) : undefined;
}

function submittedWorkflow(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const call = mocks.corsSafeFetch.mock.calls.find(([url]) => String(url).endsWith('/prompt'));
  return JSON.parse(String((call?.[1] as RequestInit).body)).prompt;
}

// 退役的图仍可由用户手动导入；保留其参数注入与参考素材裁剪回归。
const legacyImports: WorkflowDefinition[] = [
  {
    id: 'wf-imported-h3-t2v', fileName: 'minimax-h3-t2v.json',
    fileContent: legacyTextToVideo, defaultNodes: { prompt: '105:104' },
  },
  {
    id: 'wf-imported-h3-r2v', fileName: 'minimax-h3-r2v.json',
    fileContent: legacyReferenceToVideo, defaultNodes: { prompt: '138', image: '137' },
  },
  {
    id: 'wf-imported-h3-r2v-turbo', fileName: 'minimax-h3-r2v-turbo.json',
    fileContent: legacyReferenceToVideoTurbo, defaultNodes: { prompt: '138', image: '169', video: '167' },
  },
].map((workflow) => ({
  ...workflow, name: workflow.fileName, category: 'ai-video' as const,
  ioNodes: extractComfyUIIONodes(workflow.fileContent), createdAt: 1,
}));

/** 把内置与手动导入的工作流装进 store，然后按 id 提交一次。 */
async function runWorkflow(
  workflowId: string,
  params: Parameters<typeof executeComfyUIVideoGenerate>[0],
  promptMedia: { imageUrls?: string[]; videoUrls?: string[] } = {},
) {
  const workflows = [...pendingBuiltInWorkflows([]), ...legacyImports];
  mocks.storeState.workflows = workflows as unknown as Array<Record<string, unknown>>;
  await executeComfyUIVideoGenerate({ ...params, workflowId }, undefined, [], promptMedia);
  return workflows.find((workflow) => workflow.id === workflowId) as WorkflowDefinition;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
    const seedSchema = seedSchemaResponse(url); if (seedSchema) return seedSchema;
    if (url.endsWith('/upload/image')) {
      return jsonResponse({ name: 'upload_1.png', subfolder: '', type: 'input' });
    }
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (url.includes('/history/')) {
      return jsonResponse({
        'prompt-1': {
          status: { completed: true },
          outputs: { '92': { images: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] } },
        },
      });
    }
    throw new Error(`未预期的请求：${url}`);
  });
});

describe('内置 MiniMax H3 工作流', () => {
  it('首次启动播种一个图片、七个视频与七个音频工作流，之后不再重复添加', () => {
    const first = pendingBuiltInWorkflows([]);
    expect(first).toHaveLength(15);
    expect(first.filter((workflow) => workflow.category === 'ai-image')).toHaveLength(1);
    expect(first.filter((workflow) => workflow.category === 'ai-video')).toHaveLength(7);
    expect(first.filter((workflow) => workflow.category === 'ai-audio')).toHaveLength(7);
    expect(pendingBuiltInWorkflows([])).toHaveLength(0);
  });

  it('只记账已经建出来的，剩下的下次启动继续补', () => {
    localStorage.setItem(
      'aicanvas.builtinWorkflows.seededIds',
      JSON.stringify(['builtin-minimax-h3-i2v']),
    );
    const pending = pendingBuiltInWorkflows([]);
    expect(pending.map((workflow) => workflow.id)).not.toContain('builtin-minimax-h3-i2v');
    expect(pending).toHaveLength(14);
  });

  it.each([
    'builtin-minimax-h3-t2v',
    'builtin-minimax-h3-t2v-turbo',
    'builtin-minimax-h3-r2v',
    'builtin-minimax-h3-r2v-turbo',
  ])('%s 已退役，首次播种和重置均不再提供', (id) => {
    expect(isRetiredBuiltInWorkflow(id)).toBe(true);
    expect(pendingBuiltInWorkflows([]).map((workflow) => workflow.id)).not.toContain(id);
    expect(resetBuiltInWorkflows().map((workflow) => workflow.id)).not.toContain(id);
  });

  it('默认 IO 节点都能在工作流 JSON 里找到对应的输入', () => {
    for (const workflow of pendingBuiltInWorkflows([])) {
      const json = JSON.parse(workflow.fileContent) as Record<string, { inputs: Record<string, unknown> }>;
      for (const [type, nodeId] of Object.entries(workflow.defaultNodes ?? {})) {
        expect(json[nodeId], `${workflow.name} 的 ${type} 默认节点`).toBeTruthy();
        expect(workflow.ioNodes?.some((io) => io.nodeId === nodeId && io.type === type)).toBe(true);
      }
    }
  });

  it('12GB 极速图生视频使用 4B 投影、INT8 ConvRot、Turbo 4 步和 Comfy Kitchen', () => {
    const workflow = pendingBuiltInWorkflows([]).find(
      (item) => item.id === 'builtin-minimax-h3-i2v-fast-12gb',
    )!;
    const graph = JSON.parse(workflow.fileContent);
    expect(workflow.defaultNodes).toEqual({ prompt: '132', image: '114' });
    expect(graph['126'].inputs.unet_name).toBe('minimax_h3_fl2va_pruned_int8_convrot.safetensors');
    expect(graph['127']).toMatchObject({
      class_type: 'ClipProjLoader',
      inputs: {
        clip_name: 'qwen3vl_4b_int8_convrot.safetensors',
        type: 'krea2',
        projection: 'mmh3-4b-ClipProj-v3.1.safetensors',
        mode: 'streaming',
      },
    });
    expect(graph['118'].inputs.vae_name).toBe('minimax_h3_video_vae_int8_convrot.safetensors');
    expect(graph['122'].class_type).toBe('MiniMaxH3TurboSampler');
    expect(graph['115'].inputs.megapixels).toBe(0.2);
    expect(graph['123'].inputs).toMatchObject({ scheduler: 'simple', steps: 4, model: ['146', 0] });
    expect(graph['142'].inputs).toMatchObject({
      lora_name: 'minimax_h3_turbo_v4_step600_ema.safetensors',
      strength: 1,
      low_vram: false,
    });
    expect(graph['146']).toMatchObject({
      class_type: 'ModelAttentionBackend',
      inputs: { attention: 'comfy kitchen attention', model: ['142', 0] },
    });
  });

  it('12GB 极速工作流迁移旧投影引用、流式编码器和六步采样', () => {
    const workflow = pendingBuiltInWorkflows([]).find(
      (item) => item.id === 'builtin-minimax-h3-i2v-fast-12gb',
    )!;
    const stale = {
      ...workflow,
      fileContent: workflow.fileContent.replace(
        'mmh3-4b-ClipProj-v3.1.safetensors',
        'mmh3-4b-ClipProj-v3-mlp.safetensors',
      ).replace('"mode": "streaming"', '"mode": "resident"')
        .replace('"steps": 4', '"steps": 6'),
    };

    const upgraded = withBuiltInEditableContent(stale)!;

    expect(JSON.parse(upgraded.fileContent)['127'].inputs.projection)
      .toBe('mmh3-4b-ClipProj-v3.1.safetensors');
    expect(JSON.parse(upgraded.fileContent)['127'].inputs.mode).toBe('streaming');
    expect(JSON.parse(upgraded.fileContent)['123'].inputs.steps).toBe(4);
    expect(stale.fileContent).toContain('mmh3-4b-ClipProj-v3-mlp.safetensors');
    expect(withBuiltInEditableContent(workflow)).toBeNull();
  });

  it('手动导入旧版文生视频：分辨率写进 ResolutionSelector，时长写进秒数节点，帧率保持工作流原值', async () => {
    await runWorkflow('wf-imported-h3-t2v', {
      prompt: '海边日落',
      model: 'wf',
      provider: 'comfyui',
      videoResolution: 480,
      seedanceRatio: '16:9',
      seedanceDuration: 6,
      videoFps: 24,
    });

    const submitted = submittedWorkflow();
    expect(submitted['105:104'].inputs.prompt).toBe('海边日落');
    // 480×272 ≈ 0.13MP，比例写成 combo 里合法的档位
    expect(submitted['115'].inputs).toMatchObject({
      aspect_ratio: '16:9 (Widescreen)',
      megapixels: 0.13,
    });
    expect(submitted['105:111'].inputs.value).toBe(6);
    // 秒→帧由工作流自己的算式按 24 帧完成，改帧率反而会让时长错位
    expect(submitted['105:91'].inputs.fps).toBe(24);
  });

  it.each([
    { name: '未设置时长使用 5 秒', controls: {}, seconds: 5 },
    { name: '明确选择 3 秒', controls: { seedanceDuration: 3 }, seconds: 3 },
    { name: '旧节点的 77 帧换算为 3 秒', controls: { videoFrames: 77, videoFps: 24 }, seconds: 3 },
    { name: '选择 3 秒覆盖旧的 121 帧', controls: { seedanceDuration: 3, videoFrames: 121 }, seconds: 3 },
  ])('图生视频时长提交：$name', async ({ controls, seconds }) => {
    const workflowId = 'builtin-minimax-h3-i2v';
    await runWorkflow(workflowId, {
      // 提示词里的秒数不能覆盖参数控件。
      prompt: 'Create a 5-second shot', model: 'wf', provider: 'comfyui',
      ...resolveVideoSubmissionControls({ provider: 'comfyui', workflowId, ...controls }),
    });

    const submitted = submittedWorkflow();
    expect(submitted['105:111'].inputs.value).toBe(seconds);
    expect(submitted['105:107'].inputs['values.a']).toEqual(['105:111', 0]);
    expect(submitted['105:91'].inputs.fps).toBe(24);
    // 注入只改变提交副本，不覆盖用户保存的工作流默认值。
    const stored = JSON.parse(String(mocks.storeState.workflows.find((workflow) => workflow.id === workflowId)?.fileContent));
    expect(stored['105:111'].inputs.value).toBe(5);
  });

  it('图生视频：连线图片上传后写进 LoadImage', async () => {
    await runWorkflow(
      'builtin-minimax-h3-i2v',
      { prompt: '让它动起来', model: 'wf', provider: 'comfyui', seedanceRatio: '9:16' },
      { imageUrls: ['data:image/png;base64,QUJD'] },
    );

    const submitted = submittedWorkflow();
    expect(submitted['114'].inputs.image).toBe('upload_1.png');
    expect(submitted['115'].inputs.aspect_ratio).toBe('9:16 (Portrait Widescreen)');
  });

  it('手动导入旧版参考生视频：只给一张图时，多余的参考位连同视频链路一起摘掉', async () => {
    await runWorkflow(
      'wf-imported-h3-r2v-turbo',
      { prompt: '按参考图生成', model: 'wf', provider: 'comfyui' },
      { imageUrls: ['data:image/png;base64,QUJD'] },
    );

    const submitted = submittedWorkflow();
    expect(submitted['169'].inputs.image).toBe('upload_1.png');
    // 第二张参考图、参考视频和取元素节点都不该留在提交里
    expect(submitted['170']).toBeUndefined();
    expect(submitted['167']).toBeUndefined();
    expect(submitted['168']).toBeUndefined();
    expect(Object.keys(submitted['136'].inputs).filter((key) => key.startsWith('ref_')))
      .toEqual(['ref_image_size', 'ref_images.ref_image_0']);
  });

  it('手动导入旧版参考生视频：两张图各就各位，不会互相覆盖', async () => {
    await runWorkflow(
      'wf-imported-h3-r2v',
      { prompt: '双角色同框', model: 'wf', provider: 'comfyui' },
      // 上传结果按内容缓存，这里要用别的用例没传过的图，否则命中缓存就不会真的上传
      { imageUrls: ['data:image/png;base64,SEhI', 'data:image/png;base64,SUlJ'] },
    );

    const submitted = submittedWorkflow();
    expect(submitted['137'].inputs.image).toBe('upload_1.png');
    expect(submitted['139'].inputs.image).toBe('upload_1.png');
    const uploads = mocks.corsSafeFetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/image'));
    expect(uploads).toHaveLength(2);
  });
});

describe('内置 AuK 音频工作流', () => {
  beforeEach(() => {
    let outputFormat = 'flac';
    mocks.corsSafeFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const seedSchema = seedSchemaResponse(url); if (seedSchema) return seedSchema;
      if (url.endsWith('/upload/image')) return jsonResponse({ name: 'auk-reference.wav', subfolder: '', type: 'input' });
      if (url.endsWith('/prompt')) {
        const body = JSON.parse(String(init?.body));
        outputFormat = body.prompt['6'].inputs.format;
        return jsonResponse({ prompt_id: 'prompt-auk' });
      }
      if (url.includes('/history/')) {
        return jsonResponse({
          'prompt-auk': { status: { completed: true }, outputs: {
            '6': { audio: [{ filename: `auk.${outputFormat}`, subfolder: 'audio', type: 'output' }] },
          } },
        });
      }
      throw new Error(`未预期的请求：${url}`);
    });
  });

  function installAuK(id: string) {
    const workflows = pendingBuiltInWorkflows([]);
    mocks.storeState.workflows = workflows as unknown as Array<Record<string, unknown>>;
    return workflows.find((workflow) => workflow.id === id)!;
  }

  it('已播种其他工作流的用户只补缺失的两个 AuK 工作流，不复写旧数据', () => {
    const initial = resetBuiltInWorkflows();
    const existing = initial.filter((workflow) => !workflow.id.startsWith('builtin-auk-'));
    existing[0].name = '用户修改的名字';
    localStorage.setItem('aicanvas.builtinWorkflows.seededIds', JSON.stringify(existing.map((workflow) => workflow.id)));
    const pending = pendingBuiltInWorkflows(existing);
    expect(pending.map((workflow) => workflow.id)).toEqual(['builtin-auk-tts', 'builtin-auk-voice-cloning']);
    expect(existing[0].name).toBe('用户修改的名字');
    expect(pendingBuiltInWorkflows(existing)).toEqual([]);
    expect(resetBuiltInWorkflows()).toHaveLength(15);
  });

  it.each(['builtin-auk-tts', 'builtin-auk-voice-cloning'])('%s 保留可编辑布局、模型、采样参数和全部执行连线', (id) => {
    const workflow = installAuK(id);
    const api = JSON.parse(workflow.fileContent);
    const ui = JSON.parse(workflow.editableContent!);
    const executableNodes = ui.nodes.filter((node: { type: string }) => node.type !== 'MarkdownNote');
    expect(Object.keys(api)).toHaveLength(executableNodes.length);
    for (const node of executableNodes) {
      expect(api[String(node.id)].class_type).toBe(node.type);
      expect(node.pos).toHaveLength(2);
    }
    for (const [, sourceId, outputIndex, targetId, inputIndex] of ui.links) {
      const target = ui.nodes.find((node: { id: number }) => node.id === targetId);
      expect(api[String(targetId)].inputs[target.inputs[inputIndex].name]).toEqual([String(sourceId), outputIndex]);
    }
    expect(api['1'].inputs.model_name).toBe('auk_flash_w4a8.safetensors');
    expect(api['2'].inputs.encoder_name).toBe('qwen_omni_w4a8.safetensors');
    expect(api['3'].inputs.vae_name).toBe('auk_vae.safetensors');
    expect(api['5'].inputs).toMatchObject({ seconds: 3, seed: 42, steps: 32, guidance: 2, sway: -1 });
    expect(withBuiltInEditableContent(workflow)).toBeNull();
    expect(withBuiltInEditableContent({ ...workflow, editableContent: undefined })?.editableContent).toBe(workflow.editableContent);
  });

  it('文生语音将正文与声音描述组合后取回 FLAC，保持保存参数', async () => {
    const workflow = installAuK('builtin-auk-tts');
    const prompt = '欢迎回来。';
    const result = await executeComfyUIAudioGenerate({ prompt, model: 'wf', provider: 'comfyui', workflowId: workflow.id });
    const submitted = submittedWorkflow();
    expect(workflow.ioNodes).toEqual([{ nodeId: '4', title: 'AuKInstructionEncode', type: 'prompt' }]);
    expect(submitted['4'].inputs.instruction).toContain(`The content to speak is: ${JSON.stringify(prompt)}.`);
    expect(submitted['4'].inputs.instruction).toContain('adult female voice');
    expect(submitted['4'].inputs.audio).toBeUndefined();
    expect(submitted['6'].inputs).toEqual({ audio: ['5', 0], filename_prefix: 'audio/AuK', format: 'flac' });
    expect(result.url).toContain('auk.flac');
    expect(mocks.corsSafeFetch.mock.calls.some(([url]) => String(url).endsWith('/upload/image'))).toBe(false);
    expect(JSON.parse(workflow.fileContent)['4'].inputs.instruction).toContain('Hello, welcome to AuK.');
  });

  it('克隆台词写入动态字段，参考音频上传后接入原图，取回 MP3', async () => {
    const workflow = installAuK('builtin-auk-voice-cloning');
    const result = await executeComfyUIAudioGenerate(
      { prompt: '你好，欢迎回来。', model: 'wf', provider: 'comfyui', workflowId: workflow.id },
      undefined, ['data:audio/wav;base64,QVVLLUNMT05F'],
    );
    const submitted = submittedWorkflow();
    expect(workflow.ioNodes?.map(({ nodeId, type }) => ({ nodeId, type }))).toEqual([
      { nodeId: '7', type: 'audio' }, { nodeId: '10', type: 'prompt' },
    ]);
    expect(submitted['10'].inputs).toEqual({ task: 'Voice cloning', 'task.text': '你好，欢迎回来。' });
    expect(submitted['4'].inputs.instruction).toEqual(['10', 0]);
    expect(submitted['4'].inputs.audio).toEqual(['7', 0]);
    expect(submitted['7'].inputs.audio).toBe('auk-reference.wav');
    expect(submitted['6'].inputs).toEqual({ audio: ['5', 0], filename_prefix: 'audio/AuK', format: 'mp3', 'format.quality': 'V0' });
    expect(result.url).toContain('auk.mp3');
    expect(JSON.parse(workflow.fileContent)['7'].inputs.audio).toBe('sample-2.mp3');
  });

  it.each([
    ['builtin-auk-tts', '4', 'instruction'],
    ['builtin-auk-voice-cloning', '10', 'task.text'],
  ])('%s 显式 @ 提示词优先于默认正文', async (id, nodeId, field) => {
    const workflow = installAuK(id);
    await executeComfyUIAudioGenerate({
      prompt: '默认正文', model: 'wf', provider: 'comfyui', workflowId: workflow.id,
      workflowInputs: { [nodeId]: '显式台词', ...(id.endsWith('voice-cloning') ? { '7': 'data:audio/wav;base64,YXVkaW8=' } : {}) },
    });
    expect(submittedWorkflow()[nodeId].inputs[field]).toContain('显式台词');
    expect(submittedWorkflow()[nodeId].inputs[field]).not.toContain('默认正文');
  });

  it('显式 @ 音频优先于连线音频', async () => {
    const workflow = installAuK('builtin-auk-voice-cloning');
    const explicit = 'data:audio/wav;base64,QVVLLUVERkFVRFJP';
    await executeComfyUIAudioGenerate({
      prompt: '台词', model: 'wf', provider: 'comfyui', workflowId: workflow.id,
      workflowInputs: { '7': explicit },
    }, undefined, [explicit]);
    const uploads = mocks.corsSafeFetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/image'));
    expect(uploads).toHaveLength(1);
    const body = uploads[0][1].body as FormData;
    expect(await (body.get('image') as Blob).text()).toBe(atob(explicit.split(',')[1]));
    expect(submittedWorkflow()['7'].inputs.audio).toBe('auk-reference.wav');
  });

  it('指令连线和展示节点不会被当成新的提示词入口', () => {
    expect(extractComfyUIIONodes(JSON.stringify({
      a: { class_type: 'AuKInstructionEncode', inputs: { instruction: ['b', 0] } },
      b: { class_type: 'AuKInstructionBuilder', inputs: { task: 'Voice cloning', 'task.text': '台词' } },
      c: { class_type: 'PreviewAny', inputs: { instruction: '展示结果' } },
    }))).toEqual([{ nodeId: 'b', title: 'AuKInstructionBuilder', type: 'prompt' }]);
  });
  it('纯文本参数只改本次请求，速度指令与朗读正文分离', async () => {
    const workflow = installAuK('builtin-auk-tts');
    const original = workflow.fileContent;
    await executeComfyUIAudioGenerate({
      prompt: '你好。', model: 'wf', provider: 'comfyui', workflowId: workflow.id,
      audioSpeechSettings: { voiceStyle: 'boy', pace: 1, duration: 12 },
    });
    const graph = submittedWorkflow();
    expect(graph['4'].inputs.instruction).toContain('natural young boy voice');
    expect(graph['4'].inputs.instruction).toContain('slightly slower pace');
    expect(graph['4'].inputs.instruction).toContain('The content to speak is: "你好。".');
    expect(graph['5'].inputs).toMatchObject({ seconds: 12, steps: 32, guidance: 2, sway: -1 });
    expect(Number.isSafeInteger(graph['5'].inputs.seed)).toBe(true);
    expect(Number(graph['5'].inputs.seed)).toBeGreaterThanOrEqual(0);
    expect(workflow.fileContent).toBe(original);
  });

  it('克隆保留音频连线，忽略纯文本音色并把速度写入指令', async () => {
    const workflow = installAuK('builtin-auk-voice-cloning');
    const original = workflow.fileContent;
    await executeComfyUIAudioGenerate({
      prompt: '欢迎。', model: 'wf', provider: 'comfyui', workflowId: workflow.id,
      audioSpeechSettings: { voiceStyle: 'male', pace: 3, duration: 8 },
    }, undefined, ['data:audio/wav;base64,YXVkaW8=']);
    const graph = submittedWorkflow();
    expect(graph['4'].inputs.audio).toEqual(['7', 0]);
    expect(graph['4'].inputs.instruction).toBe('Say the following with the same voice: "欢迎。". Speak at a slightly faster pace.');
    expect(graph['5'].inputs.seconds).toBe(8);
    expect(workflow.fileContent).toBe(original);
  });

  it('缺少参考时在上传和提交前拒绝，不使用示例文件', async () => {
    const workflow = installAuK('builtin-auk-voice-cloning');
    await expect(executeComfyUIAudioGenerate({ prompt: '台词', model: 'wf', provider: 'comfyui', workflowId: workflow.id })).rejects.toThrow('请添加参考语音');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('纯文本工作流收到参考语音时提示切换，不忽略引用', async () => {
    const workflow = installAuK('builtin-auk-tts');
    await expect(executeComfyUIAudioGenerate({ prompt: '台词', model: 'wf', provider: 'comfyui', workflowId: workflow.id }, undefined, ['data:audio/wav;base64,YQ=='])).rejects.toThrow('不接收参考语音');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });

});

describe('内置 DLSS5 材质增强工作流', () => {
  const ids = ['builtin-dlss5-image-enhance', 'builtin-dlss5-video-enhance'];

  function install(id: string) {
    const workflows = pendingBuiltInWorkflows([]);
    mocks.storeState.workflows = workflows as unknown as Array<Record<string, unknown>>;
    return workflows.find((workflow) => workflow.id === id)!;
  }

  beforeEach(() => {
    mocks.corsSafeFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/upload/image')) {
        const file = (init?.body as FormData).get('image') as File;
        return jsonResponse({ name: file.type.startsWith('video/') ? 'dlss5-input.mp4' : 'dlss5-input.png', subfolder: '', type: 'input' });
      }
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-dlss5' });
      if (url.includes('/history/')) return jsonResponse({
        'prompt-dlss5': { status: { completed: true }, outputs: {
          '4': { images: [{ filename: 'enhanced.png', subfolder: '', type: 'output' }] },
          '6': { images: [{ filename: 'enhanced.mp4', subfolder: '', type: 'output' }] },
        } },
      });
      if (url.includes('/object_info/')) return jsonResponse({});
      throw new Error(`未预期的请求：${url}`);
    });
  });

  it('增量添加两项 DLSS5，保留用户编辑、删除记录及同名导入项', () => {
    const all = resetBuiltInWorkflows();
    const existing = all.filter((workflow) => !ids.includes(workflow.id));
    expect(existing).toHaveLength(13);
    localStorage.setItem('aicanvas.builtinWorkflows.seededIds', JSON.stringify(existing.map((workflow) => workflow.id)));
    existing.pop();
    existing[0].name = '用户编辑';
    existing.push({ ...all[0], id: 'wf-user-dlss5', fileContent: '{"user":"edited"}' });
    const before = JSON.stringify(existing);
    const pending = pendingBuiltInWorkflows(existing);
    expect(pending.map((workflow) => workflow.id)).toEqual(ids);
    expect(pending.map((workflow) => workflow.category)).toEqual(['ai-image', 'ai-video']);
    expect(JSON.stringify(existing)).toBe(before);
    expect(pendingBuiltInWorkflows(existing)).toEqual([]);
    expect(resetBuiltInWorkflows().filter((workflow) => ids.includes(workflow.id))).toHaveLength(2);
  });

  it.each(ids)('%s 保留编辑布局、增强参数和全部连线，执行图不包含说明或上传控件', (id) => {
    const workflow = install(id);
    const api = JSON.parse(workflow.fileContent);
    const ui = JSON.parse(workflow.editableContent!);
    const isImage = id === ids[0];
    const type = isImage ? 'image' : 'video';
    expect(workflow.defaultNodes).toEqual({ [type]: '1' });
    expect(workflow.ioNodes).toEqual([{ nodeId: '1', title: isImage ? 'LoadImage' : '① 选择/上传视频', type }]);
    expect(Object.keys(api)).toHaveLength(isImage ? 4 : 5);
    expect(api['5']).toBeUndefined();
    expect(ui.nodes.find((node: { type: string }) => node.type === 'MarkdownNote')).toBeTruthy();
    for (const node of ui.nodes.filter((node: { type: string }) => node.type !== 'MarkdownNote')) {
      expect(api[String(node.id)].class_type).toBe(node.type);
      expect(node.pos).toHaveLength(2);
    }
    for (const [, sourceId, slot, targetId, inputIndex] of ui.links) {
      const target = ui.nodes.find((node: { id: number }) => node.id === targetId);
      expect(api[String(targetId)].inputs[target.inputs[inputIndex].name]).toEqual([String(sourceId), slot]);
    }
    expect(api['2'].inputs).toEqual({
      upscaling_mode: '1x (DLAA / native)', nr_preset: 'Default', nr_style: 'Natural', nr_intensity: 1,
      local_tone_strength: 1, local_structure_strength: 1.5, skin_structure_strength: 2,
      automatic_mask: true, dlss_model_preset: 'M', motion: 'auto', scene_change_threshold: 0.24,
      warmup_frames: 0, runtime_dir: '',
    });
    expect(api['3'].inputs.verify_neural_rendering).toBe(true);
    expect(api['1'].inputs[type]).toBe('');
    if (isImage) {
      expect(ui.nodes.find((node: { id: number }) => node.id === 1).widgets_values[0]).toBe('');
      expect(api['4'].inputs.filename_prefix).toBe('DLSS5_NR');
      expect(api['1'].inputs).toEqual({ image: '' });
    } else {
      expect(api['1'].inputs).not.toHaveProperty('videopreview');
      expect(api['1'].inputs).not.toHaveProperty('choose video to upload');
      expect(api['4'].inputs).toMatchObject({ audio: ['1', 2], fps: 24, bit_depth: 10 });
      expect(api['6'].inputs).toEqual({ video: ['4', 0], filename_prefix: 'DLSS5_NR_video', format: 'auto', codec: 'auto' });
    }
    expect(withBuiltInEditableContent(workflow)).toBeNull();
    expect(withBuiltInEditableContent({ ...workflow, editableContent: undefined })?.editableContent).toBe(workflow.editableContent);
  });

  it('图片引用上传到默认输入，取回图片且不修改源图', async () => {
    const workflow = install(ids[0]);
    const original = workflow.fileContent;
    const result = await executeComfyUIGenerate({ prompt: '', model: 'wf', provider: 'comfyui', workflowId: workflow.id },
      undefined, ['data:image/png;base64,RExTUzU=']);
    const graph = submittedWorkflow();
    expect(graph['1'].inputs.image).toBe('dlss5-input.png');
    expect(graph['3'].inputs).toMatchObject({ images: ['1', 0], settings: ['2', 0] });
    expect(graph['2']).toEqual(JSON.parse(original)['2']);
    expect(result.url).toContain('enhanced.png');
    expect(workflow.fileContent).toBe(original);
  });

  it('视频引用上传到默认输入，保留音轨和整段加载参数，取回视频且不修改源图', async () => {
    const workflow = install(ids[1]);
    const original = workflow.fileContent;
    const result = await executeComfyUIVideoGenerate({
      prompt: '', model: 'wf', provider: 'comfyui', workflowId: workflow.id, videoFps: 30,
      videoResolution: 1280, seedanceDuration: 5,
    }, undefined, [], { videoUrls: ['data:video/mp4;base64,RExTUzU='] });
    const graph = submittedWorkflow();
    expect(graph['1'].inputs).toMatchObject({ video: 'dlss5-input.mp4', force_rate: 0, custom_width: 0,
      custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' });
    expect(graph['4'].inputs).toEqual({ images: ['3', 0], audio: ['1', 2], fps: 30, bit_depth: 10 });
    expect(graph['2']).toEqual(JSON.parse(original)['2']);
    expect(result.url).toContain('enhanced.mp4');
    expect(workflow.fileContent).toBe(original);
  });
});

describe('内置 Qwen3 音频工作流', () => {
  const ids = ['builtin-qwen3-voice-clone', 'builtin-qwen3-voice-design', 'builtin-qwen3-reference-voice-design'];
  const reference = 'data:audio/wav;base64,UXdlbi1yZWZlcmVuY2U=';

  beforeEach(() => {
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/upload/image')) return jsonResponse({ name: 'qwen-reference.wav', subfolder: '', type: 'input' });
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-qwen' });
      if (url.includes('/history/')) return jsonResponse({
        'prompt-qwen': { status: { completed: true }, outputs: {
          save: { audio: [{ filename: 'qwen.flac', subfolder: 'audio', type: 'output' }] },
        } },
      });
      throw new Error(`未预期的请求：${url}`);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function install(id: string) {
    const workflows = pendingBuiltInWorkflows([]);
    mocks.storeState.workflows = workflows as unknown as Array<Record<string, unknown>>;
    return workflows.find((workflow) => workflow.id === id)!;
  }

  it('已有其他项的用户只补三个 Qwen3 工作流，保留修改且不重复播种', () => {
    const existing = resetBuiltInWorkflows().filter((workflow) => !ids.includes(workflow.id));
    expect(existing).toHaveLength(12);
    existing[0].name = '自定义 AuK';
    localStorage.setItem('aicanvas.builtinWorkflows.seededIds', JSON.stringify(existing.map((workflow) => workflow.id)));
    const pending = pendingBuiltInWorkflows(existing);
    expect(pending.map((workflow) => workflow.id)).toEqual(ids);
    expect(pending.every((workflow) => workflow.category === 'ai-audio')).toBe(true);
    expect(existing[0].name).toBe('自定义 AuK');
    expect(pendingBuiltInWorkflows(existing)).toEqual([]);
  });

  it.each(ids)('%s 保留编辑布局、执行连线及采样字段，剔除 UI 种子控件', (id) => {
    const workflow = install(id);
    const api = JSON.parse(workflow.fileContent);
    const ui = JSON.parse(workflow.editableContent!);
    const executable = ui.nodes.filter((node: { type: string }) => !['Note', 'MarkdownNote'].includes(node.type));
    expect(Object.keys(api)).toHaveLength(executable.length);
    for (const node of executable) {
      expect(api[String(node.id)].class_type).toBe(node.type);
      expect(node.pos).toHaveLength(2);
    }
    for (const [, sourceId, slot, targetId, inputIndex] of ui.links) {
      const target = ui.nodes.find((node: { id: number }) => node.id === targetId);
      expect(api[String(targetId)].inputs[target.inputs[inputIndex].name]).toEqual([String(sourceId), slot]);
    }
    const synth = id === ids[1] ? api['1'] : api['3'];
    expect(synth.inputs).toMatchObject({ model_choice: '1.7B', precision: 'bf16', seed: 20260916,
      max_new_tokens: 1536, top_p: 0.9, top_k: 50, repetition_penalty: 1.05, attention: 'sdpa', unload_model_after_generate: true });
    expect(Object.values(synth.inputs)).not.toContain('randomize');
    expect(Object.values(synth.inputs)).not.toContain('fixed');
    if (id !== ids[1]) {
      expect(api['2'].inputs).toEqual({ model: 'Qwen/Qwen3-ASR-1.7B-hf', precision: 'bf16', language: 'auto',
        hints: '', normalize_text: false, unload_models: true, audio: ['1', 0] });
    }
    expect(withBuiltInEditableContent({ ...workflow, editableContent: undefined })?.editableContent).toBe(workflow.editableContent);
  });

  it.each([ids[0], ids[2]])('%s 注入新台词和参考音频，保留 ASR 连线与源图', async (id) => {
    const workflow = install(id);
    const original = workflow.fileContent;
    const result = await executeComfyUIAudioGenerate({ prompt: '这回说新的台词。', model: 'wf', provider: 'comfyui', workflowId: id }, undefined, [reference]);
    const graph = submittedWorkflow();
    expect(graph['1'].inputs.audio).toBe('qwen-reference.wav');
    expect(graph['3'].inputs.target_text).toBe('这回说新的台词。');
    expect(graph['3'].inputs.ref_text).toEqual(['2', 0]);
    expect(graph['3'].inputs.ref_audio).toEqual(['1', 0]);
    expect(graph['3'].inputs.seed).toBe(20260916);
    expect(result.url).toContain('qwen.flac');
    expect(workflow.fileContent).toBe(original);
    if (id === ids[2]) {
      const originalGraph = JSON.parse(original);
      expect(graph['5'].inputs.text).toBe(originalGraph['5'].inputs.text);
      expect(graph['5'].inputs.instruct).toBe(originalGraph['5'].inputs.instruct);
      expect(graph['6']).toEqual(originalGraph['6']);
      expect(graph['4'].inputs.audio).toEqual(['6', 0]);
    }
  });

  it.each([ids[0], ids[2]])('%s 显式台词和音频优先于默认值，保留参考转写', async (id) => {
    install(id);
    const explicitReference = `data:audio/wav;base64,${btoa(id)}`;
    await executeComfyUIAudioGenerate({ prompt: '默认台词', model: 'wf', provider: 'comfyui', workflowId: id,
      workflowInputs: { '3': '显式新台词', '1': explicitReference } }, undefined, [explicitReference]);
    const graph = submittedWorkflow();
    expect(graph['3'].inputs.target_text).toBe('显式新台词');
    expect(graph['3'].inputs.ref_text).toEqual(['2', 0]);
    const uploads = mocks.corsSafeFetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/image'));
    expect(uploads).toHaveLength(1);
    expect(await ((uploads[0][1].body as FormData).get('image') as Blob).text()).toBe(id);
  });

  it('文生抽卡仅替换朗读正文，保留音色描述，不上传音频', async () => {
    const workflow = install(ids[1]);
    const source = JSON.parse(workflow.fileContent);
    await executeComfyUIAudioGenerate({ prompt: '新的朗读正文', model: 'wf', provider: 'comfyui', workflowId: workflow.id });
    const graph = submittedWorkflow();
    expect(graph['1'].inputs.text).toBe('新的朗读正文');
    expect(graph['1'].inputs.instruct).toBe(source['1'].inputs.instruct);
    expect(graph['2'].inputs.audio).toEqual(['1', 0]);
    expect(mocks.corsSafeFetch.mock.calls.some(([url]) => String(url).endsWith('/upload/image'))).toBe(false);
  });

  it.each([[ids[1], '1'], [ids[2], '5']])('%s 连续抽卡只更换声音设计种子，不写回源图', async (id, designNodeId) => {
    const workflow = install(id);
    const original = { api: workflow.fileContent, ui: workflow.editableContent };
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const params = { prompt: '抽卡正文', model: 'wf', provider: 'comfyui', workflowId: id };
    await executeComfyUIAudioGenerate(params, undefined, id === ids[2] ? [reference] : []);
    expect(submittedWorkflow()[designNodeId].inputs.seed).toBe(Math.floor(0.25 * Number.MAX_SAFE_INTEGER));
    mocks.corsSafeFetch.mockClear();
    random.mockReturnValue(0.75);
    await executeComfyUIAudioGenerate(params, undefined, id === ids[2] ? [reference] : []);
    expect(submittedWorkflow()[designNodeId].inputs.seed).toBe(Math.floor(0.75 * Number.MAX_SAFE_INTEGER));
    expect(workflow.fileContent).toBe(original.api);
    expect(workflow.editableContent).toBe(original.ui);
  });

  it.each(['fixed', 'missing', 'invalid', 'linked'])('声音设计种子控制为 %s 时不随机', async (mode) => {
    const workflow = install(ids[1]);
    const ui = JSON.parse(workflow.editableContent!);
    const node = ui.nodes.find((item: { id: number }) => item.id === 1);
    node.widgets_values[7] = 'fixed';
    if (mode === 'linked') {
      node.widgets_values[7] = 'randomize';
      node.inputs.find((input: { name: string }) => input.name === 'seed').link = 9;
    }
    workflow.editableContent = mode === 'missing' ? undefined : mode === 'invalid' ? '{' : JSON.stringify(ui);
    await executeComfyUIAudioGenerate({ prompt: '固定种子', model: 'wf', provider: 'comfyui', workflowId: workflow.id });
    expect(submittedWorkflow()['1'].inputs.seed).toBe(20260916);
  });

  it('面板设置进入完整提交图：克隆、目标音色、ASR、转换分别映射', async () => {
    const workflow = install(ids[2]);
    const source = workflow.fileContent;
    const fallback = mocks.corsSafeFetch.getMockImplementation()!;
    mocks.corsSafeFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/object_info/SeedVCVoiceConversion')) return jsonResponse({ SeedVCVoiceConversion: { input: {
        required: { pitch_shift: ['INT', { min: -12, max: 12 }] },
      } } });
      return fallback(url, init);
    });
    await executeComfyUIAudioGenerate({ prompt: '默认正文', model: 'wf', provider: 'comfyui', workflowId: workflow.id,
      workflowInputs: { '3': '真正要说的台词', '5': '显式目标音色样本' },
      audioSpeechSettings: { qwen: { [workflow.id]: {
        'clone.seed_mode': 'fixed', 'clone.seed': 789, 'clone.temperature': 0.65, 'clone.language': 'Chinese',
        'design.seed_mode': 'fixed', 'design.seed': 456, 'design.instruct': '温柔女声', 'design.pace': 3,
        'design.text': '旧样本正文', 'asr.hints': '公司名称', 'asr.normalize_text': true, 'conversion.pitch_shift': -2,
      } } },
    }, undefined, [reference]);
    const graph = submittedWorkflow();
    expect(graph['3'].inputs).toMatchObject({ target_text: '真正要说的台词', seed: 789, temperature: 0.65, ref_text: ['2', 0] });
    expect(graph['5'].inputs).toMatchObject({ instruct: '温柔女声\n语速偏快。', seed: 456, text: '显式目标音色样本' });
    expect(graph['2'].inputs).toMatchObject({ hints: '公司名称', normalize_text: true });
    expect(graph['6'].inputs).toMatchObject({ pitch_shift: -2, source_audio: ['3', 0], target_voice: ['5', 0] });
    expect(workflow.fileContent).toBe(source);
  });

  it.each(['out-of-range', 'unavailable'])('SeedVC 声明 %s 时阻止无效面板参数提交', async (scenario) => {
    const workflow = install(ids[2]);
    const oldUrl = mocks.storeState.config.comfyUIUrl;
    mocks.storeState.config.comfyUIUrl = `http://seedvc-${scenario}.test:8188`;
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.includes('/object_info/')) return jsonResponse(scenario === 'unavailable' ? {} : {
        SeedVCVoiceConversion: { input: { required: { pitch_shift: ['INT', { min: -12, max: 12 }] } } },
      });
      throw new Error('不应上传或提交');
    });
    try {
      await expect(executeComfyUIAudioGenerate({ prompt: '正文', model: 'wf', provider: 'comfyui', workflowId: workflow.id,
        audioSpeechSettings: { qwen: { [workflow.id]: { 'conversion.pitch_shift': 100 } } },
      }, undefined, [reference])).rejects.toThrow(scenario === 'unavailable' ? '无法读取 SeedVC' : '不符合目标 ComfyUI');
      expect(mocks.corsSafeFetch.mock.calls.every(([url]) => String(url).includes('/object_info/'))).toBe(true);
    } finally { mocks.storeState.config.comfyUIUrl = oldUrl; }
  });

  it.each([ids[0], ids[2]])('%s 未添加参考语音时在请求前给出明确提示', async (id) => {
    install(id);
    await expect(executeComfyUIAudioGenerate({ prompt: '台词', model: 'wf', provider: 'comfyui', workflowId: id })).rejects.toThrow('请添加参考语音');
    expect(mocks.corsSafeFetch).not.toHaveBeenCalled();
  });
});

describe('内置 H3 PDD 与 Breeze TTS 2', () => {
  const ids = [
    'builtin-minimax-h3-pdd-i2v', 'builtin-minimax-h3-pdd-i2v-audio',
    'builtin-breeze-tts2-voice-clone', 'builtin-breeze-tts2-voice-design',
  ];
  function install(id: string) {
    const workflows = pendingBuiltInWorkflows([]);
    mocks.storeState.workflows = workflows as unknown as Array<Record<string, unknown>>;
    return workflows.find((workflow) => workflow.id === id)!;
  }

  it('已有其他项时补齐四项单图PDD与Breeze，保留用户修改和删除记录', () => {
    const existing = resetBuiltInWorkflows().filter((workflow) => !ids.includes(workflow.id));
    expect(existing).toHaveLength(11);
    const seeded = existing.map((workflow) => workflow.id);
    const removedId = existing.pop()!.id;
    existing[0].name = '用户自定义';
    localStorage.setItem('aicanvas.builtinWorkflows.seededIds', JSON.stringify(seeded));
    const pending = pendingBuiltInWorkflows(existing);
    expect(pending.map((workflow) => workflow.id)).toEqual(ids);
    expect(pending.map((workflow) => workflow.category)).toEqual(['ai-video', 'ai-video', 'ai-audio', 'ai-audio']);
    expect(pending.some((workflow) => workflow.id === removedId)).toBe(false);
    expect(existing[0].name).toBe('用户自定义');
    expect(pendingBuiltInWorkflows([...existing, ...pending])).toEqual([]);
  });

  it.each([
    { id: ids[0], input: '7', image: '27', resolution: '22', duration: '24', math: '23', pdd: '6', video: '14' },
    { id: ids[1], input: '19', image: '35', resolution: '29', duration: '38', math: '37', pdd: '25', video: '26' },
  ])('$id 注入图片、参考音频及秒数，保持 PDD 与生成音轨', async (spec) => {
    const workflow = install(spec.id);
    const original = workflow.fileContent;
    const uploads: string[] = [];
    mocks.corsSafeFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const seedSchema = seedSchemaResponse(url); if (seedSchema) return seedSchema;
      if (url.endsWith('/upload/image')) {
        const file = (init?.body as FormData).get('image') as File;
        const name = file.type.startsWith('audio/') ? 'reference.wav' : 'reference.png';
        uploads.push(name);
        return jsonResponse({ name, subfolder: '', type: 'input' });
      }
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
      if (url.includes('/history/')) return jsonResponse({ 'prompt-1': {
        status: { completed: true }, outputs: { out: { images: [{ filename: 'pdd.mp4', subfolder: '', type: 'output' }] } },
      } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const withAudio = spec.id === ids[1];
    const result = await executeComfyUIVideoGenerate({
      workflowId: spec.id, prompt: '小满端起杯子', model: 'wf', provider: 'comfyui',
      seedanceRatio: '9:16', videoResolution: 480, seedanceDuration: 6, videoFps: 30,
    }, undefined, withAudio ? ['data:audio/wav;base64,SDNfUERE'] : [], {
      imageUrls: ['data:image/png;base64,' + btoa(spec.id)],
    });
    const graph = submittedWorkflow();
    expect(graph[spec.input].inputs).toMatchObject({
      prompt: '小满端起杯子', width: [spec.resolution, 0], height: [spec.resolution, 1], length: [spec.math, 1],
    });
    expect(graph[spec.image].inputs.image).toBe('reference.png');
    expect(graph[spec.resolution].inputs.aspect_ratio).toBe('9:16 (Portrait Widescreen)');
    expect(graph[spec.duration].inputs.value).toBe(6);
    expect(graph[spec.math].inputs['values.a']).toEqual([spec.duration, 0]);
    expect(graph[spec.pdd].inputs).toMatchObject({ pdd_file: 'MiniMax-H3-Ref2VA-Acc-8Step.safetensors', nfe: '8' });
    expect(graph[spec.video].inputs.fps).toBe(24);
    if (withAudio) {
      expect(graph['28'].inputs.audio).toBe('reference.wav');
      expect(graph['19'].inputs['ref_audios.ref_audio_0']).toEqual(['28', 0]);
      expect(graph['26'].inputs.audio).toEqual(['23', 0]);
    }
    expect(uploads).toHaveLength(withAudio ? 2 : 1);
    expect(result.url).toContain('pdd.mp4');
    expect(workflow.fileContent).toBe(original);
  });

  function audioResponses() {
    mocks.corsSafeFetch.mockImplementation(async (url: string) => {
      const seedSchema = seedSchemaResponse(url); if (seedSchema) return seedSchema;
      if (url.endsWith('/upload/image')) return jsonResponse({ name: 'breeze-reference.wav', subfolder: '', type: 'input' });
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-breeze' });
      if (url.includes('/history/')) return jsonResponse({ 'prompt-breeze': {
        status: { completed: true }, outputs: { out: { audio: [{ filename: 'breeze.flac', subfolder: 'audio', type: 'output' }] } },
      } });
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it('Breeze 克隆注入台词与参考音频，参考原文来自 Whisper', async () => {
    const workflow = install(ids[2]);
    const original = workflow.fileContent;
    audioResponses();
    const result = await executeComfyUIAudioGenerate({
      workflowId: workflow.id, prompt: '今天开业啦！', model: 'wf', provider: 'comfyui',
    }, undefined, ['data:audio/wav;base64,QlJFRVpFX0NMT05F']);
    const graph = submittedWorkflow();
    expect(workflow.defaultNodes).toEqual({ prompt: '12', audio: '8' });
    expect(graph['12'].inputs.value).toBe('今天开业啦！');
    expect(graph['8'].inputs.audio).toBe('breeze-reference.wav');
    expect(graph['13'].inputs).toMatchObject({ text: ['12', 0], reference_audio: ['11', 0], reference_text: ['11', 1] });
    expect(graph['10']).toBeUndefined();
    expect(result.url).toContain('breeze.flac');
    expect(workflow.fileContent).toBe(original);
  });

  it.each([false, true])('Breeze 声音设计区分朗读正文和音色描述：显式输入=%s', async (explicit) => {
    const workflow = install(ids[3]);
    const original = workflow.fileContent;
    const originalGraph = JSON.parse(original);
    audioResponses();
    await executeComfyUIAudioGenerate({
      workflowId: workflow.id, prompt: '欢迎光临。', model: 'wf', provider: 'comfyui',
      ...(explicit ? { workflowInputs: { '4': '显式朗读台词', '5': '温暖沉稳的成年女声' } } : {}),
    });
    const graph = submittedWorkflow();
    expect(workflow.defaultNodes).toEqual({ prompt: '4' });
    expect(graph['4'].inputs.value).toBe(explicit ? '显式朗读台词' : '欢迎光临。');
    expect(graph['5'].inputs.value).toBe(explicit ? '温暖沉稳的成年女声' : originalGraph['5'].inputs.value);
    expect(graph['2'].inputs).toMatchObject({ text: ['4', 0], instruction: ['5', 0] });
    expect(workflow.fileContent).toBe(original);
    expect(mocks.corsSafeFetch.mock.calls.some(([url]) => String(url).endsWith('/upload/image'))).toBe(false);
  });
});

describe('内置 H3 PDD 自由参考', () => {
  const id = 'builtin-minimax-h3-pdd-r2v';
  let requestNumber = 0;

  function install() {
    const workflows = pendingBuiltInWorkflows([]);
    mocks.storeState.workflows = workflows as unknown as Array<Record<string, unknown>>;
    return workflows.find((workflow) => workflow.id === id)!;
  }

  it('已有项只补缺少的自由参考，不覆盖用户修改、删除记录及同名 MCP 导入项', () => {
    const all = resetBuiltInWorkflows();
    const existing = all.filter((workflow) => workflow.id !== id);
    expect(existing).toHaveLength(14);
    localStorage.setItem('aicanvas.builtinWorkflows.seededIds', JSON.stringify(existing.map((workflow) => workflow.id)));
    const removed = existing.pop()!.id;
    existing[0].name = '保留用户修改';
    const imported = { ...all.find((workflow) => workflow.id === id)!, id: 'workflow-mcp-imported', fileContent: '{"user":"edited"}' };
    existing.push(imported);
    const before = JSON.stringify(existing);
    const pending = pendingBuiltInWorkflows(existing);
    expect(pending.map((workflow) => workflow.id)).toEqual([id]);
    expect(pending.some((workflow) => workflow.id === removed)).toBe(false);
    expect(JSON.stringify(existing)).toBe(before);
    expect(pendingBuiltInWorkflows(existing)).toEqual([]);
  });

  it('保留9图3视频3音频空槽、默认提示词19和五份配套模型', () => {
    const workflow = install();
    const graph = JSON.parse(workflow.fileContent);
    expect(workflow.category).toBe('ai-video');
    expect(workflow.defaultNodes).toEqual({ prompt: '19', image: '101', video: '201' });
    expect(workflow.editableContent).toBeUndefined();
    expect(Object.keys(graph)).toHaveLength(35);
    expect(workflow.ioNodes).toHaveLength(16);
    for (const [type, count] of [['prompt', 1], ['image', 9], ['video', 3], ['audio', 3]] as const) {
      const ios = workflow.ioNodes!.filter((io) => io.type === type);
      expect(ios).toHaveLength(count);
      if (type !== 'prompt') for (const io of ios) expect(graph[io.nodeId].inputs[type]).toBe('');
    }
    expect(graph['34'].inputs.unet_name).toBe('minimax_h3_ref2va_pruned_int8_convrot.safetensors');
    expect(graph['25'].inputs.pdd_file).toBe('MiniMax-H3-Ref2VA-Acc-8Step.safetensors');
    expect(graph['24'].inputs.clip_name).toBe('qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors');
    expect(graph['22'].inputs.vae_name).toBe('minimax_h3_video_vae_fp16.safetensors');
    expect(graph['27'].inputs.vae_name).toBe('minimax_h3_audio_vae_fp32.safetensors');
    expect(graph['900'].class_type).toBe('FL_UnloadAllModels');
    expect(graph['900'].inputs.value).toEqual(['16', 0]);
    expect(graph['33'].inputs.samples).toEqual(['900', 0]);
    expect(graph['23'].inputs.samples).toEqual(['16', 0]);
  });

  it('只迁移旧版视频解码连线，保留提示词和分辨率且不会重复迁移', () => {
    const workflow = install();
    const oldGraph = JSON.parse(workflow.fileContent);
    delete oldGraph['900'];
    oldGraph['33'].inputs.samples = ['16', 0];
    oldGraph['19'].inputs.prompt = '用户自己的提示词';
    oldGraph['29'].inputs.megapixels = 0.39;

    const upgraded = withBuiltInEditableContent({
      ...workflow,
      fileContent: JSON.stringify(oldGraph),
    });
    expect(upgraded).not.toBeNull();
    const graph = JSON.parse(upgraded!.fileContent);
    expect(graph['900'].class_type).toBe('FL_UnloadAllModels');
    expect(graph['33'].inputs.samples).toEqual(['900', 0]);
    expect(graph['23'].inputs.samples).toEqual(['16', 0]);
    expect(graph['19'].inputs.prompt).toBe('用户自己的提示词');
    expect(graph['29'].inputs.megapixels).toBe(0.39);
    expect(withBuiltInEditableContent(upgraded!)).toBeNull();
  });

  it('已有可编辑图或自定义视频解码连线不被自动覆盖', () => {
    const workflow = install();
    const oldGraph = JSON.parse(workflow.fileContent);
    delete oldGraph['900'];
    oldGraph['33'].inputs.samples = ['16', 0];
    const fileContent = JSON.stringify(oldGraph);
    expect(withBuiltInEditableContent({ ...workflow, fileContent, editableContent: '{"nodes":[]}' })).toBeNull();
    oldGraph['33'].inputs.samples = ['custom', 0];
    expect(withBuiltInEditableContent({ ...workflow, fileContent: JSON.stringify(oldGraph) })).toBeNull();
  });

  async function submit(counts: number[], mode: 'explicit' | 'automatic' | 'sparse' = 'explicit') {
    const workflow = install();
    const original = workflow.fileContent;
    const workflowInputs: Record<string, string> = {};
    const media: string[][] = [[], [], []];
    requestNumber++;
    const uploads: string[] = [];
    for (const [group, start, mime] of [[0, 101, 'image/png'], [1, 201, 'video/mp4'], [2, 301, 'audio/wav']] as const) {
      for (let i = 0; i < counts[group]; i++) {
        const url = `data:${mime};base64,${btoa(`builtin-optional-${id}-${requestNumber}-${group}-${i}`)}`;
        media[group].push(url);
        if (mode !== 'automatic') workflowInputs[String(start + i + (mode === 'sparse' ? 1 : 0))] = url;
      }
    }
    mocks.corsSafeFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const seedSchema = seedSchemaResponse(url); if (seedSchema) return seedSchema;
      if (url.endsWith('/upload/image')) {
        const file = (init?.body as FormData).get('image') as File;
        const name = `ref-${uploads.length + 1}.${file.type.split('/')[1]}`;
        uploads.push(name);
        return jsonResponse({ name, subfolder: '', type: 'input' });
      }
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'optional-prompt' });
      if (url.includes('/history/')) return jsonResponse({ 'optional-prompt': {
        status: { completed: true }, outputs: { '31': { videos: [{ filename: 'optional.mp4', type: 'output' }] } },
      } });
      throw new Error(`Unexpected request: ${url}`);
    });
    await executeComfyUIVideoGenerate({
      workflowId: id, model: 'wf', provider: 'comfyui', prompt: '小满推开酒馆门。', workflowInputs,
      seedanceRatio: '9:16', videoResolution: 480, seedanceDuration: 8,
    }, undefined, mode === 'automatic' ? media[2] : [], mode === 'automatic' ? { imageUrls: media[0], videoUrls: media[1] } : {});
    expect(workflow.fileContent).toBe(original);
    expect(uploads).toHaveLength(counts.reduce((total, count) => total + count, 0));
    return { graph: submittedWorkflow(), uploads };
  }

  it.each([[0, 0, 0], [1, 0, 0], [9, 0, 0], [0, 1, 0], [0, 3, 0], [0, 0, 1], [0, 0, 3], [1, 1, 1], [6, 3, 3], [9, 2, 1]])(
    '图%s 视频%s 音频%s：默认提示词生效，空槽不进入提交且无悬空连接', async (images, videos, audios) => {
      const counts = [images, videos, audios];
      const { graph } = await submit(counts);
      for (const [group, prefix, cls] of [[0, 'ref_images.', 'LoadImage'], [1, 'ref_videos.', 'VHS_LoadVideo'], [2, 'ref_audios.', 'LoadAudio']] as const) {
        expect(Object.keys(graph['19'].inputs).filter((key) => key.startsWith(prefix))).toHaveLength(counts[group]);
        expect(Object.values(graph).filter((node) => node.class_type === cls)).toHaveLength(counts[group]);
      }
      for (const node of Object.values(graph)) {
        for (const value of Object.values(node.inputs)) if (Array.isArray(value)) expect(graph[value[0]]).toBeDefined();
      }
      expect(graph['19'].inputs.prompt).toBe('小满推开酒馆门。');
      expect(graph['26'].inputs.audio).toEqual(['23', 0]);
      expect(graph['25'].inputs.nfe).toBe('8');
    },
  );

  it('该内置默认配置接收6图3视频3音频，三段音频按顺序入槽', async () => {
    const { graph, uploads } = await submit([6, 3, 3], 'automatic');
    expect([101, 102, 103, 104, 105, 106].map((node) => graph[String(node)].inputs.image)).toEqual(uploads.slice(0, 6));
    expect([201, 202, 203].map((node) => graph[String(node)].inputs.video)).toEqual(uploads.slice(6, 9));
    expect([301, 302, 303].map((node) => graph[String(node)].inputs.audio)).toEqual(uploads.slice(9));
    expect(graph['107']).toBeUndefined();
    expect(graph['19'].inputs.prompt).toBe('小满推开酒馆门。');
  });

  it('显式只填第二槽时保留已填素材，并清理第一空槽', async () => {
    const { graph } = await submit([1, 1, 1], 'sparse');
    for (const node of ['101', '201', '301']) expect(graph[node]).toBeUndefined();
    for (const node of ['102', '202', '302']) expect(graph[node]).toBeDefined();
  });
});
