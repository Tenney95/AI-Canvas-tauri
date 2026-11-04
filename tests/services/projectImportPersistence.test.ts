/** 项目包从预览到真实 IndexedDB 提交的往返；仅隔离原生文件 IO 和 Worker 传输。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ArchiveAssetDigest } from '../../src/services/projectExchangeDomain';
import type { ProjectArchiveChatPayload } from '../../src/services/projectTransferService';
import type { ProjectExchangeRevision, ProjectExchangeState } from '../../src/types/projectExchange';

const native = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), assets: new Map<string, Array<{ path: string; bytes: number; sha256: string }>>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, convertFileSrc: (value: string) => value }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open }));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: () => true, buildProjectFolderName: (name: string, id: string) => `${name}-${id}`,
  registerProjectFolder: vi.fn(), registerProjectFolders: vi.fn(), notifyProjectDiskChanged: vi.fn(),
  ensureProjectDataDir: async (id: string) => {
    const directory = `/projects/${id}`;
    if (!native.assets.has(directory)) native.assets.set(directory, []);
    return directory;
  },
  deleteProjectDataDir: async (id: string) => { native.assets.delete(`/projects/${id}`); },
}));
vi.mock('../../src/services/projectMergeWorkerClient', () => ({
  captureProjectSnapshot: async (...args: Parameters<typeof import('../../src/services/projectExchangeDomain').captureExchangeSnapshot>) =>
    (await import('../../src/services/projectExchangeDomain')).captureExchangeSnapshot(...args),
  compareProjectSnapshots: async (...args: Parameters<typeof import('../../src/services/projectMergeService').buildProjectMergePlan>) =>
    (await import('../../src/services/projectMergeService')).buildProjectMergePlan(...args),
}));

let archive: { texts: Record<string, string>; assets: ArchiveAssetDigest[] };
let database: IDBDatabase | undefined;
const cleanup: Array<() => Promise<void>> = [];
const sourceAssets: ArchiveAssetDigest[] = [
  { path: '人物/主图.png', bytes: 10, sha256: 'a'.repeat(64) },
  { path: '人物/另一别名.png', bytes: 10, sha256: 'a'.repeat(64) },
];

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('crypto', webcrypto);
  native.assets.clear(); native.open.mockResolvedValue('/incoming/project.aicanvas');
  native.invoke.mockImplementation(async (command: string, input: {
    assetsDir?: string; stagingDir?: string; projectDir?: string; operationId?: string;
    assets?: Array<ArchiveAssetDigest & { destinationPath: string }>;
  }) => {
    if (command === 'unpack_project_archive') {
      native.assets.set(input.assetsDir!, structuredClone(archive.assets));
      return structuredClone(archive);
    }
    if (command === 'inspect_project_archive_assets') return structuredClone(native.assets.get(input.assetsDir!) ?? []);
    if (command === 'publish_project_import_assets') {
      const source = native.assets.get(input.stagingDir!) ?? [], target = native.assets.get(input.projectDir!)!;
      for (const asset of input.assets ?? []) {
        expect(source).toContainEqual({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256 });
        target.push({ path: `imports/${input.operationId}/${asset.destinationPath}`, bytes: asset.bytes, sha256: asset.sha256 });
      }
      return undefined;
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
});
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  database?.close(); database = undefined; vi.unstubAllGlobals();
});

async function runtime() {
  const [service, repository, exchange, domain, format, schema, drama] = await Promise.all([
    import('../../src/services/projectImportService'), import('../../src/services/indexedDb/projectImportRepository'),
    import('../../src/services/indexedDb/projectExchangeRepository'), import('../../src/services/projectExchangeDomain'),
    import('../../src/services/projectExchangeFormat'), import('../../src/services/indexedDb/schema'), import('../../src/types/dramaAssets'),
  ]);
  database = await schema.openDB();
  return { service, repository, exchange, domain, format, drama, db: database };
}
type Runtime = Awaited<ReturnType<typeof runtime>>;
function sourceRecords(context: Runtime): ProjectSaveData[] {
  const owner: ProjectSaveData = { id: 'source', name: '整部剧', nodes: [
    { id: 'owner-node', type: 'ai-text', data: { type: 'ai-text', output: '剧集正文' } },
  ], edges: [], groups: [], createdAt: 1, updatedAt: 2, dramaAssets: context.drama.normalizeDramaAssetLibrary({ characters: [
    { id: 'character', kind: 'character', name: '主角', primaryReferenceImageId: 'primary', referenceImages: [
      { id: 'primary', kind: 'primary', relativePath: sourceAssets[0].path },
      { id: 'selected', relativePath: sourceAssets[1].path },
    ], voiceClips: [{ id: 'voice', audioUrl: 'https://example.com/voice.wav' }], actions: [
      { id: 'action', name: '行走', media: [{ id: 'action-image', kind: 'image', relativePath: sourceAssets[0].path }] },
    ] },
  ] }) };
  return [owner, ...[1, 2].map((number) => ({ id: `source-episode-${number}`, parentId: owner.id, name: `第${number}集`,
    episodeNo: number, episodeScript: `分集${number}剧本`, createdAt: 1, updatedAt: 2, edges: [], groups: [], nodes: [
      { id: `episode-node-${number}`, type: 'ai-image', data: { type: 'ai-image', relativePath: sourceAssets[number - 1].path,
        prompt: '@drama{character#selected:主角}' } },
    ] }))];
}
function histories(records: ProjectSaveData[]): ProjectArchiveChatPayload[] {
  return records.map((record, index): ProjectArchiveChatPayload => {
    const conversationId = `${record.id}-conversation`;
    return { conversations: [{ id: conversationId, projectId: record.id, title: record.name, titleSource: 'user', pinned: false,
      archived: false, agentMode: 'plan', messageCount: 1, createdAt: 1, updatedAt: 2 }],
    messages: [{ id: `${conversationId}-message`, projectId: record.id, conversationId, sequence: 0, role: 'user', content: `${record.name}的对话`,
      status: 'done', createdAt: 1, updatedAt: 2 }],
    memories: index === 0 ? [{ id: 'memory', projectId: record.id, kind: 'fact', content: '跨分集来源', enabled: true,
      source: { conversationId: `${records[1].id}-conversation`, messageId: `${records[1].id}-conversation-message` }, createdAt: 1, updatedAt: 2 }] : [] };
  });
}
async function prepare(context: Runtime, records: ProjectSaveData[], previous?: { state: ProjectExchangeState; revisions: ProjectExchangeRevision[] }) {
  const captured = context.domain.captureExchangeSnapshot(records, sourceAssets, previous?.state ?? null);
  const head = await context.format.createProjectExchangeRevision(captured.snapshot, previous ? [previous.state.headRevisionId] : []);
  const state: ProjectExchangeState = { ownerId: records[0].id, lineageId: captured.snapshot.lineageId, rootProjectId: captured.snapshot.rootProjectId,
    headRevisionId: head.revisionId, stateVersion: (previous?.state.stateVersion ?? 0) + 1, identities: captured.identities };
  const revisions = [...(previous?.revisions ?? []), head], payloads = histories(records);
  archive = { assets: sourceAssets, texts: {
    'manifest.json': JSON.stringify({ formatVersion: 3, exportedAt: 1, projectId: records[0].id, projectName: records[0].name, episodeCount: records.length - 1 }),
    'project.json': JSON.stringify(records[0]), 'chat.json': JSON.stringify(payloads[0]),
    'episodes.json': JSON.stringify(records.slice(1).map((project, index) => ({ project, chat: payloads[index + 1] }))),
    'exchange-state.json': JSON.stringify(state),
    'exchange.json': JSON.stringify({ format: 'ai-canvas-project-exchange', version: 1, packageId: 'package', lineageId: state.lineageId,
      headRevisionId: head.revisionId, revisions, ancestors: [], files: head.snapshot.media.map((descriptor) => {
        const file = head.snapshot.entities.find((entity) => entity.kind === 'file' && entity.data.mediaId === descriptor.id)!;
        return { mediaId: descriptor.id, archivePath: `assets/${captured.files.get(file.id)}` };
      }) }),
  } };
  const session = await context.service.prepareProjectImport();
  if (!session) throw new Error('项目包未准备完成');
  cleanup.push(() => context.service.closePreparedProjectImport(session));
  return { session, state, revisions };
}
async function rows<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly'), request = tx.objectStore(store).getAll();
    tx.oncomplete = () => resolve(request.result as T[]); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
async function assertExport(context: Runtime, ownerId: string) {
  const records = await context.repository.readProjectImportScope(ownerId), state = (await context.exchange.loadProjectExchangeState(ownerId))!;
  const graph = await context.exchange.loadProjectExchangeGraph(state.lineageId), head = graph.revisions.find((revision) => revision.revisionId === state.headRevisionId)!;
  const directory = `/projects/${ownerId}`, assets = native.assets.get(directory)!;
  expect(context.domain.captureExchangeSnapshot(records, assets, state, head.snapshot, directory).snapshot).toEqual(head.snapshot);
  const exported = await context.service.prepareExchangeExport(records, assets, directory);
  expect(exported.headRevisionId).toBe(head.revisionId);
  expect((await context.exchange.loadProjectExchangeState(ownerId))!.stateVersion).toBe(state.stateVersion + 1);
}

describe('项目包真实持久化导入', () => {
  it.each([false, true])('新建整部剧完成真实状态校验、事务与再次导出（独立副本=%s）', async (independent) => {
    const context = await runtime(), source = sourceRecords(context), incoming = await prepare(context, source);
    const result = await context.service.applyProjectImport(incoming.session, null, {}, { independent, appendChat: true, appendMemories: true });
    const records = await context.repository.readProjectImportScope(result.projectId), state = (await context.exchange.loadProjectExchangeState(result.projectId))!;
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.exchangeEpoch === 1)).toBe(true);
    expect(records.every((record) => !source.some((original) => original.id === record.id))).toBe(true);
    expect(records.slice(1).every((record) => record.parentId === result.projectId && record.dataFolder === result.dataFolder)).toBe(true);
    expect(state).toMatchObject({ ownerId: result.projectId, rootProjectId: source[0].id, stateVersion: 1 });
    expect(state.lineageId === incoming.state.lineageId).toBe(!independent);
    expect(state.identities.every((identity) => Object.keys(identity).sort().join(',') === 'id,kind,localId,scopeId')).toBe(true);
    expect(new Set(state.identities.filter((identity) => identity.kind === 'file').map((identity) => identity.localId)).size).toBe(2);
    expect(state.identities.map((identity) => identity.kind)).toEqual(expect.arrayContaining(['project', 'node', 'character', 'referenceImage', 'voiceClip', 'action', 'actionMedia']));
    const graph = await context.exchange.loadProjectExchangeGraph(state.lineageId);
    expect(graph.revisions).toHaveLength(1);
    expect(graph.revisions[0].revisionId).toBe(state.headRevisionId);
    expect(await rows(context.db, 'projectSummaries')).toHaveLength(3);
    const conversations = await rows<{ id: string; projectId: string; title: string }>(context.db, 'chatConversations');
    const messages = await rows<{ id: string; projectId: string; conversationId: string }>(context.db, 'chatMessages');
    const memories = await rows<{ projectId: string; source: { conversationId: string; messageId: string; unavailable: boolean } }>(context.db, 'projectMemories');
    expect(conversations).toHaveLength(3); expect(messages).toHaveLength(3); expect(memories).toHaveLength(1);
    const episodeConversation = conversations.find((conversation) => conversation.title === source[1].name)!;
    expect(memories[0]).toMatchObject({ projectId: result.projectId, source: { conversationId: episodeConversation.id,
      messageId: messages.find((message) => message.conversationId === episodeConversation.id)!.id, unavailable: false } });
    await assertExport(context, result.projectId);
  });

  it('更新已有整部剧时为新增分集和节点建立纯身份映射并通过真实 CAS 提交', async () => {
    const context = await runtime(), source = sourceRecords(context), initial = await prepare(context, source);
    const result = await context.service.applyProjectImport(initial.session, null, {}, { appendChat: true, appendMemories: true });
    const before = await context.repository.readProjectImportScope(result.projectId);
    const added: ProjectSaveData = { id: 'source-episode-3', parentId: source[0].id, name: '第三集', episodeNo: 3,
      createdAt: 1, updatedAt: 3, edges: [], groups: [], nodes: [{ id: 'new-node', type: 'ai-text', data: { type: 'ai-text', output: '新增正文' } }] };
    const incoming = await prepare(context, [...source, added], { state: initial.state, revisions: initial.revisions });
    const preview = await context.service.previewProjectImport(incoming.session, result.projectId);
    expect(preview.plan.alreadyApplied).toBe(false);
    expect(preview.plan.changes.some((change) => change.conflict)).toBe(false);
    await context.service.applyProjectImport(incoming.session, preview, {}, { appendChat: true, appendMemories: true });
    const records = await context.repository.readProjectImportScope(result.projectId), state = (await context.exchange.loadProjectExchangeState(result.projectId))!;
    expect(records).toHaveLength(4);
    expect(records.every((record) => record.exchangeEpoch === 2)).toBe(true);
    expect(before.every((record) => records.some((current) => current.id === record.id))).toBe(true);
    const episode = records.find((record) => record.name === added.name)!;
    expect(episode.id).not.toBe(added.id); expect(episode.parentId).toBe(result.projectId);
    expect(episode.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'new-node' })]));
    expect(state.stateVersion).toBe(2);
    expect(state.identities.find((identity) => identity.kind === 'project' && identity.id === added.id)?.localId).toBe(episode.id);
    expect(state.identities.find((identity) => identity.kind === 'node' && identity.id === 'new-node')).toEqual({
      kind: 'node', scopeId: added.id, id: 'new-node', localId: 'new-node',
    });
    expect(await rows(context.db, 'chatConversations')).toHaveLength(4);
    expect(await rows(context.db, 'chatMessages')).toHaveLength(4);
    expect(await rows(context.db, 'projectMemories')).toHaveLength(1);
    const recoveries = await context.repository.listProjectImportRecoveries(result.projectId);
    expect(recoveries).toHaveLength(1); expect(recoveries[0].records).toHaveLength(3); expect(recoveries[0].assets).toHaveLength(2);
    await assertExport(context, result.projectId);
  });
});
