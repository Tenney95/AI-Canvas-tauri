/**
 * 封装导演台运行时的安装状态、下载进度、安装控制和打开入口等 Tauri 调用。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const DIRECTOR_DESK_INSTALL_PROGRESS_EVENT = 'director-desk:install-progress';

export interface DirectorDeskRuntimeStatus {
  installed: boolean;
  installing: boolean;
  version: string;
  downloadBytes: number;
  installedBytes: number;
}

export type DirectorDeskInstallStage =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'complete';

export interface DirectorDeskInstallProgress {
  stage: DirectorDeskInstallStage;
  transferredBytes: number;
  totalBytes: number;
}

export function requiresDirectorDeskRuntime(): boolean {
  return isDirectorDeskRuntimeAvailable();
}

export function isDirectorDeskRuntimeAvailable(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
}

export function getDirectorDeskRuntimeStatus(): Promise<DirectorDeskRuntimeStatus> {
  return invoke<DirectorDeskRuntimeStatus>('director_desk_runtime_status');
}

export function installDirectorDeskRuntime(archivePath?: string): Promise<DirectorDeskRuntimeStatus> {
  return invoke<DirectorDeskRuntimeStatus>('install_director_desk_runtime', {
    archivePath: archivePath ?? null,
  });
}

export function cancelDirectorDeskInstall(): Promise<void> {
  return invoke<void>('cancel_director_desk_install');
}

export function removeDirectorDeskRuntime(): Promise<DirectorDeskRuntimeStatus> {
  return invoke<DirectorDeskRuntimeStatus>('remove_director_desk_runtime');
}

export function subscribeDirectorDeskInstallProgress(
  handler: (progress: DirectorDeskInstallProgress) => void,
): Promise<UnlistenFn> {
  return listen<DirectorDeskInstallProgress>(DIRECTOR_DESK_INSTALL_PROGRESS_EVENT, (event) => {
    handler(event.payload);
  });
}
