/**
 * contextManager — 模型上下文预算与组装（P3-D1）
 *
 * 职责：
 * 1. token 估算（无精确 tokenizer，所有数值均为估算口径）
 * 2. 按当前助手模型的上下文窗口组装 Agent 请求消息：
 *    系统规则（含画布引用）→ 历史摘要 → 最近消息 → 当前用户消息
 * 3. 约 75% 时触发后台预压缩，约 90% 时请求前强制压缩；
 *    压缩失败时抛出 ContextBudgetError，由调用方暂停任务
 *
 * 只影响发送给模型的上下文，不修改、不删除原始消息历史。
 */
import { useAppStore } from '../../store/useAppStore';
import { resolveTextModelContextSpec, type TextModelContextSpec } from '../../components/nodes/shared/defaultModels';
import { loadMessages } from './chatHistoryService';
import { compressConversationContext } from './contextCompressionService';
import type { AssistantModelMessage } from '../ai/assistantStream';
import type {
  ChatMessage,
  ConversationContextSummary,
} from '../../types/chat';
import type { GeneralModelConfig } from '../../types';

// ============================================
// 阈值
// ============================================

/** 达到输入预算的该比例时，后台预压缩 */
export const PRECOMPRESS_RATIO = 0.75;
/** 达到输入预算的该比例时，请求前强制压缩 */
export const FORCE_COMPRESS_RATIO = 0.9;

export class ContextBudgetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContextBudgetError';
    this.code = code;
  }
}

// ============================================
// token 估算
// ============================================

const CJK_PATTERN = /[⺀-鿿豈-﫿＀-￯]/g;

/**
 * 估算文本 token 数。
 * CJK 字符按 1 token/字，其余按 4 字符/token。仅用于预算判断，非精确值。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  return Math.ceil(cjkCount + (text.length - cjkCount) / 4);
}

/** 每条消息的结构开销（role、分隔符等）估算值 */
const PER_MESSAGE_OVERHEAD = 8;

/** 估算一组模型消息（含 tool_calls / tool 结果）的 token 数。 */
export function estimateModelMessagesTokens(messages: AssistantModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateTokens(message.content);
    if (message.tool_calls) {
      total += estimateTokens(JSON.stringify(message.tool_calls));
    }
  }
  return total;
}

// ============================================
// 模型规格
// ============================================

export interface AssistantContextSpec extends TextModelContextSpec {
  /** 输入预算 = 上下文窗口 - 建议输出预算 */
  inputBudget: number;
  modelName?: string;
}

/** 解析当前配置的助手文本模型的上下文规格；未配置时返回保守默认规格。 */
export function resolveAssistantContextSpec(): AssistantContextSpec {
  const config = useAppStore.getState().config;
  const model = config.generalModels?.find(
    (item) => item.id === config.assistantModelId && item.category === 'text',
  );
  return toAssistantContextSpec(model ?? null);
}

function toAssistantContextSpec(
  model: Pick<GeneralModelConfig, 'modelId' | 'contextWindow' | 'name'> | null,
): AssistantContextSpec {
  const spec = resolveTextModelContextSpec(model);
  return {
    ...spec,
    inputBudget: spec.contextWindow - spec.outputBudget,
    modelName: model?.name,
  };
}

// ============================================
// 占用统计（UI 指示器）
// ============================================

export interface ContextUsageStat {
  /** 当前会话估算占用 token */
  estimatedTokens: number;
  contextWindow: number;
  inputBudget: number;
  /** estimatedTokens / inputBudget，可能大于 1 */
  ratio: number;
  /** 窗口来源：declared / catalog / default */
  source: AssistantContextSpec['source'];
  modelName?: string;
}

/** 系统规则 + 画布引用的固定开销估算值（UI 指示器用，实际组装时按真实文本计算） */
const SYSTEM_PROMPT_OVERHEAD_ESTIMATE = 1_200;

type UsageMessage = Pick<ChatMessage, 'role' | 'content' | 'status' | 'timestamp'>;

/**
 * 估算会话上下文占用（用于头部指示器）。
 * 被摘要覆盖的消息按摘要 token 计，之后的消息按原文计。
 */
export function estimateConversationUsage(
  messages: UsageMessage[],
  contextSummary: ConversationContextSummary | undefined,
  model: Pick<GeneralModelConfig, 'modelId' | 'contextWindow' | 'name'> | null | undefined,
): ContextUsageStat {
  const spec = toAssistantContextSpec(model ?? null);
  let estimatedTokens = SYSTEM_PROMPT_OVERHEAD_ESTIMATE;
  if (contextSummary) estimatedTokens += contextSummary.estimatedTokens + PER_MESSAGE_OVERHEAD;
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (!message.content) continue;
    if (contextSummary && message.timestamp <= contextSummary.coveredUntilTimestamp) continue;
    estimatedTokens += PER_MESSAGE_OVERHEAD + estimateTokens(message.content);
  }
  return {
    estimatedTokens,
    contextWindow: spec.contextWindow,
    inputBudget: spec.inputBudget,
    ratio: spec.inputBudget > 0 ? estimatedTokens / spec.inputBudget : 1,
    source: spec.source,
    modelName: spec.modelName,
  };
}

// ============================================
// Agent 上下文组装
// ============================================

export interface AssembleAgentContextOptions {
  conversationId: string;
  systemPrompt: string;
  userMessage: string;
  /** 当前轮已在界面新建的消息（当前用户消息、助手占位），从历史中排除 */
  excludeMessageIds?: string[];
  signal?: AbortSignal;
}

export interface AssembledAgentContext {
  messages: AssistantModelMessage[];
  usage: ContextUsageStat;
  /** 本次组装是否执行了强制压缩 */
  forcedCompression: boolean;
}

/** 参与上下文的历史消息：用户/助手原文，排除错误、中断和当前轮消息。 */
function selectHistoryMessages(
  messages: ChatMessage[],
  excludeIds: Set<string>,
  summary: ConversationContextSummary | undefined,
): ChatMessage[] {
  return messages.filter((message) =>
    (message.role === 'user' || message.role === 'assistant')
    && !!message.content
    && !excludeIds.has(message.id)
    && !['error', 'interrupted', 'canceled'].includes(message.status)
    && (!summary || message.timestamp > summary.coveredUntilTimestamp));
}

function getConversationSummary(conversationId: string): ConversationContextSummary | undefined {
  return useAppStore.getState().conversations.find(
    (conversation) => conversation.id === conversationId,
  )?.contextSummary;
}

interface BuildResult {
  messages: AssistantModelMessage[];
  estimatedTokens: number;
  /** 全部候选历史都纳入时的估算 token（未裁剪口径，用于触发压缩） */
  rawEstimatedTokens: number;
  droppedHistoryCount: number;
}

function buildMessages(
  systemPrompt: string,
  summary: ConversationContextSummary | undefined,
  history: ChatMessage[],
  userMessage: string,
  inputBudget: number,
): BuildResult {
  const systemTokens = systemPrompt
    ? PER_MESSAGE_OVERHEAD + estimateTokens(systemPrompt)
    : 0;
  const summaryContent = summary
    ? `以下是本会话更早对话的压缩摘要（原始历史仍保留在本地，仅上下文使用摘要）：\n${summary.text}`
    : '';
  const summaryTokens = summaryContent
    ? PER_MESSAGE_OVERHEAD + estimateTokens(summaryContent)
    : 0;
  const userTokens = PER_MESSAGE_OVERHEAD + estimateTokens(userMessage);
  const fixedTokens = systemTokens + summaryTokens + userTokens;

  // 最新消息优先，从新到旧填充预算
  const included: ChatMessage[] = [];
  let historyTokens = 0;
  let rawHistoryTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = PER_MESSAGE_OVERHEAD + estimateTokens(history[i].content);
    rawHistoryTokens += tokens;
    if (fixedTokens + historyTokens + tokens <= inputBudget) {
      included.unshift(history[i]);
      historyTokens += tokens;
    }
  }

  const messages: AssistantModelMessage[] = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...(summaryContent ? [{ role: 'system' as const, content: summaryContent }] : []),
    ...included.map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    })),
    { role: 'user' as const, content: userMessage },
  ];

  return {
    messages,
    estimatedTokens: fixedTokens + historyTokens,
    rawEstimatedTokens: fixedTokens + rawHistoryTokens,
    droppedHistoryCount: history.length - included.length,
  };
}

/**
 * 组装一次 Agent 请求的完整消息序列。
 *
 * - 未超过 75%：直接返回全量历史
 * - 75% ~ 90%：返回当前组装结果，同时后台预压缩
 * - 超过 90%：先强制压缩再组装；压缩失败抛 ContextBudgetError
 * - 最新用户消息永不截断；容纳不下时抛 ContextBudgetError
 */
export async function assembleAgentContext(
  options: AssembleAgentContextOptions,
): Promise<AssembledAgentContext> {
  const { conversationId, systemPrompt, userMessage, signal } = options;
  const excludeIds = new Set(options.excludeMessageIds ?? []);
  const spec = resolveAssistantContextSpec();

  const { messages: persisted } = await loadMessages(conversationId, 0, 200);
  let summary = getConversationSummary(conversationId);
  let history = selectHistoryMessages(persisted, excludeIds, summary);
  let result = buildMessages(systemPrompt, summary, history, userMessage, spec.inputBudget);
  let forcedCompression = false;

  const rawRatio = result.rawEstimatedTokens / spec.inputBudget;
  if (rawRatio >= FORCE_COMPRESS_RATIO) {
    // 请求前强制压缩：失败时不发送超限请求，由调用方暂停任务
    try {
      const compressed = await compressConversationContext(conversationId, {
        excludeMessageIds: options.excludeMessageIds,
        signal,
      });
      if (compressed) {
        forcedCompression = true;
        summary = compressed;
        history = selectHistoryMessages(persisted, excludeIds, summary);
        result = buildMessages(systemPrompt, summary, history, userMessage, spec.inputBudget);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ContextBudgetError(
        'CONTEXT_COMPRESSION_FAILED',
        `上下文接近模型上限且压缩失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
  } else if (rawRatio >= PRECOMPRESS_RATIO) {
    // 后台预压缩，不阻塞本次请求
    void compressConversationContext(conversationId, {
      excludeMessageIds: options.excludeMessageIds,
    }).catch(() => { /* 预压缩失败不影响本次请求，下次达到 90% 时再强制压缩 */ });
  }

  // 系统规则 + 摘要 + 用户消息本身超出预算：无法继续压缩，拒绝发送
  const fixedOnly = buildMessages(systemPrompt, summary, [], userMessage, spec.inputBudget);
  if (fixedOnly.estimatedTokens > spec.inputBudget) {
    throw new ContextBudgetError(
      'CONTEXT_INPUT_TOO_LARGE',
      `当前消息与系统上下文估算约 ${fixedOnly.estimatedTokens} token，超过模型输入预算 ${spec.inputBudget}，请精简消息或更换更大上下文的模型`,
    );
  }

  return {
    messages: result.messages,
    usage: {
      estimatedTokens: result.estimatedTokens,
      contextWindow: spec.contextWindow,
      inputBudget: spec.inputBudget,
      ratio: spec.inputBudget > 0 ? result.estimatedTokens / spec.inputBudget : 1,
      source: spec.source,
      modelName: spec.modelName,
    },
    forcedCompression,
  };
}
