/** 回归现用归档的投影、校验和本机素材映射。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectArchiveBusinessV4, ProjectArchivePayloadV4, ValidatedProjectArchiveV4 } from '../../src/types/projectArchiveV4';
import type { ProjectExchangeMedia } from '../../src/types/projectExchange';
import type { ProjectModelTransferCapture } from '../../src/types/projectModelTransfer';
import {
  importProjectModelArchiveHistory,
  materializeProjectModelArchiveBusiness,
  prepareProjectModelArchiveCapture,
  readProjectModelArchive,
} from '../../src/services/projectModelArchiveService';
import { buildProjectExchangeSnapshotV2, readProjectArchiveV4, serializeProjectArchiveV4 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import { buildProjectMergePlanV2, resolveProjectMergeV2 } from '../../src/services/projectMergeV2Service';
import { readProjectArchiveContents } from '../../src/services/projectImportService';

vi.mock('../../src/services/projectImportService', () => ({ readProjectArchiveContents: vi.fn() }));
vi.mock('../../src/services/projectMergeWorkerClient', async () => {
  const { captureExchangeSnapshot } = await import('../../src/services/projectExchangeDomain');
  return { captureProjectSnapshot: vi.fn(async (...args: Parameters<typeof captureExchangeSnapshot>) => captureExchangeSnapshot(...args)) };
});
vi.mock('../../src/services/projectArchiveSerialization', () => ({ serializeProjectArchiveEntries: async (entries: Array<{ path: string; value: unknown }>) =>
  entries.map((entry) => ({ path: entry.path, content: JSON.stringify(entry.value) })) }));

const hash = 'a'.repeat(64);
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
async function seedNativeArchive(source: ValidatedProjectArchiveV4, operationId: string) {
  const projectId = 'p2-00000000-0000-4000-8000-000000000001';
  let nextId = 1;
  const allocateId = vi.fn((kind: 'episode' | 'canvas' | 'storage-root') => {
    const prefix = { episode: 'e2', canvas: 'c2', 'storage-root': 'r2' } as const;
    return `${prefix[kind]}-00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  });
  const native = { allocateId, folderName: `project-${projectId}` };
  const material = await materializeProjectModelArchiveBusiness(source.payload, source.snapshot, null, projectId, operationId, undefined, native);
  const exchange = { lineageId: source.snapshot.lineageId, localHead: source.payload.exchange.head, stateVersion: 1,
    bundle: source.payload.exchange, identities: material.identities, fileBindings: material.fileBindings, published: [] };
  const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'native-capture', sessionRevision: 0,
    sourceToken: 'snapshot', aggregate: material.aggregate, exchange, history: [], historyBindings: [], includesHistory: true };
  const assets = material.media.map((item) => ({ ...item, path: item.relativePath }));
  return { capture, exchange, assets, native };
}

async function asArchive(value: Awaited<ReturnType<typeof prepareProjectModelArchiveCapture>>) {
  const packed = value.payload.exchange.files.map((file) => {
    const media = value.snapshot.media.find((item) => item.id === file.mediaId)!;
    return { path: file.archivePath.slice(7), bytes: media.bytes, sha256: media.sha256 };
  });
  const texts = textsOf(await serializeProjectArchiveV4(value.payload, { packageId: value.payload.exchange.packageId, exportedAt: 1 }, packed));
  return readProjectArchiveV4(texts, packed);
}

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.unstubAllGlobals(); });
describe('项目归档投影', () => {
  it('filePath-only 的 macOS Unicode 路径只按本轮原生同根别名映射，不改写源记录', async () => {
    const { capture, assets } = await seedNativeArchive(await archive(), 'unicode-seed');
    const canvas = capture.aggregate.canvases[0];
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
    const { capture, assets } = await seedNativeArchive(await archive(), 'wrong-root-seed');
    const canvas = capture.aggregate.canvases[0];
    const actual = 'media/cafe\u0301.png', alias = 'media/caf\u00e9.png', root = '/Users/private/项目素材/作品';
    capture.exchange = null;
    const node = canvas.nodes[0] as { data: Record<string, unknown> };
    delete node.data.relativePath; node.data.filePath = `${root}/${alias}`;
    const other = assets.find((asset) => asset.rootRef !== canvas.storageRootRef)!;
    await expect(prepareProjectModelArchiveCapture(capture, [...assets,
      { ...other, path: actual, aliases: [alias], localAbsolutePath: `${root}/${actual}` }]))
      .rejects.toThrow('未证明来源');
  });

  it('AAC、Opus 和 PCM 随输出历史往返，旧媒体身份及冻结备份可继续核验', async () => {
    const { capture, assets } = await seedNativeArchive(await archive(), 'audio-seed');
    const canvas = capture.aggregate.canvases[0];
    const rootRef = capture.aggregate.project.storageRootRef;
    const legacyAudio: ProjectExchangeMedia[] = ['aac', 'opus', 'pcm'].map((extension, index) => ({
      id: `${String(index + 1).repeat(64)}_${extension}`, kind: 'file', extension, bytes: 4,
      sha256: String(index + 1).repeat(64),
    }));
    const audioAssets = legacyAudio.map(({ extension, sha256, bytes }) => ({ rootRef, sha256, bytes, path: `audio/result.${extension.toUpperCase()}` }));
    const archiveAssets = [...assets, ...audioAssets];

    const legacy = await prepareProjectModelArchiveCapture(capture, archiveAssets, legacyAudio);
    expect(legacy.snapshot.media).toEqual(expect.arrayContaining(legacyAudio));
    capture.exchange = legacy.exchange;
    const reconstructed = await prepareProjectModelArchiveCapture(capture, archiveAssets, legacy.snapshot.media);
    expect(reconstructed.snapshot).toEqual(legacy.snapshot);

    capture.history = audioAssets.map((asset, index) => ({ kind: 'output', sourceNamespace: 'native:audio', archiveOriginId: '', value: {
      id: `audio-history-${index}`, projectId: canvas.id, nodeId: 'audio-node', nodeType: 'ai-audio', nodeLabel: '旁白', timestamp: 1,
      prompt: '旁白', output: '', relativePath: asset.path, storageRootRef: asset.rootRef, status: 'success',
    } }));
    const current = await prepareProjectModelArchiveCapture(capture, archiveAssets);
    const descriptors = current.snapshot.media.filter((entry) => entry.kind === 'audio');
    expect(descriptors).toEqual(expect.arrayContaining(legacyAudio.map((entry) => ({ ...entry, kind: 'audio', id: `audio_${entry.id}` }))));
    expect(current.exchange.bundle.revisions).toEqual(expect.arrayContaining(legacy.exchange.bundle.revisions));
    expect(current.exchange.fileBindings).toEqual(legacy.exchange.fileBindings);

    const plan = await buildProjectMergePlanV2(legacy.snapshot, current.snapshot, legacy.snapshot);
    expect(resolveProjectMergeV2(plan, {}).media).toEqual(current.snapshot.media);
    const packageAssets = current.exchange.bundle.files.map((file) => {
      const media = current.snapshot.media.find((item) => item.id === file.mediaId)!;
      return { path: file.archivePath.slice('assets/'.length), bytes: media.bytes, sha256: media.sha256 };
    });
    const entries = await serializeProjectArchiveV4(current.payload, { packageId: current.exchange.bundle.packageId, exportedAt: 1 }, packageAssets);
    const readBack = await readProjectArchiveV4(textsOf(entries), packageAssets);
    expect(readBack.snapshot).toEqual(current.snapshot);
    expect(readBack.payload.history?.payload.outputs).toHaveLength(3);
  });

  it('新项目输出历史经归档映射原画布、旧节点与素材根，导入保持快照且重复更新只绑定既有记录', async () => {
    const { capture, assets } = await seedNativeArchive(await archive(), 'output-seed');
    const canvas = capture.aggregate.canvases[0];
    const binding = capture.exchange!.fileBindings.find((item) => item.id === 'F2')!;
    const root = capture.exchange!.identities.find((item) => item.kind === 'storage-root' && item.sourceId === binding.rootRef)!.localId;
    capture.history = [{ kind: 'output', sourceNamespace: 'native:test', archiveOriginId: '', value: {
      id: 'original-history', projectId: canvas.id, nodeId: 'deleted-node', nodeType: 'ai-image', nodeLabel: '原图', timestamp: 1,
      prompt: '生成当时的提示词', output: 'asset://original', mediaUrl: 'asset://original', filePath: '/isolated/private.png',
      relativePath: binding.localRelativePath, storageRootRef: root, model: 'general/original', provider: 'fixture', status: 'success',
      recoveryTask: { taskId: 'never-execute' }, params: { aspectRatio: '1:1', originalInputUnavailable: true } } }];
    const archived = await asArchive(await prepareProjectModelArchiveCapture(capture, assets));
    const output = archived.payload.history!.payload.outputs![0];
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

  it('原助手媒体按分集根归档，新项目只绑定发布文件，副本仍可再次归档', async () => {
    const source = await archive();
    let nextId = 1;
    const allocateId = (kind: 'episode' | 'canvas' | 'storage-root') => {
      const prefix = kind === 'episode' ? 'e2' : kind === 'canvas' ? 'c2' : 'r2';
      return `${prefix}-00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
    };
    const localId = 'p2-00000000-0000-4000-8000-000000000001';
    const native = { allocateId, folderName: `project-${localId}` };
    const original = await materializeProjectModelArchiveBusiness(source.payload, source.snapshot, null, localId, 'first-import', undefined, native);
    const child = original.aggregate.canvases[0];
    const conversationId = 'original-chat', messageId = 'original-message', operationId = '11111111-1111-4111-8111-111111111111';
    const sha256 = 'b'.repeat(64), relativePath = `media/${sha256}.mp4`;
    const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'native-capture', sessionRevision: 0,
      sourceToken: 'snapshot', aggregate: original.aggregate, exchange: null, historyBindings: [], includesHistory: true,
      history: [
        { kind: 'conversation', sourceNamespace: 'lineage', archiveOriginId: '', value: { id: conversationId, projectId: child.id,
          title: '助手媒体', titleSource: 'user', pinned: false, archived: false, agentMode: 'plan', messageCount: 1, createdAt: 1, updatedAt: 1 } },
        { kind: 'message', sourceNamespace: 'lineage', archiveOriginId: '', value: { id: messageId, projectId: child.id,
          conversationId, sequence: 0, role: 'assistant', status: 'done', content: '已生成', createdAt: 1, updatedAt: 1,
          agentTaskId: 'original-task', mediaStatus: 'succeeded', mediaResult: { id: `native-media-${operationId}`, sourceUrl: relativePath,
            kind: 'video', persistence: 'saved', url: 'https://example.test/transient-source', taskReceipt: { taskId: 'private-receipt' } } } },
      ], nativeMediaResults: [{ operationId, canvasId: child.id, storageRootRef: child.storageRootRef, delivered: true, relativePath,
        category: 'video', providerConfigId: 'provider', createdAt: 1, bytes: 9, sha256,
        origin: { conversationId, messageId, agentTaskId: 'original-task', deliveryMode: 'chat' } }] };
    const assets = [...original.media.map((item) => ({ ...item, path: item.relativePath })),
      { rootRef: original.aggregate.project.storageRootRef, path: relativePath, bytes: 8, sha256: 'c'.repeat(64) },
      { rootRef: child.storageRootRef, path: relativePath, bytes: 9, sha256 }];
    const prepared = await prepareProjectModelArchiveCapture(capture, assets);
    const portable = await asArchive(prepared);
    const card = portable.payload.history!.mediaCards![0];
    expect(card).toEqual({ messageId, kind: 'video', fileId: portable.files.find((file) => file.relativePath === relativePath
      && portable.snapshot.media.some((item) => item.id === file.mediaId && item.sha256 === sha256))!.id });
    expect(JSON.stringify(portable.payload.history)).not.toMatch(/original-task|private-receipt|transient-source/);
    await expect(asArchive({ ...prepared, payload: { ...prepared.payload, history: { ...prepared.payload.history!,
      mediaCards: [{ ...card, kind: 'audio' }] } } })).rejects.toThrow('助手媒体卡片');

    const copiedId = 'p2-00000000-0000-4000-8000-000000000002';
    const copy = await materializeProjectModelArchiveBusiness(portable.payload, portable.snapshot, null, copiedId, 'copy-import', undefined,
      { allocateId, folderName: `project-${copiedId}` });
    const history = await importProjectModelArchiveHistory(portable, copiedId, portable.snapshot.lineageId, null,
      { appendChat: true, appendMemories: true }, { identities: copy.identities, ...copy.aggregate, fileBindings: copy.fileBindings });
    const copied = history.find((row) => row.kind === 'message')!.value;
    expect(copied).toMatchObject({ content: '已生成', archiveMedia: { fileId: card.fileId, kind: 'video', bytes: 9, sha256,
      storageRootRef: copy.aggregate.canvases[0].storageRootRef, relativePath: expect.stringMatching(/^imports\/copy-import-root-1\//) } });
    expect(copied).not.toHaveProperty('mediaResult');
    expect(copied).not.toHaveProperty('agentTaskId');
    const exchange = { lineageId: portable.snapshot.lineageId, localHead: portable.payload.exchange.head, stateVersion: 1,
      bundle: portable.payload.exchange, identities: copy.identities, fileBindings: copy.fileBindings, published: [] };
    const exportedAgain = await asArchive(await prepareProjectModelArchiveCapture({ ...capture, aggregate: copy.aggregate,
      exchange, history, nativeMediaResults: [] }, copy.media.map((item) => ({ ...item, path: item.relativePath }))));
    expect(exportedAgain.payload.history!.mediaCards).toEqual([{ ...card, messageId: copied.id }]);
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
    const source = await archive();
    const { capture, exchange, assets } = await seedNativeArchive(source, 'first-import');
    const { project, content } = capture.aggregate;
    expect(project.id).not.toBe('P');
    expect(exchange.fileBindings.map((item) => item.id)).toEqual(['F1', 'F2']);
    expect(exchange.fileBindings.every((item) => item.localRelativePath.startsWith('imports/first-import-root-'))).toBe(true);
    expect(content.script).toBe('same.png');
    expect(content.storyGraph?.revision).toBe(0);
    expect(project.storageBindings[0].folderName).toBe(project.dataFolder);
    const exported = await asArchive(await prepareProjectModelArchiveCapture(capture, assets));
    const head = exported.payload.exchange.revisions.find((item) => item.revisionId === exported.payload.exchange.head.revisionId)!;
    const importedHead = exchange.bundle.revisions.find((item) => item.revisionId === exchange.localHead.revisionId)!;
    expect(head.contentDigest).toBe(importedHead.contentDigest);
    expect(exported.files).toEqual(source.files);
    expect(exported.snapshot.media).toEqual(source.snapshot.media);
    expect(JSON.stringify(exported.payload)).not.toContain('first-import');
  });

  it('同名异根更新保留本机绑定及物理文件，不重复分配已绑定的身份', async () => {
    const source = await archive();
    const { capture, exchange, native } = await seedNativeArchive(source, 'seed');
    const project = capture.aggregate.project;
    const allocations = native.allocateId.mock.calls.length;
    const updated = await materializeProjectModelArchiveBusiness(source.payload, source.snapshot, capture, project.id, 'update',
      { exchange, snapshot: source.snapshot }, native);
    expect(updated.aggregate.project.storageBindings).toEqual(project.storageBindings);
    expect(updated.aggregate.project.dataFolder).toBe(project.dataFolder);
    expect(updated.aggregate.project.storageRootRef).toBe(project.storageRootRef);
    expect(updated.fileBindings).toEqual(exchange.fileBindings);
    expect(updated.media).toEqual([]);
    expect(native.allocateId).toHaveBeenCalledTimes(allocations);
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
    const prepared = await prepareProjectModelArchiveCapture(capture, []);
    expect(prepared.exchange.identities.every((item) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.sourceId))).toBe(true);
    expect(prepared.exchange.identities.find((item) => item.kind === 'storage-root')!.localId).toBe('legacy-root:uuid');
    expect(JSON.stringify((await asArchive(prepared)).payload)).not.toContain('local:');
  });
  it('已导入会话的目标删除后转retired并读回，不能用旧binding重建活动分集', async () => {
    const { capture, assets } = await seedNativeArchive(await archive(), 'history-seed');
    capture.aggregate.project.kind = 'series'; capture.aggregate.canvases = [];
    capture.exchange!.identities.push({ kind: 'episode', sourceId: 'deleted-episode', localId: 'deleted-local' });
    capture.history.push({ kind: 'conversation', sourceNamespace: 'lineage', archiveOriginId: 'b'.repeat(64),
      historicalTarget: { state: 'active', kind: 'episode', projectId: 'P', episodeId: 'deleted-episode' },
      value: { id: 'history', projectId: capture.aggregate.project.id, title: '旧工作台', titleSource: 'user', agentMode: 'plan',
        archived: true, pinned: false, messageCount: 0, createdAt: 1, updatedAt: 1 } });
    const exported = await asArchive(await prepareProjectModelArchiveCapture(capture, assets));
    const target = exported.payload.history!.workbenchTargets[0].target;
    expect(target).toEqual({ state: 'retired', kind: 'episode', projectId: 'P', id: 'deleted-episode' });
    expect(exported.snapshot.historicalTargets).toContainEqual(target);
    expect(exported.payload.episodes).toEqual([]);
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
