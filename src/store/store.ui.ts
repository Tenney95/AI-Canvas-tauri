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
  lastCanvasMousePos: { x: number; y: number } | null;
  assetsPanelOpen: boolean;
  historyPanelOpen: boolean;
  minimapVisible: boolean;
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
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set) => ({
  settingsOpen: false,
  nodeMenuVisible: false,
  nodeMenuPosition: { x: 0, y: 0 },
  nodePickerOpen: false,
  avatarMenuOpen: false,
  activeNodeId: null,
  dialogPosition: null,
  lastCanvasMousePos: null,
  assetsPanelOpen: false,
  historyPanelOpen: false,
  minimapVisible: true,

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
  setAssetsPanelOpen: (open) => set({ assetsPanelOpen: open }),
  setHistoryPanelOpen: (open) => set({ historyPanelOpen: open }),
  toggleMinimap: () => set((s) => ({ minimapVisible: !s.minimapVisible })),
});
