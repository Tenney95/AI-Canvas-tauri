import { invoke } from '@tauri-apps/api/core';

export type NativeProjectImportProgress = { phase: 'copy'; percent: number }
  | { phase: 'publish'; taskId: string }
  | { phase: 'backup' | 'idle' };

export interface NativeProjectImportTransfer {
  signal?: AbortSignal;
  onNativeProgress?: (progress: NativeProjectImportProgress) => void;
}

export class NativeProjectImportPausedError extends Error {
  readonly operationId: string;

  constructor(operationId: string, cause: unknown) {
    super(`已取消导入，原操作 ${operationId} 已保留，可继续原操作`, { cause });
    this.operationId = operationId;
  }
}

/** 每次传输单独取消，同一持久操作仍可按原身份续接。 */
export async function publishNativeProjectImportAssets(args: { operationId: string } & Record<string, unknown>,
  transfer?: NativeProjectImportTransfer): Promise<void> {
  const signal = transfer?.signal;
  const report = transfer?.onNativeProgress;
  if (!signal && !report) return invoke<void>('publish_project_import_assets', args);
  signal?.throwIfAborted();
  const taskId = crypto.randomUUID();
  const cancel = () => { void invoke('cancel_file_transfer', { taskId }).catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    report?.({ phase: 'publish', taskId });
    signal?.throwIfAborted();
    await invoke('publish_project_import_assets', { ...args, transferId: taskId });
  } catch (error) {
    if (error === '项目导入已取消') signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    report?.({ phase: 'idle' });
  }
}
