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
  context: Pick<AgentToolContext, 'executionContext' | 'projectScope'>, input?: unknown): boolean {
  const target = context.executionContext ?? context.projectScope;
  if (!target) return true;
  const requirement = getMcpProjectContextRequirement(tool);
  if (requirement === 'global') return true;
  if (requirement === 'canvas') return target.kind === 'canvas';
  if (requirement === 'episode') {
    const episodeId = input && typeof input === 'object' ? (input as Record<string, unknown>).episodeId : undefined;
    if (target.kind === 'episode') return episodeId === undefined || episodeId === target.episodeId;
    // 未携v2请求条件的旧画布任务仍可操作当前集；显式v2正文写要求episode条件。
    return !context.executionContext && target.kind === 'canvas' && target.episodeId !== null
      && (episodeId === undefined || episodeId === target.episodeId);
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
  if (explicit && explicit.modelGeneration !== 0) throw new ProjectExecutionContextError('PROJECT_MODEL_EXECUTION_DISABLED');
  if (explicit && !isProjectExpectedContextCurrent(explicit, state, { checkCanvasRevision: options.checkRevision !== false })) {
    throw new ProjectExecutionContextError();
  }
  if (context.projectScope) {
    const scope = parseProjectExpectedContext(context.projectScope);
    if (scope.modelGeneration !== 0) throw new ProjectExecutionContextError('PROJECT_MODEL_EXECUTION_DISABLED');
    if (scope.kind === 'global') return; // 普通全局对话不因无关目录变化中断；显式请求仍核上方catalog条件。
    // 已持久化的legacy任务可经显式继续恢复；不把旧进程epoch当成新租约，
    // 原Canvas/owner和持久epoch必须仍匹配，计数/回执原样保留。
    if (!isProjectExpectedContextCurrent(scope, state, { checkCanvasRevision: false, checkRuntimeEpoch: false })) {
      throw new ProjectExecutionContextError();
    }
  }
}
