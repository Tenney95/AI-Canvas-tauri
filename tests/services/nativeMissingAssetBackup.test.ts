/** 明确缺失时才使用同版本备份；全程只用替身，不访问用户文件。 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { ProjectModelTransferCapture } from '../../src/types/projectModelTransfer';
import type { NativeContentRecoveryPoint } from '../../src/services/indexedDb/nativeProjectRepository';
import type { ValidatedProjectArchiveV4 } from '../../src/types/projectArchiveV4';
const io = vi.hoisted(() => ({ invoke: vi.fn(), lstat: vi.fn(), paths: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ lstat: io.lstat }));
vi.mock('../../src/services/projectModelArchiveNativePort', () => ({ currentStoragePaths: io.paths }));
import { prepareNativeMissingAssetBackup, validateNativeMissingAssetProof, assertNativeFileMissing } from '../../src/services/nativeMissingAssetBackup';

const operation = '00000000-0000-4000-8000-000000000001', root = 'r2-00000000-0000-4000-8000-000000000002';
const project = 'p2-00000000-0000-4000-8000-000000000003', sha = 'a'.repeat(64);
const file = { id: 'file-a', rootRef: 'logical-root', relativePath: 'media/a.png', mediaId: 'media-a' };
function fixture() {
  const snapshot = { entities: [{ kind: 'file', id: file.id, data: { rootRef: file.rootRef, relativePath: file.relativePath, mediaId: file.mediaId } },
    { kind: 'file', id: 'stale', data: { rootRef: file.rootRef, relativePath: 'media/deleted.png', mediaId: 'stale-media' } }],
    media: [{ id: file.mediaId, bytes: 3, sha256: sha, extension: 'png' }, { id: 'stale-media', bytes: 4, sha256: 'b'.repeat(64), extension: 'png' }] };
  const exchange = { localHead: { canonicalVersion: 2, revisionId: 'head' }, bundle: { revisions: [{ canonicalVersion: 2, revisionId: 'head', snapshot }] },
    identities: [{ kind: 'storage-root', localId: root, sourceId: 'logical-root' }], fileBindings: [{ id: file.id, rootRef: file.rootRef, relativePath: file.relativePath, localRelativePath: 'media/a.png' },
      { id: 'stale', rootRef: file.rootRef, relativePath: 'media/deleted.png', localRelativePath: 'media/deleted.png' }] };
  const expected = { aggregate: { project: { id: project, storageRootRef: root, storageBindings: [{ rootRef: root }] } }, exchange } as unknown as ProjectModelTransferCapture;
  const point = { projectId: project, operationId: `recovery-${operation}`, exchange,
    backup: { operationId: `backup-${operation}`, outputRef: 'published', packageDigest: 'c'.repeat(64) } } as unknown as NativeContentRecoveryPoint;
  const source = { files: [file], snapshot: structuredClone(snapshot), payload: { exchange: { files: [{ mediaId: file.mediaId, archivePath: 'assets/a.png' }] } } } as unknown as ValidatedProjectArchiveV4;
  return { expected, point, source };
}
beforeEach(() => {
  vi.clearAllMocks(); io.paths.mockReturnValue(new Map([[root, new Set(['media/a.png'])]]));
  io.lstat.mockRejectedValue(new Error('os error 2: file not found'));
  io.invoke.mockImplementation(async (command: string, args: { selectedPaths?: string[] }) => {
    if (command === 'resolve_native_project_media_root') return 'C:/fixture';
    if (command === 'publish_project_import_assets') return undefined;
    if (command === 'inspect_project_archive_assets') return args.selectedPaths!.map((path) => ({ path, bytes: 3, sha256: sha }));
    throw new Error('unexpected command');
  });
});

it('只复制当前仍引用且当前head和所选备份完全一致的字节，不读取已删正文的陈旧附件', async () => {
  const { expected, point, source } = fixture();
  const proofs = await prepareNativeMissingAssetBackup(expected, point, source, 'C:/isolated-backup', operation);
  expect(proofs).toHaveLength(1); expect(proofs[0]).toMatchObject({ rootRef: root, path: 'media/a.png', fileId: file.id,
    copyPath: `imports/missing-backup-${operation}/copy-${sha}.png`, sha256: sha, bytes: 3 });
  expect(io.lstat).toHaveBeenCalledTimes(1);
  expect(io.invoke).toHaveBeenCalledWith('publish_project_import_assets', expect.objectContaining({ projectDir: 'C:/fixture', operationId: `missing-backup-${operation}` }));
  expect(() => validateNativeMissingAssetProof(expected, point, { ...proofs[0], sha256: 'b'.repeat(64) }, operation)).toThrow();
});

it('权限失败、版本不同或原路径重新出现均保留现状，不把未知字节当缺失恢复', async () => {
  io.lstat.mockRejectedValueOnce(new Error('permission denied (os error 5)'));
  await expect(assertNativeFileMissing('C:/fixture/media/a.png')).rejects.toThrow('permission denied');
  io.lstat.mockResolvedValueOnce({ isFile: true });
  await expect(assertNativeFileMissing('C:/fixture/media/a.png')).rejects.toThrow('重新出现');
  const { expected, point, source } = fixture(); source.snapshot.media[0].sha256 = 'd'.repeat(64);
  await expect(prepareNativeMissingAssetBackup(expected, point, source, 'C:/isolated-backup', operation)).rejects.toThrow('没有相同版本');
  expect(io.invoke).not.toHaveBeenCalledWith('publish_project_import_assets', expect.anything());
});
