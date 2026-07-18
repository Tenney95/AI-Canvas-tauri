/**
 * UI slice — panel visibility, menu positioning, dialog state
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';

export interface UISlice {
  settingsOpen: boolean;
  nodeMenuVisible: boolean;
  nodeMenuPosition: { x: number; y: number };
  nodePickerOpen: boolean;
  avatarMenuOpen: boolean;
  activeNodeId: string | null;
  dialogPosition: { x: number; y: number } | null;
  assetsPanelOpen: boolean;
  historyPanelOpen: boolean;
  minimapVisible: boolean;
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
  setAssetsPanelOpen: (open: boolean) => void;
  setHistoryPanelOpen: (open: boolean) => void;
  toggleMinimap: () => void;
  setHoveredMentionNodeId: (id: string | null) => void;
  setPendingPresetAction: (action: UISlice['pendingPresetAction']) => void;
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set) => ({
  settingsOpen: false,
  nodeMenuVisible: false,
  nodeMenuPosition: { x: 0, y: 0 },
  nodePickerOpen: false,
  avatarMenuOpen: false,
  activeNodeId: null,
  dialogPosition: null,
  assetsPanelOpen: false,
  historyPanelOpen: false,
  minimapVisible: true,
  hoveredMentionNodeId: null,
  pendingPresetAction: null,

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  showNodeMenu: (position) => set({ nodeMenuVisible: true, nodeMenuPosition: position }),
  hideNodeMenu: () => set({ nodeMenuVisible: false }),
  openNodePicker: () => set({ nodePickerOpen: true, avatarMenuOpen: false }),
  toggleNodePicker: () => set((s) => ({ nodePickerOpen: !s.nodePickerOpen, avatarMenuOpen: false })),
  closeNodePicker: () => set({ nodePickerOpen: false }),
  toggleAvatarMenu: () => set((s) => ({ avatarMenuOpen: !s.avatarMenuOpen, nodePickerOpen: false })),
  closeAvatarMenu: () => set({ avatarMenuOpen: false }),
  openNodeDialog: (nodeId, position) => set({ activeNodeId: nodeId, dialogPosition: position ?? null }),
  closeNodeDialog: () => set({ activeNodeId: null, dialogPosition: null, pendingPresetAction: null }),
  setAssetsPanelOpen: (open) => set({ assetsPanelOpen: open }),
  setHistoryPanelOpen: (open) => set({ historyPanelOpen: open }),
  toggleMinimap: () => set((s) => ({ minimapVisible: !s.minimapVisible })),
  setHoveredMentionNodeId: (id) => set({ hoveredMentionNodeId: id }),
  setPendingPresetAction: (action) => set({ pendingPresetAction: action }),
});
