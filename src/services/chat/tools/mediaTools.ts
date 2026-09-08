/**
 * 注册图片、视频和音频生成工具；媒体调用沿用项目默认值、统一运行时和固定 Policy 边界。
 */
import { useAppStore } from '../../../store/useAppStore';
import { comfyBaseUrlFor } from '../../comfyServers';
import { isRunningHubWorkflow, isCloudWorkflow, mediaProviderConfigId, workflowExecution } from '../../workflowExecutionService';
import { AUTODL_H3_WORKFLOW, validateWorkflowApiManifest, resolveWorkflowApiInputValues } from '../../workflowApi/autodlWorkflowManifest';
import { completeWorkflowApiNodeTask, workflowApiConnection } from '../../workflowApi/workflowApiAdapter';
import { getRunningHubModel, parseRunningHubModelParameter } from '../../ai/providers/runninghubModelManifest';
import { runningHubParameterKey } from '../../runninghubWorkflowService';
import { completeRunningHubNodeTask } from '../../ai/providers/runninghubWorkflow';
import type {
  AudioGenerationPurpose,
  MediaDeliveryMode,
  MediaGenerationIntent,
  MediaKind,
} from '../../../types/media';
import {
  findMediaModelOption,
  getMediaModelOptions,
} from '../../../components/nodes/shared/defaultModels';
import {
  extractModelMention,
  MEDIA_PERSIST_FAILED_MESSAGE,
  runMediaGeneration,
} from '../../ai/generationRuntime';
import type { AgentToolDisplaySnapshot } from '../../../types/agent';
import {
  registerAgentTool,
  type AgentToolExecutionResult,
} from '../toolRegistry';
import {
  failMediaPlaceholderLifecycle,
  MEDIA_PLACEHOLDER_STALE_ERROR,
  registerMediaPlaceholderLifecycle,
  settleMediaPlaceholderLifecycle,
  type MediaPlaceholderLifecycle,
} from '../mediaPlaceholderLifecycle';

interface GenerateMediaInput {
  kind: MediaKind;
  prompt: string;
  modelRef?: string;
  deliveryMode: MediaDeliveryMode;
  audioPurpose?: AudioGenerationPurpose;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  modelParameters?: Array<{ name: string; value: string }>;
  workflowInputs?: Array<{ nodeId: string; fieldName: string; value: string }>;
}

const MEDIA_PROMPT_DISPLAY_LIMIT = 1_000;

function resolveMediaToolInput(
  input: GenerateMediaInput,
  context: { projectId: string; mode: string },
): GenerateMediaInput {
  const store = useAppStore.getState();
  const projectSettings = store.projects.find(
    (project) => project.id === context.projectId,
  )?.settings;
  const defaultModel = projectSettings?.defaultModels?.[input.kind];
  let modelRef = input.modelRef ?? defaultModel;
  if (!input.modelRef && context.mode === 'autonomous' && projectSettings?.modelAutoRouting) {
    const terms = input.prompt.toLowerCase().split(/[\s,，。;；、/]+/).filter((term) => term.length >= 2);
    const options = getMediaModelOptions(
      store.config.generalModels ?? [],
      store.config,
      store.workflows,
    ).filter((option) => option.mediaKind === input.kind);
    const ranked = options.map((option) => {
      const description = `${option.label} ${option.description ?? ''}`.toLowerCase();
      const relevance = terms.reduce((score, term) => score + (description.includes(term) ? 1 : 0), 0);
      return { option, score: relevance + (option.value === defaultModel ? 0.25 : 0) };
    }).sort((a, b) => b.score - a.score);
    modelRef = ranked[0]?.option.value ?? modelRef;
  }
  const resolved: GenerateMediaInput = {
    ...input,
    ...(modelRef ? { modelRef } : {}),
  };
  if (input.kind !== 'video') return resolved;
  const selectedModel = modelRef
    ? findMediaModelOption(
      modelRef,
      store.config.generalModels ?? [],
      store.config,
      store.workflows,
    )
    : undefined;
  // 自定义 API 的缺省值由该模型 capability / 上游接口决定，不能套用项目里为内置模型
  // 保存的 16:9、1080p、10 秒等偏好。用户本轮显式传入的值已经保留在 resolved 中。
  if (selectedModel?.provider === 'general' && !selectedModel.workflowId) return resolved;
  if (selectedModel && ['runninghubwf', 'runninghub', 'workflow-api'].includes(selectedModel.provider)) return resolved;
  return {
    ...resolved,
    aspectRatio: input.aspectRatio ?? projectSettings?.generation?.videoAspectRatio,
    resolution: input.resolution ?? projectSettings?.generation?.videoResolution,
    duration: input.duration ?? projectSettings?.generation?.videoDuration,
  };
}

function nodeMediaKind(nodeId: string): MediaKind | undefined {
  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
  if (!node) return undefined;
  if (node.data.imageUrl || node.type === 'source-image' || node.type === 'ai-image') return 'image';
  if (node.data.videoUrl || node.type === 'source-video' || node.type === 'ai-video') return 'video';
  if (node.data.audioUrl || node.type === 'source-audio' || node.type === 'ai-audio') return 'audio';
  return undefined;
}

function buildMediaInputDisplay(input: GenerateMediaInput): AgentToolDisplaySnapshot {
  const nodeReferences = [...input.prompt.matchAll(/@\{([^:}]+):([^}]+)\}/g)]
    .map((match) => {
      const nodeId = match[1].split('/cell/')[0];
      const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
      return {
        kind: 'node' as const,
        id: nodeId,
        label: node?.data.label || match[2],
        mediaKind: nodeMediaKind(nodeId),
      };
    });
  const assetReferences = [...input.prompt.matchAll(/@asset\{[^}]+\}/g)]
    .map((_, index) => ({
      kind: 'asset' as const,
      id: `asset-${index + 1}`,
      label: `用户素材 ${index + 1}`,
      mediaKind: 'image' as const,
    }));
  const fields: NonNullable<AgentToolDisplaySnapshot['fields']> = [
    {
      label: '媒体类型',
      value: input.kind === 'image' ? '图片' : input.kind === 'video' ? '视频' : '音频',
    },
    { label: '模型', value: input.modelRef || '确认时选择' },
    {
      label: '输出位置',
      value: input.deliveryMode === 'chat'
        ? '对话'
        : input.deliveryMode === 'canvas'
          ? '画布'
          : '对话和画布',
    },
    { label: '提示词', value: input.prompt.trim().slice(0, MEDIA_PROMPT_DISPLAY_LIMIT) },
  ];
  if (input.kind === 'video') {
    fields.push(
      {
        label: '画面比例',
        value: input.aspectRatio || '模型默认',
        source: input.aspectRatio ? 'resolved' : 'model_default',
      },
      {
        label: '分辨率',
        value: input.resolution || '模型默认',
        source: input.resolution ? 'resolved' : 'model_default',
      },
      {
        label: '时长',
        value: input.duration ? `${input.duration} 秒` : '模型默认',
        source: input.duration ? 'resolved' : 'model_default',
      },
    );
  }
  return {
    fields,
    references: [...nodeReferences, ...assetReferences],
  };
}

function getAssistantMessageId(taskId: string): string | undefined {
  return useAppStore.getState().messages.find(
    (message) => message.agentTaskId === taskId && message.role === 'assistant',
  )?.id;
}

export function registerMediaAgentTools(): Array<() => void> {
  return [
    registerAgentTool<{ modelRef: string }>({
      id: 'media_model_parameters', title: '读取模型专属参数', effect: 'read',
      description: '读取当前可选 RunningHub 标准模型的操作、输入媒体、必填字段、默认值和限制。通过 media_generate.modelParameters 提交专属参数；首尾帧、编辑或动作控制需选择对应操作。',
      inputSchema: { type: 'object', required: ['modelRef'], additionalProperties: false, properties: { modelRef: { type: 'string', minLength: 1, maxLength: 240 } } },
      authorize: (context) => ({ allowed: context.projectId === useAppStore.getState().currentProjectId, reason: '只能读取当前项目可用的模型' }),
      execute: async (_context, input) => {
        const store = useAppStore.getState();
        const option = findMediaModelOption(input.modelRef, store.config.generalModels ?? [], store.config, store.workflows);
        const model = option?.provider === 'runninghub' ? getRunningHubModel(input.modelRef, true) : undefined;
        if (!model) return { status: 'error', summary: '未找到可用的 RunningHub 标准模型', modelContent: '先在模型管理中启用所需操作', errorCode: 'RUNNINGHUB_MODEL_NOT_FOUND' };
        return { status: 'success', summary: `已读取 ${model.label} 参数`, modelContent: JSON.stringify(model) };
      },
    }),
    registerAgentTool<{ modelRef: string }>({
      id: 'media_workflow_parameters', title: '读取云工作流参数', effect: 'read',
      description: '读取已保存云工作流的输出类型、参数名称、默认值与素材映射，供 media_generate 使用。',
      inputSchema: { type: 'object', required: ['modelRef'], additionalProperties: false, properties: { modelRef: { type: 'string', minLength: 1, maxLength: 240 } } },
      authorize: (context) => ({ allowed: context.projectId === useAppStore.getState().currentProjectId, reason: '只能读取当前项目可用的工作流' }),
      execute: async (_context, input) => {
        const store = useAppStore.getState();
        const option = findMediaModelOption(input.modelRef, store.config.generalModels ?? [], store.config, store.workflows);
        const workflow = store.workflows.find((item) => item.id === option?.workflowId);
        if (workflow?.adapterType === 'workflow-api') {
          validateWorkflowApiManifest(workflow.workflowApi);
          const defaults = resolveWorkflowApiInputValues(workflow.workflowApi.defaults);
          return { status: 'success', summary: `已读取 ${workflow.name} 的参数`, modelContent: JSON.stringify({
            workflowId: workflow.id, outputType: 'video', capability: AUTODL_H3_WORKFLOW.capability, defaults,
            parameters: [{ nodeId: 'workflow', fieldName: 'seed', type: 'number', required: false, defaultValue: defaults.seed }],
            usage: '时长、分辨率和比例使用 duration/resolution/aspectRatio；可选 seed 放入 workflowInputs。图片与音频在 prompt 中显式引用，按顺序传入。',
          }) };
        }
        if (!isRunningHubWorkflow(workflow) || !workflow?.runninghub) return { status: 'error', summary: '未找到已保存的云工作流', modelContent: '请先在工作流管理中导入 RunningHub 工作流或 AI 应用', errorCode: 'RUNNINGHUB_WORKFLOW_NOT_FOUND' };
        return { status: 'success', summary: `已读取 ${workflow.name} 的参数`, modelContent: JSON.stringify({ workflowId: workflow.id, outputType: workflow.category, parameters: workflow.runninghub.parameters.map((field) => ({ ...field, defaultValue: typeof field.defaultValue === 'string' ? field.defaultValue.slice(0, 1200) : field.defaultValue })) }) };
      },
    }),
    registerAgentTool<GenerateMediaInput>({
      id: 'media_generate',
      title: '生成媒体内容',
      description: [
        '生成图片、视频、音乐或语音。用户本轮已提供 @model 时把模型 ID 写入 modelRef；',
        '未提供 @model 时省略 modelRef，运行时优先使用项目默认模型。',
        '若项目已设置该类型默认模型则直接使用；自主模式开启自动路由后，可依据模型能力与用户自定义说明选择。',
        '图片 prompt 可以原样包含用户提供的 @{nodeId:label} 或 @asset{path} 引用，',
        '运行时会自动解析为参考图输入；无需先读取节点原 prompt，也不要要求用户重新描述图片。',
        '视频可显式传入 aspectRatio、resolution 和 duration；自定义 API 省略时由模型 capability / 接口默认值决定，内置模型与工作流才锁定项目默认值。',
        '协作模式由 Policy 请求确认，自主模式直接执行。deliveryMode 控制结果显示在对话、画布或两者。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['kind', 'prompt', 'deliveryMode'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: 12000,
            description: '生成或编辑要求；图片编辑时必须原样保留用户给出的节点或资产引用标记。',
          },
          modelRef: { type: 'string', minLength: 1, maxLength: 240 },
          modelParameters: {
            type: 'array', maxItems: 100, description: 'RunningHub 标准模型专属参数；先用 media_model_parameters 读取合同。值为字符串，数组使用 JSON 字符串数组，数字/布尔值由本地还原。',
            items: { type: 'object', required: ['name', 'value'], additionalProperties: false, properties: {
              name: { type: 'string', minLength: 1, maxLength: 200 }, value: { type: 'string', maxLength: 12000 },
            } },
          },
          workflowInputs: {
            type: 'array', maxItems: 200, description: 'RunningHub 参数覆盖；先用 media_workflow_parameters 读取参数定义，数字和布尔值以字符串传入并由本地恢复类型。',
            items: { type: 'object', required: ['nodeId', 'fieldName', 'value'], additionalProperties: false, properties: {
              nodeId: { type: 'string', minLength: 1, maxLength: 120 }, fieldName: { type: 'string', minLength: 1, maxLength: 160 }, value: { type: 'string', maxLength: 12000 },
            } },
          },
          deliveryMode: { type: 'string', enum: ['chat', 'canvas', 'both'] },
          audioPurpose: { type: 'string', enum: ['music', 'speech'] },
          aspectRatio: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: '视频画面比例；用户明确指定时传入，合法值由所选模型 capability 校验。',
          },
          resolution: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: '视频分辨率档位；用户明确指定时传入，合法值由所选模型 capability 校验。',
          },
          duration: {
            type: 'integer',
            minimum: 1,
            maximum: 3600,
            description: '视频时长，单位秒；用户明确指定时传入，模型范围由 capability 在提交前校验。',
          },
        },
      },
      effect: 'media_generation',
      resolveInput: resolveMediaToolInput,
      authorize: (context, input) => {
        const store = useAppStore.getState();
        const task = store.agentTasks.find((item) => item.id === context.taskId);
        const mentionedModel = task ? extractModelMention(task.goal) : undefined;
        if (mentionedModel && mentionedModel !== input.modelRef) {
          return {
            allowed: false,
            reason: '工具使用的媒体模型与用户本轮 @model 选择不一致',
          };
        }
        if (input.modelRef) {
          const option = findMediaModelOption(
            input.modelRef,
            store.config.generalModels ?? [],
            store.config,
            store.workflows,
          );
          if (!option || option.mediaKind !== input.kind) {
            return { allowed: false, reason: '所选模型与本次媒体类型不兼容' };
          }
          if (input.modelParameters?.length) {
            const model = option.provider === 'runninghub' ? getRunningHubModel(input.modelRef, true) : undefined;
            if (!model) return { allowed: false, reason: '所选模型不支持 RunningHub 专属参数' };
            if (new Set(input.modelParameters.map((field) => field.name)).size !== input.modelParameters.length) return { allowed: false, reason: '模型参数包含重复字段' };
            try {
              for (const entry of input.modelParameters) {
                const field = model.parameters.find((field) => field.name === entry.name);
                if (!field) return { allowed: false, reason: '模型参数不在当前合同中' };
                parseRunningHubModelParameter(field, entry.value);
              }
            } catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : '模型参数无效' }; }
          }
          if (option.workflowId) {
            const workflow = store.workflows.find((item) => item.id === option.workflowId);
            if (isRunningHubWorkflow(workflow) && [input.aspectRatio, input.resolution, input.duration].some((value) => value !== undefined)) return { allowed: false, reason: '云工作流使用自己的参数定义，请通过 workflowInputs 设置比例、分辨率或时长' };
            if (input.workflowInputs && new Set(input.workflowInputs.map(runningHubParameterKey)).size !== input.workflowInputs.length) return { allowed: false, reason: '工作流参数包含重复节点/字段' };
            if (isRunningHubWorkflow(workflow)) {
              if (!store.config.providers[mediaProviderConfigId(option.provider, workflow)]?.apiKey) return { allowed: false, reason: '请先配置该 RunningHub 工作流使用的 API Key' };
            } else if (workflow?.adapterType === 'workflow-api') {
              try { validateWorkflowApiManifest(workflow.workflowApi); workflowApiConnection(store.config.providers[workflow.workflowApi.connectionId]); }
              catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : '工作流连接无效' }; }
            } else if (!comfyBaseUrlFor(option.workflowId)) {
              return { allowed: false, reason: '请先在设置里配置 ComfyUI 服务地址' };
            }
          } else if (option.provider === 'general') {
            const generalModel = (store.config.generalModels ?? []).find(
              (model) => `general/${model.id}` === option.value,
            );
            const provider = generalModel
              ? store.config.providers[generalModel.providerConfigId]
              : undefined;
            if (!generalModel?.modelId || !provider?.baseUrl) {
              return { allowed: false, reason: `模型“${option.label}”的接口配置不完整` };
            }
          } else if (option.provider === 'dreamina') {
            if (!store.config.dreaminaAuth?.loggedIn) {
              return { allowed: false, reason: '请先登录即梦账号' };
            }
          } else if (!store.config.providers[mediaProviderConfigId(option.provider)]?.apiKey) {
            return { allowed: false, reason: `请先配置 ${option.provider} 的 API Key` };
          }
        }
        if (
          input.deliveryMode !== 'chat'
          && store.currentProjectId !== context.projectId
        ) {
          return {
            allowed: false,
            reason: '目标项目当前未加载，不能把媒体结果写入其他项目的画布',
          };
        }
        if (input.kind === 'audio' && !input.audioPurpose) {
          return {
            allowed: false,
            reason: '音频生成必须说明用途是音乐还是语音',
          };
        }
        if (
          input.kind !== 'video'
          && (input.aspectRatio !== undefined || input.resolution !== undefined || input.duration !== undefined)
        ) {
          return { allowed: false, reason: '比例、分辨率和时长参数只适用于视频生成' };
        }
        return { allowed: true };
      },
      summarizeInput: (input) => {
        const label = input.kind === 'image'
          ? '图片'
          : input.kind === 'video'
            ? '视频'
            : input.audioPurpose === 'music'
              ? '音乐'
              : '语音';
        const referenceCount = input.prompt.match(/@asset\{[^}]+\}|@\{[^:}]+:[^}]+\}/g)?.length ?? 0;
        return `${input.modelRef ? `使用 ${input.modelRef}` : '选择模型后'}${referenceCount > 0 ? `，基于 ${referenceCount} 个参考输入` : ''}生成${label}，输出到${
          input.deliveryMode === 'chat'
            ? '对话'
            : input.deliveryMode === 'canvas'
              ? '画布'
              : '对话和画布'
        }`;
      },
      buildInputDisplay: buildMediaInputDisplay,
      execute: async (context, input): Promise<AgentToolExecutionResult> => {
        const store = useAppStore.getState();
        if (!input.modelRef) {
          return {
            status: 'error',
            summary: '未选择媒体模型',
            modelContent: '未选择媒体模型',
            errorCode: 'AGENT_MEDIA_MODEL_REQUIRED',
          };
        }
        const referencedNodeIds = [...input.prompt.matchAll(/@\{([^:}]+):[^}]+\}/g)]
          .map((match) => match[1].split('/cell/')[0]);
        const missingNodeId = referencedNodeIds.find(
          (nodeId) => !store.nodes.some((node) => node.id === nodeId),
        );
        if (missingNodeId) {
          return {
            status: 'error',
            summary: '参考节点已不存在，请重新选择图片',
            modelContent: '参考节点已不存在，请重新选择图片',
            errorCode: 'AGENT_MEDIA_REFERENCE_NOT_FOUND',
          };
        }
        const assistantMessageId = getAssistantMessageId(context.taskId);
        if (!assistantMessageId) {
          return {
            status: 'error',
            summary: '未找到承载媒体结果的助手消息',
            modelContent: '未找到承载媒体结果的助手消息',
            errorCode: 'AGENT_MEDIA_MESSAGE_NOT_FOUND',
          };
        }

        const intent: MediaGenerationIntent = {
          kind: input.kind,
          prompt: input.prompt,
          modelRef: input.modelRef,
          deliveryMode: input.deliveryMode,
          audioPurpose: input.audioPurpose,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          duration: input.duration,
          runninghubModelParameters: input.modelParameters ? Object.fromEntries(input.modelParameters.map((field) => [field.name, field.value])) : undefined,
          workflowInputs: input.workflowInputs ? Object.fromEntries(input.workflowInputs.map((field) => [runningHubParameterKey(field), field.value])) : undefined,
        };
        const needsCanvas = input.deliveryMode === 'canvas' || input.deliveryMode === 'both';
        let targetNodeId: string | undefined;
        let placeholderLifecycle: MediaPlaceholderLifecycle | null = null;
        if (needsCanvas) {
          targetNodeId = store.createMediaPlaceholder(intent);
          const cloud = store.workflows?.find((workflow) => isCloudWorkflow(workflow) && workflowExecution(workflow).model === input.modelRef);
          if (!cloud && input.modelRef && getRunningHubModel(input.modelRef)) store.updateNodeDataTransient(targetNodeId, { provider: 'runninghub', model: input.modelRef, runninghubModelParameters: intent.runninghubModelParameters });
          if (cloud) store.updateNodeDataTransient(targetNodeId, { ...workflowExecution(cloud), workflowInputs: intent.workflowInputs });
          placeholderLifecycle = registerMediaPlaceholderLifecycle(targetNodeId);
        }
        store.updateMessage(assistantMessageId, {
          mediaStatus: 'queued',
          mediaError: undefined,
          canvasStatus: needsCanvas ? 'pending' : 'none',
          canvasNodeId: targetNodeId,
          canvasError: undefined,
        });

        try {
          useAppStore.getState().updateMessage(assistantMessageId, {
            mediaStatus: 'generating',
          });
          const result = await runMediaGeneration(
            intent,
            context.projectId,
            context.signal,
            targetNodeId,
            { projectId: context.projectId, conversationId: context.conversationId, messageId: assistantMessageId, deliveryMode: input.deliveryMode },
          );
          if (context.signal.aborted) {
            throw new DOMException('请求已取消', 'AbortError');
          }
          const currentStore = useAppStore.getState();
          const nodeCreated = placeholderLifecycle
            ? settleMediaPlaceholderLifecycle(placeholderLifecycle, result)
            : targetNodeId ? currentStore.settleMediaPlaceholder(targetNodeId, result) : false;
          if (nodeCreated && targetNodeId && ['runninghubwf', 'runninghub'].includes(result.provider)) {
            currentStore.updateNodeDataTransient(targetNodeId, { runninghubOutputs: result.runninghubOutputs });
            completeRunningHubNodeTask(targetNodeId);
          }
          currentStore.updateMessage(assistantMessageId, {
            mediaResult: result,
            mediaStatus: 'succeeded',
            mediaError: undefined,
            canvasStatus: targetNodeId ? (nodeCreated ? 'created' : 'failed') : 'none',
            canvasNodeId: targetNodeId,
            canvasError: targetNodeId && !nodeCreated
              ? MEDIA_PLACEHOLDER_STALE_ERROR
              : undefined,
          });
          if (!targetNodeId && ['runninghubwf', 'runninghub'].includes(result.provider)) completeRunningHubNodeTask(`runninghub-message-${assistantMessageId}`);
          if (result.workflowApiTaskId && (!targetNodeId || nodeCreated)) {
            if (targetNodeId) currentStore.updateNodeDataTransient(targetNodeId, { workflowApiOutputs: result.workflowApiOutputs });
            completeWorkflowApiNodeTask(targetNodeId ?? `workflow-api-message-${assistantMessageId}`, result.workflowApiTaskId);
          }
          // 落盘失败时产物只有临时地址，必须让用户和模型都看到，而不是报告纯成功
          const unsaved = result.persistence === 'failed';
          if (unsaved) {
            currentStore.showToast(
              `媒体已生成，但未保存到项目：${result.persistError || MEDIA_PERSIST_FAILED_MESSAGE}`,
              'error',
            );
          }
          return {
            status: 'success',
            summary: unsaved ? '媒体内容已生成，但未能保存到项目目录' : '媒体内容已生成',
            modelContent: JSON.stringify({
              artifactId: result.id,
              kind: result.kind,
              audioPurpose: result.audioPurpose,
              deliveryMode: result.deliveryMode,
              canvasNodeId: targetNodeId,
              persistence: result.persistence,
              persistError: result.persistError,
            }),
            display: {
              fields: [
                { label: '产物 ID', value: result.id },
                { label: '媒体类型', value: result.kind },
                { label: '模型', value: result.modelId },
                { label: '保存状态', value: result.persistence },
                ...(targetNodeId
                  ? [{ label: '画布节点', value: targetNodeId }]
                  : []),
              ],
            },
          };
        } catch (error) {
          const stopped = context.signal.aborted
            || (error instanceof DOMException && error.name === 'AbortError');
          const message = stopped
            ? '已停止本地跟踪；供应商未确认远端取消，任务可能继续并产生费用'
            : error instanceof Error ? error.message : '未知错误';
          const currentStore = useAppStore.getState();
          if (placeholderLifecycle) failMediaPlaceholderLifecycle(placeholderLifecycle, message);
          else if (targetNodeId) currentStore.failMediaPlaceholder(targetNodeId, message);
          currentStore.updateMessage(assistantMessageId, {
            mediaStatus: 'failed',
            mediaError: message,
            canvasStatus: targetNodeId ? 'failed' : 'none',
            canvasNodeId: targetNodeId,
            canvasError: targetNodeId ? message : undefined,
          });
          return {
            status: 'error',
            summary: stopped ? message : `媒体生成失败：${message}`,
            modelContent: stopped ? message : `媒体生成失败：${message}`,
            errorCode: stopped
              ? 'AGENT_MEDIA_TRACKING_STOPPED'
              : 'AGENT_MEDIA_GENERATION_FAILED',
          };
        }
      },
    }),
  ];
}
