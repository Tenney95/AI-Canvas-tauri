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
import { projectMemoryOwnerId } from '../../store/store.utils';
import {
  getConfiguredModelGroups,
  resolveTextModelContextSpec,
  type TextModelContextSpec,
} from '../../components/nodes/shared/defaultModels';
import { loadMessages } from './chatHistoryService';
import { compressConversationContext } from './contextCompressionService';
import type { AssistantModelMessage } from '../ai/assistantStream';
import type {
  ChatMessage,
  ConversationContextSummary,
} from '../../types/chat';
import type { GeneralModelConfig } from '../../types';
import {
  PROJECT_MEMORY_KIND_LABELS,
  type ProjectMemory,
} from '../../types/memory';
import { rankProjectMemories } from './memoryRetrieval';
import { buildLearnedPromptContext } from './promptLearningService';
import { estimateTokens } from './tokenEstimate';
import { getAssistantTextModelCandidates } from '../projectSettingsService';
import { findHistoryCutIndex, historyMessageContent, messageContentWithSources } from './contextTranscript';

export { estimateTokens };
export { messageContentWithSources };

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

/** 每条消息的结构开销（role、分隔符等）估算值 */
const PER_MESSAGE_OVERHEAD = 8;

/** 估算一组模型消息（含 tool_calls / tool 结果）的 token 数。 */
export function estimateModelMessagesTokens(messages: AssistantModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateTokens(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    );
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
export function resolveAssistantContextSpec(projectId?: string, modelId?: string): AssistantContextSpec {
  const state = useAppStore.getState();
  const config = state.config;
  const project = state.projects.find((item) => item.id === (projectId ?? state.currentProjectId));
  const candidates = modelId !== undefined ? [modelId] : getAssistantTextModelCandidates(
    project?.settings,
    config.assistantModelId,
  );
  const configuredModels = getConfiguredModelGroups(config, 'ai-text')
    .flatMap((group) => group.models);
  for (const candidate of candidates) {
    const selectedModelId = candidate.replace(/^general\//, '');
    const generalModel = config.generalModels?.find(
      (item) => item.id === selectedModelId && item.category === 'text',
    );
    if (generalModel) return toAssistantContextSpec(generalModel);
    const configuredModel = configuredModels.find((item) => item.value === candidate);
    if (configuredModel) {
      return toAssistantContextSpec({ modelId: configuredModel.value, name: configuredModel.label });
    }
  }
  return toAssistantContextSpec(null);
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

type UsageMessage = Pick<ChatMessage, 'role' | 'content' | 'status' | 'timestamp' | 'sources'>;

// 消息离开内存后缓存也会释放；只缓存这条消息的贡献，摘要和模型预算仍按本次参数计算。
const conversationUsageCache = new WeakMap<UsageMessage, {
  content: string;
  sources: Pick<NonNullable<UsageMessage['sources']>[number], 'citationId' | 'title' | 'url'>[];
  tokens: number;
}>();

function estimateUsageMessageTokens(message: UsageMessage): number {
  const cached = conversationUsageCache.get(message);
  const sources = message.sources;
  // 来源可能在原数组里补齐，比较实际参与拼接的字段，不只比较数组引用。
  if (cached?.content === message.content && cached.sources.length === (sources?.length ?? 0)
    && cached.sources.every((source, index) => source.citationId === sources![index].citationId
      && source.title === sources![index].title && source.url === sources![index].url)) {
    return cached.tokens;
  }
  const tokens = PER_MESSAGE_OVERHEAD + estimateTokens(messageContentWithSources(message));
  conversationUsageCache.set(message, {
    content: message.content,
    sources: sources?.map(({ citationId, title, url }) => ({ citationId, title, url })) ?? [],
    tokens,
  });
  return tokens;
}

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
    estimatedTokens += estimateUsageMessageTokens(message);
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
// 项目记忆注入
// ============================================

/** 记忆块的 token 预算上限（估算），避免记忆挤占对话历史。 */
const MEMORY_BLOCK_TOKEN_BUDGET = 1_500;

/**
 * 选择要注入上下文的已启用项目记忆。
 * 按类别优先级（约束/决定/偏好/事实）再按更新时间排序，累计不超过 token 预算。
 *
 * ponytail: 相关性用"类别优先级 + recency + token 预算"近似；
 * 若记忆量增大需要按当前对话主题做语义检索，再引入向量或关键词打分。
 */
export function selectProjectMemoriesForContext(
  memories: ProjectMemory[],
  projectId: string,
  query = '',
): ProjectMemory[] {
  const enabled = rankProjectMemories(memories, projectId, query);

  const selected: ProjectMemory[] = [];
  let tokens = 0;
  for (const memory of enabled) {
    const cost = PER_MESSAGE_OVERHEAD + estimateTokens(memory.content);
    if (tokens + cost > MEMORY_BLOCK_TOKEN_BUDGET) break;
    selected.push(memory);
    tokens += cost;
  }
  return selected;
}

/** 构建项目记忆系统消息；无启用记忆时返回空字符串。 */
function buildMemoryBlock(projectId: string, query: string): string {
  const state = useAppStore.getState();
  const memories = selectProjectMemoriesForContext(
    state.projectMemories,
    // 记忆整部剧共用，挂在剧集项目上
    projectMemoryOwnerId(state.projects, projectId),
    query,
  );
  if (memories.length === 0) return '';
  const lines = memories.map(
    (memory) => `- [${PROJECT_MEMORY_KIND_LABELS[memory.kind]}] ${memory.content}`,
  );
  return [
    '以下是用户已确认的项目长期记忆（可信，应主动遵守；如与用户当前消息冲突，以当前消息为准）：',
    ...lines,
  ].join('\n');
}

// ============================================
// Agent 上下文组装
// ============================================

export interface AssembleAgentContextOptions {
  /** 本次执行段冻结的运行时前提；不进入消息/摘要持久化。 */
  assertCurrent?: () => void;
  conversationId: string;
  /** 当前项目 ID；用于注入项目记忆 */
  projectId?: string;
  /** 工作台会话保留本会话历史，但不注入项目记忆和提示词学习样本。 */
  includeProjectContext?: boolean;
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
    && ['done', 'partial', 'clarifying', 'preview'].includes(message.status)
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
  memoryBlock: string,
  summary: ConversationContextSummary | undefined,
  history: ChatMessage[],
  userMessage: string,
  inputBudget: number,
): BuildResult {
  const systemTokens = systemPrompt
    ? PER_MESSAGE_OVERHEAD + estimateTokens(systemPrompt)
    : 0;
  const memoryTokens = memoryBlock
    ? PER_MESSAGE_OVERHEAD + estimateTokens(memoryBlock)
    : 0;
  const summaryContent = summary
    ? `以下是本会话更早对话的压缩摘要（原始历史仍保留在本地，仅上下文使用摘要）：\n${summary.text}`
    : '';
  const summaryTokens = summaryContent
    ? PER_MESSAGE_OVERHEAD + estimateTokens(summaryContent)
    : 0;
  const userTokens = PER_MESSAGE_OVERHEAD + estimateTokens(userMessage);
  const fixedTokens = systemTokens + memoryTokens + summaryTokens + userTokens;

  // 按完整轮次保留连续的最近历史，不跳过大消息后再塞入更早的小消息。
  let historyTokens = 0;
  const costs = history.map((message) => PER_MESSAGE_OVERHEAD + estimateTokens(message.content));
  const rawHistoryTokens = costs.reduce((sum, cost) => sum + cost, 0);
  let firstIncluded = history.length;
  while (firstIncluded > 0) {
    const start = findHistoryCutIndex(history.slice(0, firstIncluded), 1);
    const tokens = costs.slice(start, firstIncluded).reduce((sum, cost) => sum + cost, 0);
    if (fixedTokens + historyTokens + tokens > inputBudget) break;
    historyTokens += tokens;
    firstIncluded = start;
  }
  const included = history.slice(firstIncluded);

  const messages: AssistantModelMessage[] = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...(memoryBlock ? [{ role: 'system' as const, content: memoryBlock }] : []),
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
  const { conversationId, projectId, systemPrompt, userMessage, signal } = options;
  options.assertCurrent?.();
  const excludeIds = new Set(options.excludeMessageIds ?? []);
  const spec = resolveAssistantContextSpec(projectId);
  // 对话历史与提示词样本互不依赖，并行读取可避免给每轮 Agent 响应叠加串行存储延迟。
  const [persistedResult, learnedPromptBlock] = await Promise.all([
    loadMessages(conversationId, 0, 200),
    projectId && options.includeProjectContext !== false ? buildLearnedPromptContext(projectId, userMessage) : Promise.resolve(''),
  ]);
  options.assertCurrent?.();
  // 学习样本复用记忆块的预算入口，使后续裁剪和压缩仍由统一上下文预算控制。
  const memoryBlock = [
    projectId && options.includeProjectContext !== false ? buildMemoryBlock(projectId, userMessage) : '',
    learnedPromptBlock,
  ].filter(Boolean).join('\n\n');

  const tasks = useAppStore.getState().agentTasks.filter((task) =>
    task.conversationId === conversationId && task.projectId === projectId);
  // 上一轮可能仍在节流落盘；同会话的最新内存消息也要进入追问上下文。
  const persisted = [...new Map([
    ...persistedResult.messages.filter((message) => message.conversationId === conversationId),
    ...useAppStore.getState().messages.filter((message) => message.conversationId === conversationId),
  ].map((message) => [message.id, message])).values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((message) => ({
      ...message,
      content: historyMessageContent(message, tasks.find((task) => task.id === message.agentTaskId)),
    }));
  let summary = getConversationSummary(conversationId);
  let history = selectHistoryMessages(persisted, excludeIds, summary);
  let result = buildMessages(systemPrompt, memoryBlock, summary, history, userMessage, spec.inputBudget);
  let forcedCompression = false;

  const rawRatio = result.rawEstimatedTokens / spec.inputBudget;
  if (rawRatio >= FORCE_COMPRESS_RATIO) {
    // 请求前强制压缩：失败时不发送超限请求，由调用方暂停任务
    try {
      const compressed = await compressConversationContext(conversationId, {
        projectId,
        excludeMessageIds: options.excludeMessageIds,
        signal,
        assertCurrent: options.assertCurrent,
      });
      options.assertCurrent?.();
      if (compressed) {
        forcedCompression = true;
        summary = compressed;
        history = selectHistoryMessages(persisted, excludeIds, summary);
        result = buildMessages(systemPrompt, memoryBlock, summary, history, userMessage, spec.inputBudget);
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
      projectId,
      excludeMessageIds: options.excludeMessageIds,
      assertCurrent: options.assertCurrent,
    }).catch(() => { /* 预压缩失败不影响本次请求，下次达到 90% 时再强制压缩 */ });
  }

  // 系统规则 + 记忆 + 摘要 + 用户消息本身超出预算：无法继续压缩，拒绝发送
  const fixedOnly = buildMessages(systemPrompt, memoryBlock, summary, [], userMessage, spec.inputBudget);
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
