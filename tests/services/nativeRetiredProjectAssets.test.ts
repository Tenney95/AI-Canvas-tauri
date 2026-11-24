import { beforeEach, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';
import type { AssetImageRecord } from '../../src/types/assetImage';
import type { ProjectModelTransferAggregate } from '../../src/types/projectModelTransfer';

const io = vi.hoisted(() => ({
  index: vi.fn(), getRoot: vi.fn(), retiredCanvasIds: vi.fn(), identifyAsset: vi.fn(), tags: vi.fn(),
  images: vi.fn(), repairIndexes: vi.fn(),
}));
const projectId = 'p2-11111111-1111-4111-8111-111111111111';
const retiredCanvasId = 'c2-22222222-2222-4222-8222-222222222222';
const otherCanvasId = 'c2-33333333-3333-4333-8333-333333333333';
const rootRef = 'r2-11111111-1111-4111-8111-111111111111';
const directory = '/workspace/project';
const relativePath = 'image.png';
const path = `${directory}/${relativePath}`;

vi.mock('@tauri-apps/api/core', () => ({ invoke: () => io.getRoot() }));
vi.mock('@tauri-apps/plugin-fs', async (original) => ({
  ...await original<typeof import('@tauri-apps/plugin-fs')>(),
  readDir: async () => [{ name: 'image.png', isDirectory: false, isFile: true, isSymlink: false }],
  stat: async () => ({ size: 10 }),
}));
vi.mock('../../src/services/fs/core', async (original) => ({
  ...await original<typeof import('../../src/services/fs/core')>(),
  isTauriEnv: () => true,
  getNativeProjectOwner: (id: string) => id === projectId ? projectId : undefined,
  getProjectDataDir: io.getRoot,
  getConvertFileSrc: async () => (value: string) => `asset://${value}`,
}));
vi.mock('../../src/services/fs/assetIndex', async (original) => ({
  ...await original<typeof import('../../src/services/fs/assetIndex')>(), identifyAsset: io.identifyAsset,
}));
vi.mock('../../src/services/indexedDb/mediaRelocations', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/mediaRelocations')>(), retiredMediaPaths: async () => new Set<string>(),
}));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/nativeProjectRepository')>(), listNativeRetiredCanvasIds: io.retiredCanvasIds,
}));
vi.mock('../../src/services/indexedDbService', () => ({
  loadProjectAssetPathLookup: async () => (paths: string[]) => Promise.all(paths.map(() => io.index())),
  getAssetIndexById: io.index, getAssetMetaById: io.tags, getAssetImageRecords: io.images, putAssetIndexes: io.repairIndexes,
}));

import { walkDirectoryFiles } from '../../src/services/fs/assetLibrary';
import { captureNativeAssetSnapshots } from '../../src/services/nativeProjectAssetRecovery';

const index: AssetIndexRecord = { assetId: 'original-asset', projectId: retiredCanvasId, source: 'project', path,
  rootPath: directory, relativePath, size: 10, mtimeMs: 0, fingerprint: '10:0', status: 'online', updatedAt: 1 };
const capture = {
  project: { id: projectId, storageRootRef: rootRef }, content: { reference: { assetId: index.assetId, relativePath } }, canvases: [],
} as unknown as ProjectModelTransferAggregate;
const assets = [{ rootRef, path: relativePath, bytes: 10, sha256: 'a'.repeat(64) }];

function listProjectAssets() {
  return walkDirectoryFiles(directory, { source: 'project', projectId, projectIdentityScope: [projectId], preserveProjectIdentity: true });
}

beforeEach(() => {
  vi.resetAllMocks();
  io.index.mockResolvedValue(index);
  io.getRoot.mockResolvedValue(directory);
  io.retiredCanvasIds.mockResolvedValue([retiredCanvasId]);
  io.tags.mockResolvedValue({ assetId: index.assetId, path, tags: ['场景'], taggedBy: 'manual', updatedAt: 1 });
  io.images.mockResolvedValue([]);
});

it('资源库继续显示退役分集的原素材，保留身份且无需刷新原索引', async () => {
  await expect(listProjectAssets()).resolves.toMatchObject([
    { assetId: index.assetId, ownerProjectId: projectId, path, relativePath },
  ]);
  expect(io.retiredCanvasIds).toHaveBeenCalledWith(projectId, expect.any(Object));
  expect(io.identifyAsset).not.toHaveBeenCalled();
});

it('归档以作品归属保留仍被引用的退役分集素材和原标签', async () => {
  await expect(captureNativeAssetSnapshots(capture, [], assets)).resolves.toMatchObject([
    { assetId: index.assetId, ownerId: projectId, rootRef, path: relativePath, tags: { tags: ['场景'] } },
  ]);
  expect(io.index).toHaveBeenCalledWith(index.assetId);
});

it.each([
  { rootPath: undefined, relativePath: undefined },
  { rootPath: undefined, relativePath },
  { rootPath: directory, relativePath: undefined },
])('归档按原生文件摘要补齐活动画布旧素材的定位字段 %o', async (location) => {
  const legacyIndex = { ...index, projectId: otherCanvasId, ...location };
  const activeCapture = { ...capture, canvases: [{ id: otherCanvasId } as ProjectModelTransferAggregate['canvases'][number]] };
  io.index.mockResolvedValue(legacyIndex);
  io.repairIndexes.mockImplementation(async (records: AssetIndexRecord[]) => records);

  await expect(captureNativeAssetSnapshots(activeCapture, [], assets)).resolves.toMatchObject([
    { assetId: index.assetId, ownerId: otherCanvasId, path: relativePath, sha256: assets[0].sha256 },
  ]);
  expect(io.repairIndexes).toHaveBeenCalledExactlyOnceWith(
    [{ ...legacyIndex, rootPath: directory, relativePath }], { repairMissingProjectLocation: true },
  );
});

it('用替代备份归档时拒绝推断缺失的原素材位置', async () => {
  io.index.mockResolvedValue({ ...index, rootPath: undefined, relativePath: undefined });
  const backups = assets.map((asset) => ({ ...asset, backupSourceRelativePath: 'replacement.png' }));
  await expect(captureNativeAssetSnapshots(capture, [], backups)).rejects.toThrow('原素材缺少本项目索引或文件摘要证明');
  expect(io.repairIndexes).not.toHaveBeenCalled();
});

it('同一根和路径的重复摘要即使完全相同也无法补写索引', async () => {
  io.index.mockResolvedValue({ ...index, rootPath: undefined, relativePath: undefined });
  await expect(captureNativeAssetSnapshots(capture, [], [assets[0], { ...assets[0] }]))
    .rejects.toThrow('原素材缺少本项目索引或文件摘要证明');
  expect(io.repairIndexes).not.toHaveBeenCalled();
});

it('全局素材证明须同时满足身份、根、路径、大小和摘要', async () => {
  io.index.mockResolvedValue({ ...index, source: 'global', projectId: undefined });
  const matching = { ...assets[0], assetId: index.assetId };
  const mismatches = [{ ...matching, bytes: 9 }, { ...matching, sha256: 'b'.repeat(64) },
    { ...matching, rootRef: 'other-root' }, { ...matching, path: 'other.png' }, { ...matching, assetId: 'different-asset' }];
  await expect(captureNativeAssetSnapshots(capture, [], assets, mismatches))
    .rejects.toThrow('原素材缺少本项目索引或文件摘要证明');
  await expect(captureNativeAssetSnapshots(capture, [], [...assets, { ...assets[0], rootRef: 'other-root' }], [...mismatches, matching]))
    .resolves.toMatchObject([{ assetId: index.assetId, ownerId: projectId, sha256: matching.sha256 }]);
  expect(io.getRoot).not.toHaveBeenCalled();
  expect(io.repairIndexes).not.toHaveBeenCalled();
});

it('同一素材的多个引用只捕获一次，图片元数据按读取顺序独立复制', async () => {
  const image: AssetImageRecord = { id: 'first', assetId: index.assetId, contentDigest: 'a'.repeat(64),
    fileName: relativePath, prompt: '', references: [], revision: 1, updatedAt: 1 };
  const other = { ...image, id: 'other', assetId: 'other-asset' };
  const second = { ...image, id: 'second', contentDigest: 'b'.repeat(64) };
  io.images.mockResolvedValue([image, other, second]);
  const secondReference = { imageAssetId: index.assetId, imageRelativePath: relativePath };
  const repeated = { ...capture, canvases: [secondReference as unknown as ProjectModelTransferAggregate['canvases'][number]] };

  const snapshots = await captureNativeAssetSnapshots(repeated, [], assets);

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].images).toEqual([image, second]);
  expect(snapshots[0].images?.[0].references).not.toBe(image.references);
  expect(io.index).toHaveBeenCalledExactlyOnceWith(index.assetId);
});

it.each([
  { changed: { projectId: otherCanvasId }, archiveError: '原素材缺少本项目索引或文件摘要证明' },
  { changed: { rootPath: '/workspace/another-project' }, archiveError: '素材索引根与原生文件根不一致' },
])('索引不属于同一作品或真实素材根时拒绝读取', async ({ changed, archiveError }) => {
  io.index.mockResolvedValue({ ...index, ...changed });
  await expect(listProjectAssets()).rejects.toThrow('其他来源');
  await expect(captureNativeAssetSnapshots(capture, [], assets)).rejects.toThrow(archiveError);
  expect(io.repairIndexes).not.toHaveBeenCalled();
});
