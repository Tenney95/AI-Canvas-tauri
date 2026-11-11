/** 多模型团队的可持久化合同。正文只存在于不可变项目产物文件中。 */
export type TeamTemplateId = 'outline' | 'script' | 'review' | 'general';
export type TeamRoleId = 'architect' | 'writer' | 'continuity' | 'dialogue' | 'director' | 'storyboard' | 'editor';

export type TeamExecutionTarget =
  | { kind: 'text-model'; modelId: string }
  | { kind: 'external-agent'; providerId: 'codex-app-server'; modelId: string };

export interface TeamGraphNode {
  id: string;
  roleId: TeamRoleId;
  title: string;
  kind: 'outline' | 'draft' | 'review' | 'decision' | 'revision';
  dependsOn: string[];
  /** 明确指定所审/所写正文，必须是依赖祖先，不读取其他分支的全部材料。 */
  sourceTaskId?: string;
  /** 覆盖该角色的文本模型；外部执行器沿角色显式绑定。 */
  modelId?: string;
}

export interface TeamGraphDefinition {
  version: 1;
  nodes: TeamGraphNode[];
  finalTaskId: string;
}

export type AssistantExecutionSelection =
  | { kind: 'single' }
  | { kind: 'team'; templateId: TeamTemplateId };

export interface AgentTeamProfile {
  version: 1;
  name: string;
  roles: Record<TeamRoleId, string>;
  roleExecutors?: Partial<Record<TeamRoleId, TeamExecutionTarget>>;
  graph?: TeamGraphDefinition;
  maxCalls: number;
  /** 含未知 usage 时的保守预算估算，不代表官方账单上限。 */
  maxTotalTokens: number;
  maxOutputChars: number;
}

export interface TeamEpisodeTarget {
  kind: 'episode';
  seriesId: string;
  episodeId: string;
  field: 'outline' | 'script';
  expectedHash: string;
  /** 非目标正文与创作设定的快照摘要，避免基于旧上游结构应用。 */
  sourceHash?: string;
  label: string;
}

export interface TeamInvocationContext {
  source: 'assistant' | 'script-workbench';
  target?: TeamEpisodeTarget;
}

export type TeamArtifactKind = 'input' | 'outline' | 'draft' | 'review' | 'decision' | 'revision' | 'original';

export interface TeamArtifactReference {
  id: string;
  kind: TeamArtifactKind;
  label: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  createdAt: number;
  stageId?: string;
  roleId?: TeamRoleId;
  parentArtifactIds: string[];
}

export interface ReviewFinding {
  id: string;
  severity: 'critical' | 'major' | 'minor';
  location: string;
  evidence: string;
  constraint: string;
  suggestion: string;
}

export interface TeamReviewReport {
  version: 1;
  artifactId: string;
  artifactHash: string;
  findings: ReviewFinding[];
}

export interface ReviewDecision {
  findingId: string;
  action: 'accept' | 'reject' | 'clarify';
  reason: string;
}

export interface TeamDecisionReport {
  version: 1;
  decisions: ReviewDecision[];
  summary: string;
}

export interface TeamStageRun {
  id: string;
  roleId: TeamRoleId;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  modelId: string;
  executionTarget?: TeamExecutionTarget;
  modelFingerprint?: string;
  taskRevision?: number;
  attemptId?: string;
  attempts: number;
  artifactId?: string;
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  usageKnown: boolean;
  startedAt?: number;
  completedAt?: number;
}

export interface TeamApplicationReceipt {
  status: 'pending' | 'applied' | 'restore-pending' | 'restored';
  artifactId: string;
  originalArtifactId: string;
  targetHashBefore: string;
  targetHashAfter: string;
  appliedAt: number;
  restoredAt?: number;
}

export interface AgentTeamRun {
  version: 1 | 2;
  /** 同任务追加要求时递增，使旧执行段的迟到结果失效。 */
  revision: number;
  graph?: TeamGraphDefinition;
  boardRevision?: number;
  id: string;
  templateId: TeamTemplateId;
  source: TeamInvocationContext['source'];
  target?: TeamEpisodeTarget;
  profile: AgentTeamProfile;
  inputArtifact: TeamArtifactReference;
  /** 非敏感模型执行身份的摘要；不包含实际地址、配置或凭据。 */
  modelFingerprints: Record<TeamRoleId, string>;
  stages: TeamStageRun[];
  artifacts: TeamArtifactReference[];
  callsUsed: number;
  budgetTokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  usageKnown: boolean;
  resultArtifactId?: string;
  usageReportedCalls: number;
  unknownUsageCalls: number;
  application?: TeamApplicationReceipt;
  createdAt: number;
}
