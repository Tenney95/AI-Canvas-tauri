/** 工作台只能操作当前已加载剧集中的明确分集；不授予该分集的画布权限。 */
import type { CanvasProject } from '../types';
import type { AgentTask } from '../types/agent';
import type { ChatConversation } from '../types/chat';

export interface EpisodeWorkspaceState {
  projects: CanvasProject[];
  currentProjectId: string | null;
  projectLoadStatus: 'loading' | 'ready' | 'error';
  isCreatingProject: boolean;
  isReturningToStartPage: boolean;
  switchingProjectName: string | null;
}

export function readEpisodeWorkspaceScope(state: EpisodeWorkspaceState, episodeId: string): {
  episode: CanvasProject; owner: CanvasProject; canvasProjectId: string;
} | null {
  if (!state.currentProjectId || state.projectLoadStatus !== 'ready' || state.isCreatingProject
    || state.isReturningToStartPage || state.switchingProjectName !== null) return null;
  const canvasProject = state.projects.find((project) => project.id === state.currentProjectId);
  const episode = state.projects.find((project) => project.id === episodeId);
  const owner = state.projects.find((project) => project.id === episode?.parentId);
  if (!canvasProject || !episode?.parentId || !owner || owner.parentId
    || (canvasProject.parentId ?? canvasProject.id) !== owner.id) return null;
  return { episode, owner, canvasProjectId: canvasProject.id };
}

export function isWorkbenchTeamTaskInScope(
  state: EpisodeWorkspaceState, task: AgentTask, toolId?: string,
): boolean {
  if (toolId !== undefined && !['agent_team_apply_result', 'agent_team_restore_result'].includes(toolId)) return false;
  const run = task.teamRun;
  const target = run?.target;
  if (task.executionKind !== 'team' || run?.id !== task.id || run.source !== 'script-workbench'
    || target?.kind !== 'episode' || target.episodeId !== task.projectId) return false;
  const scope = readEpisodeWorkspaceScope(state, target.episodeId);
  return !!scope && scope.owner.id === target.seriesId;
}

/** 工作台自动创作只读固定子集，不授予目标分集或当前分集的画布权限。 */
export const WORKBENCH_AGENT_READ_TOOLS = [
  'episode_read', 'skill_search', 'skill_load', 'skill_read_file',
  'agent_run_sub_agent', 'agent_result_read',
] as const;

export interface WorkbenchAgentScopeState extends EpisodeWorkspaceState {
  conversations: readonly Pick<ChatConversation, 'id' | 'projectId' | 'deletedAt' | 'workbenchTarget'>[];
  agentTasks: readonly AgentTask[];
}

function hasWorkbenchReadAllowlist(task: AgentTask): boolean {
  return Array.isArray(task.toolAllowlist)
    && task.toolAllowlist.every((toolId) => WORKBENCH_AGENT_READ_TOOLS.some((allowed) => allowed === toolId));
}

export function isWorkbenchAgentTaskInScope(
  state: WorkbenchAgentScopeState, task: AgentTask, toolId?: string,
): boolean {
  const target = task.workbenchTarget;
  if (!target || task.executionKind || task.mcpOperation || target.episodeId !== task.projectId
    || !hasWorkbenchReadAllowlist(task)
    || (toolId !== undefined && (!WORKBENCH_AGENT_READ_TOOLS.some((allowed) => allowed === toolId)
      || !task.toolAllowlist!.includes(toolId)))) return false;
  const scope = readEpisodeWorkspaceScope(state, target.episodeId);
  if (!scope || scope.owner.id !== target.seriesId
    || !state.conversations.some((conversation) => conversation.id === task.conversationId
      && conversation.projectId === target.seriesId && !conversation.deletedAt
      && conversation.workbenchTarget?.seriesId === target.seriesId
      && conversation.workbenchTarget.episodeId === target.episodeId)) return false;
  if (!task.parentTaskId) return true;
  const parent = state.agentTasks.find((item) => item.id === task.parentTaskId);
  return !!parent && !parent.parentTaskId && !parent.executionKind && !parent.mcpOperation
    && parent.projectId === task.projectId && parent.conversationId === task.conversationId
    && parent.workbenchTarget?.episodeId === target.episodeId
    && parent.workbenchTarget.seriesId === target.seriesId
    && ['planning', 'running', 'waiting_tool', 'waiting_approval'].includes(parent.status)
    && hasWorkbenchReadAllowlist(parent)
    && task.toolAllowlist!.every((allowed) => parent.toolAllowlist!.includes(allowed));
}
