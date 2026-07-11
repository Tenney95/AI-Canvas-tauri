/**
 * Chat 类型定义 — 对话助手相关的 CommandId、Selector AST、CommandIntent、
 * CommandPlan、CommandResult、ChatMessage、ChatConversation 等核心类型
 */

import type { NodeType } from './index';

// ============================================
// 命令 ID
// ============================================

export type CommandId =
  | 'query'
  | 'select'
  | 'deleteNodes'
  | 'undo'
  | 'redo'
  | 'connect'
  | 'groupByType'
  | 'translatePrompt'
  | 'regenerate'
  | 'describe'
  | 'cancelTask';

// ============================================
// Selector AST — 目标选择器
// ============================================

export type NodeSelector =
  | { op: 'selected' }
  | { op: 'displayId'; value: number }
  | { op: 'type'; value: NodeType }
  | { op: 'status'; value: 'idle' | 'loading' | 'success' | 'error' }
  | { op: 'and'; items: NodeSelector[] }
  | { op: 'or'; items: NodeSelector[] }
  | { op: 'not'; item: NodeSelector };

// ============================================
// CommandIntent — AI/规则引擎产出的意图
// ============================================

export interface CommandIntent {
  commandId: CommandId;
  selector?: NodeSelector;
  params?: unknown;
  parseSource: 'rule' | 'llm';
  confidence: number;
}

// ============================================
// CommandPlan — 规划器生成的执行计划
// ============================================

export interface CommandPlan<TParams = unknown> {
  id: string;
  projectId: string;
  baseRevision: number;
  commandId: CommandId;
  targetNodeIds: string[];
  params: TParams;
  summary: string;
  risk: 'read' | 'low' | 'destructive' | 'external';
  requiresConfirm: boolean;
  externalDataDisclosure?: ExternalDataDisclosure;
}

export interface ExternalDataDisclosure {
  modelId?: string;
  providerName?: string;
  fieldsSent: string[];
  mediaSent: boolean;
  estimatedCost: string;
}

// ============================================
// CommandResult — 命令执行结果
// ============================================

export interface CommandResult {
  planId: string;
  status: 'success' | 'partial' | 'rejected' | 'failed';
  affectedNodeIds: string[];
  message: string;
  errorCode?: string;
  historyIndex?: number;
}

// ============================================
// 流事件协议
// ============================================

export type StreamPhase = 'connecting' | 'responding' | 'planning';
export type FinishReason = 'stop' | 'length' | 'canceled' | 'error';

export type AssistantStreamEvent =
  | { type: 'start'; requestId: string; modelId: string }
  | { type: 'text.delta'; delta: string }
  | { type: 'status'; phase: StreamPhase; message?: string }
  | { type: 'conversation.title'; title: string }
  | { type: 'tool.call.delta'; callId: string; delta: string }
  | { type: 'tool.call.final'; call: ProposedToolCall }
  | { type: 'tool.result'; result: ToolResultSummary }
  | { type: 'intent.final'; intents: CommandIntent[] }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'done'; finishReason: FinishReason };

// ============================================
// 工具调用（P1）
// ============================================

export interface ProposedToolCall {
  callId: string;
  toolId: string;
  input: unknown;
}

export interface ToolResultSummary {
  callId: string;
  toolId: string;
  status: 'success' | 'error' | 'denied';
  summary: string;
  truncated: boolean;
}

// ============================================
// 聊天消息状态
// ============================================

export type ChatMessageStatus =
  | 'queued'
  | 'parsing'
  | 'streaming'
  | 'clarifying'
  | 'preview'
  | 'executing'
  | 'done'
  | 'partial'
  | 'interrupted'
  | 'error'
  | 'canceled';

// ============================================
// 聊天消息
// ============================================

export interface ChatMessage {
  id: string;
  /** 所属会话 ID */
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  status: ChatMessageStatus;
  /** AI 请求 ID（assistant 消息使用） */
  requestId?: string;
  /** 使用的模型 ID */
  modelId?: string;
  /** 关联的解析指令 */
  commands?: CommandIntent[];
  /** 执行结果 */
  executionResults?: CommandResult[];
  /** 流结束原因 */
  finishReason?: FinishReason;
}

// ============================================
// 持久化消息
// ============================================

export interface PersistedChatMessage {
  id: string;
  projectId: string;
  conversationId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: ChatMessageStatus;
  requestId?: string;
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  finishReason?: FinishReason;
  commands?: CommandIntent[];
  executionResults?: CommandResult[];
}

// ============================================
// 会话
// ============================================

export interface ChatConversation {
  id: string;
  projectId: string;
  title: string;
  /** 标题来源：auto=自动生成，user=用户手动命名 */
  titleSource: 'auto' | 'user';
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number;
  /** 最近一条消息预览文本 */
  lastMessagePreview?: string;
  messageCount: number;
  /** 软删除时间戳，存在则在回收站中 */
  deletedAt?: number;
}

// ============================================
// 操作日志
// ============================================

export interface OperationLog {
  id: string;
  projectId: string;
  conversationId: string;
  timestamp: number;
  /** 命令 ID */
  commandId: CommandId;
  /** 人类可读摘要 */
  summary: string;
  /** 受影响的节点 */
  targetNodeIds: string[];
  /** 解析来源 */
  parseSource: 'rule' | 'llm';
  /** AI 请求 ID（如果有） */
  requestId?: string;
  /** 模型 ID */
  modelId?: string;
  /** 执行结果 */
  status: 'success' | 'partial' | 'failed';
  /** 对应历史索引 */
  historyIndex?: number;
  /** 是否仍可撤销 */
  undoable: boolean;
  /** 耗时毫秒 */
  duration?: number;
  /** 错误码 */
  errorCode?: string;
}

// ============================================
// 上下文脱敏
// ============================================

export interface CanvasNodeSummary {
  id: string;
  type: NodeType;
  status: 'idle' | 'loading' | 'success' | 'error';
  displayId?: number;
  selected: boolean;
}

export interface CanvasContext {
  projectId: string;
  totalNodes: number;
  totalEdges: number;
  selectedNodeIds: string[];
  nodes: CanvasNodeSummary[];
}

// ============================================
// Store revision 模式
// ============================================

/** Revision 计数模式 */
export type RevisionScope = 'project' | 'global';
