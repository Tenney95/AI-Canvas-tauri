/** 仅在内存模拟原生扫描缺失路径的行为；不访问真实项目或系统资料。 */
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectExchangeSnapshotV2 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import { createBoundProjectModelArchiveExportPort } from '../../src/services/projectModelArchiveNativePort';
import type { ProjectArchiveBusinessV4 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange } from '../../src/types/projectModelTransfer';

const native = vi.hoisted(() => ({ invoke: vi.fn(), exists: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: native.exists }));
vi.mock('../../src/services/indexedDb/sharedAssetSyncRepository', () => ({
  loadSharedAssetSyncState: async () => ({ mappings: [], outbox: [] }),
}));

const projectId = 'p2-11111111-1111-4111-8111-111111111111';
const folder = `project-${projectId}`;
const root = 'r2-22222222-2222-4222-8222-222222222222';
const child = 'r2-33333333-3333-4333-8333-333333333333';
const rootPath = 'fixture/primary';
const openExport = () => createBoundProjectModelArchiveExportPort(projectId, 'unused.aicanvas');

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
    identities: [{ kind: 'project', sourceId: 'P', localId: projectId },
      { kind: 'storage-root', sourceId: 'R', localId: root }],
    fileBindings: [{ id: 'F', rootRef: 'R', relativePath: '附件.png', localRelativePath: 'imports/op/附件.png' }], published: [],
    bundle: { format: 'ai-canvas-project-exchange', version: 2, packageId: 'package', lineageId: 'lineage',
      head, revisions: [revision], ancestors: [], files: [{ mediaId: 'media', archivePath: 'assets/附件.png' }] } };
  return { schemaVersion: 1, generation: 1, sessionId: 'session', sessionRevision: 1, sourceToken: 'token', includesHistory: true,
    aggregate: { project: { id: projectId, name: '旧剧集', kind: 'series', createdAt: 1, updatedAt: 1, epoch: 0,
      dataFolder: folder, storageRootRef: root, storageBindings: [
        { rootRef: root, folderName: folder, sourceRecordIds: [], source: 'project-managed' },
      ] }, content: { projectId: projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } },
      episodes: [], episodeContents: [], canvases: [], previews: [], bindings: [] }, exchange, historyBindings: [], history: [] };
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto);
  // Rust selected_asset_file 对缺失文件返回 None，AssetScan::add_file 随后忽略该路径。
  native.invoke.mockImplementation(async (command: string) => command === 'resolve_native_project_media_root' ? rootPath : []);
});

describe('新项目归档保留旧 head 的附件校验', () => {
  it.each([true, false])('素材文件或整个根缺失（根存在：%s）时停止捕获，不把附件当成已删除', async (rootExists) => {
    native.exists.mockResolvedValue(rootExists);
    const capture = await oldHeadCapture(), port = openExport();
    await expect(port.inspectAssets(capture)).rejects.toThrow();
  });
  it('旧附件指向被排除的嵌套素材根时拒绝捕获', async () => {
    native.exists.mockResolvedValue(true);
    const capture = await oldHeadCapture();
    const nested = `roots/${child}/附件.png`;
    capture.exchange!.fileBindings[0].localRelativePath = nested;
    capture.aggregate.project.storageBindings.push({ rootRef: child, folderName: `${folder}/roots/${child}`, sourceRecordIds: [], source: 'project-managed' });
    native.invoke.mockImplementation(async (command: string, args: { assetsDir: string }) => {
      if (command === 'resolve_native_project_media_root') return rootPath;
      if (command === 'resolve_native_project_media_subroot') return `${rootPath}/roots/${child}`;
      return args.assetsDir === rootPath ? [{ path: nested, bytes: 1, sha256: 'a'.repeat(64) }] : [];
    });
    await expect(openExport().inspectAssets(capture)).rejects.toThrow('项目引用的素材缺失');
  });
  it('旧 head 根映射已不属于当前项目时拒绝捕获', async () => {
    native.exists.mockResolvedValue(true);
    const capture = await oldHeadCapture();
    capture.exchange!.identities.find((item) => item.kind === 'storage-root')!.localId = 'missing-root';
    await expect(openExport().inspectAssets(capture)).rejects.toThrow();
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
    await expect(openExport().inspectAssets(capture)).rejects.toThrow();
  });
});
