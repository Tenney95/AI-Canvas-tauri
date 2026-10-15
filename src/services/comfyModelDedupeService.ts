import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  ComfyModelDedupeBatchRequest, ComfyModelDedupeHistory, ComfyModelDedupeProgress, ComfyModelDedupeRecovery, ComfyModelDedupeRequest,
  ComfyModelDedupeResult, ComfyModelDedupeScan, ComfyModelScanRoot, ComfyModelScanRootKind, ComfyModelScanScope,
} from '../types/comfyModelDedupe';

export async function scanComfyDuplicateModels(
  scope: ComfyModelScanScope,
  onProgress: (progress: ComfyModelDedupeProgress) => void,
  rootId?: string,
): Promise<ComfyModelDedupeScan> {
  const channel = new Channel<string>();
  channel.onmessage = (message) => {
    let value: ComfyModelDedupeProgress;
    try { value = JSON.parse(message) as ComfyModelDedupeProgress; } catch { return; }
    if (value && ['collecting', 'hashing', 'verifying', 'linking'].includes(value.stage)
      && Number.isFinite(value.completed) && value.completed >= 0
      && (value.unit === 'files' || value.unit === 'bytes')
      && (value.total == null || (Number.isFinite(value.total) && value.total >= 0))) {
      onProgress(value);
    }
  };
  try {
    return await invoke<ComfyModelDedupeScan>('scan_comfyui_duplicate_models', { scope, onProgress: channel, ...(rootId ? { rootId } : {}) });
  } finally { channel.onmessage = () => {}; }
}

export const chooseComfyModelScanRoot = (kind: ComfyModelScanRootKind): Promise<ComfyModelScanRoot | null> =>
  invoke('choose_comfyui_model_scan_root', { kind });

export const cancelComfyModelScan = (): Promise<void> =>
  invoke('cancel_comfyui_model_scan');

export const applyComfyModelDeduplication = (request: ComfyModelDedupeRequest): Promise<ComfyModelDedupeResult> =>
  invoke('apply_comfyui_model_deduplication', { request });

export const applyComfyModelDeduplicationBatch = (request: ComfyModelDedupeBatchRequest): Promise<ComfyModelDedupeResult> =>
  invoke('apply_comfyui_model_deduplication_batch', { request });

export const listComfyModelDedupeHistory = (): Promise<ComfyModelDedupeHistory> =>
  invoke('list_comfyui_model_dedupe_history');

export const listComfyModelDedupeRecoveries = (): Promise<ComfyModelDedupeRecovery[]> =>
  invoke('list_comfyui_model_dedupe_recoveries');

export const recoverComfyModelDedupe = (recoveryId: string): Promise<ComfyModelDedupeResult> =>
  invoke('recover_comfyui_model_dedupe', { recoveryId });
