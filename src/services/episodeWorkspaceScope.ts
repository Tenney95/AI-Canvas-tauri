/** 工作台只能操作当前已加载剧集中的明确分集；不授予该分集的画布权限。 */
import type { CanvasProject } from '../types';
import type { AgentTask } from '../types/agent';

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
