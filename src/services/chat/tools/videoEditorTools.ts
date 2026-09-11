/** MCP 剪辑能力只接收节点与工程 ID，复用现有合成器，不接收脚本或任意媒体地址。 */
import { useAppStore } from '../../../store/useAppStore';
import { registerAgentTool, type AgentToolContext, type AgentToolEffect, type AgentToolExecutionResult } from '../toolRegistry';
import type { AgentToolSchema } from '../agentToolSchemas';
import type { VideoEditorCreateInput, VideoEditorExportInput, VideoEditorUpdateInput } from '../../../types/videoEditorControl';

const id: AgentToolSchema = { type: 'string', minLength: 1, maxLength: 200 };
const name: AgentToolSchema = { type: 'string', minLength: 1, maxLength: 120 };
const version: AgentToolSchema = { type: 'string', minLength: 64, maxLength: 64 };
const number = (minimum: number, maximum: number): AgentToolSchema => ({ type: 'number', minimum, maximum });
const object = (properties: Record<string, AgentToolSchema>, required: string[] = []): AgentToolSchema => (
  { type: 'object', additionalProperties: false, properties, required }
);
const timestamps: AgentToolSchema = { type: 'array', minItems: 1, maxItems: 6, items: number(0, 7200) };
const target = { editorId: id };
const expectedTarget = { ...target, expectedVersion: version };
const clipSchema = object({
  id, kind: { type: 'string', enum: ['video', 'image', 'text'] }, nodeId: id,
  timelineStart: number(0, 300), sourceIn: number(0, 7200), sourceOut: number(0.001, 7500),
  transform: object({ x: number(-2, 3), y: number(-2, 3), scale: number(0.01, 5), rotation: number(-360, 360),
    opacity: number(0, 1) }, ['x', 'y', 'scale', 'rotation', 'opacity']),
  transitionIn: object({ kind: { type: 'string', enum: ['none', 'fade', 'dissolve'] }, duration: number(0, 5) }, ['kind', 'duration']),
  volume: number(0, 4),
  volumePoints: { type: 'array', maxItems: 40, items: object({ t: number(0, 300), gain: number(0, 4) }, ['t', 'gain']) },
  textStyle: object({ content: { type: 'string', minLength: 1, maxLength: 2000 },
    fontFamily: { type: 'string', minLength: 1, maxLength: 100 }, fontSize: number(8, 240),
    color: { type: 'string', minLength: 7, maxLength: 9 }, fontWeight: { type: 'integer', enum: [400, 600, 700] },
    align: { type: 'string', enum: ['left', 'center', 'right'] } }, ['content']),
}, ['id', 'kind', 'timelineStart', 'sourceIn', 'sourceOut']);
const tracks: AgentToolSchema = { type: 'array', minItems: 1, maxItems: 8, items: object({
  id, kind: { type: 'string', enum: ['video', 'audio'] }, name,
  muted: { type: 'boolean' }, hidden: { type: 'boolean' }, locked: { type: 'boolean' }, overlay: { type: 'boolean' },
  volume: number(0, 4), clips: { type: 'array', maxItems: 120, items: clipSchema },
}, ['id', 'kind', 'name', 'clips']) };

function success(value: unknown, summary: string): AgentToolExecutionResult {
  return { status: 'success', summary, modelContent: JSON.stringify(value) };
}

/** 只展示控制层自身的短校验消息；底层原生异常不进入审计。 */
function failure(error: unknown): AgentToolExecutionResult {
  const message = error instanceof Error && error.name === 'VideoEditorControlError'
    ? error.message : '剪辑操作失败，请检查项目状态、媒体可用性和存储授权';
  return { status: 'error', summary: message, modelContent: message, errorCode: 'VIDEO_EDITOR_CONTROL_FAILED' };
}

function register<T>(toolId: string, title: string, description: string, effect: AgentToolEffect,
  inputSchema: AgentToolSchema, execute: (context: AgentToolContext, input: T) => Promise<AgentToolExecutionResult>) {
  return registerAgentTool<T>({ id: toolId, title, description, effect, inputSchema,
    isAvailable: (context) => context.conversationId.startsWith('mcp-control-'),
    authorize: (context) => ({ allowed: context.conversationId.startsWith('mcp-control-')
      && useAppStore.getState().currentProjectId === context.projectId, reason: '剪辑控制仅供当前项目的 MCP 会话使用' }),
    summarizeInput: () => title,
    execute: async (context, input) => { try { return await execute(context, input); } catch (error) { return failure(error); } },
  });
}

export function registerVideoEditorAgentTools(): Array<() => void> {
  return [
    register<Record<string, never>>('video_editor_list', '列出剪辑工程', '列出当前画布项目最近 50 个剪辑工程、版本与总时长，并给出总数及截断标记。', 'read', object({}), async (context) => {
      const api = await import('../../videoEditorControlService');
      return success(await api.listControlledEditors(context), '已列出剪辑工程');
    }),
    register<VideoEditorCreateInput>('video_editor_create', '创建剪辑时间轴',
      '从有结果的图片/视频节点或分镜表创建独立剪辑工程，不打开窗口。nodeIds 与 shotlistNodeId 二选一；主轨顺序排列，图片默认停留 3 秒。', 'file_write',
      object({ name, nodeIds: { type: 'array', minItems: 1, maxItems: 64, items: id }, shotlistNodeId: id,
        includeDialogueCaptions: { type: 'boolean' } }), async (context, input) => {
        const api = await import('../../videoEditorControlService');
        return success(await api.createControlledEditor(context, input), '已创建剪辑时间轴');
      }),
    register<{ editorId: string }>('video_editor_get', '读取剪辑时间轴',
      '读取可编辑的轨道、片段、文字、音量、输出规格与版本。不返回素材地址。', 'read', object(target, ['editorId']), async (context, input) => {
        const api = await import('../../videoEditorControlService');
        return success(await api.describeControlledEditor(await api.readControlledEditor(context, input.editorId)), '已读取时间轴');
      }),
    register<VideoEditorUpdateInput>('video_editor_update', '编辑剪辑时间轴',
      '按 expectedVersion 原子更新。tracks 是完整替换：首轨为主视频轨并自动连续排列；后续为叠加轨。裁切单位秒；文字用 video 轨的 text 片段；音乐用 audio 轨的 video 片段并绑定音频节点。支持淡入/叠化、位置/缩放/旋转/透明度、音量包络；最多 300 秒、8 轨、120 片段。', 'file_write',
      object({ ...expectedTarget, name, tracks, output: object({
        width: { type: 'integer', minimum: 64, maximum: 1920 }, height: { type: 'integer', minimum: 64, maximum: 1920 },
        frameRate: { type: 'integer', minimum: 1, maximum: 60 },
      }, ['width', 'height', 'frameRate']) }, ['editorId', 'expectedVersion']), async (context, input) => {
        const api = await import('../../videoEditorControlService');
        return success(await api.updateControlledEditor(context, input), '已更新剪辑时间轴');
      }),
    register<VideoEditorExportInput>('video_editor_export', '后台合成导出 MP4',
      '按已读取版本合成、校验并保存 MP4 到项目目录，再添加视频节点。返回 jobId，需查询直到成功。独立剪辑窗口须关闭；每次新导出使用唯一 requestKey，同 key 同版本重查不重复启动；本会话仅保留最近 30 个任务。导出期间不要切换项目或修改画布/工程。', 'canvas_write',
      object({ ...expectedTarget, requestKey: id }, ['editorId', 'expectedVersion', 'requestKey']), async (context, input) => {
        const api = await import('../../videoEditorExportService');
        return success(await api.startControlledExport(context, input), '已受理合成导出，请查询任务结果');
      }),
    register<{ jobId: string }>('video_editor_export_status', '查询合成导出',
      '读取当前项目的导出进度、阶段、错误或完成的视频节点。任务状态仅保留在应用会话内。', 'read', object({ jobId: id }, ['jobId']), async (context, input) => {
        const api = await import('../../videoEditorExportService');
        return success(api.getControlledExport(context, input.jobId), '已读取导出任务');
      }),
    register<{ jobId: string }>('video_editor_export_cancel', '取消合成导出',
      '请求取消后台合成；查询状态直到 cancelled、failed 或 succeeded。已经完成的任务保持原结果。', 'canvas_write', object({ jobId: id }, ['jobId']), async (context, input) => {
        const api = await import('../../videoEditorExportService');
        return success(api.cancelControlledExport(context, input.jobId), '已处理导出取消请求');
      }),
    register<{ nodeId: string }>('video_media_probe', '探测媒体参数',
      '读取当前视频或音频节点结果的真实时长、宽高、编码与视频可解码性。', 'read', object({ nodeId: id }, ['nodeId']), async (context, input) => {
        const api = await import('../../videoEditorInspectionService');
        return success(await api.probeControlledNode(context, input.nodeId), '已探测媒体参数');
      }),
    register<{ nodeId: string; timestamps: number[] }>('video_media_extract_frames', '按时间点抽帧验片',
      '从当前视频节点按 1 至 6 个严格递增的秒数取帧；返回实际样本时间与 JPEG 图像，图像不写入聊天或任务持久化。', 'read',
      object({ nodeId: id, timestamps }, ['nodeId', 'timestamps']), async (context, input) => {
        const api = await import('../../videoEditorInspectionService');
        const result = await api.inspectControlledNode(context, input.nodeId, input.timestamps);
        return { ...success(result.metadata, '已抽取验片帧'), mcpContent: [
          { type: 'text', text: JSON.stringify(result.metadata) }, ...result.images,
        ] };
      }),
    register<{ editorId: string; expectedVersion: string; timestamps: number[] }>('video_editor_preview', '预览时间轴合成画面',
      '按工程版本渲染 1 至 6 个指定时间点，复用真实合成器显示文字、转场与叠加，返回 JPEG，不生成视频或写文件。', 'read',
      object({ ...expectedTarget, timestamps }, ['editorId', 'expectedVersion', 'timestamps']), async (context, input) => {
        const api = await import('../../videoEditorExportService');
        const result = await api.previewControlledEditor(context, input.editorId, input.expectedVersion, input.timestamps);
        return { ...success(result.metadata, '已渲染合成预览'), mcpContent: [
          { type: 'text', text: JSON.stringify(result.metadata) }, ...result.images,
        ] };
      }),
  ];
}
