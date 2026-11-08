import { beforeEach, expect, it, vi } from 'vitest';
import type { SharedAssetSyncCommitInput } from '../../src/services/indexedDb/sharedAssetSyncRepository';
const probes = vi.hoisted(() => ({ asset: vi.fn(), index: vi.fn(), journal: vi.fn() }));
vi.mock('../../src/services/indexedDb/nativeAssetRepository', () => ({ readNativeAsset: probes.asset, resolveNativeAssetIndex: probes.index }));
vi.mock('../../src/services/indexedDb/nativeSharedAssetSyncRepository', () => ({ readNativeSharedAssetSync: probes.journal, nativeSharedAssetReceiptKey: (id: string) => `receipt:${id}` }));
import { authorizeNativeSharedAssetSources, captureNativeSharedAssetSources } from '../../src/services/indexedDb/nativeSharedAssetSources';

const id = 'na2-00000000-0000-4000-8000-000000000001';
const asset = { assetId: id, projectId: 'project', tags: { assetId: id, tags: ['本机标签'], updatedAt: 1 }, images: [] };
const index = { assetId: id, relativePath: 'imports/original/a.png', size: 4 };
const input = (): SharedAssetSyncCommitInput => ({ ownerId: 'project', operationId: 'operation', mappings: [], operation: {} as never,
  expectedIndexes: [index as never], tags: [{ assetId: id, expected: asset.tags, next: asset.tags }],
  expectedImageRecords: [{ assetId: id, records: [] }], nativeAuthority: { projectId: 'project', memberIds: ['project'], receiptDigest: 'a'.repeat(64) } });

beforeEach(() => { vi.clearAllMocks(); probes.asset.mockResolvedValue(structuredClone(asset)); probes.index.mockResolvedValue(index);
  probes.journal.mockResolvedValue({ phase: 'prepared', projectId: 'project', receiptDigest: 'a'.repeat(64), memberIds: ['project'], nativeAssets: [asset] }); });

it('只有原新库journal的索引与metadata基线相同才过滤旧库只读条件，不产生na2镜像', async () => {
  expect(await captureNativeSharedAssetSources(input())).toEqual([asset]);
  const authorized = await authorizeNativeSharedAssetSources(input());
  expect(authorized.expectedIndexes).toEqual([]); expect(authorized.tags).toEqual([]); expect(authorized.expectedImageRecords).toEqual([]);
  expect(authorized.nativeAuthority).toEqual(input().nativeAuthority);
});

it('项目切换、元数据变化、撤销和直接写恢复素材都拒绝，原输入保持不变', async () => {
  const original = input();
  probes.asset.mockResolvedValueOnce({ ...asset, projectId: 'other' });
  await expect(authorizeNativeSharedAssetSources(original)).rejects.toThrow('不属于');
  probes.asset.mockResolvedValueOnce({ ...asset, tags: { ...asset.tags, tags: ['变化'] } });
  await expect(authorizeNativeSharedAssetSources(original)).rejects.toThrow('原标签');
  probes.journal.mockResolvedValueOnce({ phase: 'aborted', projectId: 'project' });
  await expect(authorizeNativeSharedAssetSources(original)).rejects.toThrow('原操作');
  await expect(authorizeNativeSharedAssetSources({ ...original, indexes: [index as never] })).rejects.toThrow('原索引');
  expect(original.expectedIndexes).toEqual([index]); expect(original.tags?.[0]?.next?.tags).toEqual(['本机标签']);
});
