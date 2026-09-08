/** RunningHub 云工作流合同；不含密钥、访问密码或本地文件路径。 */
export type RunningHubMediaKind = import('./workflowApi').CloudWorkflowMediaKind;
export type RunningHubValue = string | number | boolean;
export type RunningHubConnectionId = 'runninghub' | 'runninghub-model';
export interface RunningHubTaskContext {
  projectId: string;
  conversationId: string;
  messageId: string;
  deliveryMode: 'chat' | 'canvas' | 'both';
}
export interface RunningHubParameter {
  nodeId: string;
  fieldName: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  defaultValue: RunningHubValue;
  required?: boolean;
  options?: RunningHubValue[];
  source: 'value' | 'prompt' | RunningHubMediaKind;
  /** 同类型参考素材的索引，从 0 开始。 */
  referenceIndex?: number;
  mediaFormat?: 'filename' | 'url';
}
export interface RunningHubWorkflowManifest {
  version: 1;
  kind: 'workflow' | 'app';
  remoteId: string;
  connectionId: RunningHubConnectionId;
  parameters: RunningHubParameter[];
  outputNodeIds?: string[];
  instanceType?: 'default' | 'plus';
  usePersonalQueue?: boolean;
}
export type RunningHubOutput = import('./workflowApi').CloudWorkflowOutput;
export interface RunningHubConnection {
  apiKey: string;
  baseUrl: string;
}
