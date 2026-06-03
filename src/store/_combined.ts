/**
 * useAppStore — 全局状态聚合（按职责分 slice，待文件系统权限恢复后可迁移为独立文件）
 *
 * Slice 分区:
 *   [Utils]         工具函数 (generateId, computeImageNodeDimensions, blobToDataUrl)
 *   [Toast]         消息提示
 *   [UI]            UI 面板状态
 *   [History]       撤销 / 重做
 *   [Nodes]         画布节点 / 边 CRUD
 *   [Config]        API 配置
 *   [Workflows]     ComfyUI 工作流
 *   [Presets]       用户预设
 *   [Groups]        节点分组
 *   [Clipboard]     复制 / 粘贴
 *   [Projects]      项目管理 / 保存加载
 *   [Store]         聚合入口
 */
import { create } from 'zustand';
import type { Node, Edge, Connection } from '@xyflow/react';
import type { BaseNodeData, CanvasProject, AppConfig, WorkflowDefinition, UserPreset, PresetNodeType, NodeGroup } from '../types';
import { GROUP_COLOR_PALETTE } from '../types';
import * as fileService from '../services/fileService';

// ============================================================================
// [Utils] — 纯函数
// ============================================================================

export const generateId = () => Math.random().toString(36).substring(2, 11);

export function generateProjectId(): string {
  return crypto.randomUUID();
}

export function computeImageNodeDimensions(dataUrl: string): Promise<{ nodeWidth: number; nodeHeight: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const maxWidth = 280;
      const minWidth = 160;
      let nodeWidth = img.naturalWidth;
      if (nodeWidth > maxWidth) nodeWidth = maxWidth;
      if (nodeWidth < minWidth) nodeWidth = minWidth;
      const contentWidth = nodeWidth - 4;
      const previewHeight = Math.round(contentWidth / naturalRatio);
      const nodeHeight = Math.max(120, previewHeight + 4);
      resolve({ nodeWidth, nodeHeight });
    };
    img.onerror = () => resolve({ nodeWidth: 280, nodeHeight: 158 });
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getNextDisplayId(nodes: Node<BaseNodeData>[]): number {
  let max = 9;
  for (const n of nodes) {
    const id = (n.data as BaseNodeData).displayId;
    if (typeof id === 'number' && id > max) max = id;
  }
  return max + 1;
}

// ============================================================================
// [Toast] — 消息提示
// ============================================================================

interface ToastSlice {
  toast: { visible: boolean; message: string; type: 'success' | 'error' };
  showToast: (message: string, type?: 'success' | 'error') => void;
  dismissToast: () => void;
}

const initialToast = { visible: false, message: '', type: 'success' as const };

function createToastSlice(set: any, get: any): ToastSlice {
  return {
    toast: { ...initialToast },
    showToast: (message, type = 'success') => {
      set({ toast: { visible: true, message, type } });
      setTimeout(() => {
        const s = get() as any;
        if (s.toast?.visible) set({ toast: { ...s.toast, visible: false } });
      }, 2500);
    },
    dismissToast: () => set({ toast: { visible: false, message: '', type: 'success' } }),
  };
}

// ============================================================================
// [UI] — UI 面板状态
// ============================================================================

interface UISlice {
  settingsOpen: boolean;
  nodeMenuVisible: boolean;
  nodeMenuPosition: { x: number; y: number };
  nodePickerOpen: boolean;
  avatarMenuOpen: boolean;
  activeNodeId: string | null;
  dialogPosition: { x: number; y: number } | null;
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
}

function createUISlice(set: any): UISlice {
  return {
    settingsOpen: false,
    nodeMenuVisible: false,
    nodeMenuPosition: { x: 0, y: 0 },
    nodePickerOpen: false,
    avatarMenuOpen: false,
    activeNodeId: null,
    dialogPosition: null,
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    showNodeMenu: (pos) => set({ nodeMenuVisible: true, nodeMenuPosition: pos }),
    hideNodeMenu: () => set({ nodeMenuVisible: false }),
    openNodePicker: () => set({ nodePickerOpen: true, avatarMenuOpen: false }),
    toggleNodePicker: () => set((s: any) => ({ nodePickerOpen: !s.nodePickerOpen, avatarMenuOpen: false })),
    closeNodePicker: () => set({ nodePickerOpen: false }),
    toggleAvatarMenu: () => set((s: any) => ({ avatarMenuOpen: !s.avatarMenuOpen, nodePickerOpen: false })),
    closeAvatarMenu: () => set({ avatarMenuOpen: false }),
    openNodeDialog: (nodeId, pos) => set({ activeNodeId: nodeId, dialogPosition: pos ?? null }),
    closeNodeDialog: () => set({ activeNodeId: null, dialogPosition: null }),
  };
}
