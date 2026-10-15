/**
 * UI slice — panel visibility, menu positioning, dialog state
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { ReversePromptRequest } from '../types';
import type { AssetFileEntry, AssetFolderSelection, FileTransferOptions, NodeOutputDownloadProgress } from '../services/fileService';
import type { AssetImageRecord, AssetImageSaveInput } from '../types/assetImage';
import type { AppUpdateProgress } from '../services/updateService';

export type SettingsTab = 'general' | 'appearance' | 'files' | 'api' | 'shortcuts' | 'comfyui' | 'storage' | 'plugins' | 'mcp';
export const NEW_API_KEY_CONNECTION_ID = '__new__';

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
  recentAssetsRevision: number;
  markAssetUsed: (file: Pick<AssetFileEntry, 'path' | 'assetId'>) => Promise<boolean>;
  /** 当前运行期入口请求，不进入项目或配置持久化。 */
  assetsPanelRequest: { tab: 'project' | 'permanent'; projectId?: string; folder?: AssetFolderSelection } | null;
  saveAssetImageDetails: (file: AssetFileEntry, input: AssetImageSaveInput, options?: FileTransferOptions) => Promise<AssetImageRecord>;
  settingsOpen: boolean;
  /** 打开设置时要激活的标签页；SettingsPanel 消费后清空 */
  settingsInitialTab: SettingsTab | null;
  /** 打开 API Key 设置后要自动打开的连接 id；NEW_API_KEY_CONNECTION_ID 表示直接打开新建连接弹窗 */
  pendingApiKeyConnectionId: string | null;
  /** 连接弹窗内要展开的模型参数；仅当前运行期使用，不持久化。 */
  pendingApiKeyModelId: string | null;
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
  /** 同一资产库的展示方式，仅用于当前界面，不持久化。 */
  assetsPanelMode: 'modal' | 'drawer' | 'page';
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
  /** 吉祥物与关于窗口共用的应用更新进度，不持久化。 */
  appUpdateProgress: AppUpdateProgress | null;
  setAppUpdateProgress: (progress: AppUpdateProgress) => void;
  /** 节点另存为的下载展示，不持久化；取消句柄留在画布 Hook。 */
  nodeOutputDownload: (NodeOutputDownloadProgress & { fileName: string }) | null;
  setNodeOutputDownload: (progress: UISlice['nodeOutputDownload']) => void;
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
  setSettingsInitialTab: (tab: SettingsTab | null) => void;
  /** 打开 API Key 页的指定连接，可同时展开模型参数；不传连接 id 时打开新建弹窗。 */
  openApiKeySettings: (connectionId?: string, modelId?: string) => void;
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
  setAssetsPanelOpen: (open: boolean, mode?: UISlice['assetsPanelMode'], request?: UISlice['assetsPanelRequest']) => void;
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
  recentAssetsRevision: 0,
  assetsPanelRequest: null,
  markAssetUsed: async (file) => {
    try {
      const { markRecentAssetUsed } = await import('../services/fs/recentAssets');
      const recorded = await markRecentAssetUsed(file);
      if (recorded) set((state) => ({ recentAssetsRevision: state.recentAssetsRevision + 1 }));
      return recorded;
    } catch { return false; } // 最近记录写入失败不阻断预览或导入。
  },
  saveAssetImageDetails: async (file, input, options) => {
    const { saveAssetImageMetadata } = await import('../services/fs/assetImageMetadata');
    const record = await saveAssetImageMetadata(file, input, options);
    if (input.tagReplacement) set((state) => ({ recentAssetsRevision: state.recentAssetsRevision + 1 }));
    return record;
  },
  settingsOpen: false,
  settingsInitialTab: null,
  pendingApiKeyConnectionId: null,
  pendingApiKeyModelId: null,
  nodeMenuVisible: false,
  nodeMenuPosition: { x: 0, y: 0 },
  nodePickerOpen: false,
  avatarMenuOpen: false,
  projectLibraryOpen: false,
  helpOpen: false,
  activeNodeId: null,
  dialogPosition: null,
  assetsPanelOpen: false,
  assetsPanelMode: 'modal',
  characterLibraryOpen: false,
  characterActionLibraryOpen: false,
  historyPanelOpen: false,
  minimapVisible: true,
  directorDeskRuntimeRequest: null,
  hoveredMentionNodeId: null,
  pendingPresetAction: null,
  reversePromptRequest: null,
  comfyNodeProgress: {},
  appUpdateProgress: null,
  setAppUpdateProgress: (progress) => set({ appUpdateProgress: progress }),
  nodeOutputDownload: null,
  setNodeOutputDownload: (progress) => set({ nodeOutputDownload: progress }),

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
    : { settingsOpen: false, settingsInitialTab: null, pendingApiKeyConnectionId: null, pendingApiKeyModelId: null }),
  setSettingsInitialTab: (tab) => set({ settingsInitialTab: tab }),
  openApiKeySettings: (connectionId, modelId) => set({
    settingsOpen: true,
    settingsInitialTab: 'api',
    pendingApiKeyConnectionId: connectionId ?? NEW_API_KEY_CONNECTION_ID,
    pendingApiKeyModelId: connectionId ? modelId ?? null : null,
    assetsPanelOpen: false,
    characterLibraryOpen: false,
    historyPanelOpen: false,
    dramaAssetsPanelOpen: false,
    chatOpen: false,
  }),
  setPendingApiKeyConnectionId: (id) => set({ pendingApiKeyConnectionId: id, pendingApiKeyModelId: null }),
  showNodeMenu: (position) => set({ nodeMenuVisible: true, nodeMenuPosition: position }),
  hideNodeMenu: () => set({ nodeMenuVisible: false }),
  openNodePicker: () => set({ nodePickerOpen: true, avatarMenuOpen: false }),
  toggleNodePicker: () => set((s) => ({ nodePickerOpen: !s.nodePickerOpen, avatarMenuOpen: false })),
  closeNodePicker: () => set({ nodePickerOpen: false }),
  toggleAvatarMenu: () => set((s) => ({ avatarMenuOpen: !s.avatarMenuOpen, nodePickerOpen: false })),
  closeAvatarMenu: () => set({ avatarMenuOpen: false }),
  setProjectLibraryOpen: (open) => set({ projectLibraryOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  openNodeDialog: (nodeId, position) => set((state) => {
    const node = state.nodes.find((item) => item.id === nodeId);
    // 点击、空格和其他入口共用此边界：宫格只使用自身的分格/取图交互。
    if (node?.type === 'ai-storyboard' || node?.data.type === 'ai-storyboard') {
      return { activeNodeId: null, dialogPosition: null, pendingPresetAction: null };
    }
    return { activeNodeId: nodeId, dialogPosition: position ?? null };
  }),
  closeNodeDialog: () => set({ activeNodeId: null, dialogPosition: null, pendingPresetAction: null }),
  setAssetsPanelOpen: (open, mode = 'modal', request = null) => set(open
    ? {
        settingsOpen: false,
        assetsPanelOpen: true,
        assetsPanelMode: mode,
        assetsPanelRequest: request,
        ...(request ? { dramaAssetsPanelOpen: false } : {}),
        characterLibraryOpen: false,
        characterActionLibraryOpen: false,
        historyPanelOpen: false,
        dramaAssetsPanelOpen: false,
        chatOpen: false,
      }
    : { assetsPanelOpen: false, assetsPanelMode: 'modal', assetsPanelRequest: null, dramaAssetsPanelOpen: false }),
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
