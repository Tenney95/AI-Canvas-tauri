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
  | 'user_choice'
  | 'canvas_write'
  | 'file_write'
  | 'permanent_delete'
  | 'media_generation'
  | 'memory_write'
  | 'config_write'
  | 'asset_write';

export type AgentApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired';

/**
 * 任务终身上限：跨全部执行段（含每次「继续」与「重新规划」）累计。
 * 单段预算每次继续都会重新放宽，只有这层上限能约束任务的总成本。
 * 本改动之前持久化的任务不带这些字段，读取时用 resolveAgentLifetimeBudget 回退到默认值。
 */
export interface AgentTaskLifetimeBudget {
  maxTotalModelRounds: number;
  maxTotalToolCalls: number;
  /** 累计 input + output token 上限 */
  maxTotalTokens: number;
  /** 最大继续（含重新规划）次数 */
  maxResumes: number;
}

/** 单段执行预算；终身上限见 AgentTaskLifetimeBudget。 */
export interface AgentTaskBudget extends Partial<AgentTaskLifetimeBudget> {
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

export const DEFAULT_AGENT_TASK_BUDGET: AgentTaskBudget & AgentTaskLifetimeBudget = {
  maxModelRounds: 12,
  maxToolCalls: 24,
  maxParallelReadTools: 3,
  maxReadRetries: 3,
  maxTotalModelRounds: 60,
  maxTotalToolCalls: 120,
  maxTotalTokens: 1_500_000,
  maxResumes: 8,
};

export type AgentToolDisplayValue = string | number | boolean;

export interface AgentToolDisplayField {
  label: string;
  value: AgentToolDisplayValue;
  source?: 'user' | 'project_default' | 'model_default' | 'resolved';
}

export interface AgentToolDisplayReference {
  kind: 'node' | 'asset';
  id: string;
  label: string;
  mediaKind?: 'image' | 'video' | 'audio';
}

export interface AgentToolDisplayEntity {
  id?: string;
  title: string;
  subtitle?: string;
  fields?: AgentToolDisplayField[];
  preview?: string;
}

export interface AgentToolDisplayChange {
  targetId: string;
  targetLabel?: string;
  field: string;
  before?: AgentToolDisplayValue;
  after?: AgentToolDisplayValue;
}

/** 面向用户的脱敏工具快照；禁止保存原始任意 JSON、密钥、路径或媒体 URL。 */
export interface AgentToolDisplaySnapshot {
  fields?: AgentToolDisplayField[];
  references?: AgentToolDisplayReference[];
  entities?: AgentToolDisplayEntity[];
  changes?: AgentToolDisplayChange[];
  note?: string;
}

export interface AgentToolCallSnapshot {
  callId: string;
  toolId: string;
  inputSummary?: string;
  inputDisplay?: AgentToolDisplaySnapshot;
  retryCount: number;
  startedAt?: number;
  finishedAt?: number;
  resultSummary?: string;
  resultDisplay?: AgentToolDisplaySnapshot;
  errorCode?: string;
  effect?: AgentApprovalKind | 'read';
  inputFingerprint?: string;
  canvasCheckpoint?: AgentCanvasCheckpoint;
}

/** 供用户勾选的候选模型；category 用于在卡片里分组。 */
export interface ProviderModelChoice {
  id: string;
  name: string;
  category: 'text' | 'image' | 'video' | 'audio';
}

export interface ProviderModelCatalogSummary {
  catalogId: string;
  total: number;
  categoryCounts: Record<ProviderModelChoice['category'], number>;
  expiresAt: number;
  maxSelection: number;
}

export type AgentApprovalInputRequest =
  | {
    kind: 'media_model';
    mediaKind: 'image' | 'video' | 'audio';
    selectedModelRef?: string;
  }
  | {
    /** 中转站接入：让用户从清单里勾选要接入哪几个模型 */
    kind: 'provider_models';
    /** 受限候选元数据快照供主/独立窗口展示；最终仍由宿主复核目录。 */
    options: ProviderModelChoice[];
    catalog?: ProviderModelCatalogSummary;
    maxSelection?: number;
  };

export interface AgentApprovalInputValues {
  modelRef?: string;
  selectedModelIds?: string[];
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

export type AgentReplanReason = 'user_requested' | 'step_skipped';

/**
 * 待消费的重新规划请求。
 *
 * pausedReason 在 prepareAgentTaskResume 中会被清空，无法把「重新规划」和普通「继续」
 * 区分开；该请求独立持久化，由 Runtime 组装上下文时读取并清除，确保要求真正传给模型。
 */
export interface AgentReplanRequest {
  requestedAt: number;
  reason: AgentReplanReason;
}

/**
 * 用户显式引用 Skill 在任务创建时形成的不可变快照。
 * 任务恢复时只读取该快照，避免全局 Skill 的后续编辑或删除改变既有任务语义。
 */
export interface AgentSkillBinding {
  skillId: string;
  name: string;
  version?: string;
  content: string;
  origin?: 'user' | 'agent-package';
  packageId?: string;
  packageName?: string;
  packageVersion?: string;
  entryPath?: string;
  contentHash?: string;
  /** 存在时只能缩小任务可见工具集合；空数组表示该 Skill 不允许任何工具。 */
  allowedTools?: string[];
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
  /** 已执行的「继续 / 重新规划」次数，受 maxResumes 约束（历史记录可能缺省）。 */
  resumeCount?: number;
  /** 用户请求重新规划后待模型消费的指令；消费后清除。 */
  replanRequest?: AgentReplanRequest;
  budget: AgentTaskBudget;
  /** 任务创建时由用户显式引用的 Skill 计算，只能缩小 Registry 可见集合。 */
  toolAllowlist?: string[];
  /** 任务创建时固定的显式 Skill 内容；undefined 仅用于兼容旧任务。 */
  skillBindings?: AgentSkillBinding[];
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
