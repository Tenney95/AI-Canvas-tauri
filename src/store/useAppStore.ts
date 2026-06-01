/**
 * useAppStore Zustand 全局状态存储 — 管理画布节点/边/项目/配置/UI 状态，提供撤销/重做、节点增删改查等所有 Actions
 */
import { create } from 'zustand';
import type { Node, Edge, Connection } from '@xyflow/react';
import type { BaseNodeData, CanvasProject, AppConfig, WorkflowDefinition, UserPreset, PresetNodeType } from '../types';
import * as fileService from '../services/fileService';

// 生成唯一 ID（节点等短 ID）
export const generateId = () => Math.random().toString(36).substring(2, 11);

/** 生成项目 ID（UUID v4，固定不重复） */
export function generateProjectId(): string {
  return crypto.randomUUID();
}

/** Load an image from dataUrl and compute proportional node dimensions */
export function computeImageNodeDimensions(dataUrl: string): Promise<{ nodeWidth: number; nodeHeight: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      // Clamp nodeWidth between 160 and 280 based on image width
      const maxWidth = 280;
      const minWidth = 160;
      let nodeWidth = img.naturalWidth;
      if (nodeWidth > maxWidth) nodeWidth = maxWidth;
      if (nodeWidth < minWidth) nodeWidth = minWidth;
      // Content area = nodeWidth - 4px padding (2px each side)
      const contentWidth = nodeWidth - 4;
      const previewHeight = Math.round(contentWidth / naturalRatio);
      const nodeHeight = Math.max(120, previewHeight + 4);
      resolve({ nodeWidth, nodeHeight });
    };
    img.onerror = () => resolve({ nodeWidth: 280, nodeHeight: 158 });
    img.src = dataUrl;
  });
}

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
  userPresets: UserPreset[];
  presetManagerOpen: boolean;

  // UI 状态
  settingsOpen: boolean;
  nodeMenuVisible: boolean;
  nodeMenuPosition: { x: number; y: number };
  nodePickerOpen: boolean;
  avatarMenuOpen: boolean;
  activeNodeId: string | null;
  dialogPosition: { x: number; y: number } | null;

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
  deleteProject: (id: string) => Promise<void>;
  switchProject: (id: string) => void;

  // Actions - Config
  updateConfig: (config: Partial<AppConfig>) => void;
  setProviderKey: (providerName: string, key: string) => void;
  setProviderUrl: (providerName: string, url: string) => void;
  setProviderConfig: (providerName: string, config: Partial<{ apiKey: string; baseUrl: string }>) => void;
  saveConfig: () => Promise<void>;
  loadConfig: () => Promise<void>;

  // Actions - Toast
  showToast: (message: string, type?: 'success' | 'error') => void;
  dismissToast: () => void;

  // Actions - History
  undo: () => void;
  redo: () => void;
  commitToHistory: () => void;

  // Actions - Clipboard
  clipboard: Node<BaseNodeData>[];
  copySelectedNodes: () => void;
  pasteNodes: (position: { x: number; y: number }) => void;
  pasteExternalContent: (position: { x: number; y: number }) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pasteExternalFromDataTransfer: (dt: any, position: { x: number; y: number }, maxItems?: number, actionName?: string) => Promise<void>;

  // Actions - Workflows
  setWorkflowPanelOpen: (open: boolean) => void;
  addWorkflow: (wf: WorkflowDefinition) => void;
  deleteWorkflow: (id: string) => Promise<void>;
  loadWorkflows: () => Promise<void>;

  // Actions - Presets
  setPresetManagerOpen: (open: boolean) => void;
  addUserPreset: (preset: UserPreset) => Promise<void>;
  updateUserPreset: (id: string, data: Partial<UserPreset>) => Promise<void>;
  deleteUserPreset: (id: string) => Promise<void>;
  loadPresets: () => Promise<void>;

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

// Computes the next displayId by scanning existing nodes for the max, then +1.
function getNextDisplayId(nodes: Node<BaseNodeData>[]): number {
  let max = 9;
  for (const n of nodes) {
    const id = (n.data as BaseNodeData).displayId;
    if (typeof id === 'number' && id > max) max = id;
  }
  return max + 1;
}

// Convert Blob to base64 data URL
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

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
  settingsOpen: false,
  nodeMenuVisible: false,
  nodeMenuPosition: { x: 0, y: 0 },
  nodePickerOpen: false,
  avatarMenuOpen: false,
  activeNodeId: null,
  dialogPosition: null,
  clipboard: [],
  workflows: [],
  workflowPanelOpen: false,
  userPresets: [],
  presetManagerOpen: false,
  toast: { visible: false, message: '', type: 'success' },
  config: defaultConfig,

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  addNode: (node) => {
    get().commitToHistory();
    set((state) => {
      const displayId = getNextDisplayId(state.nodes);
      return {
        nodes: [...state.nodes, { ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>],
      };
    });
  },

  // Atomically add a node and a connecting edge in one state update
  addNodeWithEdge: (node, edge) => {
    get().commitToHistory();
    set((state) => {
      const displayId = getNextDisplayId(state.nodes);
      return {
        nodes: [...state.nodes, { ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>],
        edges: [...state.edges, edge],
      };
    });
  },

  updateNodeData: (nodeId, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } as BaseNodeData } : n
      ),
    })),

  deleteNode: (nodeId) => {
    get().commitToHistory();
    // Try to delete the associated local file
    const node = get().nodes.find((n) => n.id === nodeId);
    if (node) {
      fileService.deleteNodeFile(node.data as BaseNodeData).catch(() => {});
    }
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    }));
  },

  onConnect: (connection) => {
    get().commitToHistory();
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
    const id = generateProjectId();
    // Derive default name from existing project names, not projects.length
    // (projects.length can include the legacy 'default' placeholder, causing duplicates)
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
    const project: CanvasProject = {
      id,
      name: defaultName,
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
    // Ensure local data directory for media assets
    fileService.ensureProjectDataDir(id).catch(() => {});
  },

  deleteProject: async (id) => {
    const state = get();
    const filtered = state.projects.filter((p) => p.id !== id);
    const isCurrent = state.currentProjectId === id;

    // If the only remaining entry is the legacy 'default' placeholder,
    // auto-create a fresh UUID project so files are saved to disk.
    if (isCurrent && filtered.length === 1 && filtered[0]?.id === 'default') {
      const newId = generateProjectId();
      const now = Date.now();
      set({
        projects: [{ id: newId, name: '默认画布', createdAt: now, updatedAt: now }],
        currentProjectId: newId,
        projectName: '默认画布',
        nodes: [],
        edges: [],
        history: [],
        historyIndex: -1,
      });
      fileService.saveProject({ id: newId, name: '默认画布', createdAt: now, updatedAt: now, nodes: [], edges: [] }).catch(() => {});
      fileService.ensureProjectDataDir(newId).catch(() => {});
    } else {
      const nextId = isCurrent ? filtered[0]?.id ?? null : state.currentProjectId;
      const nextName = isCurrent ? filtered[0]?.name ?? '' : state.projectName;

      set({
        projects: filtered,
        currentProjectId: nextId,
        ...(isCurrent
          ? {
              projectName: nextName,
              nodes: [],
              edges: [],
              history: [],
              historyIndex: -1,
            }
          : {}),
      });

      // When deleting the current project, load the next project's data
      if (isCurrent && nextId) {
        try {
          const data = await fileService.loadProjectData(nextId);
          if (data && data.nodes) {
            set({
              nodes: data.nodes as Node<BaseNodeData>[],
              edges: (data.edges as Edge[]) || [],
            });
          }
        } catch {
          // Keep empty canvas if loading fails
        }
      }
    }

    // Remove from IndexedDB
    fileService.deleteProjectData(id).catch(() => {});
    // Remove local data directory (media files)
    fileService.deleteProjectDataDir(id).catch(() => {});
  },

  switchProject: async (id) => {
    // Save current project before switching
    await get().saveCurrentProject();

    const project = get().projects.find((p) => p.id === id);
    if (!project) return;

    // Ensure local data directory for the target project
    fileService.ensureProjectDataDir(id).catch(() => {});

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

  setProviderUrl: (providerName, url) =>
    set((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          [providerName]: {
            ...(state.config.providers[providerName] || { name: providerName, apiKey: '' }),
            baseUrl: url,
          },
        },
      },
    })),

  setProviderConfig: (providerName, cfg) =>
    set((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          [providerName]: {
            ...(state.config.providers[providerName] || { name: providerName, apiKey: '' }),
            ...cfg,
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

  // Preset actions
  setPresetManagerOpen: (open) => set({ presetManagerOpen: open }),

  addUserPreset: async (preset) => {
    set((state) => ({ userPresets: [...state.userPresets, preset] }));
    await fileService.savePreset({ ...preset }).catch(() => {});
  },

  updateUserPreset: async (id, data) => {
    set((state) => ({
      userPresets: state.userPresets.map((p) =>
        p.id === id ? { ...p, ...data } : p,
      ),
    }));
    const updated = get().userPresets.find((p) => p.id === id);
    if (updated) {
      await fileService.savePreset({ ...updated }).catch(() => {});
    }
  },

  deleteUserPreset: async (id) => {
    set((state) => ({
      userPresets: state.userPresets.filter((p) => p.id !== id),
    }));
    await fileService.deletePreset(id).catch(() => {});
  },

  loadPresets: async () => {
    const records = await fileService.loadPresets();
    if (records.length > 0) {
      set({
        userPresets: records.map((r) => ({
          id: r.id,
          nodeType: r.nodeType as PresetNodeType,
          name: r.name,
          description: r.description,
          promptTemplate: r.promptTemplate,
          thumbnail: r.thumbnail,
          triggerMode: (r.triggerMode as UserPreset['triggerMode']) || 'direct',
        })),
      });
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

  // Clipboard — copy selected nodes, paste at position
  copySelectedNodes: () => {
    const { selectedNodeIds, nodes } = get();
    if (selectedNodeIds.length === 0) return;
    const copied = nodes
      .filter((n) => selectedNodeIds.includes(n.id))
      .map((n) => JSON.parse(JSON.stringify(n)) as Node<BaseNodeData>);
    set({ clipboard: copied });
  },

  pasteNodes: (position) => {
    const { clipboard, nodes } = get();
    if (clipboard.length === 0) return;
    get().commitToHistory();
    let baseDisplayId = getNextDisplayId(nodes);
    const pasted: Node<BaseNodeData>[] = clipboard.map((n, i) => {
      const newId = `node-${generateId()}`;
      const displayId = baseDisplayId + i;
      const offsetX = i * 40;
      const offsetY = i * 40;
      return {
        ...n,
        id: newId,
        position: { x: position.x + offsetX, y: position.y + offsetY },
        data: { ...n.data, displayId } as BaseNodeData,
      };
    });
    set((s) => ({
      nodes: [...s.nodes, ...pasted],
      selectedNodeIds: pasted.map((n) => n.id),
    }));
  },

  // Paste external content from a native paste event's DataTransfer (WebView2 reliable path)
  pasteExternalFromDataTransfer: async (dt, position, maxItems = 5, actionName = '已粘贴') => {
    if (!dt) return;

    // Generate position offsets for multiple items (cascading diagonal layout)
    const offsets: { x: number; y: number }[] = [];
    for (let i = 0; i < maxItems; i++) {
      offsets.push({ x: i * 30, y: i * 30 });
    }

    // Helper: create image node (proportional to image aspect ratio)
    const addImageNode = async (dataUrl: string, idx: number) => {
      const dims = await computeImageNodeDimensions(dataUrl);
      const off = offsets[idx] || { x: idx * 40, y: idx * 40 };
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-image',
        position: { x: position.x + off.x, y: position.y + off.y },
        data: { label: '粘贴图像', type: 'ai-image', role: 'source', imageUrl: dataUrl, status: 'success', ...dims },
      };
      get().addNode(newNode as Parameters<AppState['addNode']>[0]);
    };

    // Helper: create video node
    const addVideoNode = (dataUrl: string, idx: number) => {
      const off = offsets[idx] || { x: idx * 40, y: idx * 40 };
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-video',
        position: { x: position.x + off.x, y: position.y + off.y },
        data: { label: '粘贴视频', type: 'ai-video', role: 'source', videoUrl: dataUrl, status: 'success' },
      };
      get().addNode(newNode as Parameters<AppState['addNode']>[0]);
    };

    // Helper: create audio node
    const addAudioNode = (dataUrl: string, idx: number) => {
      const off = offsets[idx] || { x: idx * 40, y: idx * 40 };
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-audio',
        position: { x: position.x + off.x, y: position.y + off.y },
        data: { label: '粘贴音频', type: 'ai-audio', role: 'source', audioUrl: dataUrl, status: 'success', nodeWidth: 260, nodeHeight: 140 },
      };
      get().addNode(newNode as Parameters<AppState['addNode']>[0]);
    };

    // Helper: create text node
    const addTextNode = (text: string, idx: number) => {
      const lineCount = text.split('\n').length;
      const h = Math.max(120, Math.min(600, 40 + lineCount * 20));
      const off = offsets[idx] || { x: idx * 40, y: idx * 40 };
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-text',
        position: { x: position.x + off.x, y: position.y + off.y },
        data: { label: '粘贴文本', type: 'ai-text', role: 'source', output: text, status: 'success', nodeWidth: 280, nodeHeight: h },
      };
      get().addNode(newNode as Parameters<AppState['addNode']>[0]);
    };

    let pastedCount = 0;

    // ── Collect all pending work, then execute ──
    type PendingItem =
      | { kind: 'file'; file: File }
      | { kind: 'dataUrl'; dataUrl: string; mediaType: 'image' | 'video' | 'audio' }
      | { kind: 'text'; text: string }
      | { kind: 'file-path'; filePath: string; ext: string };

    const pending: PendingItem[] = [];

    // 1) File objects (OS file copy — most reliable on Windows)
    if (dt.files.length > 0) {
      for (let i = 0; i < dt.files.length && pending.length < maxItems; i++) {
        pending.push({ kind: 'file', file: dt.files[i] });
      }
    }

    // 2) Items by type (used when no File objects, or as additional processing)
    if (pending.length === 0 && dt.items.length > 0) {
      for (let i = 0; i < dt.items.length && pending.length < maxItems; i++) {
        const item = dt.items[i];

        if (item.type.startsWith('image/') || item.type.startsWith('video/') || item.type.startsWith('audio/')) {
          const file = item.getAsFile();
          if (file) {
            pending.push({ kind: 'file', file });
            continue;
          }
        }

        // text/html — extract image src
        if (item.type === 'text/html') {
          const html = dt.getData('text/html');
          if (html) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const img = doc.querySelector('img');
            if (img?.src) {
              if (img.src.startsWith('data:')) {
                pending.push({ kind: 'dataUrl', dataUrl: img.src, mediaType: 'image' });
              } else if (img.src.startsWith('file://')) {
                const filePath = fileService.fileUriToPath(img.src);
                const ext = filePath.split('.').pop()?.toLowerCase() || '';
                pending.push({ kind: 'file-path', filePath, ext });
              } else if (img.src.startsWith('http')) {
                pending.push({ kind: 'dataUrl', dataUrl: img.src, mediaType: 'image' });
              }
            }
          }
          continue;
        }

        // text/uri-list — file paths from OS file copy
        if (item.type === 'text/uri-list') {
          const uriText = dt.getData('text/uri-list');
          if (uriText) {
            const uris = uriText.split('\n').filter((u) => u.trim().startsWith('file://'));
            for (const uri of uris) {
              if (pending.length >= maxItems) break;
              const filePath = fileService.fileUriToPath(uri.trim());
              const ext = filePath.split('.').pop()?.toLowerCase() || '';
              pending.push({ kind: 'file-path', filePath, ext });
            }
          }
          continue;
        }

        // text/plain
        if (item.type === 'text/plain') {
          const text = dt.getData('text/plain');
          if (text?.trim()) {
            pending.push({ kind: 'text', text });
          }
          continue;
        }
      }
    }

    // ── Execute all pending items ──
    for (const p of pending) {
      if (pastedCount >= maxItems) break;

      if (p.kind === 'file') {
        const off = offsets[pastedCount] || { x: pastedCount * 40, y: pastedCount * 40 };
        const nodePos = { x: position.x + off.x, y: position.y + off.y };
        const projectId = get().currentProjectId;
        const isTauri = projectId && projectId !== 'default' && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
        const file = p.file; // capture for async closure

        if (file.type.startsWith('image/')) {
          const nodeId = `node-${generateId()}`;
          const newNode: Node<BaseNodeData> = {
            id: nodeId,
            type: 'ai-image',
            position: nodePos,
            data: {
              label: file.name || '粘贴图像',
              type: 'ai-image', role: 'source',
              status: 'loading',
              nodeWidth: 280, nodeHeight: 158,
            },
          };
          get().addNode(newNode as Parameters<AppState['addNode']>[0]);
          pastedCount++;

          // Upload in background
          (async () => {
            try {
              let assetUrl: string | null = null;
              let savedPath: string | null = null;
              if (isTauri) {
                try {
                  const buf = await file.arrayBuffer();
                  const result = await fileService.saveBinaryToProjectData(
                    new Uint8Array(buf),
                    projectId!,
                    file.name,
                  );
                  if (result) {
                    assetUrl = result.assetUrl;
                    savedPath = result.filePath;
                    console.log(`[pasteFile] saved "${file.name}" (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB) → ${result.filePath}`);
                  } else {
                    console.warn(`[pasteFile] saveBinaryToProjectData returned null for "${file.name}", falling back to base64`);
                  }
                } catch (err) {
                  console.error(`[pasteFile] failed to save "${file.name}":`, err);
                }
              }
              const imgUrl = assetUrl || await blobToDataUrl(file);
              const dims = await computeImageNodeDimensions(imgUrl);
              get().updateNodeData(nodeId, {
                imageUrl: imgUrl,
                label: savedPath ? file.name : '粘贴图像',
                status: 'success',
                ...(savedPath ? { filePath: savedPath, fileName: file.name } : {}),
                ...dims,
              });
            } catch (err) {
              console.error(`[pasteFile] upload failed for "${file.name}":`, err);
              get().updateNodeData(nodeId, {
                status: 'error',
                error: err instanceof Error ? err.message : '上传失败',
              });
            }
          })();
        } else if (file.type.startsWith('video/')) {
          const nodeId = `node-${generateId()}`;
          const newNode: Node<BaseNodeData> = {
            id: nodeId,
            type: 'ai-video',
            position: nodePos,
            data: {
              label: file.name || '粘贴视频',
              type: 'ai-video', role: 'source',
              status: 'loading',
              nodeWidth: 280, nodeHeight: 160,
            },
          };
          get().addNode(newNode as Parameters<AppState['addNode']>[0]);
          pastedCount++;

          (async () => {
            try {
              let assetUrl: string | null = null;
              let savedPath: string | null = null;
              if (isTauri) {
                try {
                  const buf = await file.arrayBuffer();
                  const result = await fileService.saveBinaryToProjectData(
                    new Uint8Array(buf),
                    projectId!,
                    file.name,
                  );
                  if (result) {
                    assetUrl = result.assetUrl;
                    savedPath = result.filePath;
                    console.log(`[pasteFile] saved "${file.name}" (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB) → ${result.filePath}`);
                  } else {
                    console.warn(`[pasteFile] saveBinaryToProjectData returned null for "${file.name}", falling back to base64`);
                  }
                } catch (err) {
                  console.error(`[pasteFile] failed to save "${file.name}":`, err);
                }
              }
              const vidUrl = assetUrl || await blobToDataUrl(file);
              get().updateNodeData(nodeId, {
                videoUrl: vidUrl,
                label: savedPath ? file.name : '粘贴视频',
                status: 'success',
                ...(savedPath ? { filePath: savedPath, fileName: file.name } : {}),
              });
            } catch (err) {
              console.error(`[pasteFile] upload failed for "${file.name}":`, err);
              get().updateNodeData(nodeId, {
                status: 'error',
                error: err instanceof Error ? err.message : '上传失败',
              });
            }
          })();
        } else if (file.type.startsWith('audio/')) {
          const nodeId = `node-${generateId()}`;
          const newNode: Node<BaseNodeData> = {
            id: nodeId,
            type: 'ai-audio',
            position: nodePos,
            data: {
              label: file.name || '粘贴音频',
              type: 'ai-audio', role: 'source',
              status: 'loading',
              nodeWidth: 260, nodeHeight: 140,
            },
          };
          get().addNode(newNode as Parameters<AppState['addNode']>[0]);
          pastedCount++;

          (async () => {
            try {
              let assetUrl: string | null = null;
              let savedPath: string | null = null;
              if (isTauri) {
                try {
                  const buf = await file.arrayBuffer();
                  const result = await fileService.saveBinaryToProjectData(
                    new Uint8Array(buf),
                    projectId!,
                    file.name,
                  );
                  if (result) {
                    assetUrl = result.assetUrl;
                    savedPath = result.filePath;
                    console.log(`[pasteFile] saved "${file.name}" (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB) → ${result.filePath}`);
                  } else {
                    console.warn(`[pasteFile] saveBinaryToProjectData returned null for "${file.name}", falling back to base64`);
                  }
                } catch (err) {
                  console.error(`[pasteFile] failed to save "${file.name}":`, err);
                }
              }
              const audUrl = assetUrl || await blobToDataUrl(file);
              get().updateNodeData(nodeId, {
                audioUrl: audUrl,
                label: savedPath ? file.name : '粘贴音频',
                status: 'success',
                ...(savedPath ? { filePath: savedPath, fileName: file.name } : {}),
              });
            } catch (err) {
              console.error(`[pasteFile] upload failed for "${file.name}":`, err);
              get().updateNodeData(nodeId, {
                status: 'error',
                error: err instanceof Error ? err.message : '上传失败',
              });
            }
          })();
        } else {
          continue;
        }
      } else if (p.kind === 'dataUrl') {
        // If it's a remote URL, try to fetch it
        if (p.dataUrl.startsWith('http')) {
          try {
            const resp = await fetch(p.dataUrl);
            const blob = await resp.blob();
            const realDataUrl = await blobToDataUrl(blob);
            if (p.mediaType === 'image') await addImageNode(realDataUrl, pastedCount);
            else if (p.mediaType === 'video') addVideoNode(realDataUrl, pastedCount);
            else if (p.mediaType === 'audio') addAudioNode(realDataUrl, pastedCount);
            else continue;
            pastedCount++;
          } catch {
            // fetch failed, skip
          }
        } else {
          if (p.mediaType === 'image') await addImageNode(p.dataUrl, pastedCount);
          else if (p.mediaType === 'video') addVideoNode(p.dataUrl, pastedCount);
          else if (p.mediaType === 'audio') addAudioNode(p.dataUrl, pastedCount);
          else continue;
          pastedCount++;
        }
      } else if (p.kind === 'file-path') {
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
        const videoExts = ['mp4', 'webm', 'avi', 'mov', 'mkv'];
        const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac'];
        if (imageExts.includes(p.ext) || videoExts.includes(p.ext) || audioExts.includes(p.ext)) {
          const projectId = get().currentProjectId;
          const off = offsets[pastedCount] || { x: pastedCount * 40, y: pastedCount * 40 };
          const filePath = p.filePath;
          const extLower = p.ext.toLowerCase();
          const fileName = filePath.split(/[/\\]/).pop() || filePath;

          if (projectId && projectId !== 'default') {
            // Create node immediately with loading, copy file in background
            if (imageExts.includes(extLower)) {
              const nodeId = `node-${generateId()}`;
              const newNode: Node<BaseNodeData> = {
                id: nodeId,
                type: 'ai-image',
                position: { x: position.x + off.x, y: position.y + off.y },
                data: { label: fileName, type: 'ai-image', role: 'source', status: 'loading', nodeWidth: 280, nodeHeight: 158 },
              };
              get().addNode(newNode as Parameters<AppState['addNode']>[0]);
              pastedCount++;
              (async () => {
                try {
                  const result = await fileService.copyFileToProjectData(filePath, projectId);
                  if (result && result.assetUrl) {
                    const dims = await computeImageNodeDimensions(result.assetUrl);
                    get().updateNodeData(nodeId, { label: result.fileName, imageUrl: result.assetUrl, filePath: result.filePath, fileName: result.fileName, status: 'success', ...dims });
                  } else {
                    // Fallback: read into memory
                    const dataUrl = await fileService.readFileToDataUrl(filePath);
                    if (dataUrl) {
                      const dims = await computeImageNodeDimensions(dataUrl);
                      get().updateNodeData(nodeId, { imageUrl: dataUrl, status: 'success', ...dims });
                    } else {
                      get().updateNodeData(nodeId, { status: 'error', error: '无法读取文件' });
                    }
                  }
                } catch (err) {
                  console.error(`[pasteFile] file-path copy failed for "${filePath}":`, err);
                  get().updateNodeData(nodeId, { status: 'error', error: err instanceof Error ? err.message : '拷贝失败' });
                }
              })();
            } else if (videoExts.includes(extLower)) {
              const nodeId = `node-${generateId()}`;
              const newNode: Node<BaseNodeData> = {
                id: nodeId,
                type: 'ai-video',
                position: { x: position.x + off.x, y: position.y + off.y },
                data: { label: fileName, type: 'ai-video', role: 'source', status: 'loading', nodeWidth: 280, nodeHeight: 160 },
              };
              get().addNode(newNode as Parameters<AppState['addNode']>[0]);
              pastedCount++;
              (async () => {
                try {
                  const result = await fileService.copyFileToProjectData(filePath, projectId);
                  if (result && result.assetUrl) {
                    get().updateNodeData(nodeId, { label: result.fileName, videoUrl: result.assetUrl, filePath: result.filePath, fileName: result.fileName, status: 'success' });
                  } else {
                    const dataUrl = await fileService.readFileToDataUrl(filePath);
                    if (dataUrl) {
                      get().updateNodeData(nodeId, { videoUrl: dataUrl, status: 'success' });
                    } else {
                      get().updateNodeData(nodeId, { status: 'error', error: '无法读取文件' });
                    }
                  }
                } catch (err) {
                  console.error(`[pasteFile] file-path copy failed for "${filePath}":`, err);
                  get().updateNodeData(nodeId, { status: 'error', error: err instanceof Error ? err.message : '拷贝失败' });
                }
              })();
            } else {
              const nodeId = `node-${generateId()}`;
              const newNode: Node<BaseNodeData> = {
                id: nodeId,
                type: 'ai-audio',
                position: { x: position.x + off.x, y: position.y + off.y },
                data: { label: fileName, type: 'ai-audio', role: 'source', status: 'loading', nodeWidth: 260, nodeHeight: 140 },
              };
              get().addNode(newNode as Parameters<AppState['addNode']>[0]);
              pastedCount++;
              (async () => {
                try {
                  const result = await fileService.copyFileToProjectData(filePath, projectId);
                  if (result && result.assetUrl) {
                    get().updateNodeData(nodeId, { label: result.fileName, audioUrl: result.assetUrl, filePath: result.filePath, fileName: result.fileName, status: 'success' });
                  } else {
                    const dataUrl = await fileService.readFileToDataUrl(filePath);
                    if (dataUrl) {
                      get().updateNodeData(nodeId, { audioUrl: dataUrl, status: 'success' });
                    } else {
                      get().updateNodeData(nodeId, { status: 'error', error: '无法读取文件' });
                    }
                  }
                } catch (err) {
                  console.error(`[pasteFile] file-path copy failed for "${filePath}":`, err);
                  get().updateNodeData(nodeId, { status: 'error', error: err instanceof Error ? err.message : '拷贝失败' });
                }
              })();
            }
            continue;
          }

          // Fallback (no project): read into memory synchronously
          const dataUrl = await fileService.readFileToDataUrl(p.filePath);
          if (dataUrl) {
            if (imageExts.includes(p.ext)) await addImageNode(dataUrl, pastedCount);
            else if (videoExts.includes(p.ext)) addVideoNode(dataUrl, pastedCount);
            else addAudioNode(dataUrl, pastedCount);
            pastedCount++;
          }
        }
      } else if (p.kind === 'text') {
        addTextNode(p.text, pastedCount);
        pastedCount++;
      }
    }

    if (pastedCount > 0) {
      get().showToast(`${actionName} ${pastedCount} 个源节点`);
    } else {
      get().showToast('无可识别内容', 'error');
    }
  },

  // Paste external content from OS clipboard (text / image / video / audio) → source nodes
  pasteExternalContent: async (position) => {
    const state = get();
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
      state.showToast('当前环境不支持读取剪贴板', 'error');
      return;
    }

    const offsets = [
      { x: 0, y: 0 },
      { x: 40, y: 40 },
      { x: 80, y: 80 },
      { x: -40, y: 40 },
      { x: -80, y: 80 },
    ];

    let pastedCount = 0;

    try {
      const items = await navigator.clipboard.read();
      if (!items || items.length === 0) {
        state.showToast('剪贴板为空', 'error');
        return;
      }

      for (let i = 0; i < items.length && i < offsets.length; i++) {
        const item = items[i];
        const offset = offsets[i];
        const nodePos = { x: position.x + offset.x, y: position.y + offset.y };

        // Check by priority: image > video > audio > text
        if (item.types.some((t) => t.startsWith('image/'))) {
          const imageType = item.types.find((t) => t.startsWith('image/'))!;
          const blob = await item.getType(imageType);
          const dataUrl = await blobToDataUrl(blob);
          const dims = await computeImageNodeDimensions(dataUrl);

          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-image',
            position: nodePos,
            data: {
              label: '粘贴图像',
              type: 'ai-image',
              role: 'source',
              imageUrl: dataUrl,
              status: 'success',
              ...dims,
            },
          };
          get().addNode(newNode as Parameters<AppState['addNode']>[0]);
          pastedCount++;
        } else if (item.types.some((t) => t.startsWith('video/'))) {
          const videoType = item.types.find((t) => t.startsWith('video/'))!;
          const blob = await item.getType(videoType);
          const dataUrl = await blobToDataUrl(blob);

          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-video',
            position: nodePos,
            data: {
              label: '粘贴视频',
              type: 'ai-video',
              role: 'source',
              videoUrl: dataUrl,
              status: 'success',
            },
          };
          get().addNode(newNode as Parameters<AppState['addNode']>[0]);
          pastedCount++;
        } else if (item.types.some((t) => t.startsWith('audio/'))) {
          const audioType = item.types.find((t) => t.startsWith('audio/'))!;
          const blob = await item.getType(audioType);
          const dataUrl = await blobToDataUrl(blob);

          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-audio',
            position: nodePos,
            data: {
              label: '粘贴音频',
              type: 'ai-audio',
              role: 'source',
              audioUrl: dataUrl,
              status: 'success',
              nodeWidth: 260,
              nodeHeight: 140,
            },
          };
          get().addNode(newNode as Parameters<AppState['addNode']>[0]);
          pastedCount++;
        } else if (item.types.includes('text/html')) {
          // Image copied from browser — often stored as HTML with <img> tag
          const htmlBlob = await item.getType('text/html');
          const html = await htmlBlob.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const img = doc.querySelector('img');
          if (img?.src) {
            let dataUrl: string | null = null;
            if (img.src.startsWith('data:')) {
              dataUrl = img.src;
            } else if (img.src.startsWith('file://')) {
              // Local file reference — read via Tauri FS
              const filePath = fileService.fileUriToPath(img.src);
              dataUrl = await fileService.readFileToDataUrl(filePath);
            } else if (img.src.startsWith('http://') || img.src.startsWith('https://')) {
              try {
                const resp = await fetch(img.src);
                const fetchedBlob = await resp.blob();
                dataUrl = await blobToDataUrl(fetchedBlob);
              } catch {
                // Fetch failed, skip this item
              }
            }

            if (dataUrl) {
              const dims = await computeImageNodeDimensions(dataUrl);
              const newNode: Node<BaseNodeData> = {
                id: `node-${generateId()}`,
                type: 'ai-image',
                position: nodePos,
                data: {
                  label: '粘贴图像',
                  type: 'ai-image',
                  role: 'source',
                  imageUrl: dataUrl,
                  status: 'success',
                  ...dims,
                },
              };
              get().addNode(newNode as Parameters<AppState['addNode']>[0]);
              pastedCount++;
            }
          }
        } else if (item.types.includes('text/uri-list')) {
          // File copied from file manager — URI list of file:// paths
          const uriBlob = await item.getType('text/uri-list');
          const uriText = await uriBlob.text();
          const uris = uriText.split('\n').filter((u) => u.trim().startsWith('file://'));

          for (let j = 0; j < uris.length && pastedCount < offsets.length; j++) {
            const uri = uris[j].trim();
            const filePath = fileService.fileUriToPath(uri);
            const ext = filePath.split('.').pop()?.toLowerCase() || '';

            // Determine media type from extension
            const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
            const videoExts = ['mp4', 'webm', 'avi', 'mov', 'mkv'];
            const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac'];

            let mediaType: 'image' | 'video' | 'audio' | null = null;
            if (imageExts.includes(ext)) mediaType = 'image';
            else if (videoExts.includes(ext)) mediaType = 'video';
            else if (audioExts.includes(ext)) mediaType = 'audio';

            if (mediaType) {
              const dataUrl = await fileService.readFileToDataUrl(filePath);
              if (dataUrl) {
                const uriOffset = offsets[pastedCount] || { x: pastedCount * 40, y: pastedCount * 40 };
                const uriNodePos = { x: position.x + uriOffset.x, y: position.y + uriOffset.y };

                if (mediaType === 'image') {
                  const dims = await computeImageNodeDimensions(dataUrl);
                  const newNode: Node<BaseNodeData> = {
                    id: `node-${generateId()}`,
                    type: 'ai-image',
                    position: uriNodePos,
                    data: {
                      label: '粘贴图像',
                      type: 'ai-image',
                      role: 'source',
                      imageUrl: dataUrl,
                      status: 'success',
                      ...dims,
                    },
                  };
                  get().addNode(newNode as Parameters<AppState['addNode']>[0]);
                } else if (mediaType === 'video') {
                  const newNode: Node<BaseNodeData> = {
                    id: `node-${generateId()}`,
                    type: 'ai-video',
                    position: uriNodePos,
                    data: {
                      label: '粘贴视频',
                      type: 'ai-video',
                      role: 'source',
                      videoUrl: dataUrl,
                      status: 'success',
                    },
                  };
                  get().addNode(newNode as Parameters<AppState['addNode']>[0]);
                } else if (mediaType === 'audio') {
                  const newNode: Node<BaseNodeData> = {
                    id: `node-${generateId()}`,
                    type: 'ai-audio',
                    position: uriNodePos,
                    data: {
                      label: '粘贴音频',
                      type: 'ai-audio',
                      role: 'source',
                      audioUrl: dataUrl,
                      status: 'success',
                      nodeWidth: 260,
                      nodeHeight: 140,
                    },
                  };
                  get().addNode(newNode as Parameters<AppState['addNode']>[0]);
                }
                pastedCount++;
              }
            }
          }
        } else if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();

          if (!text.trim()) continue;

          const lineCount = text.split('\n').length;
          const estimatedHeight = Math.max(120, Math.min(600, 40 + lineCount * 20));

          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-text',
            position: nodePos,
            data: {
              label: '粘贴文本',
              type: 'ai-text',
              role: 'source',
              output: text,
              status: 'success',
              nodeWidth: 280,
              nodeHeight: estimatedHeight,
            },
          };
          get().addNode(newNode as Parameters<AppState['addNode']>[0]);
          pastedCount++;
        }
      }

      if (pastedCount > 0) {
        get().showToast(`已粘贴 ${pastedCount} 个源节点`);
      } else {
        get().showToast('剪贴板无可识别内容', 'error');
      }
    } catch (err: unknown) {
      const e = err as { name?: string };
      if (e?.name === 'NotAllowedError') {
        get().showToast('无剪贴板读取权限', 'error');
      } else {
        console.error('External clipboard paste failed:', err);
        get().showToast('无法读取剪贴板', 'error');
      }
    }
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
      // Load config, workflows and presets in parallel
      await Promise.all([get().loadConfig(), get().loadWorkflows(), get().loadPresets()]);

      const allProjects = await fileService.loadProjectsList();
      // Filter out any stale 'default' placeholder that may have leaked
      // into IndexedDB (e.g. saveCurrentProject before initFromDb finished)
      const valid = allProjects.filter((p) => p.id !== 'default');
      // Clean up stale 'default' entry from IndexedDB if present
      if (valid.length < allProjects.length) {
        fileService.deleteProjectData('default').catch(() => {});
      }
      if (valid.length > 0) {
        const mapped: CanvasProject[] = valid.map((p) => ({
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
        } else {
          set({ projects: mapped, currentProjectId: lastId });
        }
        // Ensure data dir for current project
        fileService.ensureProjectDataDir(lastId).catch(() => {});
      } else {
        // No saved projects, persist default with UUID
        // Must also update `projects` so the legacy {id:'default'} placeholder
        // is replaced — otherwise fallback after deleting the last project would
        // put us back to 'default' and files would be stored as base64.
        const id = generateProjectId();
        const now = Date.now();
        const defaultProject = {
          id,
          name: '默认画布',
          createdAt: now,
          updatedAt: now,
          nodes: [],
          edges: [],
        };
        set({
          projects: [{ id, name: '默认画布', createdAt: now, updatedAt: now }],
          currentProjectId: id,
          projectName: '默认画布',
        });
        await fileService.saveProject(defaultProject).catch(() => {});
        fileService.ensureProjectDataDir(id).catch(() => {});
      }
    } catch (error) {
      console.error('Init from IndexedDB failed:', error);
    }
  },
}));
