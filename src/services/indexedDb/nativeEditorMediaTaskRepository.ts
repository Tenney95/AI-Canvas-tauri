/** 剪辑付费任务使用新库独立账本，结果和原工程以同一耐久事务提交。 */
import type { CanvasContext } from '../../types/project';
import type { VideoEditorProjectRecord } from '../../types/videoEditor';
import { getVideoTrack, relayoutSequential } from '../../types/videoEditor';
import { configValuesEqual } from '../configPatch';
import { validateNativeVideoEditorRecord } from '../videoEditorRecordValidation';
import { safeExchangePath } from '../projectExchangeDomain';
import { CANVASES, EPISODES, EXCHANGE, REVISIONS, ROOTS, TRANSFER, assertNoPendingNativeSharedSync,
  isNativeCanvasId, isNativeEpisodeId, isNativeProjectId, openNativeProjectDatabase, readCanvasTarget, transact, type NativeProjectOptions } from './nativeProjectRepository';

const PREFIX = 'editor-task:';
const stores = [ROOTS, CANVASES, EPISODES, REVISIONS, EXCHANGE, TRANSFER] as const;
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error('转场账本读取失败'));
});
export interface NativeEditorMediaTask {
  projectId: string; kind: 'native-editor-media-v1'; ownerProjectId: string; canvasId: string; episodeId: string | null;
  projectEpoch: number; canvasEpoch: number; operationId: string; requestId: string; anchorNodeId: string;
  editorId: string; beforeClipId: string; expectedEditor: VideoEditorProjectRecord;
  modelRef: string; providerConfigId: string; providerBase: string; protocolDigest: string;
  status: 'prepared' | 'submitted' | 'outcome-unknown' | 'failed' | 'delivered' | 'reviewed'; remoteTaskId?: string;
  lease: string; submissionLease: string; revision: number; resultPath?: string; resultDuration?: number; createdAt: number; updatedAt: number;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function validate(row: NativeEditorMediaTask): NativeEditorMediaTask {
  if (!row || row.kind !== 'native-editor-media-v1' || !uuid.test(row.operationId) || !uuid.test(row.lease) || !uuid.test(row.submissionLease)
    || row.projectId !== `${PREFIX}${row.operationId}` || !['prepared', 'submitted', 'outcome-unknown', 'failed', 'delivered', 'reviewed'].includes(row.status)
    || !isNativeProjectId(row.ownerProjectId) || !isNativeCanvasId(row.canvasId)
    || ![row.projectEpoch, row.canvasEpoch, row.revision, row.createdAt, row.updatedAt].every((value) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER)
    || !(row.episodeId === null || isNativeEpisodeId(row.episodeId)) || !/^[a-f0-9]{64}$/.test(row.protocolDigest)
    || ![row.editorId, row.anchorNodeId, row.requestId, row.beforeClipId, row.modelRef, row.providerConfigId].every(identity)
    || row.editorId !== `${row.canvasId}::${row.anchorNodeId}` || row.expectedEditor?.id !== row.editorId
    || row.expectedEditor.nodeId !== row.anchorNodeId
    || row.expectedEditor.automationRevision !== undefined && (!Number.isSafeInteger(row.expectedEditor.automationRevision)
      || row.expectedEditor.automationRevision < 0 || row.expectedEditor.automationRevision >= Number.MAX_SAFE_INTEGER)
    || row.remoteTaskId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(row.remoteTaskId)
    || row.status === 'submitted' && !row.remoteTaskId || row.status === 'delivered' && (!row.remoteTaskId || !row.resultPath)
    || row.resultPath !== undefined && (safeExchangePath(row.resultPath) !== row.resultPath || !Number.isFinite(row.resultDuration) || row.resultDuration! <= 0)
    || Object.keys(row).some((key) => !['projectId', 'kind', 'ownerProjectId', 'canvasId', 'episodeId', 'projectEpoch', 'canvasEpoch', 'operationId',
      'requestId', 'anchorNodeId', 'editorId', 'beforeClipId', 'expectedEditor', 'modelRef', 'providerConfigId', 'providerBase', 'protocolDigest',
      'status', 'remoteTaskId', 'lease', 'submissionLease', 'revision', 'resultPath', 'resultDuration', 'createdAt', 'updatedAt'].includes(key))) throw new Error('原转场回执损坏，不能自动续接');
  const url = new URL(row.providerBase);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('原连接地址无法安全恢复');
  validateNativeVideoEditorRecord(row.expectedEditor, row.canvasId);
  return row;
}
async function target(tx: IDBTransaction, context: Readonly<CanvasContext>): Promise<void> {
  if (context.modelGeneration !== 1) throw new Error('转场需要新项目画布');
  const { project, canvas } = await readCanvasTarget(tx, context.projectId, context.canvasId);
  if (project.epoch !== context.projectEpoch || canvas.epoch !== context.canvasEpoch || canvas.episodeId !== context.episodeId) {
    throw new Error('原转场画布代际已变化，原回执保留');
  }
  await assertNoPendingNativeSharedSync(tx, context.projectId);
}
async function editor(tx: IDBTransaction, context: Readonly<CanvasContext>, id: string): Promise<VideoEditorProjectRecord> {
  const row = await request(tx.objectStore(EXCHANGE).get(`video-editor:${id}`)) as
    { kind?: string; ownerProjectId?: string; canvasId?: string; record?: VideoEditorProjectRecord } | undefined;
  if (row?.kind !== 'video-editor-v1' || row.ownerProjectId !== context.projectId || row.canvasId !== context.canvasId || !row.record) throw new Error('原剪辑工程已不存在');
  validateNativeVideoEditorRecord(row.record, context.canvasId); return row.record;
}
async function useDb<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>, options: NativeProjectOptions): Promise<T> {
  const db = await openNativeProjectDatabase(false, options); if (!db) throw new Error('新项目数据库不存在');
  try { return await transact(db, mode, options, async (tx) => {
    if (mode === 'readwrite' && tx.durability !== 'strict') throw new Error('转场账本需要耐久事务');
    return work(tx);
  }, stores, mode === 'readwrite'); } finally { db.close(); }
}
export async function listNativeEditorMediaTasks(context: Readonly<CanvasContext>, anchorNodeId?: string,
  options: NativeProjectOptions = {}): Promise<NativeEditorMediaTask[]> {
  return useDb('readonly', async (tx) => {
    await target(tx, context);
    const rows = await request(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`))) as NativeEditorMediaTask[];
    if (rows.length > 100_000) throw new Error('转场账本超过核验上限');
    return rows.map(validate).filter((row) => row.ownerProjectId === context.projectId && row.canvasId === context.canvasId
      && (anchorNodeId === undefined || row.anchorNodeId === anchorNodeId));
  }, options);
}
export async function prepareNativeEditorMediaTask(input: { context: Readonly<CanvasContext>; requestId: string; anchorNodeId: string;
  beforeClipId: string; modelRef: string; providerConfigId: string; providerBase: string; protocolDigest: string },
options: NativeProjectOptions = {}): Promise<NativeEditorMediaTask> {
  const fixed = structuredClone(input), operationId = crypto.randomUUID(), now = Date.now();
  return useDb('readwrite', async (tx) => {
    await target(tx, fixed.context);
    const store = tx.objectStore(EXCHANGE), rows = await request(store.getAll(IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`))) as NativeEditorMediaTask[];
    if (rows.map(validate).some((row) => row.canvasId === fixed.context.canvasId && row.anchorNodeId === fixed.anchorNodeId
      && (row.requestId === fixed.requestId || ['prepared', 'submitted', 'outcome-unknown'].includes(row.status)))) {
      throw new Error('原转场仍有未结算任务，请先取回原操作，勿重新提交');
    }
    const editorId = `${fixed.context.canvasId}::${fixed.anchorNodeId}`, expectedEditor = await editor(tx, fixed.context, editorId);
    const track = getVideoTrack(expectedEditor.tracks), index = track?.clips.findIndex((clip) => clip.id === fixed.beforeClipId) ?? -1;
    if (!track || track.locked || index <= 0) throw new Error('原剪辑接缝不存在或已锁定，未提交任务');
    const row = validate({ projectId: `${PREFIX}${operationId}`, kind: 'native-editor-media-v1', ownerProjectId: fixed.context.projectId,
      canvasId: fixed.context.canvasId, episodeId: fixed.context.episodeId, projectEpoch: fixed.context.projectEpoch,
      canvasEpoch: fixed.context.canvasEpoch, operationId, requestId: fixed.requestId, anchorNodeId: fixed.anchorNodeId,
      editorId, beforeClipId: fixed.beforeClipId, expectedEditor, modelRef: fixed.modelRef, providerConfigId: fixed.providerConfigId,
      providerBase: fixed.providerBase, protocolDigest: fixed.protocolDigest, status: 'prepared', lease: crypto.randomUUID(), submissionLease: crypto.randomUUID(), revision: 0, createdAt: now, updatedAt: now });
    await request(store.add(row)); return row;
  }, options);
}
export async function recordNativeEditorMediaSubmission(row: NativeEditorMediaTask,
  outcome: { taskId: string } | { unknown: true } | { notStarted: true }, options: NativeProjectOptions = {}): Promise<NativeEditorMediaTask> {
  return useDb('readwrite', async (tx) => {
    const store = tx.objectStore(EXCHANGE), current = validate(await request(store.get(row.projectId)) as NativeEditorMediaTask);
    if (current.submissionLease !== row.submissionLease || current.status === 'delivered' || current.status === 'failed'
      || current.remoteTaskId && (!('taskId' in outcome) || current.remoteTaskId !== outcome.taskId)) throw new Error('原转场任务回执已变化');
    const next = validate({ ...current, status: current.status === 'reviewed' ? 'reviewed' : 'taskId' in outcome ? 'submitted' : 'unknown' in outcome ? 'outcome-unknown' : 'failed',
      ...('taskId' in outcome ? { remoteTaskId: outcome.taskId } : {}), revision: current.revision + 1, updatedAt: Date.now() });
    await request(store.put(next)); return next;
  }, options);
}
export async function claimNativeEditorMediaTask(context: Readonly<CanvasContext>, operationId: string,
  options: NativeProjectOptions = {}): Promise<NativeEditorMediaTask> {
  return useDb('readwrite', async (tx) => {
    await target(tx, context);
    const store = tx.objectStore(EXCHANGE), row = validate(await request(store.get(`${PREFIX}${operationId}`)) as NativeEditorMediaTask);
    if (row.ownerProjectId !== context.projectId || row.canvasId !== context.canvasId || row.projectEpoch !== context.projectEpoch
      || row.canvasEpoch !== context.canvasEpoch || row.episodeId !== context.episodeId || row.status !== 'submitted' || !row.remoteTaskId) {
      throw new Error('原转场不能自动续查；请先核对平台原任务');
    }
    const next = validate({ ...row, lease: crypto.randomUUID(), revision: row.revision + 1, updatedAt: Date.now() });
    await request(store.put(next)); return next;
  }, options);
}
export async function retainNativeEditorMediaOutput(context: Readonly<CanvasContext>, row: NativeEditorMediaTask,
  relativePath: string, duration: number, options: NativeProjectOptions = {}): Promise<NativeEditorMediaTask> {
  if (!relativePath || safeExchangePath(relativePath) !== relativePath || !Number.isFinite(duration) || duration <= 0) throw new Error('转场素材或时长无效');
  return useDb('readwrite', async (tx) => {
    await target(tx, context);
    const store = tx.objectStore(EXCHANGE), live = validate(await request(store.get(row.projectId)) as NativeEditorMediaTask);
    if (live.ownerProjectId !== context.projectId || live.canvasId !== context.canvasId || live.lease !== row.lease
      || live.remoteTaskId !== row.remoteTaskId || live.status !== 'submitted' || live.revision !== row.revision) throw new Error('原转场回执已变化');
    if (live.resultPath && (live.resultPath !== relativePath || live.resultDuration !== duration)) throw new Error('原转场产物已冻结，不能替换');
    const next = validate({ ...live, resultPath: relativePath, resultDuration: duration, revision: live.revision + 1, updatedAt: Date.now() });
    const revision = await request(tx.objectStore(REVISIONS).get(context.projectId)) as { projectId: string; changeRevision: number } | undefined;
    if (!revision || revision.projectId !== context.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision >= Number.MAX_SAFE_INTEGER) throw new Error('项目版本无效');
    await request(store.put(next));
    await request(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: revision.changeRevision + 1 }));
    return next;
  }, options);
}
/** 导出/恢复素材闭包只读取已经冻结的项目相对路径，不改写原任务回执。 */
export async function listNativeEditorMediaArtifactsForProject(projectId: string, options: NativeProjectOptions = {}): Promise<Array<{ operationId: string; canvasId: string; path: string }>> {
  return useDb('readonly', async (tx) => {
    const rows = await request(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`))) as NativeEditorMediaTask[];
    if (rows.length > 100_000) throw new Error('转场账本超过核验上限');
    return rows.map(validate).filter((row) => row.ownerProjectId === projectId && row.resultPath)
      .map((row) => ({ operationId: row.operationId, canvasId: row.canvasId, path: row.resultPath! }));
  }, options);
}
/** 用户已核对平台或决定只保留素材；此状态不代表远端已取消，也不删除原 ID 和产物。 */
export async function reviewNativeEditorMediaTask(context: Readonly<CanvasContext>, operationId: string,
  options: NativeProjectOptions = {}): Promise<void> {
  await useDb('readwrite', async (tx) => {
    await target(tx, context);
    const store = tx.objectStore(EXCHANGE), row = validate(await request(store.get(`${PREFIX}${operationId}`)) as NativeEditorMediaTask);
    if (row.ownerProjectId !== context.projectId || row.canvasId !== context.canvasId || row.projectEpoch !== context.projectEpoch
      || row.canvasEpoch !== context.canvasEpoch || ['delivered', 'failed'].includes(row.status)) throw new Error('原转场不能结束跟踪');
    await request(store.put(validate({ ...row, status: 'reviewed', revision: row.revision + 1, lease: crypto.randomUUID(), updatedAt: Date.now() })));
  }, options);
}
export async function assertNativeEditorMediaPrepared(context: Readonly<CanvasContext>, row: NativeEditorMediaTask,
  options: NativeProjectOptions = {}): Promise<void> {
  await useDb('readonly', async (tx) => {
    await target(tx, context);
    const current = validate(await request(tx.objectStore(EXCHANGE).get(row.projectId)) as NativeEditorMediaTask);
    if (current.status !== 'prepared' || current.lease !== row.lease || current.revision !== row.revision
      || !configValuesEqual(await editor(tx, context, row.editorId), row.expectedEditor)) throw new Error('原剪辑工程或任务已变化，未提交请求');
  }, options);
}
export async function failNativeEditorMediaTask(row: NativeEditorMediaTask, options: NativeProjectOptions = {}): Promise<void> {
  await useDb('readwrite', async (tx) => {
    const store = tx.objectStore(EXCHANGE), live = validate(await request(store.get(row.projectId)) as NativeEditorMediaTask);
    if (live.lease !== row.lease || live.remoteTaskId !== row.remoteTaskId || live.status !== 'submitted') throw new Error('原转场回执已变化');
    await request(store.put(validate({ ...live, status: 'failed', revision: live.revision + 1, updatedAt: Date.now() })));
  }, options);
}
export async function commitNativeEditorMediaResult(context: Readonly<CanvasContext>, row: NativeEditorMediaTask,
  relativePath: string, options: NativeProjectOptions = {}): Promise<void> {
  if (!relativePath || safeExchangePath(relativePath) !== relativePath) throw new Error('转场结果路径无效');
  await useDb('readwrite', async (tx) => {
    await target(tx, context);
    const store = tx.objectStore(EXCHANGE), live = validate(await request(store.get(row.projectId)) as NativeEditorMediaTask);
    if (live.ownerProjectId !== context.projectId || live.canvasId !== context.canvasId || live.projectEpoch !== context.projectEpoch
      || live.canvasEpoch !== context.canvasEpoch || live.lease !== row.lease || live.remoteTaskId !== row.remoteTaskId) throw new Error('原转场投递租约已变化');
    if (live.status === 'delivered' && live.resultPath === relativePath) return;
    if (live.status !== 'submitted' || live.revision !== row.revision || live.resultPath !== relativePath || !live.resultDuration) throw new Error('原转场回执已变化');
    const previous = await editor(tx, context, live.editorId);
    if (!configValuesEqual(previous, live.expectedEditor)) throw new Error('剪辑工程已变化，结果与回执保留，未覆盖工程');
    const track = getVideoTrack(previous.tracks), index = track?.clips.findIndex((clip) => clip.id === live.beforeClipId) ?? -1;
    if (!track || track.locked || index <= 0 || (previous.automationRevision ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error('原剪辑接缝已变化');
    const tracks = structuredClone(previous.tracks), targetTrack = tracks.find((item) => item.id === track.id)!;
    targetTrack.clips.splice(index, 0, { id: `ai-transition-${live.operationId}`, kind: 'video', fileName: relativePath.split('/').pop()!,
      relativePath, timelineStart: targetTrack.clips[index].timelineStart, sourceIn: 0, sourceOut: live.resultDuration });
    targetTrack.clips = relayoutSequential(targetTrack.clips);
    const record: VideoEditorProjectRecord = { ...previous, tracks, automationRevision: (previous.automationRevision ?? 0) + 1, updatedAt: Date.now() };
    validateNativeVideoEditorRecord(record, context.canvasId);
    const revision = await request(tx.objectStore(REVISIONS).get(context.projectId)) as { projectId: string; changeRevision: number } | undefined;
    if (!revision || revision.projectId !== context.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision >= Number.MAX_SAFE_INTEGER) throw new Error('项目版本无效');
    await request(store.put({ projectId: `video-editor:${record.id}`, kind: 'video-editor-v1', ownerProjectId: context.projectId, canvasId: context.canvasId, record }));
    await request(store.put(validate({ ...live, status: 'delivered', resultPath: relativePath, revision: live.revision + 1, updatedAt: Date.now() })));
    await request(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: revision.changeRevision + 1 }));
  }, options);
}
