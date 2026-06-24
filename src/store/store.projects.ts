/**
 * Project slice — multi-project management, save/load/init via IndexedDB
 */
import type { Node, Edge } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData, CanvasProject } from '../types';
import { generateProjectId } from './store.utils';
import * as fileService from '../services/fileService';
import { resumePendingTasks, clearProjectTasks } from '../services/pollManager';

export interface ProjectSlice {
  projects: CanvasProject[];
  currentProjectId: string | null;
  projectName: string;
  _autoSaveFailedNotified?: boolean;
  setProjectName: (name: string) => void;
  createProject: (name?: string) => void;
  deleteProject: (id: string) => Promise<void>;
  switchProject: (id: string) => void;
  saveCurrentProject: () => Promise<string | undefined>;
  saveCurrentProjectSilent: () => Promise<string | undefined>;
  loadProject: () => Promise<void>;
  initFromDb: () => Promise<void>;
}

export const createProjectSlice: StateCreator<AppState, [], [], ProjectSlice> = (set, get) => ({
  projects: [
    { id: 'default', name: '默认画布', createdAt: Date.now(), updatedAt: Date.now() },
  ],
  currentProjectId: 'default',
  projectName: '新项目',

  setProjectName: (name) =>
    set((state) => ({
      projectName: name,
      projects: state.projects.map((p) =>
        p.id === state.currentProjectId ? { ...p, name } : p
      ),
    })),

  createProject: (name) => {
    const id = generateProjectId();
    let defaultName: string;
    if (name) {
      defaultName = name;
    } else {
      const existing = get().projects
        .filter((p) => p.id !== 'default')
        .map((p) => {
          const m = p.name.match(/^项目\s+(\d+)$/);
          return m ? parseInt(m[1], 10) : 0;
        });
      const nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 1;
      defaultName = `项目 ${nextNum}`;
    }
    const dataFolder = fileService.buildProjectFolderName(defaultName, id);
    const project: CanvasProject = {
      id,
      name: defaultName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dataFolder,
    };
    fileService.registerProjectFolder(id, dataFolder);
    set((state) => ({
      projects: [...state.projects, project],
      currentProjectId: project.id,
      projectName: project.name,
      nodes: [],
      edges: [],
      groups: [],
    }));
    fileService.saveProject({ ...project, nodes: [], edges: [], groups: [] }).catch((e) => console.warn('[创建项目] 保存失败:', e));
    fileService.ensureProjectDataDir(id).catch((e) => console.warn('[创建项目] 数据目录初始化失败:', e));
    setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
  },

  deleteProject: async (id) => {
    const state = get();
    const filtered = state.projects.filter((p) => p.id !== id);
    const isCurrent = state.currentProjectId === id;

    if (isCurrent && filtered.length === 1 && filtered[0]?.id === 'default') {
      const newId = generateProjectId();
      const now = Date.now();
      const newFolder = fileService.buildProjectFolderName('默认画布', newId);
      fileService.registerProjectFolder(newId, newFolder);
      set({
        projects: [{ id: newId, name: '默认画布', createdAt: now, updatedAt: now, dataFolder: newFolder }],
        currentProjectId: newId,
        projectName: '默认画布',
        nodes: [],
        edges: [],
        history: [],
        historyIndex: -1,
      });
      fileService.saveProject({ id: newId, name: '默认画布', createdAt: now, updatedAt: now, dataFolder: newFolder, nodes: [], edges: [] }).catch((e) => console.warn('[重建默认项目] 保存失败:', e));
      fileService.ensureProjectDataDir(newId).catch((e) => console.warn('[重建默认项目] 数据目录初始化失败:', e));
      setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
    } else {
      const nextId = isCurrent ? filtered[0]?.id ?? null : state.currentProjectId;
      const nextName = isCurrent ? filtered[0]?.name ?? '' : state.projectName;

      set({
        projects: filtered,
        currentProjectId: nextId,
        ...(isCurrent
          ? { projectName: nextName, nodes: [], edges: [], history: [], historyIndex: -1 }
          : {}),
      });

      if (isCurrent && nextId) {
        try {
          const data = await fileService.loadProjectData(nextId);
          if (data?.nodes) {
            set({
              nodes: data.nodes as Node<BaseNodeData>[],
              edges: (data.edges as Edge[]) || [],
            });
          }
          setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
        } catch { /* Keep empty canvas */ }
      }
    }

    clearProjectTasks(id);
    fileService.deleteProjectData(id).catch((e) => console.warn('[删除项目] 清理数据失败:', e));
    fileService.deleteProjectDataDir(id).catch((e) => console.warn('[删除项目] 清理目录失败:', e));
  },

  switchProject: async (id) => {
    await get().saveCurrentProject();
    // Clean up undo-trash dirs from the old project before switching
    await fileService.flushUndoTrashDirs();

    const project = get().projects.find((p) => p.id === id);
    if (!project) return;

    fileService.ensureProjectDataDir(id).catch((e) => console.warn('[切换项目] 数据目录初始化失败:', e));

    const data = await fileService.loadProjectData(id);
    if (data?.nodes) {
      set({
        currentProjectId: id,
        projectName: project.name,
        nodes: data.nodes as Node<BaseNodeData>[],
        edges: (data.edges as Edge[]) || [],
        groups: (data as any).groups || [],
        history: [],
        historyIndex: -1,
      });
    } else {
      set({
        currentProjectId: id,
        projectName: project.name,
        groups: [],
        nodes: [],
        edges: [],
        history: [],
        historyIndex: -1,
      });
    }
    // 恢复当前项目的待续轮询任务
    resumePendingTasks(id).catch((e) => console.warn('[切换项目] 恢复待续任务失败:', e));

    setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
  },

  saveCurrentProject: async () => {
    const { projects, currentProjectId, projectName, nodes, edges, showToast, groups } = get();
    const project = projects.find((p) => p.id === currentProjectId);
    if (!project) return undefined;
    try {
      const record = {
        id: currentProjectId!,
        name: projectName,
        createdAt: project.createdAt,
        updatedAt: Date.now(),
        dataFolder: project.dataFolder,
        nodes,
        edges,
        groups,
      };
      await fileService.saveProject(record);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === currentProjectId ? { ...p, updatedAt: Date.now(), name: projectName } : p
        ),
      }));
      showToast('项目已保存');
      return currentProjectId!;
    } catch (error) {
      console.error('Save failed:', error);
      showToast('保存失败', 'error');
      return undefined;
    }
  },

  /** 静默保存（不弹 toast），用于自动保存 */
  saveCurrentProjectSilent: async () => {
    const { projects, currentProjectId, projectName, nodes, edges, groups } = get();
    const project = projects.find((p) => p.id === currentProjectId);
    if (!project) return undefined;
    try {
      const record = {
        id: currentProjectId!,
        name: projectName,
        createdAt: project.createdAt,
        updatedAt: Date.now(),
        dataFolder: project.dataFolder,
        nodes,
        edges,
        groups,
      };
      await fileService.saveProject(record);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === currentProjectId ? { ...p, updatedAt: Date.now(), name: projectName } : p
        ),
      }));
      // 成功后重置失败通知标志
      set({ _autoSaveFailedNotified: false });
      return currentProjectId!;
    } catch (error) {
      console.warn('[自动保存] 保存失败:', error);
      // 首次失败才弹 toast，避免每 2 秒刷屏
      if (!get()._autoSaveFailedNotified) {
        get().showToast('自动保存失败，请手动保存 (Ctrl+S)', 'error');
        set({ _autoSaveFailedNotified: true });
      }
      return undefined;
    }
  },

  loadProject: async () => {
    try {
      const allProjects = await fileService.loadProjectsList();
      if (allProjects.length > 0) {
        const mapped: CanvasProject[] = allProjects.map((p) => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, dataFolder: p.dataFolder,
        }));
        fileService.registerProjectFolders(mapped);
        const current = get().currentProjectId;
        const exists = mapped.find((p) => p.id === current);
        const targetId = exists ? current : mapped[0].id;
        set({ projects: mapped, currentProjectId: targetId! });

        const data = await fileService.loadProjectData(targetId!);
        if (data) {
          set({
            projectName: data.name || '已加载项目',
            nodes: data.nodes as Node<BaseNodeData>[],
            edges: (data.edges as Edge[]) || [],
            groups: (data as any).groups || [],
            history: [],
            historyIndex: -1,
          });
        }
        // 恢复待续轮询任务
        resumePendingTasks(targetId!).catch((e) => console.warn('[加载项目] 恢复待续任务失败:', e));
      }
    } catch (error) {
      console.error('Load failed:', error);
    }
  },

  initFromDb: async () => {
    try {
      await Promise.all([get().loadConfig(), get().loadWorkflows(), get().loadPresets(), get().loadCustomStyles()]);

      const allProjects = await fileService.loadProjectsList();
      const valid = allProjects.filter((p) => p.id !== 'default');
      if (valid.length < allProjects.length) {
        fileService.deleteProjectData('default').catch((e) => console.warn('[初始化] 清理默认项目数据失败:', e));
      }
      let activeProjectId: string | null = null;
      if (valid.length > 0) {
        const mapped: CanvasProject[] = valid.map((p) => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, dataFolder: p.dataFolder,
        }));
        fileService.registerProjectFolders(mapped);
        mapped.sort((a, b) => b.updatedAt - a.updatedAt);
        const lastId = mapped[0].id;
        activeProjectId = lastId;

        const data = await fileService.loadProjectData(lastId);
        if (data) {
          set({
            projects: mapped,
            currentProjectId: lastId,
            projectName: data.name || '新项目',
            nodes: (data.nodes as Node<BaseNodeData>[]) || [],
            edges: (data.edges as Edge[]) || [],
            groups: (data as any).groups || [],
          });
        } else {
          set({ projects: mapped, currentProjectId: lastId, groups: [] });
        }
        fileService.ensureProjectDataDir(lastId).catch((e) => console.warn('[初始化] 数据目录初始化失败:', e));
      } else {
        const id = generateProjectId();
        activeProjectId = id;
        const now = Date.now();
        const dataFolder = fileService.buildProjectFolderName('默认画布', id);
        fileService.registerProjectFolder(id, dataFolder);
        const defaultProject = { id, name: '默认画布', createdAt: now, updatedAt: now, dataFolder, nodes: [], edges: [] };
        set({
          projects: [{ id, name: '默认画布', createdAt: now, updatedAt: now, dataFolder }],
          currentProjectId: id,
          projectName: '默认画布',
        });
        await fileService.saveProject(defaultProject).catch((e) => console.warn('[初始化] 创建默认项目失败:', e));
        fileService.ensureProjectDataDir(id).catch((e) => console.warn('[初始化] 数据目录初始化失败:', e));
      }
      // 恢复当前项目的待续轮询任务
      if (activeProjectId) {
        resumePendingTasks(activeProjectId).catch((e) => console.warn('[初始化] 恢复待续任务失败:', e));
      }
    } catch (error) {
      console.error('Init from IndexedDB failed:', error);
    }
  },
});
