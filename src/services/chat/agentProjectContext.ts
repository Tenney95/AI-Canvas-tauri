/** Agent只增执行前提，不重算旧任务ID、回执、父子关系或任何累计预算。 */
import type { AgentTask } from '../../types/agent';
import type { ProjectExpectedContext } from '../../types/project';
import type { ProjectExecutionContextState } from '../../types/projectExecutionContext';
import { isGeneralAssistantScope } from './assistantScope';
import { getMcpProjectContextRequirement } from '../mcp/mcpProjectContext';
import type { AgentToolContext, AgentToolDefinition } from './toolRegistry';
import { MCP_SETTINGS_SCOPE_ID } from '../mcp/mcpSettingsScope';
import {
  captureLegacyEpisodeContext, captureLegacyProjectExpectedContext,
  isProjectExpectedContextCurrent, parseProjectExpectedContext, ProjectExecutionContextError,
} from '../projectExecutionContext';

export function captureAgentProjectScope(state: ProjectExecutionContextState,
  task: Pick<AgentTask, 'projectId' | 'workbenchTarget'> & { teamRun?: Pick<NonNullable<AgentTask['teamRun']>, 'target'> }): ProjectExpectedContext | undefined {
  try {
    if (isGeneralAssistantScope(task.projectId)) return captureLegacyProjectExpectedContext(state, 'global');
    const target = task.workbenchTarget ?? task.teamRun?.target;
    if (target) {
      const selected = captureLegacyEpisodeContext(state, target.episodeId);
      return selected?.projectId === target.seriesId ? selected : undefined;
    }
    // 后台任务保留自己的旧Canvas身份，不能从当前显示的另一集取得epoch。
    if (!state.projects?.some((project) => project.id === task.projectId)) return undefined;
    return captureLegacyProjectExpectedContext({ ...state, currentProjectId: task.projectId,
      getCurrentRevision: () => state.currentProjectId === task.projectId ? state.getCurrentRevision() : 0 });
  } catch { return undefined; }
}

/** 旧任务缺显式字段时保留原工具合同；有类型上下文后禁止以空项目启动画布/付费能力。 */
export function isAgentToolProjectContextCompatible(tool: Pick<AgentToolDefinition, 'id' | 'effect'>,
  context: Pick<AgentToolContext, 'executionContext' | 'projectScope'>, input?: unknown,
  state?: ProjectExecutionContextState): boolean {
  const target = context.executionContext ?? context.projectScope;
  if (!target) return true;
  // 只开放已接耐久原回执的统一媒体入口；发现阶段无input，实际参数仍由authorize和Provider复核。
  if (target.modelGeneration > 0 && tool.effect === 'media_generation') {
    if (target.modelGeneration !== 1 || target.kind !== 'canvas' || tool.id !== 'media_generate') return false;
    if (input !== undefined && (!input || typeof input !== 'object' || !['image', 'video', 'audio'].includes(String((input as { kind?: unknown }).kind))
      || !['chat', 'canvas', 'both'].includes(String((input as { deliveryMode?: unknown }).deliveryMode)))) return false;
  }
  const requirement = getMcpProjectContextRequirement(tool);
  if (requirement === 'global') return true;
  if (requirement === 'canvas') return target.kind === 'canvas';
  if (requirement === 'episode') {
    const episodeId = input && typeof input === 'object' ? (input as Record<string, unknown>).episodeId : undefined;
    const resolvedId = typeof episodeId === 'string' && state
      ? captureLegacyEpisodeContext(state, episodeId)?.episodeId ?? episodeId : episodeId;
    if (target.kind === 'episode') return resolvedId === undefined || resolvedId === target.episodeId;
    // 未携v2请求条件的旧画布任务仍可操作当前集；显式v2正文写要求episode条件。
    return !context.executionContext && target.kind === 'canvas' && target.episodeId !== null
      && (resolvedId === undefined || resolvedId === target.episodeId);
  }
  // 通用助手的网页/文件/配置等能力仍由原白名单限制，不继承活动画布。
  return target.kind !== 'global' || tool.effect !== 'canvas_write' && tool.effect !== 'media_generation';
}
export function assertAgentProjectContext(state: ProjectExecutionContextState,
  context: { projectId?: string; executionContext?: ProjectExpectedContext; projectScope?: ProjectExpectedContext },
  options: { checkRevision?: boolean } = {}): void {
  if (!context.executionContext && !context.projectScope && state.projects !== undefined && context.projectId
    && !isGeneralAssistantScope(context.projectId) && context.projectId !== MCP_SETTINGS_SCOPE_ID) {
    // 旧任务只读适配失败时保留记录并停止，不能在loading/损坏关系中继承当前画布。
    throw new ProjectExecutionContextError();
  }
  const explicit = context.executionContext === undefined ? undefined : parseProjectExpectedContext(context.executionContext);
  if (explicit && !isProjectExpectedContextCurrent(explicit, state, { checkCanvasRevision: options.checkRevision !== false })) {
    throw new ProjectExecutionContextError();
  }
  if (context.projectScope) {
    const scope = parseProjectExpectedContext(context.projectScope);
    if (scope.kind === 'global') return; // 普通全局对话不因无关目录变化中断；显式请求仍核上方catalog条件。
    // 已持久化的legacy任务可经显式继续恢复；不把旧进程epoch当成新租约，
    // 原Canvas/owner和持久epoch必须仍匹配，计数/回执原样保留。
    // 新结构每次激活画布都会更换运行租约；切走后再切回也不能让旧回调复活。
    // 旧任务继续沿用原有重启语义，不更改其预算和回执。
    if (scope.modelGeneration > 0 && !scope.runtimeEpoch
      || !isProjectExpectedContextCurrent(scope, state, { checkCanvasRevision: false, checkRuntimeEpoch: scope.modelGeneration > 0 })) {
      throw new ProjectExecutionContextError();
    }
  }
}
