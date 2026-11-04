/** 真正的导出文本交给收件预览与真实 IndexedDB 提交；仅隔离 Tauri IO 和 Worker 传输。 */
import { createHash, webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ArchiveAssetDigest } from '../../src/services/projectExchangeDomain';
import type { ProjectArchiveJsonEntry, ProjectArchiveTextEntry } from '../../src/services/projectArchiveSerialization';
import type { PreparedProjectImport } from '../../src/services/projectImportService';
import type { ProjectArchiveChatPayload } from '../../src/services/projectTransferService';
import type { ProjectExchangeBundle } from '../../src/types/projectExchange';

interface MemoryArchive { entries: ProjectArchiveTextEntry[]; files: Array<{ path: string; bytes: Uint8Array }> }
const native = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn(),
  files: new Map<string, Uint8Array>(), directories: new Set<string>(), archives: new Map<string, MemoryArchive>(), corruptSerialized: false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}` }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.10.25' }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => '/app', executableDir: async () => '/bin' }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open, save: native.save }));
vi.mock('@tauri-apps/plugin-fs', () => {
  const info = async (path: string) => {
    if (!native.files.has(path) && !native.directories.has(path)) throw new Error('ENOENT');
    return { isFile: native.files.has(path), isDirectory: native.directories.has(path), isSymlink: false,
      size: native.files.get(path)?.length ?? 0, mtime: new Date(1) };
  };
  return {
    exists: async (path: string) => native.files.has(path) || native.directories.has(path),
    mkdir: async (path: string) => { native.directories.add(path); }, stat: info, lstat: info,
    readFile: async (path: string) => { const bytes = native.files.get(path); if (!bytes) throw new Error('ENOENT'); return bytes.slice(); },
    writeFile: async (path: string, bytes: Uint8Array) => { native.files.set(path, bytes.slice()); },
    readDir: async () => [], open: vi.fn(), remove: vi.fn(), rename: vi.fn(), watch: async () => () => {},
  };
});
vi.mock('../../src/services/projectArchiveSerialization', () => ({
  serializeProjectArchiveEntries: async (values: ProjectArchiveJsonEntry[]) => values.map(({ path, value }) => ({ path,
    content: JSON.stringify(native.corruptSerialized && path === 'project.json' ? { ...(value as object), name: '序列化后被破坏的项目名' } : value) })),
}));
vi.mock('../../src/services/projectMergeWorkerClient', () => ({
  captureProjectSnapshot: async (...args: Parameters<typeof import('../../src/services/projectExchangeDomain').captureExchangeSnapshot>) =>
    (await import('../../src/services/projectExchangeDomain')).captureExchangeSnapshot(...args),
  compareProjectSnapshots: async (...args: Parameters<typeof import('../../src/services/projectMergeService').buildProjectMergePlan>) =>
    (await import('../../src/services/projectMergeService')).buildProjectMergePlan(...args),
}));

interface NativeInput { assetsDir?: string; outputPath?: string; archivePath?: string; stagingDir?: string; projectDir?: string;
  operationId?: string; path?: string; entries?: ProjectArchiveTextEntry[]; expectedAssets?: ArchiveAssetDigest[];
  includeImportPaths?: string[]; selectedPaths?: string[]; assets?: Array<ArchiveAssetDigest & { destinationPath: string }> }
const digest = (path: string, bytes: Uint8Array): ArchiveAssetDigest => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
function filesUnder(directory: string) {
  return [...native.files].filter(([path]) => path.startsWith(`${directory}/`))
    .map(([path, bytes]) => ({ path: path.slice(directory.length + 1), bytes }));
}
function storedArchive(path: string): MemoryArchive {
  const archive = native.archives.get(path); expect(archive).toBeDefined(); return archive!;
}
let database: IDBDatabase | undefined;
const sessions: PreparedProjectImport[] = [];
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, dispatchEvent: vi.fn() });
  native.files.clear(); native.directories.clear(); native.archives.clear(); native.corruptSerialized = false;
  let output = 0; native.save.mockImplementation(async () => `/exports/project-${++output}.aicanvas`);
  native.invoke.mockImplementation(async (command: string, input: NativeInput) => {
    if (command === 'inspect_project_archive_assets') return filesUnder(input.assetsDir!).filter(({ path }) =>
      input.selectedPaths !== undefined ? input.selectedPaths.includes(path)
        : !/^imports\//i.test(path) || input.includeImportPaths === undefined || input.includeImportPaths.includes(path))
      .map(({ path, bytes }) => digest(path, bytes));
    if (command === 'pack_project_archive') {
      expect(input.entries?.every((entry) => typeof entry.content === 'string')).toBe(true);
      const files = input.expectedAssets!.map((expected) => {
        const bytes = native.files.get(`${input.assetsDir}/${expected.path}`); expect(bytes).toBeDefined();
        expect(digest(expected.path, bytes!)).toEqual(expected);
        return { path: expected.path, bytes: bytes!.slice() };
      });
      // 后续 unpack 使用本次真实导出的全部文本与字节，不手写 exchange/state/manifest。
      native.archives.set(input.outputPath!, structuredClone({ entries: input.entries!, files }));
      return { assetCount: files.length, assetBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), archiveBytes: 100 };
    }
    if (command === 'unpack_project_archive') {
      expect(filesUnder(input.assetsDir!)).toHaveLength(0);
      const archive = storedArchive(input.archivePath!);
      for (const file of archive.files) native.files.set(`${input.assetsDir}/${file.path}`, file.bytes.slice());
      return { texts: Object.fromEntries(archive.entries.map((entry) => [entry.path, entry.content])),
        assets: archive.files.map((file) => digest(file.path, file.bytes)), assetPaths: archive.files.map((file) => file.path),
        assetBytes: archive.files.reduce((sum, file) => sum + file.bytes.length, 0) };
    }
    if (command === 'publish_project_import_assets') {
      const destination = `${input.projectDir}/imports/${input.operationId}`;
      expect(native.directories.has(destination)).toBe(false); native.directories.add(destination);
      for (const asset of input.assets!) {
        const bytes = native.files.get(`${input.stagingDir}/${asset.path}`); expect(bytes).toBeDefined();
        expect(digest(asset.path, bytes!)).toEqual({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256 });
        const target = `${destination}/${asset.destinationPath}`; expect(native.files.has(target)).toBe(false);
        native.files.set(target, bytes!.slice());
      }
      return null;
    }
    if (command === 'move_to_trash') {
      for (const path of native.files.keys()) if (path.startsWith(`${input.path}/`)) native.files.delete(path);
      for (const path of native.directories) if (path === input.path || path.startsWith(`${input.path}/`)) native.directories.delete(path);
      return null;
    }
    throw new Error(`Unexpected native IO: ${command}`);
  });
  // 完整应用文件服务的首次模块加载属于环境准备，不占用单个往返行为的执行预算。
  await runtime();
});
afterEach(async () => {
  const { closePreparedProjectImport } = await import('../../src/services/projectImportService');
  await Promise.all(sessions.splice(0).map(closePreparedProjectImport));
  database?.close(); database = undefined; vi.unstubAllGlobals();
});
async function runtime() {
  const [transfer, imports, records, exchange, schema, fs, storage, drama] = await Promise.all([
    import('../../src/services/projectTransferService'), import('../../src/services/projectImportService'),
    import('../../src/services/indexedDb/projectImportRepository'), import('../../src/services/indexedDb/projectExchangeRepository'),
    import('../../src/services/indexedDb/schema'), import('../../src/services/fileService'), import('../../src/services/storageService'), import('../../src/types/dramaAssets'),
  ]);
  database = await schema.openDB();
  return { transfer, imports, records, exchange, fs, storage, drama, db: await import('../../src/services/indexedDbService') };
}
type Runtime = Awaited<ReturnType<typeof runtime>>;
const project = (id = 'source'): ProjectSaveData => ({ id, name: '人间有差', nodes: [], edges: [], groups: [], dataFolder: 'source-folder', createdAt: 1, updatedAt: 2 });
async function seed(context: Runtime, records: ProjectSaveData[], files: Array<{ path: string; text: string }>) {
  context.fs.registerProjectFolders(records);
  const directory = (await context.fs.ensureProjectDataDir(records[0].id))!;
  for (const file of files) native.files.set(`${directory}/${file.path}`, new TextEncoder().encode(file.text));
  for (const record of records) await context.db.saveProjectToDb(record);
  return directory;
}
function archiveHistory(archive: MemoryArchive): ProjectArchiveChatPayload[] {
  const texts = Object.fromEntries(archive.entries.map((entry) => [entry.path, entry.content]));
  const episodes = texts['episodes.json'] ? JSON.parse(texts['episodes.json']) as Array<{ chat: ProjectArchiveChatPayload }> : [];
  return [JSON.parse(texts['chat.json']) as ProjectArchiveChatPayload, ...episodes.map((episode) => episode.chat)];
}
function archiveMedia(archive: MemoryArchive) {
  const bundle = JSON.parse(archive.entries.find((entry) => entry.path === 'exchange.json')!.content) as ProjectExchangeBundle;
  return bundle.revisions.find((revision) => revision.revisionId === bundle.headRevisionId)!.snapshot.media;
}
async function roundTrip(context: Runtime, source: ProjectSaveData[], independent = false) {
  const first = await context.transfer.exportProjectArchive(source.at(-1)!.id); expect(first).not.toBeNull();
  const archive = storedArchive(first!.filePath);
  const firstTexts = Object.fromEntries(archive.entries.map((entry) => [entry.path, entry.content]));
  expect(JSON.parse(firstTexts['manifest.json'])).toMatchObject({ formatVersion: 3, episodeCount: source.length - 1 });
  native.open.mockResolvedValueOnce(first!.filePath);
  const session = (await context.imports.prepareProjectImport())!; sessions.push(session);
  const imported = await context.imports.applyProjectImport(session, null, {}, { independent, appendChat: true, appendMemories: true });
  const records = await context.records.readProjectImportScope(imported.projectId);
  expect(records).toHaveLength(source.length);
  expect(records.every((record) => !source.some((original) => original.id === record.id))).toBe(true);
  expect(records.slice(1).every((record) => record.parentId === imported.projectId && record.dataFolder === imported.dataFolder)).toBe(true);
  const state = (await context.exchange.loadProjectExchangeState(imported.projectId))!;
  const sourceState = JSON.parse(firstTexts['exchange-state.json']) as { lineageId: string };
  expect(state.lineageId === sourceState.lineageId).toBe(!independent);
  // 真正加载相对素材、保存并重新加载，保留真实资产索引与写入代际检查。
  for (const record of records) {
    const loaded = (await context.storage.loadProjectData(record.id))!; expect(loaded).not.toBeNull();
    await context.storage.saveProject(loaded);
    expect(await context.storage.loadProjectData(record.id)).toMatchObject({ id: record.id, dataFolder: imported.dataFolder });
  }
  const second = await context.transfer.exportProjectArchive(imported.projectId); expect(second).not.toBeNull();
  const returned = storedArchive(second!.filePath);
  expect(returned.files.map((file) => digest('', file.bytes).sha256).sort()).toEqual(archive.files.map((file) => digest('', file.bytes).sha256).sort());
  expect(archiveMedia(returned)).toEqual(archiveMedia(archive));
  expect(archiveHistory(returned).flatMap((payload) => payload.messages.map((message) => message.content)).sort())
    .toEqual(archiveHistory(archive).flatMap((payload) => payload.messages.map((message) => message.content)).sort());
  native.open.mockResolvedValueOnce(second!.filePath);
  const reopened = (await context.imports.prepareProjectImport())!; sessions.push(reopened);
  expect(reopened.records).toHaveLength(source.length);
  return { imported, records, archive, returned, state };
}

it.each([false, true])('真实导出→预览→入库→保存重开→再次导出多分集、同字节别名和空附件（独立=%s）', async (independent) => {
  const context = await runtime(), owner = project();
  owner.dramaAssets = context.drama.normalizeDramaAssetLibrary({ characters: [{ id: 'character', name: '主角',
    referenceImages: [{ id: 'primary', kind: 'primary', relativePath: '人物/主图.png' }, { id: 'alias', relativePath: '人物/别名.png' }],
    primaryReferenceImageId: 'primary', voiceClips: [{ id: 'voice', audioUrl: 'https://example.invalid/global-voice.wav' }] }] });
  const source = [owner, ...[1, 2].map((number) => ({ ...project(`episode-${number}`), parentId: owner.id, episodeNo: number, name: `EP00${number}`,
    nodes: [{ id: `image-${number}`, type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '角色',
      relativePath: number === 1 ? '人物/主图.png' : '人物/别名.png', prompt: '@drama{character#alias:主角} @drama{global/shared:全局参考}' } }] }))];
  await seed(context, source, [{ path: '人物/主图.png', text: 'same image bytes' }, { path: '人物/别名.png', text: 'same image bytes' },
    { path: '文档/空原稿.md', text: '' }, { path: 'LICENSE', text: '' }, { path: 'png', text: 'extensionless bytes' }]);
  for (const record of source) {
    const conversationId = `${record.id}-conversation`;
    await context.db.putChatConversation({ id: conversationId, projectId: record.id, title: record.name, titleSource: 'user', pinned: false,
      archived: false, agentMode: 'plan', messageCount: 1, createdAt: 1, updatedAt: 2 });
    await context.db.putChatMessage({ id: `${conversationId}-message`, projectId: record.id, conversationId, sequence: 0,
      role: 'user', content: `来自${record.name}的正文`, status: 'done', createdAt: 1, updatedAt: 2 });
  }
  await context.db.putProjectMemory({ id: 'cross-episode-memory', projectId: owner.id, kind: 'fact', content: '根项目跨分集来源',
    enabled: true, source: { conversationId: 'episode-1-conversation', messageId: 'episode-1-conversation-message' }, createdAt: 1, updatedAt: 2 });
  const result = await roundTrip(context, source, independent);
  expect(result.archive.files).toHaveLength(5); expect(result.returned.files).toHaveLength(5);
  expect(archiveMedia(result.archive)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file', extension: 'bin', bytes: 0 }),
    expect.objectContaining({ kind: 'file', extension: 'bin', bytes: new TextEncoder().encode('extensionless bytes').length })]));
  expect(archiveHistory(result.returned).flatMap((payload) => payload.messages)).toHaveLength(3);
  const episode = result.records.find((record) => record.name === 'EP001')!;
  const conversations = await context.db.getProjectConversations(episode.id);
  const messages = await context.db.getConversationMessages(conversations[0].id, 0, 10);
  const memories = await context.db.getProjectMemories(result.imported.projectId);
  expect(memories).toHaveLength(1);
  expect(memories[0]).toMatchObject({ content: '根项目跨分集来源', source: { conversationId: conversations[0].id, messageId: messages.messages[0].id, unavailable: false } });
  expect(archiveHistory(result.returned)[0].memories).toHaveLength(1);
  const restored = (await context.storage.loadProjectData(result.imported.projectId))!;
  expect(restored.dramaAssets?.characters[0].voiceClips?.[0].audioUrl).toBe('https://example.invalid/global-voice.wav');
});

it('当前 Imports 素材跨两次真实导出，未引用历史副本不进包', async () => {
  const context = await runtime(), owner = project();
  owner.nodes = [{ id: 'image', type: 'source-image', data: { type: 'source-image', relativePath: 'Imports/current.png' } }];
  await seed(context, [owner], [{ path: 'Imports/current.png', text: 'current image' }, { path: 'imports/history/old.png', text: 'private old image' }]);
  const result = await roundTrip(context, [owner]);
  expect(result.archive.files.map((file) => file.path)).toEqual(['Imports/current.png']);
  expect(result.returned.files).toHaveLength(1);
});

it('空项目经真实导出与事务导入后仍可保存重开、再次导出', async () => {
  const context = await runtime(), owner = project(); await seed(context, [owner], []);
  const result = await roundTrip(context, [owner]); expect(result.returned.files).toHaveLength(0);
});

it('序列化后的业务投影被破坏时，真实收件门禁阻止 native pack', async () => {
  const context = await runtime(), owner = project(); await seed(context, [owner], []);
  native.corruptSerialized = true;
  await expect(context.transfer.exportProjectArchive(owner.id)).rejects.toThrow('项目包业务记录与协作快照不一致');
  expect(native.invoke.mock.calls.some(([command]) => command === 'pack_project_archive')).toBe(false);
  expect(native.archives.size).toBe(0);
});
