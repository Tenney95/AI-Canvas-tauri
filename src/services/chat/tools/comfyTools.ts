/** 内部助手的 ComfyUI API 发现、动态工作流校验与执行工具。 */
import { useAppStore } from '../../../store/useAppStore';
import type { MediaDeliveryMode, MediaGenerationIntent, MediaKind, NativeMediaOrigin } from '../../../types/media';
import { listConfiguredComfyServers } from '../../comfyServers';
import {
  discoverComfyUI,
  executeValidatedComfyUIWorkflow,
  executeValidatedNativeComfyUIWorkflow,
  getComfyWorkflowSaveOfferSummary,
  getValidatedComfyWorkflowSummary,
  saveCompletedComfyUIWorkflow,
  type ComfyMcpScope,
  type ComfyWorkflowSaveOfferSummary,
  validateComfyUIWorkflow,
} from '../../comfyAgentService';
import { completeCanvasDerivation, isCanvasDerivationTargetCurrent } from '../../canvasDerivationGuard';
import { bindNativeMediaOrigin } from '../../nativeMediaOrigin';
import { registerNativeVideoSubmissionGuard } from '../../nativeVideoSubmissionGuard';
import { refreshNativeMediaNodeRecovery, trackNativeMediaNodeRun } from '../../pollManager';
import { isProjectExpectedContextCurrent } from '../../projectExecutionContext';
import { recordMcpOperationProgress } from '../../mcp/mcpOperationService';
import { generationInputSnapshot } from '../canvasNodeVersion';
import {
  failMediaPlaceholderLifecycle,
  registerMediaPlaceholderLifecycle,
  settleMediaPlaceholderLifecycle,
  type MediaPlaceholderLifecycle,
} from '../mediaPlaceholderLifecycle';
import { registerAgentTool, type AgentToolContext, type AgentToolExecutionResult } from '../toolRegistry';

interface DiscoverInput {
  resource: 'servers' | 'models' | 'nodes';
  serverId?: string;
  query?: string;
  nodeClasses?: string[];
  limit?: number;
}

interface ValidateInput {
  kind: MediaKind;
  workflow: Record<string, unknown>;
  serverId?: string;
}

interface ExecuteInput {
  validationId: string;
  prompt: string;
  deliveryMode: MediaDeliveryMode;
}

interface SaveWorkflowInput {
  saveOfferId: string;
  name: string;
}

function getAssistantMessageId(taskId: string): string | undefined {
  return useAppStore.getState().messages.find(
    (message) => message.agentTaskId === taskId && message.role === 'assistant',
  )?.id;
}

function modelContent(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 48_000) return serialized;
  return `${serialized.slice(0, 48_000)}\n[结果已截断，请缩小 query、nodeClasses 或 limit 后继续查询]`;
}

function asError(error: unknown, fallback: string): AgentToolExecutionResult {
  const message = error instanceof Error ? error.message : fallback;
  return { status: 'error', summary: message, modelContent: message };
}

function comfyMcpScope(context: Omit<AgentToolContext, 'signal'>): ComfyMcpScope | undefined {
  const canvas = context.executionContext ?? context.projectScope;
  if (context.mcpSessionId && canvas?.kind === 'canvas' && canvas.canvasId === context.projectId) {
    return { sessionId: context.mcpSessionId, canvas };
  }
}

function saveOfferContent(saveOffer: ComfyWorkflowSaveOfferSummary) {
  const { saveOfferId, suggestedName, expiresAt, serverId, serverName } = saveOffer;
  return {
    workflowSaveOffer: { saveOfferId, suggestedName, expiresAt, serverId, serverName },
    nextAction: `必须询问用户：“这个工作流已成功执行，是否以“${suggestedName}”保存到工作流管理？”不要自动保存。用户同意后再调用 comfyui_save_workflow。`,
  };
}

async function runNativeComfyTool(context: AgentToolContext, mcp: ComfyMcpScope, assistantMessageId: string,
  input: ExecuteInput, kind: MediaKind): Promise<AgentToolExecutionResult> {
  const { canvas } = mcp;
  const origin: NativeMediaOrigin = { conversationId: context.conversationId, messageId: assistantMessageId,
    agentTaskId: context.taskId, modelId: 'comfyui/dynamic-workflow', deliveryMode: input.deliveryMode };
  const tracksOperation = useAppStore.getState().agentTasks.some((task) => task.id === context.taskId && task.mcpOperation);
  let targetNodeId: string | undefined;
  const run: { placeholder?: MediaPlaceholderLifecycle } = {};
  let unbindOrigin: (() => void) | undefined;
  let finishRun: (() => void) | undefined;
  let enteredExecution = false;
  let initialInput: string | undefined;
  const isCurrent = () => isProjectExpectedContextCurrent(canvas, useAppStore.getState(), { checkCanvasRevision: false });
  const isOriginalMessage = (message: { id: string; conversationId: string; agentTaskId?: string }) => message.id === assistantMessageId
    && message.conversationId === context.conversationId && message.agentTaskId === context.taskId;
  const patchMessage = (patch: Parameters<ReturnType<typeof useAppStore.getState>['updateMessage']>[1]) => {
    const state = useAppStore.getState();
    if (isCurrent() && state.messages.some(isOriginalMessage)) state.updateMessage(assistantMessageId, patch);
  };
  const nodeInput = (state: ReturnType<typeof useAppStore.getState>) => {
    const node = state.nodes.find((item) => item.id === targetNodeId);
    return node?.data.role === 'generator' && node.data.status !== 'success'
      ? generationInputSnapshot(node.data, state.projects.find((item) => item.id === canvas.canvasId)?.settings) : undefined;
  };
  const canUpdatePlaceholder = () => {
    const state = useAppStore.getState();
    return isCurrent() && initialInput !== undefined && nodeInput(state) === initialInput
      && (!run.placeholder || isCanvasDerivationTargetCurrent(run.placeholder.guard, state));
  };
  try {
    const { operationId, saveOffer } = await executeValidatedNativeComfyUIWorkflow({
      validationId: input.validationId, taskId: context.taskId, projectId: context.projectId,
      conversationId: context.conversationId, mcp, signal: context.signal,
      prepare: async (digest) => {
        if (tracksOperation) await recordMcpOperationProgress(context.taskId, { mediaStage: 'preparing', messageId: assistantMessageId, persistence: 'pending' });
        context.signal.throwIfAborted();
        const store = useAppStore.getState();
        if (!isCurrent() || context.baseRevision !== undefined && store.getCurrentRevision() !== context.baseRevision) {
          throw new Error('画布已变化，请重新读取后运行');
        }
        const cancellation = new AbortController();
        const signal = AbortSignal.any([context.signal, cancellation.signal]);
        if (input.deliveryMode !== 'chat') {
          targetNodeId = store.createMediaPlaceholder({ kind, prompt: input.prompt, modelRef: origin.modelId, deliveryMode: input.deliveryMode });
          // 原任务续查和取消入口都依赖节点的生成角色及厂商。
          store.updateNodeDataTransient(targetNodeId, { provider: 'comfyui', role: 'generator' });
          initialInput = nodeInput(useAppStore.getState());
          const placeholder = registerMediaPlaceholderLifecycle(targetNodeId);
          if (!placeholder) throw new Error('画布占位节点无法绑定，未提交生成');
          run.placeholder = placeholder;
          finishRun = trackNativeMediaNodeRun(canvas.canvasId, targetNodeId, cancellation);
        }
        const nodeId = targetNodeId ?? `media-message-${crypto.randomUUID()}`;
        const beforeSubmit = registerNativeVideoSubmissionGuard(() => {
          signal.throwIfAborted();
          const current = useAppStore.getState();
          if (!isCurrent() || !current.messages.some((message) => isOriginalMessage(message) && !message.mediaResult)
            || !current.agentTasks.some((task) => task.id === context.taskId && task.status === 'running')
            || targetNodeId && !canUpdatePlaceholder()) {
            throw new Error('原画布、节点输入或对话已变化，未提交 ComfyUI 工作流');
          }
        });
        patchMessage({ mediaStatus: 'generating', mediaError: undefined, canvasStatus: targetNodeId ? 'pending' : 'none',
          canvasNodeId: targetNodeId, canvasError: undefined });
        const { persistNativeMediaOrigin } = await import('../../nativeMediaOriginPersistence');
        await persistNativeMediaOrigin(canvas, origin);
        if (tracksOperation) await recordMcpOperationProgress(context.taskId, { mediaStage: 'started', canvasNodeId: targetNodeId });
        beforeSubmit();
        unbindOrigin = bindNativeMediaOrigin(canvas.canvasId, nodeId, origin, targetNodeId ? undefined : {
          material: JSON.stringify([kind, digest, input.prompt]), assertCurrent: beforeSubmit,
        });
        enteredExecution = true;
        return { nodeId, signal, beforeSubmit };
      },
    });
    if (tracksOperation) await recordMcpOperationProgress(context.taskId, { mediaStage: 'delivered', persistence: 'saved',
      artifactId: `native-media-${operationId}` }).catch(() => undefined);
    if (isCurrent()) await import('../../nativeMediaMessages').then(({ projectNativeMediaMessages }) =>
      projectNativeMediaMessages(context.conversationId)).catch(() => undefined);
    return { status: 'success', summary: 'ComfyUI 原任务的产物已保存和交付', modelContent: modelContent({
      operationId, artifactId: `native-media-${operationId}`, kind, deliveryMode: input.deliveryMode,
      canvasNodeId: targetNodeId, persistence: 'saved', ...saveOfferContent(saveOffer),
    }) };
  } catch (error) {
    const pendingId = error instanceof Error && error.name === 'NativeMediaTaskPending' && 'nativeOperationId' in error
      && typeof error.nativeOperationId === 'string' ? error.nativeOperationId : undefined;
    let receiptUnavailable = false;
    const record = enteredExecution ? await import('../../indexedDb/nativeMediaTaskRepository').then(async ({ listNativeMediaTasks, ACTIVE_NATIVE_MEDIA_STATES }) => (
      await listNativeMediaTasks(canvas.projectId, { canvasId: canvas.canvasId, origin, statuses: ACTIVE_NATIVE_MEDIA_STATES })
    ).find((item) => item.episodeId === canvas.episodeId && item.projectEpoch === canvas.projectEpoch && item.canvasEpoch === canvas.canvasEpoch
      && item.origin?.agentTaskId === context.taskId)).catch(() => { receiptUnavailable = true; return undefined; }) : undefined;
    const operationId = record?.operationId ?? pendingId;
    if (operationId || receiptUnavailable) {
      const { readNativeMediaRecoverySummary } = await import('../../nativeMediaRecoverySummary');
      const recovery = record && await readNativeMediaRecoverySummary(record).catch(() => undefined);
      if (targetNodeId && operationId && isCurrent()) await refreshNativeMediaNodeRecovery(canvas, targetNodeId, operationId, canUpdatePlaceholder).catch(() => undefined);
      const summary = recovery?.canResume ? 'ComfyUI 原任务已保留，可续查或继续保存' : 'ComfyUI 提交结果待确认，请先核对原服务器';
      patchMessage({ mediaStatus: recovery?.canResume ? 'paused' : 'submit_unknown', mediaError: summary });
      if (tracksOperation) await recordMcpOperationProgress(context.taskId, { phase: 'partial', mediaStage: 'started',
        errorCode: 'AGENT_MEDIA_RECOVERY_PENDING' }).catch(() => undefined);
      return { status: 'success', summary, errorCode: 'AGENT_MEDIA_RECOVERY_PENDING', modelContent: modelContent({
        operationId, nodeId: record?.nodeId, canvasNodeId: targetNodeId, recovery, retryable: false,
      }) };
    }
    const failure = asError(error, 'ComfyUI 动态工作流执行失败');
    if (targetNodeId && canUpdatePlaceholder()) {
      if (run.placeholder) failMediaPlaceholderLifecycle(run.placeholder, failure.summary);
      else {
        const state = useAppStore.getState();
        state.failMediaPlaceholder(targetNodeId, failure.summary);
        state.incrementRevision();
      }
    }
    patchMessage({ mediaStatus: 'failed', mediaError: failure.summary, canvasStatus: targetNodeId ? 'failed' : 'none',
      canvasError: targetNodeId ? failure.summary : undefined });
    return failure;
  } finally {
    unbindOrigin?.();
    finishRun?.();
    if (run.placeholder) completeCanvasDerivation(run.placeholder.guard);
  }
}

export function registerComfyAgentTools(): Array<() => void> {
  return [
    registerAgentTool<DiscoverInput>({
      id: 'comfyui_discover',
      title: '读取 ComfyUI 服务器、模型与节点',
      description: [
        'resource=servers 读取设置中的服务器名称和 ID；查询 models/nodes 时传 serverId 选择目标，省略则使用默认服务器，不接受临时 URL。',
        '通过所选 ComfyUI API 读取已安装模型或全部注册节点，不扫描本地目录。',
        '编写工作流时先查 models，再按名称或 class_type 查询 nodes 的准确输入输出结构。',
        'resource=nodes 且传 nodeClasses 可精确读取多个节点；列表过大时用 query 和 limit 分页式缩小范围。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['resource'],
        additionalProperties: false,
        properties: {
          resource: { type: 'string', enum: ['servers', 'models', 'nodes'] },
          serverId: { type: 'string', minLength: 1, maxLength: 200 },
          query: { type: 'string', maxLength: 200 },
          nodeClasses: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 200 },
          },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
      effect: 'read',
      isAvailable: () => listConfiguredComfyServers().length > 0,
      summarizeInput: (input) => input.resource === 'servers'
        ? '读取已配置的 ComfyUI 服务器'
        : input.resource === 'models'
        ? `读取 ComfyUI 已安装模型${input.query ? `，筛选“${input.query}”` : ''}`
        : `读取 ComfyUI 节点定义${input.nodeClasses?.length ? `（${input.nodeClasses.length} 类）` : ''}`,
      execute: async (_context, input) => {
        try {
          const result = await discoverComfyUI(input);
          return {
            status: 'success',
            summary: input.resource === 'servers' ? '已读取 ComfyUI 服务器清单'
              : input.resource === 'models' ? '已读取 ComfyUI 模型清单' : '已读取 ComfyUI 节点定义',
            modelContent: modelContent(result),
          };
        } catch (error) {
          return asError(error, '读取 ComfyUI 信息失败');
        }
      },
    }),
    registerAgentTool<ValidateInput>({
      id: 'comfyui_validate_workflow',
      title: '校验 ComfyUI 动态工作流',
      description: [
        '校验助手编写的 ComfyUI API 格式工作流。workflow 顶层键是节点 ID，每个节点包含 class_type 与 inputs。',
        '传入发现阶段使用的 serverId；省略时使用默认服务器。校验凭证绑定该服务器，执行和保存不会切换目标。',
        '会按当前 /object_info 检查全部节点、必填输入、连线和 combo 选项；所有已注册自定义节点均可使用。',
        '成功后返回短期 validationId；只有该 ID 能交给 comfyui_execute_workflow 请求执行。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['kind', 'workflow'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          workflow: { type: 'object' },
          serverId: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
      effect: 'read',
      isAvailable: () => listConfiguredComfyServers().length > 0,
      summarizeInput: (input) => `校验 ${Object.keys(input.workflow ?? {}).length} 个节点的 ComfyUI ${input.kind}工作流`,
      execute: async (context, input) => {
        try {
          const mcp = comfyMcpScope(context);
          const summary = await validateComfyUIWorkflow({
            workflow: input.workflow,
            kind: input.kind,
            taskId: context.taskId,
            projectId: context.projectId,
            serverId: input.serverId,
            ...(mcp ? { mcp } : {}),
          });
          return {
            status: 'success',
            summary: `ComfyUI 工作流校验通过（${summary.serverName}，${summary.nodeCount} 个节点）`,
            modelContent: modelContent(summary),
          };
        } catch (error) {
          return asError(error, 'ComfyUI 工作流校验失败');
        }
      },
    }),
    registerAgentTool<ExecuteInput>({
      id: 'comfyui_execute_workflow',
      title: '执行 ComfyUI 动态工作流',
      description: [
        '执行刚由 comfyui_validate_workflow 校验通过的动态工作流，并把首个目标媒体输出送到对话、画布或两者。',
        '执行遵循当前模式的媒体生成权限。validationId 十分钟有效，内部助手限当前任务，MCP 限原控制桥实例和画布。',
        '目标服务器已由校验固定，地址变化或服务器被删除后必须重新校验。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['validationId', 'prompt', 'deliveryMode'],
        additionalProperties: false,
        properties: {
          validationId: { type: 'string', minLength: 1, maxLength: 160 },
          prompt: { type: 'string', minLength: 1, maxLength: 12000 },
          deliveryMode: { type: 'string', enum: ['chat', 'canvas', 'both'] },
        },
      },
      effect: 'media_generation',
      isAvailable: () => listConfiguredComfyServers().length > 0,
      authorize: (context, input) => {
        const mcp = comfyMcpScope(context);
        const target = context.executionContext ?? context.projectScope;
        if (target?.modelGeneration === 1 && !mcp) return { allowed: false, reason: '新结构动态工作流需要 MCP 控制桥上下文' };
        if (!getValidatedComfyWorkflowSummary(input.validationId, context.taskId, context.projectId, mcp)) {
          return { allowed: false, reason: '工作流尚未校验、校验已过期、服务器配置已变化或不属于当前任务' };
        }
        if (input.deliveryMode !== 'chat' && useAppStore.getState().currentProjectId !== context.projectId) {
          return { allowed: false, reason: '目标项目当前未加载，不能把结果写入其他项目画布' };
        }
        return { allowed: true };
      },
      summarizeInput: (input) => {
        const task = useAppStore.getState().agentTasks.find((item) => (
          getValidatedComfyWorkflowSummary(input.validationId, item.id, item.projectId)
        ));
        const summary = task
          ? getValidatedComfyWorkflowSummary(input.validationId, task.id, task.projectId)
          : null;
        if (!summary) return '执行已校验的 ComfyUI 动态工作流';
        const models = summary.modelNames.length ? summary.modelNames.join('、') : '工作流内置/无显式模型文件';
        const custom = summary.customNodeClasses.length
          ? `；包含自定义节点 ${summary.customNodeClasses.join('、')}`
          : '';
        return `在 ${summary.serverName} 使用模型 ${models} 执行 ${summary.nodeCount} 节点的 ComfyUI 工作流${custom}。自定义节点可能访问文件、网络或外部程序`;
      },
      execute: async (context, input) => {
        const mcp = comfyMcpScope(context);
        const summary = getValidatedComfyWorkflowSummary(input.validationId, context.taskId, context.projectId, mcp);
        if (!summary) return asError(null, '工作流校验已失效，请重新校验');
        const assistantMessageId = getAssistantMessageId(context.taskId);
        if (!assistantMessageId) return asError(null, '未找到承载 ComfyUI 结果的助手消息');
        if (mcp?.canvas.modelGeneration === 1) return runNativeComfyTool(context, mcp, assistantMessageId, input, summary.kind);

        const store = useAppStore.getState();
        const intent: MediaGenerationIntent = {
          kind: summary.kind,
          prompt: input.prompt,
          modelRef: summary.modelNames.join(', ') || 'comfyui/dynamic-workflow',
          deliveryMode: input.deliveryMode,
        };
        const needsCanvas = input.deliveryMode !== 'chat';
        let targetNodeId: string | undefined;
        let lifecycle: MediaPlaceholderLifecycle | null = null;
        if (needsCanvas) {
          targetNodeId = store.createMediaPlaceholder(intent);
          lifecycle = registerMediaPlaceholderLifecycle(targetNodeId);
        }
        store.updateMessage(assistantMessageId, {
          mediaStatus: 'generating',
          mediaError: undefined,
          canvasStatus: needsCanvas ? 'pending' : 'none',
          canvasNodeId: targetNodeId,
          canvasError: undefined,
        });

        try {
          const { artifact: result, saveOffer } = await executeValidatedComfyUIWorkflow({
            validationId: input.validationId,
            taskId: context.taskId,
            projectId: context.projectId,
            conversationId: context.conversationId,
            prompt: input.prompt,
            deliveryMode: input.deliveryMode,
            signal: context.signal,
            ...(mcp ? { mcp } : {}),
          });
          const currentStore = useAppStore.getState();
          const nodeCreated = lifecycle
            ? settleMediaPlaceholderLifecycle(lifecycle, result)
            : targetNodeId ? currentStore.settleMediaPlaceholder(targetNodeId, result) : false;
          currentStore.updateMessage(assistantMessageId, {
            mediaResult: result,
            mediaStatus: 'succeeded',
            mediaError: undefined,
            canvasStatus: targetNodeId ? (nodeCreated ? 'created' : 'failed') : 'none',
            canvasNodeId: targetNodeId,
            canvasError: targetNodeId && !nodeCreated ? '结果已生成，但目标占位节点已不存在' : undefined,
          });
          return {
            status: 'success',
            summary: result.persistence === 'failed'
              ? 'ComfyUI 已生成内容，但未能保存到项目目录'
              : 'ComfyUI 已生成内容',
            modelContent: modelContent({
              artifactId: result.id,
              kind: result.kind,
              deliveryMode: result.deliveryMode,
              canvasNodeId: targetNodeId,
              persistence: result.persistence,
              persistError: result.persistError,
              ...saveOfferContent(saveOffer),
            }),
          };
        } catch (error) {
          const stopped = context.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
          const message = stopped
            ? '已停止等待 ComfyUI 动态工作流，可在原服务器的队列和历史中核对任务状态'
            : error instanceof Error ? error.message : 'ComfyUI 动态工作流执行失败';
          const currentStore = useAppStore.getState();
          if (lifecycle) failMediaPlaceholderLifecycle(lifecycle, message);
          else if (targetNodeId) currentStore.failMediaPlaceholder(targetNodeId, message);
          currentStore.updateMessage(assistantMessageId, {
            mediaStatus: 'failed',
            mediaError: message,
            canvasStatus: targetNodeId ? 'failed' : 'none',
            canvasError: targetNodeId ? message : undefined,
          });
          return { status: 'error', summary: message, modelContent: message };
        }
      },
    }),
    registerAgentTool<SaveWorkflowInput>({
      id: 'comfyui_save_workflow',
      title: '保存 ComfyUI 动态工作流',
      description: [
        '把刚刚成功执行的动态工作流保存到“工作流管理”。',
        '只有在执行结果要求询问、且用户明确同意保存后才能调用；name 使用用户给出的名称，未指定时使用建议名称。',
        '保存后工作流会按图片、视频或音频自动分类，并自动识别可注入的提示词与媒体输入节点。',
        '保存会保留执行时的服务器绑定；服务器删除或地址变化时拒绝保存，请恢复配置或重新校验并执行。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['saveOfferId', 'name'],
        additionalProperties: false,
        properties: {
          saveOfferId: { type: 'string', minLength: 1, maxLength: 160 },
          name: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      effect: 'file_write',
      authorize: (context, input) => {
        const offer = getComfyWorkflowSaveOfferSummary(
          input.saveOfferId,
          context.conversationId,
          context.projectId,
        );
        return offer
          ? { allowed: true }
          : { allowed: false, reason: '工作流保存凭证已过期、服务器配置已变化或不属于当前对话' };
      },
      summarizeInput: (input) => `将 ComfyUI 工作流保存到工作流管理，名称为“${input.name.trim()}”`,
      execute: async (context, input) => {
        try {
          const saved = await saveCompletedComfyUIWorkflow({
            saveOfferId: input.saveOfferId,
            conversationId: context.conversationId,
            projectId: context.projectId,
            name: input.name,
          });
          useAppStore.getState().showToast(`工作流“${saved.name}”已保存`);
          return {
            status: 'success',
            summary: `工作流“${saved.name}”已保存到工作流管理`,
            modelContent: modelContent(saved),
          };
        } catch (error) {
          return asError(error, '保存 ComfyUI 工作流失败');
        }
      },
    }),
  ];
}
