/** 角色工作台的原生同步生图回执，归作品与角色草稿，不写画布。 */
import { remove } from '@tauri-apps/plugin-fs';
import type { BatchImageResult, MediaDownloadAccess } from '../types/aiTypes';
import type { NativeMediaLocalResult } from '../types/media';
import type { ProjectRecord } from '../types/project';
import type { CharacterImageTaskRecovery } from '../types/media';
import { validateCharacterImageTaskRecovery } from './characterImageTaskContext';
import { hasControlCharacters } from '../utils/controlCharacters';
import { getHttpResponseError } from './ai/httpUtils';
import { PollTaskFailedError } from './pollTask';
import { getAssetUrlFromPath, getProjectDataDir, isTauriEnv, joinPath } from './fileService';
import { saveCharacterVisualResult } from './fs/characterVisualFiles';
import { EXCHANGE, REVISIONS, ROOTS, TRANSFER, assertNoPendingNativeSharedSync, increment,
  isNativeProjectId, openNativeProjectDatabase, transact } from './indexedDb/nativeProjectRepository';
import { sha256BytesHex } from './mediaDataUrl';
import { isNativeMediaContentPath } from './nativeMediaContentPath';
import { captureNativeMediaLocalResult, readNativeMediaLocalResult } from './nativeMediaLocalResult';
import { projectModelSourceToken } from './projectModelComparisonMaterial';

const PREFIX = 'character-image-task:';
const KIND = 'native-character-image-v1';
const MAX_ROWS = 100_000;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_CHARACTER_OUTPUTS = 128;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const rootRef = /^r2-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const states = ['prepared', 'outcome-unknown', 'completed', 'failed', 'reviewed'] as const;
const guards = new WeakMap<NativeCharacterImageSubmissionGuard, { fingerprint?: string; onSubmit?: () => void }>();
const active = new Map<string, string>();

type Size = { width: number; height: number };
type Output = NativeMediaLocalResult & Size & { index: number };
type Status = (typeof states)[number];

export interface NativeCharacterImageSubmissionGuard {
  (): void;
  readonly ownerProjectId: string;
  readonly projectEpoch: number;
  readonly characterId: string;
  readonly operationId: string;
}

export interface NativeCharacterImageTask {
  operationId: string;
  ownerProjectId: string;
  projectEpoch: number;
  characterId: string;
  modelRef: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
  recovery?: CharacterImageTaskRecovery;
  candidates?: Array<Output & { url: string; filePath: string }>;
  outputIndexes: number[];
  active: boolean;
}

type Candidate = Output & { url: string; filePath: string };

interface Receipt extends Omit<NativeCharacterImageTask, 'outputIndexes' | 'active'> {
  projectId: string;
  kind: typeof KIND;
  resultRootRef: string;
  providerConfigId: string;
  requestFingerprint: string;
  outputs: Output[];
  revision: number;
}

const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error ?? new Error('角色生图回执读取失败'));
});
const validId = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !hasControlCharacters(value);
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validSize = ({ width, height }: Size) => integer(width) && integer(height)
  && width > 0 && height > 0 && width * height <= MAX_PIXELS;
const pending = (status: Status) => status === 'prepared' || status === 'outcome-unknown';
const invalid = () => new Error('角色生图回执或项目身份已变化');
const receiptFields = new Set(['projectId', 'kind', 'ownerProjectId', 'projectEpoch', 'characterId', 'operationId',
  'resultRootRef', 'modelRef', 'providerConfigId', 'requestFingerprint', 'status', 'outputs', 'revision', 'createdAt', 'updatedAt', 'recovery']);
const outputFields = new Set(['relativePath', 'bytes', 'sha256', 'width', 'height', 'index']);

export function createNativeCharacterImageSubmissionGuard(input: {
  ownerProjectId: string;
  projectEpoch: number;
  characterId: string;
  operationId?: string;
  fingerprint?: string;
  assertCurrent: () => void;
  onSubmit?: () => void;
}): NativeCharacterImageSubmissionGuard {
  const { ownerProjectId, projectEpoch, characterId, operationId = crypto.randomUUID(), assertCurrent, fingerprint, onSubmit } = input;
  if (!isNativeProjectId(ownerProjectId) || !integer(projectEpoch) || !validId(characterId) || !UUID.test(operationId)
    || fingerprint !== undefined && !SHA256.test(fingerprint)) throw invalid();
  const guard = Object.freeze(Object.assign(() => assertCurrent(), { ownerProjectId, projectEpoch, characterId, operationId }));
  guards.set(guard, { fingerprint, onSubmit });
  return guard;
}

export function isNativeCharacterImageSubmissionGuard(value: unknown): value is NativeCharacterImageSubmissionGuard {
  return typeof value === 'function' && guards.has(value as NativeCharacterImageSubmissionGuard);
}

function validate(row: Receipt | undefined): Receipt {
  if (!row || row.kind !== KIND || !UUID.test(row.operationId) || row.projectId !== taskKey(row.ownerProjectId, row.operationId)
    || !isNativeProjectId(row.ownerProjectId) || !rootRef.test(row.resultRootRef)
    || ![row.characterId, row.modelRef, row.providerConfigId].every(validId) || !states.includes(row.status)
    || ![row.projectEpoch, row.revision, row.createdAt, row.updatedAt].every(integer) || !SHA256.test(row.requestFingerprint)
    || !Array.isArray(row.outputs) || row.outputs.length > MAX_CHARACTER_OUTPUTS
    || Object.keys(row).some((key) => !receiptFields.has(key))
    || row.status === 'completed' && !row.outputs.length
    || row.outputs.some((output) => !output || Object.keys(output).some((key) => !outputFields.has(key))
      || !integer(output.index) || output.index >= MAX_CHARACTER_OUTPUTS || !integer(output.bytes) || output.bytes === 0 || !validSize(output)
      || !/\.(?:png|jpg|webp)$/.test(output.relativePath) || !isNativeMediaContentPath(output.relativePath, output.sha256))) throw invalid();
  if (new Set(row.outputs.map((output) => output.index)).size !== row.outputs.length) throw invalid();
  if (row.recovery) {
    validateCharacterImageTaskRecovery(row.recovery);
    if (row.recovery.modelRef !== row.modelRef || row.recovery.connectionId !== row.providerConfigId) throw invalid();
  }
  return row;
}

async function withDatabase<T>(write: boolean, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openNativeProjectDatabase(false, {});
  if (!db) throw new Error('原作品数据库不可用');
  try {
    return await transact(db, write ? 'readwrite' : 'readonly', {}, async (tx) => {
      if (write && tx.durability !== 'strict') throw new Error('角色生图回执需要耐久事务');
      return work(tx);
    }, [ROOTS, REVISIONS, EXCHANGE, TRANSFER], write);
  } finally { db.close(); }
}

async function readProject(tx: IDBTransaction, ownerProjectId: string, projectEpoch?: number): Promise<ProjectRecord> {
  const project = await request(tx.objectStore(ROOTS).get(ownerProjectId)) as ProjectRecord | undefined;
  if (!project || project.id !== ownerProjectId || projectEpoch !== undefined && project.epoch !== projectEpoch) throw invalid();
  return project;
}

function taskRange(ownerProjectId: string): IDBKeyRange {
  const start = `${PREFIX}${ownerProjectId}:`;
  return IDBKeyRange.bound(start, `${start}\uffff`);
}

function taskKey(ownerProjectId: string, operationId: string): string {
  return `${PREFIX}${ownerProjectId}:${operationId}`;
}

async function readRows(store: IDBObjectStore, ownerProjectId: string): Promise<Receipt[]> {
  const range = taskRange(ownerProjectId);
  if (await request(store.count(range)) > MAX_ROWS) throw new Error('角色生图回执超过核验上限');
  return (await request(store.getAll(range)) as Receipt[]).map(validate);
}

async function changeReceipt(original: Receipt, patch: Partial<Pick<Receipt, 'status' | 'outputs' | 'recovery'>>,
  assertReviewCurrent?: () => void): Promise<Receipt> {
  return withDatabase(true, async (tx) => {
    const store = tx.objectStore(EXCHANGE);
    const current = validate(await request(store.get(original.projectId)) as Receipt | undefined);
    if (current.revision !== original.revision || current.status !== original.status) throw invalid();
    const project = await readProject(tx, current.ownerProjectId, assertReviewCurrent ? undefined : current.projectEpoch);
    if (!assertReviewCurrent && project.storageRootRef !== current.resultRootRef) throw invalid();
    if (patch.status === 'outcome-unknown') await assertNoPendingNativeSharedSync(tx, current.ownerProjectId);
    const next = validate({ ...current, ...patch, revision: increment(current.revision), updatedAt: Date.now() });
    const revisions = tx.objectStore(REVISIONS);
    const revision = await request(revisions.get(project.id)) as { projectId: string; changeRevision: number } | undefined;
    if (revision?.projectId !== project.id) throw invalid();
    assertReviewCurrent?.();
    await request(store.put(next));
    await request(revisions.put({ ...revision, changeRevision: increment(revision.changeRevision) }));
    return next;
  });
}

async function projectCandidates(row: Receipt, outputIndex?: number): Promise<Candidate[]> {
  const outputs = outputIndex === undefined ? row.outputs : row.outputs.filter((output) => output.index === outputIndex);
  if (!outputs.length) return [];
  const root = await getProjectDataDir(row.ownerProjectId);
  if (!root) throw invalid();
  const candidates: Candidate[] = [];
  for (const output of outputs) {
    try { await readNativeMediaLocalResult(row.ownerProjectId, output); }
    catch { continue; }
    const filePath = joinPath(root, output.relativePath);
    candidates.push({ ...output, filePath, url: await getAssetUrlFromPath(filePath) });
  }
  return candidates;
}

function taskSummary(row: Receipt): NativeCharacterImageTask {
  const { operationId, ownerProjectId, projectEpoch, characterId, modelRef, status, createdAt, updatedAt } = row;
  return { operationId, ownerProjectId, projectEpoch, characterId, modelRef, status, createdAt, updatedAt,
    ...(row.recovery ? { recovery: row.recovery } : {}),
    outputIndexes: row.outputs.map((output) => output.index), active: active.has(row.projectId) };
}

async function readCharacterReceipts(ownerProjectId: string, characterId: string, operationIds: readonly string[]): Promise<Receipt[]> {
  if (!isNativeProjectId(ownerProjectId) || !validId(characterId)
    || operationIds.length > 50 || operationIds.some((id) => !UUID.test(id))) throw invalid();
  return withDatabase(false, async (tx) => {
    const project = await readProject(tx, ownerProjectId);
    const store = tx.objectStore(EXCHANGE);
    const receipts = (await Promise.all([...new Set(operationIds)].map(async (id) => {
      const row = await request(store.get(taskKey(ownerProjectId, id))) as Receipt | undefined;
      return row ? [validate(row)] : [];
    }))).flat();
    return receipts.filter((row) => row.ownerProjectId === ownerProjectId && row.projectEpoch === project.epoch
      && row.resultRootRef === project.storageRootRef && row.characterId === characterId);
  });
}

export async function listNativeCharacterImageTasks(ownerProjectId: string, characterId: string,
  operationIds: readonly string[]): Promise<NativeCharacterImageTask[]> {
  return (await readCharacterReceipts(ownerProjectId, characterId, operationIds)).map(taskSummary);
}

export async function readNativeCharacterImageTask(ownerProjectId: string, characterId: string, operationId: string, outputIndex?: number):
  Promise<(NativeCharacterImageTask & { candidates: Candidate[] }) | undefined> {
  const [row] = await readCharacterReceipts(ownerProjectId, characterId, [operationId]);
  return row ? { ...taskSummary(row), candidates: await projectCandidates(row, outputIndex) } : undefined;
}

/** 作品更新检查所有待处理回执，此列表使用同一范围。 */
export async function listPendingNativeCharacterImageTasks(ownerProjectId: string): Promise<NativeCharacterImageTask[]> {
  if (!isNativeProjectId(ownerProjectId)) throw invalid();
  const rows = await withDatabase(false, async (tx) => {
    await readProject(tx, ownerProjectId);
    return readRows(tx.objectStore(EXCHANGE), ownerProjectId);
  });
  return rows.filter((row) => row.ownerProjectId === ownerProjectId && pending(row.status)).map(taskSummary);
}

/** 用户结束原请求跟踪。保留回执和已有产物，不调用厂商。 */
export async function reviewNativeCharacterImageTask(ownerProjectId: string, characterId: string, operationId: string,
  assertCurrent: () => void, expectedStatus: 'prepared' | 'outcome-unknown'): Promise<void> {
  if (!isNativeProjectId(ownerProjectId) || !validId(characterId) || !UUID.test(operationId)
    || active.has(taskKey(ownerProjectId, operationId))) throw invalid();
  const row = await withDatabase(false, async (tx) => validate(await request(tx.objectStore(EXCHANGE)
    .get(taskKey(ownerProjectId, operationId))) as Receipt | undefined));
  if (row.ownerProjectId !== ownerProjectId || row.characterId !== characterId
    || row.status !== expectedStatus || active.has(row.projectId)) throw invalid();
  await changeReceipt(row, { status: row.status === 'prepared' ? 'failed' : 'reviewed' }, () => {
    if (active.has(row.projectId)) throw invalid();
    assertCurrent();
  });
}

export async function runNativeCharacterImageTask(input: {
  guard: NativeCharacterImageSubmissionGuard;
  modelRef: string;
  connectionId: string;
  requestMaterial: unknown;
  dimensions: Size;
  expectedCount: number;
  signal?: AbortSignal;
  mediaDownloadAccess?: MediaDownloadAccess;
  resume?: boolean;
  isDefinitiveFailure?: (error: unknown) => boolean;
  execute: (beforePost: () => Promise<void>, retainRecovery: (recovery: CharacterImageTaskRecovery) => Promise<void>,
    originalRecovery?: CharacterImageTaskRecovery) => Promise<string[] & { incomplete?: true }>;
}): Promise<BatchImageResult> {
  const { guard, modelRef, connectionId, expectedCount, signal } = input;
  if (!isTauriEnv() || !isNativeCharacterImageSubmissionGuard(guard) || !validSize(input.dimensions)
    || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > MAX_CHARACTER_OUTPUTS) throw invalid();
  const { ownerProjectId, projectEpoch, characterId, operationId } = guard;
  const key = taskKey(ownerProjectId, operationId);
  const target = `${ownerProjectId}:${characterId}`;
  if ([...active.values()].includes(target) || active.has(key)) throw new Error('此角色已有进行中的生图任务');
  active.set(key, target);
  let row: Receipt | undefined;
  let sent = false;
  try {
    signal?.throwIfAborted();
    guard();
    const proof = guards.get(guard);
    const requestFingerprint = proof?.fingerprint
      ?? await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken([modelRef, connectionId, input.requestMaterial])));
    row = await withDatabase(true, async (tx) => {
      const project = await readProject(tx, ownerProjectId, projectEpoch);
      await assertNoPendingNativeSharedSync(tx, ownerProjectId);
      const store = tx.objectStore(EXCHANGE);
      if (input.resume) {
        const previous = validate(await request(store.get(key)) as Receipt | undefined);
        if (previous.ownerProjectId !== ownerProjectId || previous.projectEpoch !== projectEpoch || previous.characterId !== characterId
          || previous.resultRootRef !== project.storageRootRef || previous.modelRef !== modelRef || previous.providerConfigId !== connectionId
          || previous.requestFingerprint !== requestFingerprint || !pending(previous.status) && previous.status !== 'completed') throw invalid();
        return previous;
      }
      const rows = await readRows(store, ownerProjectId);
      if (rows.some((previous) => previous.characterId === characterId && previous.projectEpoch === projectEpoch
        && previous.requestFingerprint === requestFingerprint && pending(previous.status))) {
        throw new Error('相同输入已有未结算任务，请先核对原回执');
      }
      const now = Date.now();
      const next = validate({ projectId: key, kind: KIND, ownerProjectId, projectEpoch, characterId, operationId,
        resultRootRef: project.storageRootRef, modelRef, providerConfigId: connectionId, requestFingerprint,
        status: 'prepared', outputs: [], revision: 0, createdAt: now, updatedAt: now });
      guard();
      signal?.throwIfAborted();
      await request(store.add(next));
      return next;
    });
    if (row.status === 'completed') return { requestedCount: expectedCount, results: await projectCandidates(row), failedCount: 0, allTasksSettled: true };
    sent = row.status === 'outcome-unknown';
    const urls = await input.execute(async () => {
      if (input.resume) throw new Error('原角色任务恢复不能重新提交生成');
      if (!row || row.status !== 'prepared') throw invalid();
      signal?.throwIfAborted();
      guard();
      row = await changeReceipt(row, { status: 'outcome-unknown' });
      signal?.throwIfAborted();
      guard();
      proof?.onSubmit?.();
      sent = true;
    }, async (recovery) => {
      if (!row || recovery.modelRef !== modelRef || recovery.connectionId !== connectionId) throw invalid();
      validateCharacterImageTaskRecovery(recovery);
      row = await changeReceipt(row, { recovery });
    }, row.recovery);
    if (!sent || !urls.length || urls.length > MAX_CHARACTER_OUTPUTS) {
      throw new Error('角色生图未返回可保存的图片结果');
    }
    const root = await getProjectDataDir(ownerProjectId);
    if (!root) throw invalid();
    let failedSaves = 0;
    for (const url of urls) {
      let image: Awaited<ReturnType<typeof saveCharacterVisualResult>>;
      try { image = await saveCharacterVisualResult(url, root, `character-image-${operationId}-${crypto.randomUUID().slice(0, 8)}`, input.mediaDownloadAccess); }
      catch { failedSaves++; continue; }
      const file = await captureNativeMediaLocalResult(ownerProjectId, image.filePath);
      if (!row.outputs.some((output) => output.sha256 === file.sha256)) {
        const ordinal = row.outputs.reduce((next, output) => Math.max(next, output.index + 1), 0);
        row = await changeReceipt(row, { outputs: [...row.outputs, { ...file, width: image.width, height: image.height, index: ordinal }] });
      }
      if (image.filePath !== joinPath(root, file.relativePath)) await remove(image.filePath).catch(() => undefined);
    }
    if (!row.outputs.length) throw new Error('角色生图候选未完整保存');
    if (failedSaves || urls.incomplete) throw new Error('部分角色图片尚未保存，可从原任务继续查询');
    row = await changeReceipt(row, { status: 'completed' });
    return { requestedCount: expectedCount, results: await projectCandidates(row), failedCount: Math.max(0, expectedCount - row.outputs.length), allTasksSettled: true };
  } catch (error) {
    if (!row) throw error;
    if (!sent || getHttpResponseError(error)?.definitiveFailure || error instanceof PollTaskFailedError || input.isDefinitiveFailure?.(error)) {
      await changeReceipt(row, { status: 'failed' }).catch(() => undefined);
      throw error;
    }
    if (row.status === 'completed') throw new Error('原角色生图已保存，请从生成历史查看', { cause: error });
    const unresolved = new Error('原角色生图结果尚未确认，已保留回执与可用候选。请核对生成历史。', { cause: error });
    unresolved.name = 'NativeMediaTaskPending';
    throw Object.assign(unresolved, { nativeOperationId: operationId });
  } finally { active.delete(key); }
}
