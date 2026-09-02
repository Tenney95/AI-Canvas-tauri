import { beforeEach, describe, expect, it, vi } from 'vitest';

const comfyFetchMock = vi.hoisted(() => vi.fn());
const pollComfyHistoryMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/comfyPolling', () => ({
  comfyFetch: comfyFetchMock,
  pollComfyHistory: pollComfyHistoryMock,
}));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: () => false,
  persistMediaUrlToProjectData: vi.fn(),
  saveWorkflow: vi.fn(),
}));
vi.mock('../../src/services/comfyWorkflowService', () => ({
  formatComfyPromptError: (status: number) => `ComfyUI 拒绝了工作流 (${status})`,
}));

import { useAppStore } from '../../src/store/useAppStore';
import {
  clearComfyAgentCachesForTests,
  discoverComfyUI,
  executeValidatedComfyUIWorkflow,
  saveCompletedComfyUIWorkflow,
  validateComfyUIWorkflow,
} from '../../src/services/comfyAgentService';

const objectInfo = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['base.safetensors', 'other.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'],
    python_module: 'nodes',
  },
  CustomSampler: {
    input: {
      required: {
        model: ['MODEL'],
        sampler_name: [['euler', 'dpmpp_2m']],
      },
    },
    output: ['LATENT'],
    python_module: 'custom_nodes.magic_sampler',
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'] } },
    output_node: true,
    python_module: 'nodes',
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function workflow() {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    '2': {
      class_type: 'CustomSampler',
      inputs: { model: ['1', 0], sampler_name: 'euler' },
    },
    '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState((state) => ({
    config: { ...state.config, comfyUIUrl: 'http://127.0.0.1:8188/' },
  }));
  clearComfyAgentCachesForTests();
  comfyFetchMock.mockReset();
  pollComfyHistoryMock.mockReset();
});

describe('ComfyUI assistant discovery', () => {
  it('reads model folders and files from ComfyUI APIs', async () => {
    comfyFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/models')) return jsonResponse(['checkpoints', 'loras']);
      if (url.endsWith('/models/checkpoints')) return jsonResponse(['base.safetensors']);
      if (url.endsWith('/models/loras')) return jsonResponse(['detail.safetensors']);
      throw new Error(`unexpected ${url}`);
    });

    const result = await discoverComfyUI({ resource: 'models' });

    expect(result).toMatchObject({
      source: 'ComfyUI API',
      folderCount: 2,
      folders: [
        { folder: 'checkpoints', models: ['base.safetensors'] },
        { folder: 'loras', models: ['detail.safetensors'] },
      ],
    });
  });

  it('falls back to object_info combo values on older ComfyUI versions', async () => {
    comfyFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/models')) return jsonResponse({ error: 'missing' }, 404);
      if (url.endsWith('/object_info')) return jsonResponse(objectInfo);
      throw new Error(`unexpected ${url}`);
    });

    const result = await discoverComfyUI({ resource: 'models', query: 'base' });

    expect(result.folders).toContainEqual({
      folder: 'ckpt',
      models: ['base.safetensors'],
      total: 2,
    });
  });
});

describe('ComfyUI assistant workflow validation and execution', () => {
  beforeEach(() => {
    comfyFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info')) return jsonResponse(objectInfo);
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
      if (url.includes('/api/jobs/')) return jsonResponse({ ok: true });
      throw new Error(`unexpected ${url}`);
    });
  });

  it('allows every currently registered custom node and records selected models', async () => {
    const result = await validateComfyUIWorkflow({
      workflow: workflow(),
      kind: 'image',
      taskId: 'task-1',
      projectId: 'project-1',
    });

    expect(result).toMatchObject({
      kind: 'image',
      nodeCount: 3,
      outputNodeCount: 1,
      customNodeClasses: ['CustomSampler'],
      modelNames: ['base.safetensors'],
    });
  });

  it('rejects missing nodes, dangling links, and invalid combo values before submission', async () => {
    const invalid = workflow();
    invalid['2'].inputs = { model: ['missing', 0], sampler_name: 'not-installed' };
    invalid['3'].class_type = 'UnknownSaveNode';

    await expect(validateComfyUIWorkflow({
      workflow: invalid,
      kind: 'image',
      taskId: 'task-1',
      projectId: 'project-1',
    })).rejects.toThrow(/不存在的节点|未注册|允许的选项/);
  });

  it('submits a validated workflow and resolves its media output', async () => {
    const validated = await validateComfyUIWorkflow({
      workflow: workflow(),
      kind: 'image',
      taskId: 'task-1',
      projectId: 'project-1',
    });
    pollComfyHistoryMock.mockImplementation(async (
      _baseUrl: string,
      _promptId: string,
      _timeout: string,
      extract: (outputs: unknown) => unknown,
    ) => extract({ '3': { images: [{ filename: 'result.png', type: 'output' }] } }));

    const result = await executeValidatedComfyUIWorkflow({
      validationId: validated.validationId,
      taskId: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      prompt: '一只猫',
      deliveryMode: 'chat',
    });

    expect(result).toMatchObject({
      artifact: {
        kind: 'image',
        provider: 'comfyui',
        persistence: 'skipped',
        modelId: 'base.safetensors',
      },
      saveOffer: {
        suggestedName: 'base-图像工作流',
        kind: 'image',
      },
    });
    expect(result.artifact.url).toContain('/view?filename=result.png');
    expect(comfyFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8188/prompt',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('requests remote cancellation when local execution is aborted after submission', async () => {
    const validated = await validateComfyUIWorkflow({
      workflow: workflow(),
      kind: 'image',
      taskId: 'task-1',
      projectId: 'project-1',
    });
    const controller = new AbortController();
    pollComfyHistoryMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });

    await expect(executeValidatedComfyUIWorkflow({
      validationId: validated.validationId,
      taskId: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      prompt: '一只猫',
      deliveryMode: 'chat',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(comfyFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8188/api/jobs/prompt-1/cancel',
      { method: 'POST' },
    );
  });

  it('saves a successfully executed workflow into workflow management after consent', async () => {
    const validated = await validateComfyUIWorkflow({
      workflow: workflow(),
      kind: 'image',
      taskId: 'task-1',
      projectId: 'project-1',
    });
    pollComfyHistoryMock.mockImplementation(async (
      _baseUrl: string,
      _promptId: string,
      _timeout: string,
      extract: (outputs: unknown) => unknown,
    ) => extract({ '3': { images: [{ filename: 'result.png', type: 'output' }] } }));
    const executed = await executeValidatedComfyUIWorkflow({
      validationId: validated.validationId,
      taskId: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      prompt: '一只猫',
      deliveryMode: 'chat',
    });

    const saved = await saveCompletedComfyUIWorkflow({
      saveOfferId: executed.saveOffer.saveOfferId,
      conversationId: 'conversation-1',
      projectId: 'project-1',
      name: '我的猫咪工作流',
    });

    expect(saved).toMatchObject({ name: '我的猫咪工作流', category: 'ai-image' });
    expect(useAppStore.getState().workflows).toContainEqual(expect.objectContaining({
      id: saved.id,
      name: '我的猫咪工作流',
      category: 'ai-image',
      fileName: '我的猫咪工作流.json',
    }));
    await expect(saveCompletedComfyUIWorkflow({
      saveOfferId: executed.saveOffer.saveOfferId,
      conversationId: 'conversation-1',
      projectId: 'project-1',
      name: '重复保存',
    })).rejects.toThrow('保存凭证已失效');
  });
});
