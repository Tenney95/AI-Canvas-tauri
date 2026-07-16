/**
 * assistantStream — 助手模型流式请求服务
 *
 * 封装对 OpenAI-compatible Chat Completions API 的流式调用，
 * 使用 streamParsers 解析 SSE 事件流。
 *
 * 前端通过 ChatPanel → assistantService → assistantStream 调用，
 * 流事件驱动消息状态更新。
 */
import { useAppStore } from '../../store/useAppStore';
import { buildAuthHeaders } from './httpUtils';
import { parseStream, parseNonStream } from './streamParsers';
import type { AssistantStreamEvent } from '../../types/chat';
import { findMediaModelOption } from '../../components/nodes/shared/defaultModels';

// ============================================
// Config resolution
// ============================================

interface ResolvedModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/**
 * 查找已配置的助手模型，返回 API 连接参数。
 * 返回 null 表示未配置助手模型，应回退到本地规则引擎。
 */
export function resolveAssistantModel(): ResolvedModelConfig | null {
  const config = useAppStore.getState().config;
  const assistantModelId = config.assistantModelId;

  if (!assistantModelId || !config.generalModels) return null;

  const gm = config.generalModels.find((m) => m.id === assistantModelId && m.category === 'text');
  if (!gm) {
    // 也尝试用 resolveGeneralModel
    return null;
  }

  if (!gm.openaiUrl || !gm.modelId) return null;

  return {
    baseUrl: gm.openaiUrl.replace(/\/+$/, ''),
    apiKey: gm.apiKey || '',
    modelName: gm.modelId,
  };
}

// ============================================
// Streaming call
// ============================================

export interface StreamingCallOptions {
  /** 系统提示词（画布上下文描述） */
  systemPrompt: string;
  /** 用户消息 */
  userMessage: string;
  /** 仅用于决定开放哪些工具的原始用户输入，避免 Skill 内容扩大权限。 */
  toolContextMessage?: string;
  /** 回调：每当接收到一个流事件 */
  onEvent: (event: AssistantStreamEvent) => void;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 是否使用非流式模式（某些模型不支持 stream） */
  nonStream?: boolean;
  /** Agent 多轮调用时传入完整消息序列；存在时不再自动拼接 system/user。 */
  messages?: AssistantModelMessage[];
  /** Agent Runtime 经过 Registry 过滤后的工具；空数组表示本轮禁用工具。 */
  tools?: AssistantToolDefinition[];
}

export interface AssistantModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AssistantModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: AssistantModelToolCall[];
}

export interface AssistantToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

function buildAssistantTools(userMessage: string): AssistantToolDefinition[] {
  const config = useAppStore.getState().config;
  const mentionedModelId = /@model\{([^|}\s]+)/i.exec(userMessage)?.[1];
  if (!mentionedModelId) return [];
  const mentionedModel = findMediaModelOption(mentionedModelId, config.generalModels ?? []);
  if (!mentionedModel) return [];
  const providerAvailable = mentionedModel.provider === 'general'
    || (mentionedModel.provider === 'dreamina'
      ? !!config.dreaminaAuth?.loggedIn
      : !!config.providers[mentionedModel.provider]?.apiKey);
  if (!providerAvailable) return [];

  return [{
    type: 'function',
    function: {
      name: 'media_generate',
      description: '根据用户明确要求生成图片或视频，并在当前对话中展示结果。普通问答不得调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'prompt', 'modelRef'],
        properties: {
          kind: { type: 'string', enum: [mentionedModel.mediaKind] },
          prompt: { type: 'string', minLength: 1 },
          modelRef: {
            type: 'string',
            enum: [mentionedModel.value],
            description: '必须使用用户通过 @model 显式选择的模型 ID。',
          },
          deliveryMode: {
            type: 'string',
            enum: ['chat', 'canvas', 'both'],
            default: 'chat',
            description: '仅对话=chat，仅画布=canvas，同时呈现=both。',
          },
        },
      },
    },
  }];
}

/**
 * 流式请求助手模型。
 *
 * @returns 完整响应文本
 */
export async function streamAssistantReply(options: StreamingCallOptions): Promise<string> {
  const modelConfig = resolveAssistantModel();
  if (!modelConfig) {
    throw new Error('未配置助手模型，请在「设置 → API Key」中添加');
  }

  const {
    systemPrompt,
    userMessage,
    toolContextMessage,
    onEvent,
    signal,
    nonStream,
    messages: providedMessages,
    tools: providedTools,
  } = options;

  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  onEvent({ type: 'start', requestId, modelId: modelConfig.modelName });

  const messages: AssistantModelMessage[] = providedMessages
    ? [...providedMessages]
    : [
        ...(systemPrompt
          ? [{ role: 'system' as const, content: systemPrompt }]
          : []),
        { role: 'user', content: userMessage },
      ];

  const apiUrl = modelConfig.baseUrl + '/chat/completions';
  const headers = buildAuthHeaders(modelConfig.apiKey);

  // 设置 AbortController
  const controller = new AbortController();
  const mergedSignal = signal;
  if (mergedSignal) {
    mergedSignal.addEventListener('abort', () => controller.abort());
  }
  useAppStore.getState().setActiveRequestAbort(controller);

  const tools = providedTools ?? buildAssistantTools(toolContextMessage ?? userMessage);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelConfig.modelName,
        messages,
        stream: !nonStream,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: controller.signal,
    });

    if (nonStream) {
      return await parseNonStream(response, { onEvent });
    }

    return await parseStream(response, {
      requestId,
      modelId: modelConfig.modelName,
      onEvent,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if ((error as { name?: string }).name === 'AbortError') {
      onEvent({ type: 'done', finishReason: 'canceled' });
      throw new Error('请求已取消', { cause: error });
    }
    const msg = error instanceof Error ? error.message : '未知错误';
    onEvent({ type: 'error', code: 'FETCH_ERROR', message: msg, retryable: true });
    onEvent({ type: 'done', finishReason: 'error' });
    throw error;
  } finally {
    const currentCtrl = useAppStore.getState().activeRequestAbort;
    if (currentCtrl === controller) {
      useAppStore.getState().setActiveRequestAbort(null);
    }
  }
}

// ============================================
// System prompt builder
// ============================================

/**
 * 构建媒体工具约束。媒体生成必须显式 @ 模型，不使用默认媒体模型。
 */
function buildMediaPrompt(): string {
  return [
    `你可以通过 media_generate 工具生成媒体。`,
    ``,
    `媒体工具规则:`,
    `- 只有用户明确要求生成图片或视频时才能调用 media_generate`,
    `- 用户必须显式提供 @model{模型ID|名称}；没有 @model 时提示用户选择模型，不得调用工具`,
    `- 普通聊天、画布查询、操作失败或模型配置存在都不能触发媒体工具`,
    `- kind 必须与用户要求一致，不能用图片替代视频或反之`,
    `- prompt 应保留用户语义并补全必要的画面、构图、光照或镜头细节`,
    `- 把 @model 中的模型 ID 原样写入 modelRef`,
    `- 用户说“在画布/生成节点”时 deliveryMode=canvas`,
    `- 用户说“同时放到画布/对话和画布都要”时 deliveryMode=both`,
    `- 没有明确提到画布时 deliveryMode=chat`,
    `- 每次回复最多调用一次 media_generate`,
  ].join('\n');
}

/**
 * 构建发送给 LLM 的系统提示词（含画布上下文）。
 * 脱敏：不发送 prompt/output 等隐私内容。
 */
export function buildAssistantSystemPrompt(): string {
  const store = useAppStore.getState();
  const nodes = store.nodes;

  // 统计信息
  const typeCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const nodeList: string[] = [];

  for (const n of nodes) {
    const t = n.type ?? 'unknown';
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);

    const data = n.data as { status?: string; displayId?: number; label?: string };
    const s = data.status || 'idle';
    statusCounts.set(s, (statusCounts.get(s) || 0) + 1);

    nodeList.push(
      `  #${data.displayId ?? '?'} (${t}) [${s}]${data.label ? ` "${data.label}"` : ''}`,
    );
  }

  const context = [
    `AI Canvas 画布助手`,
    `项目: ${store.currentProjectId ?? 'unknown'}`,
    `节点总数: ${nodes.length} | 连线: ${store.edges.length}`,
    `选中节点: ${store.selectedNodeIds.length > 0 ? store.selectedNodeIds.join(', ') : '无'}`,
    ``,
    `类型分布: ${[...typeCounts.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`,
    `状态分布: ${[...statusCounts.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`,
    ``,
    `节点列表:`,
    ...nodeList.slice(0, 30),
    nodeList.length > 30 ? `  ... 共 ${nodes.length} 个节点` : '',
    ``,
    `你可以执行以下操作:`,
    `- query: 查询节点状态和画布概况`,
    `- select: 选中节点（按编号/类型/状态）`,
    `- deleteNodes: 删除节点（需返回完整的 commandId + selector）`,
    `- undo: 撤销上一步`,
    `- redo: 重做`,
    `- 用户可用 @{nodeId:label} 引用当前画布节点`,
    `- 生成媒体工具的 prompt 必须原样保留所有 @{nodeId:label}，由本地 Runtime 解析节点内容`,
    `- 不要编造、改写或删除节点引用中的 nodeId`,
    ``,
    `selector 格式（必须严格使用以下 op）:`,
    `- 按编号: { "op": "displayId", "value": 24 }`,
    `- 按类型: { "op": "type", "value": "ai-video" }`,
    `- 按状态: { "op": "status", "value": "error" }`,
    `禁止使用 byType / byStatus / byDisplayId。`,
    ``,
    `回复格式: 先简短回复用户（1-2 句），如果你识别到操作指令，在回复末尾附加一个 JSON 块:`,
    `` + '```intent',
    `{ "commandId": "...", "selector": { "op": "...", ... }, "params": {} }`,
    '```',
    ``,
    `注意: 删除操作需用户确认后才执行。`,
    ``,
    buildMediaPrompt(),
  ].join('\n');

  return context;
}
