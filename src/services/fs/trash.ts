/**
 * fs/trash — 文件/目录删除域
 * 系统回收站、项目级 .trash 暂存（支持撤销）、项目数据目录删除、节点文件删除。
 */
import { mkdir, exists, rename } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import {
  normalizeDirectorResultManifestReference,
  normalizeDirectorSceneReference,
} from '../directorSceneSchema';
import { isTauriEnv, joinPath, notifyProjectDiskChanged, getProjectDataDir } from './core';

interface NodeFileReferences {
  filePath?: unknown;
  directorCaptureFilePaths?: unknown;
  directorScene?: unknown;
  directorResultManifest?: unknown;
  storyboardOverrides?: unknown;
}

const DIRECTOR_SCENE_REFERENCE_PREFIX = 'director-scene:';

function stringPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function collectDirectorSceneIds(nodeData: NodeFileReferences): string[] {
  const sceneIds = new Set<string>();
  try {
    sceneIds.add(normalizeDirectorSceneReference(nodeData.directorScene).sceneId);
  } catch {
    // 兼容轻量导演台与旧节点；无合法 Scene 引用时只处理普通文件路径。
  }
  try {
    sceneIds.add(normalizeDirectorResultManifestReference(nodeData.directorResultManifest).sceneId);
  } catch {
    // 同上。损坏或不完整引用不得扩大删除范围。
  }
  // 同一节点声明两个不同 sceneId 时视为数据冲突，失败关闭目录回收。
  return sceneIds.size <= 1 ? [...sceneIds] : [];
}

function directorSceneReferenceKey(sceneId: string): string {
  return `${DIRECTOR_SCENE_REFERENCE_PREFIX}${sceneId}`;
}

/**
 * 收集节点仍在使用的文件/Director Scene 引用键。
 * Scene 使用逻辑键而非绝对路径，避免共享判断依赖异步项目目录解析。
 */
export function collectNodeFileReferences(nodeData: NodeFileReferences): Set<string> {
  const references = new Set<string>();
  const filePath = stringPath(nodeData.filePath);
  if (filePath) references.add(filePath);
  if (Array.isArray(nodeData.directorCaptureFilePaths)) {
    nodeData.directorCaptureFilePaths.forEach((value) => {
      const path = stringPath(value);
      if (path) references.add(path);
    });
  }
  if (Array.isArray(nodeData.storyboardOverrides)) {
    nodeData.storyboardOverrides.forEach((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const path = stringPath((value as { filePath?: unknown }).filePath);
      if (path) references.add(path);
    });
  }
  collectDirectorSceneIds(nodeData).forEach((sceneId) => {
    references.add(directorSceneReferenceKey(sceneId));
  });
  return references;
}

/**
 * 将节点引用解析成真正需要暂存/恢复的路径。
 * Blender Scene bundle 按目录处理，目录内的截图、视频与 .blend 不再逐文件重复移动。
 */
export async function resolveNodeUndoTrashPaths(
  nodeData: NodeFileReferences,
  projectId?: string | null,
  keepReferences?: ReadonlySet<string>,
): Promise<string[]> {
  const directPaths = [...collectNodeFileReferences(nodeData)]
    .filter((reference) => !reference.startsWith(DIRECTOR_SCENE_REFERENCE_PREFIX));

  // 未提供项目时保持旧兼容行为，但不扩大到 Director capture 数组或目录。
  if (projectId === undefined) {
    const filePath = stringPath(nodeData.filePath);
    return filePath && !keepReferences?.has(filePath) ? [filePath] : [];
  }
  if (!projectId) return [];

  const projectRoot = await getProjectDataDir(projectId).catch(() => null);
  if (!projectRoot) return [];

  const sceneDirs = collectDirectorSceneIds(nodeData).map((sceneId) => ({
    sceneId,
    path: joinPath(projectRoot, 'director', 'scenes', sceneId),
  }));
  const paths = new Set<string>();

  for (const sceneDir of sceneDirs) {
    const shared = keepReferences?.has(directorSceneReferenceKey(sceneDir.sceneId))
      || [...(keepReferences ?? [])].some((reference) => (
        !reference.startsWith(DIRECTOR_SCENE_REFERENCE_PREFIX)
        && isPathInsideDir(reference, sceneDir.path)
      ));
    if (!shared && isPathInsideDir(sceneDir.path, projectRoot)) paths.add(sceneDir.path);
  }

  for (const filePath of directPaths) {
    if (keepReferences?.has(filePath)) continue;
    // Scene bundle 始终作为一个不可变整体保留或回收，不能只抽走其中某个 artifact。
    if (sceneDirs.some((sceneDir) => isPathInsideDir(filePath, sceneDir.path))) continue;
    if (isPathInsideDir(filePath, projectRoot)) paths.add(filePath);
    else console.warn('[fileService] 跳过删除非本项目文件:', filePath);
  }

  return [...paths];
}

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

/** 进行中的节点文件删除，撤销前要等它们结束 */
const pendingNodeFileDeletions = new Set<Promise<void>>();

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
    // .trash is a sibling of the source file, so this stays on one filesystem and avoids
    // transferring large media buffers through the WebView just to support undo.
    await rename(filePath, trashPath);
    undoTrashMap.set(filePath, trashPath);
    notifyProjectDiskChanged();
    console.log('[fileService] Staged in undo-trash:', filePath, '→', trashPath);
  } catch (err) {
    // 绝不退回系统回收站：那条路径撤销不回来，节点复活后就成了指向空文件的死节点。
    // 暂存失败时宁可把文件留在原地当孤儿文件，交给存储体检去回收。
    console.warn('[fileService] Failed to stage in undo-trash, file left in place:', filePath, err);
  }
}

/** 文件是否已不在原路径上（仅 Tauri 端有意义），用于撤销后确认媒体是否真的回来了 */
export async function isFileMissing(filePath: string): Promise<boolean> {
  if (!isTauriEnv()) return false;
  try {
    return !(await exists(filePath));
  } catch {
    return false;
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
    await rename(trashPath, filePath);
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

/** 判断路径是否位于某个项目的数据目录内（大小写不敏感，兼容 Windows 反斜杠）。 */
export function isPathInsideDir(filePath: string, dirPath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const normalizedDir = dirPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!normalizedDir) return false;
  return normalizedPath.startsWith(`${normalizedDir}/`);
}

/**
 * 节点文件是否属于指定项目。
 *
 * 跨项目复制粘贴会让副本的 filePath 仍指向源项目（详见 store.clipboard 的跨项目落地逻辑），
 * 这类路径一旦被当成「本项目的文件」删除，源项目的素材就会被搬进 .trash 并最终进系统废纸篓。
 * 因此删除前必须确认文件确实在本项目目录内。
 */
export async function isProjectOwnedFile(
  filePath: string,
  projectId: string | null,
): Promise<boolean> {
  if (!projectId) return false;
  const projectDir = await getProjectDataDir(projectId).catch(() => null);
  if (!projectDir) return false;
  return isPathInsideDir(filePath, projectDir);
}

/** 尝试删除节点关联的本地文件（如果有 filePath，移入 undo-trash 暂存，撤销时可还原）。
 *  keepPaths：仍被存活节点引用的 filePath 集合 —— 命中则跳过，避免复制节点删除时连累原节点文件。
 *  projectId：当前项目 —— 文件不在该项目目录内时一律不删，避免误删其他项目的素材。 */
export function deleteNodeFile(
  nodeData: NodeFileReferences,
  keepPaths?: ReadonlySet<string>,
  projectId?: string | null,
): Promise<void> {
  const operation = (async () => {
    const paths = await resolveNodeUndoTrashPaths(nodeData, projectId, keepPaths);
    await Promise.all(paths.map((path) => moveToUndoTrash(path)));
  })();
  // 删除是即发即忘的（节点退场动画不等文件系统），撤销必须能等它落定，
  // 否则还原会跑在暂存前面：节点回来了，文件随后才被搬进 .trash，成了死节点
  pendingNodeFileDeletions.add(operation);
  return operation.finally(() => pendingNodeFileDeletions.delete(operation));
}

/** 等待所有进行中的节点文件删除完成（撤销前调用，避免与暂存竞争） */
export async function waitForPendingNodeFileDeletions(): Promise<void> {
  while (pendingNodeFileDeletions.size > 0) {
    await Promise.allSettled([...pendingNodeFileDeletions]);
  }
}
