import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';
import type { AgentToolContext } from '../../../src/services/chat/toolRegistry';

const discoverMock = vi.hoisted(() => vi.fn());
const validateMock = vi.hoisted(() => vi.fn());
const executeMock = vi.hoisted(() => vi.fn());
const summaryMock = vi.hoisted(() => vi.fn());
const saveOfferSummaryMock = vi.hoisted(() => vi.fn());
const saveWorkflowMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/comfyAgentService', () => ({
  discoverComfyUI: discoverMock,
  validateComfyUIWorkflow: validateMock,
  executeValidatedComfyUIWorkflow: executeMock,
  getValidatedComfyWorkflowSummary: summaryMock,
  getComfyWorkflowSaveOfferSummary: saveOfferSummaryMock,
  saveCompletedComfyUIWorkflow: saveWorkflowMock,
}));

import { useAppStore } from '../../../src/store/useAppStore';
import { registerComfyAgentTools } from '../../../src/services/chat/tools/comfyTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  getAvailableAgentTools,
} from '../../../src/services/chat/toolRegistry';

const context: AgentToolContext = {
  taskId: 'task-comfy',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  mode: 'collaborative',
  signal: new AbortController().signal,
};

function task(): AgentTask {
  return {
    id: context.taskId,
    projectId: context.projectId,
    conversationId: context.conversationId,
    userMessageId: 'user-1',
    mode: context.mode,
    goal: '使用 ComfyUI 生成图片',
    status: 'running',
    steps: [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: { maxModelRounds: 12, maxToolCalls: 24, maxParallelReadTools: 3, maxReadRetries: 3 },
    createdAt: 1,
    updatedAt: 1,
  };
}

const summary = {
  validationId: 'validation-1',
  serverId: 'video-server',
  serverName: '视频服务器',
  kind: 'image' as const,
  nodeCount: 3,
  outputNodeCount: 1,
  nodeClasses: ['CheckpointLoaderSimple', 'CustomSampler', 'SaveImage'],
  customNodeClasses: ['CustomSampler'],
  modelNames: ['base.safetensors'],
  expiresAt: Date.now() + 60_000,
};

beforeEach(() => {
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState((state) => ({
    config: { ...state.config, comfyUIUrl: 'http://127.0.0.1:8188' },
    currentProjectId: context.projectId,
    agentTasks: [task()],
    messages: [{
      id: 'assistant-1',
      conversationId: context.conversationId,
      projectId: context.projectId,
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'done',
      agentTaskId: context.taskId,
      createdAt: 1,
      updatedAt: 1,
    }],
  }));
  discoverMock.mockReset().mockResolvedValue({ folders: [] });
  validateMock.mockReset().mockResolvedValue(summary);
  executeMock.mockReset().mockResolvedValue({
    artifact: {
      id: 'artifact-1',
      kind: 'image',
      deliveryMode: 'chat',
      url: 'http://127.0.0.1:8188/view?filename=result.png',
      sourceUrl: 'http://127.0.0.1:8188/view?filename=result.png',
      persistence: 'skipped',
      prompt: '猫',
      modelId: 'base.safetensors',
      provider: 'comfyui',
      createdAt: 2,
    },
    saveOffer: {
      saveOfferId: 'save-offer-1',
      serverId: 'video-server',
      serverName: '视频服务器',
      suggestedName: 'base-图像工作流',
      kind: 'image',
      modelNames: ['base.safetensors'],
      expiresAt: Date.now() + 60_000,
    },
  });
  summaryMock.mockReset().mockReturnValue(summary);
  saveOfferSummaryMock.mockReset().mockReturnValue({
    saveOfferId: 'save-offer-1',
    suggestedName: 'base-图像工作流',
    kind: 'image',
    modelNames: ['base.safetensors'],
    expiresAt: Date.now() + 60_000,
  });
  saveWorkflowMock.mockReset().mockResolvedValue({
    id: 'wf-1',
    name: '我的工作流',
    category: 'ai-image',
  });
  registerComfyAgentTools();
});

describe('ComfyUI assistant tools', () => {
  it('registers discovery and validation as read tools, execution as confirmed media generation', () => {
    expect(getAgentTool('comfyui_discover')?.effect).toBe('read');
    expect(getAgentTool('comfyui_validate_workflow')?.effect).toBe('read');
    expect(getAgentTool('comfyui_execute_workflow')?.effect).toBe('media_generation');
    expect(getAgentTool('comfyui_save_workflow')?.effect).toBe('file_write');
  });

  it('only exposes the tools when a ComfyUI service URL is configured', () => {
    expect(getAvailableAgentTools(context).map((tool) => tool.id)).toContain('comfyui_discover');
    useAppStore.setState((state) => ({ config: { ...state.config, comfyUIUrl: '' } }));
    expect(getAvailableAgentTools(context).map((tool) => tool.id)).not.toContain('comfyui_discover');
  });

  it('exposes discovery, validation and execution when only an additional server is configured', () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config, comfyUIUrl: '',
      comfyServers: [{ id: 'video-server', name: '视频服务器', url: 'http://video.test' }],
    } }));
    expect(getAvailableAgentTools(context).map((tool) => tool.id)).toEqual(expect.arrayContaining([
      'comfyui_discover', 'comfyui_validate_workflow', 'comfyui_execute_workflow',
    ]));
  });

  it('passes server discovery and explicit selection through the existing read tool', async () => {
    const tool = getAgentTool('comfyui_discover')!;
    const servers = await tool.execute(context, { resource: 'servers' });
    expect(servers.summary).toBe('已读取 ComfyUI 服务器清单');
    expect(discoverMock).toHaveBeenLastCalledWith({ resource: 'servers' });
    await tool.execute(context, { resource: 'nodes', serverId: 'video-server' });
    expect(discoverMock).toHaveBeenLastCalledWith({ resource: 'nodes', serverId: 'video-server' });
    expect(tool.inputSchema).toMatchObject({ properties: { resource: { enum: ['servers', 'models', 'nodes'] }, serverId: { type: 'string' } } });
  });

  it('returns a task-bound validation id to the assistant', async () => {
    const result = await getAgentTool('comfyui_validate_workflow')!.execute(context, {
      kind: 'image',
      serverId: 'video-server',
      workflow: { '1': { class_type: 'SaveImage', inputs: {} } },
    });

    expect(result.status).toBe('success');
    expect(result.modelContent).toContain('validation-1');
    expect(validateMock).toHaveBeenCalledWith(expect.objectContaining({
      taskId: context.taskId,
      projectId: context.projectId,
      serverId: 'video-server',
    }));
  });

  it('rejects execution when the validation is absent or belongs to another task', () => {
    summaryMock.mockReturnValue(null);
    const decision = getAgentTool('comfyui_execute_workflow')!.authorize?.(context, {
      validationId: 'invalid',
      prompt: '猫',
      deliveryMode: 'chat',
    });
    expect(decision).toEqual(expect.objectContaining({ allowed: false }));
  });

  it('executes validated workflows and writes the media result into the assistant message', async () => {
    const result = await getAgentTool('comfyui_execute_workflow')!.execute(context, {
      validationId: 'validation-1',
      prompt: '猫',
      deliveryMode: 'chat',
    });

    expect(result.status).toBe('success');
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      validationId: 'validation-1',
      taskId: context.taskId,
      projectId: context.projectId,
      conversationId: context.conversationId,
    }));
    expect(useAppStore.getState().messages.find((item) => item.id === 'assistant-1')).toMatchObject({
      mediaStatus: 'succeeded',
      mediaResult: { id: 'artifact-1' },
    });
  });

  it('instructs the assistant to ask before saving after a successful execution', async () => {
    const result = await getAgentTool('comfyui_execute_workflow')!.execute(context, {
      validationId: 'validation-1',
      prompt: '猫',
      deliveryMode: 'chat',
    });

    expect(result.modelContent).toContain('是否以');
    expect(result.modelContent).toContain('不要自动保存');
    expect(result.modelContent).toContain('comfyui_save_workflow');
    expect(result.modelContent).toContain('save-offer-1');
    expect(JSON.parse(result.modelContent!).workflowSaveOffer).toMatchObject({ serverId: 'video-server', serverName: '视频服务器' });
  });

  it('saves the workflow only through a valid conversation-bound offer', async () => {
    const tool = getAgentTool('comfyui_save_workflow')!;
    expect(tool.authorize?.(context, {
      saveOfferId: 'save-offer-1',
      name: '我的工作流',
    })).toEqual({ allowed: true });

    const result = await tool.execute(context, {
      saveOfferId: 'save-offer-1',
      name: '我的工作流',
    });

    expect(result.status).toBe('success');
    expect(saveWorkflowMock).toHaveBeenCalledWith({
      saveOfferId: 'save-offer-1',
      conversationId: context.conversationId,
      projectId: context.projectId,
      name: '我的工作流',
    });
  });

  it('shows installed models and custom-node risk in the approval summary', () => {
    const text = getAgentTool('comfyui_execute_workflow')!.summarizeInput?.({
      validationId: 'validation-1',
      prompt: '猫',
      deliveryMode: 'chat',
    });
    expect(text).toContain('base.safetensors');
    expect(text).toContain('视频服务器');
    expect(text).toContain('CustomSampler');
    expect(text).toContain('文件、网络或外部程序');
  });
});
