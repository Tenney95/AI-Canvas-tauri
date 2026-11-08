/** 新库写锁下核验共享同步的恢复素材源；旧库只写新目标身份。 */
import type { SharedAssetSyncCommitInput } from './sharedAssetSyncRepository';
import { configValuesEqual } from '../configPatch';
import { readNativeAsset, resolveNativeAssetIndex, type NativeAssetRecord } from './nativeAssetRepository';
import { readNativeSharedAssetSync } from './nativeSharedAssetSyncRepository';
import { openDB, STORE_METADATA } from './schema';
import { nativeSharedAssetReceiptKey } from './nativeSharedAssetSyncRepository';

const native = (id: string) => id.startsWith('na2-');
export async function captureNativeSharedAssetSources(input: SharedAssetSyncCommitInput): Promise<NativeAssetRecord[]> {
  if ((input.indexes ?? []).some((row) => native(row.assetId)) || (input.images ?? []).some((row) => native(row.next.assetId))) throw new Error('共享同步不能改写恢复素材身份，请为新内容建立新目标');
  const ids = new Set([...(input.expectedIndexes ?? []), ...(input.tags ?? []), ...(input.expectedImages ?? []), ...(input.expectedImageRecords ?? [])].map((row) => row.assetId).filter(native));
  const records: NativeAssetRecord[] = [];
  for (const assetId of ids) {
    const record = await readNativeAsset(assetId);
    if (!record || record.projectId !== input.ownerId) throw new Error('共享同步的恢复素材不属于当前作品');
    const projected = await resolveNativeAssetIndex(record);
    for (const expected of (input.expectedIndexes ?? []).filter((row) => row.assetId === assetId)) {
      if (!configValuesEqual(projected, expected)) throw new Error('恢复素材索引已变化，请重新预览共享同步');
    }
    for (const tags of (input.tags ?? []).filter((row) => row.assetId === assetId)) {
      if (!configValuesEqual(tags.expected, record.tags ?? null) || !configValuesEqual(tags.next, tags.expected)) throw new Error('共享同步不能覆盖恢复素材原标签');
    }
    for (const image of (input.expectedImages ?? []).filter((row) => row.assetId === assetId)) {
      if (!configValuesEqual(image, record.images?.find((row) => row.id === image.id))) throw new Error('恢复素材图片信息已变化');
    }
    for (const baseline of (input.expectedImageRecords ?? []).filter((row) => row.assetId === assetId)) {
      const sorted = (rows: readonly { id: string }[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
      if (!configValuesEqual(sorted(baseline.records), sorted(record.images ?? []))) throw new Error('恢复素材图片集合已变化');
    }
    records.push(record);
  }
  return records.sort((a, b) => a.assetId.localeCompare(b.assetId));
}

export async function authorizeNativeSharedAssetSources(input: SharedAssetSyncCommitInput): Promise<SharedAssetSyncCommitInput> {
  if ((input.indexes ?? []).some((row) => native(row.assetId)) || (input.images ?? []).some((row) => native(row.next.assetId))
    || (input.tags ?? []).some((row) => native(row.assetId) && !configValuesEqual(row.expected, row.next))) throw new Error('共享同步不能改写恢复素材原索引或元数据');
  const ids = [...(input.expectedIndexes ?? []), ...(input.tags ?? []), ...(input.expectedImages ?? []), ...(input.expectedImageRecords ?? [])].filter((row) => native(row.assetId));
  if (!ids.length && !(input.indexes ?? []).some((row) => native(row.assetId)) && !(input.images ?? []).some((row) => native(row.next.assetId))) return input;
  if (!input.nativeAuthority) throw new Error('恢复素材共享同步缺少新项目写锁');
  const journal = await readNativeSharedAssetSync(input.operationId);
  if (!journal || !['prepared', 'finalized'].includes(journal.phase) || journal.projectId !== input.ownerId
    || journal.receiptDigest !== input.nativeAuthority.receiptDigest || !configValuesEqual(journal.memberIds, input.nativeAuthority.memberIds)) throw new Error('恢复素材共享同步原操作不匹配');
  if (journal.phase === 'prepared') {
    const current = await captureNativeSharedAssetSources(input);
    if (!configValuesEqual(current, journal.nativeAssets ?? [])) throw new Error('恢复素材共享同步源基线已变化');
  } else {
    const db = await openDB();
    const receipt = await new Promise<{ projectId?: string; digest?: string; status?: string } | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_METADATA, 'readonly').objectStore(STORE_METADATA).get(nativeSharedAssetReceiptKey(input.operationId));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (!receipt || receipt.projectId !== input.ownerId || receipt.digest !== journal.receiptDigest || receipt.status !== undefined) throw new Error('原共享同步完成收据缺失，不能重投');
  }
  const proved = new Set((journal.nativeAssets ?? []).map((record) => record.assetId));
  if (ids.some((row) => !proved.has(row.assetId))) throw new Error('共享同步包含未冻结的恢复素材');
  return { ...input, expectedIndexes: input.expectedIndexes?.filter((row) => !native(row.assetId)),
    tags: input.tags?.filter((row) => !native(row.assetId)), expectedImages: input.expectedImages?.filter((row) => !native(row.assetId)),
    expectedImageRecords: input.expectedImageRecords?.filter((row) => !native(row.assetId)) };
}
