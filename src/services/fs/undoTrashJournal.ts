import { openDB, STORE_METADATA } from '../indexedDb/schema';
import { joinPath } from './core';

const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//')
  .replace(/^\/\/\?\//, '').replace(/\/+$/, '');

export function trashPathKey(path: string): string {
  const normalized = normalizePath(path);
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** Windows 盘符和 UNC 忽略大小写，POSIX 保留大小写。 */
export function isPathInsideDir(filePath: string, dirPath: string): boolean {
  const path = trashPathKey(filePath), directory = trashPathKey(dirPath);
  return !!directory && path.startsWith(`${directory}/`) && !path.includes('\0')
    && !path.split('/').some((part) => part === '.' || part === '..');
}

export function usesTrashPath(filePath: string, references: ReadonlySet<string>): boolean {
  const path = trashPathKey(filePath);
  for (const reference of references) {
    if (trashPathKey(reference) === path || isPathInsideDir(reference, path) || isPathInsideDir(path, reference)) return true;
  }
  return false;
}

interface JournalRow {
  id: string;
  originalRelativePath: string;
  stagedName: string;
}

export interface UndoTrashEntry {
  id: string;
  root: string;
  originalPath: string;
  stagedPath: string;
  stagedAt: number;
}

const prefix = (directory: string) => `undo-trash-v1:${encodeURIComponent(trashPathKey(directory))}:`;
const activeMoves = new Set<string>();
export const isUndoTrashName = (name: string): boolean => /^\d+-[a-f0-9-]{36}-[^/\\\0]+$/i.test(name);

export const isUndoTrashMoveActive = (entry: UndoTrashEntry): boolean => activeMoves.has(entry.id);

function toEntry(directory: string, row: JournalRow): UndoTrashEntry {
  const root = directory.replace(/\\/g, '/').slice(0, -'/.trash'.length);
  const { originalRelativePath, stagedName } = row;
  if (typeof originalRelativePath !== 'string' || !originalRelativePath || originalRelativePath.split('/').some((part) => !part || part === '..' || part === '.' || part.toLowerCase() === '.trash')
    || typeof stagedName !== 'string' || !stagedName.endsWith(`-${originalRelativePath.split('/').at(-1)}`)
    || /[\\:\0]/.test(originalRelativePath) || !isUndoTrashName(stagedName)
    || row.id !== `${prefix(directory)}${stagedName}`) throw new Error('节点暂存记录无效');
  const stagedAt = Number(stagedName.split('-')[0]);
  if (!Number.isSafeInteger(stagedAt)) throw new Error('节点暂存记录无效');
  return { id: row.id, root, originalPath: joinPath(root, originalRelativePath), stagedPath: joinPath(directory, stagedName), stagedAt };
}

export async function readUndoTrashEntries(directory: string): Promise<UndoTrashEntry[]> {
  const db = await openDB(), start = prefix(directory);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    const request = tx.objectStore(STORE_METADATA).getAll(IDBKeyRange.bound(start, `${start}\uffff`));
    tx.oncomplete = () => {
      try { resolve((request.result as JournalRow[]).map((row) => toEntry(directory, row))); }
      catch (error) { reject(error); }
    };
    tx.onabort = () => reject(tx.error ?? new Error('节点暂存记录读取失败'));
  });
}

async function writeJournal(update: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('节点暂存记录保存失败'));
    if (tx.durability !== 'strict') { tx.abort(); return; }
    update(tx.objectStore(STORE_METADATA));
  });
}

export async function stageUndoTrashMove(directory: string, originalRelativePath: string, stagedName: string,
  move: () => Promise<boolean>): Promise<boolean> {
  const row = { id: `${prefix(directory)}${stagedName}`, originalRelativePath, stagedName };
  const entry = toEntry(directory, row);
  activeMoves.add(entry.id);
  try {
    // 先提交原路径身份。移动失败时也保留意图，因为 IPC 失败时文件可能已经移动。
    await writeJournal((store) => { store.add(row); });
    const moved = await move();
    if (!moved) await forgetUndoTrashEntry(entry);
    return moved;
  } finally { activeMoves.delete(entry.id); }
}

export async function forgetUndoTrashEntry(entry: UndoTrashEntry): Promise<void> {
  await writeJournal((store) => { store.delete(entry.id); });
}

/** 暂存的目录可以包含整组素材，逐文件清理时要核对该文件的原位置。 */
export function originalUndoTrashPath(entry: UndoTrashEntry, path: string): string | undefined {
  if (trashPathKey(path) === trashPathKey(entry.stagedPath)) return entry.originalPath;
  if (!isPathInsideDir(path, entry.stagedPath)) return undefined;
  return joinPath(entry.originalPath, normalizePath(path).slice(normalizePath(entry.stagedPath).length + 1));
}

export function relativeUndoTrashPath(path: string, directory: string): string | undefined {
  return isPathInsideDir(path, directory) ? normalizePath(path).slice(normalizePath(directory).length + 1) : undefined;
}

export function isUndoTrashPathProtected(path: string, directory: string, entries: readonly UndoTrashEntry[],
  references: ReadonlySet<string>): boolean {
  const top = relativeUndoTrashPath(path, directory)?.split('/')[0];
  const entry = top && entries.find((item) => trashPathKey(item.stagedPath) === trashPathKey(joinPath(directory, top)));
  if (!entry) return !top || isUndoTrashName(top);
  const original = originalUndoTrashPath(entry, path);
  return isUndoTrashMoveActive(entry) || !original || usesTrashPath(original, references);
}
