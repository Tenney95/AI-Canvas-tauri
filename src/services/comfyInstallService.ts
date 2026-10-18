import { Channel, invoke } from '@tauri-apps/api/core';
import type { ComfyInstallInfo, ComfyInstallProgress, ComfyInstallResult, ComfyInstallTarget } from '../types/comfyInstall';

export const getComfyInstallInfo = (): Promise<ComfyInstallInfo> => invoke('get_comfyui_install_info');
export const chooseComfyInstallTarget = (folderName: string): Promise<ComfyInstallTarget | null> =>
  invoke('choose_comfyui_install_target', { folderName });
export const cancelComfyInstall = (targetId: string | null): Promise<void> => invoke('cancel_comfyui_install', { targetId });

export async function installComfyPortable(targetId: string, variantId: string, onProgress: (progress: ComfyInstallProgress) => void): Promise<ComfyInstallResult> {
  const channel = new Channel<string>();
  channel.onmessage = (message) => onProgress(JSON.parse(message) as ComfyInstallProgress);
  try { return await invoke('install_comfyui_portable', { targetId, variantId, onProgress: channel }); }
  finally { channel.onmessage = () => {}; }
}
