/** 原操作恢复只读冻结材料；不执行测试，供用户验收。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyProjectImportOperation, ProjectImportCommit } from '../../src/services/indexedDb/projectImportRepository';
import { resumeProjectImportOperation } from '../../src/services/projectImportResumeService';

const mocks = vi.hoisted(() => ({ read: vi.fn(), advance: vi.fn(), commit: vi.fn(), records: vi.fn(), invoke: vi.fn(),
  exists: vi.fn(), ensure: vi.fn(), source: vi.fn(), register: vi.fn(), notify: vi.fn(), remove: vi.fn(), sourceDigests: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: mocks.exists }));
vi.mock('../../src/services/indexedDb/schema', () => ({ openDB: async () => ({}) }));
vi.mock('../../src/services/indexedDb/legacyProjectWriteGuard', () => ({ assertLegacyProjectWritesAllowed: async () => undefined }));
vi.mock('../../src/services/indexedDb/projectImportRepository', () => ({ readProjectImportOperation: mocks.read,
  advanceProjectImportOperation: mocks.advance, commitProjectImport: mocks.commit, readProjectImportScope: mocks.records,
  digestProjectImportSourceRecords: mocks.sourceDigests }));
vi.mock('../../src/services/fileService', () => ({ ensureProjectDataDir: mocks.ensure, getProjectDataDir: mocks.source,
  registerProjectFolder: mocks.register, registerProjectFolders: mocks.register, notifyProjectDiskChanged: mocks.notify,
  deleteProjectDataDir: mocks.remove, joinPath: (...parts: string[]) => parts.join('/') }));

const owner = { id: 'owner', name: '首次作品', dataFolder: 'owner-folder', nodes: [], edges: [], groups: [], createdAt: 1, updatedAt: 1 };
const asset = { path: 'imports/original/file/a.txt', bytes: 4, sha256: 'a'.repeat(64) };
let operation: LegacyProjectImportOperation;
beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  const commit: ProjectImportCommit = { operationId: 'original', expectedRecords: [], records: [owner], expectedState: null,
    state: null, revisions: [], ancestors: [], history: [], label: '首次冻结' };
  const { expectedRecords: _expectedRecords, ...frozenCommit } = commit;
  operation = { id: 'project-import-operation:original', operationId: 'original', ownerId: owner.id,
    stagingProjectId: 'preview', stagingFolder: 'preview-folder', phase: 'media_ready', sequence: 1, createdAt: 1,
    prepared: { version: 1, commit: frozenCommit, sourceRecordDigests: [], commitDigest: 'b'.repeat(64), media: { mode: 'publish', targetFolder: owner.dataFolder,
      assets: [{ path: 'a.txt', destinationPath: 'file/a.txt', bytes: asset.bytes, sha256: asset.sha256 }], required: [asset], verified: true } } };
  mocks.read.mockImplementation(async () => structuredClone(operation));
  mocks.advance.mockImplementation(async (_id: string, phase: LegacyProjectImportOperation['phase']) => { operation.phase = phase; });
  mocks.commit.mockImplementation(async () => { operation.phase = 'db_committed'; });
  mocks.records.mockResolvedValue([{ ...owner, name: '数据库当前正文' }]);
  mocks.ensure.mockResolvedValue('/projects/owner-folder'); mocks.source.mockResolvedValue('/projects/preview-folder');
  mocks.exists.mockResolvedValue(true); mocks.invoke.mockResolvedValue([asset]);
  mocks.sourceDigests.mockResolvedValue([]);
});

describe('旧模型原操作恢复', () => {
  it('只有prepared登记且没有冻结材料时明确拒绝，不重新解包或猜测可重投', async () => {
    delete operation.prepared; operation.phase = 'prepared';
    await expect(resumeProjectImportOperation(operation.operationId)).rejects.toThrow('尚未冻结');
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('media_ready仍核对原字节，文件被改后不提交冻结业务稿', async () => {
    mocks.invoke.mockResolvedValue([{ ...asset, sha256: 'c'.repeat(64) }]);
    await expect(resumeProjectImportOperation(operation.operationId)).rejects.toThrow('摘要变化');
    expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('发布ACK丢失后只校验已有原目录，按第一次ID提交且投影当前DB记录', async () => {
    operation.phase = 'media_publishing';
    const result = await resumeProjectImportOperation(operation.operationId);
    expect(mocks.invoke.mock.calls.every(([command]) => command === 'inspect_project_archive_assets')).toBe(true);
    expect(mocks.commit).toHaveBeenCalledExactlyOnceWith({ ...operation.prepared!.commit, expectedRecords: [], signal: undefined });
    expect(result.records[0].name).toBe('数据库当前正文');
    expect(operation.phase).toBe('finalized'); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('首次原目录不存在时才发布；ACK失败后再次恢复不再发布、不生成新operation', async () => {
    operation.phase = 'media_publishing'; let published = false;
    mocks.exists.mockImplementation(async (path: string) => path.endsWith('/imports/original') ? published : true);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'publish_project_import_assets') { published = true; throw new Error('原发布ACK丢失'); }
      return [asset];
    });
    await expect(resumeProjectImportOperation(operation.operationId)).rejects.toThrow('ACK丢失');
    await resumeProjectImportOperation(operation.operationId);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets')).toHaveLength(1);
    expect(mocks.commit).toHaveBeenCalledOnce(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('原marker已提交时只重读当前数据库，不重放旧next或复制媒体', async () => {
    operation.phase = 'db_committed';
    expect((await resumeProjectImportOperation(operation.operationId)).records[0].name).toBe('数据库当前正文');
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it('同operation并发恢复共用原Promise，锁内重新读取phase，只提交一次', async () => {
    const first = resumeProjectImportOperation(operation.operationId), second = resumeProjectImportOperation(operation.operationId);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.read.mock.calls.length).toBeGreaterThan(1);
    expect(operation.phase).toBe('finalized');
  });
  it('取得编辑器锁前另一调用已完成时，锁内读取finalized而不再推进prepared或发布', async () => {
    let reads = 0;
    mocks.read.mockImplementation(async () => ({ ...structuredClone(operation), phase: ++reads === 1 ? 'prepared' : 'finalized' }));
    await resumeProjectImportOperation(operation.operationId);
    expect(mocks.advance).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  });
});
