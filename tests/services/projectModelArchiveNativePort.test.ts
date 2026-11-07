/** P5 原生 IPC 适配回归源；不触碰真实文件或原生服务，尚未运行。 */
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeProjectModelArchivePort } from '../../src/services/projectModelArchiveNativePort';
import { buildProjectExchangeSnapshotV2 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import type { ProjectArchiveBusinessV4, ValidatedProjectArchiveV4 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange, ProjectModelTransferImportJournal, ProjectModelTransferExportJournal } from '../../src/types/projectModelTransfer';
import type { ProjectModelFixtureBusinessSession } from '../../src/types/projectModelBusiness';

const native = vi.hoisted(() => ({ invoke: vi.fn(), existing: new Set<string>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async (path: string) => native.existing.has(path) }));
vi.mock('../../src/services/fileService', () => ({ projectArchiveFixtureDirectory: async (_db: string, relative: string) => `fixture/${relative}` }));
vi.mock('../../src/services/fs/projectArchiveFixtureFiles', () => ({ createProjectArchiveFixturePreviewDirectory: vi.fn() }));
vi.mock('../../src/services/projectModelPreRestoreBackup', () => ({ createProjectModelPreRestoreBackupService: () => ({ create: vi.fn(), verify: vi.fn(), verifyCommit: vi.fn() }) }));

const hash = 'a'.repeat(64), database = { name: 'ai-canvas-model-fixture-transfer' } as IDBDatabase;
const session = { operationId: 'migration', generation: 1, sessionId: 'session' } as ProjectModelFixtureBusinessSession;
async function setup() {
  const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '双根', kind: 'series', storageRoots: [
    { id: 'A', role: 'shared' }, { id: 'B', role: 'canvas' },
  ] }, episodes: [], canvases: [], contents: { project: { projectId: 'P', data: {} }, episodes: [] } };
  const files = [{ id: 'F1', rootRef: 'A', relativePath: 'same.png', mediaId: 'media-original' },
    { id: 'F2', rootRef: 'B', relativePath: 'same.png', mediaId: 'media-original' }];
  const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [{ id: 'media-original', kind: 'image', extension: 'png', bytes: 3, sha256: hash }], files);
  const revision = await createProjectExchangeRevisionV2(snapshot);
  const exchange: ProjectModelTransferExchange = { lineageId: 'lineage', localHead: { canonicalVersion: 2, revisionId: revision.revisionId }, stateVersion: 1,
    identities: [{ kind: 'project', sourceId: 'P', localId: 'local-project' },
      { kind: 'storage-root', sourceId: 'A', localId: 'legacy-root:A' }, { kind: 'storage-root', sourceId: 'B', localId: 'legacy-root:B' }],
    fileBindings: files.map((file, index) => ({ id: file.id, rootRef: file.rootRef, relativePath: file.relativePath,
      localRelativePath: `imports/import-op-root-${index}/same.png` })), published: [],
    bundle: { format: 'ai-canvas-project-exchange', version: 2, packageId: 'package', lineageId: 'lineage', head: { canonicalVersion: 2, revisionId: revision.revisionId },
      revisions: [revision], ancestors: [], files: [{ mediaId: 'media-original', archivePath: 'assets/original-payload.png' }] } };
  const source = { payload: { ...business, exchange: exchange.bundle }, snapshot, files,
    assets: [{ path: 'original-payload.png', bytes: 3, sha256: hash }] } as unknown as ValidatedProjectArchiveV4;
  const operation: ProjectModelTransferImportJournal = { id: 'import-op', schemaVersion: 1, kind: 'project-model-import', operationId: 'import-op', generation: 1,
    sessionId: 'session', phase: 'media_publishing', sequence: 1, createdAt: 1, updatedAt: 1, cleanup: 'retain-until-unreferenced', mode: 'import-new',
    packageDigest: hash, intentDigest: hash, targetProjectId: 'local-project', expected: null, exchange, idMap: exchange.identities, history: [],
    sourceRef: 'unpacked/original/assets', sourceFiles: files.map((file) => ({ id: file.id, rootRef: file.rootRef, relativePath: file.relativePath,
      archivePath: 'assets/original-payload.png', bytes: 3, sha256: hash })),
    media: exchange.fileBindings.map((file) => ({ rootRef: exchange.identities.find((item) => item.kind === 'storage-root' && item.sourceId === file.rootRef)!.localId,
      relativePath: file.localRelativePath, bytes: 3, sha256: hash })),
    next: { project: { id: 'local-project', name: '双根', kind: 'series', createdAt: 1, updatedAt: 1, epoch: 0, dataFolder: 'primary', storageRootRef: 'legacy-root:A',
      storageBindings: [{ rootRef: 'legacy-root:A', folderName: 'primary', sourceRecordIds: [], source: 'project-managed' },
        { rootRef: 'legacy-root:B', folderName: 'secondary', sourceRecordIds: [], source: 'project-managed' }] },
    content: { projectId: 'local-project', revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } }, episodes: [], episodeContents: [], canvases: [], previews: [], bindings: [] },
  };
  const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'session', sessionRevision: 1, sourceToken: 'token', includesHistory: true,
    aggregate: operation.next, exchange, historyBindings: [], history: [] };
  return { exchange, source, operation, capture, files };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); native.existing.clear();
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'inspect_project_archive_assets') return (args.selectedPaths as string[]).map((path) => ({ path, bytes: 3, sha256: hash }));
    if (command === 'publish_project_import_assets') { native.existing.add(`${args.projectDir}/imports/${args.operationId}`); return; }
    if (command === 'pack_project_archive') return { operationId: args.operationId, publicationRef: 'opaque-ref', archiveSha256: hash };
    throw new Error('unexpected command');
  });
});
describe('P5 native file projection', () => {
  it('capture冻结原物理包映射；重启忽略新incomingFolder，逐root核原child后只补未发布root', async () => {
    const { operation, source } = await setup();
    const original = createNativeProjectModelArchivePort(database, session, { incomingFolder: 'unpacked/original/assets' });
    expect(await original.captureImportSource!(source)).toEqual({ sourceRef: operation.sourceRef, sourceFiles: operation.sourceFiles });
    const firstImplementation = native.invoke.getMockImplementation()!;
    let lost = false;
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      const result = await firstImplementation(command, args);
      if (command === 'publish_project_import_assets' && !lost) { lost = true; throw new Error('lost response'); } return result;
    });
    await expect(original.publishMedia(operation, source)).rejects.toThrow('lost response');
    const restarted = createNativeProjectModelArchivePort(database, session, { incomingFolder: 'unpacked/replacement/assets' });
    expect(await restarted.publishMedia(operation, source)).toBe(`media_v1_${operation.operationId}`);
    const calls = native.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets');
    expect(calls.map(([, args]) => args.operationId)).toEqual(['import-op-root-0', 'import-op-root-1']);
    expect(calls.map(([, args]) => args.projectDir)).toEqual(['fixture/primary', 'fixture/secondary']);
    expect(calls.every(([, args]) => args.sourceRoots[0].directory === 'fixture/unpacked/original/assets')).toBe(true);
    expect(calls.every(([, args]) => args.assets[0].path === 'original-payload.png' && args.assets[0].destinationPath === 'same.png')).toBe(true);
    await restarted.verifyMediaPublication(operation, `media_v1_${operation.operationId}`);
    await expect(restarted.verifyMediaPublication(operation, 'another-op')).rejects.toThrow('回执');
  });
  it('inspect只包含当前bindings的imports，保普通附件并排除嵌套root重复扫描', async () => {
    const { capture } = await setup();
    capture.aggregate.project.storageBindings[1].folderName = 'primary/roots/secondary';
    capture.aggregate.content.originalWork = { relativePath: 'imports/new-output/generated.png' } as NonNullable<typeof capture.aggregate.content.originalWork>;
    capture.exchange!.fileBindings.push({ id: 'stale-file', rootRef: 'A', relativePath: 'orphan.png', localRelativePath: 'imports/failed/orphan.png' });
    native.existing.add('fixture/primary'); native.existing.add('fixture/primary/roots/secondary');
    native.invoke.mockImplementation(async (_command: string, args: Record<string, unknown>) => args.assetsDir === 'fixture/primary'
      ? [{ path: 'attachment.txt', bytes: 3, sha256: hash }, { path: 'roots/secondary/same.png', bytes: 3, sha256: hash }]
      : [{ path: 'imports/import-op-root-1/same.png', bytes: 3, sha256: hash }]);
    const result = await createNativeProjectModelArchivePort(database, session).inspectAssets(capture);
    expect(result.map((item) => [item.rootRef, item.path])).toEqual([
      ['legacy-root:A', 'attachment.txt'], ['legacy-root:B', 'imports/import-op-root-1/same.png'],
    ]);
    const calls = native.invoke.mock.calls.map(([, args]) => args);
    expect(calls.map((args) => args.includeImportPaths)).toEqual([
      ['imports/import-op-root-0/same.png', 'imports/new-output/generated.png'], ['imports/import-op-root-1/same.png'],
    ]);
  });
  it('pack仅在当前IPC传目录和source路径，portable正文与物理包path保持分离且保任意原mediaId', async () => {
    const { exchange, capture, files } = await setup();
    const operation = { operationId: 'export-op', exchange } as ProjectModelTransferExportJournal;
    const entries = [{ path: 'manifest.json', content: '{"formatVersion":4}' }];
    const assets = exchange.fileBindings.map((binding) => ({ rootRef: exchange.identities.find((item) => item.kind === 'storage-root' && item.sourceId === binding.rootRef)!.localId,
      path: binding.localRelativePath, bytes: 3, sha256: hash }));
    const receipt = await createNativeProjectModelArchivePort(database, session, { outputPath: 'chosen-output.aicanvas' }).pack(operation, entries, capture, files, assets);
    expect(receipt).toEqual({ outputRef: 'opaque-ref', packageDigest: hash });
    const args = native.invoke.mock.calls.find(([command]) => command === 'pack_project_archive')![1];
    expect(args.expectedAssets).toEqual([{ path: 'original-payload.png', bytes: 3, sha256: hash,
      sourceRootRef: 'root-0', sourceRelativePath: 'imports/import-op-root-0/same.png' }]);
    expect(args.sourceRoots.map((item: { rootRef: string }) => item.rootRef)).toEqual(['root-0', 'root-1']);
    expect(JSON.stringify(args.entries)).not.toMatch(/fixture\/|sourceRootRef|sourceRelativePath|import-op/);
    expect(JSON.stringify(operation)).not.toContain('chosen-output.aicanvas');
  });
  it('三类旧本机文件字段及截图数组只纳入所属受权root内的imports引用', async () => {
    const { capture } = await setup(); native.existing.add('fixture/primary'); native.existing.add('fixture/secondary');
    capture.aggregate.canvases.push({ id: 'C', projectId: 'local-project', episodeId: null, storageRootRef: 'legacy-root:A', revisionScope: 'project', epoch: 0, revision: 0,
      nodes: [{ id: 'n', data: { filePath: 'fixture/primary/imports/file.png', imageFilePath: 'fixture/primary/imports/image.png',
        directorCaptureFilePaths: ['fixture/primary/imports/frame.png', 'fixture/secondary/imports/wrong-root.png', 'fixture/primary-escape/imports/outside.png'],
        prompt: 'fixture/primary/imports/prompt-only.png' } }], edges: [], groups: [] });
    native.invoke.mockImplementation(async (_command: string, args: Record<string, unknown>) =>
      (args.includeImportPaths as string[]).map((path) => ({ path, bytes: 3, sha256: hash })));
    await createNativeProjectModelArchivePort(database, session).inspectAssets(capture);
    const calls = native.invoke.mock.calls.map(([, args]) => args);
    expect(calls[0].includeImportPaths).toEqual(['imports/import-op-root-0/same.png', 'imports/file.png', 'imports/image.png', 'imports/frame.png']);
    expect(calls[1].includeImportPaths).toEqual(['imports/import-op-root-1/same.png']);
    expect(JSON.stringify(calls.map((args) => args.includeImportPaths))).not.toMatch(/wrong-root|outside|prompt-only/);
  });
  it('耐久备份前拒绝预览后媒体变化，也拒绝未出现在扫描结果的完整typed引用', async () => {
    const { capture } = await setup(); native.existing.add('fixture/primary'); native.existing.add('fixture/secondary');
    native.invoke.mockImplementation(async (_command: string, args: Record<string, unknown>) =>
      ((args.selectedPaths ?? args.includeImportPaths) as string[]).map((path) => ({ path, bytes: 3, sha256: hash })));
    const port = createNativeProjectModelArchivePort(database, session), expected = await port.inspectAssets(capture);
    native.invoke.mockImplementation(async (_command: string, args: Record<string, unknown>) =>
      ((args.selectedPaths ?? args.includeImportPaths) as string[]).map((path) => ({ path, bytes: 3, sha256: 'b'.repeat(64) })));
    await expect(port.createRestoreBackup!(capture, expected)).rejects.toThrow('预览后旧素材');
    native.invoke.mockImplementation(async (_command: string, args: Record<string, unknown>) =>
      ((args.selectedPaths ?? args.includeImportPaths) as string[]).map((path) => ({ path, bytes: 3, sha256: hash })));
    capture.aggregate.content.originalWork = { relativePath: 'missing.txt', fileName: 'missing.txt', addedAt: 1 };
    await expect(port.createRestoreBackup!(capture, expected)).rejects.toThrow('旧素材引用缺失');
  });
});
