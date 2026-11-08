import type { ProjectModelTransferCapture } from '../types/projectModelTransfer';

/** 只发现已建模的媒体身份；云端人像绑定与历史回执不是文件资产。 */
export function nativeGlobalAssetReferenceRows(capture: ProjectModelTransferCapture): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [], seen = new WeakSet<object>();
  const skip = new Set(['volcengineBinding', 'executionContext', 'projectScope', 'taskReceipt', 'mediaTaskReceipt', 'agentTask', 'mcpOperation', 'dispatchHistory']);
  let count = 0;
  const walk = (value: unknown, field = '', depth = 0): void => {
    if (++count > 1_000_000 || depth > 64) throw new Error('全局素材引用超过核验上限');
    if (skip.has(field) || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((item) => walk(item, field, depth + 1)); return; }
    const row = value as Record<string, unknown>;
    if (typeof row.assetId === 'string' && row.assetId || typeof row.imageAssetId === 'string' && row.imageAssetId || row.assetSource === 'global') rows.push(row);
    Object.entries(row).forEach(([key, item]) => walk(item, key, depth + 1));
  };
  walk(capture.aggregate.content); walk(capture.aggregate.episodeContents); walk(capture.aggregate.canvases); walk(capture.aggregate.project.defaultSettings);
  return rows;
}
