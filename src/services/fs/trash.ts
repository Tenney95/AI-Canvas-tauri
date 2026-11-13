/**
 * fs/trash — 文件/目录删除域
 * 系统回收站、项目级 .trash 暂存（支持撤销）、项目数据目录删除、节点文件删除。
 */
import { mkdir, exists, rename, lstat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import {
  normalizeDirectorResultManifestReference,
  normalizeDirectorSceneReference,
} from '../directorSceneSchema';
import { isTauriEnv, joinPath, notifyProjectDiskChanged, getProjectDataDir, getNativeProjectOwner, isSharedProjectDataDir, sanitizeFolderName } from './core';
import {
  forgetUndoTrashEntry, isPathInsideDir, isUndoTrashMoveActive, readUndoTrashEntries,
  relativeUndoTrashPath, stageUndoTrashMove, trashPathKey, usesTrashPath, type UndoTrashEntry,
} from './undoTrashJournal';

export { isPathInsideDir } from './undoTrashJournal';

/** Explicit history deletion: fail visibly, accept only regular files owned by this project. */
export async function recycleHistoryFile(projectId: string, filePath: string, assertCurrent: (fileExists: boolean) => void): Promise<void> {
  if (!isTauriEnv()) throw new Error('删除本地文件需要桌面环境');
  const root = await getProjectDataDir(projectId);
  const segments = filePath.replace(/\\/g, '/').split('/');
  if (!root || !isPathInsideDir(filePath, root) || segments.some((part) => part === '..' || part === '.')) {
    throw new Error('不能从生成历史删除项目目录以外的文件');
  }
  if (!await exists(filePath)) { assertCurrent(false); return; }
  const info = await lstat(filePath);
  if (!info.isFile || info.isSymlink) throw new Error('历史记录未指向普通文件');
  assertCurrent(true);
  try { await invoke('move_to_trash', { path: filePath }); }
  catch { throw new Error('文件移入回收站失败，请重试'); }
  notifyProjectDiskChanged();
}

interface NodeFileReferences {
  filePath?: unknown;
  directorCaptureFilePaths?: unknown;
  directorScene?: unknown;
  directorResultManifest?: unknown;
  storyboardOverrides?: unknown;
  shotlistRows?: unknown;
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
  if (Array.isArray(nodeData.shotlistRows)) {
    nodeData.shotlistRows.forEach((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      for (const binding of [row.frame, row.video]) {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue;
        const path = stringPath(binding.filePath) ?? localMediaUrlToPath(binding.url);
        if (path) references.add(path);
      }
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
  // 新结构共用作品根，但文件可按全作品引用判断独占；旧剧集保持原保护行为。
  if (!projectId || !getNativeProjectOwner(projectId) && isSharedProjectDataDir(projectId)) return [];

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

/** 将文件或目录移入系统回收站；显式删除使用 throwOnError，避免失败被当作成功。 */
export async function moveToTrash(filePath: string, options?: { throwOnError?: boolean }): Promise<void> {
  if (!isTauriEnv()) {
    if (options?.throwOnError) throw new Error('系统回收站仅在桌面应用中可用');
    return;
  }
  try {
    await invoke('move_to_trash', { path: filePath });
    if (options?.throwOnError) notifyProjectDiskChanged();
    if (!options?.throwOnError) console.log('[fileService] Moved to trash:', filePath);
  } catch (err) {
    if (options?.throwOnError) throw err;
    console.warn('[fileService] Failed to move to trash:', filePath, err);
  }
}

// ============================================
// Undo-trash staging
// ============================================

/** 进行中的节点文件删除，撤销前要等它们结束 */
const pendingNodeFileDeletions = new Set<Promise<void>>();

/** Legacy callers without project context use the source parent as their staging root. */
function getFileParent(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(0, Math.max(0, normalized.lastIndexOf('/')));
}

async function assertTrashParentsSafe(path: string, root: string): Promise<void> {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const relative = relativeUndoTrashPath(path, normalizedRoot);
  if (!relative) throw new Error('回收路径不属于项目目录');
  if (await exists(root) && (await lstat(root)).isSymlink) throw new Error('回收根目录包含符号链接');
  const parts = relative.split('/').slice(0, -1);
  let parent = normalizedRoot;
  for (const part of parts) {
    parent = joinPath(parent, part);
    if (await exists(parent) && (await lstat(parent)).isSymlink) throw new Error('回收路径包含符号链接');
  }
}

/** Move a file to the project-level .trash staging directory (for undo support) */
export async function moveToUndoTrash(
  filePath: string, projectId?: string | null, canMove?: () => Promise<boolean>,
): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    const root = await projectUndoTrashRoot(projectId, filePath);
    if (!root || !isPathInsideDir(filePath, root)) return;
    await assertTrashParentsSafe(filePath, root);
    const existsFile = await exists(filePath);
    if (!existsFile) return;
    const trashDir = joinPath(root, '.trash');
    if (isPathInsideDir(filePath, trashDir)) return;
    if ((await lstat(filePath)).isSymlink) throw new Error('不能回收符号链接');
    if (await exists(trashDir) && (await lstat(trashDir)).isSymlink) throw new Error('回收目录无效');
    await mkdir(trashDir, { recursive: true });
    const fileName = filePath.split(/[/\\]/).pop() || 'file';
    const stagedName = `${Date.now()}-${crypto.randomUUID()}-${fileName}`;
    const trashPath = joinPath(trashDir, stagedName);
    if (await exists(trashPath)) throw new Error('回收目标已存在');
    const relativePath = relativeUndoTrashPath(filePath, root);
    if (!relativePath) return;
    const moved = await stageUndoTrashMove(trashDir, relativePath, stagedName, async () => {
      await assertTrashParentsSafe(filePath, root);
      await assertTrashParentsSafe(trashPath, root);
      if (canMove && !await canMove()) return false;
      await rename(filePath, trashPath);
      return true;
    });
    if (moved) notifyProjectDiskChanged();
  } catch {
    // 绝不退回系统回收站：那条路径撤销不回来，节点复活后就成了指向空文件的死节点。
    // 暂存失败时宁可把文件留在原地当孤儿文件，交给存储体检去回收。
    console.warn('[fileService] 回收暂存未确认，保留恢复记录');
  }
}

async function projectUndoTrashRoot(projectId: string | null | undefined, filePath: string): Promise<string | null> {
  if (projectId) return getProjectDataDir(projectId);
  return projectId === undefined ? getFileParent(filePath) : null;
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

async function restoreUndoTrashEntry(entry: UndoTrashEntry, assertCurrent?: () => void): Promise<boolean> {
  const { originalPath: filePath, stagedPath: trashPath, root } = entry;
  try {
    if (isUndoTrashMoveActive(entry)) return false;
    await assertTrashParentsSafe(filePath, root);
    await assertTrashParentsSafe(trashPath, root);
    const trashExists = await exists(trashPath);
    if (!trashExists) {
      await forgetUndoTrashEntry(entry);
      return false;
    }
    if (await exists(filePath)) return false; // Never overwrite a newly created file/group.
    if ((await lstat(trashPath)).isSymlink) return false;
    const parent = getFileParent(filePath);
    if (parent) await mkdir(parent, { recursive: true });
    if (await exists(filePath)) return false;
    assertCurrent?.();
    await rename(trashPath, filePath);
    await forgetUndoTrashEntry(entry).catch(() => undefined);
    notifyProjectDiskChanged();
    return true;
  } catch {
    console.warn('[fileService] 节点暂存还原未完成，已保留原记录');
    return false;
  }
}

/** Restore a staged file without relying on the current window's lifetime. */
export async function restoreFromUndoTrash(filePath: string, projectId?: string | null): Promise<boolean> {
  if (!isTauriEnv()) return false;
  const key = trashPathKey(filePath);
  try {
    const root = await projectUndoTrashRoot(projectId, filePath);
    if (!root || !isPathInsideDir(filePath, root)) return false;
    const entries = await readUndoTrashEntries(joinPath(root, '.trash'));
    for (const entry of entries.filter((item) => trashPathKey(item.originalPath) === key).sort(newestStagedFirst)) {
      if (await restoreUndoTrashEntry(entry)) return true;
    }
    return false;
  } catch { return false; }
}

function newestStagedFirst(left: UndoTrashEntry, right: UndoTrashEntry): number {
  return right.stagedAt - left.stagedAt || right.id.localeCompare(left.id);
}

/** 加载持久化画布时先恢复仍被其引用的原件，再解析素材索引和预览。 */
export async function recoverUndoTrashReferences(root: string, references: ReadonlySet<string>, groupNames: readonly string[],
  assertCurrent?: () => void): Promise<void> {
  if (!isTauriEnv()) return;
  await waitForPendingNodeFileDeletions();
  const trashDir = joinPath(root, '.trash');
  const entries = await readUndoTrashEntries(trashDir);
  if (!entries.length) return;
  const paths = new Set(references);
  const folders = new Set<string>();
  for (const name of groupNames) {
    const folder = sanitizeFolderName(name);
    if (folder && !folder.startsWith('.')) folders.add(trashPathKey(joinPath(root, folder)));
  }
  const referenced = entries.filter((entry) => folders.has(trashPathKey(entry.originalPath)) || usesTrashPath(entry.originalPath, paths));
  // 先还原父目录，避免单文件还原时创建目录，导致整组原件无法复位。
  referenced.sort((a, b) => a.originalPath.length - b.originalPath.length || newestStagedFirst(a, b));
  for (const entry of referenced) {
    assertCurrent?.();
    await restoreUndoTrashEntry(entry, assertCurrent);
  }
}

/** 将目录移至回收站（Tauri 端），trash crate 本身支持直接移动整个目录 */
async function removeDirRecursive(dirPath: string): Promise<void> {
  if (!isTauriEnv()) return;
  await invoke('move_to_trash', { path: dirPath });
  console.log('[fileService] Moved dir to trash:', dirPath);
}

/** 删除项目的本地数据目录（Tauri 端），包括所有媒体文件 */
export async function deleteProjectDataDir(projectId: string, options: { throwOnError?: boolean } = {}): Promise<void> {
  if (!isTauriEnv()) {
    if (options.throwOnError) throw new Error('清理项目目录需要桌面应用');
    return;
  }
  const dirPath = await getProjectDataDir(projectId);
  if (!dirPath) {
    if (options.throwOnError) throw new Error('无法定位待清理的项目目录');
    return;
  }
  try {
    // 严格清理可重试；上次已移走或外部已清理的目录视为完成。
    if (options.throwOnError && !await exists(dirPath)) return;
    await removeDirRecursive(dirPath);
    console.log('[fileService] Deleted project data dir:', dirPath);
  } catch (err) {
    if (options.throwOnError) throw err;
    console.warn('[fileService] Failed to delete project data dir:', dirPath, err);
  }
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
  return deleteNodeFiles([nodeData], keepPaths, projectId);
}

/** Removed group folders include groups emptied by deleting their last children. */
export function deletedGroupFolderNames(
  groups: ReadonlyArray<{ id: string; name: string; nodeIds: string[] }>,
  deletedIds: ReadonlySet<string>,
): string[] {
  return groups.filter((group) => deletedIds.has(group.id)
    || (group.nodeIds.length > 0 && group.nodeIds.every((id) => deletedIds.has(id)))).map((group) => group.name);
}

export async function resolveGroupUndoTrashPaths(
  names: readonly string[], projectId: string | null | undefined, keepPaths?: ReadonlySet<string>,
): Promise<string[]> {
  if (!names.length || !projectId || isSharedProjectDataDir(projectId)) return [];
  const root = await getProjectDataDir(projectId);
  if (!root) return [];
  return [...new Set(names.map((name) => sanitizeFolderName(name)))].filter((name) =>
    !!name && !name.startsWith('.') && !['appdata', 'director'].includes(name.toLowerCase()))
    .map((name) => joinPath(root, name))
    .filter((path) => ![...(keepPaths ?? [])].some((reference) =>
      reference.replace(/\\/g, '/').toLowerCase() === path.replace(/\\/g, '/').toLowerCase()
      || isPathInsideDir(reference, path)));
}

export interface NodeFileDeletionContext {
  deletedNodeIds: readonly string[];
  /** 项目切换或节点变化时返回 null；异步回收前重新检查当前画布与消息。 */
  getLiveKeepPaths: () => ReadonlySet<string> | null;
}

/** 旧结构整组暂存；新结构逐文件核对共享引用，再复用同一撤销暂存流程。 */
export function deleteNodeFiles(
  nodeData: readonly NodeFileReferences[], keepPaths?: ReadonlySet<string>,
  projectId?: string | null, groupNames: readonly string[] = [],
  context?: NodeFileDeletionContext,
): Promise<void> {
  const operation = (async () => {
    const native = projectId && getNativeProjectOwner(projectId);
    // 新结构的调用方必须给出明确删除范围，不能凭共享目录推断文件归属。
    if (native && !context) return;
    const guard = native && projectId && context
      ? await (await import('./nativeNodeTrash')).createNativeNodeTrashGuard(projectId, context.deletedNodeIds).catch(() => null) : undefined;
    if (native && !guard) {
      console.warn('[fileService] 无法确认作品引用，节点文件保留');
      return;
    }
    const folders = native ? [] : await resolveGroupUndoTrashPaths(groupNames, projectId, keepPaths);
    const files = (await Promise.all(nodeData.map((data) => resolveNodeUndoTrashPaths(data, projectId, keepPaths)))).flat();
    const paths = [...new Set([...folders, ...files])].filter((path) =>
      !folders.some((folder) => isPathInsideDir(path, folder)));
    for (const path of paths) {
      if (guard) {
        // 元数据与整组目录不随节点搬迁；场景 bundle 仍按原来的整体语义处理。
        const root = await getProjectDataDir(projectId!);
        if (!root || trashPathKey(path).slice(trashPathKey(root).length + 1)
          .split('/').some((part) => part.startsWith('.')) || usesTrashPath(path, guard.references)) continue;
        const { isNodeMediaCopySource } = await import('../nodeMediaCopy');
        await moveToUndoTrash(path, projectId, async () => {
          if (!await guard.isCurrent()) return false;
          const live = context!.getLiveKeepPaths();
          return live !== null && !usesTrashPath(path, live) && !isNodeMediaCopySource(path);
        });
      } else await moveToUndoTrash(path, projectId);
    }
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
