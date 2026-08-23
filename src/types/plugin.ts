import type { NodeType } from './index';

export type PluginPermission = 'node.read' | 'node.write';
export type PluginNodeOutputMode = 'update-current' | 'create-node';
export type PluginCategory = 'content' | 'media' | 'workflow' | 'utility';
export type PluginPlacement = 'node-context-menu' | 'node-toolbar';
export type PluginDialogFieldType = 'text' | 'textarea' | 'number' | 'select' | 'boolean';

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

export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  category: PluginCategory;
  keywords?: string[];
  entry: 'main.js';
  permissions: PluginPermission[];
  contributes: {
    nodeTools: PluginNodeToolManifest[];
  };
}

export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  source: string;
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
  source: string;
  tool: PluginNodeToolManifest;
}
