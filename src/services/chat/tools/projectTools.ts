/**
 * 注册项目管理工具；只编排现有 Project Store Action，不复制持久化与清理事务。
 */
import { useAppStore } from '../../../store/useAppStore';
import { resolveOpenTargetId, seriesOwnerId } from '../../../store/store.utils';
import type { CanvasProject, ProjectSettings } from '../../../types';
import { isMcpGlobalToolContext } from '../../mcp/mcpSettingsScope';
import type { AgentToolSchema } from '../agentToolSchemas';
import {
  registerAgentTool,
  type AgentToolContext,
  type AgentToolExecutionResult,
} from '../toolRegistry';

interface ProjectIdInput {
  projectId: string;
}

interface ProjectListInput {
  limit?: number;
  offset?: number;
}

interface ProjectCreateInput {
  name?: string;
}

interface ProjectRenameInput extends ProjectIdInput {
  name: string;
}

interface ProjectSettingsPatch {
  visionModelId?: string;
  modelAutoRouting?: boolean;
  visualStyle?: {
    styleId?: string;
    styleName?: string;
    prompt?: string;
    locked?: boolean;
  };
  promptSuffixes?: Partial<Record<'text' | 'image' | 'video' | 'audio', string>>;
  defaultModels?: Partial<Record<'text' | 'image' | 'video' | 'audio', string>>;
  generation?: {
    imageAspectRatio?: string;
    imageSize?: string;
    videoAspectRatio?: string;
    videoResolution?: '480p' | '720p' | '1080p' | '4k';
    videoDuration?: number;
  };
}

interface ProjectUpdateSettingsInput {
  settings: ProjectSettingsPatch;
}

const emptySchema: AgentToolSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const projectIdSchema: AgentToolSchema = {
  type: 'object',
  required: ['projectId'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', minLength: 1, maxLength: 160 },
  },
};

const projectNameSchema: AgentToolSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 80,
};

const projectSettingsSchema: AgentToolSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    visionModelId: { type: 'string', maxLength: 240 },
    modelAutoRouting: { type: 'boolean' },
    visualStyle: {
      type: 'object',
      additionalProperties: false,
      properties: {
        styleId: { type: 'string', maxLength: 160 },
        styleName: { type: 'string', maxLength: 160 },
        prompt: { type: 'string', maxLength: 12_000 },
        locked: { type: 'boolean' },
      },
    },
    promptSuffixes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: 4_000 },
        image: { type: 'string', maxLength: 4_000 },
        video: { type: 'string', maxLength: 4_000 },
        audio: { type: 'string', maxLength: 4_000 },
      },
    },
    defaultModels: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: 240 },
        image: { type: 'string', maxLength: 240 },
        video: { type: 'string', maxLength: 240 },
        audio: { type: 'string', maxLength: 240 },
      },
    },
    generation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        imageAspectRatio: { type: 'string', maxLength: 32 },
        imageSize: { type: 'string', maxLength: 32 },
        videoAspectRatio: { type: 'string', maxLength: 32 },
        videoResolution: { type: 'string', enum: ['480p', '720p', '1080p', '4k'] },
        videoDuration: { type: 'integer', minimum: 1, maximum: 600 },
      },
    },
  },
};

function isMcpControlContext(context: { projectId: string; conversationId: string }) {
  return context.conversationId === `mcp-control-${context.projectId}`;
}

function authorizeCurrentProject(context: { projectId: string; conversationId: string }) {
  const store = useAppStore.getState();
  return {
    allowed: isMcpControlContext(context) && store.currentProjectId === context.projectId,
    reason: isMcpControlContext(context)
      ? 'MCP 请求所属项目已切换，请重新读取项目状态后再操作'
      : '项目管理工具只对 MCP 控制会话开放',
  };
}

function authorizeProjectNavigation(context: Omit<AgentToolContext, 'signal'>, toolName: string) {
  return isMcpGlobalToolContext(context, toolName)
    ? { allowed: true }
    : authorizeCurrentProject(context);
}

function resolveNavigationTarget(projects: CanvasProject[], requestedId: string, currentId: string | null) {
  // 与项目库一致：再次打开正在编辑的剧集时，保留当前分集。
  return currentId && projects.some((project) => project.id === currentId)
    && seriesOwnerId(projects, currentId) === requestedId
    ? currentId : resolveOpenTargetId(projects, requestedId);
}

function projectKind(project: CanvasProject, projects: CanvasProject[]) {
  if (project.parentId) return 'episode';
  return projects.some((candidate) => candidate.parentId === project.id)
    ? 'series'
    : 'project';
}

function safeProjectSummary(project: CanvasProject, projects: CanvasProject[], currentProjectId: string | null) {
  return {
    id: project.id,
    name: project.name.slice(0, 240),
    kind: projectKind(project, projects),
    current: project.id === currentProjectId,
    opened: project.id === currentProjectId
      || Boolean(currentProjectId && project.id === seriesOwnerId(projects, currentProjectId)),
    openTargetId: resolveNavigationTarget(projects, project.id, currentProjectId),
    parentId: project.parentId,
    episodeNo: project.episodeNo,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function safeProjectSettings(settings: ProjectSettings | undefined) {
  if (!settings) return undefined;
  return {
    visualStyle: settings.visualStyle
      ? {
          styleId: settings.visualStyle.styleId,
          styleName: settings.visualStyle.styleName,
          prompt: settings.visualStyle.prompt,
          locked: settings.visualStyle.locked,
          styleReference: settings.visualStyle.styleReference
            ? {
                fileName: settings.visualStyle.styleReference.fileName,
                enabled: settings.visualStyle.styleReference.enabled,
              }
            : undefined,
        }
      : undefined,
    promptSuffixes: settings.promptSuffixes,
    defaultModels: settings.defaultModels,
    visionModelId: settings.visionModelId,
    modelAutoRouting: settings.modelAutoRouting,
    generation: settings.generation,
  };
}

function success(summary: string, content: unknown): AgentToolExecutionResult {
  return {
    status: 'success',
    summary,
    modelContent: JSON.stringify(content),
  };
}

function failure(summary: string, errorCode: string): AgentToolExecutionResult {
  return {
    status: 'error',
    summary,
    modelContent: summary,
    errorCode,
    retryable: false,
  };
}

function projectListUnavailable(): AgentToolExecutionResult | undefined {
  const store = useAppStore.getState();
  if (store.projectLoadStatus === 'loading') return failure('项目列表尚在加载，请稍后重新读取', 'PROJECT_LIST_LOADING');
  if (store.projectLoadStatus === 'error' && store.projects.length === 0) {
    return failure('项目列表读取失败，请在应用中检查存储状态', 'PROJECT_LIST_UNAVAILABLE');
  }
}

async function openProject(context: AgentToolContext, input: ProjectIdInput): Promise<AgentToolExecutionResult> {
  if (context.signal.aborted) return failure('项目打开请求已取消', 'PROJECT_OPEN_CANCELLED');
  const store = useAppStore.getState();
  if (store.projectLoadStatus === 'loading' || store.isCreatingProject || store.isReturningToStartPage
    || store.switchingProjectName !== null) {
    return failure('项目正在加载、创建或切换，请等待完成后再操作', 'PROJECT_NAVIGATION_BUSY');
  }
  const project = store.projects.find((candidate) => candidate.id === input.projectId);
  if (!project) return failure('项目不存在，请重新读取 project_list', 'PROJECT_NOT_FOUND');
  const targetId = resolveNavigationTarget(store.projects, project.id, store.currentProjectId);
  const previousProjectId = store.currentProjectId;
  const alreadyOpen = previousProjectId === targetId && store.projectLoadStatus === 'ready';
  if (!alreadyOpen) {
    try {
      const openedId = await store.switchProject(targetId, { captureSnapshot: false, signal: context.signal });
      if (context.signal.aborted) return failure('项目打开请求已取消', 'PROJECT_OPEN_CANCELLED');
      const current = useAppStore.getState();
      if (openedId !== targetId || current.currentProjectId !== targetId || current.projectLoadStatus !== 'ready'
        || current.switchingProjectName !== null) {
        return failure('项目打开未完成，可能保存或加载失败，或已被其他切换接管；请重新读取项目列表', 'PROJECT_OPEN_FAILED');
      }
    } catch {
      return failure('项目打开失败，请在应用中检查存储状态后重新读取项目列表', 'PROJECT_OPEN_FAILED');
    }
  }
  const current = useAppStore.getState();
  // 只有成功后才收起项目库，失败时保留当前界面和画布。
  current.setProjectLibraryOpen(false);
  return success(alreadyOpen ? `项目“${project.name}”已打开` : `已打开项目“${project.name}”`, {
    requestedProjectId: input.projectId,
    previousProjectId,
    currentProjectId: current.currentProjectId,
    alreadyOpen,
    project: safeProjectSummary(
      current.projects.find((candidate) => candidate.id === targetId) ?? project,
      current.projects,
      current.currentProjectId,
    ),
  });
}

function mergeProjectSettings(
  current: ProjectSettings | undefined,
  patch: ProjectSettingsPatch,
): ProjectSettings {
  return {
    ...current,
    ...(patch.visionModelId !== undefined ? { visionModelId: patch.visionModelId } : {}),
    ...(patch.modelAutoRouting !== undefined ? { modelAutoRouting: patch.modelAutoRouting } : {}),
    ...(patch.visualStyle
      ? { visualStyle: { ...current?.visualStyle, ...patch.visualStyle } }
      : {}),
    ...(patch.promptSuffixes
      ? { promptSuffixes: { ...current?.promptSuffixes, ...patch.promptSuffixes } }
      : {}),
    ...(patch.defaultModels
      ? { defaultModels: { ...current?.defaultModels, ...patch.defaultModels } }
      : {}),
    ...(patch.generation
      ? { generation: { ...current?.generation, ...patch.generation } }
      : {}),
  };
}

export function registerProjectAgentTools(): Array<() => void> {
  return [
    registerAgentTool<ProjectListInput>({
      id: 'project_list',
      title: '列出项目',
      description: '启动页或画布中分页读取项目、剧集与分集列表，返回项目 ID、名称、当前打开状态与打开目标 ID；不返回目录、路径、快照或正文。用返回的 ID 调用 project_open 或 project_switch。',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 50。' },
          offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '默认 0；使用上次 nextOffset 继续。列表随项目增删变化。' },
        },
      },
      effect: 'read',
      isAvailable: isMcpControlContext,
      authorize: (context) => authorizeProjectNavigation(context, 'project_list'),
      execute: async (_context, input) => {
        const unavailable = projectListUnavailable();
        if (unavailable) return unavailable;
        const store = useAppStore.getState();
        const page = store.projects.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50));
        const nextOffset = (input.offset ?? 0) + page.length;
        const content = {
          currentProjectId: store.currentProjectId,
          currentRootProjectId: store.currentProjectId ? seriesOwnerId(store.projects, store.currentProjectId) : null,
          total: store.projects.length,
          returned: page.length,
          hasMore: nextOffset < store.projects.length,
          ...(nextOffset < store.projects.length ? { nextOffset } : {}),
          projects: page.map((project) => (
            safeProjectSummary(project, store.projects, store.currentProjectId)
          )),
        };
        return {
          ...success(`已列出 ${page.length} 个项目记录，共 ${store.projects.length} 个`, content),
          // 分页 JSON 通过瞬时通道返回，避免通用模型文本裁剪截断列表。
          mcpContent: [{ type: 'text', text: JSON.stringify(content) }],
        };
      },
    }),
    registerAgentTool<ProjectIdInput>({
      id: 'project_get',
      title: '读取项目详情',
      description: '读取指定项目的脱敏元数据与安全项目设置；分集详情会包含本集大纲。',
      inputSchema: projectIdSchema,
      effect: 'read',
      isAvailable: isMcpControlContext,
      authorize: (context, input) => {
        const current = authorizeProjectNavigation(context, 'project_get');
        if (!current.allowed) return current;
        return {
          allowed: useAppStore.getState().projects.some((project) => project.id === input.projectId),
          reason: '项目不存在',
        };
      },
      summarizeInput: (input) => `读取项目 ${input.projectId}`,
      execute: async (_context, input) => {
        const unavailable = projectListUnavailable();
        if (unavailable) return unavailable;
        const store = useAppStore.getState();
        const project = store.projects.find((candidate) => candidate.id === input.projectId);
        if (!project) return failure('项目不存在', 'PROJECT_NOT_FOUND');
        return success(`已读取项目“${project.name}”`, {
          ...safeProjectSummary(project, store.projects, store.currentProjectId),
          settings: safeProjectSettings(project.settings),
          episodeOutline: project.parentId ? project.episodeOutline : undefined,
          episodeCount: store.projects.filter((candidate) => candidate.parentId === project.id).length,
          hasSeriesScript: Boolean(project.series?.script?.trim()),
          hasOriginalWork: Boolean(project.series?.originalWork),
        });
      },
    }),
    registerAgentTool<ProjectCreateInput>({
      id: 'project_create',
      title: '创建项目',
      description: '使用既有项目事务创建并切换到新项目；创建前会保存当前项目。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: projectNameSchema },
      },
      effect: 'canvas_write',
      isAvailable: isMcpControlContext,
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `创建项目“${input.name?.trim() || '自动命名'}”`,
      execute: async (_context, input) => {
        const name = input.name?.trim();
        if (input.name !== undefined && !name) {
          return failure('项目名称不能为空', 'PROJECT_NAME_REQUIRED');
        }
        const id = await useAppStore.getState().createProject(name);
        if (!id) return failure('项目创建失败', 'PROJECT_CREATE_FAILED');
        const project = useAppStore.getState().projects.find((candidate) => candidate.id === id);
        return success(`已创建项目“${project?.name ?? id}”`, {
          id,
          name: project?.name,
          currentProjectId: useAppStore.getState().currentProjectId,
        });
      },
    }),
    registerAgentTool<ProjectRenameInput>({
      id: 'project_rename',
      title: '重命名项目',
      description: '通过既有重命名事务更新项目名称和相关数据目录映射。',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'name'],
        additionalProperties: false,
        properties: {
          projectId: projectIdSchema.properties!.projectId,
          name: projectNameSchema,
        },
      },
      effect: 'canvas_write',
      isAvailable: isMcpControlContext,
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `把项目 ${input.projectId} 重命名为“${input.name.trim()}”`,
      execute: async (_context, input) => {
        const name = input.name.trim();
        const project = useAppStore.getState().projects.find((candidate) => candidate.id === input.projectId);
        if (!project) return failure('项目不存在', 'PROJECT_NOT_FOUND');
        const renamed = await useAppStore.getState().renameProject(input.projectId, name);
        return renamed
          ? success(`已把项目重命名为“${name}”`, { projectId: input.projectId, name })
          : failure('项目重命名失败', 'PROJECT_RENAME_FAILED');
      },
    }),
    registerAgentTool<ProjectIdInput>({
      id: 'project_open',
      title: '打开项目',
      description: '从启动页或画布打开指定项目 ID，切走前保存当前项目；剧集默认打开第一集，再次打开当前剧集保留当前分集。返回实际打开的项目 ID，失败不会报告成功。',
      inputSchema: projectIdSchema,
      effect: 'canvas_write',
      isAvailable: isMcpControlContext,
      authorize: (context) => authorizeProjectNavigation(context, 'project_open'),
      summarizeInput: (input) => `打开项目 ${input.projectId}`,
      execute: openProject,
    }),
    registerAgentTool<ProjectIdInput>({
      id: 'project_switch',
      title: '切换项目',
      description: '按项目 ID 切换当前项目，与 project_open 共用保存和加载流程，启动页也可使用；剧集默认打开第一集，再次打开当前剧集保留当前分集。',
      inputSchema: projectIdSchema,
      effect: 'canvas_write',
      isAvailable: isMcpControlContext,
      authorize: (context) => authorizeProjectNavigation(context, 'project_switch'),
      summarizeInput: (input) => `切换到项目 ${input.projectId}`,
      execute: openProject,
    }),
    registerAgentTool<ProjectUpdateSettingsInput>({
      id: 'project_update_settings',
      title: '更新项目设置',
      description: '更新当前项目的风格、提示词后缀、默认模型、视觉理解模型、自动选型和生成默认值；不接受本地路径或任意配置字段。',
      inputSchema: {
        type: 'object',
        required: ['settings'],
        additionalProperties: false,
        properties: { settings: projectSettingsSchema },
      },
      effect: 'config_write',
      isAvailable: isMcpControlContext,
      authorize: authorizeCurrentProject,
      summarizeInput: () => '更新当前项目的安全生成设置',
      execute: async (context, input) => {
        const store = useAppStore.getState();
        const project = store.projects.find((candidate) => candidate.id === context.projectId);
        if (!project) return failure('当前项目不存在', 'PROJECT_NOT_FOUND');
        const settings = mergeProjectSettings(project.settings, input.settings);
        const updated = await store.updateProjectSettings(settings);
        return updated
          ? success(`已更新项目“${project.name}”的设置`, {
              projectId: project.id,
              settings: safeProjectSettings(settings),
            })
          : failure('项目设置保存失败', 'PROJECT_SETTINGS_UPDATE_FAILED');
      },
    }),
    registerAgentTool<Record<string, never>>({
      id: 'project_save',
      title: '保存当前项目',
      description: '通过既有项目保存队列持久化当前画布、分组与共享剧集资产。',
      inputSchema: emptySchema,
      effect: 'file_write',
      isAvailable: isMcpControlContext,
      authorize: authorizeCurrentProject,
      execute: async (context) => {
        const savedProjectId = await useAppStore.getState().saveCurrentProject();
        return savedProjectId === context.projectId
          ? success('当前项目已保存', { projectId: savedProjectId })
          : failure('项目保存失败', 'PROJECT_SAVE_FAILED');
      },
    }),
    registerAgentTool<ProjectIdInput>({
      id: 'project_delete',
      title: '永久删除项目',
      description: '永久删除项目及其关联项目域数据；删除剧集会级联删除分集。此操作不可撤销。',
      inputSchema: projectIdSchema,
      effect: 'permanent_delete',
      isAvailable: isMcpControlContext,
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `永久删除项目 ${input.projectId}`,
      execute: async (_context, input) => {
        const store = useAppStore.getState();
        const project = store.projects.find((candidate) => candidate.id === input.projectId);
        if (!project) return failure('项目不存在', 'PROJECT_NOT_FOUND');
        await store.deleteProject(input.projectId);
        if (useAppStore.getState().projects.some((candidate) => candidate.id === input.projectId)) {
          return failure('项目删除失败', 'PROJECT_DELETE_FAILED');
        }
        return success(`已永久删除项目“${project.name}”`, {
          projectId: project.id,
          currentProjectId: useAppStore.getState().currentProjectId,
        });
      },
    }),
  ];
}
