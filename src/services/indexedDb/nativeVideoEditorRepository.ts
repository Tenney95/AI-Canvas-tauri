/** 新画布的剪辑工程与画布代际在同一新库事务中核验；不升级现有数据库。 */
import type { CanvasContext } from '../../types/project';
import type { VideoEditorProjectRecord } from '../../types/videoEditor';
import { parseProjectExpectedContext } from '../projectExecutionContext';
import { validateNativeVideoEditorRecord as validateStored } from '../videoEditorRecordValidation';
export { validateNativeVideoEditorRecord } from '../videoEditorRecordValidation';
import { CANVASES, EPISODES, EXCHANGE, REVISIONS, RETIRED, ROOTS, TRANSFER, assertNoPendingNativeSharedSync,
  isNativeCanvasId, isNativeProjectId, openNativeProjectDatabase, readCanvasTarget, transact,
  type NativeProjectOptions } from './nativeProjectRepository';

const PREFIX = 'video-editor:';
const LEASE_PREFIX = 'video-editor-lease:';
type EditorEnvelope = { projectId: string; kind: 'video-editor-v1'; ownerProjectId: string; canvasId: string; record: VideoEditorProjectRecord };
const stores = [ROOTS, CANVASES, EPISODES, REVISIONS, EXCHANGE, TRANSFER] as const;
const req = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('剪辑工程读取失败'));
});
const keyFor = (id: string) => `${PREFIX}${id}`;

function expectedCanvas(context: Readonly<CanvasContext>): CanvasContext {
  const expected = parseProjectExpectedContext(context);
  if (expected.kind !== 'canvas' || expected.modelGeneration !== 1 || !isNativeProjectId(expected.projectId)
    || !isNativeCanvasId(expected.canvasId)) throw new Error('剪辑工程缺少有效的新画布上下文');
  return expected;
}
function validEditorId(id: string, canvasId: string): boolean {
  return typeof id === 'string' && id.startsWith(`${canvasId}::`) && id.length <= 256
    && Array.from(id).every((character) => {
      const code = character.charCodeAt(0); return code > 31 && (code < 127 || code > 159);
    }) && id.length > canvasId.length + 2;
}
async function assertTarget(tx: IDBTransaction, context: CanvasContext): Promise<void> {
  const { project, canvas } = await readCanvasTarget(tx, context.projectId, context.canvasId);
  if (project.epoch !== context.projectEpoch || canvas.epoch !== context.canvasEpoch || canvas.episodeId !== context.episodeId) {
    throw new Error('剪辑工程原画布代际已变化');
  }
  await assertNoPendingNativeSharedSync(tx, context.projectId);
}
async function assertSession(tx: IDBTransaction, context: CanvasContext, sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined) return;
  const row = await req(tx.objectStore(EXCHANGE).get(`${LEASE_PREFIX}${context.canvasId}`)) as
    { kind?: string; ownerProjectId?: string; canvasId?: string; sessionId?: string; runtimeEpoch?: string } | undefined;
  if (!row || row.kind !== 'video-editor-lease-v1' || row.ownerProjectId !== context.projectId
    || row.canvasId !== context.canvasId || row.sessionId !== sessionId || row.runtimeEpoch !== context.runtimeEpoch) {
    throw new Error('剪辑窗口原会话已撤销');
  }
}
function unwrap(value: unknown, context: CanvasContext, id: string): VideoEditorProjectRecord | null {
  if (value === undefined) return null;
  const row = value as Partial<EditorEnvelope>;
  if (!row || row.kind !== 'video-editor-v1' || row.projectId !== keyFor(id)
    || row.ownerProjectId !== context.projectId || row.canvasId !== context.canvasId || !row.record || row.record.id !== id) {
    throw new Error('剪辑工程归属已变化');
  }
  validateStored(row.record, context.canvasId);
  return row.record;
}
async function bump(tx: IDBTransaction, projectId: string): Promise<void> {
  const store = tx.objectStore(REVISIONS), row = await req(store.get(projectId)) as { projectId: string; changeRevision: number } | undefined;
  if (!row || row.projectId !== projectId || !Number.isSafeInteger(row.changeRevision) || row.changeRevision < 0
    || row.changeRevision >= Number.MAX_SAFE_INTEGER) throw new Error('项目版本无效');
  await req(store.put({ ...row, changeRevision: row.changeRevision + 1 }));
}
async function withDatabase<T>(context: Readonly<CanvasContext>, mode: IDBTransactionMode,
  work: (tx: IDBTransaction, expected: CanvasContext) => Promise<T>, options: NativeProjectOptions = {}): Promise<T> {
  const expected = expectedCanvas(context), db = await openNativeProjectDatabase(false, options);
  if (!db) throw new Error('新项目不存在');
  try { return await transact(db, mode, options, async (tx) => { await assertTarget(tx, expected); return work(tx, expected); }, stores); }
  finally { db.close(); }
}

export async function assertNativeVideoEditorContext(context: Readonly<CanvasContext>, options: NativeProjectOptions = {}, sessionId?: string): Promise<void> {
  await withDatabase(context, 'readonly', async (tx, expected) => assertSession(tx, expected, sessionId), options);
}
export async function readNativeVideoEditorProject(id: string, context: Readonly<CanvasContext>, options: NativeProjectOptions = {}, sessionId?: string): Promise<VideoEditorProjectRecord | null> {
  return withDatabase(context, 'readonly', async (tx, expected) => {
    await assertSession(tx, expected, sessionId);
    if (!validEditorId(id, expected.canvasId)) throw new Error('剪辑工程键与原画布不一致');
    return unwrap(await req(tx.objectStore(EXCHANGE).get(keyFor(id))), expected, id);
  }, options);
}
export async function writeNativeVideoEditorProject(record: VideoEditorProjectRecord, context: Readonly<CanvasContext>,
  compare: { expected: VideoEditorProjectRecord | null } | null, options: NativeProjectOptions = {}, sessionId?: string): Promise<void> {
  const fixed = structuredClone(record), prior = compare ? structuredClone(compare.expected) : undefined;
  await withDatabase(context, 'readwrite', async (tx, expected) => {
    await assertSession(tx, expected, sessionId);
    validateStored(fixed, expected.canvasId);
    const store = tx.objectStore(EXCHANGE), existing = unwrap(await req(store.get(keyFor(fixed.id))), expected, fixed.id);
    if (compare ? JSON.stringify(existing) !== JSON.stringify(prior) : (existing?.automationRevision ?? 0) !== (fixed.automationRevision ?? 0)) {
      throw new Error(compare ? '剪辑工程已变化，请重新读取后提交' : '剪辑工程已被 MCP 更新，请重新读取工程后编辑');
    }
    const envelope: EditorEnvelope = { projectId: keyFor(fixed.id), kind: 'video-editor-v1', ownerProjectId: expected.projectId,
      canvasId: expected.canvasId, record: fixed };
    await req(store.put(envelope));
    await bump(tx, expected.projectId);
  }, options);
}

/** 主窗口创建会话后写入租约；画布切换时条件撤销，不能误撤销更新的会话。 */
export async function bindNativeVideoEditorSession(context: Readonly<CanvasContext>, sessionId: string, options: NativeProjectOptions = {}): Promise<void> {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId) || !context.runtimeEpoch) throw new Error('剪辑窗口会话无效');
  await withDatabase(context, 'readwrite', async (tx, expected) => {
    await req(tx.objectStore(EXCHANGE).put({ projectId: `${LEASE_PREFIX}${expected.canvasId}`, kind: 'video-editor-lease-v1',
      ownerProjectId: expected.projectId, canvasId: expected.canvasId, sessionId, runtimeEpoch: expected.runtimeEpoch }));
  }, options);
}
export async function revokeNativeVideoEditorSession(canvasId: string, sessionId: string, options: NativeProjectOptions = {}): Promise<void> {
  if (!isNativeCanvasId(canvasId) || !/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('剪辑窗口会话无效');
  const db = await openNativeProjectDatabase(false, options);
  if (!db) return;
  try {
    await transact(db, 'readwrite', options, async (tx) => {
      const store = tx.objectStore(EXCHANGE), key = `${LEASE_PREFIX}${canvasId}`;
      const row = await req(store.get(key)) as { kind?: string; sessionId?: string } | undefined;
      if (row?.kind === 'video-editor-lease-v1' && row.sessionId === sessionId) await req(store.delete(key));
    }, [EXCHANGE]);
  } finally { db.close(); }
}
export async function deleteNativeVideoEditorProject(id: string, context: Readonly<CanvasContext>, options: NativeProjectOptions = {}): Promise<void> {
  await withDatabase(context, 'readwrite', async (tx, expected) => {
    if (!validEditorId(id, expected.canvasId)) throw new Error('剪辑工程键与原画布不一致');
    const store = tx.objectStore(EXCHANGE), existing = unwrap(await req(store.get(keyFor(id))), expected, id);
    if (existing) { await req(store.delete(keyFor(id))); await bump(tx, expected.projectId); }
  }, options);
}

/** 归档/恢复检查使用所有活动及墓碑画布的原始工程；不依赖画布仍然活动。 */
export async function listNativeVideoEditorProjectsForProject(projectId: string, options: NativeProjectOptions = {}): Promise<VideoEditorProjectRecord[]> {
  if (!isNativeProjectId(projectId)) throw new Error('新项目身份无效');
  const db = await openNativeProjectDatabase(false, options);
  if (!db) return [];
  try {
    return await transact(db, 'readonly', options, async (tx) => {
      const result: VideoEditorProjectRecord[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursor = tx.objectStore(EXCHANGE).openCursor(IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`));
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) { resolve(); return; }
          const row = item.value as Partial<EditorEnvelope>;
          if (!row || row.kind !== 'video-editor-v1' || typeof row.ownerProjectId !== 'string' || !isNativeProjectId(row.ownerProjectId)
            || typeof row.canvasId !== 'string' || !isNativeCanvasId(row.canvasId) || !row.record
            || row.projectId !== keyFor(row.record.id)) { reject(new Error('剪辑工程索引损坏')); return; }
          if (row.ownerProjectId === projectId) { try { validateStored(row.record, row.canvasId); result.push(row.record); } catch (error) { reject(error); return; } }
          item.continue();
        };
        cursor.onerror = () => reject(cursor.error ?? new Error('剪辑工程索引读取失败'));
      });
      return result;
    }, [EXCHANGE]);
  } finally { db.close(); }
}

/** 已删除画布只能作为只读历史范围，墓碑不是编辑授权。 */
export async function readNativeRetiredCanvasOwner(canvasId: string, options: NativeProjectOptions = {}): Promise<string | null> {
  if (!isNativeCanvasId(canvasId)) return null;
  const db = await openNativeProjectDatabase(false, options);
  if (!db) return null;
  try {
    return await transact(db, 'readonly', options, async (tx) => {
      const row = await req(tx.objectStore(RETIRED).get(canvasId)) as { id?: unknown; projectId?: unknown; kind?: unknown } | undefined;
      if (!row) return null;
      if (row.id !== canvasId || row.kind !== 'canvas' || !isNativeProjectId(row.projectId)) throw new Error('已删除画布身份损坏');
      return row.projectId;
    }, [RETIRED]);
  } finally { db.close(); }
}
