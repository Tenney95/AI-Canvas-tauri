/** 用模拟 IPC 核对原生项目的归档文件边界。 */
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoundProjectModelArchiveExportPort, createBoundProjectModelArchiveImportPort, currentStoragePaths } from '../../src/services/projectModelArchiveNativePort';
import { buildProjectExchangeSnapshotV2 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import type { ProjectArchiveBusinessV4, ValidatedProjectArchiveV4 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange, ProjectModelTransferImportJournal, ProjectModelTransferExportJournal } from '../../src/types/projectModelTransfer';
import { NATIVE_EPISODE_SCRIPT_VERSION_DIRECTORY } from '../../src/utils/manuscriptFileReference';

const native = vi.hoisted(() => ({ invoke: vi.fn(), inspect: vi.fn(), existing: new Set<string>(), loadSharedAssetSyncState: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async (path: string) => native.existing.has(path) }));
vi.mock('../../src/services/fileService', () => ({
  getBaseDir: async () => '/authorized', joinPath: (...segments: string[]) => segments.join('/') }));
vi.mock('../../src/services/indexedDb/sharedAssetSyncRepository', () => ({ loadSharedAssetSyncState: native.loadSharedAssetSyncState }));

const hash = 'a'.repeat(64);
const projectId = 'p2-00000000-0000-4000-8000-000000000001';
const rootA = 'r2-00000000-0000-4000-8000-000000000002', rootB = 'r2-00000000-0000-4000-8000-000000000003';
const logicalFolder = `project-${projectId}`;
const physicalRoot = '/authorized/archive-project', physicalChild = `${physicalRoot}/roots/${rootB}`;
const sourceRef = 'native-import-00000000-0000-4000-8000-000000000004';
async function setup() {
  const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '双根', kind: 'series', storageRoots: [
    { id: 'A', role: 'shared' }, { id: 'B', role: 'canvas' },
  ] }, episodes: [], canvases: [], contents: { project: { projectId: 'P', data: {} }, episodes: [] } };
  const files = [{ id: 'F1', rootRef: 'A', relativePath: 'same.png', mediaId: 'media-original' },
    { id: 'F2', rootRef: 'B', relativePath: 'same.png', mediaId: 'media-original' }];
  const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [{ id: 'media-original', kind: 'image', extension: 'png', bytes: 3, sha256: hash }], files);
  const revision = await createProjectExchangeRevisionV2(snapshot);
  const exchange: ProjectModelTransferExchange = { lineageId: 'lineage', localHead: { canonicalVersion: 2, revisionId: revision.revisionId }, stateVersion: 1,
    identities: [{ kind: 'project', sourceId: 'P', localId: projectId },
      { kind: 'storage-root', sourceId: 'A', localId: rootA }, { kind: 'storage-root', sourceId: 'B', localId: rootB }],
    fileBindings: files.map((file, index) => ({ id: file.id, rootRef: file.rootRef, relativePath: file.relativePath,
      localRelativePath: `imports/import-op-root-${index}/same.png` })), published: [],
    bundle: { format: 'ai-canvas-project-exchange', version: 2, packageId: 'package', lineageId: 'lineage', head: { canonicalVersion: 2, revisionId: revision.revisionId },
      revisions: [revision], ancestors: [], files: [{ mediaId: 'media-original', archivePath: 'assets/original-payload.png' }] } };
  const source = { payload: { ...business, exchange: exchange.bundle }, snapshot, files,
    assets: [{ path: 'original-payload.png', bytes: 3, sha256: hash }] } as unknown as ValidatedProjectArchiveV4;
  const operation: ProjectModelTransferImportJournal = { id: 'import-op', schemaVersion: 1, kind: 'project-model-import', operationId: 'import-op', generation: 1,
    sessionId: 'session', phase: 'media_publishing', sequence: 1, createdAt: 1, updatedAt: 1, cleanup: 'retain-until-unreferenced', mode: 'import-new',
    packageDigest: hash, intentDigest: hash, targetProjectId: projectId, expected: null, exchange, idMap: exchange.identities, history: [],
    sourceRef, sourceFiles: files.map((file) => ({ id: file.id, rootRef: file.rootRef, relativePath: file.relativePath,
      archivePath: 'assets/original-payload.png', bytes: 3, sha256: hash })),
    media: exchange.fileBindings.map((file) => ({ rootRef: exchange.identities.find((item) => item.kind === 'storage-root' && item.sourceId === file.rootRef)!.localId,
      relativePath: file.localRelativePath, bytes: 3, sha256: hash })),
    next: { project: { id: projectId, name: '双根', kind: 'series', createdAt: 1, updatedAt: 1, epoch: 0, dataFolder: logicalFolder, storageRootRef: rootA,
      storageBindings: [{ rootRef: rootA, folderName: logicalFolder, sourceRecordIds: [], source: 'project-managed' },
        { rootRef: rootB, folderName: `${logicalFolder}/roots/${rootB}`, sourceRecordIds: [], source: 'project-managed' }] },
    content: { projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } }, episodes: [], episodeContents: [], canvases: [], previews: [], bindings: [] },
  };
  const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'session', sessionRevision: 1, sourceToken: 'token', includesHistory: true,
    aggregate: operation.next, exchange, historyBindings: [], history: [] };
  return { exchange, source, operation, capture, files };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); native.existing.clear();
  native.inspect.mockImplementation((args: Record<string, unknown>) =>
    ((args.selectedPaths ?? args.includeImportPaths) as string[]).map((path) => ({ path, bytes: 3, sha256: hash })));
  native.loadSharedAssetSyncState.mockResolvedValue({ mappings: [], outbox: [], conflicts: [] });
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'resolve_native_project_media_root' && args.projectId === projectId) return physicalRoot;
    if (command === 'resolve_native_project_media_subroot' && args.projectId === projectId && args.rootRef === rootB) return physicalChild;
    if (command === 'inspect_project_archive_assets') return native.inspect(args);
    if (command === 'pack_project_archive') return { operationId: args.operationId, publicationRef: 'opaque-ref', archiveSha256: hash };
    throw new Error('unexpected command');
  });
});
describe('原生项目归档文件端口', () => {
  it('扩图垫图按自身主根进入归档闭包，不沿结果画布子根定位', async () => {
    const { capture } = await setup();
    capture.aggregate.canvases = [{ id: 'canvas-pad', projectId: capture.aggregate.project.id, episodeId: null,
      epoch: 0, revision: 0, revisionScope: 'project', storageRootRef: rootB, edges: [], groups: [], nodes: [{ id: 'expanded',
        data: { outpaintInput: { relativePath: 'media/padding.png', storageRootRef: rootA, width: 1024, height: 768 } } }] }];
    const paths = currentStoragePaths(capture, new Map([[rootA, physicalRoot], [rootB, physicalChild]]));
    expect(paths.get(rootA)).toContain('media/padding.png');
    expect(paths.get(rootB)).not.toContain('media/padding.png');
  });

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

  it('复制预备只投影有引用的全局原件与子根参考图，投影不能携带物理位置', async () => {
    const { capture } = await setup();
    const projectId = 'p2-00000000-0000-4000-8000-000000000001';
    const primary = 'r2-00000000-0000-4000-8000-000000000002', child = 'r2-00000000-0000-4000-8000-000000000003';
    const operationId = '00000000-0000-4000-8000-000000000004', folder = `project-${projectId}`;
    const physicalRoot = 'authorized/native', physicalChild = `${physicalRoot}/roots/${child}`;
    const global = `imports/global-${operationId}/global-${hash}.png`;
    const reference = `imports/asset-refs-${operationId}/ref-${hash}.png`;
    capture.aggregate.project = { ...capture.aggregate.project, id: projectId, dataFolder: folder, storageRootRef: primary,
      storageBindings: [{ rootRef: primary, folderName: folder, sourceRecordIds: [], source: 'project-managed' },
        { rootRef: child, folderName: `${folder}/roots/${child}`, sourceRecordIds: [], source: 'project-managed' }] };
    capture.aggregate.content.projectId = projectId;
    capture.exchange = null;
    capture.assetMetadata = [{ assetId: 'global-asset', rootRef: primary, path: global, ownerId: projectId, bytes: 3, sha256: hash },
      { assetId: 'native-asset', rootRef: child, path: 'origin.png', ownerId: projectId, bytes: 3, sha256: hash,
        images: [{ id: 'meta', assetId: 'native-asset', contentDigest: hash, fileName: 'origin.png', prompt: '', revision: 1, updatedAt: 1,
          references: [{ id: 'ref', name: '参考图', relativePath: reference, digest: 'b'.repeat(64), bytes: 3 }] }] }];
    native.existing.add(physicalRoot); native.existing.add(physicalChild);
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') return physicalRoot;
      if (command === 'resolve_native_project_media_subroot') return physicalChild;
      if (command === 'inspect_project_archive_assets') return args.assetsDir === physicalChild
        ? [{ path: 'origin.png', bytes: 3, sha256: hash }] : [];
      throw new Error('unexpected command');
    });
    const port = createBoundProjectModelArchiveExportPort(projectId, '');
    const result = await port.inspectAssets(capture, [{ rootRef: primary, path: global, bytes: 3, sha256: hash },
      { rootRef: child, path: reference, bytes: 3, sha256: hash, localAbsolutePath: '/untrusted/location.png' }]);

    expect(result).toContainEqual({ rootRef: child, path: reference, bytes: 3, sha256: hash });
    expect(result).toContainEqual({ rootRef: primary, path: global, bytes: 3, sha256: hash });
    expect(native.invoke.mock.calls.filter(([command]) => command === 'inspect_project_archive_assets').map(([, args]) => args.referencePaths))
      .toEqual([[], ['origin.png']]);
    await expect(port.inspectAssets(capture, [{ rootRef: primary, path: reference, bytes: 3, sha256: hash }])).rejects.toThrow('投影证据');
    await expect(port.inspectAssets(capture, [{ rootRef: child, path: reference, bytes: 3, sha256: 'c'.repeat(64) }])).rejects.toThrow('投影证据');
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') return physicalRoot;
      if (command === 'resolve_native_project_media_subroot') return physicalChild;
      if (command === 'inspect_project_archive_assets') return args.assetsDir === physicalChild
        ? [{ path: 'origin.png', bytes: 3, sha256: hash }, ...(args.includeImportPaths as string[])
          .map((path) => ({ path, bytes: 3, sha256: hash }))] : [];
      throw new Error('unexpected command');
    });
    await expect(port.inspectAssets(capture, [{ rootRef: primary, path: global, bytes: 3, sha256: hash },
      { rootRef: child, path: reference, bytes: 3, sha256: hash }])).rejects.toThrow('投影位置已被占用');
  });

  it('新项目仅收录已接受和明确引用的共享素材，旧更新按冻结清单核验', async () => {
    const { capture } = await setup();
    const projectId = 'p2-00000000-0000-4000-8000-000000000001';
    const root = 'r2-00000000-0000-4000-8000-000000000002';
    const folder = `project-${projectId}`, physicalRoot = 'authorized/native';
    capture.aggregate.project = { ...capture.aggregate.project, id: projectId, dataFolder: folder, storageRootRef: root,
      storageBindings: [{ rootRef: root, folderName: folder, sourceRecordIds: [], source: 'project-managed' }] };
    capture.aggregate.content.projectId = projectId;
    // 上传只改元数据时可引用已存在的本地物理版本，不能按当前远端版本拼路径。
    const accepted = '.shared-sync/files/other-asset/previous/other-media.png';
    const old = '.shared-sync/files/asset/old/old.png';
    const referenced = '.shared-sync/files/asset/old/explicit.txt';
    const unaccepted = '.shared-sync/files/asset/pending/unaccepted.png';
    const temp = '.shared-sync/inputs/pending/temporary.png';
    const linked = { ...capture.exchange!.fileBindings[0], localRelativePath: old };
    const imported = { id: 'F3', rootRef: 'A', relativePath: '.shared-sync/files/imported/version/attachment.png',
      localRelativePath: 'imports/verified-operation/.shared-sync/files/imported/version/attachment.png' };
    capture.exchange!.identities.find((item) => item.sourceId === 'A')!.localId = root;
    // 旧 head 自动收录的旧版本没有画布引用，不能靠文件绑定再次进入归档。
    const originalHead = capture.exchange!.bundle.revisions[0];
    if (originalHead.canonicalVersion !== 2) throw new Error('invalid fixture');
    const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '项目', kind: 'series', storageRoots: [{ id: 'A', role: 'shared' }] },
      episodes: [], canvases: [], contents: { project: { projectId: 'P', data: {} }, episodes: [] } };
    const head = await createProjectExchangeRevisionV2(buildProjectExchangeSnapshotV2(business, capture.exchange!.lineageId,
      [...originalHead.snapshot.media], [linked, imported].map(({ id, rootRef, relativePath }) => ({ id, rootRef, relativePath, mediaId: 'media-original' }))));
    capture.exchange!.bundle.revisions = [head];
    capture.exchange!.bundle.head = capture.exchange!.localHead = { canonicalVersion: 2, revisionId: head.revisionId };
    capture.exchange!.fileBindings = [linked, imported];
    capture.aggregate.content.originalWork = { fileName: 'explicit.txt', relativePath: referenced, addedAt: 1 };
    const digest = { bytes: 3, sha256: hash };
    const mapping = { id: 'mapping', sharedAssetId: 'asset', ownerId: projectId, kind: 'file',
      acceptedRevisionId: 'current', currentFileAssetId: 'local-current',
      media: [{ sharedMediaId: 'accepted', localAssetId: 'local-current', projectId, relativePath: accepted, ...digest },
        { sharedMediaId: 'old', localAssetId: 'local-old', projectId, relativePath: old, ...digest },
        { sharedMediaId: 'unaccepted', localAssetId: 'local-pending', projectId, relativePath: unaccepted, ...digest }] };
    native.loadSharedAssetSyncState.mockResolvedValue({ mappings: [mapping], conflicts: [], outbox: [
      { mappingId: mapping.id, ownerId: projectId, sharedAssetId: mapping.sharedAssetId, phase: 'completed', revisionId: 'current',
        revision: { revisionId: 'current', sharedAssetId: mapping.sharedAssetId, media: [{ id: 'accepted', extension: 'png', ...digest }] } },
      { mappingId: mapping.id, ownerId: projectId, sharedAssetId: mapping.sharedAssetId, phase: 'applying', revisionId: 'pending',
        revision: { revisionId: 'pending', sharedAssetId: mapping.sharedAssetId, media: [{ id: 'unaccepted', extension: 'png', ...digest }] } },
    ] });
    native.existing.add(physicalRoot);
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') return physicalRoot;
      if (command === 'inspect_project_archive_assets') return (args.selectedPaths as string[] | undefined
        ?? [accepted, referenced, old, unaccepted, temp, imported.localRelativePath]).map((path) => ({ path, ...digest }));
      throw new Error('unexpected command');
    });
    const assets = await createBoundProjectModelArchiveExportPort(projectId, '').inspectAssets(capture);
    expect(assets.map((asset) => asset.path)).toEqual([accepted, referenced, imported.localRelativePath]);
    expect(native.invoke).toHaveBeenCalledWith('inspect_project_archive_assets', expect.objectContaining({
      excludeUnreferencedSharedSync: true, includeImportPaths: [imported.localRelativePath],
      referencePaths: [imported.localRelativePath, referenced, accepted],
    }));
    const frozen = await createBoundProjectModelArchiveExportPort(projectId, '', [], false,
      [old, temp].map((path) => ({ path, rootRef: root }))).inspectAssets(capture);
    expect(frozen.map((asset) => asset.path)).toEqual([accepted, referenced, imported.localRelativePath, old, temp]);
    expect(native.invoke).toHaveBeenCalledWith('inspect_project_archive_assets', { assetsDir: physicalRoot, selectedPaths: [old, temp] });
  });

  it('重新归档已导入的助手参考图，缺图时仍保留历史消息', async () => {
    const { capture } = await setup();
    const id = 'p2-00000000-0000-4000-8000-000000000001', root = 'r2-00000000-0000-4000-8000-000000000002';
    const child = 'r2-00000000-0000-4000-8000-000000000003', folder = `project-${id}`;
    capture.aggregate.project = { ...capture.aggregate.project, id, dataFolder: folder, storageRootRef: root,
      storageBindings: [{ rootRef: root, folderName: folder, sourceRecordIds: [], source: 'project-managed' },
        { rootRef: child, folderName: `${folder}/roots/${child}`, sourceRecordIds: [], source: 'project-managed' }] };
    capture.aggregate.content.projectId = id;
    const exchange = capture.exchange!;
    exchange.identities.find((item) => item.sourceId === 'A')!.localId = root;
    exchange.identities.find((item) => item.sourceId === 'B')!.localId = child;
    const name = 'chat-ref-11111111-1111-4111-8111-111111111111.png';
    const attachment = `imports/copied-root-0/${name}`;
    exchange.fileBindings.push({ id: 'chat-image', rootRef: 'A', relativePath: name, localRelativePath: attachment });
    capture.history.push({ kind: 'message', sourceNamespace: 'native', archiveOriginId: '',
      value: { id: 'message', projectId: id, content: `@image{${name}|参考图}` } });
    native.existing.add('authorized/native'); native.existing.add(`authorized/native/roots/${child}`);
    let present = true;
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') return 'authorized/native';
      if (command === 'resolve_native_project_media_subroot') return `authorized/native/roots/${child}`;
      if (command === 'inspect_project_archive_assets') return (args.includeImportPaths as string[]).filter((path) => path !== attachment || present)
        .map((path) => ({ path, bytes: 3, sha256: hash }));
      throw new Error('unexpected command');
    });
    const port = createBoundProjectModelArchiveExportPort(id, '');
    expect((await port.inspectAssets(capture)).map((entry) => entry.path)).toContain(attachment);
    present = false;
    expect((await port.inspectAssets(capture)).map((entry) => entry.path)).not.toContain(attachment);
  });

  it('已回收的工作台资料不阻塞新归档，当前引用和冻结清单仍须核对', async () => {
    const { capture } = await setup();
    const projectId = 'p2-00000000-0000-4000-8000-000000000001';
    const root = 'r2-00000000-0000-4000-8000-000000000002', child = 'r2-00000000-0000-4000-8000-000000000003';
    const folder = `project-${projectId}`, physicalRoot = 'authorized/native', physicalChild = `${physicalRoot}/roots/${child}`;
    capture.aggregate.project = { ...capture.aggregate.project, id: projectId, dataFolder: folder, storageRootRef: root,
      storageBindings: [{ rootRef: root, folderName: folder, sourceRecordIds: [], source: 'project-managed' },
        { rootRef: child, folderName: `${folder}/roots/${child}`, sourceRecordIds: [], source: 'project-managed' }] };
    capture.aggregate.content.projectId = projectId;
    capture.exchange!.identities.find((item) => item.sourceId === 'A')!.localId = root;
    capture.exchange!.identities.find((item) => item.sourceId === 'B')!.localId = child;
    const outline = 'outline-documents/旧稿.docx';
    capture.exchange!.fileBindings[0].localRelativePath = outline;
    native.existing.add(physicalRoot); native.existing.add(physicalChild);
    let hasOutline = false;
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') return physicalRoot;
      if (command === 'resolve_native_project_media_subroot') return physicalChild;
      if (command === 'inspect_project_archive_assets') return [
        ...(args.includeImportPaths as string[]),
        ...(args.assetsDir === physicalRoot && hasOutline ? [outline] : []),
      ].map((path) => ({ path, bytes: 3, sha256: hash }));
      throw new Error('unexpected command');
    });
    const port = createBoundProjectModelArchiveExportPort(projectId, '');
    expect((await port.inspectAssets(capture)).map((asset) => asset.path)).not.toContain(outline);
    hasOutline = true;
    expect((await port.inspectAssets(capture)).map((asset) => asset.path)).toContain(outline);
    hasOutline = false;
    const frozen = createBoundProjectModelArchiveExportPort(projectId, '', [], false, [{ rootRef: root, path: outline }]);
    await expect(frozen.inspectAssets(capture)).rejects.toThrow(outline);
    capture.aggregate.content.originalWork = { fileName: '旧稿.docx', relativePath: outline, addedAt: 1 };
    await expect(port.inspectAssets(capture)).rejects.toThrow(outline);
  });

  it('原生稿件只收录当前版本和冻结原操作的版本，普通手工稿照常收录', async () => {
    const { capture } = await setup();
    const projectId = 'p2-00000000-0000-4000-8000-000000000001';
    const root = 'r2-00000000-0000-4000-8000-000000000002', child = 'r2-00000000-0000-4000-8000-000000000003';
    const folder = `project-${projectId}`, physicalRoot = 'authorized/native', physicalChild = `${physicalRoot}/roots/${child}`;
    capture.aggregate.project = { ...capture.aggregate.project, id: projectId, dataFolder: folder, storageRootRef: root,
      storageBindings: [{ rootRef: root, folderName: folder, sourceRecordIds: [], source: 'project-managed' },
        { rootRef: child, folderName: `${folder}/roots/${child}`, sourceRecordIds: [], source: 'project-managed' }] };
    capture.aggregate.content.projectId = projectId;
    capture.exchange!.identities.find((item) => item.sourceId === 'A')!.localId = root;
    capture.exchange!.identities.find((item) => item.sourceId === 'B')!.localId = child;
    const versions = NATIVE_EPISODE_SCRIPT_VERSION_DIRECTORY;
    const previous = `imports/previous-copy-root-1/${versions}/第一集--v-${'a'.repeat(24)}.txt`;
    const fileName = `第一集--v-${'b'.repeat(24)}.txt`;
    const current = `${versions}/${fileName}`, manual = 'manuscripts/手工稿.txt';
    capture.exchange!.fileBindings[1].localRelativePath = previous;
    capture.aggregate.episodeContents.push({ episodeId: 'episode', storageRootRef: child, revision: 1,
      scriptFile: { fileName, relativePath: current, sourceName: '第一集.txt' } });
    native.existing.add(physicalRoot); native.existing.add(physicalChild);
    let previousExists = true;
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') return physicalRoot;
      if (command === 'resolve_native_project_media_subroot') return physicalChild;
      if (command === 'inspect_project_archive_assets') return [
        ...(args.includeImportPaths as string[]).filter((path) => path !== previous || previousExists),
        ...(args.assetsDir === physicalChild ? [manual] : []),
      ].map((path) => ({ path, bytes: 3, sha256: hash }));
      throw new Error('unexpected command');
    });
    const assets = await createBoundProjectModelArchiveExportPort(projectId, '').inspectAssets(capture);
    expect(assets.filter((asset) => asset.rootRef === child).map((asset) => asset.path).sort()).toEqual([current, manual]);
    const frozen = createBoundProjectModelArchiveExportPort(projectId, '', [], true, [{ rootRef: child, path: previous }]);
    expect((await frozen.inspectAssets(capture)).map((asset) => asset.path).sort()).toEqual([current, previous, manual]);
    previousExists = false;
    await expect(frozen.inspectAssets(capture)).rejects.toThrow(previous);
  });

  it.each(['readable', 'existing-id'] as const)('bound导入%s物理目录沿原journal续接，逻辑目录不重算且重启不重发已发布子操作', async (binding) => {
    const { operation, source } = await setup();
    const physicalRoot = `/authorized/${binding === 'readable' ? '导入副本-00000000' : logicalFolder}`;
    const physicalChild = `${physicalRoot}/roots/${rootB}`;
    const incoming = `/authorized/${sourceRef}`;
    const sourcePath = 'original-payload.png', destinationPath = 'same.png';
    const firstChildDirectory = `${physicalRoot}/imports/import-op-root-0`;
    const disk = new Map([
      [incoming, new Set([sourcePath])],
      [physicalRoot, new Set<string>()],
      [physicalChild, new Set<string>()],
    ]);
    const lostResponse = new Error('lost response');
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'resolve_native_project_media_root') {
        expect(args).toEqual({ projectId });
        return physicalRoot;
      }
      if (command === 'resolve_native_project_media_subroot') {
        expect(args).toEqual({ projectId, rootRef: rootB, create: false });
        return physicalChild;
      }
      if (command === 'inspect_project_archive_assets') {
        const files = disk.get(args.assetsDir as string);
        if (!files) throw new Error('未授权的扫描目录');
        return (args.selectedPaths as string[]).filter((path) => files.has(path)).map((path) => ({ path, bytes: 3, sha256: hash }));
      }
      if (command === 'publish_project_import_assets') {
        const firstChild = args.operationId === 'import-op-root-0';
        expect(args.operationId).toBe(firstChild ? 'import-op-root-0' : 'import-op-root-1');
        const root = firstChild ? physicalRoot : physicalChild;
        expect(args.projectDir).toBe(root);
        expect(args.stagingDir).toBe(incoming);
        expect(args.sourceRoots).toEqual([{ rootRef: 'incoming', directory: incoming }]);
        expect(args.assets).toEqual([{ path: sourcePath, sourceRootRef: 'incoming', destinationPath, bytes: 3, sha256: hash }]);
        const relativeDir = `imports/${args.operationId}`;
        const finalDir = `${root}/${relativeDir}`;
        native.existing.add(finalDir);
        disk.set(finalDir, new Set([destinationPath]));
        disk.get(root)!.add(`${relativeDir}/${destinationPath}`);
        if (firstChild) throw lostResponse;
        return;
      }
      throw new Error(`unexpected native command: ${command}`);
    });
    const original = createBoundProjectModelArchiveImportPort(projectId, sourceRef);
    expect(await original.captureImportSource!(source)).toEqual({ sourceRef, sourceFiles: operation.sourceFiles });
    await expect(original.publishMedia(operation, source)).rejects.toBe(lostResponse);
    const callsBeforeReplacement = native.invoke.mock.calls.length;
    const replacement = createBoundProjectModelArchiveImportPort(projectId, 'native-import-00000000-0000-4000-8000-000000000005');
    await expect(replacement.publishMedia(operation, source)).rejects.toThrow('素材目录不属于该新项目');
    expect(native.invoke.mock.calls).toHaveLength(callsBeforeReplacement);
    const restarted = createBoundProjectModelArchiveImportPort(projectId, operation.sourceRef!);
    disk.get(firstChildDirectory)!.delete(destinationPath);
    await expect(restarted.publishMedia(operation, source)).rejects.toThrow('原媒体子操作已存在但无法核实，未重发');
    expect(native.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets')).toHaveLength(1);
    disk.get(firstChildDirectory)!.add(destinationPath);
    expect(await restarted.publishMedia(operation, source)).toBe(`media_v1_${operation.operationId}`);
    await restarted.verifyMediaPublication(operation, `media_v1_${operation.operationId}`);
    const publishes = native.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets');
    expect(publishes).toHaveLength(2);
    expect(publishes.map(([, args]) => args.projectDir)).toEqual([physicalRoot, physicalChild]);
    expect(publishes.map(([, args]) => args.operationId)).toEqual(['import-op-root-0', 'import-op-root-1']);
    expect(operation.next.project.dataFolder).toBe(logicalFolder);
    expect(operation.next.project.storageBindings.map((root) => root.folderName)).toEqual([logicalFolder, `${logicalFolder}/roots/${rootB}`]);
    const inspectionRoots = native.invoke.mock.calls.filter(([command]) => command === 'inspect_project_archive_assets').map(([, args]) => args.assetsDir);
    expect(inspectionRoots).toContain(firstChildDirectory);
    expect(inspectionRoots).toContain(physicalRoot); expect(inspectionRoots).toContain(physicalChild);
    expect(native.invoke.mock.calls.some(([command]) => command === 'claim_native_project_media_root')).toBe(false);
    await expect(restarted.verifyMediaPublication(operation, 'another-op')).rejects.toThrow('回执');
  });

  it('扫描结果缺少当前正文引用时禁止打包', async () => {
    const { capture } = await setup();
    capture.exchange = null;
    capture.aggregate.project.storageBindings = capture.aggregate.project.storageBindings.slice(0, 1);
    capture.aggregate.content.originalWork = { relativePath: 'missing.txt', fileName: 'missing.txt', addedAt: 1 };
    native.existing.add(physicalRoot);
    native.inspect.mockReturnValue([]);
    await expect(createBoundProjectModelArchiveExportPort(projectId, 'chosen-output').inspectAssets(capture))
      .rejects.toThrow('项目引用的素材缺失，无法安全导出：missing.txt');
    expect(native.invoke.mock.calls.some(([command]) => command === 'pack_project_archive')).toBe(false);
  });

  it.each([
    { field: 'data.relativePath', data: { relativePath: 'missing.png' } },
    { field: 'data.referenceImages[0].relativePath', data: { referenceImages: [{ id: 'ref-one', label: '正面参考', relativePath: 'missing.png' }] } },
    { field: 'data.outpaintInput.relativePath', data: { outpaintInput: { relativePath: 'missing.png', width: 1024, height: 768 } } },
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
    native.existing.add(physicalRoot); native.inspect.mockReturnValue([]);
    const original = structuredClone(capture);
    const failure = await createBoundProjectModelArchiveExportPort(projectId, '').inspectAssets(capture).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('项目引用的素材缺失，无法安全导出：missing.png');
    expect(message).toContain('项目「剧集」 → 分集「EP000」');
    expect(message).toContain('节点 #42「角色定妆图」（ID：missing-image-node）');
    expect(message).toContain(`引用字段：${field}`);
    if (field.includes('shotlistRows')) expect(message).toContain('镜头「S003」（ID：shot-one）');
    expect(message).not.toMatch(/\/authorized\/archive-project|不得进入错误的完整正文/);
    expect(capture).toEqual(original);
  });

  it.each(['history', 'assetMetadata'] as const)('缺失引用来自%s时明确出处和字段', async (source) => {
    const { capture } = await setup(); capture.exchange = null;
    capture.aggregate.project.storageBindings = capture.aggregate.project.storageBindings.slice(0, 1);
    if (source === 'history') capture.history = [{ kind: 'output', sourceNamespace: 'native:project', archiveOriginId: 'out-one',
      value: { id: 'out-one', projectId: capture.aggregate.project.id, name: '原输出', relativePath: 'missing.png' } }];
    else capture.assetMetadata = [{ assetId: 'asset-one', rootRef: capture.aggregate.project.storageRootRef,
      ownerId: capture.aggregate.project.id, path: 'missing.png', bytes: 3, sha256: hash }];
    native.existing.add(physicalRoot); native.inspect.mockReturnValue([]);
    const failure = await createBoundProjectModelArchiveExportPort(projectId, '').inspectAssets(capture).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('项目引用的素材缺失，无法安全导出：missing.png');
    expect(message).toContain(source === 'history' ? '输出历史「原输出」（ID：out-one）' : '素材「missing.png」（ID：asset-one）');
    expect(message).toContain(source === 'history' ? '引用字段：relativePath' : '引用字段：assetMetadata.path');
    expect(message).not.toContain(physicalRoot);
  });

  it('旧版本附件缺失指出冻结文件身份，不丢弃历史附件', async () => {
    const { capture } = await setup();
    native.existing.add(physicalRoot); native.existing.add(physicalChild); native.inspect.mockReturnValue([]);
    const failure = await createBoundProjectModelArchiveExportPort(projectId, '').inspectAssets(capture).catch((error: unknown) => error);
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

  it('inspect只包含当前bindings的imports，保普通附件并排除嵌套root重复扫描', async () => {
    const { capture } = await setup();
    capture.aggregate.content.originalWork = { relativePath: 'imports/new-output/generated.png' } as NonNullable<typeof capture.aggregate.content.originalWork>;
    capture.exchange!.fileBindings.push({ id: 'stale-file', rootRef: 'A', relativePath: 'orphan.png', localRelativePath: 'imports/failed/orphan.png' });
    native.existing.add(physicalRoot); native.existing.add(physicalChild);
    native.inspect.mockImplementation((args: Record<string, unknown>) => args.assetsDir === physicalRoot
      ? [{ path: 'attachment.txt', bytes: 3, sha256: hash }, { path: `roots/${rootB}/same.png`, bytes: 3, sha256: hash },
        { path: 'imports/import-op-root-0/same.png', bytes: 3, sha256: hash }, { path: 'imports/new-output/generated.png', bytes: 3, sha256: hash }]
      : [{ path: 'imports/import-op-root-1/same.png', bytes: 3, sha256: hash }]);
    const result = await createBoundProjectModelArchiveExportPort(projectId, '').inspectAssets(capture);
    expect(result.map((item) => [item.rootRef, item.path])).toEqual([
      [rootA, 'attachment.txt'], [rootA, 'imports/import-op-root-0/same.png'],
      [rootA, 'imports/new-output/generated.png'], [rootB, 'imports/import-op-root-1/same.png'],
    ]);
    const calls = native.inspect.mock.calls.map(([args]) => args);
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
    const receipt = await createBoundProjectModelArchiveExportPort(projectId, 'chosen-output.aicanvas').pack(operation, entries, capture, files, assets);
    expect(receipt).toEqual({ outputRef: 'opaque-ref', packageDigest: hash });
    const args = native.invoke.mock.calls.find(([command]) => command === 'pack_project_archive')![1];
    expect(args.expectedAssets).toEqual([{ path: 'original-payload.png', bytes: 3, sha256: hash,
      sourceRootRef: 'root-0', sourceRelativePath: 'imports/import-op-root-0/same.png' }]);
    expect(args.sourceRoots).toEqual([{ rootRef: 'root-0', directory: physicalRoot }, { rootRef: 'root-1', directory: physicalChild }]);
    expect(JSON.stringify(args.entries)).not.toMatch(/\/authorized\/|sourceRootRef|sourceRelativePath|import-op/);
    expect(JSON.stringify(operation)).not.toContain('chosen-output.aicanvas');
  });
  it('三类旧本机文件字段及截图数组只纳入所属受权root内的imports引用', async () => {
    const { capture } = await setup(); native.existing.add(physicalRoot); native.existing.add(physicalChild);
    capture.aggregate.canvases.push({ id: 'C', projectId, episodeId: null, storageRootRef: rootB, revisionScope: 'project', epoch: 0, revision: 0,
      nodes: [{ id: 'n', data: { filePath: `${physicalChild}/imports/file.png`, imageFilePath: `${physicalChild}/imports/image.png`,
        directorCaptureFilePaths: [`${physicalChild}/imports/frame.png`, `${physicalRoot}/imports/wrong-root.png`, `${physicalChild}-escape/imports/outside.png`],
        prompt: `${physicalChild}/imports/prompt-only.png` } }], edges: [], groups: [] });
    await createBoundProjectModelArchiveExportPort(projectId, '').inspectAssets(capture);
    const calls = native.inspect.mock.calls.map(([args]) => args);
    expect(calls[0].includeImportPaths).toEqual(['imports/import-op-root-0/same.png']);
    expect(calls[1].includeImportPaths).toEqual(['imports/import-op-root-1/same.png', 'imports/file.png', 'imports/image.png', 'imports/frame.png']);
    expect(JSON.stringify(calls.map((args) => args.includeImportPaths))).not.toMatch(/wrong-root|outside|prompt-only/);
  });
});
