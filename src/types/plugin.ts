import type { GeneralModelCategory, NodeType } from './index';

export type PluginPermission =
  | 'node.read'
  | 'node.write'
  | 'models.read'
  | 'models.invoke'
  /** 读取当前节点自身与声明输入连线所引用的项目文件；只通过短期 resourceId 暴露。 */
  | 'files.connected.read'
  /** 在项目目录中创建新的派生输出；不允许覆盖上游源文件。 */
  | 'files.output.create'
  /** 读取 Manifest 显式声明并绑定当前插件 revision 的包资源。 */
  | 'plugin.resources.read'
  /** 允许插件提供自定义界面组件。该组件在主窗口 sandboxed iframe 中运行，仍需显式授权。 */
  | 'ui.custom';
export type PluginRuntime = 'javascript' | 'python';
export type PluginNodeOutputMode = 'update-current' | 'create-node' | 'create-node-set';
export type PluginCategory = 'content' | 'media' | 'workflow' | 'utility';
export type PluginPlacement = 'node-context-menu' | 'node-toolbar';
export type PluginDialogFieldType = 'text' | 'textarea' | 'number' | 'select' | 'boolean';
/** 节点工具弹窗额外支持 model 下拉；插件只能拿到不含凭据的模型目录。 */
export type PluginNodeToolDialogFieldType = PluginDialogFieldType | 'model';
export type PluginCustomNodeFieldType = PluginDialogFieldType | 'model';
export type PluginNodePortType = 'text' | 'image' | 'video' | 'audio' | 'json' | 'resource';

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
  /** create-node-set 允许创建的节点类型白名单。 */
  nodeTypes?: NodeType[];
  /** create-node-set 单次允许创建的节点总数，宿主上限为 25。 */
  maxNodes?: number;
  /** 插件返回 data 时允许写入的 BaseNodeData 顶层字段。 */
  fields: string[];
}

export interface PluginNodeSetItem {
  /** 调用内稳定键；宿主用它解析边与分镜行的 frameKey。 */
  key: string;
  nodeType: NodeType;
  /** ai-image 节点绑定本次 invocation 的派生图像资源。 */
  resourceId?: string;
  data: Record<string, PluginJsonValue>;
}

export interface PluginNodeSetEdge {
  sourceKey: string;
  targetKey: string;
}

export interface PluginNodeSetData {
  nodes: PluginNodeSetItem[];
  edges?: PluginNodeSetEdge[];
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
   * 引用 `manifest.ui.exports` 中的键，用插件自定义视图替换声明式表单。
   * `fields` 仍然定义 `parameters` 的默认值与数据契约；未声明 ui 时由宿主渲染这些字段。
   */
  ui?: string;
  /** 缺省为 modal；window 仅用于自定义 UI，实际开放由宿主隔离验收控制。 */
  presentation?: 'modal' | 'window';
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
  /** API v1：声明本工具需要哪些节点文件资源；默认不授予。 */
  resourceAccess?: PluginResourceAccessManifest;
  output: PluginNodeToolOutputManifest;
}

export interface PluginResourceAccessManifest {
  /** 当前目标节点自身引用的项目文件。 */
  self?: boolean;
  /** 当前目标节点的一跳直接输入连线。 */
  incoming?: boolean;
  /** 自定义节点可进一步把连线资源限制到这些 input port；省略表示全部声明输入。 */
  portIds?: string[];
}

export interface PluginCustomNodePortManifest {
  id: string;
  label: string;
  type: PluginNodePortType;
  required?: boolean;
  multiple?: boolean;
  /** resource 端口允许的 MIME；支持 `image/*` 形式。 */
  accept?: string[];
  /** 单个连线资源的声明大小上限。 */
  maxBytes?: number;
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
  /** API v1：声明节点自身/输入连线文件资源范围；默认不授予。 */
  resourceAccess?: PluginResourceAccessManifest;
}

/**
 * 插件自定义界面产物的声明。
 *
 * 产物必须是自包含的 IIFE/UMD bundle，并导出 `(root, props) => cleanup?` 挂载函数。
 * 插件可在产物内自带任意框架；宿主不向第三方代码暴露主窗口 React 实例。
 */
export interface PluginUIManifest {
  /** 产物相对插件根目录的路径，例如 `ui.js`。 */
  entry: string;
  /** 产物 SHA-256，形如 `sha256-<hex>` 或裸 hex；变更时需要用户重新授权。 */
  integrity: string;
  /** 逻辑名 → 产物在全局桥上暴露的导出名。 */
  exports: Record<string, string>;
}

export interface PluginPackageResourceManifest {
  /** 插件内稳定逻辑名。 */
  id: string;
  /** 相对 manifest.json 的包内路径。 */
  path: string;
  /** 文件 SHA-256，形如 `sha256-<hex>` 或裸 hex。 */
  integrity: string;
  /** 用于展示与 effect 校验，不作为内容嗅探的替代。 */
  mediaType: string;
  /** 安装包中该文件的精确字节数。 */
  bytes: number;
}

/** 安装阶段交给 Rust 私有快照的有界资源字节；不进入 IndexedDB。 */
export interface PluginPackageResourcePayload {
  id: string;
  bytes: number[];
}

/** Plugin API v1 的逻辑挂载点，与弹窗或原生窗口的展示方式无关。 */
export type PluginUISurface = 'tool-dialog';

/** 宿主与原生层的内存会话契约，不属于插件可选择的权限或持久化数据。 */
export interface PluginUiWindowBinding {
  readonly sessionId: string;
  readonly identity: {
    readonly pluginId: string;
    readonly sourceDigest: string;
    readonly revisionDigest: string;
    readonly uiDigest: string;
    readonly toolId: string;
  };
  readonly projectId: string;
  readonly nodeId: string;
  readonly canvasRevision: number;
}

export type PluginUiRequestKind = 'context' | 'effect' | 'set-parameters' | 'submit' | 'close' | 'toast';

export interface PluginUiReply {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** 只能由创建窗口时登记的原生 Channel 投递，不接受通用事件。 */
export type PluginUiWindowEvent =
  | { type: 'request'; binding: PluginUiWindowBinding; requestId: string; kind: PluginUiRequestKind; payload: unknown }
  | { type: 'closed'; binding: PluginUiWindowBinding; reason: string };

/**
 * 宿主注入给插件自定义视图的接口。
 *
 * 插件视图运行在 sandboxed iframe 或经隔离验证的专用 WebView 中，只能通过这里的回调与宿主交互——拿不到宿主的
 * DOM、store 或凭据；写回画布仍要过 output.fields 白名单与媒体来源校验。
 */
export interface PluginUISurfaceProps {
  /** 当前挂载点；v1 固定为节点工具弹窗。 */
  surface: PluginUISurface;
  /** 宿主主题；内嵌时实时同步，原生窗口重新聚焦时刷新，并派发 ai-canvas-theme-change。 */
  theme: 'dark' | 'light';
  /** 已按 inputFields 白名单裁剪的节点数据。 */
  node: { id: string; type: NodeType; data: Record<string, PluginJsonValue> };
  /** 声明 models.read 时填充的模型目录，不含任何凭据。 */
  models: PluginModelSummary[];
  /** 弹窗字段当前值；tool-dialog 挂载点使用。 */
  parameters: Record<string, PluginJsonValue>;
  /** 当前界面会话获准访问的节点、直接入边和插件包资源；只包含不透明句柄。 */
  resources: PluginInvocationResources;
  /** 请求宿主代执行模型或文件能力；受插件权限与每轮 effect 配额约束。 */
  runEffect: (effect: PluginNodeHostEffect) => Promise<PluginNodeHostEffectResult>;
  /** 合并更新弹窗参数，宿主会在提交时把它们交给插件。 */
  setParameters: (patch: Record<string, PluginJsonValue>) => Promise<void>;
  /** 提交并关闭；`data` 与 parameters 合并后重新执行插件工具，并经过正常写回校验。 */
  submit: (data?: Record<string, PluginJsonValue>) => Promise<void>;
  close: () => Promise<void>;
  toast: (message: string, type?: 'success' | 'error') => Promise<void>;
  /** 宿主正在执行 effect 或提交。 */
  busy: boolean;
}

/** 插件 UI 产物对外暴露的唯一挂载契约。 */
export type PluginUIMount = (
  root: HTMLElement,
  props: PluginUISurfaceProps,
) => void | (() => void) | Promise<void | (() => void)>;

export interface PluginManifest {
  apiVersion: 1;
  /** v1 显式选择 QuickJS 或可信 Python。 */
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
  /** API v1：当前插件 revision 随包安装的不可变资源。 */
  resources?: PluginPackageResourceManifest[];
  /** 自定义界面产物；需配合 nodeTools[].dialog.ui 使用。 */
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
  /** Rust 原生注册表计算的活动入口源码 SHA-256；缺失或不匹配时失败关闭。 */
  sourceDigest?: string;
  /** Manifest、入口、UI 与包资源共同形成的当前 revision 摘要。 */
  revisionDigest?: string;
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
  /** API v1 可选资源 sidecar；所有引用均为调用级不透明句柄。 */
  resources?: PluginInvocationResources;
  /** 上一轮宿主 effect 的结果。 */
  effectResult?: PluginNodeHostEffectResult;
}

export interface NodePluginExecutionResult {
  data?: Record<string, PluginJsonValue>;
  nodeSet?: PluginNodeSetData;
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
  revisionDigest?: string;
  tool: PluginNodeToolManifest;
  permissions: PluginPermission[];
}

export interface AvailablePluginNode {
  pluginId: string;
  pluginName: string;
  runtime: PluginRuntime;
  source: string;
  sourceDigest?: string;
  revisionDigest?: string;
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

export type PluginResourceOrigin = 'node-self' | 'connection' | 'package' | 'derived';

export interface PluginResourceRef {
  resourceId: string;
  origin: PluginResourceOrigin;
  displayName: string;
  mediaType: string;
  size: number;
  sha256?: string;
  access: 'read';
  source?: {
    nodeId: string;
    edgeId?: string;
    portId?: string;
  };
}

export interface PluginInvocationResources {
  self: PluginResourceRef[];
  incoming: PluginResourceRef[];
  inputs: Record<string, PluginResourceRef[]>;
  package: PluginResourceRef[];
  /** 宿主 effect 在当前 invocation 内生成的内存资源；会话结束即撤销。 */
  derived: PluginResourceRef[];
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
      /** API v1：由宿主解析并作为参考媒体提交，插件不接触真实路径。 */
      resourceIds?: string[];
      parameters?: Record<string, PluginJsonValue>;
    }
  | { type: 'resource.readText'; resourceId: string; maxBytes?: number }
  | { type: 'resource.readRange'; resourceId: string; offset: number; length: number }
  | { type: 'resource.createText'; content: string; suggestedName?: string }
  | { type: 'resource.export'; resourceId: string; suggestedName?: string }
  | { type: 'video.detectShots'; resourceId: string; start: number; end: number; threshold?: number; minShotDuration?: number }
  | { type: 'video.inspectFrame'; resourceId: string; time: number; direction: -1 | 0 | 1; boundary?: boolean }
  | {
      type: 'video.extractFrames';
      /** 必须是当前节点 self 中的视频资源。 */
      resourceId: string;
      /** preview 只返回小图；analysis 还登记派生帧与联系表资源。 */
      mode: 'preview' | 'analysis';
      /** preview 模式均匀采样数量，范围 1-48。 */
      count?: number;
      /** analysis 模式显式选帧，必须按 time 单调递增，最多 24 项。 */
      samples?: Array<{ key: string; time: number }>;
      /** 原子替换当前派生批次，使反复选帧不累积资源。 */
      replaceDerived?: boolean;
    };

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
  /** API v1 可选资源 sidecar；inputs 保持普通字段值语义。 */
  resources?: PluginInvocationResources;
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
