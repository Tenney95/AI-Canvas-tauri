/**
 * UI slice — panel visibility, menu positioning, dialog state
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { ReversePromptRequest } from '../types';

export type SettingsTab = 'general' | 'files' | 'api' | 'shortcuts' | 'comfyui' | 'storage' | 'plugins' | 'mcp';

export type ComfyNodeProgressStage = 'connecting' | 'queued' | 'running' | 'finalizing';

export interface ComfyNodeProgress {
  projectId: string;
  nodeId: string;
  requestId: string;
  clientId: string;
  promptId?: string;
  stage: ComfyNodeProgressStage;
  value?: number;
  max?: number;
  percent?: number;
  executingNodeId?: string;
  updatedAt: number;
}

export interface UISlice {
  settingsOpen: boolean;
  /** 打开设置时要激活的标签页；SettingsPanel 消费后清空 */
  settingsInitialTab: SettingsTab | null;
  /** 打开 API Key 设置后要自动打开编辑的连接 id；ApiKeySettings 消费后清空 */
  pendingApiKeyConnectionId: string | null;
  nodeMenuVisible: boolean;
  nodeMenuPosition: { x: number; y: number };
  nodePickerOpen: boolean;
  avatarMenuOpen: boolean;
  projectLibraryOpen: boolean;
  /** 帮助中心弹窗；侧边栏菜单和首次引导都从这里打开 */
  helpOpen: boolean;
  activeNodeId: string | null;
  dialogPosition: { x: number; y: number } | null;
  assetsPanelOpen: boolean;
  characterLibraryOpen: boolean;
  /** 角色库里的动作库弹层；圆环快捷入口要能越过角色列表直接打开它 */
  characterActionLibraryOpen: boolean;
  historyPanelOpen: boolean;
  minimapVisible: boolean;
  directorDeskRuntimeRequest: {
    instanceId: string;
    openAfterInstall: boolean;
  } | null;
  /** 当前在 prompt 里被 hover 的 @引用节点 id — 用于联动 connected-nodes-float 高亮 */
  hoveredMentionNodeId: string | null;
  /** 从 Toolbar 点击快捷指令后，需要 PromptPanel 自动执行的 preset 操作 */
  pendingPresetAction: {
    nodeId: string;
    filledPrompt: string;
    shouldTrigger: boolean;
    postProcess?: string;
    override?: {
      model?: string;
      provider?: string;
      imageSize?: string;
      aspectRatio?: string;
    };
  } | null;
  /** 反推提示词弹窗的当前请求；null 表示弹窗关闭 */
  reversePromptRequest: ReversePromptRequest | null;
  /** 仅当前运行期使用的 ComfyUI 节点进度；不进入项目节点数据或 IndexedDB。 */
  comfyNodeProgress: Record<string, ComfyNodeProgress>;
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
  setSettingsInitialTab: (tab: SettingsTab | null) => void;
  /** 打开设置的 API Key 页，并可选自动打开某连接的编辑框（填写密钥） */
  openApiKeySettings: (connectionId?: string) => void;
  setPendingApiKeyConnectionId: (id: string | null) => void;
  showNodeMenu: (position: { x: number; y: number }) => void;
  hideNodeMenu: () => void;
  openNodePicker: () => void;
  toggleNodePicker: () => void;
  closeNodePicker: () => void;
  toggleAvatarMenu: () => void;
  closeAvatarMenu: () => void;
  setProjectLibraryOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  openNodeDialog: (nodeId: string, position?: { x: number; y: number }) => void;
  closeNodeDialog: () => void;
  setAssetsPanelOpen: (open: boolean) => void;
  setCharacterLibraryOpen: (open: boolean) => void;
  setCharacterActionLibraryOpen: (open: boolean) => void;
  setHistoryPanelOpen: (open: boolean) => void;
  toggleMinimap: () => void;
  requestDirectorDeskRuntime: (instanceId: string, openAfterInstall?: boolean) => void;
  clearDirectorDeskRuntimeRequest: () => void;
  setHoveredMentionNodeId: (id: string | null) => void;
  setPendingPresetAction: (action: UISlice['pendingPresetAction']) => void;
  setReversePromptRequest: (request: ReversePromptRequest | null) => void;
  beginComfyNodeProgress: (progress: Omit<ComfyNodeProgress, 'updatedAt'>) => void;
  updateComfyNodeProgress: (
    nodeId: string,
    requestId: string,
    patch: Partial<Omit<ComfyNodeProgress, 'projectId' | 'nodeId' | 'requestId' | 'clientId'>>,
  ) => void;
  clearComfyNodeProgress: (nodeId: string, requestId: string) => void;
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set) => ({
  settingsOpen: false,
  settingsInitialTab: null,
  pendingApiKeyConnectionId: null,
  nodeMenuVisible: false,
  nodeMenuPosition: { x: 0, y: 0 },
  nodePickerOpen: false,
  avatarMenuOpen: false,
  projectLibraryOpen: false,
  helpOpen: false,
  activeNodeId: null,
  dialogPosition: null,
  assetsPanelOpen: false,
  characterLibraryOpen: false,
  characterActionLibraryOpen: false,
  historyPanelOpen: false,
  minimapVisible: true,
  directorDeskRuntimeRequest: null,
  hoveredMentionNodeId: null,
  pendingPresetAction: null,
  reversePromptRequest: null,
  comfyNodeProgress: {},

  setSettingsOpen: (open, tab) => set(open
    ? {
        settingsOpen: true,
        settingsInitialTab: tab ?? null,
        assetsPanelOpen: false,
        characterLibraryOpen: false,
        characterActionLibraryOpen: false,
        historyPanelOpen: false,
        dramaAssetsPanelOpen: false,
        chatOpen: false,
      }
    : { settingsOpen: false, settingsInitialTab: null, pendingApiKeyConnectionId: null }),
  setSettingsInitialTab: (tab) => set({ settingsInitialTab: tab }),
  openApiKeySettings: (connectionId) => set({
    settingsOpen: true,
    settingsInitialTab: 'api',
    pendingApiKeyConnectionId: connectionId ?? null,
    assetsPanelOpen: false,
    characterLibraryOpen: false,
    historyPanelOpen: false,
    dramaAssetsPanelOpen: false,
    chatOpen: false,
  }),
  setPendingApiKeyConnectionId: (id) => set({ pendingApiKeyConnectionId: id }),
  showNodeMenu: (position) => set({ nodeMenuVisible: true, nodeMenuPosition: position }),
  hideNodeMenu: () => set({ nodeMenuVisible: false }),
  openNodePicker: () => set({ nodePickerOpen: true, avatarMenuOpen: false }),
  toggleNodePicker: () => set((s) => ({ nodePickerOpen: !s.nodePickerOpen, avatarMenuOpen: false })),
  closeNodePicker: () => set({ nodePickerOpen: false }),
  toggleAvatarMenu: () => set((s) => ({ avatarMenuOpen: !s.avatarMenuOpen, nodePickerOpen: false })),
  closeAvatarMenu: () => set({ avatarMenuOpen: false }),
  setProjectLibraryOpen: (open) => set({ projectLibraryOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  openNodeDialog: (nodeId, position) => set({ activeNodeId: nodeId, dialogPosition: position ?? null }),
  closeNodeDialog: () => set({ activeNodeId: null, dialogPosition: null, pendingPresetAction: null }),
  setAssetsPanelOpen: (open) => set(open
    ? {
        settingsOpen: false,
        assetsPanelOpen: true,
        characterLibraryOpen: false,
        characterActionLibraryOpen: false,
        historyPanelOpen: false,
        dramaAssetsPanelOpen: false,
        chatOpen: false,
      }
    : { assetsPanelOpen: false, dramaAssetsPanelOpen: false }),
  setCharacterLibraryOpen: (open) => set(open
    ? {
        settingsOpen: false,
        assetsPanelOpen: false,
        characterLibraryOpen: true,
        characterActionLibraryOpen: false,
        historyPanelOpen: false,
        dramaAssetsPanelOpen: false,
        chatOpen: false,
      }
    : { characterLibraryOpen: false, characterActionLibraryOpen: false }),
  // 角色库里点开时两个都开着（关掉动作库退回角色库）；圆环直接进来时只开这一个
  setCharacterActionLibraryOpen: (open) => set(open
    ? {
        settingsOpen: false,
        assetsPanelOpen: false,
        historyPanelOpen: false,
        dramaAssetsPanelOpen: false,
        chatOpen: false,
        characterActionLibraryOpen: true,
      }
    : { characterActionLibraryOpen: false }),
  setHistoryPanelOpen: (open) => set(open
    ? {
        settingsOpen: false,
        assetsPanelOpen: false,
        characterLibraryOpen: false,
        characterActionLibraryOpen: false,
        historyPanelOpen: true,
        dramaAssetsPanelOpen: false,
        chatOpen: false,
      }
    : { historyPanelOpen: false }),
  toggleMinimap: () => set((s) => ({ minimapVisible: !s.minimapVisible })),
  requestDirectorDeskRuntime: (instanceId, openAfterInstall = true) => set((state) => {
    const normalized = instanceId.trim();
    if (!normalized || state.directorDeskRuntimeRequest) return {};
    return { directorDeskRuntimeRequest: { instanceId: normalized, openAfterInstall } };
  }),
  clearDirectorDeskRuntimeRequest: () => set({ directorDeskRuntimeRequest: null }),
  setHoveredMentionNodeId: (id) => set({ hoveredMentionNodeId: id }),
  setPendingPresetAction: (action) => set({ pendingPresetAction: action }),
  setReversePromptRequest: (request) => set({ reversePromptRequest: request }),
  beginComfyNodeProgress: (progress) => set((state) => ({
    comfyNodeProgress: {
      ...state.comfyNodeProgress,
      [progress.nodeId]: { ...progress, updatedAt: Date.now() },
    },
  })),
  updateComfyNodeProgress: (nodeId, requestId, patch) => set((state) => {
    const current = state.comfyNodeProgress[nodeId];
    if (!current || current.requestId !== requestId) return {};
    return {
      comfyNodeProgress: {
        ...state.comfyNodeProgress,
        [nodeId]: { ...current, ...patch, updatedAt: Date.now() },
      },
    };
  }),
  clearComfyNodeProgress: (nodeId, requestId) => set((state) => {
    const current = state.comfyNodeProgress[nodeId];
    if (!current || current.requestId !== requestId) return {};
    const next = { ...state.comfyNodeProgress };
    delete next[nodeId];
    return { comfyNodeProgress: next };
  }),
});
