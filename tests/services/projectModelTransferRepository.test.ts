/** P5 聚合事务、来源冻结、备份与恢复的隔离回归。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectModelTransferRepository } from '../../src/services/indexedDb/projectModelTransferRepository';
import { beginProjectModelFixtureBusinessSession, createProjectModelBusinessRepository } from '../../src/services/indexedDb/projectModelBusinessRepository';
import { createProjectModelStagingRepository, openProjectModelFixtureDatabase } from '../../src/services/indexedDb/projectModelStagingRepository';
import { readLegacyMigrationSnapshot } from '../../src/services/indexedDb/projectModelMigrationRepository';
import { createProjectModelBackup, type ProjectModelBackupPort } from '../../src/services/projectModelBackup';
import { fingerprintProjectModelSource } from '../../src/services/projectModelSourceFingerprint';
import { createProjectModelPreRestoreBackupService, type ProjectModelPreRestoreNativePort } from '../../src/services/projectModelPreRestoreBackup';
import { createProjectExchangeRevisionV2, exchangeReferencesV2 } from '../../src/services/projectExchangeV2Format';
import type { ProjectExchangeEntityV2 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferAggregate, ProjectModelTransferCapture, ProjectModelTransferExchange, ProjectModelTransferImportInput } from '../../src/types/projectModelTransfer';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';

const pendingSource = '[{"projectId":"S","nodeId":"paid","taskId":"paid-remote","submitted":true,"mediaRecoveryState":"submit_unknown"}]';
const storage = { getItem: () => pendingSource };
async function mutate(database: IDBDatabase, names: string[], action: (tx: IDBTransaction) => void) {
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite'); action(tx);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
async function all(database: IDBDatabase, name: string) {
  return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const tx = database.transaction(name, 'readonly'), request = tx.objectStore(name).getAll();
    tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error);
  });
}
async function setup() {
  const factory = new IDBFactory(), name = 'ai-canvas-model-fixture-transfer';
  const original = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 27);
    request.onupgradeneeded = () => {
      for (const table of ['projects', 'metadata', 'agentTasks', 'chatConversations', 'chatMessages', 'projectMemories']) request.result.createObjectStore(table, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await mutate(original, ['projects', 'metadata', 'agentTasks', 'chatConversations'], (tx) => {
    tx.objectStore('projects').put({ id: 'S', name: '原项目', createdAt: 1, updatedAt: 2, nodes: [], edges: [], dataFolder: 'original-folder' });
    tx.objectStore('agentTasks').put({ id: 'paid', projectId: 'S', sequence: 12, toolCallCount: 7, status: 'paused', budget: { maxToolCalls: 24 } });
    tx.objectStore('metadata').put({ id: 'mcp-operation:paid', bindingId: 'permanent-original-key', sequence: 12 });
    tx.objectStore('chatConversations').put({ id: 'existing-chat', projectId: 'S', title: '用户已经改过的标题', agentMode: 'plan' });
  });
  const snapshot = await readLegacyMigrationSnapshot(original, { localStorage: storage }); original.close();
  const backup = await createProjectModelBackup(snapshot.source, { operationId: 'source-backup', createdAt: 0 });
  const database = await openProjectModelFixtureDatabase({ factory, name }), staging = createProjectModelStagingRepository(database);
  await staging.prepare({ operationId: 'source-migration', generation: 1, source: snapshot.source,
    sourceDigest: await fingerprintProjectModelSource(backup.manifest), backupOperationId: 'source-backup', backupManifestDigest: 'b'.repeat(64) });
  await staging.stageNextBatch({ operationId: 'source-migration', batchSize: 500 }); await staging.verify({ operationId: 'source-migration' });
  const session = await beginProjectModelFixtureBusinessSession(database, { operationId: 'source-migration', generation: 1, sessionId: 'transfer-session' });
  return { database, session, repository: createProjectModelTransferRepository(database, session), business: createProjectModelBusinessRepository(database, session) };
}
function idMap(next: ProjectModelTransferAggregate) {
  return [{ kind: 'project' as const, sourceId: 'logical-project', localId: next.project.id },
    ...next.episodes.map((item) => ({ kind: 'episode' as const, sourceId: `logical-${item.id}`, localId: item.id })),
    ...next.canvases.map((item) => ({ kind: 'canvas' as const, sourceId: `logical-${item.id}`, localId: item.id })),
    ...next.project.storageBindings.map((item, index) => ({ kind: 'storage-root' as const, sourceId: `logical-root-${index}`, localId: item.rootRef }))];
}
function update(capture: ProjectModelTransferCapture, operationId = 'import-update'): ProjectModelTransferImportInput {
  const next = structuredClone(capture.aggregate); next.content.script = '新导入全剧稿';
  return { operationId, mode: 'update-existing', packageDigest: 'a'.repeat(64), intentDigest: 'c'.repeat(64),
    targetProjectId: next.project.id, expected: capture, next, exchange: null, idMap: idMap(next), history: [], media: [] };
}
async function ready(repository: ReturnType<typeof createProjectModelTransferRepository>, input: ProjectModelTransferImportInput) {
  const prepared = await repository.prepareImport(input);
  const publishing = await repository.advanceImport(input.operationId, prepared.sequence, 'media_publishing');
  return repository.advanceImport(input.operationId, publishing.sequence, 'media_ready');
}
async function exchange(capture: ProjectModelTransferCapture): Promise<ProjectModelTransferExchange> {
  const entities: ProjectExchangeEntityV2[] = [
    { kind: 'project', scopeId: 'S', id: 'S', data: { name: '原项目', kind: 'standalone', standaloneCanvasId: 'canvas',
      storageRoots: [{ id: 'root', role: 'shared' }], content: {} }, references: [] },
    { kind: 'canvas', scopeId: 'S', id: 'canvas', data: { projectId: 'S', episodeId: null, storageRootRef: 'root',
      revisionScope: capture.aggregate.canvases[0].revisionScope, nodesIds: [], edgesIds: [], groupsIds: [] }, references: [] },
  ];
  for (const entity of entities) entity.references = exchangeReferencesV2(entity, entities, 'S');
  const revision = await createProjectExchangeRevisionV2({ format: 'ai-canvas-project-snapshot', canonicalVersion: 2,
    lineageId: 'lineage', rootProjectId: 'S', complete: true, entities, media: [], historicalTargets: [] });
  return { lineageId: 'lineage', localHead: { canonicalVersion: 2, revisionId: revision.revisionId }, stateVersion: 1, published: [], fileBindings: [],
    identities: [{ kind: 'project', sourceId: 'S', localId: 'S' }, { kind: 'canvas', sourceId: 'canvas', localId: capture.aggregate.canvases[0].id },
      { kind: 'storage-root', sourceId: 'root', localId: capture.aggregate.project.storageRootRef }],
    bundle: { format: 'ai-canvas-project-exchange', version: 2, packageId: 'package', lineageId: 'lineage',
      head: { canonicalVersion: 2, revisionId: revision.revisionId }, revisions: [revision], ancestors: [], files: [] } };
}
function backupNative() {
  const backups = new Map<string, Map<string, Uint8Array>>();
  const seals = new Map<string, { manifest: string; complete: string }>();
  const lease = { leaseId: 'native-lease', profileId: 'transfer', mode: 'isolated-fixture' as const, coldStart: true as const, productionAllowed: false as const };
  const port = (operationId: string): ProjectModelBackupPort => {
    const files = backups.get(operationId)!;
    const write = async (path: string, bytes: Uint8Array) => { if (files.has(path)) throw new Error('exists'); files.set(path, Uint8Array.from(bytes)); };
    return { writeExclusive: write, publishComplete: write, read: async (path, maxBytes) => {
      const bytes = files.get(path); if (!bytes || bytes.byteLength > maxBytes) throw new Error('missing'); return Uint8Array.from(bytes);
    } };
  };
  const native: ProjectModelPreRestoreNativePort = {
    getLease: async () => lease, verifyLease: async (leaseId) => { if (leaseId !== lease.leaseId) throw new Error('lease'); return lease; },
    createBackup: async (_leaseId, operationId) => { if (backups.has(operationId)) throw new Error('existing backup'); backups.set(operationId, new Map()); return port(operationId); },
    openBackup: async (_leaseId, operationId) => { if (!backups.has(operationId)) throw new Error('missing backup'); return port(operationId); },
    seal: async (_leaseId, operationId) => {
      const files = backups.get(operationId)!;
      seals.set(operationId, { manifest: await sha256BytesHex(files.get('manifest.json')!), complete: await sha256BytesHex(files.get('complete.json')!) });
      return native.verifySeal(_leaseId, operationId);
    },
    verifySeal: async (_leaseId, operationId) => {
      const seal = seals.get(operationId), files = backups.get(operationId)!;
      if (!seal || seal.manifest !== await sha256BytesHex(files.get('manifest.json')!) || seal.complete !== await sha256BytesHex(files.get('complete.json')!)) throw new Error('bad seal');
      return { format: 'project-model-durable-seal-v1', operationId, profileId: lease.profileId,
        manifestSha256: seal.manifest, completeSha256: seal.complete, durability: 'fsync-and-directory-barrier', canActivate: false };
    },
  };
  return { native, backups };
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('P5 fixture 项目传输事务', () => {
  it('新建/独立复制分配新本机身份，重开同operation复用第一次分配结果', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!, next = structuredClone(capture.aggregate);
      next.project = { ...next.project, id: 'New', name: '独立副本', dataFolder: 'new-copy-folder', storageRootRef: 'new-root',
        storageBindings: [{ rootRef: 'new-root', folderName: 'new-copy-folder', source: 'project-managed', sourceRecordIds: [] }], lastOpenedCanvasId: 'new-canvas' };
      next.content.projectId = 'New';
      if (next.content.standaloneCreative) next.content.standaloneCreative.storageRootRef = 'new-root';
      next.canvases = next.canvases.map((canvas) => ({ ...canvas, id: 'new-canvas', projectId: 'New', storageRootRef: 'new-root' }));
      next.previews = []; next.bindings = [];
      const input: ProjectModelTransferImportInput = { ...update(capture, 'copy-operation'), mode: 'independent-copy',
        expected: null, next, idMap: idMap(next), targetProjectId: 'New' };
      const first = await sample.repository.prepareImport(input);
      const alternate = structuredClone(input); alternate.next.canvases[0].id = 'retry-allocated-canvas'; alternate.next.project.lastOpenedCanvasId = 'retry-allocated-canvas';
      alternate.idMap = idMap(alternate.next);
      const reopened = createProjectModelTransferRepository(sample.database, sample.session);
      expect(await reopened.findImport(input.operationId)).toEqual(first);
      expect((await reopened.prepareImport(alternate)).idMap).toEqual(first.idMap);
      const publishing = await reopened.advanceImport(first.operationId, first.sequence, 'media_publishing');
      const mediaReady = await reopened.advanceImport(first.operationId, publishing.sequence, 'media_ready');
      await reopened.commitImport(first.operationId, mediaReady.sequence);
      expect((await reopened.capture('New'))!.aggregate.canvases[0].id).toBe('new-canvas');
      expect((await reopened.capture('S'))!.sourceToken).toBe(capture.sourceToken);
      expect((await all(sample.database, 'projects'))).toHaveLength(1);
      await expect(reopened.prepareImport({ ...alternate, intentDigest: 'f'.repeat(64) })).rejects.toThrow('operation-identity-conflict');
      expect(await reopened.findImport('never-prepared')).toBeNull();
    } finally { sample.database.close(); }
  });
  it('完整聚合CAS拒绝预览后画布变化，不写journal或部分新稿', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!;
      await sample.business.saveCanvas({ projectId: 'S', expectedProjectEpoch: capture.aggregate.project.epoch,
        canvasId: 'S', expectedCanvasEpoch: capture.aggregate.canvases[0].epoch, expectedCanvasRevision: capture.aggregate.canvases[0].revision, document: { nodes: [{ id: 'n' }], edges: [], groups: [] } });
      await expect(sample.repository.prepareImport(update(capture))).rejects.toThrow('preview-changed');
      expect((await sample.repository.capture('S'))!.aggregate.content.script).toBe(capture.aggregate.content.script);
      expect((await all(sample.database, 'metadata')).some((item) => String(item.id).startsWith('project-model-import:'))).toBe(false);
    } finally { sample.database.close(); }
  });

  it('待完成导入冻结原归档来源，重开不接受新目录或替换媒体映射', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!, input = update(capture, 'frozen-source');
      input.sourceRef = 'incoming/frozen-source';
      input.sourceFiles = [{ id: 'logical-file', rootRef: 'logical-root', relativePath: 'clips/a.mp4',
        archivePath: 'assets/original-a.mp4', bytes: 5, sha256: 'd'.repeat(64) }];
      const first = await sample.repository.prepareImport(input);
      input.sourceFiles[0].archivePath = 'assets/replaced.mp4';
      const reopened = createProjectModelTransferRepository(sample.database, sample.session);
      expect((await reopened.readImport(input.operationId)).sourceFiles?.[0].archivePath).toBe('assets/original-a.mp4');
      await expect(reopened.prepareImport(input)).rejects.toThrow('operation-identity-conflict');
      await expect(reopened.prepareImport({ ...input, sourceFiles: first.sourceFiles, sourceRef: 'incoming/other' })).rejects.toThrow('operation-identity-conflict');
      expect(await reopened.prepareImport({ ...input, sourceRef: undefined, sourceFiles: undefined })).toEqual(first);
      await expect(reopened.prepareImport({ ...input, operationId: 'invalid-source', sourceRef: '../escape' })).rejects.toThrow();
      expect((await reopened.capture('S'))!.sourceToken).toBe(capture.sourceToken);
    } finally { sample.database.close(); }
  });

  it('提交失败原子保留旧内容；提交后的重复调用只读回原结果，预算/回执不回滚', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!, input = update(capture), journal = await ready(sample.repository, input);
      const paid = await all(sample.database, 'agentTasks'), mcp = (await all(sample.database, 'metadata')).find((row) => row.id === 'mcp-operation:paid');
      const realPut = IDBObjectStore.prototype.put;
      const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === 'projectContents') throw new DOMException('fixture quota', 'QuotaExceededError');
        return realPut.apply(this, args);
      });
      await expect(sample.repository.commitImport(input.operationId, journal.sequence)).rejects.toThrow(); failure.mockRestore();
      expect((await sample.repository.capture('S'))!.sourceToken).toBe(capture.sourceToken);
      expect((await sample.repository.readImport(input.operationId)).phase).toBe('media_ready');
      const committed = await sample.repository.commitImport(input.operationId, journal.sequence);
      const repeated = await sample.repository.commitImport(input.operationId, journal.sequence);
      expect(repeated).toEqual(committed);
      expect(committed.next.project.epoch).toBeGreaterThan(capture.aggregate.project.epoch);
      expect(committed.next.content.revisions.script).toBeGreaterThan(capture.aggregate.content.revisions.script);
      expect((await sample.repository.recoveryDisposition(input.operationId)).action).toBe('reproject-committed');
      expect(await all(sample.database, 'agentTasks')).toEqual(paid);
      expect((await all(sample.database, 'metadata')).find((row) => row.id === 'mcp-operation:paid')).toEqual(mcp);
      expect(storage.getItem()).toBe(pendingSource);
      await expect(sample.business.saveCanvas({ projectId: 'S', expectedProjectEpoch: capture.aggregate.project.epoch,
        canvasId: 'S', expectedCanvasEpoch: 0, expectedCanvasRevision: 0, document: { nodes: [], edges: [], groups: [] } })).rejects.toThrow('project-version-conflict');
    } finally { sample.database.close(); }
  });

  it('相同来源历史先绑定原行，重复导入不覆盖用户编辑或按owner重建新历史', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S', { history: true }))!, input = update(capture);
      input.history = [{ kind: 'conversation', sourceNamespace: 'origin-lineage', archiveOriginId: 'conversation-origin', existingLocalId: 'existing-chat',
        value: { id: 'candidate-chat', projectId: 'S', title: '包内旧标题', agentMode: 'plan' } },
      { kind: 'message', sourceNamespace: 'origin-lineage', archiveOriginId: 'message-origin',
        value: { id: 'imported-message', projectId: 'S', conversationId: 'candidate-chat', sequence: 1, role: 'user', content: '归档历史', status: 'done', createdAt: 1 } }];
      const first = await ready(sample.repository, input); await sample.repository.commitImport(input.operationId, first.sequence);
      const after = (await sample.repository.capture('S', { history: true }))!;
      const repeated = update(after, 'repeat-import'); repeated.history = input.history.map((item) => ({ ...item, value: { ...item.value, id: `new-${item.value.id}` } }));
      repeated.history[1].value.conversationId = 'new-candidate-chat';
      const second = await ready(sample.repository, repeated); await sample.repository.commitImport(repeated.operationId, second.sequence);
      expect(await all(sample.database, 'chatConversations')).toHaveLength(1);
      expect((await all(sample.database, 'chatConversations'))[0].title).toBe('用户已经改过的标题');
      expect(await all(sample.database, 'chatMessages')).toHaveLength(1);
      expect((await all(sample.database, 'chatMessages'))[0].conversationId).toBe('existing-chat');
      expect((await all(sample.database, 'archiveHistoryBindings'))).toHaveLength(2);
      const shared = update((await sample.repository.capture('S', { history: true }))!, 'shared-origin-import');
      shared.history = input.history.map((item) => ({ ...item, sourceNamespace: 'another-lineage',
        existingLocalId: item.kind === 'conversation' ? 'existing-chat' : 'imported-message' }));
      const third = await ready(sample.repository, shared); await sample.repository.commitImport(shared.operationId, third.sequence);
      expect((await sample.repository.capture('S', { history: true }))!.history).toHaveLength(2);
      expect(await all(sample.database, 'chatConversations')).toHaveLength(1);
      expect(await all(sample.database, 'chatMessages')).toHaveLength(1);
      expect((await all(sample.database, 'archiveHistoryBindings'))).toHaveLength(4);
    } finally { sample.database.close(); }
  });

  it('媒体未被原生核验不能进入ready，已提交后不授予删除媒体或再次合并', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!, input = update(capture);
      input.media = [{ rootRef: input.next.project.storageRootRef, relativePath: 'clip.mp4', bytes: 5, sha256: 'd'.repeat(64) }];
      const journal = await sample.repository.prepareImport(input), publishing = await sample.repository.advanceImport(input.operationId, journal.sequence, 'media_publishing');
      await expect(sample.repository.advanceImport(input.operationId, publishing.sequence, 'media_ready', { mediaPublicationRef: 'opaque-file-publication' })).rejects.toThrow('verifier-required');
      expect((await sample.repository.capture('S'))!.sourceToken).toBe(capture.sourceToken);
      expect(await sample.repository.recoveryDisposition(input.operationId)).toMatchObject({ canRepeatMerge: false, canDeletePublishedMedia: false });
    } finally { sample.database.close(); }
  });

  it('准备导出不推进head，发布失败不冒充成功；原生回执核验后才登记', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!, preparedExchange = await exchange(capture);
      const verifyPublication = vi.fn(async () => undefined);
      const repository = createProjectModelTransferRepository(sample.database, sample.session, { verifyExportPublication: verifyPublication });
      const prepared = await repository.prepareExport({ operationId: 'export-operation', capture, exchange: preparedExchange });
      expect((await repository.capture('S'))!.exchange).toBeNull();
      const packing = await repository.advanceExport(prepared.operationId, prepared.sequence, 'packing');
      verifyPublication.mockRejectedValueOnce(new Error('native receipt mismatch'));
      await expect(repository.advanceExport(prepared.operationId, packing.sequence, 'published', { packageDigest: 'e'.repeat(64), outputRef: 'opaque-output-receipt' })).rejects.toThrow('native receipt');
      expect((await repository.readExport(prepared.operationId)).phase).toBe('packing');
      const published = await repository.advanceExport(prepared.operationId, packing.sequence, 'published', { packageDigest: 'e'.repeat(64), outputRef: 'opaque-output-receipt' });
      expect((await repository.capture('S'))!.exchange).toBeNull();
      await repository.advanceExport(prepared.operationId, published.sequence, 'registered');
      expect((await repository.capture('S'))!.exchange?.published).toEqual([expect.objectContaining({ operationId: prepared.operationId, packageDigest: 'e'.repeat(64) })]);
    } finally { sample.database.close(); }
  });

  it('同项目未完成导出串行，已发布后编辑工作稿仍可登记原已交接快照', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!, preparedExchange = await exchange(capture);
      const repository = createProjectModelTransferRepository(sample.database, sample.session, { verifyExportPublication: async () => undefined });
      const prepared = await repository.prepareExport({ operationId: 'export-published', capture, exchange: preparedExchange });
      await expect(repository.prepareExport({ operationId: 'export-competing', capture, exchange: preparedExchange })).rejects.toThrow('unfinished-export-present');
      const packing = await repository.advanceExport(prepared.operationId, prepared.sequence, 'packing');
      const published = await repository.advanceExport(prepared.operationId, packing.sequence, 'published', { packageDigest: 'e'.repeat(64), outputRef: 'opaque-published-output' });
      await sample.business.saveCanvas({ projectId: 'S', expectedProjectEpoch: capture.aggregate.project.epoch,
        canvasId: 'S', expectedCanvasEpoch: capture.aggregate.canvases[0].epoch, expectedCanvasRevision: capture.aggregate.canvases[0].revision, document: { nodes: [{ id: 'later-edit' }], edges: [], groups: [] } });
      const edited = (await repository.capture('S'))!;
      await repository.advanceExport(prepared.operationId, published.sequence, 'registered');
      const registered = (await repository.capture('S'))!;
      expect(registered.aggregate).toEqual(edited.aggregate);
      expect(registered.exchange?.localHead).toEqual(preparedExchange.localHead);
      expect(registered.exchange?.published[0]).toMatchObject({ operationId: prepared.operationId, packageDigest: 'e'.repeat(64) });
    } finally { sample.database.close(); }
  });

  it('准备和提交导入均拒绝同项目待发布导出，保留可恢复journal和旧业务稿', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!, input = update(capture, 'import-before-export');
      const mediaReady = await ready(sample.repository, input);
      await sample.repository.prepareExport({ operationId: 'pending-export', capture, exchange: await exchange(capture) });
      await expect(sample.repository.prepareImport(update(capture, 'import-after-export'))).rejects.toThrow('unfinished-export-present');
      await expect(sample.repository.commitImport(input.operationId, mediaReady.sequence)).rejects.toThrow('unfinished-export-present');
      expect((await sample.repository.readImport(input.operationId)).phase).toBe('media_ready');
      expect((await sample.repository.capture('S'))!.sourceToken).toBe(capture.sourceToken);
    } finally { sample.database.close(); }
  });

  it('仅prepared导出可显式撤销并解除作品互斥，packing未知结果不能撤销重发', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S'))!, proposed = await exchange(capture);
      const prepared = await sample.repository.prepareExport({ operationId: 'abandoned-export', capture, exchange: proposed });
      const aborted = await sample.repository.abandonPreparedExport(prepared.operationId, prepared.sequence);
      expect(aborted.phase).toBe('aborted');
      expect(await sample.repository.abandonPreparedExport(prepared.operationId, prepared.sequence)).toEqual(aborted);
      expect((await sample.repository.readExport(prepared.operationId)).phase).toBe('aborted');
      expect((await sample.repository.prepareExport({ operationId: prepared.operationId, capture, exchange: proposed })).phase).toBe('aborted');
      const next = await sample.repository.prepareExport({ operationId: 'next-export', capture, exchange: proposed });
      const packing = await sample.repository.advanceExport(next.operationId, next.sequence, 'packing');
      await expect(sample.repository.abandonPreparedExport(next.operationId, packing.sequence)).rejects.toThrow('only-prepared-export-can-abort');
      expect((await sample.repository.readExport(next.operationId)).phase).toBe('packing');
      expect((await sample.repository.capture('S'))!.sourceToken).toBe(capture.sourceToken);
    } finally { sample.database.close(); }
  });

  it('同来源历史仅随已证明的删除单向退役，保留原对话正文并兼容再次capture', async () => {
    const sample = await setup();
    try {
      const capture = (await sample.repository.capture('S', { history: true }))!, initialExchange = await exchange(capture);
      const initial = update(capture, 'bind-active-history'); initial.exchange = initialExchange; initial.idMap = initialExchange.identities;
      initial.history = [{ kind: 'conversation', sourceNamespace: 'lineage', archiveOriginId: 'stable-conversation', existingLocalId: 'existing-chat',
        historicalTarget: { state: 'active', kind: 'project', projectId: 'S', domain: 'standalone-creative' },
        value: { id: 'candidate-chat', projectId: 'S', title: '包内标题', agentMode: 'plan' } }];
      const first = await ready(sample.repository, initial); await sample.repository.commitImport(initial.operationId, first.sequence);
      const expected = (await sample.repository.capture('S', { history: true }))!, retired = update(expected, 'retire-history');
      retired.next.project.kind = 'series'; delete retired.next.project.lastOpenedCanvasId; delete retired.next.content.standaloneCreative;
      retired.next.canvases = []; retired.next.previews = [];
      retired.next.bindings = retired.next.bindings.map((binding) => ({ ...binding, retired: true as const, retiredAt: 1 }));
      const descriptor = { state: 'retired' as const, kind: 'standalone-creative' as const, projectId: 'S', id: 'S' };
      const head = await createProjectExchangeRevisionV2({ format: 'ai-canvas-project-snapshot', canonicalVersion: 2, lineageId: 'lineage', rootProjectId: 'S', complete: true,
        entities: [{ kind: 'project', scopeId: 'S', id: 'S', data: { name: '零集剧集', kind: 'series', storageRoots: [{ id: 'root', role: 'shared' }], content: {} }, references: [] }],
        media: [], historicalTargets: [descriptor] }, [initialExchange.localHead]);
      retired.exchange = { ...initialExchange, localHead: { canonicalVersion: 2, revisionId: head.revisionId }, stateVersion: 2,
        bundle: { ...initialExchange.bundle, head: { canonicalVersion: 2, revisionId: head.revisionId }, revisions: [...initialExchange.bundle.revisions, head] } };
      retired.idMap = retired.exchange.identities;
      retired.history = initial.history.map((item) => ({ ...item, historicalTarget: descriptor }));
      const second = await ready(sample.repository, retired); await sample.repository.commitImport(retired.operationId, second.sequence);
      const after = (await sample.repository.capture('S', { history: true }))!;
      expect(after.history[0].historicalTarget).toEqual(descriptor);
      expect((await all(sample.database, 'chatConversations'))[0].title).toBe('用户已经改过的标题');
      const inverse = update(after, 'unproved-revival'); inverse.exchange = { ...after.exchange!, stateVersion: 3 }; inverse.idMap = inverse.exchange.identities;
      inverse.history = initial.history;
      await expect(sample.repository.prepareImport(inverse)).rejects.toThrow('invalid-history-target');
    } finally { sample.database.close(); }
  });

  it('恢复前备份使用真实schema28新表、完整审计及原LS，并要求读回seal', async () => {
    const sample = await setup(), port = backupNative();
    try {
      const capture = (await sample.repository.capture('S'))!;
      const service = createProjectModelPreRestoreBackupService(sample.database, sample.session, { native: port.native, localStorage: storage });
      const proof = await service.create(capture, { operationId: 'pre-restore-backup' });
      const manifest = JSON.parse(new TextDecoder().decode(port.backups.get(proof.backupOperationId)!.get('manifest.json')!));
      expect(manifest).toMatchObject({ format: 'project-model-fixture-backup-v2', schemaVersion: 28 });
      expect(manifest.stores.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(['projectRoots', 'canvasDocuments', 'archiveHistoryBindings', 'agentTasks', 'metadata']));
      await expect(service.verify(proof, capture)).resolves.toBeUndefined();
      const input = { ...update(capture), mode: 'restore-content' as const, restoreProof: proof };
      await expect(sample.repository.prepareImport(input)).rejects.toThrow('verifier-required');
      const repository = createProjectModelTransferRepository(sample.database, sample.session, { verifyRestoreBackup: service.verify, verifyRestoreCommit: service.verifyCommit });
      const readyState = await ready(repository, input); const committed = await repository.commitImport(input.operationId, readyState.sequence);
      expect(committed.next.project.epoch).toBeGreaterThan(capture.aggregate.project.epoch);
      expect((await all(sample.database, 'agentTasks'))[0]).toMatchObject({ id: 'paid', sequence: 12, toolCallCount: 7 });
      expect(storage.getItem()).toBe(pendingSource);
      port.backups.get(proof.backupOperationId)!.set('manifest.json', new TextEncoder().encode('{}'));
      await expect(service.verify(proof, capture)).rejects.toThrow();
    } finally { sample.database.close(); }
  });

  it('安全备份后审计或LS变化时拒绝恢复，不按旧副本覆盖较新的提交事实', async () => {
    const sample = await setup(), port = backupNative();
    try {
      const capture = (await sample.repository.capture('S'))!;
      const service = createProjectModelPreRestoreBackupService(sample.database, sample.session, { native: port.native, localStorage: storage });
      const proof = await service.create(capture, { operationId: 'pre-restore-audit' });
      await mutate(sample.database, ['agentTasks'], (tx) => tx.objectStore('agentTasks').put({ id: 'paid', projectId: 'S', sequence: 13, toolCallCount: 8 }));
      await expect(service.verify(proof, capture)).rejects.toThrow(/source[-_]changed/);
      expect((await all(sample.database, 'agentTasks'))[0]).toMatchObject({ sequence: 13, toolCallCount: 8 });
      let reads = 0;
      const changing = createProjectModelPreRestoreBackupService(sample.database, sample.session, { native: port.native,
        localStorage: { getItem: () => ++reads === 1 ? pendingSource : '[]' } });
      await expect(changing.create(capture, { operationId: 'changed-pending' })).rejects.toThrow('source-changed');
      expect(port.backups.has('changed-pending')).toBe(false);
    } finally { sample.database.close(); }
  });

  it('提交恢复再核sealed备份，等待中的预算/回执和LS前进保持当前值', async () => {
    const sample = await setup(), port = backupNative();
    try {
      const capture = (await sample.repository.capture('S'))!;
      let pending = pendingSource;
      const backup = createProjectModelPreRestoreBackupService(sample.database, sample.session, { native: port.native, localStorage: { getItem: () => pending } });
      const proof = await backup.create(capture, { operationId: 'before-waiting-restore' });
      const repository = createProjectModelTransferRepository(sample.database, sample.session, { verifyRestoreBackup: backup.verify, verifyRestoreCommit: backup.verifyCommit });
      const input: ProjectModelTransferImportInput = { ...update(capture, 'waiting-restore'), mode: 'restore-content', restoreProof: proof };
      const mediaReady = await ready(repository, input);
      await mutate(sample.database, ['agentTasks', 'metadata'], (tx) => {
        tx.objectStore('agentTasks').put({ id: 'paid', projectId: 'S', sequence: 13, toolCallCount: 8 });
        tx.objectStore('metadata').put({ id: 'mcp-operation:paid', bindingId: 'permanent-original-key', sequence: 13 });
      });
      pending = '[{"taskId":"newer-receipt","submitted":true}]';
      const files = port.backups.get(proof.backupOperationId)!, originalManifest = files.get('manifest.json')!;
      files.set('manifest.json', new TextEncoder().encode('{}'));
      await expect(repository.commitImport(input.operationId, mediaReady.sequence)).rejects.toThrow();
      expect((await repository.capture('S'))!.sourceToken).toBe(capture.sourceToken);
      expect((await repository.readImport(input.operationId)).phase).toBe('media_ready');
      files.set('manifest.json', originalManifest);
      const committed = await repository.commitImport(input.operationId, mediaReady.sequence);
      expect(committed.phase).toBe('db_committed');
      expect((await all(sample.database, 'agentTasks'))[0]).toMatchObject({ sequence: 13, toolCallCount: 8 });
      expect((await all(sample.database, 'metadata')).find((item) => item.id === 'mcp-operation:paid')).toMatchObject({ sequence: 13 });
      expect(pending).toBe('[{"taskId":"newer-receipt","submitted":true}]');
      files.set('manifest.json', new TextEncoder().encode('{}'));
      expect(await repository.commitImport(input.operationId, mediaReady.sequence)).toEqual(committed);
    } finally { sample.database.close(); }
  });

  it('显式恢复已删分集时推进到退役epoch之后，保留墓碑而不复活旧保存租约', async () => {
    const sample = await setup(), port = backupNative();
    try {
      const initial = (await sample.repository.capture('S'))!;
      await sample.business.convertStandaloneToSeries({ projectId: 'S', expectedProjectEpoch: initial.aggregate.project.epoch,
        episodeId: 'E1', name: '第一集' });
      const converted = (await sample.repository.capture('S'))!;
      await sample.business.createEpisode({ projectId: 'S', expectedProjectEpoch: converted.aggregate.project.epoch,
        episodeId: 'E2', canvasId: 'C2', name: '第二集' });
      const older = (await sample.repository.capture('S'))!;
      const episode = older.aggregate.episodes.find((item) => item.id === 'E2')!, canvas = older.aggregate.canvases.find((item) => item.id === 'C2')!;
      await sample.business.deleteEpisode({ projectId: 'S', expectedProjectEpoch: older.aggregate.project.epoch,
        episodeId: 'E2', expectedEpisodeRevision: episode.revision, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision });
      const current = (await sample.repository.capture('S'))!;
      const backup = createProjectModelPreRestoreBackupService(sample.database, sample.session, { native: port.native, localStorage: storage });
      const proof = await backup.create(current, { operationId: 'before-restore-deleted-episode' });
      const repository = createProjectModelTransferRepository(sample.database, sample.session, { verifyRestoreBackup: backup.verify, verifyRestoreCommit: backup.verifyCommit });
      const input: ProjectModelTransferImportInput = { ...update(current, 'restore-deleted-episode'), mode: 'restore-content',
        next: older.aggregate, idMap: idMap(older.aggregate), restoreProof: proof };
      const mediaReady = await ready(repository, input), committed = await repository.commitImport(input.operationId, mediaReady.sequence);
      expect(committed.next.episodes.find((item) => item.id === 'E2')?.epoch).toBeGreaterThan(episode.epoch + 1);
      expect(committed.next.canvases.find((item) => item.id === 'C2')?.epoch).toBeGreaterThan(canvas.epoch + 1);
      expect((await all(sample.database, 'metadata')).some((item) => item.kind === 'canvas' && item.targetId === 'C2')).toBe(true);
      expect((await all(sample.database, 'agentTasks'))[0]).toMatchObject({ sequence: 12, toolCallCount: 7 });
      await expect(sample.business.saveCanvas({ projectId: 'S', expectedProjectEpoch: older.aggregate.project.epoch,
        canvasId: 'C2', expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
        document: { nodes: [], edges: [], groups: [] } })).rejects.toThrow('project-version-conflict');
    } finally { sample.database.close(); }
  });
});
