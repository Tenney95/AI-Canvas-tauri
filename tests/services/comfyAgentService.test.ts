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
  getComfyWorkflowSaveOfferSummary,
  getValidatedComfyWorkflowSummary,
  saveCompletedComfyUIWorkflow,
  validateComfyUIWorkflow,
} from '../../src/services/comfyAgentService';
import { comfyBaseUrlFor } from '../../src/services/comfyServers';

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

describe('ComfyUI assistant server selection', () => {
  const remoteUrl = 'http://comfy-video.test:8288';
  const validationArgs = { kind: 'image' as const, taskId: 'task-1', projectId: 'project-1', serverId: 'video-server' };
  const executionArgs = { taskId: 'task-1', projectId: 'project-1', conversationId: 'conversation-1', prompt: '猫', deliveryMode: 'chat' as const };

  beforeEach(() => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      comfyServers: [
        { id: 'video-server', name: '视频服务器', url: `${remoteUrl}/` },
        { id: 'other-server', name: '视频服务器', url: 'http://comfy-other.test:8188' },
      ],
    } }));
    comfyFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/object_info')) return jsonResponse(objectInfo);
      if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'remote-task' });
      if (url.includes('/api/jobs/')) return jsonResponse({ ok: true });
      throw new Error(`unexpected ${url}`);
    });
    pollComfyHistoryMock.mockImplementation(async (
      _baseUrl: string, _promptId: string, _timeout: string, extract: (outputs: unknown) => unknown,
    ) => extract({ '3': { images: [{ filename: 'remote.png', type: 'output' }] } }));
  });

  it('lists configured server identities without exposing addresses or sending network requests', async () => {
    const result = await discoverComfyUI({ resource: 'servers' });
    expect(result.servers).toEqual([
      { serverName: '默认服务器', isDefault: true },
      { serverId: 'video-server', serverName: '视频服务器', isDefault: false },
      { serverId: 'other-server', serverName: '视频服务器', isDefault: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('http');
    expect(comfyFetchMock).not.toHaveBeenCalled();
  });

  it('supports an additional server when the default URL is empty', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, comfyUIUrl: '' } }));
    expect((await discoverComfyUI({ resource: 'servers' })).servers).toHaveLength(2);
    await expect(discoverComfyUI({ resource: 'nodes' })).rejects.toThrow('serverId');
    const result = await discoverComfyUI({ resource: 'nodes', serverId: 'video-server' });
    expect(result).toMatchObject({ serverId: 'video-server', serverName: '视频服务器', returned: 3 });
    expect(comfyFetchMock).toHaveBeenCalledWith(`${remoteUrl}/object_info`);
  });

  it.each(['missing-server', '', 'http://unconfigured.test'])('rejects unknown selection %s without default fallback', async (serverId) => {
    await expect(discoverComfyUI({ resource: 'nodes', serverId })).rejects.toThrow('服务器不存在');
    expect(comfyFetchMock).not.toHaveBeenCalled();
  });

  it('does not list or request a server with an invalid API URL', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config, comfyServers: [{ id: 'bad', name: '无效服务', url: 'file:///workflow.json' }],
    } }));
    expect((await discoverComfyUI({ resource: 'servers' })).servers).toHaveLength(1);
    await expect(discoverComfyUI({ resource: 'nodes', serverId: 'bad' })).rejects.toThrow('地址无效');
    expect(comfyFetchMock).not.toHaveBeenCalled();
  });

  it('isolates node and model caches when alternating between two servers', async () => {
    comfyFetchMock.mockImplementation(async (url: string) => {
      const remote = url.startsWith(remoteUrl);
      const modelName = remote ? 'remote.safetensors' : 'local.safetensors';
      if (url.endsWith('/models')) return jsonResponse(['checkpoints']);
      if (url.endsWith('/models/checkpoints')) return jsonResponse([modelName]);
      if (url.endsWith('/object_info')) return jsonResponse({ [remote ? 'RemoteNode' : 'LocalNode']: { output: [] } });
      throw new Error(`unexpected ${url}`);
    });
    for (const serverId of [undefined, 'video-server', undefined, 'video-server']) {
      const nodes = await discoverComfyUI({ resource: 'nodes', serverId });
      const models = await discoverComfyUI({ resource: 'models', serverId });
      expect(nodes.nodes).toEqual([expect.objectContaining({ classType: serverId ? 'RemoteNode' : 'LocalNode' })]);
      expect(models.folders).toEqual([expect.objectContaining({ models: [serverId ? 'remote.safetensors' : 'local.safetensors'] })]);
    }
    expect(comfyFetchMock).toHaveBeenCalledTimes(6);
  });

  it('evicts a failed cache entry so an explicit retry can recover immediately', async () => {
    comfyFetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(discoverComfyUI({ resource: 'nodes', serverId: 'video-server' })).rejects.toThrow('503');
    expect((await discoverComfyUI({ resource: 'nodes', serverId: 'video-server' })).returned).toBe(3);
    expect(comfyFetchMock).toHaveBeenCalledTimes(2);
  });

  it('validates installed models against the selected server definitions', async () => {
    comfyFetchMock.mockImplementation(async (url: string) => {
      const info = structuredClone(objectInfo);
      if (url.startsWith(remoteUrl)) info.CheckpointLoaderSimple.input.required.ckpt_name = [['remote.safetensors']];
      return jsonResponse(info);
    });
    const remoteWorkflow = workflow();
    remoteWorkflow['1'].inputs.ckpt_name = 'remote.safetensors';
    expect(await validateComfyUIWorkflow({ ...validationArgs, workflow: remoteWorkflow })).toMatchObject({ modelNames: ['remote.safetensors'] });
    await expect(validateComfyUIWorkflow({ ...validationArgs, serverId: undefined, workflow: remoteWorkflow })).rejects.toThrow('允许的选项');
  });

  it.each(['discover', 'validate'])('rejects a stale %s result if the target changes while reading definitions', async (action) => {
    let finish!: (value: Response) => void;
    comfyFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const request = action === 'discover'
      ? discoverComfyUI({ resource: 'nodes', serverId: 'video-server' })
      : validateComfyUIWorkflow({ ...validationArgs, workflow: workflow() });
    const rejected = expect(request).rejects.toThrow('服务器已删除或地址已变化');
    useAppStore.setState((state) => ({ config: { ...state.config, comfyServers: [] } }));
    finish(jsonResponse(objectInfo));
    await rejected;
  });

  it('keeps execution and saved workflow on the selected server when the default changes', async () => {
    const validated = await validateComfyUIWorkflow({ ...validationArgs, workflow: workflow() });
    expect(validated).toMatchObject({ serverId: 'video-server', serverName: '视频服务器' });
    expect(JSON.stringify(validated)).not.toContain(remoteUrl);
    useAppStore.setState((state) => ({ config: { ...state.config, comfyUIUrl: 'http://new-default.test' } }));
    const result = await executeValidatedComfyUIWorkflow({ ...executionArgs, validationId: validated.validationId });
    expect(comfyFetchMock).toHaveBeenCalledWith(`${remoteUrl}/prompt`, expect.objectContaining({ method: 'POST' }));
    expect(pollComfyHistoryMock).toHaveBeenCalledWith(remoteUrl, 'remote-task', expect.any(String), expect.any(Function), undefined);
    expect(result.artifact.url).toContain(`${remoteUrl}/view?`);
    expect(result.saveOffer).toMatchObject({ serverId: 'video-server', serverName: '视频服务器' });
    const saved = await saveCompletedComfyUIWorkflow({ ...executionArgs, saveOfferId: result.saveOffer.saveOfferId, name: '远程工作流' });
    expect(useAppStore.getState().workflows.find((item) => item.id === saved.id)?.serverId).toBe('video-server');
    expect(comfyBaseUrlFor(saved.id)).toBe(remoteUrl);
  });

  it.each(['delete', 'replace', 'default'])('invalidates validation after %s without sending a prompt', async (change) => {
    const validated = await validateComfyUIWorkflow({ ...validationArgs, serverId: change === 'default' ? undefined : validationArgs.serverId, workflow: workflow() });
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      comfyUIUrl: 'http://new-default.test',
      comfyServers: change === 'delete' ? [] : [{ id: 'video-server', name: '新服务', url: 'http://replacement.test' }],
    } }));
    expect(getValidatedComfyWorkflowSummary(validated.validationId, 'task-1', 'project-1')).toBeNull();
    await expect(executeValidatedComfyUIWorkflow({ ...executionArgs, validationId: validated.validationId })).rejects.toThrow('重新选择服务器');
    expect(comfyFetchMock.mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
  });

  it('does not save a workflow onto a replacement server after generation', async () => {
    const validated = await validateComfyUIWorkflow({ ...validationArgs, workflow: workflow() });
    const result = await executeValidatedComfyUIWorkflow({ ...executionArgs, validationId: validated.validationId });
    useAppStore.setState((state) => ({ config: { ...state.config, comfyServers: [] } }));
    expect(getComfyWorkflowSaveOfferSummary(result.saveOffer.saveOfferId, 'conversation-1', 'project-1')).toBeNull();
    await expect(saveCompletedComfyUIWorkflow({ ...executionArgs, saveOfferId: result.saveOffer.saveOfferId, name: '远程工作流' })).rejects.toThrow('重新选择服务器');
    expect(useAppStore.getState().workflows).toHaveLength(0);
  });

  it('cancels a submitted task on its original server even after configuration changes', async () => {
    const validated = await validateComfyUIWorkflow({ ...validationArgs, workflow: workflow() });
    const controller = new AbortController();
    pollComfyHistoryMock.mockImplementation(async () => {
      useAppStore.setState((state) => ({ config: { ...state.config, comfyServers: [] } }));
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(executeValidatedComfyUIWorkflow({ ...executionArgs, validationId: validated.validationId, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(comfyFetchMock).toHaveBeenCalledWith(`${remoteUrl}/api/jobs/remote-task/cancel`, { method: 'POST' });
  });
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
