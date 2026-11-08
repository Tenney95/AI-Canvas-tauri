/**
 * Agent 领域类型。
 *
 * 本文件只描述可持久化的任务状态，不包含 AbortController、窗口句柄等运行时对象。
 */

import type { AgentTeamRun } from './agentTeam';
import type { AgentResultReference } from './agentResult';
import type { CreationProfileSnapshot } from './creationProfile';

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
  | 'asset_write'
  | 'external_write';

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
  /** 新项目历史只在捕获检查点的原运行租约下可重放/回退。 */
  runtimeEpoch?: string;
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
  resultReference?: AgentResultReference;
}

/** 调用前后持久化的安全回执；dispatched 不证明远端已受理。 */
export interface AgentDispatchRecord {
  id: string;
  kind: 'model' | 'tool' | 'team-model';
  phase: 'prepared' | 'dispatched' | 'settled' | 'not_started' | 'outcome_unknown';
  toolId?: string;
  stepId?: string;
  runRevision?: number;
  effect?: AgentApprovalKind | 'read';
  inputDigest?: string;
  preparedAt: number;
  dispatchedAt?: number;
  settledAt?: number;
  outcome?: 'succeeded' | 'failed';
  /** 已返回但无法接纳产物；事实已结算，普通继续仍不能再次提交该阶段。 */
  materializationBlocked?: true;
  recovery?: { decision: 'verified_completed' | 'abandoned'; decidedAt: number };
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

export type McpOperationPhase = 'reserved' | 'running' | 'succeeded' | 'partial' | 'failed' | 'unknown';
export type McpOperationItemStatus = 'not_started' | 'started' | 'succeeded' | 'failed' | 'unknown';
/** started 仅表示进入本地生成调用，不证明服务商已受理；提交身份沿用媒体恢复模块。 */
export type McpOperationMediaStage = 'preparing' | 'started' | 'generated' | 'delivered';

/** 仅保存摘要身份，不保存客户端 key、参数正文、路径或凭据。 */
export interface McpOperationIdentity {
  bindingId: string;
  projectId: string;
  keyDigest: string;
  inputDigest: string;
  toolId: string;
  effect: 'canvas_write' | 'media_generation';
}

export interface McpOperationItemReceipt {
  nodeId: string;
  status: McpOperationItemStatus;
  errorCode?: string;
}

export interface McpOperationRecord extends McpOperationIdentity {
  version: 1;
  phase: McpOperationPhase;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  items?: McpOperationItemReceipt[];
  mediaStage?: McpOperationMediaStage;
  canvasNodeId?: string;
  messageId?: string;
  artifactId?: string;
  persistence?: 'pending' | 'saved' | 'skipped' | 'failed';
  errorCode?: string;
  revisionAfter?: number;
}

/** AgentTask 删除后仍保留绑定，防止同 key 再次提交付费工作。 */
export interface McpOperationBinding extends McpOperationIdentity {
  id: string;
  kind: 'mcp-operation-binding';
  version: 1;
  taskId: string;
  createdAt: number;
  taskDeletedAt?: number;
  lastSequence?: number;
}

export type McpOperationUpdate = Partial<Pick<McpOperationRecord,
  'phase' | 'items' | 'mediaStage' | 'canvasNodeId' | 'messageId' | 'artifactId' | 'persistence'
  | 'errorCode' | 'revisionAfter'>>;

export interface McpOperationReceipt {
  operationId: string;
  taskId: string;
  projectId: string;
  toolId: string;
  status: Exclude<McpOperationPhase, 'reserved'> | 'not_started';
  sequence: number;
  resultAvailable: false;
  retryable: false;
  requiresReadVerification: boolean;
  nextAction: string;
  items?: McpOperationItemReceipt[];
  mediaStage?: McpOperationMediaStage;
  canvasNodeId?: string;
  messageId?: string;
  artifactId?: string;
  persistence?: 'pending' | 'saved' | 'skipped' | 'failed';
  errorCode?: string;
  revisionAfter?: number;
}

export interface AgentTask {
  id: string;
  projectId: string;
  /** 新请求原样捕获的跨连接并发前提；旧projectId仍保留原Canvas命名空间。 */
  executionContext?: import('./project').ProjectExpectedContext;
  /** legacy任务的持久身份/代际边界；正文和画布版本仍由既有专用守卫管理。 */
  projectScope?: import('./project').ProjectExpectedContext;
  conversationId: string;
  userMessageId: string;
  /** 团队任务不得在缺少/损坏团队快照时回退为普通单模型执行。 */
  executionKind?: 'team';
  teamRun?: AgentTeamRun;
  /** 同一次团队提交的非敏感摘要，用于断线后的查重；不是调用模型的重试许可。 */
  teamRequestDigest?: string;
  /** 工作台发起的只读创作任务，仅授权目标分集正文，不授予其画布权限。 */
  workbenchTarget?: { seriesId: string; episodeId: string };
  mode: AgentMode;
  goal: string;
  status: AgentTaskStatus;
  steps: AgentStep[];
  dispatches?: AgentDispatchRecord[];
  creationProfile?: CreationProfileSnapshot;
  /** 组合包准备未完成时，暂停/重启不能绕过异步能力与持久化前置条件。 */
  creationProfilePreparation?: 'pending' | 'ready' | 'failed';
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
  mcpOperation?: McpOperationRecord;
}

/** 主窗口发起的任务定位请求，只用于当前 UI，不进入任务持久化。 */
export interface AgentTaskFocusRequest {
  taskId: string;
  revision: number;
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
