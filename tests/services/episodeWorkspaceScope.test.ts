import { describe, expect, it } from 'vitest';
import type { AgentTask } from '../../src/types/agent';
import { readEpisodeWorkspaceScope, isWorkbenchTeamTaskInScope, type EpisodeWorkspaceState } from '../../src/services/episodeWorkspaceScope';

const scope = (): EpisodeWorkspaceState => ({
  currentProjectId: 'episode-a', projectLoadStatus: 'ready', isCreatingProject: false,
  isReturningToStartPage: false, switchingProjectName: null,
  projects: [
    { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
    { id: 'episode-a', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 },
    { id: 'episode-b', parentId: 'series', name: '第二集', createdAt: 1, updatedAt: 1 },
    { id: 'other', name: '另一项目', createdAt: 1, updatedAt: 1 },
  ],
});

describe('工作台分集范围', () => {
  it('允许已加载同剧集的明确目标，不改变画布当前集', () => {
    const state = scope();
    expect(readEpisodeWorkspaceScope(state, 'episode-b')).toMatchObject({
      episode: { id: 'episode-b' }, owner: { id: 'series' }, canvasProjectId: 'episode-a',
    });
    expect(state.currentProjectId).toBe('episode-a');
    expect(readEpisodeWorkspaceScope(state, 'series')).toBeNull();
  });

  it('跨剧集、切换中、父项目缺失和非ready均拒绝', () => {
    const state = scope();
    expect(readEpisodeWorkspaceScope({ ...state, currentProjectId: 'other' }, 'episode-b')).toBeNull();
    expect(readEpisodeWorkspaceScope({ ...state, switchingProjectName: '切换中' }, 'episode-b')).toBeNull();
    expect(readEpisodeWorkspaceScope({ ...state, projectLoadStatus: 'loading' }, 'episode-b')).toBeNull();
    expect(readEpisodeWorkspaceScope({ ...state, projects: state.projects.filter((project) => project.id !== 'series') }, 'episode-b')).toBeNull();
  });

  it('团队例外只接受工作台来源和精确目标，不放宽其他工具', () => {
    const task = { id: 'task', projectId: 'episode-b', executionKind: 'team', teamRun: {
      id: 'task', source: 'script-workbench', target: { kind: 'episode', episodeId: 'episode-b', seriesId: 'series' },
    } } as AgentTask;
    expect(isWorkbenchTeamTaskInScope(scope(), task)).toBe(true);
    expect(isWorkbenchTeamTaskInScope(scope(), task, 'agent_team_apply_result')).toBe(true);
    expect(isWorkbenchTeamTaskInScope(scope(), task, 'canvas_create_nodes')).toBe(false);
    expect(isWorkbenchTeamTaskInScope(scope(), { ...task, teamRun: { ...task.teamRun!, source: 'assistant' } })).toBe(false);
    expect(isWorkbenchTeamTaskInScope(scope(), { ...task, projectId: 'episode-a' })).toBe(false);
  });
});
