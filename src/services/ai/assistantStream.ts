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
import { resolveGeneralModel } from './helpers';
import { buildAuthHeaders } from './httpUtils';
import { parseStream, parseNonStream } from './streamParsers';
import type { AssistantStreamEvent } from '../../types/chat';

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
  /** 回调：每当接收到一个流事件 */
  onEvent: (event: AssistantStreamEvent) => void;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 是否使用非流式模式（某些模型不支持 stream） */
  nonStream?: boolean;
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

  const { systemPrompt, userMessage, onEvent, signal, nonStream } = options;

  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  onEvent({ type: 'start', requestId, modelId: modelConfig.modelName });

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userMessage });

  const apiUrl = modelConfig.baseUrl + '/chat/completions';
  const headers = buildAuthHeaders(modelConfig.apiKey);

  // 设置 AbortController
  const controller = new AbortController();
  const mergedSignal = signal;
  if (mergedSignal) {
    mergedSignal.addEventListener('abort', () => controller.abort());
  }
  useAppStore.getState().setActiveRequestAbort(controller);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelConfig.modelName,
        messages,
        stream: !nonStream,
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
      throw new Error('请求已取消');
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
    ``,
    `回复格式: 先简短回复用户（1-2 句），如果你识别到操作指令，在回复末尾附加一个 JSON 块:`,
    `` + '```intent',
    `{ "commandId": "...", "selector": { "op": "...", ... }, "params": {} }`,
    '```',
    ``,
    `注意: 删除操作需用户确认后才执行。`,
  ].join('\n');

  return context;
}
