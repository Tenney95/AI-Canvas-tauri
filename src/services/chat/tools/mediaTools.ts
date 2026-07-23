import { useAppStore } from '../../../store/useAppStore';
import type {
  AudioGenerationPurpose,
  MediaDeliveryMode,
  MediaGenerationIntent,
  MediaKind,
} from '../../../types/media';
import {
  findMediaModelOption,
} from '../../../components/nodes/shared/defaultModels';
import {
  extractModelMention,
  runMediaGeneration,
} from '../../ai/generationRuntime';
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
}

function getAssistantMessageId(taskId: string): string | undefined {
  return useAppStore.getState().messages.find(
    (message) => message.agentTaskId === taskId && message.role === 'assistant',
  )?.id;
}

export function registerMediaAgentTools(): Array<() => void> {
  return [
    registerAgentTool<GenerateMediaInput>({
      id: 'media_generate',
      title: '生成媒体内容',
      description: [
        '生成图片、视频、音乐或语音。用户本轮已提供 @model 时把模型 ID 写入 modelRef；',
        '未提供 @model 时省略 modelRef，运行时会在审批卡中让用户选择兼容模型。',
        '图片 prompt 可以原样包含用户提供的 @{nodeId:label} 或 @asset{path} 引用，',
        '运行时会自动解析为参考图输入；无需先读取节点原 prompt，也不要要求用户重新描述图片。',
        '每次调用都会向用户确认。deliveryMode 控制结果显示在对话、画布或两者。',
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
          deliveryMode: { type: 'string', enum: ['chat', 'canvas', 'both'] },
          audioPurpose: { type: 'string', enum: ['music', 'speech'] },
        },
      },
      effect: 'media_generation',
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
          );
          if (!option || option.mediaKind !== input.kind) {
            return { allowed: false, reason: '所选模型与本次媒体类型不兼容' };
          }
          if (option.provider === 'general') {
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
          } else if (!store.config.providers[option.provider]?.apiKey) {
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
        };
        const needsCanvas = input.deliveryMode === 'canvas' || input.deliveryMode === 'both';
        let targetNodeId: string | undefined;
        let placeholderLifecycle: MediaPlaceholderLifecycle | null = null;
        if (needsCanvas) {
          targetNodeId = store.createMediaPlaceholder(intent);
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
          );
          if (context.signal.aborted) {
            throw new DOMException('请求已取消', 'AbortError');
          }
          const currentStore = useAppStore.getState();
          const nodeCreated = placeholderLifecycle
            ? settleMediaPlaceholderLifecycle(placeholderLifecycle, result)
            : targetNodeId ? currentStore.settleMediaPlaceholder(targetNodeId, result) : false;
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
          return {
            status: 'success',
            summary: '媒体内容已生成',
            modelContent: JSON.stringify({
              artifactId: result.id,
              kind: result.kind,
              audioPurpose: result.audioPurpose,
              deliveryMode: result.deliveryMode,
              canvasNodeId: targetNodeId,
            }),
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
