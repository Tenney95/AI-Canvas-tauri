import { create } from 'zustand';
import type { Node, Edge, Connection } from '@xyflow/react';
import type { BaseNodeData, CanvasProject, AppConfig, WorkflowDefinition } from '../types';
import * as fileService from '../services/fileService';

// 生成唯一 ID
export const generateId = () => Math.random().toString(36).substring(2, 11);

// Undo/Redo history
interface HistoryEntry {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
}

const MAX_HISTORY = 50;

interface AppState {
  // 画布状态
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  selectedNodeIds: string[];

  // 历史记录
  history: HistoryEntry[];
  historyIndex: number;

  // 项目状态
  projects: CanvasProject[];
  currentProjectId: string | null;
  projectName: string;

  // Toast 消息
  toast: { visible: boolean; message: string; type: 'success' | 'error' };

  // 工作流
  workflows: WorkflowDefinition[];
  workflowPanelOpen: boolean;

  // UI 状态
  sidebarOpen: boolean;
  settingsOpen: boolean;
  nodeMenuVisible: boolean;
  nodeMenuPosition: { x: number; y: number };
  nodePickerOpen: boolean;
  avatarMenuOpen: boolean;
  activeNodeId: string | null;
  dialogPosition: { x: number; y: number } | null;
  nextNodeDisplayId: number;

  // 配置
  config: AppConfig;

  // Actions - Nodes
  setNodes: (nodes: Node<BaseNodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  addNode: (node: Node<BaseNodeData>) => void;
  addNodeWithEdge: (node: Node<BaseNodeData>, edge: Edge) => void;
  updateNodeData: (nodeId: string, data: Partial<BaseNodeData>) => void;
  deleteNode: (nodeId: string) => void;

  // Actions - Connections
  onConnect: (connection: Connection) => void;
  onNodesChange: (changes: unknown[]) => void;
  onEdgesChange: (changes: unknown[]) => void;

  // Actions - UI
  toggleSidebar: () => void;
  setSettingsOpen: (open: boolean) => void;
  showNodeMenu: (position: { x: number; y: number }) => void;
  hideNodeMenu: () => void;
  openNodePicker: () => void;
  toggleNodePicker: () => void;
  closeNodePicker: () => void;
  toggleAvatarMenu: () => void;
  closeAvatarMenu: () => void;
  openNodeDialog: (nodeId: string, position?: { x: number; y: number }) => void;
  closeNodeDialog: () => void;

  // Actions - Projects
  setProjectName: (name: string) => void;
  createProject: (name?: string) => void;
  deleteProject: (id: string) => void;
  switchProject: (id: string) => void;

  // Actions - Config
  updateConfig: (config: Partial<AppConfig>) => void;
  setProviderKey: (providerName: string, key: string) => void;
  saveConfig: () => Promise<void>;
  loadConfig: () => Promise<void>;

  // Actions - Toast
  showToast: (message: string, type?: 'success' | 'error') => void;
  dismissToast: () => void;

  // Actions - History
  undo: () => void;
  redo: () => void;
  commitToHistory: () => void;

  // Actions - Workflows
  setWorkflowPanelOpen: (open: boolean) => void;
  addWorkflow: (wf: WorkflowDefinition) => void;
  deleteWorkflow: (id: string) => Promise<void>;
  loadWorkflows: () => Promise<void>;

  // Actions - Save/Load
  saveCurrentProject: () => Promise<string | undefined>;
  loadProject: () => Promise<void>;
  initFromDb: () => Promise<void>;
}

const defaultConfig: AppConfig = {
  providers: {},
  theme: 'dark',
  localLLMUrl: '',
  comfyUIUrl: '',
};

export const useAppStore = create<AppState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeIds: [],
  history: [],
  historyIndex: -1,
  projects: [
    { id: 'default', name: '默认画布', createdAt: Date.now(), updatedAt: Date.now() },
  ],
  currentProjectId: 'default',
  projectName: '新项目',
  sidebarOpen: true,
  settingsOpen: false,
  nodeMenuVisible: false,
  nodeMenuPosition: { x: 0, y: 0 },
  nodePickerOpen: false,
  avatarMenuOpen: false,
  activeNodeId: null,
  dialogPosition: null,
  nextNodeDisplayId: 10,
  workflows: [],
  workflowPanelOpen: false,
  toast: { visible: false, message: '', type: 'success' },
  config: defaultConfig,

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  addNode: (node) =>
    set((state) => {
      const displayId = state.nextNodeDisplayId;
      return {
        nodes: [...state.nodes, { ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>],
        nextNodeDisplayId: displayId + 1,
      };
    }),

  // Atomically add a node and a connecting edge in one state update
  addNodeWithEdge: (node, edge) =>
    set((state) => {
      const displayId = state.nextNodeDisplayId;
      return {
        nodes: [...state.nodes, { ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>],
        edges: [...state.edges, edge],
        nextNodeDisplayId: displayId + 1,
      };
    }),

  updateNodeData: (nodeId, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } as BaseNodeData } : n
      ),
    })),

  deleteNode: (nodeId) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    })),

  onConnect: (connection) => {
    const id = `edge-${generateId()}`;
    const edge: Edge = {
      id,
      source: connection.source!,
      target: connection.target!,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    };
    set((state) => ({ edges: [...state.edges, edge] }));
  },

  onNodesChange: (changes) => {
    console.log('onNodesChange:', changes);
    // React Flow will handle most node changes internally
  },

  onEdgesChange: (changes) => {
    console.log('onEdgesChange:', changes);
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  showNodeMenu: (position) => set({ nodeMenuVisible: true, nodeMenuPosition: position }),
  hideNodeMenu: () => set({ nodeMenuVisible: false }),
  openNodePicker: () => set({ nodePickerOpen: true, avatarMenuOpen: false }),
  toggleNodePicker: () => set((s) => ({ nodePickerOpen: !s.nodePickerOpen, avatarMenuOpen: false })),
  closeNodePicker: () => set({ nodePickerOpen: false }),
  toggleAvatarMenu: () => set((s) => ({ avatarMenuOpen: !s.avatarMenuOpen, nodePickerOpen: false })),
  closeAvatarMenu: () => set({ avatarMenuOpen: false }),
  openNodeDialog: (nodeId, position) => set({ activeNodeId: nodeId, dialogPosition: position ?? null }),
  closeNodeDialog: () => set({ activeNodeId: null, dialogPosition: null }),

  setProjectName: (name) =>
    set((state) => ({
      projectName: name,
      projects: state.projects.map((p) =>
        p.id === state.currentProjectId ? { ...p, name } : p
      ),
    })),

  createProject: (name) => {
    const project: CanvasProject = {
      id: generateId(),
      name: name || `项目 ${get().projects.length + 1}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((state) => ({
      projects: [...state.projects, project],
      currentProjectId: project.id,
      projectName: project.name,
      nodes: [],
      edges: [],
    }));
    // Persist to IndexedDB
    fileService.saveProject({ ...project, nodes: [], edges: [] }).catch(() => {});
  },

  deleteProject: (id) => {
    set((state) => {
      const filtered = state.projects.filter((p) => p.id !== id);
      return {
        projects: filtered,
        currentProjectId:
          state.currentProjectId === id ? filtered[0]?.id ?? null : state.currentProjectId,
      };
    });
    // Remove from IndexedDB
    fileService.deleteProjectData(id).catch(() => {});
  },

  switchProject: async (id) => {
    // Save current project before switching
    await get().saveCurrentProject();

    const project = get().projects.find((p) => p.id === id);
    if (!project) return;

    // Load project data from IndexedDB
    const data = await fileService.loadProjectData(id);
    if (data && data.nodes) {
      set({
        currentProjectId: id,
        projectName: project.name,
        nodes: data.nodes as Node<BaseNodeData>[],
        edges: (data.edges as Edge[]) || [],
        history: [],
        historyIndex: -1,
      });
    } else {
      set({
        currentProjectId: id,
        projectName: project.name,
        nodes: [],
        edges: [],
        history: [],
        historyIndex: -1,
      });
    }
  },

  updateConfig: (config) =>
    set((state) => ({ config: { ...state.config, ...config } })),

  setProviderKey: (providerName, key) =>
    set((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          [providerName]: {
            ...(state.config.providers[providerName] || { name: providerName }),
            apiKey: key,
          },
        },
      },
    })),

  // Persist config to IndexedDB
  saveConfig: async () => {
    const { config, showToast } = get();
    try {
      await fileService.saveConfig(config);
      showToast('设置已保存');
    } catch {
      showToast('设置保存失败', 'error');
    }
  },

  // Load config from IndexedDB on app start
  loadConfig: async () => {
    try {
      const saved = await fileService.loadConfig();
      if (saved) {
        set({ config: { ...defaultConfig, ...(saved as AppConfig) } });
      }
    } catch {
      // Use default config if load fails
    }
  },

  // Workflow actions
  setWorkflowPanelOpen: (open) => set({ workflowPanelOpen: open }),

  addWorkflow: (wf) => {
    set((state) => ({ workflows: [...state.workflows, wf] }));
    fileService.saveWorkflow({
      id: wf.id,
      name: wf.name,
      category: wf.category,
      fileName: wf.fileName,
      fileContent: wf.fileContent,
      ioNodes: wf.ioNodes,
      createdAt: wf.createdAt,
    }).catch(() => {});
  },

  deleteWorkflow: async (id) => {
    set((state) => ({
      workflows: state.workflows.filter((w) => w.id !== id),
    }));
    await fileService.deleteWorkflow(id).catch(() => {});
  },

  loadWorkflows: async () => {
    const records = await fileService.loadWorkflows();
    if (records.length > 0) {
      const mapped: WorkflowDefinition[] = records.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category as WorkflowDefinition['category'],
        fileName: r.fileName,
        fileContent: r.fileContent,
        ioNodes: r.ioNodes as WorkflowDefinition['ioNodes'],
        createdAt: r.createdAt,
      }));
      set({ workflows: mapped });
    }
  },

  // Toast actions
  showToast: (message, type = 'success') => {
    set({ toast: { visible: true, message, type } });
    // auto-dismiss after 2.5s
    setTimeout(() => {
      set((s) => (s.toast.visible ? { toast: { ...s.toast, visible: false } } : s));
    }, 2500);
  },
  dismissToast: () => set((s) => ({ toast: { ...s.toast, visible: false } })),

  // Undo/Redo
  undo: () => {
    const { historyIndex, history } = get();
    if (historyIndex > 0) {
      const entry = history[historyIndex - 1];
      set({ nodes: entry.nodes, edges: entry.edges, historyIndex: historyIndex - 1 });
    }
  },

  redo: () => {
    const { historyIndex, history } = get();
    if (historyIndex < history.length - 1) {
      const entry = history[historyIndex + 1];
      set({ nodes: entry.nodes, edges: entry.edges, historyIndex: historyIndex + 1 });
    }
  },

  commitToHistory: () => {
    const { nodes, edges, history, historyIndex } = get();
    const newEntry: HistoryEntry = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    };
    // Trim future if not at the end
    const newHistory =
      historyIndex === history.length - 1 ? [...history, newEntry] : [...history.slice(0, historyIndex + 1), newEntry];
    // Limit max history size
    if (newHistory.length > MAX_HISTORY) newHistory.shift();
    set({ history: newHistory, historyIndex: Math.min(newHistory.length - 1, historyIndex + 1) });
  },

  // Save/Load — all via IndexedDB
  saveCurrentProject: async () => {
    const { projects, currentProjectId, projectName, nodes, edges, showToast } = get();
    const project = projects.find((p) => p.id === currentProjectId);
    if (!project) return undefined;
    try {
      const record = {
        id: currentProjectId!,
        name: projectName,
        createdAt: project.createdAt,
        updatedAt: Date.now(),
        nodes,
        edges,
      };
      await fileService.saveProject(record);
      // Update local project metadata
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

  loadProject: async () => {
    // Re-load from IndexedDB: refresh projects list, load current project data
    try {
      const allProjects = await fileService.loadProjectsList();
      if (allProjects.length > 0) {
        const mapped: CanvasProject[] = allProjects.map((p) => ({
          id: p.id,
          name: p.name,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }));
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
            history: [],
            historyIndex: -1,
          });
        }
      }
    } catch (error) {
      console.error('Load failed:', error);
    }
  },

  initFromDb: async () => {
    try {
      // Load config and workflows in parallel
      await Promise.all([get().loadConfig(), get().loadWorkflows()]);

      const allProjects = await fileService.loadProjectsList();
      if (allProjects.length > 0) {
        const mapped: CanvasProject[] = allProjects.map((p) => ({
          id: p.id,
          name: p.name,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }));
        // Sort by updatedAt desc
        mapped.sort((a, b) => b.updatedAt - a.updatedAt);
        const lastId = mapped[0].id;

        const data = await fileService.loadProjectData(lastId);
        if (data) {
          set({
            projects: mapped,
            currentProjectId: lastId,
            projectName: data.name || '新项目',
            nodes: (data.nodes as Node<BaseNodeData>[]) || [],
            edges: (data.edges as Edge[]) || [],
          });
          return;
        }
        set({ projects: mapped, currentProjectId: lastId });
      } else {
        // No saved projects, persist default
        const defaultProject = {
          id: 'default',
          name: '默认画布',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          nodes: [],
          edges: [],
        };
        await fileService.saveProject(defaultProject).catch(() => {});
      }
    } catch (error) {
      console.error('Init from IndexedDB failed:', error);
    }
  },
}));
