import { invoke } from '@tauri-apps/api/core';
import type {
  ComfyCatalogEntry,
  ComfyManagementResult,
  ComfyManagementSnapshot,
  ComfyManagementUiContext,
  ComfyRepositoryAction,
  ComfyVersion,
} from '../types/comfyManagement';

/** 目录选择、校验与持久授权均由原生层完成；取消保持原选择。 */
export const selectComfyInstallation = (): Promise<string | null> =>
  invoke('select_comfyui_installation');

/** 只恢复原生已保存的选择，不根据前端配置字符串扩大目录权限。 */
export const getComfyInstallation = (): Promise<string | null> =>
  invoke('get_comfyui_installation');

export const openComfyManagementWindow = (comfyPath: string, uiContext: ComfyManagementUiContext): Promise<void> =>
  invoke('open_comfyui_settings_window', { comfyPath, uiContext });

export const getComfyManagementSnapshot = (): Promise<ComfyManagementSnapshot> =>
  invoke('get_comfyui_management_snapshot');

export const listComfyVersions = (repositoryId: string, refresh = false): Promise<ComfyVersion[]> =>
  invoke('list_comfyui_versions', { repositoryId, refresh });

export const applyComfyRepositoryAction = (request: ComfyRepositoryAction): Promise<ComfyManagementResult> =>
  invoke('apply_comfyui_repository_action', { request });

export const listComfyCatalog = (): Promise<ComfyCatalogEntry[]> =>
  invoke('list_comfyui_catalog');

export const installComfyExtension = (repositoryUrl: string): Promise<ComfyManagementResult> =>
  invoke('install_comfyui_extension', { repositoryUrl });

export const installComfyDependencies = (repositoryId: string): Promise<ComfyManagementResult> =>
  invoke('install_comfyui_dependencies', { repositoryId });
