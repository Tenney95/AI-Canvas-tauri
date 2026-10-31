/** RunningHub 云工作流合同；不含密钥、访问密码或本地文件路径。 */
export type RunningHubMediaKind = import('./workflowApi').CloudWorkflowMediaKind;
export type RunningHubValue = string | number | boolean;
export type RunningHubConnectionId = 'runninghub' | 'runninghub-model';
export type RunningHubSiteId = 'cn' | 'ai';
/** 仅用于设置弹窗和保存调用；不得作为嵌套字段写入配置或 IndexedDB。 */
export type RunningHubSiteKeyDrafts = Record<RunningHubSiteId, { modelKey: string; workflowKey: string }>;
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
  /** 定义中实际声明的数值范围；步进也可采用 ComfyUI INT 控件的默认值 1。 */
  min?: number;
  max?: number;
  step?: number;
  /** 字符串字段实际声明的多行展示方式。 */
  multiline?: boolean;
  source: 'value' | 'prompt' | RunningHubMediaKind;
  /** API 图中明确的文本输入；未绑定时仍保留其固定值（如负面提示词）。 */
  inputType?: 'prompt';
  /** 用户在导入编辑器显式选择的来源；固定值不再参与旧定义的提示词兼容识别。 */
  sourceExplicit?: boolean;
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
  /** 显式节点绑定；缺省保留旧来源/参考序号映射。 */
  inputBindingMode?: 'nodes';
  outputNodeIds?: string[];
  instanceType?: 'default' | 'plus';
  usePersonalQueue?: boolean;
}
export type RunningHubOutput = import('./workflowApi').CloudWorkflowOutput;
export interface RunningHubConnection {
  apiKey: string;
  baseUrl: string;
}
