import { beforeEach, expect, it, vi } from 'vitest';
import type { NativeAssetSnapshot } from '../../src/services/nativeProjectAssetRecovery';
const root = 'r2-11111111-1111-4111-8111-111111111111', subroot = 'r2-22222222-2222-4222-8222-222222222222';
const probes = vi.hoisted(() => ({ invoke: vi.fn(), fingerprint: vi.fn(), index: vi.fn(), exists: vi.fn(async () => false) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: probes.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: probes.exists }));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({ fingerprintAssetImage: probes.fingerprint }));
vi.mock('../../src/services/indexedDbService', () => ({ getAssetIndexById: probes.index }));
vi.mock('../../src/services/indexedDb/nativeAssetRepository', () => ({ isNativeAssetId: (value: string) => value.startsWith('na2-') }));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', () => ({ readNativeProjectContent: async () => ({ project: {
  storageRootRef: 'r2-11111111-1111-4111-8111-111111111111', storageBindings: [{ rootRef: 'r2-11111111-1111-4111-8111-111111111111' }, { rootRef: 'r2-22222222-2222-4222-8222-222222222222' }] } }) }));
vi.mock('../../src/services/fs/core', () => ({ getBaseDir: async () => '/base', joinPath: (...parts: string[]) => parts.join('/'), stripVerbatimPrefix: (value: string) => value }));
import { freezeNativeAssetImageReferences } from '../../src/services/nativeAssetReferenceFiles';

const operationId = '33333333-3333-4333-8333-333333333333';
const snapshot = (assetId = 'old-asset', rootRef = root): NativeAssetSnapshot => ({ assetId, rootRef, path: 'media/image.png', ownerId: 'project', bytes: 4, sha256: 'c'.repeat(64),
  images: [{ id: `asset-image:${encodeURIComponent(assetId)}:${'d'.repeat(64)}`, assetId, contentDigest: 'd'.repeat(64), fileName: 'image.png', prompt: '提示词', revision: 1, updatedAt: 1,
    references: [{ id: 'ref', name: '参考图', relativePath: 'asset-image-references/44444444-4444-4444-8444-444444444444.png', digest: 'b'.repeat(64), bytes: 4 }] }] });
beforeEach(() => {
  probes.fingerprint.mockReset().mockResolvedValue({ digest: 'b'.repeat(64), bytes: 4 });
  probes.index.mockReset().mockResolvedValue({ source: 'project', rootPath: '/native-source' }); probes.exists.mockReset().mockResolvedValue(false);
  probes.invoke.mockReset().mockImplementation(async (command: string, input: { assetsDir?: string; selectedPaths?: string[] }) => {
    if (command === 'resolve_native_project_media_root') return '/project';
    if (command === 'resolve_native_project_media_subroot') return '/project/subroot';
    if (command === 'publish_project_import_assets') return;
    if (command === 'inspect_project_archive_assets') return input.selectedPaths!.map((path) => ({ path, bytes: 4, sha256: 'a'.repeat(64) }));
    throw new Error('unexpected command');
  });
});

it('旧引用仅从专属目录读取，按raw SHA发布并保留chain摘要；原metadata不改写', async () => {
  const original = [snapshot()];
  const result = await freezeNativeAssetImageReferences('project', operationId, original);
  expect(probes.invoke).toHaveBeenCalledWith('publish_project_import_assets', expect.objectContaining({
    stagingDir: '/base/asset-image-references', projectDir: '/project', operationId: `asset-refs-${operationId}`,
    sourceRoots: [{ rootRef: 'source-0', directory: '/base/asset-image-references' }],
    assets: [expect.objectContaining({ path: '44444444-4444-4444-8444-444444444444.png', destinationPath: `ref-${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64) })],
  }));
  expect(result.referenceFiles).toEqual([{ rootRef: root, path: `imports/asset-refs-${operationId}/ref-${'a'.repeat(64)}.png`, bytes: 4, sha256: 'a'.repeat(64) }]);
  expect(result.snapshots[0].images?.[0].references[0]).toMatchObject({ digest: 'b'.repeat(64), relativePath: result.referenceFiles[0].path });
  expect(original[0].images?.[0].references[0].relativePath).toMatch(/^asset-image-references\//);
});

it('na2来源按索引根读取，subroot引用不会误发到primary根', async () => {
  const original = snapshot('na2-new', subroot); original.images![0].references[0].relativePath = 'imports/old/ref.png';
  const result = await freezeNativeAssetImageReferences('project', operationId, [original]);
  expect(probes.invoke).toHaveBeenCalledWith('publish_project_import_assets', expect.objectContaining({ stagingDir: '/native-source', projectDir: '/project/subroot' }));
  expect(result.referenceFiles[0].rootRef).toBe(subroot);
});

it('内容变化或发布副本不满足原chain身份时拒绝，旧记录仍保留', async () => {
  probes.fingerprint.mockResolvedValueOnce({ digest: 'e'.repeat(64), bytes: 4 });
  await expect(freezeNativeAssetImageReferences('project', operationId, [snapshot()])).rejects.toThrow('原图片专属参考图已变化');
  expect(probes.invoke.mock.calls.some(([command]) => command === 'publish_project_import_assets')).toBe(false);
  probes.fingerprint.mockResolvedValueOnce({ digest: 'b'.repeat(64), bytes: 4 }).mockResolvedValueOnce({ digest: 'e'.repeat(64), bytes: 4 });
  const original = [snapshot()];
  await expect(freezeNativeAssetImageReferences('project', operationId, original)).rejects.toThrow('副本内容与原元数据不一致');
  expect(original[0].images?.[0].references[0].relativePath).toMatch(/^asset-image-references\//);
});
