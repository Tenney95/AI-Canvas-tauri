/** P5 原生 IPC 适配回归源；不触碰真实文件或原生服务，尚未运行。 */
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoundProjectModelArchiveExportPort, createBoundProjectModelArchiveImportPort, createNativeProjectModelArchivePort } from '../../src/services/projectModelArchiveNativePort';
import { buildProjectExchangeSnapshotV2 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import type { ProjectArchiveBusinessV4, ValidatedProjectArchiveV4 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange, ProjectModelTransferImportJournal, ProjectModelTransferExportJournal } from '../../src/types/projectModelTransfer';
import type { ProjectModelFixtureBusinessSession } from '../../src/types/projectModelBusiness';

const native = vi.hoisted(() => ({ invoke: vi.fn(), existing: new Set<string>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async (path: string) => native.existing.has(path) }));
vi.mock('../../src/services/fileService', () => ({ projectArchiveFixtureDirectory: async (_db: string, relative: string) => `fixture/${relative}`,
  getBaseDir: async () => 'authorized', joinPath: (...segments: string[]) => segments.join('/') }));
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
  it('新项目导出只使用原生绑定的主根和逻辑子根，不接受其他目录', async () => {
    const { capture, files } = await setup();
    const projectId = 'p2-00000000-0000-4000-8000-000000000001';
    const rootA = 'r2-00000000-0000-4000-8000-000000000002', rootB = 'r2-00000000-0000-4000-8000-000000000003';
    capture.aggregate.project.id = projectId;
    capture.aggregate.project.dataFolder = `project-${projectId}`;
    capture.aggregate.project.storageRootRef = rootA;
    capture.aggregate.project.storageBindings = [
      { rootRef: rootA, folderName: `project-${projectId}`, sourceRecordIds: [], source: 'project-managed' },
      { rootRef: rootB, folderName: `project-${projectId}/roots/${rootB}`, sourceRecordIds: [], source: 'project-managed' },
    ];
    capture.exchange!.identities.find((item) => item.sourceId === 'A')!.localId = rootA;
    capture.exchange!.identities.find((item) => item.sourceId === 'B')!.localId = rootB;
    const physicalRoot = 'authorized/人间有差-00000000', physicalChild = `${physicalRoot}/roots/${rootB}`;
    native.existing.add(physicalRoot); native.existing.add(physicalChild);
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') return physicalRoot;
      if (command === 'resolve_native_project_media_subroot') return physicalChild;
      if (command === 'pack_project_archive') return { operationId: args.operationId, publicationRef: 'opaque-ref', archiveSha256: hash };
      if (command === 'inspect_project_archive_assets') return [
        ...(args.includeImportPaths as string[]).map((path) => ({ path, bytes: 3, sha256: hash })),
        ...(args.assetsDir === physicalRoot ? [{ path: '.ai-canvas-native-project.json', bytes: 3, sha256: hash },
          { path: 'roots/unfinished/retained.png', bytes: 3, sha256: hash }] : []),
      ];
      throw new Error('unexpected command');
    });
    const port = createBoundProjectModelArchiveExportPort(projectId, 'output');
    const result = await port.inspectAssets(capture);
    expect(result.map((item) => item.rootRef)).toEqual([rootA, rootB]);
    expect(result.map((item) => item.localAbsolutePath)).toEqual([
      `${physicalRoot}/imports/import-op-root-0/same.png`, `${physicalChild}/imports/import-op-root-1/same.png`,
    ]);
    expect(capture.aggregate.project.dataFolder).toBe(`project-${projectId}`);
    const exportOperation = { operationId: 'export-op', exchange: capture.exchange } as ProjectModelTransferExportJournal;
    await port.pack(exportOperation, [{ path: 'manifest.json', content: '{"formatVersion":4}' }], capture, files, result);
    const packed = native.invoke.mock.calls.find(([command]) => command === 'pack_project_archive')![1];
    expect(packed.sourceRoots).toEqual([{ rootRef: 'root-0', directory: physicalRoot }, { rootRef: 'root-1', directory: physicalChild }]);
    expect(JSON.stringify(packed.entries)).not.toContain(physicalRoot);
    expect(native.invoke).toHaveBeenCalledWith('resolve_native_project_media_subroot', { projectId, rootRef: rootB, create: false });
    capture.aggregate.project.storageBindings[1].folderName = `project-${projectId}/roots/../../outside`;
    await expect(port.inspectAssets(capture)).rejects.toThrow('素材根不属于该新项目');
  });

  it.each(['readable', 'existing-id'] as const)('bound导入%s物理目录沿原journal续接，逻辑目录不重算且重启不重发已发布子操作', async (binding) => {
    const { operation, source } = await setup();
    const projectId = 'p2-00000000-0000-4000-8000-000000000001';
    const rootA = 'r2-00000000-0000-4000-8000-000000000002', rootB = 'r2-00000000-0000-4000-8000-000000000003';
    const logicalFolder = `project-${projectId}`, physicalRoot = `authorized/${binding === 'readable' ? '导入副本-00000000' : logicalFolder}`;
    const physicalChild = `${physicalRoot}/roots/${rootB}`, sourceRef = 'native-import-00000000-0000-4000-8000-000000000004';
    operation.targetProjectId = projectId; operation.sourceRef = sourceRef;
    operation.next.project = { ...operation.next.project, id: projectId, dataFolder: logicalFolder, storageRootRef: rootA,
      storageBindings: [{ rootRef: rootA, folderName: logicalFolder, sourceRecordIds: [], source: 'project-managed' },
        { rootRef: rootB, folderName: `${logicalFolder}/roots/${rootB}`, sourceRecordIds: [], source: 'project-managed' }] };
    operation.next.content.projectId = projectId;
    operation.idMap.find((item) => item.kind === 'project')!.localId = projectId;
    operation.idMap.find((item) => item.sourceId === 'A')!.localId = rootA;
    operation.idMap.find((item) => item.sourceId === 'B')!.localId = rootB;
    operation.media.forEach((item, ordinal) => { item.rootRef = ordinal ? rootB : rootA; });
    let lost = false;
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') return physicalRoot;
      if (command === 'resolve_native_project_media_subroot') return physicalChild;
      if (command === 'inspect_project_archive_assets') return (args.selectedPaths as string[]).map((path) => ({ path, bytes: 3, sha256: hash }));
      if (command === 'publish_project_import_assets') {
        native.existing.add(`${args.projectDir}/imports/${args.operationId}`);
        if (!lost) { lost = true; throw new Error('lost response'); }
        return;
      }
      throw new Error(`unexpected native command: ${command}`);
    });
    const original = createBoundProjectModelArchiveImportPort(projectId, sourceRef);
    expect(await original.captureImportSource!(source)).toEqual({ sourceRef, sourceFiles: operation.sourceFiles });
    await expect(original.publishMedia(operation, source)).rejects.toThrow('lost response');
    const restarted = createBoundProjectModelArchiveImportPort(projectId, operation.sourceRef!);
    expect(await restarted.publishMedia(operation, source)).toBe(`media_v1_${operation.operationId}`);
    await restarted.verifyMediaPublication(operation, `media_v1_${operation.operationId}`);
    const publishes = native.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets');
    expect(publishes).toHaveLength(2);
    expect(publishes.map(([, args]) => args.projectDir)).toEqual([physicalRoot, physicalChild]);
    expect(publishes.map(([, args]) => args.operationId)).toEqual(['import-op-root-0', 'import-op-root-1']);
    expect(publishes.every(([, args]) => args.sourceRoots[0].directory === `authorized/${sourceRef}`)).toBe(true);
    expect(operation.next.project.dataFolder).toBe(logicalFolder);
    expect(operation.next.project.storageBindings.map((root) => root.folderName)).toEqual([logicalFolder, `${logicalFolder}/roots/${rootB}`]);
    const inspectionRoots = native.invoke.mock.calls.filter(([command]) => command === 'inspect_project_archive_assets').map(([, args]) => args.assetsDir);
    expect(inspectionRoots).toContain(`${physicalRoot}/imports/import-op-root-0`);
    expect(inspectionRoots).toContain(physicalRoot); expect(inspectionRoots).toContain(physicalChild);
    expect(native.invoke.mock.calls.some(([command]) => command === 'claim_native_project_media_root')).toBe(false);
  });

  it('扫描结果缺少当前正文引用时禁止打包', async () => {
    const { capture } = await setup();
    capture.exchange = null;
    capture.aggregate.project.storageBindings = capture.aggregate.project.storageBindings.slice(0, 1);
    capture.aggregate.content.originalWork = { relativePath: 'missing.png' } as NonNullable<typeof capture.aggregate.content.originalWork>;
    native.existing.add('fixture/primary');
    native.invoke.mockResolvedValue([]);
    await expect(createNativeProjectModelArchivePort(database, session).inspectAssets(capture)).rejects.toThrow('项目引用的素材缺失');
  });

  it.each([
    { field: 'data.relativePath', data: { relativePath: 'missing.png' } },
    { field: 'data.referenceImages[0].relativePath', data: { referenceImages: [{ id: 'ref-one', label: '正面参考', relativePath: 'missing.png' }] } },
    { field: 'data.shotlistRows[0].relativePath', data: { shotlistRows: [{ id: 'shot-one', shotNo: 'S003', relativePath: 'missing.png' }] } },
  ])('新项目缺失引用定位到分集、节点和$field，不静默跳过', async ({ field, data }) => {
    const { capture } = await setup();
    capture.exchange = null; capture.aggregate.project.name = '剧集';
    capture.aggregate.project.storageBindings = capture.aggregate.project.storageBindings.slice(0, 1);
    capture.aggregate.episodes = [{ id: 'episode-one', projectId: capture.aggregate.project.id, canvasId: 'canvas-one', name: 'EP000',
      orderRank: 0, createdAt: 1, updatedAt: 1, epoch: 0, revision: 0, settingsPolicy: { mode: 'inherit', overrides: {} } }];
    capture.aggregate.canvases = [{ id: 'canvas-one', projectId: capture.aggregate.project.id, episodeId: 'episode-one',
      storageRootRef: capture.aggregate.project.storageRootRef, epoch: 0, revision: 0, revisionScope: 'project', edges: [], groups: [],
      nodes: [{ id: 'missing-image-node', type: 'source-image', data: { label: '角色定妆图', displayId: 42, ...data,
        prompt: '不得进入错误的完整正文' } }] }];
    native.existing.add('fixture/primary'); native.invoke.mockResolvedValue([]);
    const original = structuredClone(capture);
    const failure = await createNativeProjectModelArchivePort(database, session).inspectAssets(capture).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('项目引用的素材缺失，无法安全导出：missing.png');
    expect(message).toContain('项目「剧集」 → 分集「EP000」');
    expect(message).toContain('节点 #42「角色定妆图」（ID：missing-image-node）');
    expect(message).toContain(`引用字段：${field}`);
    if (field.includes('shotlistRows')) expect(message).toContain('镜头「S003」（ID：shot-one）');
    expect(message).not.toMatch(/fixture\/primary|不得进入错误的完整正文/);
    expect(capture).toEqual(original);
  });

  it.each(['history', 'assetMetadata'] as const)('缺失引用来自%s时明确出处和字段', async (source) => {
    const { capture } = await setup(); capture.exchange = null;
    capture.aggregate.project.storageBindings = capture.aggregate.project.storageBindings.slice(0, 1);
    if (source === 'history') capture.history = [{ kind: 'output', sourceNamespace: 'native:project', archiveOriginId: 'out-one',
      value: { id: 'out-one', projectId: capture.aggregate.project.id, name: '原输出', relativePath: 'missing.png' } }];
    else capture.assetMetadata = [{ assetId: 'asset-one', rootRef: capture.aggregate.project.storageRootRef,
      ownerId: capture.aggregate.project.id, path: 'missing.png', bytes: 3, sha256: hash }];
    native.existing.add('fixture/primary'); native.invoke.mockResolvedValue([]);
    const failure = await createNativeProjectModelArchivePort(database, session).inspectAssets(capture).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('项目引用的素材缺失，无法安全导出：missing.png');
    expect(message).toContain(source === 'history' ? '输出历史「原输出」（ID：out-one）' : '素材「missing.png」（ID：asset-one）');
    expect(message).toContain(source === 'history' ? '引用字段：relativePath' : '引用字段：assetMetadata.path');
    expect(message).not.toContain('fixture/primary');
  });

  it('旧版本附件缺失指出冻结文件身份，不丢弃历史附件', async () => {
    const { capture } = await setup();
    native.existing.add('fixture/primary'); native.existing.add('fixture/secondary'); native.invoke.mockResolvedValue([]);
    const failure = await createNativeProjectModelArchivePort(database, session).inspectAssets(capture).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('旧版本附件（文件 ID：F1）');
    expect((failure as Error).message).toContain('引用字段：exchange.fileBindings.localRelativePath');
    expect((failure as Error).message).toContain('imports/import-op-root-0/same.png');
  });

  it('macOS绝对filePath只在本轮扫描映射，错误显示相对文件名而不泄露目录或正文', async () => {
    const { capture } = await setup();
    const projectId = 'p2-00000000-0000-4000-8000-000000000001', rootRef = 'r2-00000000-0000-4000-8000-000000000002';
    const folderName = `project-${projectId}`, physicalRoot = '/Users/private/项目素材/作品-00000000';
    capture.exchange = null;
    capture.aggregate.project = { ...capture.aggregate.project, id: projectId, name: '作品', dataFolder: folderName,
      storageRootRef: rootRef, storageBindings: [{ rootRef, folderName, sourceRecordIds: [], source: 'project-managed' }] };
    capture.aggregate.canvases = [{ id: 'canvas-one', projectId, episodeId: null, storageRootRef: rootRef,
      epoch: 0, revision: 0, revisionScope: 'project', edges: [], groups: [], nodes: [{ id: 'source-node', type: 'source-image',
        data: { label: '导入图片', displayId: 7, filePath: `${physicalRoot}/missing.png`, prompt: '不得进入错误的完整正文' } }] }];
    native.existing.add(physicalRoot);
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'resolve_native_project_media_root') return physicalRoot;
      if (command === 'inspect_project_archive_assets') return [];
      throw new Error(`unexpected native command: ${command}`);
    });
    const failure = await createBoundProjectModelArchiveExportPort(projectId, 'chosen-output').inspectAssets(capture).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('missing.png');
    expect((failure as Error).message).toContain('节点 #7「导入图片」（ID：source-node）');
    expect((failure as Error).message).toContain('引用字段：data.filePath');
    expect((failure as Error).message).not.toMatch(/\/Users\/private|不得进入错误的完整正文|chosen-output/);
  });

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
      ? [{ path: 'attachment.txt', bytes: 3, sha256: hash }, { path: 'roots/secondary/same.png', bytes: 3, sha256: hash },
        { path: 'imports/import-op-root-0/same.png', bytes: 3, sha256: hash }, { path: 'imports/new-output/generated.png', bytes: 3, sha256: hash }]
      : [{ path: 'imports/import-op-root-1/same.png', bytes: 3, sha256: hash }]);
    const result = await createNativeProjectModelArchivePort(database, session).inspectAssets(capture);
    expect(result.map((item) => [item.rootRef, item.path])).toEqual([
      ['legacy-root:A', 'attachment.txt'], ['legacy-root:A', 'imports/import-op-root-0/same.png'],
      ['legacy-root:A', 'imports/new-output/generated.png'], ['legacy-root:B', 'imports/import-op-root-1/same.png'],
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
    await expect(port.createRestoreBackup!(capture, expected)).rejects.toThrow('项目引用的素材缺失，无法安全导出');
  });
});
