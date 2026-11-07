/**
 * 剪辑工程仓储 — `videoEditorProjects` 表的读写
 *
 * 工程与视频节点是一对一：节点 ID 即定位键，独立窗口和主窗口同源共享同一个库。
 */
import type { VideoEditorProjectRecord } from '../../types/videoEditor';
import { VIDEO_EDITOR_SCHEMA_VERSION } from '../../types/videoEditor';
import type { CanvasContext } from '../../types/project';
import { parseProjectExpectedContext } from '../projectExecutionContext';
import { withRelocatedMedia } from './mediaRelocations';
import { openDB, STORE_METADATA, STORE_PROJECTS, STORE_VIDEO_EDITOR_PROJECTS } from './schema';
import { withLegacyProjectWrite } from './legacyProjectWriteGuard';

function captureExpected(context: Readonly<CanvasContext> | undefined): CanvasContext {
  const expected = parseProjectExpectedContext(context);
  if (expected.kind !== 'canvas' || expected.modelGeneration !== 0) throw new Error('剪辑工程缺少有效的旧画布上下文');
  return expected;
}

function withCurrentCanvas(transaction: IDBTransaction, projectId: string, context: Readonly<CanvasContext> | undefined,
  ready: () => void, fail: (error: Error) => void) {
  try {
    const expected = parseProjectExpectedContext(context);
    if (expected.kind !== 'canvas' || expected.modelGeneration !== 0 || expected.canvasId !== projectId) throw new Error('剪辑工程缺少有效的旧画布上下文');
    withLegacyProjectWrite(transaction, () => {
      const request = transaction.objectStore(STORE_PROJECTS).get(projectId);
      request.onsuccess = () => {
        const canvas = request.result as { id: string; parentId?: string; exchangeEpoch?: number } | undefined;
        if (!canvas || (canvas.parentId ?? canvas.id) !== expected.projectId || (canvas.parentId ? canvas.id : null) !== expected.episodeId
          || (canvas.exchangeEpoch ?? 0) !== expected.canvasEpoch) { fail(new Error('剪辑工程原画布代际已变化')); return; }
        const ownerRequest = transaction.objectStore(STORE_PROJECTS).get(expected.projectId);
        ownerRequest.onsuccess = () => {
          const owner = ownerRequest.result as { parentId?: string; exchangeEpoch?: number } | undefined;
          if (!owner || owner.parentId || (owner.exchangeEpoch ?? 0) !== expected.projectEpoch) { fail(new Error('剪辑工程所属项目代际已变化')); return; }
          ready();
        };
      };
    }, fail);
  } catch (error) { fail(error instanceof Error ? error : new Error('剪辑工程上下文无效')); }
}

/** 独立窗口只有持久化代际，不继承主窗口Store或运行时授权。文件effect前仍需此只读预检。 */
export async function assertVideoEditorProjectContext(projectId: string, context: Readonly<CanvasContext> | undefined): Promise<void> {
  context = captureExpected(context);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_PROJECTS, STORE_METADATA], 'readonly');
    let failure: Error | undefined;
    const fail = (error: Error) => { failure = error; try { transaction.abort(); } catch { reject(error); } };
    withCurrentCanvas(transaction, projectId, context, () => undefined, fail);
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('剪辑工程上下文核对失败'));
  });
}

/** 由画布项目与节点推出稳定的工程 ID，避免重复开窗产生多份工程 */
export function buildVideoEditorProjectId(projectId: string, nodeId: string): string {
  return `${projectId}::${nodeId}`;
}

export async function saveVideoEditorProject(record: VideoEditorProjectRecord, context?: Readonly<CanvasContext>): Promise<void> {
  context = captureExpected(context);
  record = structuredClone(record);
  if (!record.id.startsWith(`${record.projectId}::`)) throw new Error('剪辑工程键与原画布不一致');
  if ((record.schemaVersion ?? 0) > VIDEO_EDITOR_SCHEMA_VERSION) throw new Error('不能保存更高版本的剪辑工程');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_VIDEO_EDITOR_PROJECTS, STORE_PROJECTS, STORE_METADATA], 'readwrite');
    let failure: Error | undefined;
    const fail = (error: Error) => { failure = error; try { transaction.abort(); } catch { reject(error); } };
    const store = transaction.objectStore(STORE_VIDEO_EDITOR_PROJECTS);
    withCurrentCanvas(transaction, record.projectId, context, () => {
      const request = store.get(record.id);
      request.onsuccess = () => {
        const current = request.result as VideoEditorProjectRecord | undefined;
        if (current && current.projectId !== record.projectId) { fail(new Error('剪辑工程归属已变化')); return; }
        if ((current?.schemaVersion ?? 0) > VIDEO_EDITOR_SCHEMA_VERSION) { fail(new Error('不能覆盖更高版本的剪辑工程')); return; }
        if ((current?.automationRevision ?? 0) !== (record.automationRevision ?? 0)) {
          reject(new Error('剪辑工程已被 MCP 更新，请重新读取工程后编辑'));
          transaction.abort();
          return;
        }
        withRelocatedMedia(transaction, record, (next) => store.put(next));
      };
    }, fail);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(failure ?? new Error('剪辑工程事务已取消'));
  });
}

/** 同一 IDB 事务内比较完整快照并写入，防止异步读取后覆盖人工作业。 */
export async function compareAndSaveVideoEditorProject(
  record: VideoEditorProjectRecord,
  expected: VideoEditorProjectRecord | null,
  context?: Readonly<CanvasContext>,
): Promise<void> {
  context = captureExpected(context);
  record = structuredClone(record); expected = structuredClone(expected);
  if (!record.id.startsWith(`${record.projectId}::`)) throw new Error('剪辑工程键与原画布不一致');
  if ((record.schemaVersion ?? 0) > VIDEO_EDITOR_SCHEMA_VERSION) throw new Error('不能保存更高版本的剪辑工程');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_VIDEO_EDITOR_PROJECTS, STORE_PROJECTS, STORE_METADATA], 'readwrite');
    let failure: Error | undefined;
    const fail = (error: Error) => { failure = error; try { transaction.abort(); } catch { reject(error); } };
    const store = transaction.objectStore(STORE_VIDEO_EDITOR_PROJECTS);
    withCurrentCanvas(transaction, record.projectId, context, () => {
      const request = store.get(record.id);
      request.onsuccess = () => {
        if (request.result && (request.result as VideoEditorProjectRecord).projectId !== record.projectId) { fail(new Error('剪辑工程归属已变化')); return; }
        if (((request.result as VideoEditorProjectRecord | undefined)?.schemaVersion ?? 0) > VIDEO_EDITOR_SCHEMA_VERSION) { fail(new Error('不能覆盖更高版本的剪辑工程')); return; }
        if (JSON.stringify(request.result ?? null) !== JSON.stringify(expected)) {
          reject(new Error('剪辑工程已变化，请重新读取后提交'));
          transaction.abort();
          return;
        }
        withRelocatedMedia(transaction, record, (next) => store.put(next));
      };
    }, fail);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('剪辑工程保存失败'));
    transaction.onabort = () => reject(failure ?? new Error('剪辑工程事务已取消'));
  });
}

export async function getVideoEditorProject(id: string, context?: Readonly<CanvasContext>): Promise<VideoEditorProjectRecord | null> {
  context = context === undefined ? undefined : captureExpected(context);
  if (context && !id.startsWith(`${context.canvasId}::`)) throw new Error('剪辑工程键与原画布不一致');
  const db = await openDB();
  const record = await new Promise<VideoEditorProjectRecord | undefined>((resolve, reject) => {
    const transaction = db.transaction(context === undefined ? STORE_VIDEO_EDITOR_PROJECTS
      : [STORE_VIDEO_EDITOR_PROJECTS, STORE_PROJECTS, STORE_METADATA], 'readonly');
    let result: VideoEditorProjectRecord | undefined;
    let failure: Error | undefined;
    const fail = (error: Error) => { failure = error; try { transaction.abort(); } catch { reject(error); } };
    const read = () => {
      const request = transaction.objectStore(STORE_VIDEO_EDITOR_PROJECTS).get(id);
      request.onsuccess = () => {
        result = request.result as VideoEditorProjectRecord | undefined;
        if (context && result && (result.projectId !== context.canvasId || result.id !== id)) fail(new Error('剪辑工程归属已变化'));
      };
    };
    if (context === undefined) read();
    else withCurrentCanvas(transaction, context.canvasId, context, read, fail);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('剪辑工程读取已取消'));
  });
  if (!record) return null;
  // 旧只读展示沿用null；有执行上下文的读取必须拒绝未来工程，不能借缺省重建覆盖。
  if ((record.schemaVersion ?? 0) > VIDEO_EDITOR_SCHEMA_VERSION) {
    if (context) throw new Error('剪辑工程来自更高版本，不能重建覆盖');
    return null;
  }
  return record;
}

export async function listVideoEditorProjectsByProject(
  projectId: string,
): Promise<VideoEditorProjectRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const index = db
      .transaction(STORE_VIDEO_EDITOR_PROJECTS, 'readonly')
      .objectStore(STORE_VIDEO_EDITOR_PROJECTS)
      .index('projectId_updatedAt');
    const request = index.getAll(
      IDBKeyRange.bound([projectId, -Infinity], [projectId, Infinity]),
    );
    request.onsuccess = () => {
      const records = (request.result as VideoEditorProjectRecord[])
        .filter((record) => (record.schemaVersion ?? 0) <= VIDEO_EDITOR_SCHEMA_VERSION);
      resolve(records.reverse());
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteVideoEditorProject(id: string, context?: Readonly<CanvasContext>): Promise<void> {
  context = captureExpected(context);
  if (!id.startsWith(`${context.canvasId}::`)) throw new Error('剪辑工程键与原画布不一致');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_VIDEO_EDITOR_PROJECTS, STORE_PROJECTS, STORE_METADATA], 'readwrite');
    let failure: Error | undefined;
    const fail = (error: Error) => { failure = error; try { transaction.abort(); } catch { reject(error); } };
    withCurrentCanvas(transaction, context!.canvasId, context, () => {
      const store = transaction.objectStore(STORE_VIDEO_EDITOR_PROJECTS), request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as VideoEditorProjectRecord | undefined;
        if ((record?.schemaVersion ?? 0) > VIDEO_EDITOR_SCHEMA_VERSION) { fail(new Error('不能删除更高版本的剪辑工程')); return; }
        if (record && record.projectId !== context!.canvasId) { fail(new Error('剪辑工程归属已变化')); return; }
        store.delete(id);
      };
    }, fail);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(failure ?? new Error('剪辑工程删除已取消'));
  });
}
