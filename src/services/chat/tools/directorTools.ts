/** 外部助手分别调用 AI Canvas MCP 和 Blender MCP；此域不接收或转发 Blender Python。 */
import { useAppStore } from '../../../store/useAppStore';
import type { DirectorOperationOwner, DirectorSceneSource } from '../../../types/directorOperation';
import type { DirectorRuntimeKind } from '../../../types/directorScene';
import {
  cancelDirectorOperation,
  DirectorOperationError,
  getDirectorNodeState,
  getDirectorOperation,
  setDirectorNodeRuntime,
  startDirectorNodeOperation,
} from '../../directorNodeOperationService';
import { validateAgentToolInput, type AgentToolSchema } from '../agentToolSchemas';
import {
  registerAgentTool,
  type AgentToolContext,
  type AgentToolDefinition,
  type AgentToolExecutionResult,
} from '../toolRegistry';

interface NodeInput { nodeId: string }
interface OperationInput { operationId: string }

const idSchema: AgentToolSchema = { type: 'string', minLength: 1, maxLength: 160 };
const nodeSchema: AgentToolSchema = {
  type: 'object', properties: { nodeId: idSchema }, required: ['nodeId'], additionalProperties: false,
};
const operationSchema: AgentToolSchema = {
  type: 'object', properties: { operationId: idSchema }, required: ['operationId'], additionalProperties: false,
};

function isMcpContext(context: Pick<AgentToolContext, 'projectId' | 'conversationId'>): boolean {
  return !!context.projectId && context.conversationId === `mcp-control-${context.projectId}`;
}

function owner(context: AgentToolContext): DirectorOperationOwner {
  return { source: 'mcp', projectId: context.projectId, conversationId: context.conversationId, taskId: context.taskId };
}

function success(summary: string, data: unknown): AgentToolExecutionResult {
  return { status: 'success', summary, modelContent: JSON.stringify(data) };
}

function register<T>(definition: AgentToolDefinition<T>): () => void {
  const authorize: NonNullable<AgentToolDefinition<T>['authorize']> = (context) => ({
    allowed: isMcpContext(context) && useAppStore.getState().currentProjectId === context.projectId
      && (definition.effect === 'read' || context.baseRevision === useAppStore.getState().getCurrentRevision()),
    reason: '导演工具只对当前项目的 MCP 控制会话开放；画布变更后请重新读取状态',
  });
  return registerAgentTool({
    ...definition,
    isAvailable: isMcpContext,
    authorize,
    execute: async (context, input) => {
      try {
        if (!authorize(context, input).allowed) throw new DirectorOperationError('DIRECTOR_CONTEXT_CHANGED');
        if (!validateAgentToolInput(definition.inputSchema, input).valid) {
          throw new DirectorOperationError('DIRECTOR_INVALID_INPUT');
        }
        if (context.signal.aborted) throw new DirectorOperationError('DIRECTOR_CANCELLED');
        return await definition.execute(context, input);
      } catch (error) {
        const failure = error instanceof DirectorOperationError
          ? error : new DirectorOperationError('DIRECTOR_OPERATION_FAILED');
        return {
          status: 'error', summary: failure.message, errorCode: failure.code, retryable: false,
          modelContent: JSON.stringify({ error: { code: failure.code, message: failure.message } }),
        };
      }
    },
  });
}

export function registerDirectorAgentTools(): Array<() => void> {
  return [
    register<NodeInput>({
      id: 'director_get_state', title: '读取导演台状态', effect: 'read', inputSchema: nodeSchema,
      description: '读取一个导演节点的运行时、场景身份、当前任务和成果摘要，不打开 Blender，不返回文件路径。双 MCP 协作时，通过 Blender MCP 核对同一 jobId、sceneId、revision 和摘要后才编辑。',
      execute: async (context, input) => success('已读取导演台状态', { director: await getDirectorNodeState(input.nodeId, owner(context)) }),
    }),
    register<NodeInput & { runtimeKind: DirectorRuntimeKind }>({
      id: 'director_set_runtime', title: '选择导演运行时', effect: 'canvas_write',
      inputSchema: {
        ...nodeSchema, required: ['nodeId', 'runtimeKind'],
        properties: { nodeId: idSchema, runtimeKind: { type: 'string', enum: ['lightweight-web', 'blender'] } },
      },
      description: '为导演节点选择轻量导演台或 Blender；已有任务时拒绝切换。只更新画布选择，不安装或启动程序。',
      execute: async (context, input) => {
        setDirectorNodeRuntime(input.nodeId, input.runtimeKind, owner(context), context.baseRevision);
        return success('已选择导演运行时', { nodeId: input.nodeId, runtimeKind: input.runtimeKind });
      },
    }),
    ...([
      { id: 'director_open_blender', operation: 'open-editor', title: '打开 Blender 导演台', effect: 'file_write',
        description: '启动受管 Blender 编辑会话并返回 operationId，然后可用独立的 Blender MCP 搭建场景和动画。get_state 返回 supportsSavedScene=true 且已有成果时，默认保留保存工程的时间线、FPS、相机和当前帧；旧后端继续原有导演镜头表模式，明确请求 saved-blender 时返回升级要求。sceneSource=director-scene 明确重用导演镜头表。使用 Blender driver_namespace 中 ai_canvas_director_editor_session_v1 的 jobId、sceneId、sceneRevision、sceneSha256 核对当前任务，只读取这些身份字段。保存返回调用已有 ai_canvas.save_and_return，再查询完成状态；无安装时返回 setup-required。' },
      { id: 'director_render_frame', operation: 'render-frame', title: '导出 Blender 当前帧', effect: 'media_generation',
        description: '启动本地单帧渲染并返回 operationId，完成后图片回填。后端 supportsSavedScene=true 且已有成果时，默认使用保存的 Blender 工程，frame 缺省为保存时当前帧；否则沿用导演镜头表及其起始帧，也可明确 sceneSource=director-scene。明确 saved-blender 而后端不支持或没有成果时拒绝，编辑会话需先保存返回。目标帧必须位于所选来源的实际时间线内。不调用付费 AI 模型。' },
      { id: 'director_render_video', operation: 'render-video', title: '导出 Blender 参考视频', effect: 'media_generation',
        description: '启动本地视频渲染并返回 operationId，完成后回填导演台并创建视频节点。后端 supportsSavedScene=true 且已有成果时，默认保留保存的 Blender 工程起止帧、有效 FPS、活动相机及相机切换标记；否则沿用导演镜头表，也可明确 sceneSource=director-scene。明确 saved-blender 而后端不支持时返回升级要求。保存工程模式最多 14400 帧且最长 600 秒；结果提供实际时间线摘要。编辑会话需先保存返回。不调用付费 AI 模型。' },
    ] as const).map(({ id, operation, title, effect, description }) => register<NodeInput & { frame?: number; sceneSource?: DirectorSceneSource }>({
      id, title, effect, description,
      inputSchema: {
        ...nodeSchema,
        properties: {
          nodeId: idSchema,
          sceneSource: { type: 'string', enum: ['director-scene', 'saved-blender'] },
          ...(operation === 'render-frame' ? { frame: { type: 'integer', minimum: 0, maximum: 10_000_000 } as AgentToolSchema } : {}),
        },
      },
      execute: async (context, input) => {
        const snapshot = await startDirectorNodeOperation({ nodeId: input.nodeId, operation, frame: input.frame, sceneSource: input.sceneSource }, owner(context), {
          baseRevision: context.baseRevision, signal: context.signal,
        });
        return success(snapshot.state === 'succeeded' ? 'Blender 操作已完成并回传'
          : 'Blender 任务已受理，可继续调用 Blender MCP；请通过 director_get_operation 查询实际完成状态', { operation: snapshot });
      },
    })),
    register<OperationInput>({
      id: 'director_get_operation', title: '查询 Blender 任务', effect: 'read', inputSchema: operationSchema,
      description: '按 operationId 只读查询 Blender 任务、进度、jobId、场景身份和已回传的节点 ID。查询不收集文件也不写画布；只有 succeeded 才表示成果已验证并回传。记录仅在本次应用运行期间有效。',
      execute: async (context, input) => success('已读取 Blender 任务', { operation: getDirectorOperation(input.operationId, owner(context)) }),
    }),
    register<OperationInput>({
      id: 'director_cancel_operation', title: '取消 Blender 任务', effect: 'canvas_write', inputSchema: operationSchema,
      description: '取消所属导演台的受管 Blender 任务；cancelling 表示已请求取消，需要继续查询终态。不会关闭其他 Blender 进程。',
      execute: async (context, input) => success('已处理 Blender 取消请求', { operation: cancelDirectorOperation(input.operationId, owner(context)) }),
    }),
  ];
}
