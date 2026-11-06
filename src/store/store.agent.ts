/**
 * Agent Slice — 可持久化任务状态。
 *
 * 运行时 AbortController 和活动 Promise 将由后续 Agent Runtime 单独管理，
 * 不进入 Zustand 持久化快照或 IndexedDB。
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import {
  DEFAULT_AGENT_TASK_BUDGET,
  DEFAULT_AGENT_TASK_METRICS,
  type AgentMode,
  type AgentExpertRole,
  type AgentSkillBinding,
  type AgentTask,
  type AgentTaskBudget,
  type AgentTaskFocusRequest,
  type McpOperationRecord,
} from '../types/agent';
import type { McpOperationClaim } from '../services/indexedDbService';
import * as agentTaskService from '../services/chat/agentTaskService';
import { emitAgentLifecycleEvent } from '../services/chat/agentLifecycle';
import type { CreationProfileSnapshot } from '../types/creationProfile';

export interface CreateAgentTaskInput {
  /** 仅宿主团队入口用于同一发起请求的稳定身份。 */
  taskId?: string;
  executionKind?: 'team';
  teamRequestDigest?: string;
  projectId: string;
  conversationId: string;
  userMessageId: string;
  mode: AgentMode;
  goal: string;
  budget?: Partial<AgentTaskBudget>;
  toolAllowlist?: string[];
  skillBindings?: AgentSkillBinding[];
  creationProfile?: CreationProfileSnapshot;
  creationProfilePreparation?: AgentTask['creationProfilePreparation'];
  parentTaskId?: string;
  expertRole?: AgentExpertRole;
  expertDepth?: 1;
}

export interface AgentSlice {
  agentTaskFocus: AgentTaskFocusRequest | null;
  focusAgentTask: (taskId: string) => void;
  agentTasks: AgentTask[];
  createAgentTask: (input: CreateAgentTaskInput) => AgentTask;
  claimMcpAgentTask: (input: CreateAgentTaskInput, operation: McpOperationRecord) => Promise<McpOperationClaim>;
  applyPersistedMcpOperation: (taskId: string, operation: McpOperationRecord) => void;
  upsertAgentTask: (task: AgentTask) => void;
  updateAgentTask: (id: string, partial: Partial<AgentTask>) => void;
  removeAgentTask: (id: string) => void;
  removeConversationAgentTasks: (conversationId: string) => void;
  removeProjectAgentTasks: (projectId: string) => void;
  loadAgentTasksForProject: (projectId: string) => Promise<void>;
  repairInterruptedAgentTasksForProject: (projectId: string) => Promise<string[]>;
  clearAgentTasks: () => void;
}

function persistTask(task: AgentTask): void {
  agentTaskService.saveAgentTask(task).catch((error) => {
    console.warn('[agent.persist] 保存任务失败:', error);
  });
}

function createTaskId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildAgentTask(input: CreateAgentTaskInput, mcpOperation?: McpOperationRecord): AgentTask {
  const now = Date.now();
  const taskId = input.taskId ?? createTaskId();
  return {
    id: taskId, projectId: input.projectId, conversationId: input.conversationId,
    userMessageId: input.userMessageId, mode: input.mode, goal: input.goal,
    executionKind: input.executionKind,
    teamRequestDigest: input.teamRequestDigest,
    creationProfile: input.creationProfile ? structuredClone(input.creationProfile) : undefined,
    creationProfilePreparation: input.creationProfilePreparation,
    status: 'queued', steps: [], modelRounds: 0, toolCallCount: 0, resumeCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET, ...input.budget },
    toolAllowlist: input.toolAllowlist ? [...new Set(input.toolAllowlist)] : undefined,
    skillBindings: input.skillBindings?.map((binding) => ({
      ...binding, allowedTools: binding.allowedTools ? [...binding.allowedTools] : undefined,
    })),
    parentTaskId: input.parentTaskId, expertRole: input.expertRole, expertDepth: input.expertDepth,
    events: [{ id: `${taskId}-event-0`, taskId, sequence: 0, type: 'task_queued', timestamp: now }],
    metrics: { ...DEFAULT_AGENT_TASK_METRICS }, createdAt: now, updatedAt: now,
    ...(mcpOperation ? { mcpOperation } : {}),
  };
}

export const createAgentSlice: StateCreator<AppState, [], [], AgentSlice> = (set) => ({
  agentTaskFocus: null,
  focusAgentTask: (taskId) => set((state) => ({ agentTaskFocus: {
    taskId, revision: (state.agentTaskFocus?.revision ?? 0) + 1,
  } })),
  agentTasks: [],

  createAgentTask: (input) => {
    const task = buildAgentTask(input);
    set((state) => ({ agentTasks: [...state.agentTasks, task] }));
    persistTask(task);
    emitAgentLifecycleEvent({
      type: 'task.status',
      taskId: task.id,
      projectId: task.projectId,
      conversationId: task.conversationId,
      status: task.status,
    });
    return task;
  },

  claimMcpAgentTask: async (input, operation) => {
    const result = await agentTaskService.claimMcpOperationTask(buildAgentTask(input, operation));
    if (result.task) {
      const task = result.task;
      set((state) => state.agentTasks.some((item) => item.id === task.id)
        ? {} : { agentTasks: [...state.agentTasks, task] });
      if (result.claimed) emitAgentLifecycleEvent({ type: 'task.status', taskId: task.id,
        projectId: task.projectId, conversationId: task.conversationId, status: task.status });
    }
    return result;
  },

  // 仅在对应回执事务已完成后调用；不触碰运行任务的状态/步骤，也不再发起异步保存。
  applyPersistedMcpOperation: (taskId, operation) => set((state) => ({
    agentTasks: state.agentTasks.map((task) => task.id === taskId
      && task.mcpOperation?.bindingId === operation.bindingId
      && task.mcpOperation.sequence <= operation.sequence ? { ...task, mcpOperation: operation } : task),
  })),

  upsertAgentTask: (task) => {
    const normalized = { ...task, updatedAt: task.updatedAt || Date.now() };
    set((state) => {
      const exists = state.agentTasks.some((item) => item.id === normalized.id);
      return {
        agentTasks: exists
          ? state.agentTasks.map((item) => (item.id === normalized.id ? normalized : item))
          : [...state.agentTasks, normalized],
      };
    });
    persistTask(normalized);
  },

  updateAgentTask: (id, partial) => {
    let changed: AgentTask | undefined;
    set((state) => ({
      agentTasks: state.agentTasks.map((task) => {
        if (task.id !== id) return task;
        changed = { ...task, ...partial, id: task.id, updatedAt: Date.now() };
        return changed;
      }),
    }));
    if (changed) persistTask(changed);
  },

  removeAgentTask: (id) => {
    set((state) => ({ agentTasks: state.agentTasks.filter((task) => task.id !== id) }));
    agentTaskService.removeAgentTask(id).catch((error) => {
      console.warn('[agent.persist] 删除任务失败:', error);
    });
  },

  removeConversationAgentTasks: (conversationId) => {
    set((state) => ({
      agentTasks: state.agentTasks.filter((task) => task.conversationId !== conversationId),
    }));
    agentTaskService.removeConversationAgentTasks(conversationId).catch((error) => {
      console.warn('[agent.persist] 清理会话任务失败:', error);
    });
  },

  removeProjectAgentTasks: (projectId) => {
    set((state) => ({
      agentTasks: state.agentTasks.filter((task) => task.projectId !== projectId),
    }));
    agentTaskService.removeProjectAgentTasks(projectId).catch((error) => {
      console.warn('[agent.persist] 清理项目任务失败:', error);
    });
  },

  loadAgentTasksForProject: async (projectId) => {
    try {
      const tasks = await agentTaskService.loadProjectAgentTasks(projectId);
      set((state) => {
        const loaded = new Map(tasks.filter((task) => task.projectId === projectId).map((task) => [task.id, task]));
        // 读库期间工作台团队仍可推进；迟到快照不能回退阶段/预算，同毫秒也以实时状态为准。
        for (const live of state.agentTasks) {
          if (live.projectId !== projectId) continue;
          const persisted = loaded.get(live.id);
          if (!persisted || live.updatedAt >= persisted.updatedAt) loaded.set(live.id, live);
        }
        return { agentTasks: [
          ...state.agentTasks.filter((task) => task.projectId !== projectId),
          ...loaded.values(),
        ] };
      });
    } catch (error) {
      console.warn('[agent] 加载项目任务失败:', error);
    }
  },

  repairInterruptedAgentTasksForProject: async (projectId) => {
    try {
      const repairedIds = await agentTaskService.repairInterruptedAgentTasks(projectId);
      const tasks = await agentTaskService.loadProjectAgentTasks(projectId);
      set((state) => ({
        agentTasks: [
          ...state.agentTasks.filter((task) => task.projectId !== projectId),
          ...tasks,
        ],
      }));
      return repairedIds;
    } catch (error) {
      console.warn('[agent] 修复中断任务失败:', error);
      return [];
    }
  },

  clearAgentTasks: () => set({ agentTasks: [], agentTaskFocus: null }),
});
