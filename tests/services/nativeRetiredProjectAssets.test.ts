import { beforeEach, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';
import type { ProjectModelTransferAggregate } from '../../src/types/projectModelTransfer';

const io = vi.hoisted(() => ({
  index: vi.fn(), getRoot: vi.fn(), retiredCanvasIds: vi.fn(), identifyAsset: vi.fn(), tags: vi.fn(),
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
  getAssetIndexById: io.index, getAssetMetaById: io.tags, getAssetImageRecords: async () => [],
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
  { changed: { projectId: otherCanvasId }, archiveError: '原素材缺少本项目索引或文件摘要证明' },
  { changed: { rootPath: '/workspace/another-project' }, archiveError: '素材索引根与原生文件根不一致' },
])('索引不属于同一作品或真实素材根时拒绝读取', async ({ changed, archiveError }) => {
  io.index.mockResolvedValue({ ...index, ...changed });
  await expect(listProjectAssets()).rejects.toThrow('其他来源');
  await expect(captureNativeAssetSnapshots(capture, [], assets)).rejects.toThrow(archiveError);
});
