/** P6 集成：真实归档/业务/传输仓储与native port，仅原生IPC、文件系统及Worker传输为内存替身。 */
import { createHash, webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectArchiveBusinessV4, ProjectArchivePayloadV4 } from '../../src/types/projectArchiveV4';
import type { ProjectArchiveTextEntry } from '../../src/services/projectArchiveSerialization';
import type { ArchiveAssetDigest } from '../../src/services/projectExchangeDomain';
import { buildProjectExchangeSnapshotV2, readProjectArchiveV4, serializeProjectArchiveV4 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import { createProjectModelArchiveService } from '../../src/services/projectModelArchiveService';
import { createNativeProjectModelArchivePort, prepareProjectModelArchiveFixtureImport } from '../../src/services/projectModelArchiveNativePort';
import { createProjectModelStagingRepository, openProjectModelFixtureDatabase, projectModelSourceToken } from '../../src/services/indexedDb/projectModelStagingRepository';
import { beginProjectModelFixtureBusinessSession, createProjectModelBusinessRepository } from '../../src/services/indexedDb/projectModelBusinessRepository';
import { readLegacyMigrationSnapshot } from '../../src/services/indexedDb/projectModelMigrationRepository';
import { createProjectModelBackup } from '../../src/services/projectModelBackup';
import { fingerprintProjectModelSource } from '../../src/services/projectModelSourceFingerprint';

interface MemoryArchive { texts: Record<string, string>; assets: Map<string, Uint8Array> }
interface NativeAsset extends ArchiveAssetDigest { sourceRootRef?: string; sourceRelativePath?: string; destinationPath?: string }
interface NativeInput { archivePath?: string; assetsDir?: string; selectedPaths?: string[]; includeImportPaths?: string[];
  resolveImportAliases?: boolean; referencePaths?: string[];
  aliasChecks?: Array<{ rootRef: string; path: string; aliases: string[]; bytes: number; sha256: string }>;
  projectDir?: string; stagingDir?: string; operationId?: string; outputPath?: string; publicationRef?: string;
  entries?: ProjectArchiveTextEntry[]; expectedAssets?: NativeAsset[]; assets?: NativeAsset[]; sourceRoots?: Array<{ rootRef: string; directory: string }> }
const memory = vi.hoisted(() => ({ invoke: vi.fn(), files: new Map<string, Uint8Array>(), directories: new Set<string>(),
  archives: new Map<string, MemoryArchive>(), receipts: new Map<string, { outputPath: string; publicationRef: string; archiveSha256: string }>(),
  losePublish: false, losePack: false,
  lease: { leaseId: 'integration-lease', profileId: 'archive-integration', mode: 'isolated-fixture', coldStart: true, productionAllowed: false } }));
const root = '/isolated-app-data', databaseName = 'ai-canvas-model-fixture-archive-integration';
vi.mock('@tauri-apps/api/core', () => ({ invoke: memory.invoke, convertFileSrc: (path: string) => path }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => '/isolated-app-data', executableDir: async () => '/unused' }));
vi.mock('@tauri-apps/plugin-fs', () => {
  const info = async (path: string) => {
    if (!memory.directories.has(path) && !memory.files.has(path)) throw new Error('ENOENT');
    return { isDirectory: memory.directories.has(path), isFile: memory.files.has(path), isSymlink: false, size: memory.files.get(path)?.byteLength ?? 0 };
  };
  const unexpected = () => { throw new Error('Unexpected filesystem operation'); };
  return { exists: async (path: string) => memory.directories.has(path) || memory.files.has(path), lstat: info, stat: info,
    mkdir: async (path: string) => {
      if (memory.directories.has(path) || memory.files.has(path) || !memory.directories.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('directory exists or parent missing');
      memory.directories.add(path);
    }, open: unexpected, remove: unexpected, readDir: unexpected, readFile: unexpected, rename: unexpected, watch: unexpected, writeFile: unexpected };
});
vi.mock('../../src/services/fileService', async () => {
  const core = await import('../../src/services/fs/core'), fixture = await import('../../src/services/fs/projectArchiveFixtureFiles');
  return { buildProjectFolderName: core.buildProjectFolderName, projectArchiveFixtureDirectory: fixture.projectArchiveFixtureDirectory };
});
vi.mock('../../src/services/projectModelNativeSafety', () => {
  const unused = () => { throw new Error('Unexpected native backup operation'); };
  return { getProjectModelMaintenanceLease: async () => memory.lease,
    verifyProjectModelMaintenanceLease: async (id: string) => { if (id !== memory.lease.leaseId) throw new Error('bad lease'); return memory.lease; },
    createNativeProjectModelBackupPort: unused, openNativeProjectModelBackupPort: unused,
    sealNativeProjectModelBackup: unused, verifyNativeProjectModelBackupSeal: unused, PROJECT_MODEL_NATIVE_ENTRY_LIMIT: 128 * 1024 * 1024 };
});
vi.mock('../../src/services/projectArchiveSerialization', () => ({ serializeProjectArchiveEntries: async (entries: Array<{ path: string; value: unknown }>) =>
  entries.map((entry) => ({ path: entry.path, content: JSON.stringify(entry.value) })) }));

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);
const descriptor = (path: string, bytes: Uint8Array): ArchiveAssetDigest => ({ path, bytes: bytes.byteLength, sha256: hash(bytes) });
function put(path: string, bytes: Uint8Array) {
  for (let index = path.indexOf('/', 1); index > 0; index = path.indexOf('/', index + 1)) memory.directories.add(path.slice(0, index));
  memory.files.set(path, Uint8Array.from(bytes));
}
const under = (directory: string) => [...memory.files].filter(([path]) => path.startsWith(directory + '/'))
  .map(([path, bytes]) => [path.slice(directory.length + 1), bytes] as const);
function archiveDigest(archive: MemoryArchive) {
  return hash(encode(JSON.stringify([archive.texts, [...archive.assets].map(([path, bytes]) => [path, Array.from(bytes)])])));
}
async function native(command: string, input: NativeInput) {
  if (command === 'inspect_project_archive_assets') {
    const files = new Map(under(input.assetsDir!));
    const aliases = new Map<string, string[]>(), firstByFolded = new Map<string, string>();
    for (const path of input.includeImportPaths ?? []) {
      const folded = path.toLowerCase(), first = firstByFolded.get(folded);
      if (first) {
        const candidates = [...files.keys()].filter((name) => name.toLowerCase() === folded);
        if (!input.resolveImportAliases || candidates.length !== 1) throw new Error('项目素材清单存在重复路径');
        aliases.set(first, [...(aliases.get(first) ?? []), path]);
      } else firstByFolded.set(folded, path);
    }
    const selected = input.selectedPaths ?? [...files.keys()].filter((path) => !/^imports\//i.test(path)
      || input.includeImportPaths === undefined || firstByFolded.has(path.toLowerCase()));
    for (const path of input.selectedPaths ?? firstByFolded.values()) if (!files.has(path)) throw new Error('missing selected asset');
    for (const reference of input.referencePaths ?? []) {
      const matching = selected.filter((path) => path.toLowerCase() === reference.toLowerCase());
      if (matching.length > 1) throw new Error('项目素材清单存在重复路径');
      const first = matching[0];
      if (first && first !== reference) {
        const paths = aliases.get(first) ?? [];
        if (!paths.includes(reference)) aliases.set(first, [...paths, reference]);
      }
    }
    return selected.map((path) => ({ ...descriptor(path, files.get(path)!), ...(aliases.has(path) ? { aliases: aliases.get(path) } : {}) }));
  }
  if (command === 'unpack_project_archive') {
    const archive = memory.archives.get(input.archivePath!); if (!archive || under(input.assetsDir!).length) throw new Error('not a fresh archive directory');
    for (const [path, bytes] of archive.assets) put(`${input.assetsDir}/${path}`, bytes);
    return { texts: structuredClone(archive.texts), assets: [...archive.assets].map(([path, bytes]) => descriptor(path, bytes)) };
  }
  if (command === 'publish_project_import_assets') {
    const directory = `${input.projectDir}/imports/${input.operationId}`;
    if (memory.directories.has(directory)) throw new Error('publish overwrite');
    const staged = input.assets!.map((asset) => {
      const source = input.sourceRoots!.find((item) => item.rootRef === asset.sourceRootRef); if (!source) throw new Error('missing source root');
      const bytes = memory.files.get(`${source.directory}/${asset.path}`);
      if (!bytes || bytes.byteLength !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error('source digest mismatch');
      return { path: `${directory}/${asset.destinationPath}`, bytes };
    });
    memory.directories.add(directory); for (const item of staged) put(item.path, item.bytes);
    if (memory.losePublish) { memory.losePublish = false; throw new Error('published response lost'); }
    return;
  }
  if (command === 'pack_project_archive') {
    if (memory.archives.has(input.outputPath!)) throw new Error('pack overwrite');
    for (const check of input.aliasChecks ?? []) {
      const source = input.sourceRoots!.find((item) => item.rootRef === check.rootRef); if (!source) throw new Error('missing source root');
      const matches = under(source.directory).filter(([path]) => path.toLowerCase() === check.path.toLowerCase());
      if (matches.length !== 1 || check.aliases.some((path) => path.toLowerCase() !== check.path.toLowerCase())
        || matches[0][1].byteLength !== check.bytes || hash(matches[0][1]) !== check.sha256) throw new Error('素材别名已变化');
    }
    const assets = new Map<string, Uint8Array>();
    for (const asset of input.expectedAssets!) {
      const source = input.sourceRoots!.find((item) => item.rootRef === asset.sourceRootRef); if (!source) throw new Error('missing export root');
      const bytes = memory.files.get(`${source.directory}/${asset.sourceRelativePath}`);
      if (!bytes || bytes.byteLength !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error('export digest mismatch');
      assets.set(asset.path, bytes.slice());
    }
    const archive = { texts: Object.fromEntries(input.entries!.map((entry) => [entry.path, entry.content])), assets };
    const receipt = { outputPath: input.outputPath!, publicationRef: `publication-${input.operationId}`, archiveSha256: archiveDigest(archive) };
    memory.archives.set(input.outputPath!, archive); memory.receipts.set(input.operationId!, receipt);
    if (memory.losePack) { memory.losePack = false; throw new Error('packed response lost'); }
    return { operationId: input.operationId, publicationRef: receipt.publicationRef, archiveSha256: receipt.archiveSha256 };
  }
  if (command === 'verify_project_archive_publication') {
    const receipt = memory.receipts.get(input.operationId!); if (!receipt) return { status: 'missing' };
    const archive = memory.archives.get(receipt.outputPath);
    if (!archive || archiveDigest(archive) !== receipt.archiveSha256 || input.publicationRef && input.publicationRef !== receipt.publicationRef) return { status: 'unknown' };
    return { status: 'published', operationId: input.operationId, publicationRef: receipt.publicationRef, archiveSha256: receipt.archiveSha256 };
  }
  throw new Error(`Unexpected mocked native command: ${command}`);
}
const opened = new Set<IDBDatabase>();
async function mutate(database: IDBDatabase, tables: string[], write: (tx: IDBTransaction) => void) {
  await new Promise<void>((resolve, reject) => { const tx = database.transaction(tables, 'readwrite'); write(tx); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
}
async function records(database: IDBDatabase, table: string) {
  return new Promise<unknown[]>((resolve, reject) => { const tx = database.transaction(table, 'readonly'), request = tx.objectStore(table).getAll();
    tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error); });
}
async function setup() {
  const factory = new IDBFactory();
  const original = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open(databaseName, 27);
    request.onupgradeneeded = () => { for (const name of ['projects', 'metadata', 'agentTasks', 'chatConversations', 'chatMessages', 'projectMemories']) request.result.createObjectStore(name, { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await mutate(original, ['projects', 'agentTasks', 'metadata'], (tx) => {
    tx.objectStore('projects').put({ id: 'unrelated', name: '原库保留项目', createdAt: 1, updatedAt: 1, nodes: [], edges: [], dataFolder: 'original-folder' });
    tx.objectStore('agentTasks').put({ id: 'paid-receipt', projectId: 'unrelated', status: 'paused', modelRounds: 8, toolCallCount: 11 });
    tx.objectStore('metadata').put({ id: 'mcp-operation:paid', sequence: 11, submitted: true });
  });
  const source = await readLegacyMigrationSnapshot(original, { localStorage: { getItem: () => '[]' } }); original.close();
  const backup = await createProjectModelBackup(source.source, { operationId: 'seed-backup', createdAt: 0 });
  const open = async () => {
    const database = await openProjectModelFixtureDatabase({ factory, name: databaseName }); opened.add(database); return database;
  };
  const database = await open(), staging = createProjectModelStagingRepository(database);
  await staging.prepare({ operationId: 'seed-migration', generation: 1, source: source.source, sourceDigest: await fingerprintProjectModelSource(backup.manifest),
    backupOperationId: 'seed-backup', backupManifestDigest: 'a'.repeat(64) });
  await staging.stageNextBatch({ operationId: 'seed-migration', batchSize: 500 }); await staging.verify({ operationId: 'seed-migration' });
  const session = await beginProjectModelFixtureBusinessSession(database, { operationId: 'seed-migration', generation: 1, sessionId: 'fixture-session' });
  return { database, session, open };
}
async function sourceArchive() {
  const shared = new Uint8Array([1, 2, 3]), episode = new Uint8Array([4, 5, 6, 7]), script = encode('分集中文剧本\n第二行');
  const files = [{ id: 'file-shared', rootRef: 'shared-root', relativePath: '同名.png', mediaId: 'media-shared' },
    { id: 'file-episode', rootRef: 'episode-root', relativePath: '同名.png', mediaId: 'media-episode' },
    { id: 'file-script', rootRef: 'episode-root', relativePath: 'manuscripts/剧本.txt', mediaId: 'media-script' }];
  const media = [{ id: 'media-shared', kind: 'image' as const, extension: 'png', bytes: shared.byteLength, sha256: hash(shared) },
    { id: 'media-episode', kind: 'image' as const, extension: 'png', bytes: episode.byteLength, sha256: hash(episode) },
    { id: 'media-script', kind: 'file' as const, extension: 'txt', bytes: script.byteLength, sha256: hash(script) }];
  const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '多根中文剧集', kind: 'series', storageRoots: [
    { id: 'shared-root', role: 'shared' }, { id: 'episode-root', role: 'canvas' }] },
    episodes: [{ id: 'E', projectId: 'P', canvasId: 'C', name: '第一集', orderRank: 0, displayNo: 1, settingsPolicy: { mode: 'inherit', overrides: {} } }],
    canvases: [{ id: 'C', projectId: 'P', episodeId: 'E', storageRootRef: 'episode-root', revisionScope: 'project',
      nodes: [{ id: 'image', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', relativePath: '同名.png', prompt: '同名.png 保留原正文' } }], edges: [], groups: [] }],
    contents: { project: { projectId: 'P', data: { script: '全剧中文稿', originalWork: { fileName: '同名.png', relativePath: '同名.png', addedAt: 1 } } },
      episodes: [{ episodeId: 'E', data: { script: '分集中文剧本\n第二行', storageRootRef: 'episode-root',
        scriptFile: { fileName: '剧本.txt', relativePath: 'manuscripts/剧本.txt', digest: hash(script) } } }] } };
  const snapshot = buildProjectExchangeSnapshotV2(business, 'integration-lineage', media, files), head = await createProjectExchangeRevisionV2(snapshot);
  const payload: ProjectArchivePayloadV4 = { ...business, exchange: { format: 'ai-canvas-project-exchange', version: 2, packageId: 'source-package', lineageId: snapshot.lineageId,
    head: { canonicalVersion: 2, revisionId: head.revisionId }, revisions: [head], ancestors: [], files: [
      { mediaId: 'media-shared', archivePath: 'assets/payload/shared.png' }, { mediaId: 'media-episode', archivePath: 'assets/payload/episode.png' },
      { mediaId: 'media-script', archivePath: 'assets/payload/episode-script.txt' }] }, history: { payload: {
      conversations: [{ id: 'conversation', projectId: 'P', archiveOriginId: 'b'.repeat(64), title: '分集工作台', titleSource: 'user',
        agentMode: 'plan', pinned: false, archived: false, messageCount: 1, createdAt: 1, updatedAt: 1 }],
      messages: [{ id: 'message', projectId: 'P', archiveOriginId: 'c'.repeat(64), conversationId: 'conversation', sequence: 0,
        role: 'assistant', content: '中文历史', status: 'done', createdAt: 1, updatedAt: 1 }],
      memories: [{ id: 'memory', projectId: 'P', archiveOriginId: 'd'.repeat(64), kind: 'fact', content: '原稿信息', enabled: true,
        source: { conversationId: 'conversation', messageId: 'message', unavailable: false }, createdAt: 1, updatedAt: 1 }],
    }, workbenchTargets: [{ conversationId: 'conversation', target: { state: 'active', kind: 'episode', projectId: 'P', episodeId: 'E' } }] } };
  const assets = new Map([['payload/shared.png', shared], ['payload/episode.png', episode], ['payload/episode-script.txt', script]]);
  const entries = await serializeProjectArchiveV4(payload, { packageId: 'source-package', exportedAt: 1 }, [...assets].map(([path, bytes]) => descriptor(path, bytes)));
  const archive = { texts: Object.fromEntries(entries.map((entry) => [entry.path, entry.content])), assets };
  memory.archives.set('/input/source.aicanvas', archive); return { archive, snapshot, shared, episode };
}
async function received(outputPath: string) {
  const archive = memory.archives.get(outputPath)!;
  return readProjectArchiveV4(archive.texts, [...archive.assets].map(([path, bytes]) => descriptor(path, bytes)));
}
async function imported() {
  const sample = await setup(); await sourceArchive();
  const incoming = await prepareProjectModelArchiveFixtureImport(sample.database, sample.session, { archivePath: '/input/source.aicanvas', operationId: 'first-preview' });
  const service = createProjectModelArchiveService(sample.database, sample.session, incoming.port);
  const operation = await service.apply(await service.preview(incoming.source), { operationId: 'first-import', mode: 'import-new', appendChat: true, appendMemories: true });
  return { ...sample, service, operation };
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  memory.files.clear(); memory.directories.clear(); memory.archives.clear(); memory.receipts.clear(); memory.directories.add(root);
  memory.losePublish = false; memory.losePack = false; memory.invoke.mockReset(); memory.invoke.mockImplementation(native);
});
afterEach(() => { for (const database of opened) database.close(); opened.clear(); vi.unstubAllGlobals(); });

describe('P6 v4真实fixture集成', () => {
  it('原生确认同一素材的大小写别名后可导出，保留旧文件身份', async () => {
    const sample = await imported(), capture = (await sample.service.repository.capture(sample.operation.targetProjectId))!;
    const canvas = capture.aggregate.canvases[0];
    const logicalRoot = capture.exchange!.identities.find((item) => item.kind === 'storage-root' && item.localId === canvas.storageRootRef)!.sourceId;
    const binding = capture.exchange!.fileBindings.find((item) => item.rootRef === logicalRoot && item.localRelativePath.startsWith('imports/'))!;
    const alias = binding.localRelativePath.replace(/^imports\//, 'Imports/');
    await createProjectModelBusinessRepository(sample.database, sample.session).saveCanvas({
      projectId: capture.aggregate.project.id, expectedProjectEpoch: capture.aggregate.project.epoch,
      canvasId: canvas.id, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: [...canvas.nodes, { id: 'case-alias', type: 'source-image', position: { x: 10, y: 10 },
        data: { type: 'source-image', relativePath: alias } }], edges: canvas.edges, groups: canvas.groups },
    });
    const exporter = createProjectModelArchiveService(sample.database, sample.session,
      createNativeProjectModelArchivePort(sample.database, sample.session, { outputPath: '/output/case-alias.aicanvas' }));
    await exporter.exportProject(capture.aggregate.project.id, 'case-alias-export');
    const calls = memory.invoke.mock.calls.filter(([command]) => command === 'inspect_project_archive_assets');
    const paths = calls.flatMap(([, input]) => input.includeImportPaths ?? []);
    expect(paths).toContain(binding.localRelativePath); expect(paths).toContain(alias);
    const exported = await received('/output/case-alias.aicanvas');
    expect(exported.files.find((file) => file.id === binding.id)).toMatchObject({ relativePath: binding.relativePath });
  });

  it.each([true, false])('大小写相似的不同文件（扫描前出现：%s）不能被合并发布', async (beforeScan) => {
    const sample = await imported(), capture = (await sample.service.repository.capture(sample.operation.targetProjectId))!;
    const canvas = capture.aggregate.canvases[0];
    const logicalRoot = capture.exchange!.identities.find((item) => item.kind === 'storage-root' && item.localId === canvas.storageRootRef)!.sourceId;
    const binding = capture.exchange!.fileBindings.find((item) => item.rootRef === logicalRoot && item.localRelativePath.startsWith('imports/'))!;
    const alias = binding.localRelativePath.replace(/^imports\//, 'Imports/');
    const folder = capture.aggregate.project.storageBindings.find((item) => item.rootRef === canvas.storageRootRef)!.folderName;
    const conflict = `${root}/project-model-fixture-assets/archive-integration/${folder}/${alias}`;
    await createProjectModelBusinessRepository(sample.database, sample.session).saveCanvas({
      projectId: capture.aggregate.project.id, expectedProjectEpoch: capture.aggregate.project.epoch,
      canvasId: canvas.id, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: [...canvas.nodes, { id: 'case-alias', type: 'source-image', position: { x: 10, y: 10 },
        data: { type: 'source-image', relativePath: alias } }], edges: canvas.edges, groups: canvas.groups },
    });
    if (beforeScan) put(conflict, new Uint8Array([9]));
    else memory.invoke.mockImplementation(async (command: string, input: NativeInput) => {
      if (command === 'pack_project_archive') put(conflict, new Uint8Array([9]));
      return native(command, input);
    });
    const exporter = createProjectModelArchiveService(sample.database, sample.session,
      createNativeProjectModelArchivePort(sample.database, sample.session, { outputPath: '/output/case-conflict.aicanvas' }));
    await expect(exporter.exportProject(capture.aggregate.project.id, 'case-conflict-export')).rejects.toThrow();
    expect(memory.archives.has('/output/case-conflict.aicanvas')).toBe(false);
  });

  it('普通素材的大小写引用经身份核实后仍可归档', async () => {
    const sample = await imported(), capture = (await sample.service.repository.capture(sample.operation.targetProjectId))!;
    const canvas = capture.aggregate.canvases[0], folder = capture.aggregate.project.storageBindings.find((item) => item.rootRef === canvas.storageRootRef)!.folderName;
    put(`${root}/project-model-fixture-assets/archive-integration/${folder}/CAPTURE.PNG`, new Uint8Array([5, 7]));
    await createProjectModelBusinessRepository(sample.database, sample.session).saveCanvas({
      projectId: capture.aggregate.project.id, expectedProjectEpoch: capture.aggregate.project.epoch,
      canvasId: canvas.id, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: [...canvas.nodes, { id: 'ordinary-alias', type: 'source-image', position: { x: 10, y: 10 },
        data: { type: 'source-image', relativePath: 'capture.png' } }], edges: canvas.edges, groups: canvas.groups },
    });
    const exporter = createProjectModelArchiveService(sample.database, sample.session,
      createNativeProjectModelArchivePort(sample.database, sample.session, { outputPath: '/output/ordinary-case.aicanvas' }));
    await exporter.exportProject(capture.aggregate.project.id, 'ordinary-case-export');
    const oldFile = (await received('/output/ordinary-case.aicanvas')).files.find((file) => file.relativePath === 'CAPTURE.PNG')!;
    expect(oldFile).toBeDefined();
    const saved = (await exporter.repository.capture(capture.aggregate.project.id))!, savedCanvas = saved.aggregate.canvases[0];
    await createProjectModelBusinessRepository(sample.database, sample.session).saveCanvas({
      projectId: saved.aggregate.project.id, expectedProjectEpoch: saved.aggregate.project.epoch,
      canvasId: savedCanvas.id, expectedCanvasEpoch: savedCanvas.epoch, expectedCanvasRevision: savedCanvas.revision,
      document: { nodes: savedCanvas.nodes.map((node) => node.id === 'ordinary-alias'
        ? { ...node, data: { ...node.data, relativePath: 'Capture.png' } } : node), edges: savedCanvas.edges, groups: savedCanvas.groups },
    });
    const again = createProjectModelArchiveService(sample.database, sample.session,
      createNativeProjectModelArchivePort(sample.database, sample.session, { outputPath: '/output/ordinary-case-again.aicanvas' }));
    await again.exportProject(capture.aggregate.project.id, 'ordinary-case-export-again');
    expect((await received('/output/ordinary-case-again.aicanvas')).files).toContainEqual(oldFile);
    const current = (await again.repository.capture(capture.aggregate.project.id))!;
    expect(current.exchange!.fileBindings.find((item) => item.id === oldFile.id)?.localRelativePath).toBe('CAPTURE.PNG');
  });

  it('逐root发布ACK丢失后重开数据库按原journal续行，保不同字节/原ID/历史，导出ACK丢失不重pack', async () => {
    const sample = await setup(), original = await sourceArchive(), legacyBefore = projectModelSourceToken(await records(sample.database, 'projects')),
      auditBefore = projectModelSourceToken(await records(sample.database, 'agentTasks'));
    const incoming = await prepareProjectModelArchiveFixtureImport(sample.database, sample.session, { archivePath: '/input/source.aicanvas', operationId: 'original-preview' });
    const first = createProjectModelArchiveService(sample.database, sample.session, incoming.port), preview = await first.preview(incoming.source);
    memory.losePublish = true;
    await expect(first.apply(preview, { operationId: 'resume-original', mode: 'import-new', appendChat: true, appendMemories: true })).rejects.toThrow('published response lost');
    const frozen = await first.repository.readImport('resume-original');
    expect(await first.repository.capture(frozen.targetProjectId)).toBeNull();
    sample.database.close(); const reopened = await sample.open();
    const outputPath = '/output/restarted.aicanvas';
    const service = createProjectModelArchiveService(reopened, sample.session, createNativeProjectModelArchivePort(reopened, sample.session,
      { incomingFolder: 'archive-previews/replacement-must-not-be-used', outputPath }));
    const committed = await service.resumeImport('resume-original');
    expect(committed.idMap).toEqual(frozen.idMap); expect(committed.sourceRef).toBe(frozen.sourceRef); expect(committed.sourceFiles).toEqual(frozen.sourceFiles);
    const callCount = memory.invoke.mock.calls.length; expect(await service.resumeImport('resume-original')).toEqual(committed); expect(memory.invoke).toHaveBeenCalledTimes(callCount);
    expect(memory.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets').map(([, input]) => input.operationId).sort())
      .toEqual(['resume-original-root-0', 'resume-original-root-1']);
    const capture = (await service.repository.capture(committed.targetProjectId, { history: true }))!;
    for (const [logicalRoot, bytes] of [['shared-root', original.shared], ['episode-root', original.episode]] as const) {
      const binding = capture.exchange!.fileBindings.find((item) => item.rootRef === logicalRoot && item.relativePath === '同名.png')!;
      const localRoot = capture.exchange!.identities.find((item) => item.kind === 'storage-root' && item.sourceId === logicalRoot)!.localId;
      const directory = capture.aggregate.project.storageBindings.find((item) => item.rootRef === localRoot)!.folderName;
      expect(memory.files.get(`${root}/project-model-fixture-assets/archive-integration/${directory}/${binding.localRelativePath}`)).toEqual(bytes);
    }
    expect(capture.history.map((item) => item.kind).sort()).toEqual(['conversation', 'memory', 'message']);
    expect(capture.aggregate.episodeContents[0].script).toBe('分集中文剧本\n第二行');
    memory.losePack = true; await expect(service.exportProject(committed.targetProjectId, 'export-original')).rejects.toThrow('packed response lost');
    expect((await service.repository.readExport('export-original')).phase).toBe('packing');
    expect((await service.recoverExport('export-original')).phase).toBe('registered');
    expect(memory.invoke.mock.calls.filter(([command]) => command === 'pack_project_archive')).toHaveLength(1);
    const exported = await received(outputPath);
    expect(exported.snapshot.entities).toEqual(original.snapshot.entities); expect(exported.snapshot.media).toEqual(original.snapshot.media);
    expect(exported.payload.history?.payload.messages[0].content).toBe('中文历史');
    expect(projectModelSourceToken(await records(reopened, 'projects'))).toBe(legacyBefore);
    expect(projectModelSourceToken(await records(reopened, 'agentTasks'))).toBe(auditBefore);
    expect((await createProjectModelBusinessRepository(reopened, sample.session).listProjects()).some((item) => item.id === 'unrelated')).toBe(true);
  });

  it.each(['Imports', 'IMPORTS'])('旧%s当前新文件纳入导出而失败残留不入包，同源重复更新保根与历史来源', async (directoryCase) => {
    const sample = await imported(), capture = (await sample.service.repository.capture(sample.operation.targetProjectId, { history: true }))!;
    const incoming = await prepareProjectModelArchiveFixtureImport(sample.database, sample.session, { archivePath: '/input/source.aicanvas', operationId: 'update-preview' });
    const update = createProjectModelArchiveService(sample.database, sample.session, incoming.port);
    const result = await update.apply(await update.preview(incoming.source, sample.operation.targetProjectId), { operationId: 'update-existing', mode: 'update-existing', appendChat: true, appendMemories: true });
    expect(result.next.project.storageBindings).toEqual(capture.aggregate.project.storageBindings);
    expect(result.next.project.storageRootRef).toBe(capture.aggregate.project.storageRootRef);
    expect((await update.repository.capture(result.targetProjectId, { history: true }))!.history).toHaveLength(3);
    const current = (await update.repository.capture(result.targetProjectId, { history: true }))!, canvas = current.aggregate.canvases[0];
    const rootBinding = current.aggregate.project.storageBindings.find((item) => item.rootRef === canvas.storageRootRef)!;
    const actualRoot = `${root}/project-model-fixture-assets/archive-integration/${rootBinding.folderName}`;
    put(`${actualRoot}/${directoryCase}/新图.png`, new Uint8Array([8, 8, 8])); put(`${actualRoot}/${directoryCase}/失败残留.png`, new Uint8Array([9, 9, 9]));
    await createProjectModelBusinessRepository(sample.database, sample.session).saveCanvas({ projectId: current.aggregate.project.id, expectedProjectEpoch: current.aggregate.project.epoch,
      canvasId: canvas.id, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: [...canvas.nodes, { id: 'new-image', type: 'source-image', position: { x: 10, y: 10 }, data: { type: 'source-image', relativePath: `${directoryCase}/新图.png` } }], edges: canvas.edges, groups: canvas.groups } });
    const outputPath = `/output/${directoryCase}.aicanvas`, exporter = createProjectModelArchiveService(sample.database, sample.session,
      createNativeProjectModelArchivePort(sample.database, sample.session, { outputPath }));
    await exporter.exportProject(current.aggregate.project.id, 'case-export');
    const exported = await received(outputPath);
    expect(exported.files.some((item) => item.relativePath === `${directoryCase}/新图.png`)).toBe(true);
    expect(exported.files.some((item) => item.relativePath.includes('失败残留'))).toBe(false);
    expect(exported.files.filter((item) => item.relativePath === '同名.png')).toHaveLength(2);
    const attachment = exported.files.find((item) => item.relativePath === `${directoryCase}/新图.png`)!, saved = (await exporter.repository.capture(current.aggregate.project.id))!, savedCanvas = saved.aggregate.canvases[0];
    await createProjectModelBusinessRepository(sample.database, sample.session).saveCanvas({ projectId: saved.aggregate.project.id, expectedProjectEpoch: saved.aggregate.project.epoch,
      canvasId: savedCanvas.id, expectedCanvasEpoch: savedCanvas.epoch, expectedCanvasRevision: savedCanvas.revision,
      document: { nodes: savedCanvas.nodes.filter((node) => (node as { id: string }).id !== 'new-image'), edges: savedCanvas.edges, groups: savedCanvas.groups } });
    const retainedPath = `/output/${directoryCase}-attachment.aicanvas`, retained = createProjectModelArchiveService(sample.database, sample.session,
      createNativeProjectModelArchivePort(sample.database, sample.session, { outputPath: retainedPath }));
    await retained.exportProject(current.aggregate.project.id, 'case-attachment-export');
    expect((await received(retainedPath)).files).toContainEqual(attachment);
  });

  it('删除最后一集保整剧/历史，零集包再导入再导出不复活分集', async () => {
    const sample = await imported(), capture = (await sample.service.repository.capture(sample.operation.targetProjectId, { history: true }))!, episode = capture.aggregate.episodes[0], canvas = capture.aggregate.canvases[0];
    await createProjectModelBusinessRepository(sample.database, sample.session).deleteEpisode({ projectId: capture.aggregate.project.id, expectedProjectEpoch: capture.aggregate.project.epoch,
      episodeId: episode.id, expectedEpisodeRevision: episode.revision, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision });
    const outputPath = '/output/zero.aicanvas', service = createProjectModelArchiveService(sample.database, sample.session,
      createNativeProjectModelArchivePort(sample.database, sample.session, { outputPath }));
    await service.exportProject(capture.aggregate.project.id, 'zero-export');
    const zero = await received(outputPath); expect(zero.payload.project.kind).toBe('series'); expect(zero.payload.episodes).toEqual([]); expect(zero.payload.canvases).toEqual([]);
    expect(zero.payload.contents.project.data.script).toBe('全剧中文稿');
    expect(zero.payload.history!.workbenchTargets[0].target).toEqual({ state: 'retired', kind: 'episode', projectId: 'P', id: 'E' });
    const preview = await prepareProjectModelArchiveFixtureImport(sample.database, sample.session, { archivePath: outputPath, operationId: 'zero-preview', outputPath: '/output/zero-again.aicanvas' });
    const receiver = createProjectModelArchiveService(sample.database, sample.session, preview.port);
    const importedZero = await receiver.apply(await receiver.preview(preview.source), { operationId: 'zero-import', mode: 'import-new', appendChat: true, appendMemories: true });
    expect(importedZero.targetProjectId).not.toBe(capture.aggregate.project.id); expect(importedZero.next.episodes).toEqual([]);
    await receiver.exportProject(importedZero.targetProjectId, 'zero-again-export');
    const again = await received('/output/zero-again.aicanvas'); expect(again.snapshot.entities).toEqual(zero.snapshot.entities);
    expect(again.payload.history!.workbenchTargets[0].target.state).toBe('retired');
    expect((await receiver.repository.capture(capture.aggregate.project.id))!.aggregate.episodes).toEqual([]);
  });
});
