/** 仅使用隔离fake IndexedDB；图片文件与新库账本由固定替身提供，不访问用户数据。 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import type { ChatMessageRecord } from '../../src/services/indexedDbService';
const io = vi.hoisted(() => ({ db: null as IDBDatabase | null, records: [] as NativeMediaTaskRecord[], verify: vi.fn(async () => {}) }));
vi.mock('../../src/services/indexedDbService', () => ({ putChatConversation: vi.fn(), getProjectConversations: vi.fn(),
  putChatMessageWithSequence: vi.fn(), getConversationMessages: vi.fn(), deleteConversationMessages: vi.fn() }));
vi.mock('../../src/services/indexedDb/schema', () => ({ openDB: async () => io.db!, STORE_CHAT_MESSAGES: 'messages', STORE_CHAT_CONVERSATIONS: 'conversations', STORE_METADATA: 'metadata' }));
vi.mock('../../src/services/fileService', () => ({ isTransientMediaUrl: () => false, persistMediaUrlToProjectData: vi.fn() }));
vi.mock('../../src/services/indexedDb/nativeMediaTaskRepository', () => ({ listNativeMediaTasks: async () => io.records }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: io.verify }));
vi.mock('../../src/services/chat/teams/teamProfileService', () => ({ normalizeExecutionSelection: (value: unknown) => value, normalizeTeamProfile: (value: unknown) => value }));
vi.mock('../../src/services/creationProfiles/creationProfileManifest', () => ({ restoreCreationProfileSelection: (value: unknown) => value }));
vi.mock('../../src/services/chat/workbenchConversationScope', () => ({ normalizeConversationWorkbenchTarget: (value: unknown) => value }));
import { getConversationMessages, putChatMessageWithSequence } from '../../src/services/indexedDbService';
import { loadMessages, persistMessage, projectNativeMediaMessageBatch } from '../../src/services/chat/chatHistoryService';

const op = '11111111-1111-4111-8111-111111111111';
const owner = 'p2-22222222-2222-4222-8222-222222222222', canvas = 'c2-33333333-3333-4333-8333-333333333333';
const receiptId = `native-media-message-projection:${op}`;
const extraId = `media-output-native-media-${op}-1`;
const root = () => ({ id: 'original-message', projectId: owner, conversationId: 'original-conversation', sequence: 0,
  role: 'assistant', content: '原消息正文', status: 'done', agentTaskId: 'original-agent', createdAt: 1, updatedAt: 1 });
async function write(store: string, value: unknown, id?: string) {
  await new Promise<void>((resolve, reject) => { const tx = io.db!.transaction(store, 'readwrite');
    if (id) tx.objectStore(store).delete(id); else tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); });
}
async function all(store: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => { const tx = io.db!.transaction(store, 'readonly'), read = tx.objectStore(store).getAll();
    tx.oncomplete = () => resolve(read.result); tx.onabort = tx.onerror = () => reject(tx.error); });
}
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange); io.verify.mockReset(); io.verify.mockResolvedValue(undefined);
  vi.mocked(getConversationMessages).mockReset(); vi.mocked(putChatMessageWithSequence).mockClear();
  io.db = await new Promise((resolve, reject) => { const request = new IDBFactory().open('fixture', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('conversations', { keyPath: 'id' }); request.result.createObjectStore('metadata', { keyPath: 'id' });
      request.result.createObjectStore('messages', { keyPath: 'id' }).createIndex('conversationId_sequence', ['conversationId', 'sequence']); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const files = ['a', 'b'].map((letter) => ({ relativePath: `media/${letter.repeat(64)}.png`, sha256: letter.repeat(64), bytes: 10 }));
  io.records = [{ projectId: `media-task:${op}`, kind: 'native-media-task-v1', operationId: op, ownerProjectId: owner, canvasId: canvas,
    episodeId: null, projectEpoch: 0, canvasEpoch: 0, sourceCanvasRevision: 0, nodeId: 'original-node', inputFingerprint: 'a'.repeat(64),
    fingerprintScheme: 'media-input-v2', requestFingerprint: 'b'.repeat(64), providerConfigId: 'apimart', providerBase: 'https://fixture.example',
    modelRef: 'apimart/model', protocolDigest: 'c'.repeat(64), submissionKind: 'async', category: 'image', status: 'delivered', remoteTaskId: 'remote-original',
    deliveryDigest: 'd'.repeat(64), committedCanvasRevision: 1, resultRelativePath: files[0].relativePath,
    lease: '44444444-4444-4444-8444-444444444444', revision: 4, createdAt: 1, updatedAt: 2,
    origin: { conversationId: 'original-conversation', messageId: 'original-message', agentTaskId: 'original-agent', deliveryMode: 'chat' },
    apimartImageBatch: { version: 1, requestedCount: 1, submissions: [{ id: '55555555-5555-4555-8555-555555555555', state: 'submitted', taskIds: ['remote-original'] }],
      tasks: [{ taskId: 'remote-original', state: 'completed', results: files }] } }];
  await write('conversations', { id: 'original-conversation', projectId: owner, title: '原会话', titleSource: 'user', pinned: false, archived: false,
    agentMode: 'autonomous', createdAt: 1, updatedAt: 1, messageCount: 1 });
  await write('messages', root());
});
afterEach(() => { io.db?.close(); vi.unstubAllGlobals(); });

it('全部候选与收据同事务稳定追加，重试和删除后均不重复或复活', async () => {
  const first = await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true);
  expect(first.created).toBe(true); expect(first.messages.map((row) => row.id)).toEqual(['original-message', extraId]);
  expect(first.messages[0].content).toBe('原消息正文');
  const stored = await all('messages');
  expect(stored.map((row) => (row.mediaResult as { url: string }).url).sort()).toEqual(io.records[0].apimartImageBatch!.tasks[0].results!.map((file) => file.relativePath).sort());
  expect((await all('metadata'))[0]).toMatchObject({ id: receiptId, state: 'committed' });
  expect((await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true)).created).toBe(false);
  expect(await all('messages')).toHaveLength(2);
  await write('messages', undefined, extraId);
  expect((await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true)).messages.map((row) => row.id)).toEqual(['original-message']);
  expect(await all('messages')).toHaveLength(1);
});
it('原消息已删除时记抑制收据，之后出现同ID也不自动重建候选', async () => {
  await write('messages', undefined, 'original-message');
  expect((await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true)).messages).toEqual([]);
  expect((await all('metadata'))[0]).toMatchObject({ state: 'suppressed' });
  await write('messages', root());
  expect((await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true)).messages).toEqual([]);
  expect(await all('messages')).toHaveLength(1);
});
it('任何候选文件核验失败都不写消息或收据', async () => {
  io.verify.mockRejectedValueOnce(new Error('candidate digest changed'));
  await expect(projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true)).rejects.toThrow('digest');
  expect(await all('metadata')).toHaveLength(0);
  expect((await all('messages'))[0].mediaResult).toBeUndefined();
});
it('通用混合媒体集合完整投影到原消息与稳定额外消息，类型和相对文件不丢失', async () => {
  const record = io.records[0];
  delete record.apimartImageBatch;
  record.category = 'audio'; record.providerConfigId = 'provider'; record.modelRef = 'workflow/frozen';
  record.localResults = [
    { category: 'audio', relativePath: `media/${'a'.repeat(64)}.mp3`, sha256: 'a'.repeat(64), bytes: 12 },
    { category: 'image', relativePath: `media/${'b'.repeat(64)}.png`, sha256: 'b'.repeat(64), bytes: 13 },
    { category: 'video', relativePath: `media/${'c'.repeat(64)}.mp4`, sha256: 'c'.repeat(64), bytes: 14 },
  ];
  record.resultRelativePath = record.localResults[0].relativePath;
  const projected = await projectNativeMediaMessageBatch(record, [undefined, undefined, undefined], () => true);
  expect(projected.messages.map((row) => row.mediaResult?.kind)).toEqual(['audio', 'image', 'video']);
  expect(projected.messages.map((row) => row.mediaResult?.sourceUrl)).toEqual(record.localResults.map((file) => file.relativePath));
  expect(projected.messages[0].content).toBe('原消息正文');
  expect(projected.messages[1].content).toContain('媒体产物');
  await write('messages', undefined, extraId);
  const repeated = await projectNativeMediaMessageBatch(record, [undefined, undefined, undefined], () => true);
  expect(repeated.messages).toHaveLength(2);
  expect(repeated.messages.some((message) => message.id === extraId)).toBe(false);
  expect(await all('messages')).toHaveLength(2);
});
it('追加中途失败时原消息与收据整笔回滚', async () => {
  io.records[0].updatedAt = Number.MAX_SAFE_INTEGER;
  await expect(projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true)).rejects.toThrow('序号');
  expect(await all('messages')).toEqual([root()]);
  expect(await all('metadata')).toHaveLength(0);
});
it('普通迟到快照不抹首张或复活已删除候选，新原生产物只保存相对引用', async () => {
  const projected = await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true);
  const extra = projected.messages[1], artifact = extra.mediaResult!;
  await persistMessage({ ...extra, content: '合法消息更新', mediaResult: { ...artifact, url: 'asset://localhost/C:/private/project/result.png',
    filePath: 'C:/private/project/result.png' } }, owner, 'original-conversation');
  const savedExtra = (await all('messages')).find((row) => row.id === extraId)!;
  expect(savedExtra.mediaResult).toMatchObject({ url: artifact.sourceUrl, sourceUrl: artifact.sourceUrl });
  expect((savedExtra.mediaResult as { filePath?: string }).filePath).toBeUndefined();
  await write('messages', undefined, extraId);
  await persistMessage(extra, owner, 'original-conversation');
  expect(await all('messages')).toHaveLength(1);
  await persistMessage({ ...projected.messages[0], content: '迟到的无产物快照', mediaResult: undefined, mediaStatus: 'generating' }, owner, 'original-conversation');
  expect((await all('messages'))[0].mediaResult).toMatchObject({ id: `native-media-${op}` });
  expect((await all('messages'))[0].mediaStatus).toBe('succeeded');
});
it('用户核对未知提交后只投影已知候选，消息明确保留原批次部分完成统计', async () => {
  const batch = io.records[0].apimartImageBatch!;
  batch.submissions.push({ id: '66666666-6666-4666-8666-666666666666', state: 'unknown', taskIds: [] });
  batch.uncertainAcknowledged = true;
  const projected = await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true);
  expect(projected.messages).toHaveLength(2);
  expect(projected.messages[0].content).toContain('原消息正文');
  expect(projected.messages[0].content).toContain('待核对提交 1 个');
  expect(projected.messages[1].content).toContain('原批次部分完成');
  const before = await all('messages');
  io.records[0].lateImageTaskIds = [{ submissionId: '66666666-6666-4666-8666-666666666666', taskIds: ['late-original-id'] }];
  io.records[0].revision += 1; io.records[0].updatedAt += 1;
  const retried = await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true);
  expect(retried.created).toBe(false);
  expect(await all('messages')).toEqual(before);
});
it('分页快照规范化期间删除的原生候选不会绕过槽收据被写回复活', async () => {
  await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true);
  const stale = (await all('messages')).find((row) => row.id === extraId)! as unknown as ChatMessageRecord;
  stale.mediaResult = { ...stale.mediaResult as object, url: 'asset://localhost/C:/private/stale.png', filePath: 'C:/private/stale.png' };
  vi.mocked(getConversationMessages).mockImplementationOnce(async () => {
    await write('messages', undefined, extraId);
    return { messages: [stale], total: 2 };
  });
  await loadMessages('original-conversation');
  expect((await all('messages')).some((row) => row.id === extraId)).toBe(false);
  expect(putChatMessageWithSequence).not.toHaveBeenCalled();
});
it('首个任务返回足量候选也不能掩盖后续已确认失败的提交', async () => {
  const batch = io.records[0].apimartImageBatch!;
  batch.requestedCount = 2;
  batch.submissions.push({ id: '66666666-6666-4666-8666-666666666666', state: 'failed', taskIds: [] });
  const projected = await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true);
  expect(projected.messages).toHaveLength(2);
  expect(projected.batchNote).toContain('原批次部分完成');
  expect(projected.batchNote).toContain('已保存 2 个候选');
  expect(projected.batchNote).toContain('失败提交 1 个');
  expect(projected.messages.every((message) => message.content.includes('失败提交 1 个'))).toBe(true);
});
it('原生分页规范化只改同一媒体字段，保留读取后更新的正文及持久元数据', async () => {
  await projectNativeMediaMessageBatch(io.records[0], [undefined, undefined], () => true);
  const stale = (await all('messages')).find((row) => row.id === extraId)! as unknown as ChatMessageRecord;
  stale.mediaResult = { ...stale.mediaResult as object, url: 'asset://localhost/C:/private/stale.png', filePath: 'C:/private/stale.png' };
  await write('messages', { ...stale, content: '并发更新的正文', updatedAt: 99, importedMetadata: { source: '保留原字段' } });
  vi.mocked(getConversationMessages).mockResolvedValueOnce({ messages: [stale], total: 2 });
  await loadMessages('original-conversation');
  const current = (await all('messages')).find((row) => row.id === extraId)!;
  expect(current).toMatchObject({ content: '并发更新的正文', updatedAt: 99, sequence: stale.sequence, importedMetadata: { source: '保留原字段' } });
  expect(current.mediaResult).toMatchObject({ url: (stale.mediaResult as { sourceUrl: string }).sourceUrl });
  expect((current.mediaResult as { filePath?: string }).filePath).toBeUndefined();
  expect(putChatMessageWithSequence).not.toHaveBeenCalled();
});
