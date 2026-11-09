/** 隔离新库与固定媒体核验替身；不访问真实数据或提交模型。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange } from '../../src/types/projectModelTransfer';
import { EXCHANGE, createNativeProject, openNativeProjectDatabase, readNativeProjectCapture,
  saveNativeCanvas, transact } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeMediaTask, listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { retainNativeMediaOutputs } from '../../src/services/indexedDb/nativeMediaCollectionRepository';
import { buildNativeMediaCollectionCanvas } from '../../src/services/nativeMediaCollectionCanvas';
import { commitNativeMediaDelivery, commitNativeMediaMessageDelivery } from '../../src/services/nativeMediaDelivery';
import { nativeOutputHistoryImportedFile, readNativeOutputHistory } from '../../src/services/nativeOutputHistory';
import { prepareProjectModelArchiveCapture } from '../../src/services/projectModelArchiveService';
import { readNativeProjectExchange, verifiedExchange } from '../../src/services/indexedDb/projectModelTransferRepository';
import { bindNativeMediaOrigin } from '../../src/services/nativeMediaOrigin';

vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: async () => {} }));
let factory: IDBFactory;
const files = [
  { category: 'image' as const, relativePath: `media/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64), bytes: 10 },
  { category: 'audio' as const, relativePath: `media/${'b'.repeat(64)}.mp3`, sha256: 'b'.repeat(64), bytes: 11 },
];
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());
async function fixture(chat = false) {
  const root = await createNativeProject({ name: '隔离历史' }, { factory });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'fixture-runtime', projectId: root.project.id,
    projectEpoch: root.project.epoch, canvasId: root.canvas!.id, canvasEpoch: root.canvas!.epoch, canvasRevision: 0, episodeId: null };
  const canvas = await saveNativeCanvas({ projectId: context.projectId, canvasId: context.canvasId, episodeId: null,
    expectedProjectEpoch: context.projectEpoch, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: 0,
    document: { nodes: [{ id: 'source', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image',
      label: '原节点', prompt: '原始杯子', model: 'general/frozen', imageQuality: 'low', aspectRatio: '1:1', status: 'loading',
      filePath: 'must-not-copy', workflowInputs: { private: 'must-not-copy' } } }], edges: [], groups: [] } }, { factory });
  const nodeId = chat ? `media-message-${crypto.randomUUID()}` : 'source';
  const releaseOrigin = chat ? bindNativeMediaOrigin(context.canvasId, nodeId,
    { conversationId: 'conversation', messageId: 'message', deliveryMode: 'chat' }) : () => {};
  let prepared: Awaited<ReturnType<typeof prepareNativeMediaTask>>;
  try {
    prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId, category: 'image',
      providerConfigId: 'fixture', providerBase: 'https://fixture.example', submissionKind: 'sync', fingerprintScheme: 'media-input-v3',
      modelRef: 'general/frozen', protocolDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64), inputFingerprint: 'c'.repeat(64),
      sourceCanvasRevision: canvas.revision,
    }, { factory });
  } finally { releaseOrigin(); }
  const record = await retainNativeMediaOutputs(prepared, files, { factory });
  const document = chat ? { nodes: canvas.nodes, edges: canvas.edges, groups: canvas.groups } : buildNativeMediaCollectionCanvas(canvas, record);
  return { root, context, canvas, record, document };
}
async function mutate(work: (store: IDBObjectStore) => void) {
  const database = await openNativeProjectDatabase(false, { factory });
  try { await transact(database!, 'readwrite', { factory }, async (tx) => work(tx.objectStore(EXCHANGE)), [EXCHANGE]); }
  finally { database?.close(); }
}
async function outboxCount() {
  const database = await openNativeProjectDatabase(false, { factory });
  try { return await transact(database!, 'readonly', { factory }, (tx) => new Promise<number>((resolve, reject) => {
    const request = tx.objectStore(EXCHANGE).count(IDBKeyRange.bound('output-history:', 'output-history:\uffff'));
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  }), [EXCHANGE]); } finally { database?.close(); }
}
async function importedExchange(projectId: string, paths: string[]): Promise<ProjectModelTransferExchange> {
  const source = await readNativeProjectCapture(projectId, { factory });
  if (!source) throw new Error('fixture项目不存在');
  const aggregate = source.aggregate;
  const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'fixture', sessionRevision: source.changeRevision,
    sourceToken: 'f'.repeat(64), includesHistory: false, exchange: null, history: [], historyBindings: [],
    aggregate: { project: aggregate.project, content: aggregate.content, episodes: aggregate.episodes, episodeContents: aggregate.episodeContents,
      canvases: aggregate.canvases.map((canvas) => ({ ...canvas, nodes: [], edges: [], groups: [] })), previews: [], bindings: [] } };
  const prepared = await prepareProjectModelArchiveCapture(capture, files.map((file) => ({ rootRef: aggregate.project.storageRootRef,
    path: file.relativePath, bytes: file.bytes, sha256: file.sha256 })));
  for (const binding of prepared.exchange.fileBindings) {
    const ordinal = files.findIndex((file) => file.relativePath === binding.relativePath);
    if (ordinal < 0) throw new Error('fixture文件绑定缺失');
    binding.localRelativePath = paths[ordinal];
  }
  // 使用真实构造、摘要和完整合同校验，不能靠不完整手写bundle绕过业务依赖。
  await verifiedExchange(prepared.exchange);
  return readNativeProjectExchange(prepared.exchange)!;
}

it('完整混合产物与原输入快照同事务提交，改稿后历史仍保留且重复交付不重复记录', async () => {
  const { root, context, canvas, record, document } = await fixture();
  const input = { record, document, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0 };
  await commitNativeMediaDelivery(input, { factory });
  await commitNativeMediaDelivery(input, { factory });
  let rows = await readNativeOutputHistory(context.canvasId, { factory });
  expect(rows).toHaveLength(2); expect(await outboxCount()).toBe(2);
  expect(rows[0]).toMatchObject({ ownerProjectId: context.projectId, rootRef: root.project.storageRootRef,
    entry: { prompt: '原始杯子', model: 'general/frozen', provider: 'fixture', params: { imageQuality: 'low', aspectRatio: '1:1' } } });
  expect(rows.map((row) => row.entry.nodeType)).toEqual(['ai-image', 'ai-audio']);
  expect(JSON.stringify(rows)).not.toContain('must-not-copy');
  const current = (await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0];
  await saveNativeCanvas({ projectId: context.projectId, canvasId: context.canvasId, episodeId: null,
    expectedProjectEpoch: context.projectEpoch, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: current.revision,
    document: { nodes: current.nodes.map((node) => ({ ...(node as object), data: { ...(node as { data: object }).data, prompt: '用户新稿', imageQuality: 'high' } })),
      edges: [], groups: [] } }, { factory });
  rows = await readNativeOutputHistory(context.canvasId, { factory });
  expect(rows[0].entry.prompt).toBe('原始杯子'); expect(rows[0].entry.params?.imageQuality).toBe('low');
});

it('历史发件箱失败时画布和原回执一起回滚', async () => {
  const { context, canvas, record, document } = await fixture();
  const id = `hist-native-${context.canvasId}-${record.operationId}-0`;
  await mutate((store) => { store.put({ projectId: `output-history:${id}`, kind: 'corrupt' }); });
  await expect(commitNativeMediaDelivery({ record, document, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0 }, { factory }))
    .rejects.toThrow('历史身份无效');
  expect((await listNativeMediaTasks(context.projectId, { factory }))[0].status).toBe('submitted');
  const current = (await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0];
  expect(current.revision).toBe(canvas.revision); expect(current.nodes).toHaveLength(1);
});

it('既有delivered回执只读补记，未知原稿留空，不修改账本或创建outbox', async () => {
  const { context, canvas, record, document } = await fixture();
  await commitNativeMediaDelivery({ record, document, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0 }, { factory });
  await mutate((store) => { for (const ordinal of [0, 1]) store.delete(`output-history:hist-native-${context.canvasId}-${record.operationId}-${ordinal}`); });
  const before = await listNativeMediaTasks(context.projectId, { factory });
  const rows = await readNativeOutputHistory(context.canvasId, { factory });
  expect(rows).toHaveLength(2); expect(rows.every((row) => row.entry.prompt === '' && row.entry.params?.originalInputUnavailable)).toBe(true);
  expect(rows[0].entry.timestamp).toBe(record.createdAt); expect(await outboxCount()).toBe(0);
  expect(await listNativeMediaTasks(context.projectId, { factory })).toEqual(before);
});

it('旧导入产物只按artifact与摘要文件身份补记，不捏造提示词和生成时间', async () => {
  const { context, canvas, record, document } = await fixture();
  await commitNativeMediaDelivery({ record, document, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0 }, { factory });
  await mutate((store) => {
    store.delete(record.projectId);
    for (const ordinal of [0, 1]) store.delete(`output-history:hist-native-${context.canvasId}-${record.operationId}-${ordinal}`);
  });
  const rows = await readNativeOutputHistory(context.canvasId, { factory });
  expect(rows).toHaveLength(2);
  expect(rows[0].entry).toMatchObject({ timestamp: 0, prompt: '', params: { originalInputUnavailable: true, originalTimestampUnavailable: true } });
  expect(await outboxCount()).toBe(0);
});

it('导入发布路径按根与fileId的exchange绑定只读补记，同名路径和错误类别不能冒认', async () => {
  const { root, context, canvas, record, document } = await fixture();
  await commitNativeMediaDelivery({ record, document, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0 }, { factory });
  const paths = files.map((file) => `imports/publication-root-0/${file.relativePath}`);
  const exchange = await importedExchange(context.projectId, paths);
  await mutate((store) => {
    store.delete(record.projectId);
    for (const ordinal of [0, 1]) store.delete(`output-history:hist-native-${context.canvasId}-${record.operationId}-${ordinal}`);
    store.put({ projectId: context.projectId, exchange });
  });
  const current = (await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0];
  await saveNativeCanvas({ projectId: context.projectId, canvasId: context.canvasId, episodeId: null,
    expectedProjectEpoch: context.projectEpoch, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: current.revision,
    document: { nodes: current.nodes.map((node, ordinal) => {
      const original = node as { id: string; data: Record<string, unknown> };
      const mediaKey = ordinal === 0 ? 'imageUrl' : 'audioUrl';
      return { ...original, data: { ...original.data, [mediaKey]: paths[ordinal], relativePath: paths[ordinal],
        sourceUrl: paths[ordinal], output: paths[ordinal] } };
    }), edges: [], groups: [] } }, { factory });
  const rows = await readNativeOutputHistory(context.canvasId, { factory });
  expect(rows.map((row) => row.relativePath)).toEqual(paths);
  expect(rows.map((row) => [row.sha256, row.bytes])).toEqual(files.map((file) => [file.sha256, file.bytes]));
  expect(rows.every((row) => row.entry.prompt === '' && row.entry.timestamp === 0)).toBe(true);
  expect(await outboxCount()).toBe(0);
  expect(nativeOutputHistoryImportedFile(exchange, `r2-${crypto.randomUUID()}`, paths[0], 'image')).toBeUndefined();
  expect(nativeOutputHistoryImportedFile(exchange, root.project.storageRootRef, paths[0].replace('root-0', 'root-1'), 'image')).toBeUndefined();
  expect(nativeOutputHistoryImportedFile(exchange, root.project.storageRootRef, paths[0], 'audio')).toBeUndefined();
  const duplicated = structuredClone(exchange); duplicated.fileBindings.push({ ...duplicated.fileBindings[0], id: 'other-file' });
  expect(nativeOutputHistoryImportedFile(duplicated, root.project.storageRootRef, paths[0], 'image')).toBeUndefined();
});

it('仅对话交付也留历史但不偷取画布节点输入，不创建额外画布节点', async () => {
  const { context, canvas, record } = await fixture(true);
  await commitNativeMediaMessageDelivery(record, files[0].relativePath, { factory });
  const rows = await readNativeOutputHistory(context.canvasId, { factory });
  expect(rows).toHaveLength(2); expect(rows[0].entry.prompt).toBe(''); expect(rows[0].entry.params?.originalInputUnavailable).toBe(true);
  const capture = await readNativeProjectCapture(context.projectId, { factory });
  expect(capture!.aggregate.canvases[0].nodes).toEqual(canvas.nodes);
});

it('旧ID及缺失的新库读取不创建项目库', async () => {
  expect(await readNativeOutputHistory('legacy-project', { factory })).toEqual([]);
  expect(await readNativeOutputHistory(`c2-${crypto.randomUUID()}`, { factory })).toEqual([]);
  expect(await factory.databases()).toEqual([]);
});
