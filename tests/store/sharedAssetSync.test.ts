/**
 * sharedAssetSync — 回归测试：手动项目资产同步协调边界。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { SharedAssetConflict, SharedAssetMapping, SharedAssetOutboxEntry, SharedAssetSyncLocalState, SharedProjectBinding } from '../../src/types/assetSync';
import type { SharedAssetSyncContext, SharedAssetSyncSession } from '../../src/services/fs/sharedAssetSync';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(), execute: vi.fn(), deleteAsset: vi.fn(), cancel: vi.fn(async () => undefined),
  load: vi.fn(), listen: vi.fn<(name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>>(),
  notify: vi.fn(), commit: vi.fn(async () => ({ alreadyApplied: false })),
  invoke: vi.fn(),
  previewReset: vi.fn(), applyReset: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/fs/sharedAssetSync', () => ({ projectAssetSyncService: {
  preview: mocks.preview, apply: mocks.execute, deleteAsset: mocks.deleteAsset, readState: mocks.load,
} }));
vi.mock('../../src/services/fs/sharedAssetStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/sharedAssetStorage')>(),
  cancelSharedStorageTask: mocks.cancel, sharedStorageErrorMessage: (code: string) => code,
  previewSharedProjectReset: mocks.previewReset, applySharedProjectReset: mocks.applyReset,
  bindSharedStorageProject: vi.fn(), probeSharedStorageProject: vi.fn(), loadSharedStorageSnapshot: vi.fn(),
  removeSharedStorageConnection: vi.fn(), saveSharedStorageConnection: vi.fn(), unbindSharedStorageProject: vi.fn(),
}));
vi.mock('../../src/services/configPersistenceQueue', () => ({
  areSettingsMutationsFrozen: () => false, enqueueConfigPersistence: (run: () => Promise<void>) => run(),
}));
vi.mock('../../src/services/fs/core', () => ({ notifyProjectDiskChanged: mocks.notify, isTauriEnv: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
import { createAssetSyncSlice } from '../../src/store/store.assetSync';

const binding: SharedProjectBinding = {
  ownerId: 'series', ownerName: '测试剧集', connectionId: 'connection', connectionRevision: 'connection-v1',
  libraryId: 'library', sharedProjectId: 'shared-project', projectPrefix: 'team/libraries/library/projects/shared-project',
  capabilities: { checks: [], multiplayerWritable: true, cleanupPending: false, checkedAt: 1 }, updatedAt: 1,
};
function session(context: SharedAssetSyncContext, completed = 0, total = 1): SharedAssetSyncSession {
  const items = [{ id: 'asset', name: '角色', kind: 'character' as const, direction: 'upload' as const }];
  context.onStatus({ stage: 'preview', items, completed, total });
  return { context, expectedLibrary: context.library, rootDirectory: 'runtime-only', mappings: [],
    operations: [{ operation: {} }], items, completed, total, executing: false, savedMappings: new Map() } as unknown as SharedAssetSyncSession;
}
const syncIdentity = { ownerId: binding.ownerId, connectionId: binding.connectionId, connectionRevision: binding.connectionRevision,
  libraryId: binding.libraryId, sharedProjectId: binding.sharedProjectId, generation: 'legacy' };
function savedMapping(assetId: string, acceptedRevisionId = `${assetId}-v1`, patch: Partial<SharedAssetMapping> = {}): SharedAssetMapping {
  return { ...syncIdentity, id: `${assetId}-mapping`, sharedAssetId: assetId, kind: 'file', localEntityId: `${assetId}-local`,
    members: [], media: [], acceptedRevisionId, acceptedETag: `${acceptedRevisionId}-etag`, baselineDigest: 'a'.repeat(64), updatedAt: 1, ...patch };
}
function savedOperation(assetId: string, revisionId = `${assetId}-v1`, patch: Partial<SharedAssetOutboxEntry> = {}): SharedAssetOutboxEntry {
  const operationId = `${assetId}-${revisionId}-operation`;
  return { ...syncIdentity, id: operationId, operationId, mappingId: `${assetId}-mapping`, sharedAssetId: assetId, kind: 'file',
    direction: 'upload', revisionId, phase: 'completed', createdAt: 1, updatedAt: 10,
    revision: { format: 'ai-canvas-shared-asset', version: 1, libraryId: binding.libraryId, sharedProjectId: binding.sharedProjectId,
      sharedAssetId: assetId, revisionId, operationId, createdAt: 1,
      payload: { kind: 'file', name: `${assetId}.png`, displayRelativePath: `${assetId}.png`, mediaId: 'image', tags: [] },
      media: [{ id: 'image', kind: 'image', extension: 'png', sha256: 'b'.repeat(64), bytes: 10 }] }, ...patch };
}
function savedConflict(assetId: string, baseRevisionId: string, patch: Partial<SharedAssetConflict> = {}): SharedAssetConflict {
  return { ...syncIdentity, id: `${assetId}-conflict`, sharedAssetId: assetId, kind: 'file',
    baseRevisionId, remoteRevisionId: `${assetId}-remote`, reason: 'bothChanged', createdAt: 20, ...patch };
}
function arrange() {
  return createStore<AppState>()((...args) => ({
    ...createAssetSyncSlice(...args), currentProjectId: 'episode', projectInitialized: true, projectLoadStatus: 'ready',
    projects: [{ id: 'series', dataFolder: 'series' }, { id: 'episode', parentId: 'series', dataFolder: 'series' }, { id: 'other' }],
    config: { baseDataDir: 'runtime-root' }, nodes: [], dramaAssets: { version: 2, characters: [], scenes: [], props: [] },
    sharedAssetStorage: { revision: 1, bindings: [binding], connections: [{ id: 'connection', name: '测试存储',
      endpoint: 'https://s3.example.com', bucket: 'assets', region: 'us-east-1', rootPrefix: 'team', pathStyle: true,
      revision: 'connection-v1', credentialsSaved: true, sessionTokenSaved: false }] }, commitSharedAssetSyncDownload: mocks.commit,
  } as unknown as AppState));
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.previewReset.mockImplementation(async (input: { mode: string }) => ({ mode: input.mode, objectCount: 3, bytes: 10, previewToken: 'preview-token' }));
  mocks.applyReset.mockResolvedValue({ status: 'completed', deletedCount: 3, totalCount: 3 });
  mocks.load.mockResolvedValue({ mappings: [], outbox: [], conflicts: [] });
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.preview.mockImplementation(async (context: SharedAssetSyncContext) => session(context));
  mocks.commit.mockResolvedValue({ alreadyApplied: false });
  mocks.deleteAsset.mockResolvedValue(undefined);
  mocks.execute.mockImplementation(async (value: SharedAssetSyncSession) => value.context.onStatus({ stage: 'completed' }));
});

describe('手动项目资产同步协调边界', () => {
  it('无效单项ID或仅给方向均拒绝执行，不能退化为整批同步', async () => {
    const store = arrange(); await store.getState().previewSharedProjectSync('series');
    await expect(store.getState().syncSharedProjectNow('series', '', 'upload')).rejects.toThrow('有效的单项资产');
    await expect(store.getState().syncSharedProjectNow('series', undefined, 'download')).rejects.toThrow('有效的单项资产');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('preview');
  });

  it('单条动作传递原row及方向，完成后销毁旧会话并重新预览剩余项目', async () => {
    const store = arrange(); let original!: SharedAssetSyncSession;
    mocks.preview.mockImplementationOnce(async (context: SharedAssetSyncContext) => {
      original = session(context, 0, 2); return original;
    }).mockImplementationOnce(async (context: SharedAssetSyncContext) => {
      const next = session(context, 1, 2);
      next.items = [{ id: 'remaining', name: '声音', kind: 'file', direction: 'download' }];
      context.onStatus({ stage: 'preview', items: next.items, completed: 1, total: 2 }); return next;
    });
    await store.getState().previewSharedProjectSync('series');
    await store.getState().syncSharedProjectNow('series', 'asset', 'upload');
    expect(mocks.execute).toHaveBeenCalledWith(original, expect.any(Object), { itemId: 'asset', direction: 'upload' });
    expect(original.context.signal?.aborted).toBe(true); expect(() => original.context.assertCurrent()).toThrow();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'preview', completed: 1, total: 2,
      items: [{ id: 'remaining', direction: 'download' }] });
  });

  it('无变更且可删的行保留本轮会话，云端删除完成重新预览且本机库不变', async () => {
    const store = arrange(); const library = store.getState().dramaAssets;
    mocks.preview.mockImplementationOnce(async (context: SharedAssetSyncContext) => {
      const value = session(context, 1, 1); value.operations = [];
      value.items = [{ id: 'unchanged', name: '角色', kind: 'character', direction: 'unchanged', canDelete: true }];
      context.onStatus({ stage: 'completed', items: value.items, completed: 1, total: 1 }); return value;
    });
    await store.getState().previewSharedProjectSync('series');
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('preview');
    await store.getState().deleteSharedProjectAsset('series', 'unchanged');
    expect(mocks.deleteAsset).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ id: 'unchanged' })] }), 'unchanged');
    expect(mocks.preview).toHaveBeenCalledTimes(2); expect(mocks.execute).not.toHaveBeenCalled();
    expect(store.getState().dramaAssets).toBe(library); expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('旧删除结果在取消并建立新预览后到达，不覆盖新状态也不额外重扫', async () => {
    const store = arrange(); let finish!: () => void;
    mocks.deleteAsset.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await store.getState().previewSharedProjectSync('series');
    const deleting = store.getState().deleteSharedProjectAsset('series', 'asset').catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.deleteAsset).toHaveBeenCalledOnce());
    await store.getState().cancelSharedProjectSync('series');
    await store.getState().previewSharedProjectSync('series');
    const current = store.getState().sharedAssetSyncStatus.series;
    finish(); await deleting;
    expect(store.getState().sharedAssetSyncStatus.series).toBe(current);
    expect(mocks.preview).toHaveBeenCalledTimes(2); expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('删除CAS冲突保留本机库并提示重新预览，不把列表标为完成', async () => {
    const store = arrange(); const library = store.getState().dramaAssets;
    mocks.deleteAsset.mockRejectedValueOnce(new Error('云端资产已有其他修改，未删除，请重新预览'));
    await store.getState().previewSharedProjectSync('series');
    await expect(store.getState().deleteSharedProjectAsset('series', 'asset')).rejects.toThrow('重新预览');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'failed', error: expect.stringContaining('未删除') });
    expect(store.getState().dramaAssets).toBe(library); expect(mocks.commit).not.toHaveBeenCalled();
    await expect(store.getState().deleteSharedProjectAsset('series', 'asset')).rejects.toThrow('请先重新预览');
  });

  it('重新载入删除冲突仍明确显示本机保留，不认作旧上传已完成', async () => {
    const store = arrange();
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image', 'accepted-v1')],
      outbox: [savedOperation('image', 'accepted-v1', { errorCode: 'remote_deleted' })],
      conflicts: [savedConflict('image', 'accepted-v1', { reason: 'remoteDeleted' })] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'paused', completed: 0, total: 0,
      items: [{ direction: 'conflict', message: expect.stringContaining('云端资产已删除，本机内容已保留') }] });
  });

  it('应用预览后在执行器等待期间立即保留四比五，执行完成再显示五比五', async () => {
    const store = arrange();
    let finish!: () => void;
    mocks.preview.mockImplementationOnce(async (context: SharedAssetSyncContext) => session(context, 4, 5));
    mocks.execute.mockImplementationOnce(async (value: SharedAssetSyncSession) => {
      expect(value).toMatchObject({ completed: 4, total: 5 });
      await new Promise<void>((resolve) => { finish = resolve; });
      value.completed = 5;
      value.context.onStatus({ stage: 'completed', completed: 5, total: value.total });
    });
    await store.getState().previewSharedProjectSync('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'preview', completed: 4, total: 5 });
    const applying = store.getState().syncSharedProjectNow('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'syncing', completed: 4, total: 5 });
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'syncing', completed: 4, total: 5 });
    finish(); await applying;
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'completed', completed: 5, total: 5 });
  });

  it('当前已接受版本之后的冲突覆盖旧完成展示，冲突不计入可执行总数', async () => {
    const store = arrange();
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image', 'accepted-v1')], outbox: [
      savedOperation('image', 'accepted-v1'),
      savedOperation('image', 'candidate-v2', { phase: 'conflict', baseRevisionId: 'accepted-v1', errorCode: 'conflict', updatedAt: 20 }),
    ], conflicts: [] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'paused', completed: 0, total: 0 });
    expect(store.getState().sharedAssetSyncStatus.series.items).toEqual([
      expect.objectContaining({ kind: 'file', direction: 'conflict' }),
    ]);
  });

  it('仅有当前基线的冲突表记录而无outbox时仍显示待处理冲突', async () => {
    const store = arrange();
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image', 'accepted-v1')], outbox: [],
      conflicts: [savedConflict('image', 'accepted-v1')] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'paused', completed: 0, total: 0 });
    expect(store.getState().sharedAssetSyncStatus.series.items).toEqual([
      expect.objectContaining({ kind: 'file', direction: 'conflict' }),
    ]);
  });

  it('已经接受新版本时旧基线的冲突待办与冲突表都不阻碍完成展示', async () => {
    const store = arrange();
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image', 'accepted-v3')], outbox: [
      savedOperation('image', 'accepted-v1'),
      savedOperation('image', 'candidate-v2', { phase: 'conflict', baseRevisionId: 'accepted-v1', errorCode: 'conflict', updatedAt: 20 }),
      savedOperation('image', 'accepted-v3', { updatedAt: 30 }),
    ], conflicts: [savedConflict('image', 'accepted-v1')] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({
      stage: 'completed', completed: 1, total: 1, lastSyncedAt: 30, items: [],
    });
  });

  it('同一资产的原待恢复操作优先于旧冲突表记录，不被过时冲突阻止恢复', async () => {
    const store = arrange();
    const pending = savedOperation('image', 'candidate-v2', { phase: 'paused', baseRevisionId: 'accepted-v1', updatedAt: 15 });
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image', 'accepted-v1')],
      outbox: [savedOperation('image', 'accepted-v1'), pending], conflicts: [savedConflict('image', 'accepted-v1')] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'paused', completed: 0, total: 1 });
    expect(store.getState().sharedAssetSyncStatus.series.items).toEqual([
      expect.objectContaining({ id: pending.operationId, name: 'image.png', kind: 'file', direction: 'upload' }),
    ]);
  });

  it('重启恢复已完成四项和待上传一项，显示四比五并只列出待恢复操作', async () => {
    const store = arrange();
    const assets = ['image-1', 'image-2', 'image-3', 'image-4', 'image-5'];
    mocks.load.mockResolvedValue({ mappings: assets.map((id) => savedMapping(id)),
      outbox: assets.map((id, index) => savedOperation(id, undefined, { phase: index === 4 ? 'paused' : 'completed', updatedAt: (index + 1) * 10 })),
      conflicts: [] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'paused', completed: 4, total: 5, lastSyncedAt: 40 });
    expect(store.getState().sharedAssetSyncStatus.series.items).toEqual([
      expect.objectContaining({ name: 'image-5.png', kind: 'file', direction: 'upload', message: expect.stringContaining('恢复上次固定') }),
    ]);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('同一资产历史版本只计一次，新预览丢弃的候选不遮蔽已接受版本', async () => {
    const store = arrange();
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image', 'accepted-v2')], outbox: [
      savedOperation('image', 'old-v1', { updatedAt: 10 }),
      savedOperation('image', 'accepted-v2', { updatedAt: 20 }),
      savedOperation('image', 'discarded-preview-v3', { updatedAt: 500 }),
    ], conflicts: [] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'completed', completed: 1, total: 1, lastSyncedAt: 20, items: [] });
  });

  it.each(['applied', 'completed'] as const)('本地已应用但尚未确认回执的%s条目仍覆盖旧完成记录', async (phase) => {
    const store = arrange();
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image', 'new-v2')], outbox: [
      savedOperation('image', 'old-v1'),
      savedOperation('image', 'new-v2', { phase, errorCode: 'ack_pending', updatedAt: 50 }),
    ], conflicts: [] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'paused', completed: 0, total: 1 });
    expect(store.getState().sharedAssetSyncStatus.series.lastSyncedAt).toBeUndefined();
    expect(store.getState().sharedAssetSyncStatus.series.items).toHaveLength(1);
  });

  it('同一资产多笔待办只计一项，不能与旧完成记录重复累计', async () => {
    const store = arrange();
    const latest = savedOperation('image', 'latest-v3', { phase: 'planned', updatedAt: 30 });
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image')], outbox: [
      savedOperation('image'), savedOperation('image', 'pending-v2', { phase: 'paused', updatedAt: 20 }),
      { ...latest, revision: undefined, draft: { ...latest.revision!,
        media: latest.revision!.media.map(({ id, kind, extension }) => ({ id, kind, extension })) } },
    ], conflicts: [] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'paused', completed: 0, total: 1 });
    expect(store.getState().sharedAssetSyncStatus.series.items).toHaveLength(1);
    expect(store.getState().sharedAssetSyncStatus.series.items[0].name).toBe('image.png');
  });

  it.each([
    ['ownerId', 'other-owner'], ['connectionId', 'other-connection'], ['connectionRevision', 'other-revision'],
    ['libraryId', 'other-library'], ['sharedProjectId', 'other-project'], ['generation', 'other-generation'],
  ] as const)('恢复计数排除%s不同的历史映射和待办', async (key, value) => {
    const store = arrange();
    const outsideScope: Partial<SharedAssetMapping & SharedAssetOutboxEntry> = { [key]: value };
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image'), savedMapping('outside', undefined, outsideScope)], outbox: [
      savedOperation('image'), savedOperation('image', 'other-pending', { ...outsideScope, phase: 'paused' }),
      savedOperation('outside', undefined, outsideScope),
    ], conflicts: [] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'completed', completed: 1, total: 1, items: [] });
  });

  it('当前绑定切换代次后只读取同代次记录，旧legacy待办不覆盖新代次完成数', async () => {
    const store = arrange();
    store.setState({ sharedAssetStorage: { ...store.getState().sharedAssetStorage!, bindings: [{ ...binding, generation: 'current-generation' }] } });
    mocks.load.mockResolvedValue({ mappings: [savedMapping('old-image'), savedMapping('image', undefined, { generation: 'current-generation' })],
      outbox: [savedOperation('old-image', undefined, { phase: 'paused' }),
        savedOperation('image', undefined, { generation: 'current-generation', updatedAt: 30 })], conflicts: [] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'completed', completed: 1, total: 1, lastSyncedAt: 30, items: [] });
  });

  it.each([
    { mappingId: 'different-mapping' }, { sharedAssetId: 'different-asset' }, { kind: 'prop' as const }, { revisionId: 'different-revision' },
  ])('没有严格匹配已接受映射的完成证据时不计入完成数：%o', async (patch) => {
    const store = arrange();
    mocks.load.mockResolvedValue({ mappings: [savedMapping('image')], outbox: [savedOperation('image', undefined, patch)], conflicts: [] });
    await store.getState().loadSharedProjectSyncState('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'idle', completed: 0, total: 0, items: [] });
    expect(store.getState().sharedAssetSyncStatus.series.lastSyncedAt).toBeUndefined();
  });

  it('扫描保留已恢复四比五基线，迟到的磁盘读取不能覆盖活动运行实例', async () => {
    const store = arrange();
    store.setState({ sharedAssetSyncStatus: { series: { ownerId: 'series', stage: 'paused', items: [], completed: 4, total: 5 } } });
    let finishLoad!: (value: SharedAssetSyncLocalState) => void;
    let finishPreview!: (value: SharedAssetSyncSession) => void;
    let captured!: SharedAssetSyncContext;
    mocks.load.mockImplementationOnce(() => new Promise<SharedAssetSyncLocalState>((resolve) => { finishLoad = resolve; }));
    const loading = store.getState().loadSharedProjectSyncState('series');
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    mocks.preview.mockImplementationOnce((context: SharedAssetSyncContext) => {
      captured = context;
      return new Promise<SharedAssetSyncSession>((resolve) => { finishPreview = resolve; });
    });
    const scanning = store.getState().previewSharedProjectSync('series');
    await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'scanning', completed: 4, total: 5 });
    finishLoad({ mappings: [], outbox: [], conflicts: [] }); await loading;
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'scanning', completed: 4, total: 5 });
    finishPreview(session(captured)); await scanning;
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('preview');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('读盘期间新同步已完成并释放运行实例后，迟到的旧快照仍不能覆盖完成结果', async () => {
    const store = arrange();
    let finishLoad!: (value: SharedAssetSyncLocalState) => void;
    mocks.load.mockImplementationOnce(() => new Promise<SharedAssetSyncLocalState>((resolve) => { finishLoad = resolve; }));
    const loading = store.getState().loadSharedProjectSyncState('series');
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    mocks.execute.mockImplementationOnce(async (value: SharedAssetSyncSession) => {
      value.completed = 1;
      value.context.onStatus({ stage: 'completed', completed: 1, total: 1, lastSyncedAt: 70 });
    });
    await store.getState().previewSharedProjectSync('series');
    await store.getState().syncSharedProjectNow('series');
    const completed = store.getState().sharedAssetSyncStatus.series;
    expect(completed).toMatchObject({ stage: 'completed', completed: 1, total: 1, lastSyncedAt: 70 });
    await store.getState().cancelSharedProjectSync('series');
    expect(store.getState().sharedAssetSyncStatus.series).toBe(completed);
    finishLoad({ mappings: [], outbox: [], conflicts: [] }); await loading;
    expect(store.getState().sharedAssetSyncStatus.series).toBe(completed);
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'completed', completed: 1, total: 1 });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('清理仅在用户确认预览后执行，保留本机项目和绑定', async () => {
    const store = arrange();
    const originalLibrary = store.getState().dramaAssets;
    const preview = await store.getState().previewSharedProjectReset('series', 'clear');
    expect(preview).toMatchObject({ objectCount: 3, bytes: 10 });
    expect(mocks.applyReset).not.toHaveBeenCalled();
    const result = await store.getState().applySharedProjectReset('series', 'clear', preview.previewToken);
    expect(result).toEqual({ status: 'completed', deletedCount: 3, totalCount: 3 });
    expect(mocks.applyReset).toHaveBeenCalledWith(expect.objectContaining({ mode: 'clear', previewToken: 'preview-token' }));
    expect(store.getState().dramaAssets).toBe(originalLibrary);
    expect(store.getState().sharedAssetStorage?.bindings).toEqual([binding]);
  });
  it('部分失败返回真实数量且不修改本地资产', async () => {
    const store = arrange();
    const preview = await store.getState().previewSharedProjectReset('series', 'delete');
    mocks.applyReset.mockResolvedValue({ status: 'failed', deletedCount: 1, totalCount: 3, errorCode: 'network' });
    const result = await store.getState().applySharedProjectReset('series', 'delete', preview.previewToken);
    expect(result).toMatchObject({ status: 'failed', deletedCount: 1, totalCount: 3 });
    expect(store.getState().sharedAssetStorage?.bindings).toEqual([binding]);
    expect(store.getState().sharedProjectResetStatus.series.stage).toBe('idle');
  });
  it('取消预览等待原请求结束，迟到结果不能重新显示', async () => {
    const store = arrange();
    let finish!: (value: { mode: 'clear'; objectCount: number; bytes: number; previewToken: string }) => void;
    mocks.previewReset.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.getState().previewSharedProjectReset('series', 'clear');
    const rejected = expect(pending).rejects.toThrow('cancelled');
    let cancelled = false;
    const stopping = store.getState().cancelSharedProjectResetPreview('series').then(() => { cancelled = true; });
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(1));
    expect(cancelled).toBe(false);
    finish({ mode: 'clear', objectCount: 1, bytes: 1, previewToken: 'token' });
    await rejected; await stopping;
    expect(store.getState().sharedProjectResetStatus.series.stage).toBe('idle');
    expect(mocks.applyReset).not.toHaveBeenCalled();
  });
  it('执行时显示清理进度，取消等待实际结果并保留部分删除数', async () => {
    const store = arrange();
    const preview = await store.getState().previewSharedProjectReset('series', 'delete');
    let emit!: (event: { payload: unknown }) => void;
    mocks.listen.mockImplementation(async (_name: string, handler: typeof emit) => { emit = handler; return vi.fn<() => void>(); });
    let finish!: (result: { status: 'cancelled'; deletedCount: number; totalCount: number }) => void;
    mocks.applyReset.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const applying = store.getState().applySharedProjectReset('series', 'delete', preview.previewToken);
    await vi.waitFor(() => expect(mocks.applyReset).toHaveBeenCalledTimes(1));
    const taskId = mocks.applyReset.mock.calls[0][0].taskId;
    emit({ payload: { taskId, ownerId: 'series', phase: 'cleanup', transferredBytes: 2, totalBytes: 3 } });
    expect(store.getState().sharedProjectResetStatus.series.progress).toEqual({ deletedCount: 2, totalCount: 3 });
    let done = false;
    const stopping = store.getState().cancelSharedProjectResetPreview('series').then(() => { done = true; });
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(taskId));
    expect(done).toBe(false);
    finish({ status: 'cancelled', deletedCount: 2, totalCount: 3 });
    expect(await applying).toEqual({ status: 'cancelled', deletedCount: 2, totalCount: 3 });
    await stopping;
    expect(store.getState().sharedAssetStorage?.bindings).toEqual([binding]);
  });
  it('原生清理接口验证输出计数', async () => {
    const storage = await vi.importActual<typeof import('../../src/services/fs/sharedAssetStorage')>('../../src/services/fs/sharedAssetStorage');
    const context = { taskId: 'task', ownerId: 'owner', connectionId: 'connection', connectionRevision: 'revision', libraryId: 'library', sharedProjectId: 'project' };
    mocks.invoke.mockResolvedValueOnce({ mode: 'clear', objectCount: 3, bytes: 10, previewToken: 'token' });
    expect(await storage.previewSharedProjectReset({ ...context, mode: 'clear' })).toMatchObject({ objectCount: 3 });
    mocks.invoke.mockResolvedValueOnce({ status: 'failed', deletedCount: 5, totalCount: 3 });
    await expect(storage.applySharedProjectReset({ ...context, mode: 'clear', previewToken: 'token' })).rejects.toThrow();
  });

  it('记录恢复失败时仅输出白名单字段，不记录原始异常或参数', async () => {
    const storage = await vi.importActual<typeof import('../../src/services/fs/sharedAssetStorage')>('../../src/services/fs/sharedAssetStorage');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mocks.invoke.mockRejectedValue({ code: 'unknown', stage: 'partUpload', message: 'private-signature' });
      await expect(storage.recoverSharedAssetOperation({
        taskId: 'task', ownerId: 'owner', connectionId: 'connection', connectionRevision: 'revision',
        libraryId: 'library', sharedProjectId: 'project', operationId: 'operation', revisionId: 'revision', sharedAssetId: 'asset',
      })).rejects.toBeInstanceOf(Error);
      expect(warning).toHaveBeenCalledWith('[project-asset-sync] IPC failed', 'project_asset_storage_recover_operation',
        { code: 'unknown', stage: 'partUpload' });
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-signature');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('operationId');
    } finally { warning.mockRestore(); }
  });

  it('只将安全的原生失败阶段投影到状态，不暴露原始错误内容', async () => {
    const storage = await vi.importActual<typeof import('../../src/services/fs/sharedAssetStorage')>('../../src/services/fs/sharedAssetStorage');
    mocks.invoke.mockRejectedValue({ code: 'unknown', stage: 'partUpload', message: 'private-signature' });
    const failure = await storage.loadSharedStorageSnapshot().then(
      () => { throw new Error('expected failure'); },
      (error: unknown) => error as Error,
    );
    expect(failure).toMatchObject({ cause: { code: 'unknown', stage: 'partUpload' } });
    expect(JSON.stringify(failure.cause)).not.toContain('private-signature');
    expect(storage.sharedStorageErrorStage(new Error('x', { cause: { stage: 'private-signature' } }))).toBeUndefined();
    const store = arrange();
    mocks.execute.mockRejectedValue(failure);
    await store.getState().previewSharedProjectSync('series');
    await store.getState().syncSharedProjectNow('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'failed', errorStage: 'partUpload' });
    expect(JSON.stringify(store.getState().sharedAssetSyncStatus)).not.toContain('private-signature');
  });

  it('预览不提交传输，显式应用后才执行，并不把路径或会话放进Store', async () => {
    const store = arrange();
    await store.getState().previewSharedProjectSync('series');
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ binding, originProjectId: 'episode' }));
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('preview');
    expect(JSON.stringify(store.getState().sharedAssetSyncStatus)).not.toContain('runtime-only');
    await store.getState().syncSharedProjectNow('series');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('completed');
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it('切换后再切回仍撤销原预览与原生请求，不自动应用迟到结果', async () => {
    const store = arrange();
    let finish!: (value: SharedAssetSyncSession) => void;
    let captured!: SharedAssetSyncContext;
    mocks.preview.mockImplementation((context: SharedAssetSyncContext) => {
      captured = context; context.onTask('native-task', true);
      return new Promise<SharedAssetSyncSession>((resolve) => { finish = resolve; });
    });
    const preparing = store.getState().previewSharedProjectSync('series');
    await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    store.setState({ currentProjectId: 'other' });
    store.setState({ currentProjectId: 'episode' });
    expect(captured.signal?.aborted).toBe(true);
    finish(session(captured)); await preparing;
    expect(mocks.cancel).toHaveBeenCalledWith('native-task');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('paused');
  });

  it('库内容变化使已有预览失效，不能发布旧预览', async () => {
    const store = arrange();
    await store.getState().previewSharedProjectSync('series');
    store.setState({ dramaAssets: { ...store.getState().dramaAssets, lastViewedAt: 2 } });
    await store.getState().cancelSharedProjectSync('series');
    await expect(store.getState().syncSharedProjectNow('series')).rejects.toThrow('请先重新预览');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('实际传输时的本地提交通过项目保存屏障，不能绕过Store直接保存', async () => {
    const store = arrange();
    mocks.execute.mockImplementation(async (_value, options) => {
      await options.applyDownload({ expectedLibrary: store.getState().dramaAssets,
        commit: { ownerId: 'series', operationId: 'operation', mappings: [], operation: {} } });
    });
    await store.getState().previewSharedProjectSync('series');
    await store.getState().syncSharedProjectNow('series');
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'series', originProjectId: 'episode' }));
  });

  it('无变更的已完成预览释放运行实例，关闭面板不会改成暂停', async () => {
    const store = arrange();
    mocks.preview.mockImplementation(async (context: SharedAssetSyncContext) => {
      const value = session(context); value.operations = [];
      context.onStatus({ stage: 'completed', items: [], total: 0, lastSyncedAt: 20 });
      return value;
    });
    await store.getState().previewSharedProjectSync('series');
    await store.getState().cancelSharedProjectSync('series');
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('completed');
    expect(store.getState().sharedAssetSyncStatus.series.lastSyncedAt).toBe(20);
  });

  it('晚到的旧失败不能覆盖新预览', async () => {
    const store = arrange();
    let fail!: (error: Error) => void;
    mocks.preview.mockImplementationOnce(() => new Promise<SharedAssetSyncSession>((_resolve, reject) => { fail = reject; }));
    const old = store.getState().previewSharedProjectSync('series');
    await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    await store.getState().cancelSharedProjectSync('series');
    await store.getState().previewSharedProjectSync('series');
    fail(new Error('旧任务失败')); await old;
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('preview');
    expect(store.getState().sharedAssetSyncStatus.series.error).toBeUndefined();
  });
});
