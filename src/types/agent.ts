/**
 * Agent 领域类型。
 *
 * 本文件只描述可持久化的任务状态，不包含 AbortController、窗口句柄等运行时对象。
 */

export type AgentMode = 'collaborative' | 'autonomous' | 'plan';

export const AGENT_EXPERT_ROLES = [
  'canvas_structure',
  'workflow_risk',
  'asset_reuse',
] as const;

export type AgentExpertRole = typeof AGENT_EXPERT_ROLES[number];

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
  | 'memory_write'
  | 'config_write';

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

export interface AgentTaskMetrics {
  inputTokens: number;
  outputTokens: number;
  modelDurationMs: number;
  toolDurationMs: number;
  policyAllowed: number;
  policyDenied: number;
  approvalCount: number;
  retryCount: number;
  interjectionCount: number;
}

export const DEFAULT_AGENT_TASK_METRICS: AgentTaskMetrics = {
  inputTokens: 0,
  outputTokens: 0,
  modelDurationMs: 0,
  toolDurationMs: 0,
  policyAllowed: 0,
  policyDenied: 0,
  approvalCount: 0,
  retryCount: 0,
  interjectionCount: 0,
};

export type AgentEventType =
  | 'task_queued'
  | 'task_status'
  | 'model_round_start'
  | 'model_round_end'
  | 'interjection_applied'
  | 'tool_proposed'
  | 'policy_decision'
  | 'approval_resolved'
  | 'tool_start'
  | 'tool_end'
  | 'canvas_checkpoint'
  | 'canvas_rewind';

export interface AgentEventData {
  status?: AgentTaskStatus | AgentStepStatus;
  toolId?: string;
  callId?: string;
  effect?: AgentApprovalKind | 'read';
  decision?: 'allow' | 'deny' | 'require_approval';
  approved?: boolean;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  retryCount?: number;
  revisionBefore?: number;
  revisionAfter?: number;
  historyIndexBefore?: number;
  historyIndexAfter?: number;
  interjectionId?: string;
}

export interface AgentEvent {
  id: string;
  taskId: string;
  sequence: number;
  type: AgentEventType;
  timestamp: number;
  data?: AgentEventData;
}

export interface AgentCanvasCheckpoint {
  revisionBefore: number;
  revisionAfter: number;
  historyIndexBefore: number;
  historyIndexAfter: number;
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
  effect?: AgentApprovalKind | 'read';
  inputFingerprint?: string;
  canvasCheckpoint?: AgentCanvasCheckpoint;
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
  /** 任务创建时由用户显式引用的 Skill 计算，只能缩小 Registry 可见集合。 */
  toolAllowlist?: string[];
  /** 只读专家任务的父任务；存在时嵌套深度固定为 1。 */
  parentTaskId?: string;
  expertRole?: AgentExpertRole;
  expertDepth?: 1;
  resultSummary?: string;
  events?: AgentEvent[];
  metrics?: AgentTaskMetrics;
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
