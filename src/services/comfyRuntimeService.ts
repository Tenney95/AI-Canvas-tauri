import { invoke } from '@tauri-apps/api/core';
import type { ComfyRuntimeSnapshot, ComfyRuntimeStartResult } from '../types/comfyRuntime';

/** 主窗口启动入口；路径仅是已有原生安装授权的校验候选。 */
export function launchComfyUI(comfyPath: string): Promise<ComfyRuntimeStartResult> {
  return invoke('launch_comfyui', { comfyPath });
}

/** 主窗口只读取状态，不跨窗口传输进程输出。 */
export function getComfyUIRuntimeStatus(): Promise<ComfyRuntimeStartResult> {
  return invoke('get_comfyui_runtime_status');
}

/** 管理窗口使用其原生会话绑定的安装，不接收路径或任意启动参数。 */
export function startManagedComfyUI(): Promise<ComfyRuntimeStartResult> {
  return invoke('start_comfyui_managed');
}

export function stopManagedComfyUI(runId: string): Promise<string> {
  return invoke('stop_comfyui_managed', { runId });
}

export function getComfyRuntimeSnapshot(runId: string | null, afterSequence: number): Promise<ComfyRuntimeSnapshot> {
  return invoke('get_comfyui_runtime_snapshot', { runId, afterSequence });
}
