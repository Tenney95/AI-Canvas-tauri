import { useAppStore } from '../../../store/useAppStore';
import type {
  AudioGenerationPurpose,
  MediaDeliveryMode,
  MediaGenerationIntent,
  MediaKind,
} from '../../../types/media';
import {
  extractModelMention,
  runMediaGeneration,
} from '../../ai/generationRuntime';
import {
  registerAgentTool,
  type AgentToolExecutionResult,
} from '../toolRegistry';

interface GenerateMediaInput {
  kind: MediaKind;
  prompt: string;
  modelRef: string;
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
        '使用用户本轮通过 @model 明确选择的模型生成图片、视频、音乐或语音。',
        '每次调用都会向用户确认。deliveryMode 控制结果显示在对话、画布或两者。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['kind', 'prompt', 'modelRef', 'deliveryMode'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          prompt: { type: 'string', minLength: 1, maxLength: 12000 },
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
        if (!mentionedModel || mentionedModel !== input.modelRef) {
          return {
            allowed: false,
            reason: '媒体模型必须由用户在本轮消息中通过 @model 明确选择',
          };
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
        return `使用 ${input.modelRef} 生成${label}，输出到${
          input.deliveryMode === 'chat'
            ? '对话'
            : input.deliveryMode === 'canvas'
              ? '画布'
              : '对话和画布'
        }`;
      },
      execute: async (context, input): Promise<AgentToolExecutionResult> => {
        const store = useAppStore.getState();
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
        if (needsCanvas) targetNodeId = store.createMediaPlaceholder(intent);
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
          const nodeCreated = targetNodeId
            ? currentStore.settleMediaPlaceholder(targetNodeId, result)
            : false;
          currentStore.updateMessage(assistantMessageId, {
            mediaResult: result,
            mediaStatus: 'succeeded',
            mediaError: undefined,
            canvasStatus: targetNodeId ? (nodeCreated ? 'created' : 'failed') : 'none',
            canvasNodeId: targetNodeId,
            canvasError: targetNodeId && !nodeCreated
              ? '生成期间占位节点已被删除'
              : undefined,
          });
          if (targetNodeId) currentStore.incrementRevision();
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
          const message = error instanceof Error ? error.message : '未知错误';
          const currentStore = useAppStore.getState();
          if (targetNodeId) currentStore.failMediaPlaceholder(targetNodeId, message);
          currentStore.updateMessage(assistantMessageId, {
            mediaStatus: 'failed',
            mediaError: message,
            canvasStatus: targetNodeId ? 'failed' : 'none',
            canvasNodeId: targetNodeId,
            canvasError: targetNodeId ? message : undefined,
          });
          return {
            status: 'error',
            summary: `媒体生成失败：${message}`,
            modelContent: `媒体生成失败：${message}`,
            errorCode: 'AGENT_MEDIA_GENERATION_FAILED',
          };
        }
      },
    }),
  ];
}
