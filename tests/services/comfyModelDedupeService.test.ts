import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComfyModelDedupeProgress, ComfyModelDedupeScan } from '../../src/types/comfyModelDedupe';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage: (message: string) => void }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage = (_message: string) => {};
    constructor() { native.channels.push(this); }
  },
}));

import { applyComfyModelDeduplication, applyComfyModelDeduplicationBatch, chooseComfyModelScanRoot, scanComfyDuplicateModels } from '../../src/services/comfyModelDedupeService';

beforeEach(() => { native.invoke.mockReset(); native.channels.length = 0; });

describe('ComfyUI model deduplication native bridge', () => {
  it('forwards scan scope, reports progress and detaches completed channels', async () => {
    let resolveScan!: (scan: ComfyModelDedupeScan) => void;
    native.invoke.mockReturnValue(new Promise<ComfyModelDedupeScan>((resolve) => { resolveScan = resolve; }));
    const updates: ComfyModelDedupeProgress[] = [];
    const pending = scanComfyDuplicateModels('modelsAndPlugins', (value) => updates.push(value));
    const progress: ComfyModelDedupeProgress = { stage: 'hashing', completed: 1024, total: 4096, unit: 'bytes' };
    native.channels[0].onmessage(JSON.stringify(progress));
    expect(native.invoke).toHaveBeenCalledWith('scan_comfyui_duplicate_models', { scope: 'modelsAndPlugins', onProgress: native.channels[0] });
    expect(updates).toEqual([progress]);
    const scan: ComfyModelDedupeScan = { scanId: 'opaque-scan', engine: 'Czkawka Core', groups: [], scannedFiles: 2, skippedFiles: 0, warnings: [], skippedEntries: [], omittedSkippedEntries: 0 };
    resolveScan(scan);
    expect(await pending).toBe(scan);
    native.channels[0].onmessage(JSON.stringify(progress));
    expect(updates).toHaveLength(1);
  });

  it('ignores malformed progress without interrupting the scan', async () => {
    native.invoke.mockResolvedValue({ scanId: 'scan', groups: [] });
    const onProgress = vi.fn();
    const pending = scanComfyDuplicateModels('models', onProgress);
    for (const message of ['{', 'null', '{}', JSON.stringify({ stage: 'hashing', completed: -1, unit: 'bytes' }), JSON.stringify({ stage: 'hashing', completed: 1, total: 'bad', unit: 'bytes' })]) {
      native.channels[0].onmessage(message);
    }
    await pending;
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('requests external roots from the native picker and handles cancellation', async () => {
    native.invoke.mockResolvedValue(null);
    expect(await chooseComfyModelScanRoot('disk')).toBeNull();
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('choose_comfyui_model_scan_root', { kind: 'disk' });
  });

  it('scans an external folder using only its opaque native grant', async () => {
    native.invoke.mockResolvedValue({ scanId: 'scan', groups: [] });
    await scanComfyDuplicateModels('folder', () => {}, 'opaque-root');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('scan_comfyui_duplicate_models', {
      scope: 'folder', rootId: 'opaque-root', onProgress: native.channels[0],
    });
  });

  it('submits opaque identities unchanged for differently named model paths', async () => {
    const request = { scanId: 'scan', groupId: 'content-group', keeperId: 'model-a', targetIds: ['renamed-model-b'], linkType: 'hardlink' as const };
    native.invoke.mockResolvedValue({ completed: 1, reclaimedBytes: 4096, message: 'done', warnings: [] });
    expect((await applyComfyModelDeduplication(request)).completed).toBe(1);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('apply_comfyui_model_deduplication', { request });
  });

  it('propagates replacement failures without automatic retries', async () => {
    native.invoke.mockRejectedValue(new Error('扫描后文件已变化'));
    await expect(applyComfyModelDeduplication({ scanId: 'old-scan', groupId: 'g', keeperId: 'a', targetIds: ['b'], linkType: 'symlink' })).rejects.toThrow('扫描后文件已变化');
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it('submits all selected groups in one native invocation and never retries a partial batch', async () => {
    const request = { scanId: 'scan', groups: [
      { groupId: 'a', keeperId: 'keeper-a', targetIds: ['target-a'], linkType: 'hardlink' as const },
      { groupId: 'b', keeperId: 'keeper-b', targetIds: ['target-b'], linkType: 'symlink' as const },
    ] };
    const result = { completed: 1, failed: 1, unprocessed: 0, reclaimedBytes: 4096, message: 'partial', warnings: [], historyId: 'opaque-history' };
    native.invoke.mockResolvedValue(result);
    expect(await applyComfyModelDeduplicationBatch(request)).toEqual(result);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('apply_comfyui_model_deduplication_batch', { request });
  });
});
