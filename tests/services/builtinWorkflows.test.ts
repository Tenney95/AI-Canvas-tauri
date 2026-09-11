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
}));

import { pendingBuiltInWorkflows } from '../../src/services/builtinWorkflows';
import { executeComfyUIVideoGenerate } from '../../src/services/comfyWorkflowService';
import { resolveVideoSubmissionControls } from '../../src/services/ai/videoRequestResolver';
import type { WorkflowDefinition } from '../../src/types';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function submittedWorkflow(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const call = mocks.corsSafeFetch.mock.calls.find(([url]) => String(url).endsWith('/prompt'));
  return JSON.parse(String((call?.[1] as RequestInit).body)).prompt;
}

/** 把内置工作流装进 store，然后按 id 提交一次 */
async function runBuiltIn(
  workflowId: string,
  params: Parameters<typeof executeComfyUIVideoGenerate>[0],
  promptMedia: { imageUrls?: string[]; videoUrls?: string[] } = {},
) {
  const workflows = pendingBuiltInWorkflows([]);
  mocks.storeState.workflows = workflows as unknown as Array<Record<string, unknown>>;
  await executeComfyUIVideoGenerate({ ...params, workflowId }, undefined, [], promptMedia);
  return workflows.find((workflow) => workflow.id === workflowId) as WorkflowDefinition;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.corsSafeFetch.mockImplementation(async (url: string) => {
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
  it('首次启动播种六个工作流，之后不再重复添加', () => {
    const first = pendingBuiltInWorkflows([]);
    expect(first).toHaveLength(6);
    expect(first.every((workflow) => workflow.category === 'ai-video')).toBe(true);
    expect(pendingBuiltInWorkflows([])).toHaveLength(0);
  });

  it('只记账已经建出来的，剩下的下次启动继续补', () => {
    localStorage.setItem(
      'aicanvas.builtinWorkflows.seededIds',
      JSON.stringify(['builtin-minimax-h3-t2v']),
    );
    const pending = pendingBuiltInWorkflows([]);
    expect(pending.map((workflow) => workflow.id)).not.toContain('builtin-minimax-h3-t2v');
    expect(pending).toHaveLength(5);
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

  it('文生视频：分辨率写进 ResolutionSelector，时长写进秒数节点，帧率保持工作流原值', async () => {
    await runBuiltIn('builtin-minimax-h3-t2v', {
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
    await runBuiltIn(workflowId, {
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
    await runBuiltIn(
      'builtin-minimax-h3-i2v',
      { prompt: '让它动起来', model: 'wf', provider: 'comfyui', seedanceRatio: '9:16' },
      { imageUrls: ['data:image/png;base64,QUJD'] },
    );

    const submitted = submittedWorkflow();
    expect(submitted['114'].inputs.image).toBe('upload_1.png');
    expect(submitted['115'].inputs.aspect_ratio).toBe('9:16 (Portrait Widescreen)');
  });

  it('参考生视频：只给一张图时，多余的参考位连同视频链路一起摘掉', async () => {
    await runBuiltIn(
      'builtin-minimax-h3-r2v-turbo',
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

  it('参考生视频：两张图各就各位，不会互相覆盖', async () => {
    await runBuiltIn(
      'builtin-minimax-h3-r2v',
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
