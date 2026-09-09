import type { ModelExecutionProtocol, ResolvedModelProtocolPoll } from './aiTypes';

/** 云工作流共享产物；请求与鉴权仍由各厂商 adapter 定义。 */
export type CloudWorkflowMediaKind = 'image' | 'video' | 'audio';
export interface CloudWorkflowOutput {
  url: string;
  sourceUrl?: string;
  filePath?: string;
  kind: CloudWorkflowMediaKind;
  nodeId?: string;
}

export interface WorkflowApiInputValues {
  [key: string]: string | number | boolean | undefined;
  duration?: number;
  resolution?: string;
  ratio?: string;
  seed?: number;
}

export interface CloudWorkflowTaskContext {
  projectId: string;
  conversationId: string;
  messageId: string;
  deliveryMode: 'chat' | 'canvas' | 'both';
}

/** 持久化只保存已知工作流的身份与标量默认值，不接收任意端点/脚本。 */
export interface LegacyWorkflowApiManifest {
  version: 1;
  adapter: 'autodl-comfyui';
  workflowId: string;
  connectionId: string;
  defaults?: WorkflowApiInputValues;
}

export interface WorkflowApiParameter {
  type: 'string' | 'number' | 'integer' | 'boolean';
  label?: string;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  options?: Array<string | number>;
}

export interface WorkflowApiMediaInput {
  min: number;
  max: number;
  extensions?: string[];
}

/** 声明式工作流：只读取受信变量，不执行脚本，端点受连接同源约束。 */
export interface DeclarativeWorkflowApiManifest {
  version: 2;
  adapter: 'declarative';
  workflowId: string;
  connectionId: string;
  outputKind: CloudWorkflowMediaKind;
  references: Partial<Record<CloudWorkflowMediaKind, WorkflowApiMediaInput>>;
  parameters: Record<string, WorkflowApiParameter>;
  prompt?: { required?: boolean; maxLength?: number };
  protocol: ModelExecutionProtocol;
  businessStatus?: { path: string; successValues: Array<string | number>; errorPath?: string };
  defaults?: WorkflowApiInputValues;
}

export type WorkflowApiManifest = LegacyWorkflowApiManifest | DeclarativeWorkflowApiManifest;
export interface WorkflowApiDraft { id: string; name: string; manifest: DeclarativeWorkflowApiManifest }

export interface WorkflowApiTaskDescriptor {
  version: 1;
  /** 区分同一节点上尚未返回远端 ID 的不同提交。 */
  attemptId: string;
  adapter: 'autodl-comfyui' | 'declarative';
  workflowId: string;
  remoteWorkflowId: string;
  /** 绑定提交时的站点，凭据更新不允许把旧任务送往另一个站点。 */
  origin: string;
  state: 'submit_unknown' | 'disconnected' | 'save_pending';
  /** 固定提交时的合同；编辑连接内的新工作流不改写旧任务。 */
  manifest?: DeclarativeWorkflowApiManifest;
  poll?: ResolvedModelProtocolPoll;
  outputs?: CloudWorkflowOutput[];
}

export type WorkflowApiReferences = Partial<Record<CloudWorkflowMediaKind, readonly string[]>>;
export interface WorkflowApiConnection { apiKey: string; baseUrl: string }
