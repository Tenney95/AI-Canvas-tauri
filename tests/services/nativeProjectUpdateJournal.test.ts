/** 隔离 fake IndexedDB 样本；不读取或更改真实作品。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixtureVerification = vi.hoisted(() => ({ verify: vi.fn(async () => {}) }));
// 只在 Vitest 替身模块中注入物理文件证据；生产仓储没有允许调用方替换核验的参数。
vi.mock('../../src/services/nativeProjectUpdateVerification', () => ({ verifyNativeProjectUpdateCommit: fixtureVerification.verify }));
import { createNativeProject, createNativeEpisode, readNativeProjectCapture, saveNativeCanvas,
  prepareNativeProjectExport, advanceNativeProjectExport, prepareNativeProjectUpdate, readNativeProjectUpdate,
  advanceNativeProjectUpdate, commitNativeProjectUpdate, abortNativeProjectUpdate, listNativeContentRecoveryPoints,
  listNativeRetiredIdentityIds, NATIVE_PROJECT_DATABASE_NAME } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareProjectModelArchiveCapture, materializeProjectModelArchiveBusiness } from '../../src/services/projectModelArchiveService';
import { projectArchivePayloadFromSnapshotV2, readProjectArchiveV4Files } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2, parseProjectExchangeBundleV2 } from '../../src/services/projectExchangeV2Format';
import { rebindRetiredNativeSnapshot } from '../../src/services/nativeProjectIdentityRebind';
import { materializeNativeRawRecovery } from '../../src/services/nativeProjectRawRecovery';
import type { ProjectModelTransferCapture } from '../../src/types/projectModelTransfer';

const id = (prefix: 'p2' | 'e2' | 'c2', digit: string) => `${prefix}-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); fixtureVerification.verify.mockReset().mockResolvedValue(undefined); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function capture(projectId: string): Promise<ProjectModelTransferCapture> {
  const stored = await readNativeProjectCapture(projectId, { factory });
  if (!stored) throw new Error('缺少隔离样本');
  return { schemaVersion: 1, generation: 1, sessionId: 'native-project', sessionRevision: stored.changeRevision,
    sourceToken: 'a'.repeat(64), includesHistory: true, aggregate: { ...stored.aggregate, previews: [], bindings: [] },
    exchange: stored.exchange, history: [], historyBindings: [], editorRecords: [], retiredEditorRecords: [] };
}

async function setup(legacyReceipt = false) {
  const projectId = id('p2', '1');
  const root = await createNativeProject({ name: '隔离剧集', kind: 'series', projectId }, { factory });
  await createNativeEpisode({ projectId, expectedProjectEpoch: root.project.epoch,
    episodeId: id('e2', '2'), canvasId: id('c2', '3'), name: '第一集' }, { factory });
  const before = await capture(projectId), prepared = await prepareProjectModelArchiveCapture(before, []);
  let journal = await prepareNativeProjectExport({ operationId: 'initial-export', projectId, expectedChangeRevision: before.sessionRevision,
    sourceToken: before.sourceToken, expectedExchange: null, exchange: prepared.exchange, includesHistory: true }, { factory });
  journal = await advanceNativeProjectExport(journal.operationId, journal.sequence, 'packing', undefined, { factory });
  const receipt = { outputRef: 'fixture-receipt', packageDigest: 'b'.repeat(64) };
  journal = await advanceNativeProjectExport(journal.operationId, journal.sequence, 'published', receipt, { factory });
  await advanceNativeProjectExport(journal.operationId, journal.sequence, 'registered', receipt, { factory });
  if (legacyReceipt) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(NATIVE_PROJECT_DATABASE_NAME); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('nativeProjectExchange', 'readwrite'), store = tx.objectStore('nativeProjectExchange'), request = store.get(projectId);
        request.onsuccess = () => {
          Object.assign(request.result.exchange.published[0], { archiveBytes: 1024 });
          store.put(request.result);
        };
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  return capture(projectId);
}

async function updateInput(expected: ProjectModelTransferCapture, operationId: string,
  next = structuredClone(expected.aggregate)) {
  const prepared = await prepareProjectModelArchiveCapture({ ...expected, aggregate: next }, []);
  return { operationId, mode: 'update-existing' as const, packageDigest: 'c'.repeat(64), intentDigest: 'd'.repeat(64),
    targetProjectId: expected.aggregate.project.id, expected, next: { ...next, previews: [], bindings: [] }, exchange: prepared.exchange,
    idMap: prepared.exchange.identities, history: [], media: [], editorRecords: [],
    sourceRef: `imports/native-update-${operationId}`, sourceFiles: [],
    backup: { operationId: `backup-${operationId}`, outputRef: 'fixture-backup', packageDigest: 'e'.repeat(64) }, oldAssets: [] };
}

async function ready(input: Parameters<typeof prepareNativeProjectUpdate>[0]) {
  let operation = await prepareNativeProjectUpdate(input, { factory });
  operation = await advanceNativeProjectUpdate(operation.operationId, operation.sequence, 'media_publishing', undefined, { factory });
  return advanceNativeProjectUpdate(operation.operationId, operation.sequence, 'media_ready', `media_v1_${operation.operationId}`, { factory });
}

describe('新项目更新 journal', () => {
  it.each([false, true])('权威媒体或备份核验失败时禁止提交；原 journal 保持可恢复（旧导出回执=%s）', async (legacyReceipt) => {
    const expected = await setup(legacyReceipt), operationId = uuid('7'), input = await updateInput(expected, operationId);
    const operation = await ready(input);
    fixtureVerification.verify.mockRejectedValueOnce(new Error('独立备份无法核实'));
    await expect(commitNativeProjectUpdate(operationId, operation.sequence, { factory })).rejects.toThrow('独立备份无法核实');
    expect((await readNativeProjectUpdate(operationId, { factory }))?.phase).toBe('media_ready');
    expect((await readNativeProjectCapture(expected.aggregate.project.id, { factory }))?.changeRevision).toBe(expected.sessionRevision);
    const committed = await commitNativeProjectUpdate(operationId, operation.sequence, { factory });
    expect(committed.phase).toBe('db_committed');
    expect(fixtureVerification.verify).toHaveBeenCalledTimes(2);
    const exchange = (await readNativeProjectCapture(expected.aggregate.project.id, { factory }))!.exchange!;
    expect(exchange.published).toHaveLength(1);
    expect(exchange.published[0]).not.toHaveProperty('archiveBytes');
    expect((await listNativeContentRecoveryPoints(expected.aggregate.project.id, { factory }))[0].exchange!.published[0])
      .not.toHaveProperty('archiveBytes');
  });
  it('准备后冻结原项目；撤销与迟到推进竞争后不得再提交，原数据保留', async () => {
    const expected = await setup(), operationId = uuid('4'), input = await updateInput(expected, operationId);
    const operation = await prepareNativeProjectUpdate(input, { factory });
    const canvas = expected.aggregate.canvases[0];
    await expect(saveNativeCanvas({ projectId: expected.aggregate.project.id, expectedProjectEpoch: expected.aggregate.project.epoch,
      canvasId: canvas.id, episodeId: canvas.episodeId, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: [], edges: [], groups: [] } }, { factory })).rejects.toThrow('project-update-pending');
    await Promise.allSettled([abortNativeProjectUpdate(operationId, { factory }),
      advanceNativeProjectUpdate(operationId, operation.sequence, 'media_publishing', undefined, { factory })]);
    const current = await readNativeProjectUpdate(operationId, { factory });
    if (current?.phase !== 'aborted') await abortNativeProjectUpdate(operationId, { factory });
    await expect(commitNativeProjectUpdate(operationId, operation.sequence, { factory })).rejects.toThrow();
    expect((await readNativeProjectCapture(expected.aggregate.project.id, { factory }))?.aggregate.canvases[0]).toEqual(canvas);
    expect((await readNativeProjectUpdate(operationId, { factory }))?.phase).toBe('aborted');
  });

  it.each(['missing', 'changed'] as const)('原素材 %s 时只接受备份同身份摘要并幂等提交', async (state) => {
    const initial = await setup(), canvas = initial.aggregate.canvases[0];
    const file = { rootRef: initial.aggregate.project.storageRootRef, path: 'media/a.png', bytes: 3, sha256: 'a'.repeat(64) };
    await saveNativeCanvas({ projectId: initial.aggregate.project.id, expectedProjectEpoch: initial.aggregate.project.epoch,
      canvasId: canvas.id, episodeId: canvas.episodeId, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: [{ id: 'image', type: 'source-image', position: { x: 0, y: 0 }, data: { relativePath: file.path } }], edges: [], groups: [] } }, { factory });
    const beforeExport = await capture(initial.aggregate.project.id);
    const first = await prepareProjectModelArchiveCapture(beforeExport, [file]);
    let exp = await prepareNativeProjectExport({ operationId: 'asset-export', projectId: initial.aggregate.project.id,
      expectedChangeRevision: beforeExport.sessionRevision, sourceToken: beforeExport.sourceToken, expectedExchange: beforeExport.exchange,
      exchange: first.exchange, includesHistory: true }, { factory });
    exp = await advanceNativeProjectExport(exp.operationId, exp.sequence, 'packing', undefined, { factory });
    const receipt = { outputRef: 'asset-export-receipt', packageDigest: 'b'.repeat(64) };
    exp = await advanceNativeProjectExport(exp.operationId, exp.sequence, 'published', receipt, { factory });
    await advanceNativeProjectExport(exp.operationId, exp.sequence, 'registered', receipt, { factory });
    const before = await capture(initial.aggregate.project.id), updateId = uuid('4');
    const next = structuredClone(before.aggregate); next.canvases[0].nodes = []; next.content.script = '新版';
    const nextProjection = await prepareProjectModelArchiveCapture({ ...before, aggregate: next }, []);
    const update = { operationId: updateId, mode: 'update-existing' as const, packageDigest: 'c'.repeat(64), intentDigest: 'd'.repeat(64),
      targetProjectId: before.aggregate.project.id, expected: before, next, exchange: nextProjection.exchange,
      idMap: nextProjection.exchange.identities, history: [], media: [], editorRecords: [], oldAssets: [file],
      sourceRef: `imports/native-update-${updateId}`, sourceFiles: [],
      backup: { operationId: `backup-${updateId}`, outputRef: 'asset-update-receipt', packageDigest: 'e'.repeat(64) } };
    const readyUpdate = await ready(update);
    const committed = await commitNativeProjectUpdate(updateId, readyUpdate.sequence, { factory });
    await advanceNativeProjectUpdate(updateId, committed.sequence, 'finalized', undefined, { factory });
    const point = (await listNativeContentRecoveryPoints(initial.aggregate.project.id, { factory }))[0];
    const current = await capture(initial.aggregate.project.id), restoreId = uuid('6');
    const old = await prepareProjectModelArchiveCapture({ ...current, aggregate: point.aggregate, exchange: point.exchange,
      editorRecords: point.editorRecords, retiredEditorRecords: point.retiredEditorRecords }, [file]);
    const material = await materializeProjectModelArchiveBusiness(projectArchivePayloadFromSnapshotV2(old.snapshot), old.snapshot,
      current, current.aggregate.project.id, restoreId, { exchange: { ...old.exchange, fileBindings: [] }, snapshot: old.snapshot },
      { folderName: current.aggregate.project.dataFolder, allocateId: (kind) => kind === 'episode' ? id('e2', '8') : kind === 'canvas' ? id('c2', '9') : `r2-${uuid('8')}` });
    const logical = readProjectArchiveV4Files(old.snapshot)[0], destination = material.fileBindings[0].localRelativePath;
    const episodeIds = [{ from: id('e2', '2'), to: id('e2', '2') }], canvasIds = [{ from: id('c2', '3'), to: id('c2', '3') }];
    const files = [{ rootRef: file.rootRef, from: file.path, to: destination }];
    const raw = materializeNativeRawRecovery({ original: point.aggregate, target: material.aggregate, episodeIds, canvasIds, files, editors: [] });
    const head = await createProjectExchangeRevisionV2(old.snapshot, [current.exchange!.localHead]);
    const bundle = await parseProjectExchangeBundleV2({ ...current.exchange!.bundle, head: { canonicalVersion: 2, revisionId: head.revisionId },
      revisions: [...current.exchange!.bundle.revisions, head], files: old.exchange.bundle.files });
    const exchange = { ...current.exchange!, localHead: bundle.head, bundle, identities: material.identities,
      fileBindings: material.fileBindings, stateVersion: current.exchange!.stateVersion + 1 };
    const backupFile = old.exchange.bundle.files.find((item) => item.mediaId === logical.mediaId)!;
    const sourceFile = { id: logical.id, rootRef: logical.rootRef, relativePath: logical.relativePath, archivePath: backupFile.archivePath,
      bytes: file.bytes, sha256: file.sha256 };
    const input = { operationId: restoreId, mode: 'restore-content' as const, packageDigest: 'c'.repeat(64), intentDigest: 'd'.repeat(64),
      targetProjectId: current.aggregate.project.id, expected: current, next: raw.aggregate, exchange, idMap: material.identities,
      history: [], media: material.media, editorRecords: [], sourceRef: `imports/native-update-${restoreId}`, sourceFiles: [sourceFile],
      backup: { operationId: `backup-${restoreId}`, outputRef: 'fixture-restore', packageDigest: 'e'.repeat(64) },
      oldAssets: state === 'changed' ? [{ ...file, sha256: 'f'.repeat(64) }] : [], restoreRecoveryId: point.operationId, restoreAssets: [],
      rawRecovery: { recoveryId: point.operationId, episodeIds, canvasIds, files, rebindings: [] } };
    await expect(prepareNativeProjectUpdate({ ...input, sourceFiles: [{ ...sourceFile, sha256: 'f'.repeat(64) }] }, { factory }))
      .rejects.toThrow('restore-file-conflict');
    let operation = await prepareNativeProjectUpdate(input, { factory });
    operation = await advanceNativeProjectUpdate(restoreId, operation.sequence, 'media_publishing', undefined, { factory });
    operation = await advanceNativeProjectUpdate(restoreId, operation.sequence, 'media_ready', `media_v1_${restoreId}`, { factory });
    const committedRestore = await commitNativeProjectUpdate(restoreId, operation.sequence, { factory });
    expect((await commitNativeProjectUpdate(restoreId, operation.sequence, { factory })).committedToken).toBe(committedRestore.committedToken);
    const node = (await readNativeProjectCapture(current.aggregate.project.id, { factory }))!.aggregate.canvases[0].nodes[0] as { data: { relativePath: string } };
    expect(node.data.relativePath).toBe(destination);
  });

  it('剪辑工程在冻结后发生未授权变化时，CAS 拒绝整个作品提交', async () => {
    const expected = await setup(), operationId = uuid('7'), input = await updateInput(expected, operationId);
    const operation = await ready(input), canvasId = expected.aggregate.canvases[0].id;
    const record = { id: `${canvasId}::node`, schemaVersion: 1, projectId: canvasId, nodeId: 'node',
      name: '本地剪辑', tracks: [], createdAt: 1, updatedAt: 1 };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(NATIVE_PROJECT_DATABASE_NAME);
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('nativeProjectExchange', 'readwrite');
        tx.objectStore('nativeProjectExchange').add({ projectId: `video-editor:${record.id}`, kind: 'video-editor-v1',
          ownerProjectId: expected.aggregate.project.id, canvasId, record });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
      await expect(commitNativeProjectUpdate(operationId, operation.sequence, { factory })).rejects.toThrow('剪辑工程在更新前已变化');
      expect((await readNativeProjectCapture(expected.aggregate.project.id, { factory }))?.changeRevision).toBe(expected.sessionRevision);
      await abortNativeProjectUpdate(operationId, { factory });
    } finally { db.close(); }
  });

  it('拒绝跨操作复用备份，结构删除保留墓碑，恢复不能复活原身份', async () => {
    const expected = await setup(), operationId = uuid('4'), next = structuredClone(expected.aggregate);
    next.episodes = []; next.episodeContents = []; next.canvases = [];
    delete next.project.lastOpenedCanvasId;
    const input = await updateInput(expected, operationId, next);
    await expect(prepareNativeProjectUpdate({ ...input, backup: { ...input.backup, operationId: `backup-${uuid('5')}` } }, { factory }))
      .rejects.toThrow('invalid-update-journal');
    const pending = await ready(input);
    const committed = await commitNativeProjectUpdate(operationId, pending.sequence, { factory });
    await advanceNativeProjectUpdate(operationId, committed.sequence, 'finalized', undefined, { factory });
    const retired = await listNativeRetiredIdentityIds(expected.aggregate.project.id, { factory });
    expect(retired).toEqual(expect.arrayContaining([id('e2', '2'), id('c2', '3')]));
    const point = (await listNativeContentRecoveryPoints(expected.aggregate.project.id, { factory }))[0];
    expect(point.aggregate.episodes[0].id).toBe(id('e2', '2'));
    expect(point.backup).toEqual(input.backup);
    const current = await capture(expected.aggregate.project.id), restoreId = uuid('6');
    const restored = { ...structuredClone(point.aggregate), previews: [], bindings: [] };
    const restoreBase = await updateInput(current, restoreId, restored);
    const restore = { ...restoreBase, mode: 'restore-content' as const, editorRecords: point.editorRecords!,
      restoreRecoveryId: point.operationId, restoreAssets: point.oldAssets! };
    const altered = structuredClone(restore); altered.next.content.script = '伪造恢复内容';
    await expect(prepareNativeProjectUpdate(altered, { factory })).rejects.toThrow('restore-point-conflict');
    const operation = await prepareNativeProjectUpdate(restore, { factory });
    const publishing = await advanceNativeProjectUpdate(restoreId, operation.sequence, 'media_publishing', undefined, { factory });
    const mediaReady = await advanceNativeProjectUpdate(restoreId, publishing.sequence, 'media_ready', `media_v1_${restoreId}`, { factory });
    await expect(commitNativeProjectUpdate(restoreId, mediaReady.sequence, { factory })).rejects.toThrow('retired-or-occupied-identity');
    await abortNativeProjectUpdate(restoreId, { factory });

    // 明确创建新协作 ID 与新本机 ID，旧身份仍保留在墓碑和历史映射中。
    const freshId = uuid('7'), latest = await capture(expected.aggregate.project.id);
    const original = await prepareProjectModelArchiveCapture({ ...latest, aggregate: point.aggregate,
      exchange: point.exchange, editorRecords: point.editorRecords, retiredEditorRecords: point.retiredEditorRecords }, []);
    const local = await prepareProjectModelArchiveCapture(latest, []);
    const rebound = rebindRetiredNativeSnapshot(original.snapshot, local.exchange, retired);
    const material = await materializeProjectModelArchiveBusiness(projectArchivePayloadFromSnapshotV2(rebound.snapshot), rebound.snapshot,
      latest, latest.aggregate.project.id, freshId, { exchange: { ...original.exchange, identities: local.exchange.identities }, snapshot: original.snapshot },
      { allocateId: (kind) => kind === 'episode' ? id('e2', '8') : kind === 'canvas' ? id('c2', '9') : `r2-${uuid('8')}`,
        folderName: latest.aggregate.project.dataFolder });
    const episodeIds = [{ from: id('e2', '2'), to: id('e2', '8') }];
    const canvasIds = [{ from: id('c2', '3'), to: id('c2', '9') }];
    const raw = materializeNativeRawRecovery({ original: point.aggregate, target: material.aggregate,
      episodeIds, canvasIds, files: [], editors: point.editorRecords ?? [] });
    const head = await createProjectExchangeRevisionV2(rebound.snapshot, [local.exchange.localHead]);
    const bundle = await parseProjectExchangeBundleV2({ ...local.exchange.bundle, head: { canonicalVersion: 2, revisionId: head.revisionId },
      revisions: [...local.exchange.bundle.revisions, head], files: [] });
    const nextExchange = { ...local.exchange, localHead: bundle.head, bundle, identities: material.identities,
      fileBindings: material.fileBindings, stateVersion: latest.exchange!.stateVersion + 1, published: latest.exchange!.published };
    const safeInput = { ...await updateInput(latest, freshId, raw.aggregate), mode: 'restore-content' as const,
      next: raw.aggregate, exchange: nextExchange, idMap: material.identities, editorRecords: raw.editors,
      restoreRecoveryId: point.operationId, restoreAssets: [],
      rawRecovery: { recoveryId: point.operationId, episodeIds, canvasIds, files: [], rebindings: rebound.rebindings } };
    let safe = await prepareNativeProjectUpdate(safeInput, { factory });
    safe = await advanceNativeProjectUpdate(freshId, safe.sequence, 'media_publishing', undefined, { factory });
    safe = await advanceNativeProjectUpdate(freshId, safe.sequence, 'media_ready', `media_v1_${freshId}`, { factory });
    await commitNativeProjectUpdate(freshId, safe.sequence, { factory });
    expect((await readNativeProjectCapture(latest.aggregate.project.id, { factory }))?.aggregate.episodes[0].id).toBe(id('e2', '8'));
    expect(await listNativeRetiredIdentityIds(latest.aggregate.project.id, { factory })).toEqual(expect.arrayContaining([id('e2', '2'), id('c2', '3')]));
  });
});
