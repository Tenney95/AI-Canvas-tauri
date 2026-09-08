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
export interface WorkflowApiManifest {
  version: 1;
  adapter: 'autodl-comfyui';
  workflowId: string;
  connectionId: string;
  defaults?: WorkflowApiInputValues;
}

export interface WorkflowApiTaskDescriptor {
  version: 1;
  /** 区分同一节点上尚未返回远端 ID 的不同提交。 */
  attemptId: string;
  adapter: 'autodl-comfyui';
  workflowId: string;
  remoteWorkflowId: string;
  /** 绑定提交时的站点，凭据更新不允许把旧任务送往另一个站点。 */
  origin: string;
  state: 'submit_unknown' | 'disconnected' | 'save_pending';
}

export type WorkflowApiReferences = Partial<Record<CloudWorkflowMediaKind, readonly string[]>>;
export interface WorkflowApiConnection { apiKey: string; baseUrl: string }
