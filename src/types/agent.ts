/**
 * Agent 领域类型。
 *
 * 本文件只描述可持久化的任务状态，不包含 AbortController、窗口句柄等运行时对象。
 */

export type AgentMode = 'collaborative' | 'autonomous';

export type AgentTaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_tool'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped';

export type AgentStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'stopped';

export type AgentStepKind =
  | 'planning'
  | 'tool'
  | 'approval'
  | 'observation'
  | 'response';

export type AgentApprovalKind =
  | 'canvas_write'
  | 'file_write'
  | 'permanent_delete'
  | 'media_generation'
  | 'memory_write';

export type AgentApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired';

export interface AgentTaskBudget {
  maxModelRounds: number;
  maxToolCalls: number;
  maxParallelReadTools: number;
  maxReadRetries: number;
}

export const DEFAULT_AGENT_TASK_BUDGET: AgentTaskBudget = {
  maxModelRounds: 12,
  maxToolCalls: 24,
  maxParallelReadTools: 3,
  maxReadRetries: 3,
};

export interface AgentToolCallSnapshot {
  callId: string;
  toolId: string;
  inputSummary?: string;
  retryCount: number;
  startedAt?: number;
  finishedAt?: number;
  resultSummary?: string;
  errorCode?: string;
}

export interface AgentApprovalInputRequest {
  kind: 'media_model';
  mediaKind: 'image' | 'video' | 'audio';
  selectedModelRef?: string;
}

export interface AgentApprovalInputValues {
  modelRef?: string;
}

export interface AgentApprovalResolution {
  approved: boolean;
  inputValues?: AgentApprovalInputValues;
}

export interface AgentApprovalSnapshot {
  id: string;
  kind: AgentApprovalKind;
  status: AgentApprovalStatus;
  summary: string;
  requestedAt: number;
  resolvedAt?: number;
  inputRequest?: AgentApprovalInputRequest;
}

export interface AgentStep {
  id: string;
  taskId: string;
  index: number;
  kind: AgentStepKind;
  title: string;
  status: AgentStepStatus;
  createdAt: number;
  updatedAt: number;
  toolCall?: AgentToolCallSnapshot;
  approval?: AgentApprovalSnapshot;
  outputSummary?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface AgentTask {
  id: string;
  projectId: string;
  conversationId: string;
  userMessageId: string;
  mode: AgentMode;
  goal: string;
  status: AgentTaskStatus;
  steps: AgentStep[];
  currentStepId?: string;
  modelRounds: number;
  toolCallCount: number;
  budget: AgentTaskBudget;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  pausedReason?: string;
  errorCode?: string;
  errorMessage?: string;
}

export const AGENT_TERMINAL_STATUSES = new Set<AgentTaskStatus>([
  'completed',
  'failed',
  'stopped',
]);

export const AGENT_RESTART_PAUSE_STATUSES = new Set<AgentTaskStatus>([
  'queued',
  'planning',
  'running',
  'waiting_tool',
  'waiting_approval',
]);
