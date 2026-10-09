import type {
  NodePluginInvocationInput,
  NodePluginExecutionResult,
  PluginNodeInvocationInput,
  PluginNodeExecutionResult,
} from '../src/types/plugin';

/** 默认是节点工具；自定义节点可显式指定输入和结果类型。 */
declare global {
  function definePlugin<Input extends NodePluginInvocationInput | PluginNodeInvocationInput = NodePluginInvocationInput>(definition: {
    tools: Record<string, (input: Input) =>
      (Input extends PluginNodeInvocationInput ? PluginNodeExecutionResult : NodePluginExecutionResult)
      | PromiseLike<Input extends PluginNodeInvocationInput ? PluginNodeExecutionResult : NodePluginExecutionResult>>;
  }): void;
}

export type * from '../src/types/plugin';

/**
 * video.replicaPipeline：runEffect(video.replicaJob.start) 接受整个本地视频任务。
 * 模型目录 videoCapability 用于分段预览；宿主按实际配置再次预检。
 * 接受后只用返回 jobId 查询/停止；不得沿用 UI resourceId 或引用 token 执行后台步骤。
 * 原音保留、模型声音和静音分别由 audioMode 指定；转写是分段文本，不是声音克隆。
 * speechModelsRequired 表示等待用户明确下载；停止后续段不重投已经提交的生成。
 */

/**
 * prompt.mentions 返回候选标签与调用级 token；声明 prompt.references.read + prompt.mentions。
 * 可选 preview:true 提供宿主生成的有界 thumbnailDataUrl、裁剪矩形和小标，不返回路径或原图地址。
 * thumbnailDataUrl 仅用于选择器展示；不得把预览或其像素当作原始生成参考图。
 * 在提示词中保留返回的 opaque token，宿主负责解析正文和参考图；不要自行构造 @node/@drama/@asset。
 */

/**
 * 视频生成沿用 PluginNodeSetItem.generation：只提交安全模型目录 ID 与白名单 parameters。
 * 声明 output.generateVideos 后，宿主创建 idle 视频节点并启动持久化批次；无需 UI 轮询。
 * 参考图与控制视频用同批 edges 连接，不提交 provider、工作流 JSON、资源 URL 或文件路径。
 */

/** 可信 Python 最终回包的产物声明；Rust 验收后才替换为宿主的 artifacts 引用。 */
export interface PythonMediaArtifactDeclaration {
  key: string;
  /** nativeMedia.outputDir 中的普通 MP4 文件名，禁止路径与子目录。 */
  fileName: string;
  mediaType: 'video/mp4';
}

/** 仅原生在获准的 Python 调用中注入，不来自普通 UI 参数且不可持久化。 */
export interface PythonNativeMediaWorkspace {
  inputFiles: Record<string, string>;
  outputDir: string;
}
