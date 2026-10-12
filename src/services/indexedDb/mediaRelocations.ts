import { openDB, STORE_METADATA } from './schema';
import { localMediaUrlToPath } from '../../utils/mediaUrl';

export interface MediaRelocation {
  oldPath: string;
  newPath: string;
  assetUrl: string;
  oldAssetUrl?: string;
  relativePath: string;
  projectId: string;
  ownerId?: string;
  /** 用户在资源库改名时，也把对应节点的标题一起更新。 */
  renamedFileName?: string;
  /** 全局资产移动：项目引用不再使用原项目相对路径，身份保持不变。 */
  assetMove?: { assetId: string; rootPath: string; source: 'global' | 'folder'; digest: string; totalBytes: number; mtimeMs: number };
}
const JOURNAL_ID = 'media-relocations';
const STORES = ['projects', 'history', 'chatMessages', 'assetIndex', 'assetMeta', 'assetMetaV2',
  'globalCharacters', 'videoEditorProjects', 'agentTasks', 'workflows', 'presets'];
const pathKey = (path: string) => {
  const normalized = path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

/** 新文件占位使用保守身份；不改变已有大小写敏感文件的引用迁移语义。 */
export function mediaFileAllocationKey(path: string): string {
  const normalized = pathKey(path);
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform || '';
  // macOS 默认卷忽略大小写及 Unicode 规范形式；只规范查重键，磁盘名称保持原样。
  if (/^(?:mac|darwin)/i.test(platform)) return normalized.normalize('NFC').toLowerCase();
  return /^win/i.test(platform) ? normalized.toLowerCase() : normalized;
}

/** Rewrite exact file references only; prompts and arbitrary embedded text are not rewritten. */
export function relocateMediaReferences<T>(value: T, moves: readonly MediaRelocation[]): T {
  const lookup = new Map(moves.map((move) => [pathKey(move.oldPath), move]));
  const resolve = (path: string | undefined): MediaRelocation | undefined => {
    if (!path) return undefined;
    let found = lookup.get(pathKey(path));
    let result = found;
    const visited = new Set<string>();
    while (found && !visited.has(found.newPath)) {
      visited.add(found.newPath);
      result = found;
      found = lookup.get(pathKey(found.newPath));
    }
    return result;
  };
  const seen = new WeakMap<object, unknown>();
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const direct = resolve(item);
      if (direct) return direct.newPath;
      const known = moves.find((move) => move.oldAssetUrl === item);
      if (known) return resolve(known.oldPath)?.assetUrl ?? known.assetUrl;
      const local = resolve(localMediaUrlToPath(item));
      return local ? local.assetUrl : item;
    }
    if (!item || typeof item !== 'object' || (Object.getPrototypeOf(item) !== Object.prototype && !Array.isArray(item))) return item;
    const original = item as Record<string, unknown>;
    const identityMove = resolve(typeof original.filePath === 'string' ? original.filePath : typeof original.path === 'string' ? original.path : undefined);
    // 旧位置后来放入了另一份资产：旧日志只修复原身份，不能挪走新文件的索引或标签。
    if (identityMove?.assetMove?.assetId && typeof original.assetId === 'string' && original.assetId !== identityMove.assetMove.assetId) return item;
    if (seen.has(item)) return seen.get(item);
    const next: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : {};
    seen.set(item, next);
    let changed = false;
    for (const [key, child] of Object.entries(item)) {
      const rewritten = visit(child);
      (next as Record<string, unknown>)[key] = rewritten;
      if (rewritten !== child) changed = true;
    }
    const record = item as Record<string, unknown>;
    const move = resolve(typeof record.filePath === 'string' ? record.filePath : typeof record.path === 'string' ? record.path : undefined);
    if (move && !Array.isArray(next)) {
      if (move.assetMove) {
        if ('fingerprint' in record && 'assetId' in record) {
          next.rootPath = move.assetMove.rootPath;
          next.source = move.assetMove.source;
          next.relativePath = move.relativePath;
          next.mtimeMs = move.assetMove.mtimeMs;
          next.fingerprint = `${move.assetMove.totalBytes}:${move.assetMove.mtimeMs}`;
          next.size = move.assetMove.totalBytes;
          next.status = 'online';
          next.updatedAt = Date.now();
          delete next.projectId;
        } else {
          // 此路径以全局资产根目录为基准，不能交给项目目录解析。
          delete next.relativePath;
        }
      } else if ('relativePath' in record || 'filePath' in record) next.relativePath = move.relativePath;
      if (move.ownerId && 'assetId' in record) delete next.assetId;
      if ('fileName' in record) next.fileName = move.newPath.replace(/\\/g, '/').split('/').pop();
      if (move.renamedFileName && typeof record.filePath === 'string'
        && typeof record.type === 'string' && typeof record.label === 'string') {
        next.label = move.renamedFileName;
        if ('displayLabel' in record) next.displayLabel = move.renamedFileName;
      }
      changed = true;
    }
    const result = changed ? next : item;
    seen.set(item, result);
    return result;
  };
  return visit(value) as T;
}

function collectRelocationReferences(value: unknown): Set<string> | null {
  const references = new Set<string>();
  const seen = new WeakSet<object>();
  const active = new WeakSet<object>();
  let indexable = true;
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      references.add(item);
      references.add(pathKey(item));
      const local = localMediaUrlToPath(item);
      if (local) references.add(pathKey(local));
      return;
    }
    if (!item || typeof item !== 'object'
      || (Object.getPrototypeOf(item) !== Object.prototype && !Array.isArray(item))) return;
    if (active.has(item)) { indexable = false; return; }
    if (seen.has(item)) return;
    seen.add(item);
    active.add(item);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      // 有访问器或循环引用就沿用原执行顺序，索引本身不额外触发 getter。
      if (!('value' in descriptor)) { indexable = false; break; }
      visit(descriptor.value);
      if (!indexable) break;
    }
    active.delete(item);
  };
  visit(value);
  return indexable ? references : null;
}

function relocateJournalReferences<T>(value: T, moves: readonly MediaRelocation[]): T {
  if (!moves.length) return value;
  // 只有一条日志时直接执行，省掉额外建立索引的开销。
  let references = moves.length > 1 ? collectRelocationReferences(value) : null;
  let current = value;
  for (const move of moves) {
    if (references && !references.has(pathKey(move.oldPath))
      && (move.oldAssetUrl === undefined || !references.has(move.oldAssetUrl))) continue;
    const next = move.ownerId
      ? relocateOwnedMediaReferences(current, move, move.ownerId)
      : relocateMediaReferences(current, [move]);
    if (references && next !== current) {
      // 旧索引项最多让无效规则多跑一遍；补上可能新写入的字符串，就不用再扫整条记录。
      const added = collectRelocationReferences([move, move.newPath.replace(/\\/g, '/').split('/').pop(),
        move.assetMove ? `${move.assetMove.totalBytes}:${move.assetMove.mtimeMs}` : undefined, 'online']);
      if (added) for (const reference of added) references.add(reference);
      else references = null;
    }
    current = next;
  }
  return current;
}

/** Read the relocation journal inside the writer's transaction so stale saves cannot resurrect old paths. */
export function withRelocatedMedia<T>(tx: IDBTransaction, value: T, write: (next: T) => void): void {
  const request = tx.objectStore(STORE_METADATA).get(JOURNAL_ID);
  request.onsuccess = () => write(relocateJournalReferences(value, request.result?.moves ?? []));
}

export function relocateOwnedMediaReferences<T>(value: T, move: MediaRelocation, nodeId: string): T {
  const visit = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) {
      const next = item.map(visit);
      return next.some((child, index) => child !== item[index]) ? next : item;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) return item;
    const record = item as Record<string, unknown>;
    if (record.id === nodeId || record.nodeId === nodeId) return relocateMediaReferences(item, [{ ...move, ownerId: nodeId }]);
    let changed = false;
    const next = Object.fromEntries(Object.entries(record).map(([key, child]) => {
      const result = visit(child);
      if (result !== child) changed = true;
      return [key, result];
    }));
    return changed ? next : item;
  };
  return visit(value) as T;
}

export async function persistMediaRelocation(move: MediaRelocation, sharedNodeId?: string): Promise<void> {
  const db = await openDB();
  const stores = STORES.filter((name) => db.objectStoreNames.contains(name));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...stores, STORE_METADATA], 'readwrite');
    const journal = tx.objectStore(STORE_METADATA).get(JOURNAL_ID);
    journal.onsuccess = () => {
      const moves = [...(journal.result?.moves ?? []), { ...move, ownerId: sharedNodeId }];
      const pending = [...(journal.result?.pending ?? []), { ...move, ownerId: sharedNodeId }];
      tx.objectStore(STORE_METADATA).put({ id: JOURNAL_ID, moves, pending });
      for (const name of stores) {
        const store = tx.objectStore(name);
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const value = sharedNodeId ? relocateOwnedMediaReferences(cursor.value, move, sharedNodeId)
            : relocateMediaReferences(cursor.value, [move]);
          if (value !== cursor.value) {
            if (typeof store.keyPath === 'string' && value[store.keyPath] !== cursor.value[store.keyPath]) {
              cursor.delete();
              store.put(value);
            } else cursor.update(value);
          }
          cursor.continue();
        };
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用迁移失败'));
  });
}

export async function pendingMediaRelocations(projectId: string): Promise<MediaRelocation[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA).objectStore(STORE_METADATA).get(JOURNAL_ID);
    request.onsuccess = () => resolve((request.result?.pending ?? []).filter((move: MediaRelocation) => move.projectId === projectId));
    request.onerror = () => reject(request.error);
  });
}

/** 旧路径仍用于修复迟到的保存，不能再分配给另一份项目文件。 */
export async function retiredMediaPaths(): Promise<ReadonlySet<string>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA);
    const request = tx.objectStore(STORE_METADATA).get(JOURNAL_ID);
    const paths = new Set<string>();
    request.onsuccess = () => {
      const moves: unknown = request.result === undefined ? [] : request.result?.moves;
      if (!Array.isArray(moves) || moves.some((move) => !move || typeof move.oldPath !== 'string' || !move.oldPath.trim())) {
        reject(new Error('文件引用迁移记录损坏，停止分配文件名'));
        tx.abort();
        return;
      }
      for (const move of moves) paths.add(mediaFileAllocationKey(move.oldPath));
    };
    tx.oncomplete = () => resolve(paths);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('读取文件引用迁移记录失败'));
  });
}

export async function completeMediaRelocation(move: MediaRelocation): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    const request = tx.objectStore(STORE_METADATA).get(JOURNAL_ID);
    request.onsuccess = () => {
      if (request.result) tx.objectStore(STORE_METADATA).put({ ...request.result,
        pending: request.result.pending.filter((item: MediaRelocation) => item.oldPath !== move.oldPath || item.newPath !== move.newPath) });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
