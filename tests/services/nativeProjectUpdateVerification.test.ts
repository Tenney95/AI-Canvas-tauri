/** 新项目提交前的权威读回编排；只使用隔离替身，不访问真实文件。 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { NativeProjectUpdateJournal } from '../../src/services/indexedDb/nativeProjectRepository';

const probes = vi.hoisted(() => ({ backup: vi.fn(async () => {}), capture: vi.fn(), inspect: vi.fn(async () => []),
  publish: vi.fn(async () => {}), points: vi.fn(async () => [] as Array<{ operationId: string }>), restore: vi.fn(async () => {}),
  openBackup: vi.fn(), project: vi.fn(), remove: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-fs', () => ({ remove: probes.remove }));
vi.mock('../../src/services/projectModelArchiveService', () => ({ prepareProjectModelArchiveCapture: probes.project }));
vi.mock('../../src/services/nativeProjectArchiveService', () => ({ captureNativeProjectArchive: probes.capture }));
vi.mock('../../src/services/projectModelArchiveNativePort', () => ({
  createBoundProjectModelArchiveExportPort: () => ({ inspectAssets: probes.inspect }),
  createBoundProjectModelArchiveImportPort: () => ({ verifyMediaPublication: probes.publish }),
}));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/nativeProjectRepository')>(),
  listNativeContentRecoveryPoints: probes.points,
}));
vi.mock('../../src/services/nativeProjectUpdateMedia', () => ({ verifyNativeUpdateBackup: probes.backup,
  verifyNativeRestoreAssets: probes.restore, openNativeUpdateBackup: probes.openBackup, nativeUpdateInventory: (assets: unknown) => assets }));
import { verifyNativeProjectUpdateCommit } from '../../src/services/nativeProjectUpdateVerification';

const operation = () => ({ operationId: 'operation', projectId: 'project', phase: 'media_ready', sourceRef: 'source',
  mediaPublicationRef: 'media_v1_operation', mode: 'update-existing', backup: { operationId: 'backup' },
  expected: { sourceToken: 'source-token', sessionRevision: 4, aggregate: { content: {}, episodeContents: [], canvases: [] } }, oldAssets: [] } as unknown as NativeProjectUpdateJournal);
beforeEach(() => {
  vi.clearAllMocks();
  probes.capture.mockResolvedValue({ value: { sourceToken: 'source-token' }, changeRevision: 4 });
  probes.inspect.mockResolvedValue([]); probes.points.mockResolvedValue([]);
  probes.project.mockResolvedValue({ snapshot: { stable: true }, payload: {} });
  probes.openBackup.mockResolvedValue({ directory: 'fixture', source: { snapshot: { stable: true }, payload: {} } });
});

it('先读回独立备份、原项目和媒体，再复核目标发布；缺任一证据不继续', async () => {
  const journal = operation();
  await verifyNativeProjectUpdateCommit(journal);
  expect(probes.backup).toHaveBeenCalledWith('project', journal.backup);
  expect(probes.publish).toHaveBeenCalledWith(journal, 'media_v1_operation');
  probes.backup.mockRejectedValueOnce(new Error('备份不可读'));
  await expect(verifyNativeProjectUpdateCommit(journal)).rejects.toThrow('备份不可读');
  expect(probes.publish).toHaveBeenCalledTimes(1);
  probes.capture.mockResolvedValueOnce({ value: { sourceToken: 'changed' }, changeRevision: 4 });
  await expect(verifyNativeProjectUpdateCommit(journal)).rejects.toThrow('项目或历史');
  expect(probes.publish).toHaveBeenCalledTimes(1);
  probes.openBackup.mockResolvedValueOnce({ directory: 'fixture', source: { snapshot: { stable: false }, payload: {} } });
  await expect(verifyNativeProjectUpdateCommit(journal)).rejects.toThrow('独立备份与更新前项目内容不一致');
  expect(probes.publish).toHaveBeenCalledTimes(1);
  probes.publish.mockRejectedValueOnce(new Error('素材不完整'));
  await expect(verifyNativeProjectUpdateCommit(journal)).rejects.toThrow('素材不完整');
});

it('全局素材在核验时使用已冻结的项目副本，不重新复制或读取今日全局版本', async () => {
  const journal = operation();
  journal.expected.aggregate.content = { dramaAssets: { scenes: [{ imageAssetId: 'global-index' }] } } as never;
  const frozen = { ...journal.expected, aggregate: { ...journal.expected.aggregate,
    content: { dramaAssets: { scenes: [{ assetId: 'global-index', relativePath: 'imports/global-fixture/a.png' }] } } } };
  journal.recoveryState = { capture: frozen as never, exchange: {} as never, assets: [], globalFiles: [], referenceFiles: [] };
  await verifyNativeProjectUpdateCommit(journal);
  expect(probes.project).toHaveBeenCalledWith(frozen, []);
  expect(probes.publish).toHaveBeenCalledOnce();
  expect(probes.inspect).toHaveBeenNthCalledWith(1, journal.expected);
  expect(probes.inspect).toHaveBeenNthCalledWith(2, frozen);
});

it('素材字节相同也不能接受标签或图片专属信息不同的备份', async () => {
  probes.project.mockResolvedValueOnce({ snapshot: { stable: true }, payload: { assetMetadata: { version: 1, records: [] } } });
  await expect(verifyNativeProjectUpdateCommit(operation())).rejects.toThrow('独立备份与更新前项目内容不一致');
  expect(probes.publish).not.toHaveBeenCalled();
});

it('恢复项目时还必须读回原恢复点素材', async () => {
  const point = { operationId: 'recovery-1' };
  probes.points.mockResolvedValueOnce([point]);
  const journal = { ...operation(), mode: 'restore-content', restoreRecoveryId: 'recovery-1', restoreAssets: [] } as NativeProjectUpdateJournal;
  await verifyNativeProjectUpdateCommit(journal);
  expect(probes.restore).toHaveBeenCalledWith('project', point, journal.expected, []);
  expect(probes.publish).toHaveBeenCalledOnce();
});
