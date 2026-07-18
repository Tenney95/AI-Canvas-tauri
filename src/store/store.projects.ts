/**
 * Project slice — multi-project management, save/load/init via IndexedDB
 */
import type { Node, Edge } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData, CanvasProject, NodeGroup, ProjectSettings } from '../types';
import { generateProjectId } from './store.utils';
import * as fileService from '../services/fileService';
import { resumePendingTasks, clearProjectTasks } from '../services/pollManager';
import { normalizeProjectSettings } from '../services/projectSettingsService';

function getProjectGroups(data: { groups?: unknown } | null | undefined): NodeGroup[] {
  return Array.isArray(data?.groups) ? (data.groups as NodeGroup[]) : [];
}

function replacePathPrefix(path: string | undefined, oldDir: string, newDir: string): string | undefined {
  if (!path) return path;
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedOldDir = oldDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedNewDir = newDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedPath.startsWith(`${normalizedOldDir}/`)) return path;
  return `${normalizedNewDir}${normalizedPath.slice(normalizedOldDir.length)}`;
}

async function remapProjectNodePaths(
  nodes: Node<BaseNodeData>[],
  oldDir: string,
  newDir: string,
): Promise<Node<BaseNodeData>[]> {
  return Promise.all(nodes.map(async (node) => {
    const data = node.data as BaseNodeData;
    const nextFilePath = replacePathPrefix(data.filePath, oldDir, newDir);
    let changed = nextFilePath !== data.filePath;
    let nextData: BaseNodeData = changed ? { ...data, filePath: nextFilePath } : data;

    if (changed && nextFilePath) {
      const assetUrl = await fileService.getAssetUrlFromPath(nextFilePath);
      if (nextData.imageUrl) nextData.imageUrl = assetUrl;
      if (nextData.videoUrl) nextData.videoUrl = assetUrl;
      if (nextData.audioUrl) nextData.audioUrl = assetUrl;
    }

    if (Array.isArray(data.storyboardOverrides)) {
      const nextOverrides = await Promise.all(data.storyboardOverrides.map(async (override) => {
        if (!override) return override;
        const nextOverridePath = replacePathPrefix(override.filePath, oldDir, newDir);
        if (nextOverridePath === override.filePath) return override;
        changed = true;
        return {
          ...override,
          filePath: nextOverridePath,
          url: nextOverridePath ? await fileService.getAssetUrlFromPath(nextOverridePath) : override.url,
        };
      }));
      if (nextOverrides !== data.storyboardOverrides && nextOverrides.some((override, index) => override !== data.storyboardOverrides?.[index])) {
        nextData = nextData === data ? { ...data } : nextData;
        nextData.storyboardOverrides = nextOverrides;
      }
    }

    return changed ? { ...node, data: nextData } : node;
  }));
}

export interface ProjectSlice {
  projects: CanvasProject[];
  currentProjectId: string | null;
  projectName: string;
  _autoSaveFailedNotified?: boolean;
  setProjectName: (name: string) => void;
  updateProjectSettings: (settings: ProjectSettings) => Promise<boolean>;
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

  setProjectName: (name) => {
    const state = get();
    const currentProjectId = state.currentProjectId;
    const project = state.projects.find((p) => p.id === currentProjectId);
    if (!currentProjectId || !project) {
      set({ projectName: name });
      return;
    }

    const nextDataFolder = fileService.buildProjectFolderName(name, currentProjectId);
    const oldDataFolder = project.dataFolder;
    const dataFolderChanged = oldDataFolder !== nextDataFolder;

    set((s) => ({
      projectName: name,
      projects: s.projects.map((p) =>
        p.id === currentProjectId ? { ...p, name } : p
      ),
    }));

    if (!dataFolderChanged) return;

    (async () => {
      const renamed = await fileService.renameProjectDataDir(currentProjectId, oldDataFolder, nextDataFolder);
      if (!renamed) return;

      const latest = get();
      const latestProject = latest.projects.find((p) => p.id === currentProjectId);
      if (!latestProject) return;

      const patch: Partial<Pick<AppState, 'nodes' | 'projects'>> = {
        projects: latest.projects.map((p) =>
          p.id === currentProjectId ? { ...p, dataFolder: renamed.dataFolder, updatedAt: Date.now() } : p
        ),
      };

      if (latest.currentProjectId === currentProjectId) {
        patch.nodes = await remapProjectNodePaths(latest.nodes, renamed.oldDir, renamed.newDir);
      }

      set(patch);

      const after = get();
      const savedProject = after.projects.find((p) => p.id === currentProjectId);
      if (savedProject && after.currentProjectId === currentProjectId) {
        fileService.saveProject({
          ...savedProject,
          nodes: after.nodes,
          edges: after.edges,
          groups: after.groups,
        }).catch((e) => console.warn('[项目重命名] 保存失败:', e));
      }
    })().catch((e) => console.warn('[项目重命名] 数据目录重命名失败:', e));
  },

  updateProjectSettings: async (settings) => {
    const state = get();
    const projectId = state.currentProjectId;
    const previousProject = state.projects.find((project) => project.id === projectId);
    if (!projectId || !previousProject) return false;

    const nextProject: CanvasProject = {
      ...previousProject,
      settings: normalizeProjectSettings(settings),
      updatedAt: Date.now(),
    };
    set((current) => ({
      projects: current.projects.map((project) => (
        project.id === projectId ? nextProject : project
      )),
    }));

    try {
      await fileService.saveProject({
        ...nextProject,
        name: state.projectName,
        nodes: state.nodes,
        edges: state.edges,
        groups: state.groups,
      });
      get().showToast('项目设置已保存');
      return true;
    } catch (error) {
      console.error('Save project settings failed:', error);
      set((current) => ({
        projects: current.projects.map((project) => (
          project.id === projectId ? previousProject : project
        )),
      }));
      get().showToast('项目设置保存失败', 'error');
      return false;
    }
  },

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
    get().removeProjectAgentTasks(id);
    get().removeProjectMemories(id);
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
        groups: getProjectGroups(data),
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
    // 加载聊天会话
    get().loadConversationsForProject(id).catch((e) => console.warn('[切换项目] 加载会话失败:', e));
    get().repairInterruptedForProject(id).catch((e) => console.warn('[切换项目] 修复中断消息失败:', e));
    // 项目切换只加载任务，不把应用运行期间的后台任务误判为中断。
    get().loadAgentTasksForProject(id).catch((e) => console.warn('[切换项目] 加载 Agent 任务失败:', e));
    get().loadProjectMemoriesForProject(id).catch((e) => console.warn('[切换项目] 加载项目记忆失败:', e));

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
        settings: project.settings,
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
        settings: project.settings,
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
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          dataFolder: p.dataFolder, settings: p.settings,
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
            groups: getProjectGroups(data),
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
      await Promise.all([get().loadConfig(), get().loadWorkflows(), get().loadPresets(), get().loadSkills(), get().loadCustomStyles(), get().loadToolbarLayouts()]);

      const allProjects = await fileService.loadProjectsList();
      const valid = allProjects.filter((p) => p.id !== 'default');
      if (valid.length < allProjects.length) {
        fileService.deleteProjectData('default').catch((e) => console.warn('[初始化] 清理默认项目数据失败:', e));
      }
      let activeProjectId: string | null = null;
      if (valid.length > 0) {
        const mapped: CanvasProject[] = valid.map((p) => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          dataFolder: p.dataFolder, settings: p.settings,
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
            groups: getProjectGroups(data),
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
        // 加载聊天会话
        get().loadConversationsForProject(activeProjectId).catch((e) => console.warn('[初始化] 加载会话失败:', e));
        get().repairInterruptedForProject(activeProjectId).catch((e) => console.warn('[初始化] 修复中断消息失败:', e));
        get().loadProjectMemoriesForProject(activeProjectId).catch((e) => console.warn('[初始化] 加载项目记忆失败:', e));
        // 应用重启后，所有项目的未完成 Agent 任务都必须恢复为暂停，禁止自动续跑。
        const projectIds = get().projects.map((project) => project.id);
        await Promise.all(projectIds.map((projectId) =>
          get().repairInterruptedAgentTasksForProject(projectId),
        ));
      }
    } catch (error) {
      console.error('Init from IndexedDB failed:', error);
    }
  },
});
