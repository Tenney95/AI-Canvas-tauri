/** 新画布媒体回执账本：只记录原任务身份和恢复条件，不读取或改写旧待续队列。 */
import type { NativeVideoImageReference } from '../nativeVideoImageReference';
import { readNativeMediaOrigin, type NativeMediaOrigin } from '../nativeMediaOrigin';
import { safeExchangePath } from '../projectExchangeDomain';
import type { NativeMediaLocalResult, NativeMediaLocalOutput, NativeMediaRecoveryBinding, NativeMediaCompletion, NativeApimartImageBatch } from '../../types/media';
import { validateNativeImageBatch, nativeImageBatchResults } from '../nativeImageBatch';
import { validateNativeMediaLocalOutputs } from '../nativeMediaCollection';
import { validateNativeProtocolContext } from '../nativeModelProtocolTask';
import { configValuesEqual } from '../configPatch';
import { isNativeMediaContentPath } from '../nativeMediaContentPath';
import { hasControlCharacters } from '../../utils/controlCharacters';
import type { CanvasContext, CanvasDocument, ProjectRecord } from '../../types/project';
import { assertNoPendingNativeSharedSync, CANVASES, EXCHANGE, ROOTS, TRANSFER, isNativeCanvasId, isNativeProjectId, openNativeProjectDatabase,
  transact, REVISIONS, type NativeProjectOptions } from './nativeProjectRepository';

const PREFIX = 'media-task:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !hasControlCharacters(value);
const validEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const req = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('媒体任务账本读取失败'));
});
const fail = (message = '媒体任务账本不可用，原操作已保留') : never => { throw new Error(message); };

/** 绑定无凭据的原站点，防止重配连接后把任务 ID 发给另一服务。 */
export function normalizeNativeMediaProviderBase(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail('媒体连接地址不可用于安全恢复');
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return fail('媒体连接地址不可用于安全恢复'); }
}

/** taskId 与预算不包含密钥；原始请求、地址、提示词和凭据不得进入账本。 */
export interface NativeMediaTaskRecord {
  projectId: string; // IndexedDB key，命名空间与作品 ID 不混用
  kind: 'native-media-task-v1';
  operationId: string;
  ownerProjectId: string;
  canvasId: string;
  episodeId: string | null;
  projectEpoch: number;
  canvasEpoch: number;
  sourceCanvasRevision: number;
  nodeId: string;
  targetNodeType?: 'ai-animation' | 'ai-panorama';
  /** 生成文件始终写入作品主根；不能继承原节点的素材子根。 */
  resultRootRef?: string;
  inputFingerprint: string;
  fingerprintScheme?: 'video-input-v1' | 'media-input-v2' | 'media-input-v3';
  requestFingerprint?: string;
  submissionKind?: 'async' | 'sync';
  localResult?: NativeMediaLocalResult;
  localResults?: NativeMediaLocalOutput[];
  completion?: NativeMediaCompletion;
  recovery?: NativeMediaRecoveryBinding;
  pollContext?: Record<string, unknown>;
  apimartImageBatch?: NativeApimartImageBatch;
  lateImageTaskIds?: Array<{ submissionId: string; taskIds: string[] }>;
  imageReference?: NativeVideoImageReference;
  providerConfigId: string;
  providerBase: string;
  protocolDigest?: string;
  modelRef?: string;
  origin?: NativeMediaOrigin;
  category: 'image' | 'video' | 'audio';
  status: 'prepared' | 'submitted' | 'outcome-unknown' | 'delivered' | 'failed' | 'reviewed';
  remoteTaskId?: string;
  deliveryDigest?: string;
  committedCanvasRevision?: number;
  resultRelativePath?: string;
  lease: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export function validateNativeMediaTaskRecord(value: NativeMediaTaskRecord): NativeMediaTaskRecord {
  if (value?.completion !== undefined) {
    const summary = value.completion;
    if (!value.localResults || !summary || Object.keys(summary).some((field) => !['taskCount', 'failedTasks', 'failedSubmissions', 'unknownSubmissions', 'notStartedSubmissions'].includes(field))
      || !Number.isSafeInteger(summary.taskCount) || summary.taskCount < 1 || summary.taskCount > 128
      || !Number.isSafeInteger(summary.failedTasks) || summary.failedTasks < 0 || summary.failedTasks > summary.taskCount
      || [summary.failedSubmissions, summary.unknownSubmissions, summary.notStartedSubmissions].some((count) => count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > 32))) return fail('原媒体完成统计无效');
  }
  if (value?.localResults !== undefined) {
    validateNativeMediaLocalOutputs(value.localResults);
    if (value.localResult || value.apimartImageBatch || value.localResults[0].category !== value.category
      || value.resultRelativePath !== value.localResults[0].relativePath) return fail('原媒体完整产物集合与主结果不一致');
  }
  if (value?.recovery !== undefined) {
    const binding = value.recovery;
    if (!binding || ![Object.prototype, null].includes(Object.getPrototypeOf(binding))
      || Reflect.ownKeys(binding).some((field) => typeof field !== 'string' || !['kind', 'workflowId', 'modelId', 'serverId', 'digest', 'expectedCount'].includes(field)
        || !('value' in Object.getOwnPropertyDescriptor(binding, field)!))
      || !['general-protocol', 'workflow', 'builtin-audio', 'builtin-image', 'builtin-video'].includes(binding.kind)
      || [binding.workflowId, binding.modelId, binding.serverId].some((field) => field !== undefined && !id(field))
      || binding.digest !== undefined && !/^[a-f0-9]{64}$/.test(binding.digest)
      || binding.expectedCount !== undefined && (!Number.isSafeInteger(binding.expectedCount) || binding.expectedCount < 1 || binding.expectedCount > 128)) return fail('媒体恢复合同身份损坏');
  }
  if (value?.pollContext !== undefined) validateNativeProtocolContext(value.pollContext);
  if (value?.apimartImageBatch !== undefined) {
    validateNativeImageBatch(value.apimartImageBatch);
    if (value.providerConfigId !== 'apimart' || value.category !== 'image' || !['media-input-v2', 'media-input-v3'].includes(value.fingerprintScheme ?? '')
      || value.submissionKind !== 'async' || !value.modelRef?.startsWith('apimart/')
      || value.remoteTaskId !== value.apimartImageBatch.tasks[0]?.taskId
      || ['submitted', 'delivered'].includes(value.status) && (value.apimartImageBatch.submissions.some((submission) => submission.state === 'prepared')
        || value.apimartImageBatch.submissions.some((submission) => submission.state === 'unknown') && !value.apimartImageBatch.uncertainAcknowledged)
      || value.status === 'delivered' && (!nativeImageBatchResults(value).length || value.resultRelativePath !== nativeImageBatchResults(value)[0]?.relativePath
        || value.apimartImageBatch.tasks.some((task) => task.state === 'submitted'))) return fail('图片批次与原任务身份不一致');
  }
  if (value?.lateImageTaskIds !== undefined && (!value.apimartImageBatch || value.status !== 'delivered'
    || !Array.isArray(value.lateImageTaskIds) || value.lateImageTaskIds.length > 32
    || new Set(value.lateImageTaskIds.map((entry) => entry.submissionId)).size !== value.lateImageTaskIds.length
    || value.lateImageTaskIds.some((entry) => !entry || Object.keys(entry).some((key) => !['submissionId', 'taskIds'].includes(key))
      || !value.apimartImageBatch!.submissions.some((submission) => submission.id === entry.submissionId && submission.state === 'unknown')
      || !Array.isArray(entry.taskIds) || !entry.taskIds.length || entry.taskIds.length > 128 || entry.taskIds.some((taskId) => !/^[A-Za-z0-9_-]{1,160}$/.test(taskId))))) return fail('迟到图片回执身份损坏');
  if (!value || value.kind !== 'native-media-task-v1' || !UUID.test(value.operationId)
    || value.projectId !== `${PREFIX}${value.operationId}` || !isNativeProjectId(value.ownerProjectId)
    || !isNativeCanvasId(value.canvasId) || !(value.episodeId === null || id(value.episodeId))
    || !validEpoch(value.projectEpoch) || !validEpoch(value.canvasEpoch) || !validEpoch(value.sourceCanvasRevision) || !id(value.nodeId) || !/^[a-f0-9]{64}$/.test(value.inputFingerprint) || !id(value.providerConfigId)
    || normalizeNativeMediaProviderBase(value.providerBase) !== value.providerBase
    || value.protocolDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.protocolDigest)
    || value.modelRef !== undefined && (!id(value.modelRef) || !value.protocolDigest)
    || value.fingerprintScheme !== undefined && !['video-input-v1', 'media-input-v2', 'media-input-v3'].includes(value.fingerprintScheme)
    || value.requestFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(value.requestFingerprint)
    || value.resultRootRef !== undefined && !/^r2-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.resultRootRef)
    || value.targetNodeType !== undefined && (value.category !== 'image' || !['ai-animation', 'ai-panorama'].includes(value.targetNodeType))
    || ['media-input-v2', 'media-input-v3'].includes(value.fingerprintScheme ?? '') && (!value.requestFingerprint || !value.modelRef || !value.protocolDigest)
    || value.submissionKind !== undefined && !['async', 'sync'].includes(value.submissionKind)
    || value.submissionKind === 'sync' && value.remoteTaskId !== undefined
    || value.localResult !== undefined && (value.submissionKind !== 'sync' || !value.localResult
      || !Number.isSafeInteger(value.localResult.bytes) || value.localResult.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(value.localResult.sha256)
      || !isNativeMediaContentPath(value.localResult.relativePath, value.localResult.sha256)
      || Object.keys(value.localResult).some((key) => !['relativePath', 'bytes', 'sha256'].includes(key))
      || value.resultRelativePath !== value.localResult.relativePath)
    || value.providerConfigId === 'grsai' && !value.protocolDigest
    || !['image', 'video', 'audio'].includes(value.category)
    || !['prepared', 'submitted', 'outcome-unknown', 'delivered', 'failed', 'reviewed'].includes(value.status)
    || !UUID.test(value.lease) || !validEpoch(value.revision) || !validEpoch(value.createdAt) || !validEpoch(value.updatedAt)
    || value.remoteTaskId !== undefined && !id(value.remoteTaskId)
    || value.status === 'submitted' && !(value.localResults?.length || (value.submissionKind === 'sync' ? value.localResult : value.remoteTaskId))
    || value.deliveryDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.deliveryDigest)
    || value.committedCanvasRevision !== undefined && !validEpoch(value.committedCanvasRevision)
    || value.resultRelativePath !== undefined && safeExchangePath(value.resultRelativePath) !== value.resultRelativePath
    || value.status === 'delivered' && (!(value.localResults?.length || (value.submissionKind === 'sync' ? value.localResult : value.remoteTaskId)) || !value.deliveryDigest || value.committedCanvasRevision === undefined)) return fail('媒体任务账本身份损坏，不能自动恢复');
  if (value.imageReference !== undefined) {
    const ref = value.imageReference;
    const match = ref && typeof ref.relativePath === 'string' ? /^media\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/.exec(ref.relativePath) : null;
    const mime = match?.[2] === 'jpg' ? 'image/jpeg' : match ? `image/${match[2]}` : undefined;
    if (!ref || value.providerConfigId !== 'volcengine' || value.category !== 'video' || !id(ref.sourceNodeId) || !match || match[1] !== ref.sha256 || ref.mimeType !== mime
      || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes >= 30 * 1024 * 1024
      || Object.keys(ref).some((key) => !['sourceNodeId', 'relativePath', 'sha256', 'bytes', 'mimeType'].includes(key))) return fail('媒体参考身份损坏');
  }
  if (value.origin !== undefined && (!value.origin || !id(value.origin.conversationId) || !id(value.origin.messageId)
    || value.origin.agentTaskId !== undefined && !id(value.origin.agentTaskId)
    || value.origin.modelId !== undefined && !id(value.origin.modelId)
    || !['chat', 'canvas', 'both'].includes(value.origin.deliveryMode)
    || Object.keys(value.origin).some((key) => !['conversationId', 'messageId', 'agentTaskId', 'modelId', 'deliveryMode'].includes(key)))) return fail('媒体原对话身份损坏');
  const fields = ['projectId', 'kind', 'operationId', 'ownerProjectId', 'canvasId', 'episodeId', 'projectEpoch', 'canvasEpoch',
    'sourceCanvasRevision', 'nodeId', 'targetNodeType', 'resultRootRef', 'inputFingerprint', 'fingerprintScheme', 'requestFingerprint', 'submissionKind', 'localResult', 'localResults', 'completion', 'recovery', 'pollContext', 'apimartImageBatch', 'lateImageTaskIds', 'imageReference', 'providerConfigId', 'providerBase', 'protocolDigest', 'modelRef', 'origin', 'category', 'status', 'remoteTaskId', 'deliveryDigest', 'committedCanvasRevision', 'resultRelativePath',
    'lease', 'revision', 'createdAt', 'updatedAt'];
  if (Object.keys(value).some((key) => !fields.includes(key))) return fail('媒体任务账本包含未知字段，不能自动恢复');
  return value;
}

async function matchingCanvas(tx: IDBTransaction, row: Pick<NativeMediaTaskRecord,
  'ownerProjectId' | 'projectEpoch' | 'canvasId' | 'canvasEpoch' | 'episodeId'>): Promise<boolean> {
  const [project, canvas] = await Promise.all([
    req(tx.objectStore(ROOTS).get(row.ownerProjectId)) as Promise<ProjectRecord | undefined>,
    req(tx.objectStore(CANVASES).get(row.canvasId)) as Promise<CanvasDocument | undefined>,
  ]);
  return !!project && !!canvas && project.id === row.ownerProjectId && project.epoch === row.projectEpoch
    && canvas.id === row.canvasId && canvas.projectId === row.ownerProjectId && canvas.epoch === row.canvasEpoch
    && canvas.episodeId === row.episodeId;
}

/** 与项目/画布权威记录同事务核对；调用者须等待返回后才可发起远端提交。 */
export async function prepareNativeMediaTask(input: { context: CanvasContext; operationId: string; nodeId: string;
  providerConfigId: string; providerBase: string; protocolDigest?: string; modelRef?: string; inputFingerprint: string;
  fingerprintScheme?: NativeMediaTaskRecord['fingerprintScheme']; requestFingerprint?: string;
  submissionKind?: NativeMediaTaskRecord['submissionKind'];
  recovery?: NativeMediaRecoveryBinding;
  apimartImageBatch?: NativeApimartImageBatch;
  sourceCanvasRevision: number; imageReference?: NativeVideoImageReference; category: NativeMediaTaskRecord['category'] }, options: NativeProjectOptions = {}): Promise<NativeMediaTaskRecord> {
  const context = structuredClone(input.context);
  const origin = readNativeMediaOrigin(context.canvasId, input.nodeId);
  if (context.kind !== 'canvas' || context.modelGeneration !== 1 || !context.runtimeEpoch
    || !isNativeProjectId(context.projectId) || !isNativeCanvasId(context.canvasId)
    || !UUID.test(input.operationId) || !id(input.nodeId) || !id(input.providerConfigId)) return fail('媒体任务缺少有效的新画布身份');
  if (input.category !== 'video' && !['media-input-v2', 'media-input-v3'].includes(input.fingerprintScheme ?? '')) return fail('新图片和音频任务需要版本化的完整输入合同');
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try {
    return await transact(db, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('媒体回执需要严格耐久存储，未提交生成');
      await assertNoPendingNativeSharedSync(tx, context.projectId);
      const owner = await req(tx.objectStore(ROOTS).get(context.projectId)) as ProjectRecord | undefined;
      if (!owner || owner.id !== context.projectId || owner.epoch !== context.projectEpoch) return fail('原作品身份已变化');
      const now = Date.now(), record = validateNativeMediaTaskRecord({ projectId: `${PREFIX}${input.operationId}`, kind: 'native-media-task-v1',
        operationId: input.operationId, ownerProjectId: context.projectId, canvasId: context.canvasId, episodeId: context.episodeId,
        projectEpoch: context.projectEpoch, canvasEpoch: context.canvasEpoch, sourceCanvasRevision: input.sourceCanvasRevision, nodeId: input.nodeId, resultRootRef: owner.storageRootRef, inputFingerprint: input.inputFingerprint,
        ...(input.imageReference ? { imageReference: structuredClone(input.imageReference) } : {}),
        ...(input.protocolDigest ? { protocolDigest: input.protocolDigest } : {}), providerConfigId: input.providerConfigId, providerBase: normalizeNativeMediaProviderBase(input.providerBase), category: input.category, status: 'prepared', lease: crypto.randomUUID(),
        ...(input.modelRef ? { modelRef: input.modelRef } : {}),
        ...(input.fingerprintScheme ? { fingerprintScheme: input.fingerprintScheme } : {}),
        ...(input.requestFingerprint ? { requestFingerprint: input.requestFingerprint } : {}),
        ...(input.submissionKind ? { submissionKind: input.submissionKind } : {}),
        ...(input.recovery ? { recovery: structuredClone(input.recovery) } : {}),
        ...(input.apimartImageBatch ? { apimartImageBatch: structuredClone(input.apimartImageBatch) } : {}),
        ...(origin ? { origin } : {}),
        revision: 0, createdAt: now, updatedAt: now });
      if (!await matchingCanvas(tx, record)) return fail('原作品或画布已变化，未提交生成');
      const savedCanvas = await req(tx.objectStore(CANVASES).get(record.canvasId)) as CanvasDocument | undefined;
      if (!savedCanvas || savedCanvas.revision !== record.sourceCanvasRevision) return fail('已保存画布版本已变化，未提交生成');
      const savedNode = savedCanvas.nodes.find((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === record.nodeId) as { data?: { type?: unknown } } | undefined;
      if (record.category === 'image' && (savedNode?.data?.type === 'ai-animation' || savedNode?.data?.type === 'ai-panorama')) record.targetNodeType = savedNode.data.type;
      if (origin && (origin.deliveryMode === 'chat' ? !/^media-message-[0-9a-f-]{36}$/.test(record.nodeId)
        : !savedCanvas.nodes.some((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === record.nodeId))) return fail('原媒体目的地缺少受信身份');
      if (record.imageReference) {
        const ref = record.imageReference;
        const sources = savedCanvas.nodes.filter((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === ref.sourceNodeId);
        const source = sources[0] as { data?: { type?: unknown; relativePath?: unknown } } | undefined;
        const links = savedCanvas.edges.filter((edge) => edge && typeof edge === 'object' && (edge as { target?: unknown }).target === record.nodeId);
        if (sources.length !== 1 || source?.data?.type !== 'source-image' || source.data.relativePath !== ref.relativePath
          || links.length !== 1 || (links[0] as { source?: unknown }).source !== ref.sourceNodeId) return fail('保存的参考图片与原任务不一致');
      }
      const existing = await req(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`))) as NativeMediaTaskRecord[];
      if (existing.length > 100_000) return fail('媒体回执过多，未提交生成');
      if (existing.map(validateNativeMediaTaskRecord).some((row) => row.operationId === record.operationId
        || row.ownerProjectId === record.ownerProjectId && row.canvasId === record.canvasId
          && (row.nodeId === record.nodeId && ['prepared', 'submitted', 'outcome-unknown'].includes(row.status)
            || !!record.origin && row.origin?.messageId === record.origin.messageId
              && row.origin.conversationId === record.origin.conversationId && row.status !== 'failed'))) {
        return fail('此节点已有未结算媒体任务，或原消息已绑定产物；请核对原回执，已完成时请从新消息发起');
      }
      await req(tx.objectStore(EXCHANGE).add(record));
      return record;
    }, [ROOTS, CANVASES, EXCHANGE, TRANSFER], true);
  } finally { db.close(); }
}

/** 网络提交前核对原占位、持久画布身份和其他跨库事务写锁。 */
export async function assertNativeMediaPrepared(record: NativeMediaTaskRecord, options: NativeProjectOptions = {}): Promise<void> {
  const source = validateNativeMediaTaskRecord(structuredClone(record));
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try {
    await transact(db, 'readonly', options, async (tx) => {
      const row = await req(tx.objectStore(EXCHANGE).get(source.projectId)) as NativeMediaTaskRecord | undefined;
      if (!row) return fail('原媒体操作不存在，未提交请求');
      const current = validateNativeMediaTaskRecord(row);
      await assertNoPendingNativeSharedSync(tx, current.ownerProjectId);
      const savedCanvas = await req(tx.objectStore(CANVASES).get(current.canvasId)) as CanvasDocument | undefined;
      if (current.status !== 'prepared' || current.lease !== source.lease || current.revision !== source.revision
        || !await matchingCanvas(tx, current) || savedCanvas?.revision !== current.sourceCanvasRevision) return fail('原媒体任务或画布已变化，未提交请求');
    }, [ROOTS, CANVASES, EXCHANGE, TRANSFER]);
  } finally { db.close(); }
}

/** 已返回的同步产物归属于原持久目的地；切换当前窗口不使原文件被丢弃。 */
export async function assertNativeMediaResultRetention(record: NativeMediaTaskRecord, options: NativeProjectOptions = {}): Promise<void> {
  const original = validateNativeMediaTaskRecord(structuredClone(record));
  if (original.submissionKind !== 'sync') return fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try { await transact(db, 'readonly', options, async (tx) => {
    const value = await req(tx.objectStore(EXCHANGE).get(original.projectId)) as NativeMediaTaskRecord | undefined;
    if (!value) return fail();
    const current = validateNativeMediaTaskRecord(value);
    if (current.lease !== original.lease || !['prepared', 'outcome-unknown'].includes(current.status) || !await matchingCanvas(tx, current)) return fail('原同步任务已结束跟踪或持久目的地已变化');
    // 只保留已返回产物的原回执，不修改正文；共享写屏障不能使已付费文件丢失。
  }, [ROOTS, CANVASES, EXCHANGE]); } finally { db.close(); }
}

/** 收到远端 ID 即耐久保存；即使原画布此时已删除，也保留原回执供只读核对。 */
export async function recordNativeMediaSubmission(operationId: string, lease: string,
  outcome: { taskId: string; pollContext?: Record<string, unknown> } | { unknown: true } | { notStarted: true }, options: NativeProjectOptions = {}): Promise<NativeMediaTaskRecord> {
  if (!UUID.test(operationId) || !UUID.test(lease) || 'taskId' in outcome && !id(outcome.taskId)) return fail();
  if ('taskId' in outcome && outcome.pollContext !== undefined) validateNativeProtocolContext(outcome.pollContext);
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try {
    return await transact(db, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail();
      const store = tx.objectStore(EXCHANGE), value = await req(store.get(`${PREFIX}${operationId}`)) as NativeMediaTaskRecord | undefined;
      if (!value) return fail();
      const current = validateNativeMediaTaskRecord(value);
      if (current.lease !== lease) return fail();
      if (current.apimartImageBatch) return fail('图片批次必须保存每个原提交的完整回执');
      if (current.submissionKind === 'sync' && 'taskId' in outcome) return fail('同步媒体不能伪造远端任务 ID');
      // 用户只撤销本机防重，不抹掉仍可能迟到的原提交回执。
      if (current.status === 'reviewed') {
        if (!('taskId' in outcome)) return current;
        if (current.remoteTaskId) return current.remoteTaskId === outcome.taskId && configValuesEqual(current.pollContext, outcome.pollContext) ? current : fail();
        if (current.revision >= Number.MAX_SAFE_INTEGER) return fail();
        const late = validateNativeMediaTaskRecord({ ...current, remoteTaskId: outcome.taskId,
          ...(outcome.pollContext !== undefined ? { pollContext: structuredClone(outcome.pollContext) } : {}),
          revision: current.revision + 1, updatedAt: Date.now() });
        await req(store.put(late));
        return late;
      }
      if ('taskId' in outcome && current.status === 'submitted' && current.remoteTaskId === outcome.taskId && configValuesEqual(current.pollContext, outcome.pollContext)
        || 'unknown' in outcome && current.status === 'outcome-unknown'
        || 'notStarted' in outcome && current.status === 'failed') return current;
      if (current.status !== 'prepared' && !(current.status === 'outcome-unknown' && 'taskId' in outcome)
        || current.revision >= Number.MAX_SAFE_INTEGER) return fail();
      const next: NativeMediaTaskRecord = { ...current, status: 'taskId' in outcome ? 'submitted' : 'unknown' in outcome ? 'outcome-unknown' : 'failed',
        ...('taskId' in outcome ? { remoteTaskId: outcome.taskId, ...(outcome.pollContext !== undefined ? { pollContext: structuredClone(outcome.pollContext) } : {}) } : {}), revision: current.revision + 1, updatedAt: Date.now() };
      await req(store.put(validateNativeMediaTaskRecord(next)));
      return next;
    }, [EXCHANGE], true);
  } finally { db.close(); }
}

/** 同步返回先核验并保存本机文件身份；此事务完成后重启只能交付该原文件，不能再POST。 */
export async function retainNativeMediaLocalResult(record: NativeMediaTaskRecord, localResult: NativeMediaLocalResult,
  options: NativeProjectOptions = {}): Promise<NativeMediaTaskRecord> {
  const original = validateNativeMediaTaskRecord(structuredClone(record));
  if (original.submissionKind !== 'sync') return fail();
  const nextInput = structuredClone(localResult);
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try { return await transact(db, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail();
    const store = tx.objectStore(EXCHANGE), value = await req(store.get(original.projectId)) as NativeMediaTaskRecord | undefined;
    if (!value) return fail();
    const current = validateNativeMediaTaskRecord(value);
    if (current.submissionKind !== 'sync' || current.lease !== original.lease || !await matchingCanvas(tx, current)) return fail();
    if (current.localResult) {
      if (JSON.stringify(current.localResult) !== JSON.stringify(nextInput)) return fail('原同步产物已冻结，不能替换');
      return current;
    }
    if (!['prepared', 'outcome-unknown'].includes(current.status) || current.revision >= Number.MAX_SAFE_INTEGER) return fail();
    // 单调增加回执与捕获版本；实际画布/消息交付仍受共享写屏障保护。
    const revision = await req(tx.objectStore(REVISIONS).get(current.ownerProjectId)) as { projectId: string; changeRevision: number } | undefined;
    if (!revision || revision.projectId !== current.ownerProjectId || !validEpoch(revision.changeRevision) || revision.changeRevision >= Number.MAX_SAFE_INTEGER) return fail();
    const next = validateNativeMediaTaskRecord({ ...current, status: 'submitted', localResult: nextInput,
      resultRelativePath: nextInput.relativePath, revision: current.revision + 1, updatedAt: Date.now() });
    await Promise.all([req(store.put(next)), req(tx.objectStore(REVISIONS).put({ projectId: current.ownerProjectId, changeRevision: revision.changeRevision + 1 }))]);
    return next;
  }, [ROOTS, CANVASES, EXCHANGE, REVISIONS], true); } finally { db.close(); }
}

/** 用户继续仅获取原查询/本机交付租约；不改变原远端 ID，不重新提交生成。 */
export async function claimNativeMediaRecovery(operationId: string, context: CanvasContext,
  options: NativeProjectOptions = {}): Promise<NativeMediaTaskRecord> {
  if (!UUID.test(operationId) || context.kind !== 'canvas' || context.modelGeneration !== 1 || !context.runtimeEpoch) return fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try {
    return await transact(db, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail();
      const store = tx.objectStore(EXCHANGE), value = await req(store.get(`${PREFIX}${operationId}`)) as NativeMediaTaskRecord | undefined;
      if (!value) return fail();
      const current = validateNativeMediaTaskRecord(value);
      await assertNoPendingNativeSharedSync(tx, current.ownerProjectId);
      if (!['submitted', 'reviewed'].includes(current.status) || !(current.localResults?.length || (current.submissionKind === 'sync' ? current.localResult : current.remoteTaskId)) || current.revision >= Number.MAX_SAFE_INTEGER
        || current.category !== 'video' && !['media-input-v2', 'media-input-v3'].includes(current.fingerprintScheme ?? '')
        || current.ownerProjectId !== context.projectId || current.canvasId !== context.canvasId
        || current.episodeId !== context.episodeId || current.projectEpoch !== context.projectEpoch
        || current.canvasEpoch !== context.canvasEpoch || !await matchingCanvas(tx, current)) {
        return fail('原画布身份已变化或原任务未确认，不能自动续查');
      }
      if (current.status === 'reviewed') {
        const rows = await req(store.getAll(IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`))) as NativeMediaTaskRecord[];
        if (rows.length > 100_000 || rows.map(validateNativeMediaTaskRecord).some((row) => row.operationId !== current.operationId
          && row.ownerProjectId === current.ownerProjectId && row.canvasId === current.canvasId
          && (row.nodeId === current.nodeId || !!current.origin && row.origin?.messageId === current.origin.messageId
            && row.origin.conversationId === current.origin.conversationId))) return fail('此节点或原消息已有后续任务，请只读核对原回执，不能自动交付');
      }
      const next = validateNativeMediaTaskRecord({ ...current, status: 'submitted', lease: crypto.randomUUID(), revision: current.revision + 1, updatedAt: Date.now() });
      await req(store.put(next));
      return next;
    }, [ROOTS, CANVASES, EXCHANGE, TRANSFER], true);
  } finally { db.close(); }
}

/** 严格校验持久身份和当前租约，防止另一窗口或已替换画布投递迟到结果。 */
export async function isNativeMediaLeaseCurrent(record: NativeMediaTaskRecord, options: NativeProjectOptions = {}): Promise<boolean> {
  validateNativeMediaTaskRecord(record);
  const db = await openNativeProjectDatabase(false, options); if (!db) return false;
  try {
    return await transact(db, 'readonly', options, async (tx) => {
      const value = await req(tx.objectStore(EXCHANGE).get(record.projectId)) as NativeMediaTaskRecord | undefined;
      return !!value && validateNativeMediaTaskRecord(value).status === 'submitted' && value.lease === record.lease
        && value.revision === record.revision && await matchingCanvas(tx, value);
    }, [ROOTS, CANVASES, EXCHANGE]);
  } finally { db.close(); }
}

export async function listNativeMediaTasks(projectId: string, options: NativeProjectOptions = {}): Promise<NativeMediaTaskRecord[]> {
  if (!isNativeProjectId(projectId)) return fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) return [];
  try {
    return await transact(db, 'readonly', options, async (tx) => {
      const rows = await req(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`))) as NativeMediaTaskRecord[];
      if (rows.length > 100_000) return fail('媒体回执过多，不能自动恢复');
      return rows.map(validateNativeMediaTaskRecord).filter((row) => row.ownerProjectId === projectId);
    }, [EXCHANGE]);
  } finally { db.close(); }
}

/** 只有原查询确认远端失败后调用；保留远端 ID 和审计记录。 */
export async function failNativeMediaTask(record: NativeMediaTaskRecord, options: NativeProjectOptions = {}): Promise<void> {
  const source = validateNativeMediaTaskRecord(structuredClone(record));
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try {
    await transact(db, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail();
      const store = tx.objectStore(EXCHANGE), row = await req(store.get(source.projectId)) as NativeMediaTaskRecord | undefined;
      if (!row) return fail();
      const current = validateNativeMediaTaskRecord(row);
      if (current.lease !== source.lease || current.revision !== source.revision || current.status !== 'submitted'
        || current.remoteTaskId !== source.remoteTaskId || current.revision >= Number.MAX_SAFE_INTEGER) return fail();
      await req(store.put(validateNativeMediaTaskRecord({ ...current, status: 'failed', revision: current.revision + 1, updatedAt: Date.now() })));
    }, [EXCHANGE], true);
  } finally { db.close(); }
}

/** 用户核对原平台后结束本机跟踪；原回执、候选和远端 ID 保留，不取消或重新提交远端任务。 */
export async function reviewNativeMediaTask(operationId: string, context: CanvasContext, options: NativeProjectOptions = {}): Promise<void> {
  if (!UUID.test(operationId) || context.kind !== 'canvas' || context.modelGeneration !== 1 || !context.runtimeEpoch) return fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try {
    await transact(db, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail();
      const store = tx.objectStore(EXCHANGE), row = await req(store.get(`${PREFIX}${operationId}`)) as NativeMediaTaskRecord | undefined;
      if (!row) return fail();
      const current = validateNativeMediaTaskRecord(row);
      if (!['prepared', 'submitted', 'outcome-unknown'].includes(current.status) || current.revision >= Number.MAX_SAFE_INTEGER
        || current.ownerProjectId !== context.projectId || current.canvasId !== context.canvasId
        || current.episodeId !== context.episodeId || current.projectEpoch !== context.projectEpoch
        || current.canvasEpoch !== context.canvasEpoch || !await matchingCanvas(tx, current)) return fail('原任务或画布已变化，未解除防重');
      await req(store.put(validateNativeMediaTaskRecord({ ...current, status: 'reviewed', revision: current.revision + 1, updatedAt: Date.now(),
        ...(current.apimartImageBatch ? { apimartImageBatch: { ...current.apimartImageBatch, uncertainAcknowledged: true,
          submissions: current.apimartImageBatch.submissions.map((submission) => submission.state === 'prepared' ? { ...submission, state: 'not-started' as const } : submission) } } : {}) })));
    }, [ROOTS, CANVASES, EXCHANGE], true);
  } finally { db.close(); }
}
