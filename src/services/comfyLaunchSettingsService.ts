import { invoke } from '@tauri-apps/api/core';
import type { ComfyUILaunchSettings } from '../types/comfyLaunch';

export const getComfyLaunchSettings = (): Promise<ComfyUILaunchSettings> =>
  invoke('get_comfyui_launch_settings');

export const saveComfyLaunchSettings = (settings: ComfyUILaunchSettings): Promise<ComfyUILaunchSettings> =>
  invoke('save_comfyui_launch_settings', { settings });
