/**
 * videoBatchRepository — 按项目保存并读取视频批次记录。
 */
import { openDB, STORE_METADATA } from './indexedDb/schema';
import type { VideoBatch } from '../types/videoBatch';
import { retainVideoBatches } from './videoBatchRunner';

export const videoBatchKey = (projectId: string) => `video-batches:${projectId}`;

export async function readVideoBatches(projectId: string): Promise<VideoBatch[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly').objectStore(STORE_METADATA).get(videoBatchKey(projectId));
    request.onsuccess = () => resolve(request.result?.batches || []);
    request.onerror = () => reject(request.error);
  });
}

export async function writeVideoBatches(projectId: string, batches: VideoBatch[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    tx.objectStore(STORE_METADATA).put({ id: videoBatchKey(projectId), batches: retainVideoBatches(batches) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
