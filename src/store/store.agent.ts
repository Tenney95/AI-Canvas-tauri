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
  type AgentMode,
  type AgentTask,
  type AgentTaskBudget,
} from '../types/agent';
import * as agentTaskService from '../services/chat/agentTaskService';

export interface CreateAgentTaskInput {
  projectId: string;
  conversationId: string;
  userMessageId: string;
  mode: AgentMode;
  goal: string;
  budget?: Partial<AgentTaskBudget>;
}

export interface AgentSlice {
  agentTasks: AgentTask[];
  createAgentTask: (input: CreateAgentTaskInput) => AgentTask;
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

export const createAgentSlice: StateCreator<AppState, [], [], AgentSlice> = (set) => ({
  agentTasks: [],

  createAgentTask: (input) => {
    const now = Date.now();
    const taskId = createTaskId();
    const task: AgentTask = {
      id: taskId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      mode: input.mode,
      goal: input.goal,
      status: 'queued',
      steps: [],
      modelRounds: 0,
      toolCallCount: 0,
      budget: {
        ...DEFAULT_AGENT_TASK_BUDGET,
        ...input.budget,
      },
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({ agentTasks: [...state.agentTasks, task] }));
    persistTask(task);
    return task;
  },

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
      set((state) => ({
        agentTasks: [
          ...state.agentTasks.filter((task) => task.projectId !== projectId),
          ...tasks,
        ],
      }));
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

  clearAgentTasks: () => set({ agentTasks: [] }),
});
