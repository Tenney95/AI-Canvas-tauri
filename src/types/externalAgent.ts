/** 外部执行器公开合同；不包含安装路径、凭据、进程或原始协议日志。 */
export const CODEX_EXTERNAL_PROVIDER_ID = 'codex-app-server' as const;
export const CODEX_EXTERNAL_SECRET_KEY = 'external-agent/codex';

export interface ExternalAgentCapabilities {
  oneShot: true;
  cancel: true;
  progress: true;
  text: true;
  structuredResult: true;
  resume: false;
  fork: false;
  inheritsParentContext: false;
  hostTools: false;
}

export interface ExternalAgentModel { id: string; name: string }

export interface ExternalAgentStatus {
  providerId: typeof CODEX_EXTERNAL_PROVIDER_ID;
  registered: boolean;
  enabled: boolean;
  configured: boolean;
  compatible: boolean;
  available: boolean;
  version: string | null;
  executionFingerprint: string | null;
  activeRuns: number;
  capabilities: ExternalAgentCapabilities;
  models: ExternalAgentModel[];
  errorCode?: string;
}

export interface ExternalAgentDescriptor {
  id: typeof CODEX_EXTERNAL_PROVIDER_ID;
  name: string;
  available: boolean;
  executionFingerprint: string | null;
  capabilities: ExternalAgentCapabilities;
  models: ExternalAgentModel[];
  errorCode?: string;
}

export interface ExternalAgentProgress {
  invocationId: string;
  phase: 'preparing' | 'initializing' | 'checking' | 'running' | 'completed' | 'cancelled' | 'failed';
  elapsedMs: number;
  outputChars: number;
}

export interface ExternalAgentResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  usageKnown: boolean;
}

export interface ExternalAgentRequest {
  providerId: typeof CODEX_EXTERNAL_PROVIDER_ID;
  invocationId: string;
  projectId: string;
  conversationId: string;
  taskId: string;
  stageId: string;
  runRevision: number;
  modelId: string;
  expectedFingerprint: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputChars: number;
  /** 当前阶段有结构化结果合同时才提供；原生限制 schema 体积。 */
  outputSchema?: Record<string, unknown>;
}

export interface ExternalAgentExecutionInput extends ExternalAgentRequest {
  signal: AbortSignal;
  onProgress?: (event: ExternalAgentProgress) => void;
}

export interface ExternalAgentCollection {
  invocationId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  /** 仅有原生登记记录时提供；true 只表示可能已发送，不证明远端受理。缺失不能当 false。 */
  turnSubmitted?: boolean;
  result?: ExternalAgentResult;
  errorCode?: string;
}
