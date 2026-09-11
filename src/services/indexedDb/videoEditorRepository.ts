/**
 * 剪辑工程仓储 — `videoEditorProjects` 表的读写
 *
 * 工程与视频节点是一对一：节点 ID 即定位键，独立窗口和主窗口同源共享同一个库。
 */
import type { VideoEditorProjectRecord } from '../../types/videoEditor';
import { VIDEO_EDITOR_SCHEMA_VERSION } from '../../types/videoEditor';
import { openDB, STORE_VIDEO_EDITOR_PROJECTS } from './schema';

/** 由画布项目与节点推出稳定的工程 ID，避免重复开窗产生多份工程 */
export function buildVideoEditorProjectId(projectId: string, nodeId: string): string {
  return `${projectId}::${nodeId}`;
}

export async function saveVideoEditorProject(record: VideoEditorProjectRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_VIDEO_EDITOR_PROJECTS, 'readwrite');
    const store = transaction.objectStore(STORE_VIDEO_EDITOR_PROJECTS);
    const request = store.get(record.id);
    request.onsuccess = () => {
      const current = request.result as VideoEditorProjectRecord | undefined;
      if ((current?.automationRevision ?? 0) !== (record.automationRevision ?? 0)) {
        reject(new Error('剪辑工程已被 MCP 更新，请重新读取工程后编辑'));
        transaction.abort();
        return;
      }
      store.put(record);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(new Error('剪辑工程事务已取消'));
  });
}

/** 同一 IDB 事务内比较完整快照并写入，防止异步读取后覆盖人工作业。 */
export async function compareAndSaveVideoEditorProject(
  record: VideoEditorProjectRecord,
  expected: VideoEditorProjectRecord | null,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_VIDEO_EDITOR_PROJECTS, 'readwrite');
    const store = transaction.objectStore(STORE_VIDEO_EDITOR_PROJECTS);
    const request = store.get(record.id);
    request.onsuccess = () => {
      if (JSON.stringify(request.result ?? null) !== JSON.stringify(expected)) {
        reject(new Error('剪辑工程已变化，请重新读取后提交'));
        transaction.abort();
        return;
      }
      store.put(record);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('剪辑工程保存失败'));
    transaction.onabort = () => reject(new Error('剪辑工程事务已取消'));
  });
}

export async function getVideoEditorProject(id: string): Promise<VideoEditorProjectRecord | null> {
  const db = await openDB();
  const record = await new Promise<VideoEditorProjectRecord | undefined>((resolve, reject) => {
    const request = db
      .transaction(STORE_VIDEO_EDITOR_PROJECTS, 'readonly')
      .objectStore(STORE_VIDEO_EDITOR_PROJECTS)
      .get(id);
    request.onsuccess = () => resolve(request.result as VideoEditorProjectRecord | undefined);
    request.onerror = () => reject(request.error);
  });
  if (!record) return null;
  // 未来版本写入的工程本进程读不懂，按「没有工程」处理并重建，好过按缺字段渲染
  if ((record.schemaVersion ?? 0) > VIDEO_EDITOR_SCHEMA_VERSION) return null;
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

export async function deleteVideoEditorProject(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_VIDEO_EDITOR_PROJECTS, 'readwrite');
    transaction.objectStore(STORE_VIDEO_EDITOR_PROJECTS).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
