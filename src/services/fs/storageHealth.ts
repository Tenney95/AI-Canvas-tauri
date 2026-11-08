/**
 * fs/storageHealth — 存储健康中心扫描逻辑
 * 扫描各项目占用空间、孤儿文件、重复文件、.trash 残留、可释放空间
 */
import { exists, readDir, lstat, remove } from '@tauri-apps/plugin-fs';
import { isTauriEnv, joinPath, getProjectDataDir } from './core';
import type { CanvasProject } from '../../types';
import {
  getAllProjects, getProjectById, getHistoryEntriesPage,
  getProjectConversations, getConversationMessages, type HistoryPageCursor,
} from '../indexedDbService';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { fingerprintAssetImage } from './assetImageMetadata';
import { listProjectImportRecoveries } from '../indexedDb/projectImportRepository';
import { openDB } from '../indexedDb/schema';
import { assertLegacyProjectWritesAllowed } from '../indexedDb/legacyProjectWriteGuard';
import { safeExchangePath } from '../projectExchangeDomain';

/** 旧引用集合无法证明迁移冻结或新模型下的文件可清理。此预检不替代跨进程停写。 */
async function assertLegacyStorageHealthScope(): Promise<void> {
  await assertLegacyProjectWritesAllowed(await openDB());
}

function pathKey(value: string): string {
  const path = (localMediaUrlToPath(value) ?? value).replace(/\\/g, '/').replace(/^\/\/\?\//, '');
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
  /** 项目数据目录路径 */
  dataDir: string | null;
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

export type StorageHealthIssueReason = 'permission' | 'missing' | 'symlink' | 'changed' | 'unavailable';

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
    if (skipProjectDirectories && isSystemMetadata(entry.name)) continue;
    if (entry.isDirectory && (excludedRootDirectories.includes(entry.name)
      || skipProjectDirectories && (entry.name === '.trash' || entry.name === 'AppData'))) continue;
    const entryPath = joinPath(dirPath, entry.name);
    try {
      const info = await lstat(entryPath);
      checkAbort(signal);
      if (info.isSymlink) { onIssue(entry.name, 'symlink'); continue; }
      if (info.isDirectory) {
        const nested = await scanDirRecursive(entryPath, onIssue, [], skipProjectDirectories, signal);
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
    report.complete = false;
    report.issues.push({ area, projectName: displayName(projectName), name: displayName(name), reason });
  };

  if (!isTauriEnv()) return { ...report, scannedAt: Date.now() };

  // 项目列表只有摘要；必须读取所有完整项目，不能用当前画布推断其他项目无引用。
  // 任何读取失败或记录缺失都终止扫描，不能将未知引用视为空集合。
  const references = new Set<string>();
  const roots = new Map<string, string | null>();
  try {
    await assertLegacyStorageHealthScope();
    checkAbort(signal);
    const allProjects = new Map(projects.map((project) => [project.id, project]));
    for (const project of await getAllProjects()) {
      checkAbort(signal);
      allProjects.set(project.id, project);
    }
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
    const rootKey = dataDir ? pathKey(dataDir).replace(/\/+$/, '') : null;
    const sharedWith = rootKey ? projects.filter((other) => other.id !== project.id
      && pathKey(roots.get(other.id) ?? '').replace(/\/+$/, '') === rootKey).map((other) => other.name) : [];
    const info: ProjectStorageInfo = { projectId: project.id, projectName: project.name, dataDir,
      fileSize: 0, fileCount: 0, categories: {}, sharedWith };
    report.projects.push(info);
    if (!dataDir || !rootKey || scannedRoots.has(rootKey)) continue;
    scannedRoots.add(rootKey);
    let inventory;
    try {
      if (!await exists(dataDir)) continue;
      inventory = await scanDirRecursive(dataDir,
        (name, reason) => addIssue('project', project.name, name, reason), ['.thumbnail'], true, signal);
    } catch (error) {
      checkAbort(signal);
      addIssue('project', project.name, dataDir, issueReason(error));
      continue;
    }
    rootEntries.set(rootKey, inventory.entries);
    for (const file of inventory.files) {
      checkAbort(signal);
      const key = pathKey(file.path);
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
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
  report.projectSize = files.reduce((sum, file) => sum + file.size, 0);

  const scannedTrashes = new Set<string>();
  for (const project of projects) {
    checkAbort(signal);
    const root = roots.get(project.id);
    if (!root) continue;
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
    const checked: TrashInfo['files'] = trashFiles.map((file) => ({ path: file.path, size: file.size, referenced: isReferenced(file.path, references) }));
    // 现有流式摘要器拒绝空文件；空文件保留，不能仅凭大小证明身份。
    const reclaimable = checked.filter((file) => !file.referenced && file.size > 0);
    report.trashes.push({ projectId: project.id, projectName: project.name, trashDir,
      trashSize, fileCount: trashFiles.length, files: checked,
      reclaimableSize: reclaimable.reduce((sum, file) => sum + file.size, 0), reclaimableCount: reclaimable.length });
    report.trashSize += trashSize;
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
    try {
      if (roots.get(project.id) !== await getProjectDataDir(project.id)) addIssue('project', project.name, project.name, 'changed');
    } catch (error) {
      checkAbort(signal);
      addIssue('project', project.name, project.name, issueReason(error));
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
    await assertLegacyStorageHealthScope();
    if (!await exists(trashDir)) { result.failedCount += confirmed.size; return result; }
    const info = await lstat(trashDir);
    if (!info.isDirectory || info.isSymlink) throw new Error('回收站不是普通目录');
  } catch {
    result.failedCount++;
    return result;
  }
  const progress = { seen: new Set<string>(), incomplete: false };
  const empty = await removeDirContents(trashDir, result, verify, confirmed, confirmedDirectories, progress, signal);
  if (!progress.incomplete) for (const path of confirmed.keys()) if (!progress.seen.has(path)) result.failedCount++;
  if (empty && result.failedCount === 0) {
    try { await assertLegacyStorageHealthScope(); checkAbort(signal); await remove(trashDir); } catch { result.failedCount++; }
  }
  return result;
}

async function removeDirContents(dirPath: string, result: CleanupResult, verify: (path: string, size: number) => Promise<boolean>,
  confirmed: ReadonlyMap<string, { size: number; digest: string }>, confirmedDirectories: ReadonlySet<string>,
  progress: { seen: Set<string>; incomplete: boolean }, signal?: AbortSignal): Promise<boolean> {
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
        if (await removeDirContents(entryPath, result, verify, confirmed, confirmedDirectories, progress, signal)) { await assertLegacyStorageHealthScope(); checkAbort(signal); await remove(entryPath); }
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
        await assertLegacyStorageHealthScope();
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
    await assertLegacyStorageHealthScope();
    if (!verify || !await verify(filePath)) return false;
    const info = await lstat(filePath);
    if (!info.isFile || info.isSymlink) return false;
    await assertLegacyStorageHealthScope();
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
