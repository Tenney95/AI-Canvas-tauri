/** 仅在内存模拟原生扫描缺失路径的行为；不访问真实项目或系统资料。 */
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectExchangeSnapshotV2 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import { createNativeProjectModelArchivePort } from '../../src/services/projectModelArchiveNativePort';
import type { ProjectArchiveBusinessV4 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange } from '../../src/types/projectModelTransfer';
import type { ProjectModelFixtureBusinessSession } from '../../src/types/projectModelBusiness';

const native = vi.hoisted(() => ({ invoke: vi.fn(), exists: vi.fn(), createBackup: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: native.exists }));
vi.mock('../../src/services/fileService', () => ({ projectArchiveFixtureDirectory: async (_db: string, relative: string) => `fixture/${relative}` }));
vi.mock('../../src/services/fs/projectArchiveFixtureFiles', () => ({ createProjectArchiveFixturePreviewDirectory: vi.fn() }));
vi.mock('../../src/services/projectModelPreRestoreBackup', () => ({
  createProjectModelPreRestoreBackupService: () => ({ create: native.createBackup, verify: vi.fn(), verifyCommit: vi.fn() }),
}));

const database = { name: 'ai-canvas-model-fixture-missing-asset' } as IDBDatabase;
const session = { operationId: 'migration', generation: 1, sessionId: 'session' } as ProjectModelFixtureBusinessSession;
async function oldHeadCapture(): Promise<ProjectModelTransferCapture> {
  const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '旧剧集', kind: 'series',
    storageRoots: [{ id: 'R', role: 'shared' }] }, episodes: [], canvases: [],
  contents: { project: { projectId: 'P', data: {} }, episodes: [] } };
  const file = { id: 'F', rootRef: 'R', relativePath: '附件.png', mediaId: 'media' };
  const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [
    { id: 'media', kind: 'image', extension: 'png', bytes: 1, sha256: 'a'.repeat(64) },
  ], [file]);
  const revision = await createProjectExchangeRevisionV2(snapshot);
  const head = { canonicalVersion: 2 as const, revisionId: revision.revisionId };
  const exchange: ProjectModelTransferExchange = { lineageId: 'lineage', localHead: head, stateVersion: 1,
    identities: [{ kind: 'project', sourceId: 'P', localId: 'local-project' },
      { kind: 'storage-root', sourceId: 'R', localId: 'local-root' }],
    fileBindings: [{ id: 'F', rootRef: 'R', relativePath: '附件.png', localRelativePath: 'imports/op/附件.png' }], published: [],
    bundle: { format: 'ai-canvas-project-exchange', version: 2, packageId: 'package', lineageId: 'lineage',
      head, revisions: [revision], ancestors: [], files: [{ mediaId: 'media', archivePath: 'assets/附件.png' }] } };
  return { schemaVersion: 1, generation: 1, sessionId: 'session', sessionRevision: 1, sourceToken: 'token', includesHistory: true,
    aggregate: { project: { id: 'local-project', name: '旧剧集', kind: 'series', createdAt: 1, updatedAt: 1, epoch: 0,
      dataFolder: 'primary', storageRootRef: 'local-root', storageBindings: [
        { rootRef: 'local-root', folderName: 'primary', sourceRecordIds: [], source: 'project-managed' },
      ] }, content: { projectId: 'local-project', revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } },
      episodes: [], episodeContents: [], canvases: [], previews: [], bindings: [] }, exchange, historyBindings: [], history: [] };
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto);
  // Rust selected_asset_file 对缺失文件返回 None，AssetScan::add_file 随后忽略该路径。
  native.invoke.mockResolvedValue([]); native.createBackup.mockResolvedValue({});
});

describe('旧 head 附件丢失时拒绝归档与恢复前备份', () => {
  it.each([true, false])('素材文件或整个根缺失（根存在：%s）时停止捕获，不把附件当成已删除', async (rootExists) => {
    native.exists.mockResolvedValue(rootExists);
    const capture = await oldHeadCapture(), port = createNativeProjectModelArchivePort(database, session);
    await expect(port.inspectAssets(capture)).rejects.toThrow();
  });
  it('缺失未被正文引用的旧附件时不创建恢复前备份', async () => {
    native.exists.mockResolvedValue(true);
    const capture = await oldHeadCapture(), port = createNativeProjectModelArchivePort(database, session);
    await expect(port.createRestoreBackup!(capture, [])).rejects.toThrow();
    expect(native.createBackup).not.toHaveBeenCalled();
  });
  it('旧附件指向被排除的嵌套素材根时拒绝捕获', async () => {
    native.exists.mockResolvedValue(true);
    const capture = await oldHeadCapture();
    capture.exchange!.fileBindings[0].localRelativePath = 'roots/child/附件.png';
    capture.aggregate.project.storageBindings.push({ rootRef: 'child', folderName: 'primary/roots/child', sourceRecordIds: [], source: 'project-managed' });
    native.invoke.mockImplementation(async (_command: string, args: { assetsDir: string }) => args.assetsDir === 'fixture/primary'
      ? [{ path: 'roots/child/附件.png', bytes: 1, sha256: 'a'.repeat(64) }] : []);
    await expect(createNativeProjectModelArchivePort(database, session).inspectAssets(capture)).rejects.toThrow();
  });
  it('旧 head 根映射已不属于当前项目时拒绝捕获', async () => {
    native.exists.mockResolvedValue(true);
    const capture = await oldHeadCapture();
    capture.exchange!.identities.find((item) => item.kind === 'storage-root')!.localId = 'missing-root';
    await expect(createNativeProjectModelArchivePort(database, session).inspectAssets(capture)).rejects.toThrow();
  });
  it('旧 head 的非主素材根丢失绑定时同样拒绝捕获', async () => {
    native.exists.mockResolvedValue(true);
    const capture = await oldHeadCapture(), exchange = capture.exchange!;
    const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '旧剧集', kind: 'series', storageRoots: [
      { id: 'R', role: 'shared' }, { id: 'S', role: 'canvas' },
    ] }, episodes: [], canvases: [], contents: { project: { projectId: 'P', data: {} }, episodes: [] } };
    const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [
      { id: 'media', kind: 'image', extension: 'png', bytes: 1, sha256: 'a'.repeat(64) },
    ], [{ id: 'F', rootRef: 'S', relativePath: '附件.png', mediaId: 'media' }]);
    const revision = await createProjectExchangeRevisionV2(snapshot);
    const head = { canonicalVersion: 2 as const, revisionId: revision.revisionId };
    exchange.localHead = head; exchange.bundle.head = head; exchange.bundle.revisions = [revision];
    exchange.identities.push({ kind: 'storage-root', sourceId: 'S', localId: 'missing-root' });
    exchange.fileBindings[0].rootRef = 'S';
    await expect(createNativeProjectModelArchivePort(database, session).inspectAssets(capture)).rejects.toThrow();
  });
});
