/**
 * fs/storageHealth — 存储健康中心扫描逻辑
 * 扫描各项目占用空间、孤儿文件、重复文件、.trash 残留、可释放空间
 */
import { exists, readDir, lstat, remove } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv, joinPath, getProjectDataDir } from './core';
import type { CanvasProject } from '../../types';
import {
  getProjectById, getHistoryEntriesPage,
  getProjectConversations, getConversationMessages, type HistoryPageCursor,
} from '../indexedDbService';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { fingerprintAssetImage } from './assetImageMetadata';
import { listProjectImportRecoveries } from '../indexedDb/projectImportRepository';
import { openDB } from '../indexedDb/schema';
import { assertLegacyProjectWritesAllowed } from '../indexedDb/legacyProjectWriteGuard';
import { safeExchangePath } from '../projectExchangeDomain';
import { getRelativeAssetPath } from './assetIndex';
import { configValuesEqual } from '../configPatch';
import { collectLegacyCharacterVisualPaths, isLegacyCharacterVisualCandidatePath } from '../characterVisualHistory';
import type { ProjectCatalogEntry } from '../projectModelRouter';
import type { readNativeProjectCapture } from '../indexedDb/nativeProjectRepository';
import type { NativeProjectViewItem } from '../../store/nativeProjectView';
import { forgetUndoTrashEntry, isUndoTrashPathProtected, readUndoTrashEntries, relativeUndoTrashPath, type UndoTrashEntry } from './undoTrashJournal';
import {
  readNativeStorageSnapshot, nativeStorageProjectRows, nativeStorageProjectProtected,
  collectNativeStorageReferences, type NativeStorageSnapshot,
} from './nativeStorageReferences';

type NativeStorageScope = { entry: Extract<ProjectCatalogEntry, { dataModel: 'native' }>;
  capture: NonNullable<Awaited<ReturnType<typeof readNativeProjectCapture>>>; roots: Map<string, string> };

/** 只使用目录与新库共同证明的素材根；扫描不认领、创建或迁移目录。 */
async function readNativeStorageScopes(catalog: readonly ProjectCatalogEntry[], signal?: AbortSignal): Promise<NativeStorageScope[]> {
  if (!catalog.some((entry) => entry.dataModel === 'native')) return [];
  const { readNativeProjectCapture } = await import('../indexedDb/nativeProjectRepository');
  const scopes: NativeStorageScope[] = [];
  for (const entry of catalog) {
    if (entry.dataModel !== 'native') continue;
    checkAbort(signal);
    const capture = await readNativeProjectCapture(entry.project.id, { signal });
    checkAbort(signal);
    if (!capture || !configValuesEqual(capture.aggregate.project, entry.project)
      || !configValuesEqual(capture.aggregate.episodes, [...entry.episodes].sort((a, b) => a.orderRank - b.orderRank))
      || !configValuesEqual([...capture.aggregate.canvases.map((canvas) => canvas.id)].sort(), [...entry.canvasIds].sort())) {
      throw new Error('新项目目录在扫描时变化');
    }
    const roots = new Map<string, string>();
    for (const binding of capture.aggregate.project.storageBindings) {
      checkAbort(signal);
      const root = await invoke<string>(binding.rootRef === capture.aggregate.project.storageRootRef
        ? 'resolve_native_project_media_root' : 'resolve_native_project_media_subroot', {
        projectId: entry.project.id, ...(binding.rootRef === capture.aggregate.project.storageRootRef ? {} : { rootRef: binding.rootRef, create: false }),
      });
      checkAbort(signal);
      if (typeof root !== 'string' || !root) throw new Error('新项目素材目录不可用');
      roots.set(binding.rootRef, root);
    }
    if (!roots.has(capture.aggregate.project.storageRootRef)) throw new Error('新项目主素材目录不可用');
    scopes.push({ entry, capture, roots });
  }
  return scopes;
}

/** 不可变发布区和隐藏目录尚无清理租约，仍保留。 */
function nativeCleanupProtectedPath(filePath: string, root: string): boolean {
  const relative = pathKey(filePath).slice(pathKey(root).replace(/\/+$/, '').length).replace(/^\/+/, '');
  const parts = relative.split('/');
  return !relative || parts.some((part) => part.startsWith('.'))
    || ['media', 'imports'].includes(parts[0]);
}

/** 服务层自行复核原生引用，不相信旧报告或调用方传入的可删标记。 */
async function assertStorageCleanupPath(filePath: string, trashDirectory?: string, entries?: readonly UndoTrashEntry[]): Promise<void> {
  await assertLegacyStorageHealthScope();
  const { listProjectCatalog } = await import('../projectModelRouter');
  const catalog = await listProjectCatalog();
  const scopes = await readNativeStorageScopes(catalog);
  const key = pathKey(filePath).replace(/\/+$/, '');
  if (trashDirectory && filePath !== trashDirectory && !relativeUndoTrashPath(filePath, trashDirectory)) throw new Error('回收路径已变化');
  const legacyReferences = new Set<string>();
  for (const entry of catalog) {
    if (entry.dataModel !== 'legacy') continue;
    const root = await getProjectDataDir(entry.project.id);
    if (root && entries?.length && trashDirectory && filePath !== trashDirectory) {
      const record = await getProjectById(entry.project.id);
      if (!record) throw new Error('回收前无法核对旧项目引用');
      collectReferences(record, legacyReferences, root);
    }
    if (entry.project.parentId) continue;
    const relative = root && getRelativeAssetPath(filePath, root);
    if (root && relative && (isLegacyCharacterVisualCandidatePath(relative)
      || isReferenced(filePath, new Set((await collectLegacyCharacterVisualPaths(entry.project.id, root)).map(pathKey))))) {
      throw new Error('文件仍被角色生成历史引用');
    }
  }
  if (trashDirectory && filePath !== trashDirectory && entries && isUndoTrashPathProtected(filePath, trashDirectory, entries, legacyReferences)) {
    throw new Error('文件仍被旧项目引用');
  }
  const owners = scopes.filter((scope) => [...scope.roots.values()].some((root) => {
    const rootKey = pathKey(root).replace(/\/+$/, ''); return key === rootKey || key.startsWith(`${rootKey}/`);
  }));
  const snapshot = await readNativeStorageSnapshot();
  const retiredProjects = snapshot.retired.filter((row) => row.kind === 'project');
  if (!owners.length && retiredProjects.length) {
    for (const retired of retiredProjects) {
      let root: string;
      try { root = await invoke<string>('resolve_native_project_media_root', { projectId: retired.projectId }); }
      catch { continue; } // 已不在当前素材基目录的旧绑定不能据此认领目录。
      if (typeof root !== 'string' || !root) continue;
      const rootKey = pathKey(root).replace(/\/+$/, '');
      if (key === rootKey || key.startsWith(`${rootKey}/`)) throw new Error('已删除项目的保留目录不提供清理操作');
    }
    // 绑定损坏时也不能凭旧报告删除；这里只接受仍属于已登记旧项目的范围。
    let legacyOwner = false;
    for (const entry of catalog) {
      if (entry.dataModel !== 'legacy') continue;
      const root = await getProjectDataDir(entry.project.id);
      const rootKey = root && pathKey(root).replace(/\/+$/, '');
      if (rootKey && key.startsWith(`${rootKey}/`)) { legacyOwner = true; break; }
    }
    if (!legacyOwner) throw new Error('文件已不在活动项目目录中');
  }
  if (!owners.length) return;
  for (const scope of owners) {
    // 先选最长根，避免子根中的普通文件被当作主根中的另一条路径。
    const root = [...scope.roots.values()].filter((root) => {
      const prefix = pathKey(root).replace(/\/+$/, ''); return key === prefix || key.startsWith(`${prefix}/`);
    }).sort((a, b) => b.length - a.length)[0];
    if (!root || nativeCleanupProtectedPath(filePath, root)
      || nativeStorageProjectProtected(snapshot, scope.entry.project.id)) throw new Error('新项目此范围暂不提供清理操作');
    const references = await collectNativeScopeReferences(scope, snapshot);
    if (isReferenced(filePath, references)) throw new Error('文件仍被新项目引用');
  }
  const { isNodeMediaCopySource } = await import('../nodeMediaCopy');
  if (isNodeMediaCopySource(filePath)) throw new Error('文件正在复制');
}

/** 旧引用集合无法证明迁移冻结或新模型下的文件可清理。此预检不替代跨进程停写。 */
async function assertLegacyStorageHealthScope(): Promise<void> {
  await assertLegacyProjectWritesAllowed(await openDB());
}

function pathKey(value: string): string {
  const path = (localMediaUrlToPath(value) ?? value).replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '';
  const absolute = !!prefix || /^[a-z]:\//i.test(path);
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..' && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  const normalized = prefix + parts.join('/') + (path.endsWith('/') && parts.length ? '/' : '');
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? normalized.toLowerCase() : normalized;
}

/** 嵌套数据和持久化的相对路径也算引用，宁可多保留一份。 */
function collectReferences(value: unknown, paths: Set<string>, root?: string): void {
  if (typeof value === 'string') {
    if (/^(?:[a-z]:[/\\]|[/\\])/i.test(value) || localMediaUrlToPath(value)) paths.add(pathKey(value));
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectReferences(item, paths, root));
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (root) {
      const localReference = (path: string) => {
        if (!path) return;
        const local = localMediaUrlToPath(path) ?? path;
        if (/^(?:[a-z]:[\\/]|[\\/])/i.test(local)) paths.add(pathKey(local));
        else if (!/^[a-z][a-z0-9+.-]*:/i.test(local)) paths.add(pathKey(joinPath(root, local)));
      };
      for (const field of ['relativePath', 'imageRelativePath', 'filePath', 'imageFilePath'] as const) {
        if (typeof record[field] === 'string') localReference(record[field]);
      }
      for (const field of ['directorCaptureRelativePaths', 'directorCaptureFilePaths'] as const) {
        if (Array.isArray(record[field])) for (const path of record[field]) {
          if (typeof path === 'string') localReference(path);
        }
      }
    }
    if (root && typeof record.sceneId === 'string') {
      paths.add(`${pathKey(joinPath(root, 'director', 'scenes', record.sceneId))}/`);
    }
    Object.values(record).forEach((item) => collectReferences(item, paths, root));
  }
}

function isReferenced(path: string, paths: Set<string>): boolean {
  const key = pathKey(path);
  return paths.has(key) || [...paths].some((reference) => reference.endsWith('/') && key.startsWith(reference));
}

/** 新库回执、恢复材料及旧库历史都要参与核对；不调用会同步写入历史的归档捕获。 */
async function collectNativeScopeReferences(scope: NativeStorageScope, snapshot: NativeStorageSnapshot, signal?: AbortSignal): Promise<Set<string>> {
  const { project } = scope.capture.aggregate;
  const paths = new Set<string>();
  const collect = (value: unknown, rootRef = project.storageRootRef) => {
    for (const path of collectNativeStorageReferences(value, scope.roots, rootRef)) paths.add(pathKey(path));
  };
  collect(scope.capture.aggregate);
  const rows = nativeStorageProjectRows(snapshot, project.id);
  collect(rows.exchange); collect(rows.transfers);
  const identities = new Set([project.id, ...scope.capture.aggregate.canvases.map((canvas) => canvas.id),
    ...rows.retired.filter((row) => row.kind === 'canvas').map((row) => row.id)]);
  for (const id of identities) {
    const rootRef = scope.capture.aggregate.canvases.find((canvas) => canvas.id === id)?.storageRootRef ?? project.storageRootRef;
    let cursor: HistoryPageCursor | null = null;
    do {
      checkAbort(signal);
      const page = await getHistoryEntriesPage(id, 200, cursor);
      checkAbort(signal);
      collect(page.records, rootRef);
      if (!page.hasMore) break;
      if (!page.nextCursor) throw new Error('历史引用读取不完整');
      cursor = page.nextCursor;
    } while (cursor);
    for (const conversation of await getProjectConversations(id)) {
      let offset = 0;
      while (true) {
        checkAbort(signal);
        const page = await getConversationMessages(conversation.id, offset, 200);
        checkAbort(signal);
        collect(page.messages, rootRef);
        offset += page.messages.length;
        if (offset >= page.total) break;
        if (!page.messages.length) throw new Error('消息引用读取不完整');
      }
    }
  }
  // 没有文件发布租约的内容区和目录身份文件不纳入自动清理。
  for (const root of scope.roots.values()) {
    for (const name of ['media', 'imports', '.trash']) paths.add(`${pathKey(joinPath(root, name))}/`);
    paths.add(pathKey(joinPath(root, '.ai-canvas-native-project.json')));
  }
  return paths;
}

/** 实时相对引用使用画布实际素材根，不能一律拼到作品主根。 */
export async function collectStorageLiveFilePaths(projectId: string | null, value: unknown): Promise<Set<string>> {
  if (!projectId) return collectNodeFilePaths([{ data: { value } }]);
  const { listProjectCatalog } = await import('../projectModelRouter');
  const entry = (await listProjectCatalog()).find((entry) => entry.dataModel === 'native'
    && (entry.project.id === projectId || entry.canvasIds.includes(projectId)));
  if (entry?.dataModel === 'native') {
    const [scope] = await readNativeStorageScopes([entry]);
    const canvas = scope.capture.aggregate.canvases.find((canvas) => canvas.id === projectId);
    return new Set([...collectNativeStorageReferences(value, scope.roots,
      canvas?.storageRootRef ?? scope.capture.aggregate.project.storageRootRef)].map(pathKey));
  }
  const root = await getProjectDataDir(projectId);
  if (!root) throw new Error('当前项目的实时文件引用无法确认');
  return collectNodeFilePaths([{ data: { value } }], root);
}

// ============================================
// 类型定义
// ============================================

interface ScanFileEntry {
  name: string;
  path: string;
  size: number;
}

export interface ProjectStorageInfo {
  projectId: string;
  projectName: string;
  /** 新结构只清理普通未引用原件，发布区与目录元数据保留。 */
  dataModel?: 'native';
  /** 项目数据目录路径 */
  dataDir: string | null;
  /** 新作品可能绑定多个素材根；统计按真实文件路径去重。 */
  dataDirs?: string[];
  /** 项目素材总大小（不含 .trash 和根 .thumbnail 派生缓存） */
  fileSize: number;
  /** 项目数据目录内的文件数量 */
  fileCount: number;
  /** 按类别统计 */
  categories: Record<string, { count: number; size: number }>;
  /** 共用素材目录的其他项目名称；共享文件只在首个项目计一次。 */
  sharedWith?: string[];
}

export interface TrashInfo {
  projectId: string;
  projectName: string;
  /** .trash 目录路径 */
  trashDir: string;
  /** .trash 目录内文件总大小 */
  trashSize: number;
  /** 文件数量 */
  fileCount: number;
  /** 全部已读取文件及其项目、历史、恢复点或实时状态引用标记。 */
  files: Array<{ path: string; size: number; referenced: boolean; digest?: string }>;
  reclaimableSize: number;
  reclaimableCount: number;
}

export interface OrphanFileInfo {
  path: string;
  name: string;
  size: number;
  projectId: string;
  projectName: string;
}

export interface DuplicateFileGroup {
  /** 同名同大小初筛后，用固定块 SHA-256 链确认内容相同。 */
  key: string;
  /** 重复文件列表 */
  files: { path: string; name: string; size: number; projectId: string; projectName: string; referenced: boolean; canDelete: boolean }[];
  /** 仅统计未被引用且不是保留副本的文件；总览里不与孤儿文件重复累计。 */
  reclaimableSize: number;
}

export interface CleanupResult {
  /** 实际删除的普通文件数。 */
  deletedCount: number;
  /** 删除失败的文件或无法处理的目录数。 */
  failedCount: number;
  /** 实际删除文件的逻辑大小，不包含失败项。 */
  reclaimedSize: number;
}

export interface ExternalFolderStatus {
  path: string;
  label: string;
  online: boolean;
}

export type StorageHealthIssueReason = 'permission' | 'missing' | 'symlink' | 'changed' | 'unavailable' | 'native-protected';

export interface StorageHealthIssue {
  area: 'project' | 'trash' | 'duplicates';
  projectName: string;
  name: string;
  reason: StorageHealthIssueReason;
}

/** 只保留安全分类；原始错误可能包含路径，不带进界面状态或日志。 */
export class StorageHealthScanError extends Error {
  readonly area = 'references';
  readonly reason: StorageHealthIssueReason;
  constructor(reason: StorageHealthIssueReason) {
    super('存储引用读取不完整');
    this.name = 'StorageHealthScanError';
    this.reason = reason;
  }
}

export interface StorageHealthReport {
  complete: boolean;
  issues: StorageHealthIssue[];
  /** 各项目空间占用 */
  projects: ProjectStorageInfo[];
  /** .trash 残留 */
  trashes: TrashInfo[];
  /** 孤儿文件（未被节点引用） */
  orphans: OrphanFileInfo[];
  /** 重复文件组 */
  duplicates: DuplicateFileGroup[];
  /** 离线外部文件夹 */
  offlineFolders: ExternalFolderStatus[];
  /** 扫描时间 */
  scannedAt: number;
  /** 去重后的项目素材占用，不含回收站和根 .thumbnail 缓存。 */
  projectSize: number;
  /** 去重后的回收站占用。 */
  trashSize: number;
  /** 项目素材和回收站合计。 */
  totalSize: number;
  /** 可安全释放的空间 */
  reclaimableSize: number;
}

export interface StorageHealthScanOptions {
  /** 清理前只核对引用时，可以跳过无关文件的重复内容摘要。 */
  includeDuplicates?: boolean;
  signal?: AbortSignal;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

function issueReason(error: unknown): StorageHealthIssueReason {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/permission|forbidden|not allowed|denied|not permitted|权限|未授权/i.test(text)) return 'permission';
  if (/no such file|not found|does not exist|enoent|os error [23]\b|不存在/i.test(text)) return 'missing';
  if (/symlink|symbolic link|符号链接/i.test(text)) return 'symlink';
  if (/changed|变化|改变|切换/i.test(text)) return 'changed';
  return 'unavailable';
}

function displayName(value: string): string {
  const name = value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
  return Array.from(name, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code >= 127 && code <= 159 ? ' ' : character;
  }).join('').slice(0, 160) || '未命名';
}

function isSystemMetadata(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._') || /^(?:Thumbs\.db|desktop\.ini)$/i.test(name);
}

// ============================================
// 扫描器
// ============================================

/** 读不到的条目单独报告，已读取的占用保留下来；不跟随链接。 */
async function scanDirRecursive(
  dirPath: string,
  onIssue: (name: string, reason: StorageHealthIssueReason) => void,
  excludedRootDirectories: readonly string[] = [],
  skipProjectDirectories = true,
  signal?: AbortSignal,
  excludedDirectories: ReadonlySet<string> = new Set(),
  skipHidden = false,
): Promise<{ files: ScanFileEntry[]; entries: Awaited<ReturnType<typeof readDir>> }> {
  checkAbort(signal);
  const result: { files: ScanFileEntry[]; entries: Awaited<ReturnType<typeof readDir>> } = { files: [], entries: [] };
  try {
    const directory = await lstat(dirPath);
    checkAbort(signal);
    if (directory.isSymlink) { onIssue(dirPath, 'symlink'); return result; }
    if (!directory.isDirectory) { onIssue(dirPath, 'unavailable'); return result; }
    result.entries = await readDir(dirPath);
    checkAbort(signal);
  } catch (error) {
    checkAbort(signal);
    onIssue(dirPath, issueReason(error));
    return result;
  }
  for (const entry of result.entries) {
    checkAbort(signal);
    if (skipHidden && entry.name.startsWith('.')) continue;
    if (skipProjectDirectories && isSystemMetadata(entry.name)) continue;
    if (entry.isDirectory && (excludedRootDirectories.includes(entry.name)
      || skipProjectDirectories && (entry.name === '.trash' || entry.name === 'AppData'))) continue;
    const entryPath = joinPath(dirPath, entry.name);
    if (entry.isDirectory && excludedDirectories.has(pathKey(entryPath).replace(/\/+$/, ''))) continue;
    try {
      const info = await lstat(entryPath);
      checkAbort(signal);
      if (info.isSymlink) { onIssue(entry.name, 'symlink'); continue; }
      if (info.isDirectory) {
        const nested = await scanDirRecursive(entryPath, onIssue, [], skipProjectDirectories, signal, excludedDirectories, skipHidden);
        result.files.push(...nested.files);
      } else if (info.isFile) {
        result.files.push({ name: entry.name, path: entryPath, size: info.size });
      } else {
        onIssue(entry.name, 'unavailable');
      }
    } catch (error) {
      checkAbort(signal);
      onIssue(entry.name, issueReason(error));
    }
  }
  checkAbort(signal);
  return result;
}

function getFileCategoryName(fileName: string): string {
  const ext = `.${fileName.split('.').pop()?.toLowerCase()}`;
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) return '图片';
  if (['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext)) return '视频';
  if (['.mp3', '.wav', '.ogg', '.aac', '.flac'].includes(ext)) return '音频';
  if (['.txt', '.md', '.json', '.csv', '.xml', '.html'].includes(ext)) return '文本';
  return '其他';
}

/** 同名同大小只是候选；流式核对内容后，才显示为重复文件。 */
async function scanDuplicateFiles(
  files: OrphanFileInfo[],
  references: Set<string>,
  onIssue: (file: OrphanFileInfo, reason: StorageHealthIssueReason) => void,
  signal?: AbortSignal,
): Promise<DuplicateFileGroup[]> {
  checkAbort(signal);
  const candidates = new Map<string, OrphanFileInfo[]>();
  for (const file of files) {
    checkAbort(signal);
    // 空文件不占空间，也不用为它读取内容摘要。
    if (!file.size) continue;
    const key = `${file.size}|${file.name}`;
    const group = candidates.get(key) ?? [];
    group.push(file);
    candidates.set(key, group);
  }

  const duplicates: DuplicateFileGroup[] = [];
  for (const [candidateKey, candidatesByName] of candidates) {
    checkAbort(signal);
    if (candidatesByName.length < 2) continue;
    const byDigest = new Map<string, OrphanFileInfo[]>();
    for (const file of candidatesByName) {
      checkAbort(signal);
      try {
        // 复用固定块摘要，视频再大也不会整份装进内存。
        const content = await fingerprintAssetImage(file.path, signal);
        checkAbort(signal);
        if (content.bytes !== file.size) { onIssue(file, 'changed'); continue; }
        const group = byDigest.get(content.digest) ?? [];
        group.push(file);
        byDigest.set(content.digest, group);
      } catch (error) {
        checkAbort(signal);
        onIssue(file, issueReason(error));
      }
    }
    for (const [digest, matching] of byDigest) {
      if (matching.length < 2) continue;
      const ordered = matching.map((file) => ({ ...file, referenced: isReferenced(file.path, references) }))
        .sort((left, right) => Number(right.referenced) - Number(left.referenced) || left.path.localeCompare(right.path));
      const hasReferencedCopy = ordered.some((file) => file.referenced);
      const groupFiles = ordered.map((file, index) => ({ ...file, canDelete: !file.referenced && (hasReferencedCopy || index > 0) }));
      duplicates.push({
        key: `${candidateKey}|${digest}`,
        files: groupFiles,
        reclaimableSize: groupFiles.reduce((sum, file) => sum + (file.canDelete ? file.size : 0), 0),
      });
    }
  }
  checkAbort(signal);
  return duplicates;
}

/**
 * 收集节点和历史里的文件引用，用于孤儿检测。
 * @param allNodeData 所有项目所有节点的 data 数组
 * @param root 这些数据所属项目的目录，用来解析相对引用
 */
export function collectNodeFilePaths(allNodeData: Array<{ data?: Record<string, unknown> }>, root?: string): Set<string> {
  const paths = new Set<string>();
  collectReferences(allNodeData, paths, root);
  return paths;
}

/**
 * 执行完整的存储健康扫描
 */
export async function scanStorageHealth(
  projects: CanvasProject[],
  nodeFilePaths: Set<string> | (() => Set<string> | Promise<Set<string>>),
  assetFolders: { path: string; label: string }[] = [],
  options: StorageHealthScanOptions = {},
): Promise<StorageHealthReport> {
  const { signal, includeDuplicates = true } = options;
  checkAbort(signal);
  const report: StorageHealthReport = {
    complete: true,
    issues: [],
    projects: [],
    trashes: [],
    orphans: [],
    duplicates: [],
    offlineFolders: [],
    scannedAt: 0,
    projectSize: 0,
    trashSize: 0,
    totalSize: 0,
    reclaimableSize: 0,
  };
  const addIssue = (area: StorageHealthIssue['area'], projectName: string, name: string, reason: StorageHealthIssueReason) => {
    if (reason !== 'native-protected') report.complete = false;
    report.issues.push({ area, projectName: displayName(projectName), name: name ? displayName(name) : '', reason });
  };

  if (!isTauriEnv()) return { ...report, scannedAt: Date.now() };

  // 项目列表只有摘要；必须读取所有完整项目，不能用当前画布推断其他项目无引用。
  // 任何读取失败或记录缺失都终止扫描，不能将未知引用视为空集合。
  const references = new Set<string>();
  const roots = new Map<string, string | null>();
  const additionalRoots = new Map<string, string[]>();
  let nativeScopes: NativeStorageScope[];
  let nativeSnapshot: NativeStorageSnapshot | undefined;
  const projectRoots = (id: string): string[] => [...new Set([roots.get(id), ...(additionalRoots.get(id) ?? [])].filter((root): root is string => !!root))];
  try {
    await assertLegacyStorageHealthScope();
    checkAbort(signal);
    const { listProjectCatalog } = await import('../projectModelRouter');
    const catalog = await listProjectCatalog(); checkAbort(signal);
    nativeScopes = await readNativeStorageScopes(catalog, signal);
    if (nativeScopes.length) nativeSnapshot = await readNativeStorageSnapshot({ signal });
    const nativeViews = new Map<string, NativeProjectViewItem>();
    if (nativeScopes.length) {
      const { projectNativeCatalogEntry } = await import('../../store/nativeProjectView');
      for (const scope of nativeScopes) for (const view of projectNativeCatalogEntry(scope.entry)) nativeViews.set(view.id, view);
    }
    for (const project of projects) {
      const binding = (project as Partial<NativeProjectViewItem>).nativeView, native = nativeViews.get(project.id);
      if (binding ? !native || !configValuesEqual(binding, native.nativeView) : !!native) throw new Error('项目目录身份已变化');
    }
    const allProjects = new Map(projects.filter((project) => !(project as Partial<NativeProjectViewItem>).nativeView).map((project) => [project.id, project]));
    for (const entry of catalog) if (entry.dataModel === 'legacy') allProjects.set(entry.project.id, entry.project);
    checkAbort(signal);
    projects = [...allProjects.values()];
    for (const project of projects) {
      checkAbort(signal);
      const record = await getProjectById(project.id);
      checkAbort(signal);
      if (!record || !Array.isArray(record.nodes)) throw new Error('项目引用读取不完整');
      const root = await getProjectDataDir(project.id);
      checkAbort(signal);
      roots.set(project.id, root);
      collectReferences(record, references, root ?? undefined);
      if (root && !record.parentId) for (const path of await collectLegacyCharacterVisualPaths(project.id, root)) {
        references.add(pathKey(path));
      }
      if (!record.parentId) for (const recovery of await listProjectImportRecoveries(project.id)) {
        checkAbort(signal);
        collectReferences(recovery.records, references, root ?? undefined);
        if (root) for (const asset of recovery.assets ?? []) references.add(pathKey(joinPath(root, safeExchangePath(asset.path))));
      }
      let cursor: HistoryPageCursor | null = null;
      do {
        checkAbort(signal);
        const page = await getHistoryEntriesPage(project.id, 200, cursor);
        checkAbort(signal);
        collectReferences(page.records, references, root ?? undefined);
        if (!page.hasMore) break;
        if (!page.nextCursor) throw new Error('历史引用读取不完整');
        cursor = page.nextCursor;
      } while (cursor);
      for (const conversation of await getProjectConversations(project.id)) {
        checkAbort(signal);
        let offset = 0;
        while (true) {
          checkAbort(signal);
          const page = await getConversationMessages(conversation.id, offset, 200);
          checkAbort(signal);
          collectReferences(page.messages, references, root ?? undefined);
          offset += page.messages.length;
          if (offset >= page.total) break;
          if (!page.messages.length) throw new Error('消息引用读取不完整');
        }
      }
    }
    for (const scope of nativeScopes) {
      const { project } = scope.capture.aggregate, primary = scope.roots.get(project.storageRootRef)!;
      projects.push({ id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt });
      roots.set(project.id, primary);
      additionalRoots.set(project.id, [...scope.roots.values()].filter((root) => pathKey(root) !== pathKey(primary)));
      try {
        if (!nativeSnapshot || nativeStorageProjectProtected(nativeSnapshot, project.id)) throw new Error('原操作尚未结束');
        for (const path of await collectNativeScopeReferences(scope, nativeSnapshot, signal)) references.add(path);
      } catch {
        checkAbort(signal);
        // 状态未知只保护所属目录，不让其他项目的完整引用核对失效。
        for (const root of scope.roots.values()) references.add(`${pathKey(root).replace(/\/+$/, '')}/`);
        addIssue('project', project.name, '', 'native-protected');
      }
    }
    checkAbort(signal);
    const livePaths = typeof nodeFilePaths === 'function' ? await nodeFilePaths() : nodeFilePaths;
    checkAbort(signal);
    for (const path of livePaths) references.add(pathKey(path));
  } catch (error) {
    checkAbort(signal);
    throw new StorageHealthScanError(issueReason(error));
  }

  // 分集可能共用一个素材目录。目录只扫描一次，所有统计再按文件路径去重。
  const scannedRoots = new Set<string>();
  const rootEntries = new Map<string, Awaited<ReturnType<typeof readDir>>>();
  const seenFiles = new Set<string>();
  const files: OrphanFileInfo[] = [];
  for (const project of projects) {
    checkAbort(signal);
    const dataDir = roots.get(project.id) ?? null;
    const dataDirs = projectRoots(project.id), rootKeys = new Set(dataDirs.map((root) => pathKey(root).replace(/\/+$/, '')));
    const sharedWith = projects.filter((other) => other.id !== project.id
      && projectRoots(other.id).some((root) => rootKeys.has(pathKey(root).replace(/\/+$/, '')))).map((other) => other.name);
    const info: ProjectStorageInfo = { projectId: project.id, projectName: project.name, dataDir,
      ...(dataDirs.length > 1 ? { dataDirs } : {}), fileSize: 0, fileCount: 0, categories: {}, sharedWith,
      ...(nativeScopes.some((scope) => scope.entry.project.id === project.id) ? { dataModel: 'native' as const } : {}) };
    report.projects.push(info);
    for (const directory of dataDirs) {
      checkAbort(signal);
      const rootKey = pathKey(directory).replace(/\/+$/, '');
      const nativeDirectory = nativeScopes.some((scope) => [...scope.roots.values()]
        .some((root) => pathKey(root).replace(/\/+$/, '') === rootKey));
      if (scannedRoots.has(rootKey)) continue;
      scannedRoots.add(rootKey);
      let inventory;
      try {
        if (!await exists(directory)) continue;
        inventory = await scanDirRecursive(directory,
          (name, reason) => addIssue('project', project.name, name, reason), ['.thumbnail'], true, signal,
          new Set(dataDirs.map((root) => pathKey(root).replace(/\/+$/, '')).filter((other) => other !== rootKey)), nativeDirectory);
      } catch (error) {
        checkAbort(signal);
        addIssue('project', project.name, directory, issueReason(error));
        continue;
      }
      rootEntries.set(rootKey, inventory.entries);
      for (const file of inventory.files) {
        checkAbort(signal);
        const key = pathKey(file.path);
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        if (nativeDirectory && nativeCleanupProtectedPath(file.path, directory)) references.add(key);
        const category = getFileCategoryName(file.name);
        const count = info.categories[category] ?? { count: 0, size: 0 };
        count.count++;
        count.size += file.size;
        info.categories[category] = count;
        info.fileSize += file.size;
        info.fileCount++;
        files.push({ ...file, projectId: project.id, projectName: project.name });
      }
    }
  }
  report.projectSize = files.reduce((sum, file) => sum + file.size, 0);

  const scannedTrashes = new Set<string>();
  for (const project of projects) {
    for (const root of projectRoots(project.id)) {
      checkAbort(signal);
      const trashDir = joinPath(root, '.trash');
      const key = pathKey(trashDir);
      if (scannedTrashes.has(key)) continue;
      scannedTrashes.add(key);
      // 根目录已经列出过；没有 .trash 就不访问它，避免把隐藏路径的 scope 拒绝当成扫描失败。
      const entries = rootEntries.get(pathKey(root).replace(/\/+$/, ''));
      if (!entries?.some((entry) => entry.name === '.trash')) continue;
      const inventory = await scanDirRecursive(trashDir,
        (name, reason) => addIssue('trash', project.name, name, reason), [], false, signal);
      const trashFiles = inventory.files.filter((file) => {
        const fileKey = pathKey(file.path);
        if (seenFiles.has(fileKey)) return false;
        seenFiles.add(fileKey);
        return true;
      });
      if (!trashFiles.length) continue;
      const trashSize = trashFiles.reduce((sum, file) => sum + file.size, 0);
      let entriesForTrash: UndoTrashEntry[] | undefined;
      try { entriesForTrash = await readUndoTrashEntries(trashDir); }
      catch (error) { checkAbort(signal); addIssue('trash', project.name, '.trash', issueReason(error)); }
      const checked: TrashInfo['files'] = trashFiles.map((file) => ({ path: file.path, size: file.size,
        referenced: !entriesForTrash || isReferenced(file.path, references)
          || isUndoTrashPathProtected(file.path, trashDir, entriesForTrash, references) }));
      // 现有流式摘要器拒绝空文件；空文件保留，不能仅凭大小证明身份。
      const reclaimable = checked.filter((file) => !file.referenced && file.size > 0);
      report.trashes.push({ projectId: project.id, projectName: project.name, trashDir,
        trashSize, fileCount: trashFiles.length, files: checked,
        reclaimableSize: reclaimable.reduce((sum, file) => sum + file.size, 0), reclaimableCount: reclaimable.length });
      report.trashSize += trashSize;
    }
  }
  try { await assertLegacyStorageHealthScope(); }
  catch { throw new StorageHealthScanError('changed'); }
  checkAbort(signal);
  report.orphans = files.filter((file) => !isReferenced(file.path, references));
  if (includeDuplicates) report.duplicates = await scanDuplicateFiles(files, references,
    (file, reason) => addIssue('duplicates', file.projectName, file.name, reason), signal);
  report.totalSize = report.projectSize + report.trashSize;
  // 重复文件里的可删项本来就是未引用文件，不再加第二遍。
  report.reclaimableSize = report.trashes.reduce((sum, trash) => sum + trash.reclaimableSize, 0)
    + report.orphans.reduce((sum, file) => sum + file.size, 0);

  // 外部目录状态只用于提示，不把读取失败伪装成正常结果。
  for (const folder of assetFolders) {
    checkAbort(signal);
    try {
      const folderExists = await exists(folder.path);
      checkAbort(signal);
      if (!folderExists) {
        report.offlineFolders.push({
          path: folder.path,
          label: folder.label,
          online: false,
        });
      }
    } catch {
      checkAbort(signal);
      report.offlineFolders.push({
        path: folder.path,
        label: folder.label,
        online: false,
      });
    }
  }

  for (const project of projects) {
    checkAbort(signal);
    if (nativeScopes.some((scope) => scope.entry.project.id === project.id)) continue;
    try {
      if (roots.get(project.id) !== await getProjectDataDir(project.id)) addIssue('project', project.name, project.name, 'changed');
    } catch (error) {
      checkAbort(signal);
      addIssue('project', project.name, project.name, issueReason(error));
    }
  }
  let latestNativeSnapshot: NativeStorageSnapshot | undefined;
  if (nativeScopes.length) {
    try { latestNativeSnapshot = await readNativeStorageSnapshot({ signal }); }
    catch { checkAbort(signal); throw new StorageHealthScanError('changed'); }
  }
  for (const scope of nativeScopes) {
    checkAbort(signal);
    try {
      const [latest] = await readNativeStorageScopes([scope.entry], signal);
      if (!latest || latest.capture.changeRevision !== scope.capture.changeRevision
        || !configValuesEqual(latest.capture, scope.capture)
        || !nativeSnapshot || !latestNativeSnapshot || !configValuesEqual(nativeStorageProjectRows(latestNativeSnapshot, scope.entry.project.id),
          nativeStorageProjectRows(nativeSnapshot, scope.entry.project.id))
        || !configValuesEqual([...latest.roots].map(([id, root]) => [id, pathKey(root)]), [...scope.roots].map(([id, root]) => [id, pathKey(root)]))) {
        addIssue('project', scope.entry.project.name, '', 'changed');
      }
    } catch (error) {
      checkAbort(signal);
      addIssue('project', scope.entry.project.name, '', issueReason(error));
    }
  }
  try { await assertLegacyStorageHealthScope(); }
  catch { throw new StorageHealthScanError('changed'); }
  checkAbort(signal);
  report.scannedAt = Date.now();
  return report;
}

// ============================================
// 清理操作
// ============================================

/** 仅在用户选择清理后捕获确认快照；默认扫描不读取回收站文件的全部内容。 */
export async function prepareTrashCleanup(entries: readonly TrashInfo[], signal?: AbortSignal): Promise<TrashInfo[]> {
  const prepared: TrashInfo[] = [];
  checkAbort(signal);
  await assertLegacyStorageHealthScope();
  for (const entry of entries) {
    await assertStorageCleanupPath(entry.trashDir, entry.trashDir);
    const files: TrashInfo['files'] = [];
    for (const file of entry.files) {
      checkAbort(signal);
      const item = { ...file };
      if (!item.referenced && item.size > 0) {
        const fingerprint = await fingerprintAssetImage(item.path, signal);
        checkAbort(signal);
        if (fingerprint.bytes !== item.size || !/^[a-f0-9]{64}$/.test(fingerprint.digest)) throw new Error('回收站文件已变化');
        item.digest = fingerprint.digest;
      }
      files.push(item);
    }
    prepared.push({ ...entry, files });
  }
  for (const entry of entries) await assertStorageCleanupPath(entry.trashDir, entry.trashDir);
  await assertLegacyStorageHealthScope();
  checkAbort(signal);
  return prepared;
}

/** 逐文件重新核对引用；预检不能代替跨进程停写或文件系统原子租约。 */
export async function clearTrashDir(trashDir: string, verify?: (path: string, size: number) => Promise<boolean>,
  confirmedFiles?: ReadonlyArray<{ path: string; size: number; digest: string }>, signal?: AbortSignal): Promise<CleanupResult> {
  const result: CleanupResult = { deletedCount: 0, failedCount: 0, reclaimedSize: 0 };
  if (!isTauriEnv()) return result;
  if (pathKey(trashDir).replace(/\/+$/, '').split('/').at(-1) !== '.trash') throw new Error('只能清理项目回收站目录');
  if (!verify || !confirmedFiles) { result.failedCount++; return result; }
  if (signal?.aborted) { result.failedCount++; return result; }
  const confirmed = new Map(confirmedFiles.map((file) => [pathKey(file.path), file]));
  const confirmedDirectories = new Set<string>();
  for (const path of confirmed.keys()) {
    for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) confirmedDirectories.add(path.slice(0, end));
  }
  try {
    await assertStorageCleanupPath(trashDir, trashDir);
    if (!await exists(trashDir)) { result.failedCount += confirmed.size; return result; }
    const info = await lstat(trashDir);
    if (!info.isDirectory || info.isSymlink) throw new Error('回收站不是普通目录');
  } catch {
    result.failedCount++;
    return result;
  }
  const progress = { seen: new Set<string>(), incomplete: false, trashDir };
  const empty = await removeDirContents(trashDir, result, verify, confirmed, confirmedDirectories, progress, signal);
  if (!progress.incomplete) for (const path of confirmed.keys()) if (!progress.seen.has(path)) result.failedCount++;
  if (empty && result.failedCount === 0) {
    try { await assertStorageCleanupPath(trashDir, trashDir); checkAbort(signal); await remove(trashDir); } catch { result.failedCount++; }
  }
  if (result.deletedCount) {
    try {
      for (const entry of await readUndoTrashEntries(trashDir)) {
        if (progress.seen.has(pathKey(entry.stagedPath)) && !await exists(entry.stagedPath)) await forgetUndoTrashEntry(entry);
      }
    } catch { /* 原文件清理已结束，保留的记录不会覆盖新文件。 */ }
  }
  return result;
}

async function removeDirContents(dirPath: string, result: CleanupResult, verify: (path: string, size: number) => Promise<boolean>,
  confirmed: ReadonlyMap<string, { size: number; digest: string }>, confirmedDirectories: ReadonlySet<string>,
  progress: { seen: Set<string>; incomplete: boolean; trashDir: string }, signal?: AbortSignal): Promise<boolean> {
  const failuresBefore = result.failedCount;
  let retained = false;
  let entries;
  try { checkAbort(signal); entries = await readDir(dirPath); } catch { result.failedCount++; progress.incomplete = true; return false; }
  for (const entry of entries) {
    const entryPath = joinPath(dirPath, entry.name);
    progress.seen.add(pathKey(entryPath));
    try {
      const info = await lstat(entryPath);
      if (info.isSymlink || !info.isDirectory && !info.isFile) throw new Error('回收站条目不是普通文件或目录');
      if (info.isDirectory) {
        const directoryKey = pathKey(entryPath).replace(/\/+$/, '');
        if (confirmed.has(directoryKey)) { result.failedCount++; retained = true; continue; }
        if (!confirmedDirectories.has(directoryKey)) { retained = true; continue; }
        if (await removeDirContents(entryPath, result, verify, confirmed, confirmedDirectories, progress, signal)) {
          await assertStorageCleanupPath(entryPath, progress.trashDir); checkAbort(signal); await remove(entryPath);
        }
        else retained = true;
      } else {
        const expected = confirmed.get(pathKey(entryPath));
        if (!expected) { retained = true; continue; }
        if (expected.size !== info.size || !/^[a-f0-9]{64}$/.test(expected.digest)
          || !await verify(entryPath, info.size)) { result.failedCount++; retained = true; continue; }
        checkAbort(signal);
        const fingerprint = await fingerprintAssetImage(entryPath, signal);
        if (fingerprint.bytes !== expected.size || fingerprint.digest !== expected.digest) { result.failedCount++; retained = true; continue; }
        const current = await lstat(entryPath);
        if (!current.isFile || current.isSymlink || current.size !== expected.size) { result.failedCount++; retained = true; continue; }
        await assertStorageCleanupPath(entryPath, progress.trashDir, await readUndoTrashEntries(progress.trashDir));
        checkAbort(signal);
        await remove(entryPath);
        result.deletedCount++;
        result.reclaimedSize += info.size;
      }
    } catch { result.failedCount++; progress.incomplete = true; }
  }
  return !retained && result.failedCount === failuresBefore;
}

/**
 * 删除指定的孤儿文件
 */
export async function deleteOrphanFile(filePath: string, verify?: (path: string) => Promise<boolean>): Promise<boolean> {
  if (!isTauriEnv()) return false;
  try {
    await assertStorageCleanupPath(filePath);
    if (!verify || !await verify(filePath)) return false;
    const info = await lstat(filePath);
    if (!info.isFile || info.isSymlink) return false;
    await assertStorageCleanupPath(filePath);
    await remove(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除调用方已复核为未引用的重复副本
 */
export async function deleteDuplicateFile(filePath: string, verify?: (path: string) => Promise<boolean>): Promise<boolean> {
  return deleteOrphanFile(filePath, verify);
}
