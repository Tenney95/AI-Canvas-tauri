/** 恢复编排的文件完整性与接收端目录定位边界。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSaveData } from '../../src/services/storageService';
import { captureExchangeSnapshot } from '../../src/services/projectExchangeDomain';
import { createProjectExchangeRevision } from '../../src/services/projectExchangeFormat';
import type { ProjectExchangeState } from '../../src/types/projectExchange';
import { createEmptyStoryGraph } from '../../src/services/storyGraphService';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), read: vi.fn(), recoveries: vi.fn(), commit: vi.fn(), notify: vi.fn(), state: vi.fn(), graph: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (value: string) => value }));
vi.mock('../../src/services/fileService', () => ({ ensureProjectDataDir: async () => '/projects/renamed', notifyProjectDiskChanged: mocks.notify }));
vi.mock('../../src/services/projectTransferService', () => ({}));
vi.mock('../../src/services/indexedDb/projectExchangeRepository', () => ({ loadProjectExchangeState: mocks.state, loadProjectExchangeGraph: mocks.graph }));
vi.mock('../../src/services/indexedDb/projectImportRepository', () => ({
  readProjectImportScope: mocks.read, listProjectImportRecoveries: mocks.recoveries, commitProjectImport: mocks.commit,
}));
vi.mock('../../src/services/projectMergeWorkerClient', () => ({ captureProjectSnapshot: (...args: Parameters<typeof captureExchangeSnapshot>) => captureExchangeSnapshot(...args) }));
import { restoreProjectImportRecovery } from '../../src/services/projectImportService';

const owner: ProjectSaveData = { id: 'root', name: '已改名', dataFolder: 'renamed', nodes: [], edges: [], groups: [], createdAt: 1, updatedAt: 2 };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto);
  mocks.read.mockResolvedValue([owner]);
  mocks.invoke.mockResolvedValue([]);
  mocks.commit.mockResolvedValue(undefined);
  mocks.state.mockResolvedValue(null); mocks.graph.mockResolvedValue({ revisions: [], ancestors: [] });
});
afterEach(() => vi.unstubAllGlobals());
describe('导入恢复点编排', () => {
  it('恢复故事图内容时提升当前本机令牌，不回退到恢复点 revision', async () => {
    const graph = { ...createEmptyStoryGraph('graph'), revision: 3 };
    mocks.read.mockResolvedValue([{ ...owner, series: { script: '当前原文', storyGraph: { ...graph, revision: 12 } } }]);
    mocks.recoveries.mockResolvedValue([{ id: 'graph-recovery', records: [{ ...owner,
      series: { script: '旧原文', storyGraph: graph } }], assets: [], state: null }]);
    await restoreProjectImportRecovery(owner.id, 'graph-recovery');
    expect(mocks.commit.mock.calls[0][0].records[0].series).toMatchObject({ script: '旧原文', storyGraph: { id: graph.id, revision: 13 } });
    const snapshot = mocks.commit.mock.calls[0][0].revisions[0].snapshot;
    expect(snapshot.entities.find((entry: { kind: string }) => entry.kind === 'project').data.series.storyGraph).not.toHaveProperty('revision');
  });
  it('项目改名后恢复内容仍保留当前目录，分集与 owner 使用同一素材根', async () => {
    mocks.recoveries.mockResolvedValue([{ id: 'recovery', records: [
      { ...owner, name: '旧名称', dataFolder: 'old-folder' },
      { ...owner, id: 'episode', parentId: 'root', dataFolder: 'old-folder' },
    ], assets: [], state: null }]);
    await restoreProjectImportRecovery('root', 'recovery');
    const input = mocks.commit.mock.calls[0][0];
    expect(input.records).toMatchObject([{ id: 'root', name: '旧名称', dataFolder: 'renamed' }, { id: 'episode', dataFolder: 'renamed' }]);
    expect(input.state).toMatchObject({ ownerId: 'root', stateVersion: 1 });
    expect(input.revisions[0].parentRevisionIds).toEqual([]);
    expect(input.revisions[0].snapshot.media).toEqual([]);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'inspect_project_archive_assets', { assetsDir: '/projects/renamed', selectedPaths: [] });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'inspect_project_archive_assets', { assetsDir: '/projects/renamed', includeImportPaths: [] });
  });
  it('无协作状态的旧恢复点缺少素材校验但持有文件映射时仍拒绝', async () => {
    mocks.recoveries.mockResolvedValue([{ id: 'recovery', records: [owner], state: null,
      identities: [{ kind: 'file', scopeId: 'root', id: 'file', localId: 'imports/old/原稿.txt' }] }]);
    await expect(restoreProjectImportRecovery(owner.id, 'recovery')).rejects.toThrow('旧恢复点缺少素材校验信息');
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  });
  it.each([{ assets: [] }, { assets: [{ path: 'imports/recovery/a.png', bytes: 10, sha256: 'b'.repeat(64) }] }])('恢复点文件缺失或被替换时不发布文件、不提交数据库', async ({ assets }) => {
    mocks.recoveries.mockResolvedValue([{ id: 'recovery', records: [owner], state: null,
      assets: [{ path: 'imports/recovery/a.png', bytes: 10, sha256: 'a'.repeat(64) }] }]);
    mocks.invoke.mockResolvedValue(assets);
    await expect(restoreProjectImportRecovery('root', 'recovery')).rejects.toThrow('恢复点素材缺失或已被修改');
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['inspect_project_archive_assets']);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('恢复只捕获冻结清单，不从身份墓碑复活磁盘上保留的已删除素材', async () => {
    const active = { path: 'imports/active/current.png', bytes: 10, sha256: 'a'.repeat(64) };
    const deleted = { path: '已删除.png', bytes: 20, sha256: 'b'.repeat(64) };
    const frozen = { ...active, path: 'imports/recovery/current.png' };
    const current: ProjectSaveData = { ...owner, nodes: [{ id: 'image', type: 'source-image', data: { relativePath: active.path } }] };
    const captured = captureExchangeSnapshot([current], [active, deleted], null);
    const removedId = [...captured.files].find(([, path]) => path === deleted.path)![0];
    const snapshot = { ...captured.snapshot, entities: captured.snapshot.entities.filter((entity) => entity.id !== removedId),
      media: captured.snapshot.media.filter((descriptor) => descriptor.sha256 !== deleted.sha256) };
    const revision = await createProjectExchangeRevision(snapshot);
    const state: ProjectExchangeState = { ownerId: owner.id, rootProjectId: owner.id, lineageId: snapshot.lineageId,
      headRevisionId: revision.revisionId, stateVersion: 2, identities: captured.identities };
    const recoveryIdentities = captured.identities.map((identity) => identity.kind === 'file' && identity.localId === active.path
      ? { ...identity, localId: frozen.path } : identity);
    const restored = { ...current, nodes: [{ id: 'image', type: 'source-image', data: { relativePath: frozen.path } }] };
    mocks.read.mockResolvedValue([current]); mocks.state.mockResolvedValue(state);
    mocks.graph.mockResolvedValue({ revisions: [revision], ancestors: [] });
    mocks.recoveries.mockResolvedValue([{ id: 'recovery', records: [restored], state, identities: recoveryIdentities, assets: [frozen] }]);
    mocks.invoke.mockImplementation(async (command: string, input: { selectedPaths?: string[] }) => {
      if (command === 'inspect_project_archive_assets') return input.selectedPaths ? [frozen, deleted] : [active, deleted];
      return undefined;
    });
    await restoreProjectImportRecovery(owner.id, 'recovery');
    const input = mocks.commit.mock.calls[0][0];
    const restoredHead = input.revisions.find((item: { revisionId: string }) => item.revisionId === input.state.headRevisionId);
    expect(restoredHead.snapshot.entities.some((entity: { id: string }) => entity.id === removedId)).toBe(false);
    expect(restoredHead.snapshot.media).toHaveLength(1);
    expect(input.state.identities).toContainEqual(expect.objectContaining({ kind: 'file', id: removedId, localId: deleted.path }));
    expect(input.recoveryAssets).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'inspect_project_archive_assets', { assetsDir: '/projects/renamed', selectedPaths: [frozen.path] });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'inspect_project_archive_assets', { assetsDir: '/projects/renamed', includeImportPaths: [active.path] });
  });

  it('缺少当前完整快照时不扫描素材或提交恢复', async () => {
    mocks.recoveries.mockResolvedValue([{ id: 'recovery', records: [owner], assets: [], state: null }]);
    mocks.state.mockResolvedValue({ ownerId: owner.id, rootProjectId: owner.id, lineageId: 'lineage',
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: [] });
    await expect(restoreProjectImportRecovery(owner.id, 'recovery')).rejects.toThrow('缺少完整快照');
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  });
});
