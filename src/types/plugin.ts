import type { ComponentType } from 'react';
import type { GeneralModelCategory, NodeType } from './index';

export type PluginPermission =
  | 'node.read'
  | 'node.write'
  | 'models.read'
  | 'models.invoke'
  | 'files.read'
  | 'files.write'
  /** 允许插件提供自定义界面组件。该组件在独立 webview 进程中运行，仍需显式授权。 */
  | 'ui.custom';
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
  /**
   * 引用 `manifest.ui.exports` 中的键，用插件组件替换声明式表单。
   * `fields` 仍然保留：它定义 `parameters` 的契约，并在组件不可用时作为兜底表单。
   */
  ui?: string;
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
  /** 引用 `manifest.ui.exports` 中的键，用插件组件渲染节点主体。 */
  ui?: string;
}

/**
 * 插件自定义界面产物的声明。
 *
 * 产物必须是自包含的 IIFE/UMD bundle：React 由宿主通过全局桥注入，不重复打进产物，
 * 否则会出现 React 双实例并导致 hooks 报错。
 */
export interface PluginUIManifest {
  /** 产物相对插件根目录的路径，例如 `ui.js`。 */
  entry: string;
  /** 产物 SHA-256，形如 `sha256-<hex>` 或裸 hex；变更时需要用户重新授权。 */
  integrity: string;
  /** 逻辑名 → 产物在全局桥上暴露的导出名。 */
  exports: Record<string, string>;
}

/** 自定义界面可以挂载的位置。 */
export type PluginUISurface =
  | 'tool-dialog'
  | 'node-body'
  | 'settings-panel'
  | 'side-panel';

/**
 * 宿主注入给插件组件的接口。
 *
 * 插件组件运行在独立 webview 进程里，只能通过这里的回调与宿主交互——拿不到宿主的
 * DOM、store 或凭据；写回画布仍要过 output.fields 白名单与媒体来源校验。
 */
export interface PluginUISurfaceProps {
  /** 当前挂载点，便于同一个组件复用到多个位置。 */
  surface: PluginUISurface;
  /** 已按 inputFields 白名单裁剪的节点数据。 */
  node: { id: string; type: NodeType; data: Record<string, PluginJsonValue> };
  /** 声明 models.read 时填充的模型目录，不含任何凭据。 */
  models: PluginModelSummary[];
  /** 弹窗字段当前值；tool-dialog 挂载点使用。 */
  parameters: Record<string, PluginJsonValue>;
  /** 自定义节点字段当前值；node-body 挂载点使用。 */
  values: Record<string, PluginJsonValue>;
  /** 请求宿主代执行模型或文件能力；受插件权限与每轮 effect 配额约束。 */
  runEffect: (effect: PluginNodeHostEffect) => Promise<PluginNodeHostEffectResult>;
  /** 合并更新弹窗参数，宿主会在提交时把它们交给插件。 */
  setParameters: (patch: Record<string, PluginJsonValue>) => void;
  /**
   * 提交并关闭。当前实现等价于声明式弹窗点「执行」：宿主以最终 parameters 重新执行
   * 插件工具，写回仍走 output.fields 白名单校验。`data`/`message` 暂未直接写回，
   * 保留给未来的直接提交通道——需要把结果落到节点时，请通过 `setParameters` 把结果
   * 放进 parameters，再由插件工具读取。
   */
  submit: (data: Record<string, PluginJsonValue>, message?: string) => Promise<void>;
  close: () => void;
  toast: (message: string, type?: 'success' | 'error') => void;
  /** 宿主正在执行 effect 或提交。 */
  busy: boolean;
}

export type PluginUIComponent = ComponentType<PluginUISurfaceProps>;

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
  /** 自定义界面产物；需配合 nodeTools[].dialog.ui 或 nodes[].ui 使用。 */
  ui?: PluginUIManifest;
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
  /** 自定义界面产物的实际 SHA-256，与 manifest.ui.integrity 比对，不一致则拒绝挂载。 */
  uiDigest?: string;
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
