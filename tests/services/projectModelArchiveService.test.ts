/** P5 编排回归源：真实 portable 投影/校验，仓储和文件发行只替换 I/O；尚未运行。 */
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectArchiveBusinessV4, ProjectArchivePayloadV4, ValidatedProjectArchiveV4 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferImportInput, ProjectModelTransferImportJournal, ProjectModelTransferExportJournal } from '../../src/types/projectModelTransfer';
import type { ProjectModelFixtureBusinessSession } from '../../src/types/projectModelBusiness';
import type { ProjectArchiveTextEntry } from '../../src/services/projectArchiveSerialization';
import type { createProjectModelTransferRepository } from '../../src/services/indexedDb/projectModelTransferRepository';
import { createProjectModelArchiveService, materializeProjectModelArchiveBusiness, prepareProjectModelArchiveCapture, importProjectModelArchiveHistory,
  type ProjectModelArchivePort } from '../../src/services/projectModelArchiveService';
import { buildProjectExchangeSnapshotV2, readProjectArchiveV4, serializeProjectArchiveV4 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import { readProjectArchiveContents } from '../../src/services/projectImportService';
import { readProjectModelArchive } from '../../src/services/projectModelArchiveService';
import { registerEpisodeEditorSession } from '../../src/services/episodeEditorSessionService';

const shared = vi.hoisted(() => ({ repository: null as unknown as ReturnType<typeof createProjectModelTransferRepository> }));
vi.mock('../../src/services/indexedDb/projectModelTransferRepository', () => ({ createProjectModelTransferRepository: () => shared.repository }));
vi.mock('../../src/services/fileService', () => ({ buildProjectFolderName: (_name: string, id: string) => `project-${id}` }));
vi.mock('../../src/services/projectImportService', () => ({ readProjectArchiveContents: vi.fn() }));
vi.mock('../../src/services/projectMergeWorkerClient', async () => {
  const { captureExchangeSnapshot } = await import('../../src/services/projectExchangeDomain');
  return { captureProjectSnapshot: vi.fn(async (...args: Parameters<typeof captureExchangeSnapshot>) => captureExchangeSnapshot(...args)) };
});
vi.mock('../../src/services/projectArchiveSerialization', () => ({ serializeProjectArchiveEntries: async (entries: Array<{ path: string; value: unknown }>) =>
  entries.map((entry) => ({ path: entry.path, content: JSON.stringify(entry.value) })) }));

const hash = 'a'.repeat(64);
const session = { operationId: 'fixture', sessionId: 'session', generation: 1 } as ProjectModelFixtureBusinessSession;
const textsOf = (entries: Array<{ path: string; content: string }>) => Object.fromEntries(entries.map((entry) => [entry.path, entry.content]));
async function archive(): Promise<ValidatedProjectArchiveV4> {
  const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '双根项目', kind: 'standalone', standaloneCanvasId: 'C',
    storageRoots: [{ id: 'shared', role: 'shared' }, { id: 'canvas-root', role: 'canvas' }] }, episodes: [],
    canvases: [{ id: 'C', projectId: 'P', episodeId: null, storageRootRef: 'canvas-root', revisionScope: 'global',
      nodes: [{ id: 'n', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', relativePath: 'same.png', prompt: 'same.png' } }], edges: [], groups: [] }],
    contents: { project: { projectId: 'P', data: { originalWork: { relativePath: 'same.png', fileName: 'same.png', addedAt: 1 }, script: 'same.png',
      storyGraph: { schemaVersion: 1, id: 'graph', nodes: [], edges: [], positions: {} } } }, episodes: [] } };
  const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [{ id: 'original-media-id', kind: 'image', extension: 'png', bytes: 3, sha256: hash }],
    [{ id: 'F1', rootRef: 'shared', relativePath: 'same.png', mediaId: 'original-media-id' },
      { id: 'F2', rootRef: 'canvas-root', relativePath: 'same.png', mediaId: 'original-media-id' }]);
  const head = await createProjectExchangeRevisionV2(snapshot);
  const payload: ProjectArchivePayloadV4 = { ...business, exchange: { format: 'ai-canvas-project-exchange', version: 2, packageId: 'package', lineageId: 'lineage',
    head: { canonicalVersion: 2, revisionId: head.revisionId }, revisions: [head], ancestors: [],
    files: [{ mediaId: 'original-media-id', archivePath: 'assets/original-payload.png' }] } };
  const assets = [{ path: 'original-payload.png', bytes: 3, sha256: hash }];
  return readProjectArchiveV4(textsOf(await serializeProjectArchiveV4(payload, { packageId: 'package', exportedAt: 1 }, assets)), assets);
}
function harness(initial: ProjectModelTransferCapture | null = null) {
  let capture = initial, exported: ValidatedProjectArchiveV4 | undefined;
  const imports = new Map<string, ProjectModelTransferImportJournal>(), exports = new Map<string, ProjectModelTransferExportJournal>();
  const port: ProjectModelArchivePort = {
    inspectAssets: vi.fn(async (value: ProjectModelTransferCapture) => value.exchange!.fileBindings.map((binding) => ({ rootRef: value.exchange!.identities.find((item) =>
      item.kind === 'storage-root' && item.sourceId === binding.rootRef)!.localId, path: binding.localRelativePath, bytes: 3, sha256: hash }))),
    captureImportSource: vi.fn(async (source: ValidatedProjectArchiveV4) => ({ sourceRef: 'unpacked/original/assets', sourceFiles: source.files.map((file) => ({
      id: file.id, rootRef: file.rootRef, relativePath: file.relativePath, archivePath: 'assets/original-payload.png', bytes: 3, sha256: hash,
    })) })),
    publishMedia: vi.fn(async (operation) => operation.operationId), verifyMediaPublication: vi.fn(async () => {}),
    pack: vi.fn(async (operation: ProjectModelTransferExportJournal, entries: ProjectArchiveTextEntry[]) => {
      exported = await readProjectArchiveV4(textsOf(entries), operation.exchange.bundle.files.map((file) => ({ path: file.archivePath.slice(7), bytes: 3, sha256: hash })));
      return { outputRef: 'opaque-publication', packageDigest: hash };
    }), verifyExportPublication: vi.fn(async () => {}), recoverExportPublication: vi.fn(async () => ({ outputRef: 'opaque-publication', packageDigest: hash })),
  };
  const repository = {
    capture: vi.fn(async () => capture), findImport: vi.fn(async (id: string) => imports.get(id) ?? null),
    readImport: vi.fn(async (id: string) => { const journal = imports.get(id); if (!journal) throw new Error('missing'); return journal; }),
    prepareImport: vi.fn(async (input: ProjectModelTransferImportInput) => {
      const journal = { ...input, id: input.operationId, schemaVersion: 1 as const, kind: 'project-model-import' as const, phase: 'prepared' as const, sequence: 0,
        generation: 1, sessionId: 'session', createdAt: 1, updatedAt: 1, cleanup: 'retain-until-unreferenced' as const };
      imports.set(input.operationId, journal); return journal;
    }),
    advanceImport: vi.fn(async (id: string, _sequence: number, phase: ProjectModelTransferImportJournal['phase'], fields: object = {}) => {
      const journal = { ...imports.get(id)!, ...fields, phase, sequence: imports.get(id)!.sequence + 1 }; imports.set(id, journal); return journal;
    }),
    commitImport: vi.fn(async (id: string) => {
      const journal = { ...imports.get(id)!, phase: 'db_committed' as const }; imports.set(id, journal);
      capture = { schemaVersion: 1, generation: 1, sessionId: 'session', sessionRevision: 1, sourceToken: `committed-${id}`, includesHistory: true,
        aggregate: journal.next, exchange: journal.exchange, history: [], historyBindings: [] }; return journal;
    }),
    prepareExport: vi.fn(async (input: { operationId: string; capture: ProjectModelTransferCapture; exchange: ProjectModelTransferExportJournal['exchange'] }) => {
      const journal: ProjectModelTransferExportJournal = { id: input.operationId, schemaVersion: 1, kind: 'project-model-export', operationId: input.operationId,
        generation: 1, sessionId: 'session', targetProjectId: input.capture.aggregate.project.id, expectedToken: input.capture.sourceToken,
        expectedExchange: input.capture.exchange, includesHistory: true,
        head: input.exchange.localHead, exchange: input.exchange, phase: 'prepared', sequence: 0, createdAt: 1, updatedAt: 1 };
      exports.set(input.operationId, journal); return journal;
    }),
    advanceExport: vi.fn(async (id: string, _sequence: number, phase: ProjectModelTransferExportJournal['phase'], fields: object = {}) => {
      const journal = { ...exports.get(id)!, ...fields, phase, sequence: exports.get(id)!.sequence + 1 }; exports.set(id, journal);
      if (phase === 'registered') capture = { ...capture!, exchange: journal.exchange, sourceToken: `exported-${id}` }; return journal;
    }),
  };
  shared.repository = repository as unknown as ReturnType<typeof createProjectModelTransferRepository>;
  const service = createProjectModelArchiveService({} as IDBDatabase, session, port);
  return { service, repository, port, imports, get capture() { return capture; }, get exported() { return exported; } };
}

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); });
describe('P5 portable/本机双向编排', () => {
  it('filePath-only 的 macOS Unicode 路径只按本轮原生同根别名映射，不改写源记录', async () => {
    const source = await archive(), sample = harness();
    await sample.service.apply(await sample.service.preview(source), { operationId: 'unicode-seed', mode: 'import-new' });
    const capture = sample.capture!, canvas = capture.aggregate.canvases[0], assets = await sample.port.inspectAssets(capture);
    const actual = 'media/cafe\u0301.png', alias = 'media/caf\u00e9.png', root = '/Users/private/项目素材/作品';
    capture.exchange = null;
    const node = canvas.nodes[0] as { data: Record<string, unknown> };
    delete node.data.relativePath; node.data.filePath = `${root}/${alias}`;
    const original = structuredClone(capture);
    const prepared = await prepareProjectModelArchiveCapture(capture, assets.map((asset) => asset.rootRef === canvas.storageRootRef
      ? { ...asset, path: actual, aliases: [alias], localAbsolutePath: `${root}/${actual}` } : asset));
    expect(prepared.payload.canvases[0].nodes[0]).toMatchObject({ data: { relativePath: actual } });
    expect(JSON.stringify(prepared.payload)).not.toContain('/Users/private');
    expect(capture).toEqual(original);
  });

  it('其他素材根提供同名或相同字节别名不能证明当前画布的本机路径', async () => {
    const source = await archive(), sample = harness();
    await sample.service.apply(await sample.service.preview(source), { operationId: 'wrong-root-seed', mode: 'import-new' });
    const capture = sample.capture!, canvas = capture.aggregate.canvases[0], assets = await sample.port.inspectAssets(capture);
    const actual = 'media/cafe\u0301.png', alias = 'media/caf\u00e9.png', root = '/Users/private/项目素材/作品';
    capture.exchange = null;
    const node = canvas.nodes[0] as { data: Record<string, unknown> };
    delete node.data.relativePath; node.data.filePath = `${root}/${alias}`;
    const other = assets.find((asset) => asset.rootRef !== canvas.storageRootRef)!;
    await expect(prepareProjectModelArchiveCapture(capture, [...assets,
      { ...other, path: actual, aliases: [alias], localAbsolutePath: `${root}/${actual}` }]))
      .rejects.toThrow('未证明来源');
  });

  it('新项目输出历史经归档映射原画布、旧节点与素材根，导入保持快照且重复更新只绑定既有记录', async () => {
    const source = await archive(), sample = harness();
    await sample.service.apply(await sample.service.preview(source), { operationId: 'output-seed', mode: 'import-new' });
    const capture = sample.capture!, canvas = capture.aggregate.canvases[0];
    const binding = capture.exchange!.fileBindings.find((item) => item.id === 'F2')!;
    const root = capture.exchange!.identities.find((item) => item.kind === 'storage-root' && item.sourceId === binding.rootRef)!.localId;
    capture.history = [{ kind: 'output', sourceNamespace: 'native:test', archiveOriginId: '', value: {
      id: 'original-history', projectId: canvas.id, nodeId: 'deleted-node', nodeType: 'ai-image', nodeLabel: '原图', timestamp: 1,
      prompt: '生成当时的提示词', output: 'asset://original', mediaUrl: 'asset://original', filePath: '/isolated/private.png',
      relativePath: binding.localRelativePath, storageRootRef: root, model: 'general/original', provider: 'fixture', status: 'success',
      recoveryTask: { taskId: 'never-execute' }, params: { aspectRatio: '1:1', originalInputUnavailable: true } } }];
    await sample.service.exportProject(capture.aggregate.project.id, 'output-export');
    const archived = sample.exported!, output = archived.payload.history!.payload.outputs![0];
    expect(output).toMatchObject({ nodeId: 'deleted-node', prompt: '生成当时的提示词', fileId: 'F2', output: '' });
    expect(archived.payload.history!.scopes).toContainEqual({ kind: 'output', id: output.id, canvasId: 'C' });
    expect(JSON.stringify(output)).not.toContain('asset:'); expect(output).not.toHaveProperty('recoveryTask');
    expect(output).not.toHaveProperty('filePath');
    const wrongType = structuredClone(archived.payload);
    wrongType.history!.payload.outputs![0].nodeType = 'ai-audio';
    await expect(serializeProjectArchiveV4(wrongType, archived.manifest, archived.assets)).rejects.toThrow('媒体类型');
    const mappings = [{ kind: 'canvas' as const, sourceId: 'C', localId: 'new-canvas' },
      { kind: 'storage-root' as const, sourceId: 'canvas-root', localId: 'new-root' }];
    const imported = await importProjectModelArchiveHistory(archived, 'new-project', 'lineage', null,
      { appendChat: false, appendMemories: false }, { identities: mappings, episodes: [], fileBindings: [{ ...binding, localRelativePath: 'imports/new/result.png' }] });
    expect(imported).toHaveLength(1);
    expect(imported[0].value).toMatchObject({ projectId: 'new-canvas', nodeId: 'deleted-node', prompt: output.prompt,
      relativePath: 'imports/new/result.png', storageRootRef: 'new-root', mediaUrl: 'imports/new/result.png' });
    const again = await importProjectModelArchiveHistory(archived, 'new-project', 'lineage', { ...capture, history: imported },
      { appendChat: false, appendMemories: false }, { identities: mappings, episodes: [], fileBindings: [{ ...binding, localRelativePath: 'imports/new/result.png' }] });
    expect(again[0].existingLocalId).toBe(imported[0].value.id);
  });

  it('新副本保留会话的画布归属和已删除工作台的只读来源', async () => {
    const source = await archive();
    source.payload.history = { payload: { conversations: [{ id: 'conversation', projectId: 'P', title: '旧工作台', titleSource: 'user',
      pinned: false, archived: false, agentMode: 'plan', messageCount: 1, createdAt: 1, updatedAt: 1 }],
      messages: [{ id: 'message', projectId: 'P', conversationId: 'conversation', sequence: 1,
        role: 'user', content: '正文', status: 'done', createdAt: 1, updatedAt: 1 }], memories: [] },
      workbenchTargets: [{ conversationId: 'conversation', target: { state: 'retired', kind: 'episode', projectId: 'P', id: 'old-episode' } }],
      scopes: [{ kind: 'conversation', id: 'conversation', canvasId: 'C' }] };
    const rows = await importProjectModelArchiveHistory(source, 'new-project', 'lineage', null,
      { appendChat: true, appendMemories: false }, { identities: [{ kind: 'canvas', sourceId: 'C', localId: 'new-canvas' }], episodes: [] });
    const conversation = rows.find((row) => row.kind === 'conversation')!, message = rows.find((row) => row.kind === 'message')!;
    expect(conversation.value).toMatchObject({ projectId: 'new-canvas', archiveHistoricalTarget: { state: 'retired', id: 'old-episode' } });
    expect(conversation.value.workbenchTarget).toBeUndefined();
    expect(message.value).toMatchObject({ projectId: 'new-canvas', conversationId: conversation.value.id });
  });
  it('新结构导入保留双根同名素材的逻辑身份和独立落盘路径，导出复用原协作身份', async () => {
    let source = await archive();
    const other = { ...source.snapshot.media[0], id: 'other-media', sha256: 'b'.repeat(64) };
    const snapshot = buildProjectExchangeSnapshotV2(source.payload, source.snapshot.lineageId, [...source.snapshot.media, other],
      source.files.map((file) => file.rootRef === 'canvas-root' ? { ...file, mediaId: other.id } : file));
    const head = await createProjectExchangeRevisionV2(snapshot);
    const exchange = { ...source.payload.exchange, head: { canonicalVersion: 2 as const, revisionId: head.revisionId }, revisions: [head],
      files: [{ mediaId: 'original-media-id', archivePath: 'assets/original-payload.png' },
        { mediaId: other.id, archivePath: 'assets/other-payload.png' }] };
    const payload = { ...source.payload, exchange };
    const archivedAssets = [{ path: 'original-payload.png', bytes: 3, sha256: hash }, { path: 'other-payload.png', bytes: 3, sha256: other.sha256 }];
    source = await readProjectArchiveV4(textsOf(await serializeProjectArchiveV4(payload, { packageId: exchange.packageId, exportedAt: 1 }, archivedAssets)), archivedAssets);
    const projectId = 'p2-00000000-0000-4000-8000-000000000001';
    let nextId = 1;
    const allocated = (kind: 'episode' | 'canvas' | 'storage-root') => {
      const prefix = kind === 'episode' ? 'e2' : kind === 'canvas' ? 'c2' : 'r2';
      return `${prefix}-00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
    };
    const material = await materializeProjectModelArchiveBusiness(source.payload, source.snapshot, null, projectId, 'native-import', undefined,
      { allocateId: allocated, folderName: `project-${projectId}` });
    const roots = material.identities.filter((item) => item.kind === 'storage-root');
    expect(roots).toHaveLength(2);
    expect(new Set(roots.map((item) => item.localId)).size).toBe(2);
    expect(material.fileBindings.map((item) => item.relativePath)).toEqual(['same.png', 'same.png']);
    expect(new Set(material.fileBindings.map((item) => item.localRelativePath)).size).toBe(2);
    expect(material.aggregate.project.storageBindings.every((binding) => binding.folderName === `project-${projectId}`
      || binding.folderName.startsWith(`project-${projectId}/roots/`))).toBe(true);
    const savedExchange = { lineageId: source.snapshot.lineageId, localHead: source.payload.exchange.head, stateVersion: 1,
      bundle: source.payload.exchange, identities: material.identities, fileBindings: material.fileBindings, published: [] };
    const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'native-capture', sessionRevision: 0,
      sourceToken: 'snapshot', aggregate: material.aggregate, exchange: savedExchange, history: [], historyBindings: [], includesHistory: false };
    const projection = await prepareProjectModelArchiveCapture(capture, material.media.map((item) => ({ ...item, path: item.relativePath })));
    expect(projection.snapshot.entities).toEqual(source.snapshot.entities);
    expect(projection.snapshot.media).toEqual(source.snapshot.media);
    expect(projection.exchange.identities).toEqual(material.identities);
  });

  it('新结构归档草案拒绝不受控目标、重复本机身份与非法操作名', async () => {
    const source = await archive(), projectId = 'p2-00000000-0000-4000-8000-000000000001';
    const allocateId = (kind: 'episode' | 'canvas' | 'storage-root') => `${kind === 'storage-root' ? 'r2' : kind === 'canvas' ? 'c2' : 'e2'}-00000000-0000-4000-8000-000000000002`;
    await expect(materializeProjectModelArchiveBusiness(source.payload, source.snapshot, null, projectId, '../unsafe', undefined,
      { allocateId, folderName: `project-${projectId}` })).rejects.toThrow('操作身份无效');
    await expect(materializeProjectModelArchiveBusiness(source.payload, source.snapshot, null, projectId, 'import', undefined,
      { allocateId, folderName: 'other-project' })).rejects.toThrow('目标身份或目录无效');
    await expect(materializeProjectModelArchiveBusiness(source.payload, source.snapshot, null, projectId, 'import', undefined,
      { allocateId, folderName: `project-${projectId}` })).rejects.toThrow('本机身份冲突');
  });

  it('新导入再导出保来源project/canvas/file/media身份、canonical路径和storyGraph语义', async () => {
    const source = await archive(), sample = harness(), preview = await sample.service.preview(source);
    const operation = await sample.service.apply(preview, { operationId: 'first-import', mode: 'import-new' });
    expect(operation.next.project.id).not.toBe('P');
    expect(operation.exchange!.fileBindings.map((item) => item.id)).toEqual(['F1', 'F2']);
    expect(operation.exchange!.fileBindings.every((item) => item.localRelativePath.startsWith('imports/first-import-root-'))).toBe(true);
    expect(operation.next.content.script).toBe('same.png');
    expect(operation.next.content.storyGraph?.revision).toBe(0);
    expect(operation.next.project.storageBindings[0].folderName).toBe(operation.next.project.dataFolder);
    await sample.service.exportProject(operation.targetProjectId, 'first-export');
    const head = sample.exported!.payload.exchange.revisions.find((item) => item.revisionId === sample.exported!.payload.exchange.head.revisionId)!;
    const importedHead = operation.exchange!.bundle.revisions.find((item) => item.revisionId === operation.exchange!.localHead.revisionId)!;
    expect(head.contentDigest).toBe(importedHead.contentDigest);
    expect(sample.exported!.files).toEqual(source.files);
    expect(sample.exported!.snapshot.media).toEqual(source.snapshot.media);
    expect(JSON.stringify(sample.exported!.payload)).not.toContain('first-import');
  });
  it('同名异根更新保全部本机绑定和旧物理文件；已提交operation重放没有二次来源捕获/分配/发布', async () => {
    const source = await archive(), sample = harness();
    const first = await sample.service.apply(await sample.service.preview(source), { operationId: 'seed', mode: 'import-new' });
    const bindings = structuredClone(first.next.project.storageBindings), fileBindings = structuredClone(first.exchange!.fileBindings);
    const preview = await sample.service.preview(source, first.targetProjectId);
    const updated = await sample.service.apply(preview, { operationId: 'update', mode: 'update-existing' });
    expect(updated.next.project.storageBindings).toEqual(bindings);
    expect(updated.next.project.dataFolder).toBe(first.next.project.dataFolder);
    expect(updated.next.project.storageRootRef).toBe(first.next.project.storageRootRef);
    expect(updated.exchange!.fileBindings).toEqual(fileBindings);
    expect(updated.media).toEqual([]);
    const prepares = sample.repository.prepareImport.mock.calls.length, publishes = vi.mocked(sample.port.publishMedia).mock.calls.length;
    expect(await sample.service.apply(preview, { operationId: 'update', mode: 'update-existing' })).toEqual(updated);
    expect(sample.repository.prepareImport).toHaveBeenCalledTimes(prepares);
    expect(sample.port.publishMedia).toHaveBeenCalledTimes(publishes);
  });
  it('未提交的重启重投只复用首次journal.next/idMap/source映射，不重做随机分配', async () => {
    const source = await archive(), sample = harness(), preview = await sample.service.preview(source);
    vi.mocked(sample.port.publishMedia).mockRejectedValueOnce(new Error('response lost'));
    await expect(sample.service.apply(preview, { operationId: 'resume', mode: 'import-new' })).rejects.toThrow('response lost');
    const frozen = structuredClone(sample.imports.get('resume')!);
    const result = await sample.service.resumeImport('resume');
    expect(result.next).toEqual(frozen.next); expect(result.idMap).toEqual(frozen.idMap); expect(result.sourceFiles).toEqual(frozen.sourceFiles);
    expect(sample.repository.prepareImport).toHaveBeenCalledTimes(1);
    expect(sample.port.captureImportSource).toHaveBeenCalledTimes(1);
  });
  it('首次P3导出先把冒号root/项目/画布ID映射为稳定safe portable身份', async () => {
    const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'session', sessionRevision: 1, sourceToken: 'legacy',
      includesHistory: true, exchange: null, history: [], historyBindings: [], aggregate: {
        project: { id: 'local:project', name: '旧定位', kind: 'standalone', epoch: 0, createdAt: 1, updatedAt: 1, dataFolder: 'legacy-folder',
          storageRootRef: 'legacy-root:uuid', storageBindings: [{ rootRef: 'legacy-root:uuid', folderName: 'legacy-folder', source: 'legacy-folder-rule', sourceRecordIds: ['local:project'] }] },
        content: { projectId: 'local:project', revisions: { source: 1, script: 9, storyGraph: 0, assets: 0 } }, episodes: [], episodeContents: [],
        canvases: [{ id: 'local:canvas', projectId: 'local:project', episodeId: null, storageRootRef: 'legacy-root:uuid', revisionScope: 'project', epoch: 2, revision: 13,
          nodes: [], edges: [], groups: [] }], previews: [], bindings: [],
      } };
    const sample = harness(capture); vi.mocked(sample.port.inspectAssets).mockResolvedValue([]);
    await sample.service.exportProject(capture.aggregate.project.id, 'legacy-export');
    const identities = sample.repository.prepareExport.mock.calls[0][0].exchange.identities;
    expect(identities.every((item) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.sourceId))).toBe(true);
    expect(identities.find((item) => item.kind === 'storage-root')!.localId).toBe('legacy-root:uuid');
    expect(JSON.stringify(sample.exported!.payload)).not.toContain('local:');
  });
  it('已登记的脏稿阻止导出，锁覆盖owner和全部child直到打包完成', async () => {
    const source = await archive(), sample = harness();
    const operation = await sample.service.apply(await sample.service.preview(source), { operationId: 'dirty-seed', mode: 'import-new' });
    let dirty = true;
    const release = registerEpisodeEditorSession(operation.targetProjectId, () => ({ dirty, saving: false }));
    try {
      await expect(sample.service.exportProject(operation.targetProjectId, 'dirty-export')).rejects.toThrow('未保存');
      expect(sample.repository.prepareExport).not.toHaveBeenCalled(); expect(sample.port.pack).not.toHaveBeenCalled();
    } finally { dirty = false; release(); }
  });
  it('已导入会话的目标删除后转retired并读回，不能用旧binding重建活动分集', async () => {
    const source = await archive(), sample = harness();
    const operation = await sample.service.apply(await sample.service.preview(source), { operationId: 'history-seed', mode: 'import-new' });
    const capture = sample.capture!;
    capture.aggregate.project.kind = 'series'; capture.aggregate.canvases = [];
    capture.exchange!.identities.push({ kind: 'episode', sourceId: 'deleted-episode', localId: 'deleted-local' });
    capture.history.push({ kind: 'conversation', sourceNamespace: 'lineage', archiveOriginId: 'b'.repeat(64),
      historicalTarget: { state: 'active', kind: 'episode', projectId: 'P', episodeId: 'deleted-episode' },
      value: { id: 'history', projectId: operation.targetProjectId, title: '旧工作台', titleSource: 'user', agentMode: 'plan',
        archived: true, pinned: false, messageCount: 0, createdAt: 1, updatedAt: 1 } });
    await sample.service.exportProject(operation.targetProjectId, 'history-export');
    const target = sample.exported!.payload.history!.workbenchTargets[0].target;
    expect(target).toEqual({ state: 'retired', kind: 'episode', projectId: 'P', id: 'deleted-episode' });
    expect(sample.exported!.snapshot.historicalTargets).toContainEqual(target);
    expect(sample.exported!.payload.episodes).toEqual([]);
  });
  it.each([1, 2])('无来源证明的v%s包重复读取产生相同lineage、文件身份、包映射和历史origin', async (formatVersion) => {
    const record = { id: 'legacy-project', name: '旧项目', createdAt: 1, updatedAt: 2, nodes: [{ id: 'n', type: 'source-image',
      position: { x: 0, y: 0 }, data: { type: 'source-image', relativePath: 'same.png' } }], edges: [], groups: [] };
    const manifest = { formatVersion, projectId: record.id, projectName: record.name, exportedAt: 1 };
    const conversation = { id: 'legacy-chat', projectId: record.id, title: '旧对话', titleSource: 'user' as const, archived: false, pinned: false,
      agentMode: 'plan' as const, messageCount: 0, createdAt: 1, updatedAt: 1 };
    vi.mocked(readProjectArchiveContents).mockResolvedValue({ manifest, records: [record], chat: [{ conversations: [conversation], messages: [], memories: [] }],
      assets: [{ path: 'same.png', bytes: 3, sha256: hash }], bundle: null, sourceState: null } as Awaited<ReturnType<typeof readProjectArchiveContents>>);
    const texts = { 'manifest.json': JSON.stringify(manifest), 'project.json': JSON.stringify(record) }, assets = [{ path: 'same.png', bytes: 3, sha256: hash }];
    const first = await readProjectModelArchive(texts, assets), second = await readProjectModelArchive(texts, assets);
    expect(second).toEqual(first);
    expect(first.snapshot.lineageId).toMatch(/^legacy_[a-f0-9]{64}$/);
    expect(first.payload.exchange.revisions).toHaveLength(1);
    expect(first.payload.history!.payload.conversations[0].archiveOriginId).toMatch(/^[a-f0-9]{64}$/);
    const changed = await readProjectModelArchive({ ...texts, 'project.json': JSON.stringify({ ...record, name: '另一个旧包' }) }, assets);
    expect(changed.snapshot.lineageId).not.toBe(first.snapshot.lineageId);
  });
});
