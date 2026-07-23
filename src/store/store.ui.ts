/**
 * UI slice — panel visibility, menu positioning, dialog state
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';

export type SettingsTab = 'general' | 'files' | 'api' | 'shortcuts' | 'comfyui' | 'storage';

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
  activeNodeId: string | null;
  dialogPosition: { x: number; y: number } | null;
  assetsPanelOpen: boolean;
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
  openNodeDialog: (nodeId: string, position?: { x: number; y: number }) => void;
  closeNodeDialog: () => void;
  setAssetsPanelOpen: (open: boolean) => void;
  setHistoryPanelOpen: (open: boolean) => void;
  toggleMinimap: () => void;
  requestDirectorDeskRuntime: (instanceId: string, openAfterInstall?: boolean) => void;
  clearDirectorDeskRuntimeRequest: () => void;
  setHoveredMentionNodeId: (id: string | null) => void;
  setPendingPresetAction: (action: UISlice['pendingPresetAction']) => void;
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set) => ({
  settingsOpen: false,
  settingsInitialTab: null,
  pendingApiKeyConnectionId: null,
  nodeMenuVisible: false,
  nodeMenuPosition: { x: 0, y: 0 },
  nodePickerOpen: false,
  avatarMenuOpen: false,
  activeNodeId: null,
  dialogPosition: null,
  assetsPanelOpen: false,
  historyPanelOpen: false,
  minimapVisible: true,
  directorDeskRuntimeRequest: null,
  hoveredMentionNodeId: null,
  pendingPresetAction: null,

  setSettingsOpen: (open, tab) => set(open
    ? {
        settingsOpen: true,
        settingsInitialTab: tab ?? null,
        assetsPanelOpen: false,
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
  openNodeDialog: (nodeId, position) => set({ activeNodeId: nodeId, dialogPosition: position ?? null }),
  closeNodeDialog: () => set({ activeNodeId: null, dialogPosition: null, pendingPresetAction: null }),
  setAssetsPanelOpen: (open) => set(open
    ? {
        settingsOpen: false,
        assetsPanelOpen: true,
        historyPanelOpen: false,
        dramaAssetsPanelOpen: false,
        chatOpen: false,
      }
    : { assetsPanelOpen: false, dramaAssetsPanelOpen: false }),
  setHistoryPanelOpen: (open) => set(open
    ? {
        settingsOpen: false,
        assetsPanelOpen: false,
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
});
