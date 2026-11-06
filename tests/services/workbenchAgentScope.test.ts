import { describe, expect, it } from 'vitest';
import type { AgentTask } from '../../src/types/agent';
import {
  isWorkbenchAgentTaskInScope,
  WORKBENCH_AGENT_READ_TOOLS,
  type WorkbenchAgentScopeState,
} from '../../src/services/episodeWorkspaceScope';

function fixture(): { state: WorkbenchAgentScopeState; task: AgentTask } {
  const task = {
    id: 'workbench-task', projectId: 'episode-b', conversationId: 'conversation',
    status: 'waiting_tool', workbenchTarget: { seriesId: 'series', episodeId: 'episode-b' },
    toolAllowlist: [...WORKBENCH_AGENT_READ_TOOLS],
  } as AgentTask;
  return { task, state: {
    currentProjectId: 'episode-a', projectLoadStatus: 'ready', isCreatingProject: false,
    isReturningToStartPage: false, switchingProjectName: null,
    conversations: [{ id: 'conversation', projectId: 'series', workbenchTarget: task.workbenchTarget }], agentTasks: [task],
    projects: [
      { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-a', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-b', parentId: 'series', name: '第二集', createdAt: 1, updatedAt: 1 },
      { id: 'other', name: '另一项目', createdAt: 1, updatedAt: 1 },
    ],
  } };
}

describe('工作台自动创作的只读任务范围', () => {
  it('只为明确绑定的同剧集目标开放固定只读工具，不切画布分集', () => {
    const { state, task } = fixture();
    for (const toolId of WORKBENCH_AGENT_READ_TOOLS) {
      expect(isWorkbenchAgentTaskInScope(state, task, toolId)).toBe(true);
    }
    expect(isWorkbenchAgentTaskInScope(state, task, 'canvas_query')).toBe(false);
    expect(isWorkbenchAgentTaskInScope(state, task, 'episode_update_script')).toBe(false);
    expect(state.currentProjectId).toBe('episode-a');
    expect(isWorkbenchAgentTaskInScope(state, { ...task, workbenchTarget: undefined })).toBe(false);
    expect(isWorkbenchAgentTaskInScope(state, { ...task, projectId: 'episode-a' })).toBe(false);
  });

  it('拒绝混入写工具或缺少固定allowlist，即使目标就是当前画布', () => {
    const { state, task } = fixture();
    state.currentProjectId = task.projectId;
    expect(isWorkbenchAgentTaskInScope(state, { ...task, toolAllowlist: undefined })).toBe(false);
    expect(isWorkbenchAgentTaskInScope(state, {
      ...task, toolAllowlist: [...task.toolAllowlist!, 'episode_update_script'],
    })).toBe(false);
    expect(isWorkbenchAgentTaskInScope(state, {
      ...task, workbenchTarget: { seriesId: 'other', episodeId: task.projectId },
    })).toBe(false);
  });

  it('切离剧集、加载中、删除或更改会话归属后立即失效', () => {
    const { state, task } = fixture();
    expect(isWorkbenchAgentTaskInScope({ ...state, currentProjectId: 'other' }, task)).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, projectLoadStatus: 'loading' }, task)).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, switchingProjectName: '切换中' }, task)).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, conversations: [{ id: 'conversation', projectId: 'series', deletedAt: 1 }] }, task)).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, conversations: [{ id: 'conversation', projectId: 'other' }] }, task)).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, conversations: [{ id: 'conversation', projectId: 'series' }] }, task)).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, conversations: [{ id: 'conversation', projectId: 'series',
      workbenchTarget: { seriesId: 'series', episodeId: 'episode-a' } }] }, task)).toBe(false);
  });

  it('子任务只继承活动父任务的同一目标和更小工具集合', () => {
    const { state, task: parent } = fixture();
    const child = { ...parent, id: 'child', parentTaskId: parent.id, toolAllowlist: ['episode_read', 'skill_load'] };
    state.agentTasks = [parent, child];
    expect(isWorkbenchAgentTaskInScope(state, child, 'episode_read')).toBe(true);
    expect(isWorkbenchAgentTaskInScope(state, child, 'skill_search')).toBe(false);
    expect(isWorkbenchAgentTaskInScope(state, { ...child, conversationId: 'other' })).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, agentTasks: [] }, child)).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, agentTasks: [{ ...parent, status: 'paused' }, child] }, child)).toBe(false);
    expect(isWorkbenchAgentTaskInScope({ ...state, agentTasks: [{ ...parent, toolAllowlist: ['episode_read'] }, child] }, child)).toBe(false);
  });
});
