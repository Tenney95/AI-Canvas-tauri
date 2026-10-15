import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  ComfyCatalogEntry,
  ComfyDownloadProgress,
  ComfyManagementResult,
  ComfyManagementSnapshot,
  ComfyManagementUiContext,
  ComfyRepositoryAction,
  ComfyVersion,
} from '../types/comfyManagement';

async function invokeWithProgress<T>(
  command: string,
  args: Record<string, unknown>,
  onProgress?: (progress: ComfyDownloadProgress) => void,
): Promise<T> {
  // 字符串 Channel 直接回包，管理窗口无需开放通用 Channel 取数权限。
  const channel = new Channel<string>();
  channel.onmessage = (message) => onProgress?.(JSON.parse(message) as ComfyDownloadProgress);
  try {
    return await invoke<T>(command, { ...args, onProgress: channel });
  } finally {
    channel.onmessage = () => {};
  }
}

/** 目录选择、校验与持久授权均由原生层完成；取消保持原选择。 */
export const selectComfyInstallation = (): Promise<string | null> =>
  invoke('select_comfyui_installation');

/** 只恢复原生已保存的选择，不根据前端配置字符串扩大目录权限。 */
export const getComfyInstallation = (): Promise<string | null> =>
  invoke('get_comfyui_installation');

export const openComfyManagementWindow = (comfyPath: string, uiContext: ComfyManagementUiContext): Promise<void> =>
  invoke('open_comfyui_settings_window', { comfyPath, uiContext });

export const getComfyManagementSnapshot = (refresh = false): Promise<ComfyManagementSnapshot> =>
  invoke('get_comfyui_management_snapshot', { refresh });

export const listComfyVersions = (repositoryId: string, refresh = false, onProgress?: (progress: ComfyDownloadProgress) => void): Promise<ComfyVersion[]> =>
  invokeWithProgress('list_comfyui_versions', { repositoryId, refresh }, onProgress);

export const applyComfyRepositoryAction = (request: ComfyRepositoryAction, onProgress?: (progress: ComfyDownloadProgress) => void): Promise<ComfyManagementResult> =>
  invokeWithProgress('apply_comfyui_repository_action', { request }, onProgress);

export const listComfyCatalog = (onProgress?: (progress: ComfyDownloadProgress) => void): Promise<ComfyCatalogEntry[]> =>
  invokeWithProgress('list_comfyui_catalog', {}, onProgress);

export const installComfyExtension = (repositoryUrl: string, onProgress?: (progress: ComfyDownloadProgress) => void): Promise<ComfyManagementResult> =>
  invokeWithProgress('install_comfyui_extension', { repositoryUrl }, onProgress);

export const installComfyDependencies = (repositoryId: string): Promise<ComfyManagementResult> =>
  invoke('install_comfyui_dependencies', { repositoryId });
