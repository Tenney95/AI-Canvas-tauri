import type { GeneralModelCategory, NodeType } from './index';

export type PluginPermission =
  | 'node.read'
  | 'node.write'
  | 'models.read'
  | 'models.invoke'
  | 'files.read'
  | 'files.write';
export type PluginRuntime = 'javascript' | 'python';
export type PluginNodeOutputMode = 'update-current' | 'create-node';
export type PluginCategory = 'content' | 'media' | 'workflow' | 'utility';
export type PluginPlacement = 'node-context-menu' | 'node-toolbar';
export type PluginDialogFieldType = 'text' | 'textarea' | 'number' | 'select' | 'boolean';
export type PluginCustomNodeFieldType = PluginDialogFieldType | 'model' | 'file';
export type PluginNodePortType = 'text' | 'image' | 'video' | 'audio' | 'json';

export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export interface PluginNodeToolOutputManifest {
  mode: PluginNodeOutputMode;
  /** create-node 缺省时沿用源节点类型。 */
  nodeType?: NodeType;
  /** 插件返回 data 时允许写入的 BaseNodeData 顶层字段。 */
  fields: string[];
}

export interface PluginDialogFieldOption {
  label: string;
  value: string;
}

export interface PluginDialogFieldManifest {
  id: string;
  label: string;
  type: PluginDialogFieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: PluginDialogFieldOption[];
}

export interface PluginToolDialogManifest {
  title?: string;
  description?: string;
  submitLabel?: string;
  fields: PluginDialogFieldManifest[];
}

export interface PluginNodeToolManifest {
  id: string;
  title: string;
  description?: string;
  /** 工具在宿主 UI 中出现的位置。 */
  placements: PluginPlacement[];
  /** Iconify 图标名；使用 node-toolbar 入口时必填。 */
  icon?: string;
  /** node-toolbar 点击后由宿主渲染的声明式操作弹窗。 */
  dialog?: PluginToolDialogManifest;
  nodeTypes: NodeType[];
  /** 传给插件的 BaseNodeData 顶层字段。 */
  inputFields: string[];
  output: PluginNodeToolOutputManifest;
}

export interface PluginCustomNodePortManifest {
  id: string;
  label: string;
  type: PluginNodePortType;
  required?: boolean;
  multiple?: boolean;
}

export interface PluginCustomNodeFieldManifest {
  id: string;
  label: string;
  type: PluginCustomNodeFieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: PluginDialogFieldOption[];
  modelCategories?: GeneralModelCategory[];
}

export interface PluginCustomNodeManifest {
  id: string;
  title: string;
  description?: string;
  icon: string;
  inputs: PluginCustomNodePortManifest[];
  outputs: PluginCustomNodePortManifest[];
  fields: PluginCustomNodeFieldManifest[];
}

export interface PluginManifest {
  apiVersion: 1 | 2 | 3;
  /** v1/v2 固定为 QuickJS；v3 可声明可信 Python 子进程。 */
  runtime: PluginRuntime;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  repository?: string;
  homepage?: string;
  license?: string;
  category: PluginCategory;
  keywords?: string[];
  entry: 'main.js' | 'main.py';
  permissions: PluginPermission[];
  contributes: {
    nodeTools: PluginNodeToolManifest[];
    nodes?: PluginCustomNodeManifest[];
  };
}

export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  source: string;
  /** Rust 原生注册表计算的入口源码 SHA-256；旧记录在加载时补齐。 */
  sourceDigest?: string;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
}

export interface NodePluginInvocationInput {
  projectId: string;
  /** 宿主弹窗收集的用户参数；右键直接执行时为空对象。 */
  parameters: Record<string, PluginJsonValue>;
  node: {
    id: string;
    type: NodeType;
    data: Record<string, PluginJsonValue>;
  };
}

export interface NodePluginExecutionResult {
  data: Record<string, PluginJsonValue>;
  message?: string;
}

export interface AvailableNodePluginTool {
  pluginId: string;
  pluginName: string;
  runtime: PluginRuntime;
  source: string;
  sourceDigest?: string;
  tool: PluginNodeToolManifest;
}

export interface AvailablePluginNode {
  pluginId: string;
  pluginName: string;
  runtime: PluginRuntime;
  source: string;
  sourceDigest?: string;
  node: PluginCustomNodeManifest;
  permissions: PluginPermission[];
}

export interface PluginModelSummary {
  id: string;
  name: string;
  provider: string;
  category: GeneralModelCategory;
  description?: string;
  inputModalities?: Array<'text' | 'image'>;
}

export interface PluginFileGrantSummary {
  grantId: string;
  displayName: string;
  size: number;
  extension: string;
}

export type PluginNodeHostEffect =
  | {
      type: 'model.generate';
      modelId: string;
      prompt: string;
      parameters?: Record<string, PluginJsonValue>;
    }
  | { type: 'file.readText'; grantId: string }
  | { type: 'file.saveText'; content: string; suggestedName?: string };

export interface PluginNodeHostEffectResult {
  type: PluginNodeHostEffect['type'];
  ok: boolean;
  value?: PluginJsonValue;
  error?: string;
}

export interface PluginNodeInvocationInput {
  projectId: string;
  iteration: number;
  node: {
    id: string;
    values: Record<string, PluginJsonValue>;
  };
  inputs: Record<string, PluginJsonValue>;
  models: PluginModelSummary[];
  effectResult?: PluginNodeHostEffectResult;
}

export interface PluginNodeExecutionResult {
  data?: {
    values?: Record<string, PluginJsonValue>;
    outputs?: Record<string, PluginJsonValue>;
  };
  effect?: PluginNodeHostEffect;
  message?: string;
}

export interface PythonPluginRuntimeStatus {
  available: boolean;
  command?: string;
  version?: string;
  error?: string;
}
