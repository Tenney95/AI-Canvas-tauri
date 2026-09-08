/** 内部助手的 ComfyUI API 发现、动态工作流校验与执行工具。 */
import { useAppStore } from '../../../store/useAppStore';
import type { MediaDeliveryMode, MediaGenerationIntent, MediaKind } from '../../../types/media';
import { listConfiguredComfyServers } from '../../comfyServers';
import {
  discoverComfyUI,
  executeValidatedComfyUIWorkflow,
  getComfyWorkflowSaveOfferSummary,
  getValidatedComfyWorkflowSummary,
  saveCompletedComfyUIWorkflow,
  validateComfyUIWorkflow,
} from '../../comfyAgentService';
import {
  failMediaPlaceholderLifecycle,
  registerMediaPlaceholderLifecycle,
  settleMediaPlaceholderLifecycle,
  type MediaPlaceholderLifecycle,
} from '../mediaPlaceholderLifecycle';
import { registerAgentTool, type AgentToolExecutionResult } from '../toolRegistry';

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
          const summary = await validateComfyUIWorkflow({
            workflow: input.workflow,
            kind: input.kind,
            taskId: context.taskId,
            projectId: context.projectId,
            serverId: input.serverId,
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
        '执行遵循当前模式的媒体生成权限；摘要展示服务器、实际模型、自定义节点与节点数量。validationId 仅限当前任务且十分钟有效。',
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
        if (!getValidatedComfyWorkflowSummary(input.validationId, context.taskId, context.projectId)) {
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
        const summary = getValidatedComfyWorkflowSummary(input.validationId, context.taskId, context.projectId);
        if (!summary) return asError(null, '工作流校验已失效，请重新校验');
        const assistantMessageId = getAssistantMessageId(context.taskId);
        if (!assistantMessageId) return asError(null, '未找到承载 ComfyUI 结果的助手消息');

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
              workflowSaveOffer: {
                saveOfferId: saveOffer.saveOfferId,
                suggestedName: saveOffer.suggestedName,
                expiresAt: saveOffer.expiresAt,
                serverId: saveOffer.serverId,
                serverName: saveOffer.serverName,
              },
              nextAction: `必须询问用户：“这个工作流已成功执行，是否以“${saveOffer.suggestedName}”保存到工作流管理？”不要自动保存。用户同意后再调用 comfyui_save_workflow。`,
            }),
          };
        } catch (error) {
          const stopped = context.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
          const message = stopped
            ? '已终止 ComfyUI 动态工作流，并已请求取消远端任务'
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
