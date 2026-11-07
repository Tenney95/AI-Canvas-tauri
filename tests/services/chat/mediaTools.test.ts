/**
 * mediaTools — 回归测试：media task recovery tools。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerMediaAgentTools } from '../../../src/services/chat/tools/mediaTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import { getPendingTasksForProject, registerMediaNodeOperation, savePendingTask } from '../../../src/services/pollManager';
import * as generationRuntime from '../../../src/services/ai/generationRuntime';
import * as operationProgress from '../../../src/services/mcp/mcpOperationService';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import type { MediaGenerationResult } from '../../../src/types/media';
import { imageBatchArtifactId } from '../../../src/services/imageBatchService';
import * as chatHistory from '../../../src/services/chat/chatHistoryService';

const context: Omit<AgentToolContext, 'signal'> = {
  taskId: 'task-media',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  mode: 'collaborative',
};

beforeEach(() => {
  localStorage.removeItem('ai_canvas_pending_tasks');
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    projectLoadStatus: 'ready',
    nodes: [{
      id: 'n1',
      type: 'source-image',
      position: { x: 0, y: 0 },
      data: { type: 'source-image', label: '首帧', imageUrl: 'asset://first-frame.png' },
    }],
    projects: [{
      id: 'project-1',
      name: '测试项目',
      createdAt: 1,
      updatedAt: 1,
      settings: {
        generation: {
          videoAspectRatio: '16:9',
          videoResolution: '1080p',
          videoDuration: 10,
        },
      },
    }],
  });
  registerMediaAgentTools();
});

describe('read-only pending task source', () => {
  it('does not migrate legacy storage during a query and refuses corrupted source without claiming no paid tasks', async () => {
    const query = getAgentTool('media_pending_tasks')!;
    const raw = JSON.stringify([{ projectId: 'project-1', nodeId: 'old-node', taskId: 'old-task', nodeType: 'ai-image',
      taskType: 'apimart', provider: 'apimart', submitted: true, apiKey: 'private-key' }]);
    localStorage.setItem('ai_canvas_pending_tasks', raw);
    const write = vi.spyOn(localStorage, 'setItem');
    try {
      const read = await query.execute({ ...context, signal: new AbortController().signal }, {});
      expect(read.status).toBe('success');
      expect(read.modelContent).not.toContain('private-key');
      expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(raw);
      expect(write).not.toHaveBeenCalled();
      localStorage.setItem('ai_canvas_pending_tasks', '{broken');
      write.mockClear();
      const broken = await query.execute({ ...context, signal: new AbortController().signal }, {});
      expect(broken).toMatchObject({ status: 'error', errorCode: 'MEDIA_PENDING_SOURCE_INVALID' });
      expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe('{broken');
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
});

describe('keyed media operation progress', () => {
  function keyedMedia(deliveryMode: 'chat' | 'both' = 'both') {
    const conversationId = 'mcp-control-project-1';
    const task: AgentTask = { id: context.taskId, projectId: context.projectId, conversationId,
      userMessageId: 'receipt-user', mode: 'autonomous', goal: '生成媒体', status: 'running', steps: [],
      modelRounds: 0, toolCallCount: 1, budget: { ...DEFAULT_AGENT_TASK_BUDGET }, createdAt: 1, updatedAt: 1,
      mcpOperation: { version: 1, bindingId: 'receipt-binding', projectId: context.projectId,
        keyDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), toolId: 'media_generate', effect: 'media_generation',
        phase: 'running', sequence: 1, createdAt: 1, updatedAt: 1 } };
    useAppStore.setState({ agentTasks: [task], messages: [{ id: 'receipt-message', conversationId, role: 'assistant',
      content: '', timestamp: 1, status: 'executing', agentTaskId: context.taskId }] });
    const controller = new AbortController();
    const toolContext: AgentToolContext = { ...context, conversationId, mode: 'autonomous', signal: controller.signal };
    const input = { kind: 'image', prompt: 'private-prompt-body', modelRef: 'general/receipt-image', deliveryMode };
    const artifact: MediaGenerationResult = { id: 'receipt-artifact', kind: 'image', deliveryMode,
      url: 'asset://receipt-image.png', sourceUrl: 'https://private.example/original-result', persistence: 'saved',
      prompt: input.prompt, modelId: input.modelRef, provider: 'general', createdAt: 1 };
    return { definition: getAgentTool('media_generate')!, toolContext, controller, input, artifact };
  }

  it('MCP完整交付四条单图消息，操作摘要仅包含产物身份', async () => {
    const { definition, toolContext, input, artifact } = keyedMedia('chat');
    const receipt = { projectId: 'project-1', nodeId: 'mj-tracking', taskId: 'mj-task', attemptId: 'mj-attempt' };
    const artifacts: MediaGenerationResult[] = Array.from({ length: 4 }, (_, index) => ({ ...artifact,
      id: imageBatchArtifactId(receipt, index), taskReceipt: receipt,
      url: `asset://mj-${index}.png`, sourceUrl: `https://private.example/mj-${index}`, filePath: `mj-${index}.png`,
    }));
    savePendingTask({ ...receipt, nodeType: 'ai-image', provider: 'general', taskType: 'custom-protocol', submitted: true,
      batchCount: 4, expectedImageOutputs: 4, resultUrls: artifacts.map((item) => item.sourceUrl),
      mediaContext: { projectId: 'project-1', conversationId: toolContext.conversationId,
        messageId: 'receipt-message', deliveryMode: 'message' } });
    vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockResolvedValue(undefined);
    const writes = artifacts.map(() => {
      let finish!: () => void;
      const promise = new Promise<void>((resolve) => { finish = resolve; });
      return { promise, finish };
    });
    const durableMessageIds = new Set<string>();
    const history = vi.spyOn(chatHistory, 'persistMessage').mockImplementation(async (message) => {
      const index = artifacts.findIndex((item) => item.id === message.mediaResult?.id);
      if (index < 0) return;
      await writes[index].promise;
      durableMessageIds.add(message.id);
    });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue({ ...artifacts[0],
      expectedOutputCount: 4, additionalResults: artifacts.slice(1) });
    let settled = false;
    const running = definition.execute(toolContext, input).then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(useAppStore.getState().messages.filter((message) => message.mediaResult)).toHaveLength(4));
      expect(durableMessageIds.size).toBe(0);
      expect(settled).toBe(false);
      expect(getPendingTasksForProject('project-1')).toHaveLength(1);
      for (const [index, write] of writes.slice(0, 3).entries()) {
        write.finish();
        await vi.waitFor(() => expect(durableMessageIds.size).toBe(index + 1));
        expect(settled).toBe(false);
        expect(getPendingTasksForProject('project-1')).toHaveLength(1);
      }
    } finally { writes.forEach((write) => write.finish()); }
    const result = await running;
    expect(result).toMatchObject({ status: 'success' });
    expect(JSON.parse(result.modelContent)).toMatchObject({ outputCount: 4, artifactIds: artifacts.map((item) => item.id), deliveryPending: false });
    const messages = useAppStore.getState().messages.filter((message) => message.mediaResult);
    expect(messages).toHaveLength(4);
    expect(messages.every((message) => !('additionalResults' in message.mediaResult!))).toBe(true);
    expect(new Set(messages.map((message) => message.id)).size).toBe(4);
    expect(durableMessageIds).toEqual(new Set(messages.map((message) => message.id)));
    for (const message of messages) expect(history).toHaveBeenCalledWith(expect.objectContaining({ id: message.id,
      mediaResult: artifacts.find((item) => item.id === message.mediaResult?.id) }), toolContext.projectId, toolContext.conversationId);
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(generate).toHaveBeenCalledOnce();
    expect(result.modelContent).not.toContain('https://');
    expect(result.modelContent).not.toContain(input.prompt);
  });

  it('候选返回后取消也保留四条独立保存状态，不伪称完整交付', async () => {
    const { definition, toolContext, controller, input, artifact } = keyedMedia('chat');
    const artifacts: MediaGenerationResult[] = Array.from({ length: 4 }, (_, index) => ({ ...artifact,
      id: `cancelled-candidate-${index}`, filePath: index === 2 ? undefined : `candidate-${index}.png`,
      url: index === 2 ? 'data:image/png;base64,AAAC' : `asset://candidate-${index}.png`,
      sourceUrl: `data:image/png;base64,AAA${index}`, persistence: index === 2 ? 'failed' : 'saved',
    }));
    vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockResolvedValue(undefined);
    vi.spyOn(chatHistory, 'persistMessage').mockResolvedValue(undefined);
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockImplementation(async () => {
      controller.abort();
      return { ...artifacts[0], expectedOutputCount: 4, additionalResults: artifacts.slice(1) };
    });
    const result = await definition.execute(toolContext, input);
    expect(result).toMatchObject({ status: 'success', errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE' });
    const messages = useAppStore.getState().messages.filter((message) => message.mediaResult);
    expect(messages.map((message) => message.mediaResult?.persistence)).toEqual(['saved', 'saved', 'failed', 'saved']);
    expect(messages.every((message) => !('additionalResults' in message.mediaResult!))).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(result.modelContent).not.toContain('data:image');
  });

  it('durably binds node/message and local started before invoking generation, without persisting URLs or prompts', async () => {
    const { definition, toolContext, input, artifact } = keyedMedia();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const progress = vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockImplementation(async (_taskId, change) => {
      if (change.mediaStage === 'started') await gate;
    });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockImplementation(async (_intent, _projectId, _signal, nodeId) => {
      if (nodeId) useAppStore.getState().updateNodeDataTransient(nodeId, { status: 'loading', mediaTaskStage: 'querying' });
      return artifact;
    });
    const pending = definition.execute(toolContext, input);
    try {
      await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(context.taskId,
        expect.objectContaining({ mediaStage: 'started', messageId: 'receipt-message', canvasNodeId: expect.any(String) })));
      expect(generate).not.toHaveBeenCalled();
    } finally { release(); }
    expect(await pending).toMatchObject({ status: 'success' });
    expect(progress.mock.calls.map(([, update]) => update.mediaStage)).toEqual(['preparing', 'started', 'generated', 'delivered']);
    const storedFields = JSON.stringify(progress.mock.calls);
    expect(storedFields).not.toContain(input.prompt);
    expect(storedFields).not.toContain(artifact.sourceUrl);
    expect(progress).toHaveBeenLastCalledWith(context.taskId, expect.objectContaining({ artifactId: artifact.id, persistence: 'saved' }));
  });

  it('cleans a placeholder and blocks generation when persisting started fails', async () => {
    const { definition, toolContext, input } = keyedMedia();
    const progress = vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockImplementation(async (_taskId, change) => {
      if (change.mediaStage === 'started') throw new Error('receipt unavailable');
    });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration');
    expect(await definition.execute(toolContext, input)).toMatchObject({ status: 'error', errorCode: 'AGENT_MEDIA_NOT_STARTED' });
    expect(generate).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes.at(-1)?.data.status).toBe('error');
    expect(progress).toHaveBeenLastCalledWith(context.taskId, expect.objectContaining({ phase: 'failed', errorCode: 'AGENT_MEDIA_NOT_STARTED' }));
  });

  it.each(['cancel', 'project', 'revision', 'prompt', 'settings'] as const)('rechecks %s after the started persistence wait before calling generation', async (change) => {
    const { definition, toolContext, controller, input } = keyedMedia();
    vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockImplementation(async (_taskId, update) => {
      if (update.mediaStage !== 'started') return;
      if (change === 'cancel') controller.abort();
      else if (change === 'project') useAppStore.setState({ currentProjectId: 'different-project' });
      else if (change === 'revision') useAppStore.getState().incrementRevision();
      else if (change === 'prompt') useAppStore.getState().updateNodeDataTransient(useAppStore.getState().nodes.at(-1)!.id, { prompt: 'new-user-draft' });
      else useAppStore.setState((state) => ({ projects: state.projects.map((project) => ({ ...project,
        settings: { ...project.settings, generation: { ...project.settings?.generation, imageAspectRatio: '4:3' } } })) }));
    });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration');
    expect(await definition.execute(toolContext, input)).toMatchObject({ status: 'error', errorCode: 'AGENT_MEDIA_NOT_STARTED' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps the generated result when writing generated and delivered progress fails', async () => {
    const { definition, toolContext, input, artifact } = keyedMedia();
    vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockImplementation(async (_taskId, update) => {
      if (update.mediaStage === 'generated' || update.mediaStage === 'delivered') throw new Error('receipt unavailable');
    });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue(artifact);
    const result = await definition.execute(toolContext, input);
    expect(result).toMatchObject({ status: 'success', errorCode: 'MCP_OPERATION_RECEIPT_UNCONFIRMED' });
    expect(JSON.parse(result.modelContent)).toMatchObject({ artifactId: artifact.id, receiptUnconfirmed: true });
    expect(useAppStore.getState().messages.find((message) => message.id === 'receipt-message')?.mediaResult).toEqual(artifact);
    expect(useAppStore.getState().nodes.at(-1)?.data.artifactId).toBe(artifact.id);
    expect(generate).toHaveBeenCalledOnce();
  });

  it('keeps a user prompt changed during generation while retaining the generated artifact for verification', async () => {
    const { definition, toolContext, input, artifact } = keyedMedia();
    const progress = vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockResolvedValue(undefined);
    vi.spyOn(generationRuntime, 'runMediaGeneration').mockImplementation(async (_intent, _projectId, _signal, nodeId) => {
      useAppStore.getState().updateNodeDataTransient(nodeId!, { prompt: 'new-user-draft' });
      return artifact;
    });
    expect(await definition.execute(toolContext, input)).toMatchObject({ status: 'success', errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE' });
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBe('new-user-draft');
    expect(useAppStore.getState().messages.find((message) => message.id === 'receipt-message')?.mediaResult?.id).toBe(artifact.id);
    expect(progress).toHaveBeenLastCalledWith(context.taskId, expect.objectContaining({ phase: 'partial', artifactId: artifact.id }));
  });

  it('rejects project defaults changed during the preparing journal before creating a placeholder', async () => {
    const { definition, toolContext, input } = keyedMedia();
    vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockImplementation(async (_taskId, update) => {
      if (update.mediaStage === 'preparing') useAppStore.setState((state) => ({ projects: state.projects.map((project) => ({ ...project,
        settings: { ...project.settings, defaultModels: { image: 'general/different-model' } } })) }));
    });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration');
    expect(await definition.execute(toolContext, input)).toMatchObject({ status: 'error', errorCode: 'AGENT_MEDIA_NOT_STARTED' });
    expect(useAppStore.getState().nodes).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps original recovery identity and a partial artifact when the canvas changes during generated persistence', async () => {
    const { definition, toolContext, input, artifact } = keyedMedia();
    const progress = vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockImplementation(async (_taskId, update) => {
      if (update.mediaStage === 'generated' && !update.phase) {
        useAppStore.getState().updateNodeDataTransient(useAppStore.getState().nodes.at(-1)!.id, { prompt: 'new-user-draft' });
      }
    });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockImplementation(async (_intent, _projectId, _signal, nodeId) => {
      const taskReceipt = savePendingTask({ projectId: context.projectId, nodeId: nodeId!, nodeType: 'ai-image',
        provider: 'general', taskType: 'custom-protocol', taskId: 'original-paid-task', submitted: true,
        mediaContext: { projectId: context.projectId, conversationId: toolContext.conversationId, messageId: 'receipt-message', deliveryMode: 'node+message' } });
      return { ...artifact, taskReceipt };
    });
    const result = await definition.execute(toolContext, input);
    expect(result).toMatchObject({ status: 'success', errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE' });
    expect(progress).toHaveBeenLastCalledWith(context.taskId, expect.objectContaining({ phase: 'partial', mediaStage: 'generated', artifactId: artifact.id }));
    expect(getPendingTasksForProject(context.projectId)).toContainEqual(expect.objectContaining({ taskId: 'original-paid-task' }));
    expect(useAppStore.getState().messages.find((message) => message.id === 'receipt-message')?.mediaResult?.taskReceipt?.taskId).toBe('original-paid-task');
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBe('new-user-draft');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('marks generated but unsaved media as partial instead of reporting a fully delivered receipt', async () => {
    const { definition, toolContext, input, artifact } = keyedMedia();
    const progress = vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockResolvedValue(undefined);
    vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue({ ...artifact, persistence: 'failed' });
    expect(await definition.execute(toolContext, input)).toMatchObject({ status: 'success' });
    expect(progress).toHaveBeenLastCalledWith(context.taskId, expect.objectContaining({ phase: 'partial', mediaStage: 'generated', persistence: 'failed' }));
  });

  it('adds no metadata wait before ordinary no-key generation', async () => {
    const { definition, toolContext, input, artifact } = keyedMedia('chat');
    useAppStore.setState({ agentTasks: [] });
    const progress = vi.spyOn(operationProgress, 'recordMcpOperationProgress');
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue(artifact);
    const pending = definition.execute(toolContext, input);
    expect(generate).toHaveBeenCalledOnce();
    expect(await pending).toMatchObject({ status: 'success' });
    expect(progress).not.toHaveBeenCalled();
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('media task recovery tools', () => {
  it('does not advertise or run recovery while the original result is being saved', async () => {
    const receipt = savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      taskType: 'custom-protocol', taskId: 'saving-task', submitted: true, mediaRecoveryState: 'delivery_pending' });
    const release = registerMediaNodeOperation(receipt.nodeId);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      const toolContext = { ...context, signal: new AbortController().signal };
      const listed = await getAgentTool('media_pending_tasks')!.execute(toolContext, {});
      expect(JSON.parse(listed.modelContent)).toEqual([expect.objectContaining({ taskId: receipt.taskId, canResume: false })]);
      const definition = getAgentTool('media_resume_task')!;
      const input = { nodeId: receipt.nodeId, taskId: receipt.taskId };
      expect(definition.authorize?.(context, input).allowed).toBe(false);
      expect(await definition.execute(toolContext, input)).toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STALE' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject(receipt);
      release();
      const available = await getAgentTool('media_pending_tasks')!.execute(toolContext, {});
      expect(JSON.parse(available.modelContent)[0].canResume).toBe(true);
    } finally { release(); }
  });

  it('stops an in-flight recovery with the tool signal and retains the original task', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      recovery: { name: 'Recovery', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    const receipt = savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'recovery', taskType: 'custom-protocol', taskId: 'original-task', submitted: true,
      mediaRecoveryState: 'query_paused', protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/original-task',
        intervalMs: 1, statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = getAgentTool('media_resume_task')!.execute({ ...context, signal: controller.signal },
      { nodeId: receipt.nodeId, taskId: receipt.taskId });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STOPPED' });
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject(receipt);
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBe('asset://first-frame.png');
    finish(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/late.png' })));
  });

  it('lists original task identities without exposing their polling URLs', async () => {
    savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'custom', taskType: 'custom-protocol', taskId: 'original-task', submitted: true,
      mediaRecoveryState: 'query_paused', mediaContext: { projectId: 'project-1', messageId: 'message-1', conversationId: 'conversation-1', deliveryMode: 'message' } });
    const definition = getAgentTool('media_pending_tasks')!;
    const result = await definition.execute({ ...context, signal: new AbortController().signal }, {});
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent)).toEqual([expect.objectContaining({ taskId: 'original-task', nodeId: 'n1', canResume: true })]);
    expect(result.modelContent).not.toContain('protocolPoll');
    expect(result.modelContent).not.toContain('apiKey');
    expect(result.modelContent).not.toContain('https://');
  });

  it('refuses to resume an unknown submission or a task from another project at authorization and execution', async () => {
    savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      taskType: 'custom-protocol', taskId: 'uncertain-task', submitted: true, mediaRecoveryState: 'submit_unknown' });
    const definition = getAgentTool('media_resume_task')!;
    const input = { nodeId: 'n1', taskId: 'uncertain-task' };
    expect(definition.authorize?.(context, input).allowed).toBe(false);
    expect(await definition.execute({ ...context, signal: new AbortController().signal }, input))
      .toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STALE' });

    savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      taskType: 'custom-protocol', taskId: 'original-task', submitted: true, mediaRecoveryState: 'query_paused' });
    const knownInput = { nodeId: 'n1', taskId: 'original-task' };
    expect(definition.authorize?.(context, knownInput).allowed).toBe(true);
    const otherContext = { ...context, projectId: 'other-project' };
    expect(definition.authorize?.(otherContext, knownInput).allowed).toBe(false);
    expect(await definition.execute({ ...otherContext, signal: new AbortController().signal }, knownInput))
      .toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STALE' });
    expect(definition.effect).toBe('canvas_write');
  });

  it('does not advertise or execute task types owned by dedicated recovery lifecycles', async () => {
    const dedicatedTypes = ['runninghub', 'runninghub-workflow', 'runninghub-model', 'workflow-api'] as const;
    dedicatedTypes.forEach((taskType) => savePendingTask({
      projectId: 'project-1', nodeId: `node-${taskType}`, nodeType: 'ai-video', provider: taskType,
      taskType, taskId: `task-${taskType}`, submitted: true,
    }));
    savePendingTask({ projectId: 'project-1', nodeId: 'node-cancelling', nodeType: 'ai-video', provider: 'comfyui',
      taskType: 'comfyui', taskId: 'cancel-task', submitted: true, comfyRecoveryState: 'cancel_pending' });

    const toolContext = { ...context, signal: new AbortController().signal };
    const result = await getAgentTool('media_pending_tasks')!.execute(toolContext, {});
    const listed = JSON.parse(result.modelContent) as Array<{ nodeId: string; taskId: string; canResume: boolean }>;
    expect(listed).toHaveLength(dedicatedTypes.length + 1);
    const definition = getAgentTool('media_resume_task')!;
    for (const task of listed) {
      expect(task.canResume).toBe(false);
      const input = { nodeId: task.nodeId, taskId: task.taskId };
      expect(definition.authorize?.(context, input).allowed).toBe(false);
      expect(await definition.execute(toolContext, input))
        .toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STALE' });
    }
  });
});

describe('media_generate display parameters', () => {
  it('同型号的万象分组以独立模型引用选择各自连接', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      'relay-a': { name: 'A 组', catalogId: 'relayonapi', relayonGroup: 'image', apiKey: 'group-a-key', baseUrl: '' },
      'relay-b': { name: 'B 组', catalogId: 'relayonapi', relayonGroup: 'default', apiKey: 'group-b-key', baseUrl: 'https://relayonapi.com/v1' },
    }, generalModels: [
      { id: 'relay-a-image', name: 'Image', modelId: 'image-2.5-flare', category: 'image', providerConfigId: 'relay-a' },
      { id: 'relay-b-image', name: 'Image', modelId: 'image-2.5-flare', category: 'image', providerConfigId: 'relay-b' },
    ] } }));
    const tool = getAgentTool('media_generate')!;
    const common = { kind: 'image', prompt: '山谷', deliveryMode: 'chat' };
    expect(tool.authorize?.(context, { ...common, modelRef: 'general/relay-a-image' }).allowed).toBe(false);
    expect(tool.authorize?.(context, { ...common, modelRef: 'general/relay-b-image' }).allowed).toBe(true);
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'relay-a': { ...state.config.providers['relay-a'], baseUrl: 'https://relayonapi.com/v1' },
    } } }));
    useAppStore.setState({ messages: [{ id: 'relay-message', conversationId: context.conversationId,
      role: 'assistant', content: '', timestamp: 1, status: 'executing', agentTaskId: context.taskId }] });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue({
      id: 'relay-artifact', kind: 'image', deliveryMode: 'chat', url: 'https://cdn.example/result',
      sourceUrl: 'https://cdn.example/result', persistence: 'skipped', prompt: '山谷', modelId: 'image-2.5-flare',
      provider: 'general', createdAt: 1,
    });
    for (const id of ['relay-a-image', 'relay-b-image']) {
      const input = { ...common, modelRef: `general/${id}` };
      expect(tool.authorize?.(context, input).allowed).toBe(true);
      await tool.execute({ ...context, signal: new AbortController().signal }, input);
      expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({ modelRef: `general/${id}` }),
        context.projectId, expect.any(AbortSignal), undefined, expect.objectContaining({ messageId: 'relay-message' }));
    }
  });

  function configureVisualModels() {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, custom: { name: '自定义', catalogId: 'custom-openai',
        apiKey: 'fixture-private-key', baseUrl: 'https://private.example/v1' } },
      generalModels: [
        { id: 'image-custom', name: '图片', modelId: 'image-x', category: 'image', providerConfigId: 'custom',
          imageCapability: { resolutions: ['2K'], ratios: ['1:1'], qualities: ['low', 'high'], backgrounds: ['opaque', 'transparent'] } },
        { id: 'video-custom', name: '视频', modelId: 'video-x', category: 'video', providerConfigId: 'custom',
          videoCapability: { operations: ['text-to-video'], frameRates: [24, 30], supportsAudio: true,
            minDuration: 4, maxDuration: 15, automaticDurationValue: -1 } },
      ],
    } }));
  }

  it('普通模型能力发现只返回声明的参数，不返回连接地址、协议或 Key', async () => {
    configureVisualModels();
    const tool = getAgentTool('media_model_parameters')!;
    const toolContext = { ...context, signal: new AbortController().signal };
    const image = await tool.execute(toolContext, { modelRef: 'general/image-custom' });
    expect(JSON.parse(image.modelContent)).toMatchObject({ kind: 'image', capability: {
      qualities: ['low', 'high'], backgrounds: ['opaque', 'transparent'],
    } });
    const video = await tool.execute(toolContext, { modelRef: 'general/video-custom' });
    expect(JSON.parse(video.modelContent)).toMatchObject({ kind: 'video', capability: {
      frameRates: [24, 30], supportsAudio: true, automaticDurationValue: -1,
    } });
    for (const text of [image.modelContent, video.modelContent]) {
      expect(text).not.toContain('fixture-private-key');
      expect(text).not.toContain('private.example');
      expect(text).not.toContain('executionProfile');
    }
  });

  it.each([
    { kind: 'image', modelRef: 'general/image-custom', imageQuality: 'high', imageBackground: '' },
    { kind: 'video', modelRef: 'general/video-custom', duration: -1, videoFps: 24, generateAudio: false },
  ])('$kind 工具参数通过 schema 并在审批和生成时保留', async (parameters) => {
    configureVisualModels();
    useAppStore.setState({ messages: [{ id: 'visual-message', conversationId: context.conversationId,
      role: 'assistant', content: '', timestamp: 1, status: 'executing', agentTaskId: context.taskId }] });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue({
      id: 'visual-artifact', kind: parameters.kind as 'image' | 'video', deliveryMode: 'chat',
      url: 'https://cdn.example/result', sourceUrl: 'https://cdn.example/result', persistence: 'skipped',
      prompt: '镜头', modelId: parameters.modelRef, provider: 'general', createdAt: 1,
    });
    const input = { ...parameters, prompt: '镜头', deliveryMode: 'chat' };
    const prepared = prepareAgentToolCall({ callId: 'visual', toolId: 'media_generate', input }, context);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const tool = getAgentTool('media_generate')!;
    expect(tool.authorize?.(context, prepared.prepared.input).allowed).toBe(true);
    const display = tool.buildInputDisplay?.(prepared.prepared.input, context);
    expect(display?.fields).toEqual(expect.arrayContaining(parameters.kind === 'image'
      ? [expect.objectContaining({ label: '生成背景', value: '接口默认' })]
      : [expect.objectContaining({ label: '生成音轨', value: '关闭' })]));
    await tool.execute({ ...context, signal: new AbortController().signal }, prepared.prepared.input);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining(parameters), context.projectId, expect.any(AbortSignal),
      undefined, expect.objectContaining({ messageId: 'visual-message' }));
  });

  it('敏感参数在解析与直接执行时都被拒绝，不创建画布占位或回显原值', async () => {
    configureVisualModels();
    const secret = 'sk-example-secret';
    const input = { kind: 'image', prompt: '山谷', modelRef: 'general/image-custom', deliveryMode: 'canvas', imageQuality: secret };
    const prepared = prepareAgentToolCall({ callId: 'unsafe-visual', toolId: 'media_generate', input }, context);
    expect(prepared.ok).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(secret);
    const tool = getAgentTool('media_generate')!;
    expect(tool.authorize?.(context, input).allowed).toBe(false);
    const result = await tool.execute({ ...context, signal: new AbortController().signal }, input);
    expect(result).toMatchObject({ status: 'error', errorCode: 'MEDIA_PARAMETER_INVALID' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  it('继承的项目图片默认值包含路径时，也在创建占位前拒绝且不回显', async () => {
    configureVisualModels();
    const path = 'D:\\private\\image.png';
    useAppStore.setState((state) => ({ projects: state.projects.map((project) => ({ ...project,
      settings: { ...project.settings, generation: { ...project.settings?.generation, imageSize: path } },
    })) }));
    const input = { kind: 'image', prompt: '山谷', modelRef: 'general/image-custom', deliveryMode: 'canvas' };
    const prepared = prepareAgentToolCall({ callId: 'unsafe-default', toolId: 'media_generate', input }, context);
    expect(prepared.ok).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(path);
    const result = await getAgentTool('media_generate')!.execute({ ...context, signal: new AbortController().signal }, input);
    expect(result).toMatchObject({ status: 'error', errorCode: 'MEDIA_PARAMETER_INVALID' });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  function configureGeneralAudio() {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, 'libapi-audio': { name: 'LibAPI', catalogId: 'libapi',
        apiKey: 'fixture', baseUrl: 'https://libapi.cc/v1' } },
      generalModels: [
        { id: 'libapi-tts', name: 'LibAPI TTS', modelId: 'speech-2.8', category: 'audio', providerConfigId: 'libapi-audio' },
        { id: 'libapi-music', name: 'LibAPI Music', modelId: 'music', category: 'audio', providerConfigId: 'libapi-audio' },
      ],
    } }));
  }

  it.each(['chat', 'both'] as const)('keeps model voice and MP3 settings from the tool through %s delivery', async (deliveryMode) => {
    configureGeneralAudio();
    useAppStore.setState({ messages: [{ id: 'audio-message', conversationId: context.conversationId,
      role: 'assistant', content: '', timestamp: 1, status: 'executing', agentTaskId: context.taskId }] });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue({
      id: 'audio-artifact', kind: 'audio', deliveryMode, url: 'https://cdn.example/voice.mp3',
      sourceUrl: 'https://cdn.example/voice.mp3', persistence: 'skipped', prompt: '欢迎回来',
      modelId: 'general/libapi-tts', provider: 'general', audioPurpose: 'speech', createdAt: 1,
    });
    const input = { kind: 'audio', prompt: '欢迎回来', modelRef: 'general/libapi-tts', deliveryMode,
      audioPurpose: 'speech', audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25 };
    const definition = getAgentTool('media_generate')!;
    expect(prepareAgentToolCall({ callId: 'libapi-speech', toolId: 'media_generate', input }, context).ok).toBe(true);
    expect(definition.authorize?.(context, input).allowed).toBe(true);

    const result = await definition.execute({ ...context, signal: new AbortController().signal }, input);

    expect(result.status).toBe('success');
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ audioVoice: 'Chinese_Female_01',
      audioFormat: 'mp3', audioSpeed: 1.25 }), context.projectId, expect.any(AbortSignal),
    deliveryMode === 'both' ? expect.any(String) : undefined, expect.objectContaining({ messageId: 'audio-message', deliveryMode }));
    if (deliveryMode === 'both') {
      expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({ audioPurpose: 'speech',
        audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25, status: 'success' });
    } else expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  it('accepts literal music title and lyrics without using RunningHub modelParameters', () => {
    configureGeneralAudio();
    const input = { kind: 'audio', prompt: '轻柔民谣', modelRef: 'general/libapi-music', deliveryMode: 'chat',
      audioPurpose: 'music', musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走' };
    const prepared = prepareAgentToolCall({ callId: 'libapi-music', toolId: 'media_generate', input }, context);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.prepared.input).toMatchObject({ musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走' });
      expect(prepared.prepared.input).not.toHaveProperty('modelParameters');
    }
    expect(getAgentTool('media_generate')!.authorize?.(context, input).allowed).toBe(true);
  });

  it('rejects invalid voice IDs and audio fields on another media kind without changing policy', () => {
    configureGeneralAudio();
    const tool = getAgentTool('media_generate')!;
    const input = { kind: 'audio', prompt: '欢迎回来', modelRef: 'general/libapi-tts', deliveryMode: 'chat', audioPurpose: 'speech' };
    for (const audioVoice of ['', ' Zephyr ', 'voice\nID', 'voice\u0085ID', 'x'.repeat(257)]) {
      expect(tool.authorize?.(context, { ...input, audioVoice }).allowed).toBe(false);
    }
    expect(tool.authorize?.(context, { ...input, kind: 'image', audioVoice: 'Zephyr' }).allowed).toBe(false);
    expect(tool.effect).toBe('media_generation');
  });

  it('RunningHub 专属参数保持字符串，且不注入其他模型的视频默认值', () => {
    const id = 'minimax/h3-max-turbo/image-to-video';
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { 'runninghub-model': { name: 'RH', apiKey: 'fake', selectedModels: [{ id, name: 'H3', provider: 'runninghub', category: 'video' }] } } } }));
    const prepared = prepareAgentToolCall({ callId: 'rh-params', toolId: 'media_generate', input: { kind: 'video', prompt: '镜头推进', modelRef: `runninghub/${id}`, deliveryMode: 'chat', modelParameters: [{ name: 'duration', value: '15' }] } }, context);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.prepared.input).toMatchObject({ modelParameters: [{ name: 'duration', value: '15' }] });
      expect(prepared.prepared.input).not.toHaveProperty('resolution');
      expect(prepared.prepared.input).not.toHaveProperty('duration');
    }
    const read = prepareAgentToolCall({ callId: 'rh-read', toolId: 'media_model_parameters', input: { modelRef: `runninghub/${id}` } }, { ...context, mode: 'plan' });
    expect(read.ok).toBe(true);
  });
  it('uses the project default media model when modelRef is omitted', () => {
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        settings: { ...project.settings, defaultModels: { video: 'general/video-default' } },
      })),
    }));
    const prepared = prepareAgentToolCall({
      callId: 'call-default',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '普通镜头', deliveryMode: 'chat' },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (prepared.ok) expect(prepared.prepared.input).toMatchObject({ modelRef: 'general/video-default' });
  });

  it('autonomous routing ranks user model descriptions and overrides the default', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          custom: { name: '自定义', apiKey: 'secret', baseUrl: 'https://example.com' },
        },
        generalModels: [
          { id: 'video-default', name: '通用视频', modelId: 'video-a', category: 'video', providerConfigId: 'custom' },
          { id: 'video-anime', name: '动画专用', description: '擅长二次元动画与运镜', modelId: 'video-b', category: 'video', providerConfigId: 'custom' },
        ],
      },
      projects: state.projects.map((project) => ({
        ...project,
        settings: {
          ...project.settings,
          defaultModels: { video: 'general/video-default' },
          modelAutoRouting: true,
        },
      })),
    }));
    const prepared = prepareAgentToolCall({
      callId: 'call-auto',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '二次元 动画 运镜', deliveryMode: 'chat' },
    }, { ...context, mode: 'autonomous' });

    expect(prepared).toMatchObject({ ok: true });
    if (prepared.ok) expect(prepared.prepared.input).toMatchObject({ modelRef: 'general/video-anime' });
  });

  it('locks project video defaults before approval and exposes them in the display', () => {
    const prepared = prepareAgentToolCall({
      callId: 'call-1',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '基于 @{n1:首帧} 生成向前推进镜头',
        deliveryMode: 'canvas',
      },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    expect(prepared.prepared.input).toMatchObject({
      aspectRatio: '16:9',
      resolution: '1080p',
      duration: 10,
    });
    expect(prepared.prepared.definition.buildInputDisplay?.(
      prepared.prepared.input,
      context,
    )).toMatchObject({
      fields: expect.arrayContaining([
        { label: '画面比例', value: '16:9', source: 'resolved' },
        { label: '分辨率', value: '1080p', source: 'resolved' },
        { label: '时长', value: '10 秒', source: 'resolved' },
      ]),
      references: [{ kind: 'node', id: 'n1', label: '首帧', mediaKind: 'image' }],
    });
  });

  it('keeps explicit video parameters instead of replacing them with project defaults', () => {
    const prepared = prepareAgentToolCall({
      callId: 'call-2',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '竖屏人物镜头',
        deliveryMode: 'chat',
        aspectRatio: '9:16',
        resolution: '720p',
        duration: 6,
      },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    expect(prepared.prepared.input).toMatchObject({
      aspectRatio: '9:16',
      resolution: '720p',
      duration: 6,
    });
  });

  it('keeps omitted custom API video fields unspecified and accepts model-specific values', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          custom: { name: '自定义', apiKey: '', baseUrl: 'https://gateway.example.com' },
        },
        generalModels: [{
          id: 'video-custom',
          name: '自定义视频',
          modelId: 'video-custom-upstream',
          category: 'video',
          providerConfigId: 'custom',
          videoCapability: {
            ratios: ['7:4'],
            resolutions: ['2K'],
            maxDuration: 30,
          },
        }],
      },
      projects: state.projects.map((project) => ({
        ...project,
        settings: { ...project.settings, defaultModels: { video: 'general/video-custom' } },
      })),
    }));

    const omitted = prepareAgentToolCall({
      callId: 'call-custom-default',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '自定义镜头', deliveryMode: 'chat' },
    }, context);
    expect(omitted).toMatchObject({ ok: true });
    if (omitted.ok) {
      expect(omitted.prepared.input).toMatchObject({ modelRef: 'general/video-custom' });
      expect(omitted.prepared.input).not.toHaveProperty('aspectRatio');
      expect(omitted.prepared.input).not.toHaveProperty('resolution');
      expect(omitted.prepared.input).not.toHaveProperty('duration');
    }

    const explicit = prepareAgentToolCall({
      callId: 'call-custom-explicit',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '自定义镜头',
        deliveryMode: 'chat',
        aspectRatio: '7:4',
        resolution: '2K',
        duration: 30,
      },
    }, context);
    expect(explicit).toMatchObject({ ok: true });
    if (explicit.ok) {
      expect(explicit.prepared.input).toMatchObject({
        aspectRatio: '7:4',
        resolution: '2K',
        duration: 30,
      });
    }
  });
});
