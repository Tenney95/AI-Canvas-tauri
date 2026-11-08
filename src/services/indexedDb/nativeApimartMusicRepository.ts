/** APIMart 音乐阶段只保存原任务身份和内容文件证据；提示词／歌词正文不进入账本。 */
import type { NativeMediaTaskRecord } from './nativeMediaTaskRepository';
import { validateNativeMediaTaskRecord } from './nativeMediaTaskRepository';
import { configValuesEqual } from '../configPatch';
import { CANVASES, EPISODES, EXCHANGE, REVISIONS, ROOTS, TRANSFER, assertNoPendingNativeSharedSync, increment,
  openNativeProjectDatabase, readCanvasTarget, transact, type NativeProjectOptions } from './nativeProjectRepository';

export interface NativeAudioContentFile { relativePath: string; bytes: number; sha256: string; mimeType: 'application/json' }
type StageName = 'lyrics' | 'music';
export interface NativeMusicStage {
  submissionId: string; state: 'prepared' | 'not-started' | 'unknown' | 'submitted' | 'completed' | 'failed' | 'not-needed';
  taskId?: string; resultFile?: NativeAudioContentFile;
}
export interface NativeApimartMusicState {
  projectId: string; kind: 'native-apimart-music-v1'; operationId: string; ownerProjectId: string; canvasId: string;
  episodeId: string | null; projectEpoch: number; canvasEpoch: number; submissionLease: string;
  inputFile: NativeAudioContentFile; lyrics: NativeMusicStage; music: NativeMusicStage;
  revision: number; createdAt: number; updatedAt: number;
}
const PREFIX = 'apimart-music:';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stores = [ROOTS, EPISODES, CANVASES, EXCHANGE, TRANSFER, REVISIONS] as const;
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const fail = (): never => { throw new Error('原音乐阶段或提交身份已变化，回执保留，不会重新提交'); };
export function validateNativeAudioContentFile(file: NativeAudioContentFile): void {
  if (!file || Object.keys(file).some((key) => !['relativePath', 'bytes', 'sha256', 'mimeType'].includes(key))
    || file.mimeType !== 'application/json' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 256 * 1024
    || !/^[a-f0-9]{64}$/.test(file.sha256) || file.relativePath !== `media/${file.sha256}.json`) return fail();
}
function validate(value: NativeApimartMusicState): NativeApimartMusicState {
  if (!value || value.kind !== 'native-apimart-music-v1' || !UUID.test(value.operationId) || !UUID.test(value.submissionLease)
    || value.projectId !== `${PREFIX}${value.operationId}` || !/^p2-[a-f0-9-]{36}$/.test(value.ownerProjectId)
    || !/^c2-[a-f0-9-]{36}$/.test(value.canvasId) || !(value.episodeId === null || /^e2-[a-f0-9-]{36}$/.test(value.episodeId))
    || ![value.projectEpoch, value.canvasEpoch, value.revision, value.createdAt, value.updatedAt].every((item) => Number.isSafeInteger(item) && item >= 0 && item < Number.MAX_SAFE_INTEGER)
    || Object.keys(value).some((key) => !['projectId', 'kind', 'operationId', 'ownerProjectId', 'canvasId', 'episodeId', 'projectEpoch', 'canvasEpoch',
      'submissionLease', 'inputFile', 'lyrics', 'music', 'revision', 'createdAt', 'updatedAt'].includes(key))) return fail();
  validateNativeAudioContentFile(value.inputFile);
  for (const name of ['lyrics', 'music'] as const) {
    const stage = value[name];
    if (!stage || !UUID.test(stage.submissionId) || Object.keys(stage).some((key) => !['submissionId', 'state', 'taskId', 'resultFile'].includes(key))
      || !['prepared', 'not-started', 'unknown', 'submitted', 'completed', 'failed', 'not-needed'].includes(stage.state)
      || stage.taskId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(stage.taskId)
      || ['submitted', 'completed'].includes(stage.state) && !stage.taskId
      || ['prepared', 'not-started', 'unknown', 'not-needed'].includes(stage.state) && stage.taskId !== undefined
      || name === 'music' && (stage.state === 'not-needed' || stage.resultFile)
      || stage.resultFile && (name !== 'lyrics' || stage.state !== 'completed')
      || name === 'lyrics' && stage.state === 'completed' && !stage.resultFile) return fail();
    if (stage.resultFile) validateNativeAudioContentFile(stage.resultFile);
  }
  return value;
}
function sameScope(value: NativeApimartMusicState, parent: NativeMediaTaskRecord): void {
  if (value.operationId !== parent.operationId || value.ownerProjectId !== parent.ownerProjectId || value.canvasId !== parent.canvasId
    || value.episodeId !== parent.episodeId || value.projectEpoch !== parent.projectEpoch || value.canvasEpoch !== parent.canvasEpoch
    || parent.recovery?.kind !== 'builtin-audio' || parent.providerConfigId !== 'apimart' || parent.submissionKind !== 'async'
    || value.inputFile.sha256 !== parent.requestFingerprint) return fail();
}
async function database<T>(mode: IDBTransactionMode, options: NativeProjectOptions, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try { return await transact(db, mode, options, async (tx) => {
    if (mode === 'readwrite' && tx.durability !== 'strict') return fail();
    return work(tx);
  }, stores, mode === 'readwrite'); } finally { db.close(); }
}
async function parentIn(tx: IDBTransaction, state: NativeApimartMusicState): Promise<NativeMediaTaskRecord> {
  const row = await request(tx.objectStore(EXCHANGE).get(`media-task:${state.operationId}`)) as NativeMediaTaskRecord | undefined;
  if (!row) return fail();
  const parent = validateNativeMediaTaskRecord(row); sameScope(state, parent); return parent;
}
async function save(tx: IDBTransaction, state: NativeApimartMusicState): Promise<NativeApimartMusicState> {
  state.revision = increment(state.revision); state.updatedAt = Date.now(); validate(state);
  const revision = await request(tx.objectStore(REVISIONS).get(state.ownerProjectId)) as { projectId: string; changeRevision: number } | undefined;
  await request(tx.objectStore(EXCHANGE).put(state));
  if (revision) {
    if (revision.projectId !== state.ownerProjectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail();
    await request(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: increment(revision.changeRevision) }));
  }
  return state;
}
export async function prepareNativeApimartMusicState(record: NativeMediaTaskRecord, inputFile: NativeAudioContentFile,
  needsLyrics: boolean, options: NativeProjectOptions = {}): Promise<NativeApimartMusicState> {
  validateNativeAudioContentFile(inputFile); const now = Date.now();
  const state = validate({ projectId: `${PREFIX}${record.operationId}`, kind: 'native-apimart-music-v1', operationId: record.operationId,
    ownerProjectId: record.ownerProjectId, canvasId: record.canvasId, episodeId: record.episodeId, projectEpoch: record.projectEpoch,
    canvasEpoch: record.canvasEpoch, submissionLease: record.lease, inputFile: structuredClone(inputFile),
    lyrics: { submissionId: crypto.randomUUID(), state: needsLyrics ? 'prepared' : 'not-needed' },
    music: { submissionId: crypto.randomUUID(), state: 'prepared' }, revision: 0, createdAt: now, updatedAt: now });
  return database('readwrite', options, async (tx) => {
    const parent = await parentIn(tx, state);
    if (parent.lease !== record.lease || parent.revision !== record.revision || parent.status !== 'prepared') return fail();
    await assertNoPendingNativeSharedSync(tx, parent.ownerProjectId);
    await request(tx.objectStore(EXCHANGE).add(state)); return state;
  });
}
export async function readNativeApimartMusicState(record: NativeMediaTaskRecord, options: NativeProjectOptions = {}): Promise<NativeApimartMusicState> {
  return database('readonly', options, async (tx) => {
    const row = await request(tx.objectStore(EXCHANGE).get(`${PREFIX}${record.operationId}`)) as NativeApimartMusicState | undefined;
    if (!row) return fail(); const state = validate(row); sameScope(state, record); return state;
  });
}
/** 只有可证明从未发送的槽位能进入新 POST；unknown 永不重放。 */
export async function beginNativeApimartMusicStage(expected: NativeApimartMusicState, name: StageName, expectedCanvasRevision: number,
  options: NativeProjectOptions = {}): Promise<NativeApimartMusicState> {
  return database('readwrite', options, async (tx) => {
    const row = await request(tx.objectStore(EXCHANGE).get(expected.projectId)) as NativeApimartMusicState | undefined;
    if (!row) return fail(); const state = validate(row), parent = await parentIn(tx, state);
    const { project, canvas } = await readCanvasTarget(tx, state.ownerProjectId, state.canvasId);
    if (parent.status === 'reviewed' || parent.status === 'delivered' || parent.status === 'failed'
      || state.revision !== expected.revision || !configValuesEqual(state.inputFile, expected.inputFile)
      || !['prepared', 'not-started'].includes(state[name].state) || parent.remoteTaskId
      || project.epoch !== state.projectEpoch || canvas.epoch !== state.canvasEpoch || canvas.episodeId !== state.episodeId
      || canvas.revision !== expectedCanvasRevision
      || name === 'music' && !['not-needed', 'completed'].includes(state.lyrics.state)) return fail();
    await assertNoPendingNativeSharedSync(tx, state.ownerProjectId);
    state[name].state = 'unknown'; return save(tx, state);
  });
}
export async function recordNativeApimartMusicStage(expected: NativeApimartMusicState, name: StageName,
  outcome: { taskId: string } | { notStarted: true } | { failed: true } | { resultFile: NativeAudioContentFile } | { completed: true },
  options: NativeProjectOptions = {}): Promise<NativeApimartMusicState> {
  return database('readwrite', options, async (tx) => {
    const row = await request(tx.objectStore(EXCHANGE).get(expected.projectId)) as NativeApimartMusicState | undefined;
    if (!row) return fail(); const state = validate(row), parent = await parentIn(tx, state);
    const stage = state[name]; if (stage.submissionId !== expected[name].submissionId) return fail();
    if ('taskId' in outcome) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(outcome.taskId) || stage.taskId && stage.taskId !== outcome.taskId) return fail();
      if (stage.taskId === outcome.taskId) return state;
      if (stage.state !== 'unknown') return fail(); stage.taskId = outcome.taskId; stage.state = 'submitted';
    } else {
      if ('completed' in outcome && name === 'music' && stage.state === 'completed') return state;
      if ('resultFile' in outcome) {
        validateNativeAudioContentFile(outcome.resultFile);
        if (stage.state === 'completed' && configValuesEqual(stage.resultFile, outcome.resultFile)) return state;
      }
      if (state.revision !== expected.revision) return fail();
      if ('notStarted' in outcome) { if (stage.state !== 'unknown') return fail(); stage.state = 'not-started'; }
      else if ('failed' in outcome) { if (!['unknown', 'submitted'].includes(stage.state)) return fail(); stage.state = 'failed'; }
      else {
        if (stage.state !== 'submitted' || !stage.taskId || name === 'lyrics' && !('resultFile' in outcome)) return fail();
        if (name === 'music' && (parent.remoteTaskId !== stage.taskId || !parent.localResults?.length)) return fail();
        stage.state = 'completed'; if ('resultFile' in outcome) stage.resultFile = structuredClone(outcome.resultFile);
      }
    }
    return save(tx, state);
  });
}
