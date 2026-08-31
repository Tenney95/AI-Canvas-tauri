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
/** 节点工具弹窗额外支持 model 下拉；插件只能拿到不含凭据的模型目录。 */
export type PluginNodeToolDialogFieldType = PluginDialogFieldType | 'model';
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
  type: PluginNodeToolDialogFieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: PluginDialogFieldOption[];
  /** 仅 model 字段可用；缺省表示不限分类。 */
  modelCategories?: GeneralModelCategory[];
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
  /** 宿主 effect 轮次；0 表示首次调用。 */
  iteration: number;
  /** 宿主弹窗收集的用户参数；右键直接执行时为空对象。 */
  parameters: Record<string, PluginJsonValue>;
  node: {
    id: string;
    type: NodeType;
    data: Record<string, PluginJsonValue>;
  };
  /** 声明 models.read 时填充的可调用模型目录，不含任何凭据。 */
  models: PluginModelSummary[];
  /** 上一轮宿主 effect 的结果。 */
  effectResult?: PluginNodeHostEffectResult;
}

export interface NodePluginExecutionResult {
  data?: Record<string, PluginJsonValue>;
  message?: string;
  /** 请求宿主代执行模型或文件能力；宿主完成后会携带 effectResult 再次调用。 */
  effect?: PluginNodeHostEffect;
}

export interface AvailableNodePluginTool {
  pluginId: string;
  pluginName: string;
  runtime: PluginRuntime;
  source: string;
  sourceDigest?: string;
  tool: PluginNodeToolManifest;
  permissions: PluginPermission[];
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
      /**
       * 随本次模型调用一起提交的参考图片。
       * JavaScript 插件只允许提交本次输入中已存在的媒体引用或本轮宿主模型结果，
       * 不能自行拼接远程地址；可信 Python 插件不受该来源限制。
       */
      imageUrls?: string[];
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
