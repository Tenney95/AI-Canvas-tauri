/**
 * Memory Slice — 用户确认的项目记忆（P3-D2）。
 *
 * Agent 只能提出候选，用户确认后由此 slice 写入并持久化。
 * 记忆按项目隔离，禁用或删除后不再进入模型上下文。
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import {
  PROJECT_MEMORY_MAX_PER_PROJECT,
  type ProjectMemory,
  type ProjectMemoryKind,
  type ProjectMemorySource,
} from '../types/memory';
import * as projectMemoryService from '../services/chat/projectMemoryService';

export interface CreateProjectMemoryInput {
  projectId: string;
  kind: ProjectMemoryKind;
  content: string;
  source: ProjectMemorySource;
}

export interface MemorySlice {
  projectMemories: ProjectMemory[];
  createProjectMemory: (input: CreateProjectMemoryInput) => ProjectMemory;
  updateProjectMemory: (id: string, partial: Partial<Pick<ProjectMemory, 'content' | 'kind' | 'enabled'>>) => void;
  removeProjectMemory: (id: string) => void;
  loadProjectMemoriesForProject: (projectId: string) => Promise<void>;
  removeProjectMemories: (projectId: string) => void;
  markConversationMemorySourceUnavailable: (conversationId: string) => void;
  clearProjectMemories: () => void;
}

function persistMemory(memory: ProjectMemory): void {
  projectMemoryService.saveProjectMemory(memory).catch((error) => {
    console.warn('[memory.persist] 保存记忆失败:', error);
  });
}

function createMemoryId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const createMemorySlice: StateCreator<AppState, [], [], MemorySlice> = (set) => ({
  projectMemories: [],

  createProjectMemory: (input) => {
    const now = Date.now();
    const memory: ProjectMemory = {
      id: createMemoryId(),
      projectId: input.projectId,
      kind: input.kind,
      content: projectMemoryService.sanitizeMemoryContent(input.content),
      enabled: true,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => {
      // 超出上限时淘汰同项目最旧的一条，避免无限增长
      const projectMemories = state.projectMemories.filter((m) => m.projectId === input.projectId);
      let next = [...state.projectMemories, memory];
      if (projectMemories.length + 1 > PROJECT_MEMORY_MAX_PER_PROJECT) {
        const oldest = projectMemories
          .slice()
          .sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (oldest) {
          next = next.filter((m) => m.id !== oldest.id);
          projectMemoryService.removeProjectMemory(oldest.id).catch(() => { /* 尽力清理 */ });
        }
      }
      return { projectMemories: next };
    });
    persistMemory(memory);
    return memory;
  },

  updateProjectMemory: (id, partial) => {
    let changed: ProjectMemory | undefined;
    set((state) => ({
      projectMemories: state.projectMemories.map((memory) => {
        if (memory.id !== id) return memory;
        changed = {
          ...memory,
          ...partial,
          content: partial.content !== undefined
            ? projectMemoryService.sanitizeMemoryContent(partial.content)
            : memory.content,
          id: memory.id,
          updatedAt: Date.now(),
        };
        return changed;
      }),
    }));
    if (changed) persistMemory(changed);
  },

  removeProjectMemory: (id) => {
    set((state) => ({ projectMemories: state.projectMemories.filter((m) => m.id !== id) }));
    projectMemoryService.removeProjectMemory(id).catch((error) => {
      console.warn('[memory.persist] 删除记忆失败:', error);
    });
  },

  loadProjectMemoriesForProject: async (projectId) => {
    try {
      const memories = await projectMemoryService.loadProjectMemories(projectId);
      set((state) => ({
        projectMemories: [
          ...state.projectMemories.filter((m) => m.projectId !== projectId),
          ...memories,
        ],
      }));
    } catch (error) {
      console.warn('[memory] 加载项目记忆失败:', error);
    }
  },

  removeProjectMemories: (projectId) => {
    set((state) => ({ projectMemories: state.projectMemories.filter((m) => m.projectId !== projectId) }));
    projectMemoryService.removeProjectMemories(projectId).catch((error) => {
      console.warn('[memory.persist] 清理项目记忆失败:', error);
    });
  },

  markConversationMemorySourceUnavailable: (conversationId) => {
    let touched = false;
    set((state) => ({
      projectMemories: state.projectMemories.map((memory) => {
        if (memory.source.conversationId !== conversationId || memory.source.unavailable) {
          return memory;
        }
        touched = true;
        return { ...memory, source: { ...memory.source, unavailable: true } };
      }),
    }));
    if (touched) {
      projectMemoryService.markConversationMemoriesUnavailable(conversationId).catch((error) => {
        console.warn('[memory.persist] 标记记忆来源不可用失败:', error);
      });
    }
  },

  clearProjectMemories: () => set({ projectMemories: [] }),
});
