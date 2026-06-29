/**
 * fs/trash — 文件/目录删除域
 * 系统回收站、项目级 .trash 暂存（支持撤销）、项目数据目录删除、节点文件删除。
 */
import { writeFile, readFile as tauriReadFile, mkdir, exists, remove } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv, joinPath, notifyProjectDiskChanged, getProjectDataDir } from './core';

/** 将文件或目录移动到系统回收站（Tauri 端），浏览器环境无操作 */
export async function moveToTrash(filePath: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    await invoke('move_to_trash', { path: filePath });
    console.log('[fileService] Moved to trash:', filePath);
  } catch (err) {
    console.warn('[fileService] Failed to move to trash:', filePath, err);
  }
}

// ============================================
// Undo-trash staging (project-level .trash/ dir — restored on undo, flushed to system trash on project delete)
// ============================================

/** Map: originalFilePath → trashFilePath */
const undoTrashMap = new Map<string, string>();

/** Compute the .trash directory for a given file path (same parent dir) */
function getUndoTrashDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSep = normalized.lastIndexOf('/');
  return lastSep >= 0 ? joinPath(normalized.substring(0, lastSep), '.trash') : '.trash';
}

/** Move a file to the project-level .trash staging directory (for undo support) */
export async function moveToUndoTrash(filePath: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    const existsFile = await exists(filePath);
    if (!existsFile) return;
    const trashDir = getUndoTrashDir(filePath);
    await mkdir(trashDir, { recursive: true });
    const fileName = filePath.split(/[/\\]/).pop() || 'file';
    const trashPath = joinPath(trashDir, `${Date.now()}-${fileName}`);
    // copy + delete (rename may fail across filesystems)
    const content = await tauriReadFile(filePath);
    await writeFile(trashPath, new Uint8Array(content));
    await remove(filePath);
    undoTrashMap.set(filePath, trashPath);
    notifyProjectDiskChanged();
    console.log('[fileService] Staged in undo-trash:', filePath, '→', trashPath);
  } catch (err) {
    console.warn('[fileService] Failed to stage in undo-trash:', filePath, err);
    // Fallback: use system trash
    await moveToTrash(filePath).catch(() => {});
  }
}

/** Restore a file from undo-trash staging. Returns true on success. */
export async function restoreFromUndoTrash(filePath: string): Promise<boolean> {
  if (!isTauriEnv()) return false;
  const trashPath = undoTrashMap.get(filePath);
  if (!trashPath) return false;
  try {
    const trashExists = await exists(trashPath);
    if (!trashExists) { undoTrashMap.delete(filePath); return false; }
    const content = await tauriReadFile(trashPath);
    await writeFile(filePath, new Uint8Array(content));
    await remove(trashPath);
    undoTrashMap.delete(filePath);
    notifyProjectDiskChanged();
    console.log('[fileService] Restored from undo-trash:', filePath);
    return true;
  } catch (err) {
    console.warn('[fileService] Failed to restore from undo-trash:', filePath, err);
    return false;
  }
}

/** Flush all undo-trash files to system recycle bin (called on project delete) */
export async function flushUndoTrashDirs(): Promise<void> {
  if (!isTauriEnv()) return;
  // Collect unique .trash directories
  const trashDirs = new Set<string>();
  for (const [origPath] of undoTrashMap) {
    trashDirs.add(getUndoTrashDir(origPath));
  }
  for (const dir of trashDirs) {
    try {
      if (await exists(dir)) {
        await invoke('move_to_trash', { path: dir });
        console.log('[fileService] Flushed undo-trash dir to system trash:', dir);
      }
    } catch (err) {
      console.warn('[fileService] Failed to flush undo-trash dir:', dir, err);
    }
  }
  undoTrashMap.clear();
}

/** 删除单个文件（Tauri 端），浏览器环境无操作 */
export async function deleteFile(filePath: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    await remove(filePath);
    console.log('[fileService] Deleted file:', filePath);
  } catch (err) {
    console.warn('[fileService] Failed to delete file:', filePath, err);
  }
}

/** 将目录移至回收站（Tauri 端），trash crate 本身支持直接移动整个目录 */
async function removeDirRecursive(dirPath: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    await invoke('move_to_trash', { path: dirPath });
    console.log('[fileService] Moved dir to trash:', dirPath);
  } catch (err) {
    console.warn('[fileService] Failed to move dir to trash:', dirPath, err);
  }
}

/** 删除项目的本地数据目录（Tauri 端），包括所有媒体文件 */
export async function deleteProjectDataDir(projectId: string): Promise<void> {
  if (!isTauriEnv()) return;
  const dirPath = await getProjectDataDir(projectId);
  if (!dirPath) return;
  try {
    await removeDirRecursive(dirPath);
    console.log('[fileService] Deleted project data dir:', dirPath);
  } catch (err) {
    console.warn('[fileService] Failed to delete project data dir:', dirPath, err);
  }
}

/** 尝试删除节点关联的本地文件（如果有 filePath，移入 undo-trash 暂存，撤销时可还原）。
 *  keepPaths：仍被存活节点引用的 filePath 集合 —— 命中则跳过，避免复制节点删除时连累原节点文件。 */
export async function deleteNodeFile(
  nodeData: { filePath?: string },
  keepPaths?: Set<string>,
): Promise<void> {
  const fp = nodeData.filePath;
  if (fp && typeof fp === 'string' && !keepPaths?.has(fp)) {
    await moveToUndoTrash(fp);
  }
}
