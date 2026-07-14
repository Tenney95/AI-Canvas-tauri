/**
 * fs/storageHealth — 存储健康中心扫描逻辑
 * 扫描各项目占用空间、孤儿文件、重复文件、.trash 残留、可释放空间
 */
import { exists, readDir, stat, remove } from '@tauri-apps/plugin-fs';
import { isTauriEnv, joinPath, getProjectDataDir } from './core';
import type { CanvasProject } from '../../types';

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
  /** 项目数据目录内文件的总大小（不含 .trash） */
  fileSize: number;
  /** 项目数据目录内的文件数量 */
  fileCount: number;
  /** 按类别统计 */
  categories: Record<string, { count: number; size: number }>;
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
}

export interface OrphanFileInfo {
  path: string;
  name: string;
  size: number;
  projectId: string;
  projectName: string;
}

export interface DuplicateFileGroup {
  /** 以 size+name 组合键分组 */
  key: string;
  /** 重复文件列表 */
  files: { path: string; name: string; size: number; projectId: string; projectName: string }[];
  /** 可释放空间（保留一个，删除其余） */
  reclaimableSize: number;
}

export interface ExternalFolderStatus {
  path: string;
  label: string;
  online: boolean;
}

export interface StorageHealthReport {
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
  /** 总占用空间 */
  totalSize: number;
  /** 可安全释放的空间 */
  reclaimableSize: number;
}

// ============================================
// 扫描器
// ============================================

/**
 * 递归扫描目录，返回所有文件条目（含子目录）
 */
async function scanDirRecursive(dirPath: string): Promise<ScanFileEntry[]> {
  const results: ScanFileEntry[] = [];
  if (!isTauriEnv()) return results;

  try {
    const entries = await readDir(dirPath);
    for (const entry of entries) {
      const entryPath = joinPath(dirPath, entry.name);
      if (entry.isDirectory) {
        // 跳过 .trash、AppData 等特殊目录
        if (entry.name === '.trash' || entry.name === 'AppData') continue;
        const subFiles = await scanDirRecursive(entryPath);
        results.push(...subFiles);
      } else if (entry.isFile) {
        try {
          const fileStat = await stat(entryPath);
          results.push({
            name: entry.name,
            path: entryPath,
            size: fileStat.size ?? 0,
          });
        } catch { /* skip files we can't stat */ }
      }
    }
  } catch { /* directory doesn't exist or can't be read */ }

  return results;
}

/**
 * 扫描指定项目的数据目录
 */
async function scanProjectStorage(
  project: CanvasProject,
  nodeFilePaths: Set<string>,
): Promise<ProjectStorageInfo | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await getProjectDataDir(project.id);
  if (!dataDir) return {
    projectId: project.id,
    projectName: project.name,
    dataDir: null,
    fileSize: 0,
    fileCount: 0,
    categories: {},
  };

  const files = await scanDirRecursive(dataDir);

  const categories: Record<string, { count: number; size: number }> = {};
  let totalSize = 0;

  for (const f of files) {
    const cat = getFileCategoryName(f.name);
    if (!categories[cat]) categories[cat] = { count: 0, size: 0 };
    categories[cat].count++;
    categories[cat].size += f.size;
    totalSize += f.size;
  }

  return {
    projectId: project.id,
    projectName: project.name,
    dataDir,
    fileSize: totalSize,
    fileCount: files.length,
    categories,
  };
}

function getFileCategoryName(fileName: string): string {
  const ext = `.${fileName.split('.').pop()?.toLowerCase()}`;
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) return '图片';
  if (['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext)) return '视频';
  if (['.mp3', '.wav', '.ogg', '.aac', '.flac'].includes(ext)) return '音频';
  if (['.txt', '.md', '.json', '.csv', '.xml', '.html'].includes(ext)) return '文本';
  return '其他';
}

/**
 * 扫描项目数据目录下的 .trash 残留
 */
async function scanTrashDirs(
  project: CanvasProject,
): Promise<TrashInfo | null> {
  if (!isTauriEnv()) return null;

  const dataDir = await getProjectDataDir(project.id);
  if (!dataDir) return null;

  const trashDir = joinPath(dataDir, '.trash');
  try {
    const trashExists = await exists(trashDir);
    if (!trashExists) return null;

    const files = await scanDirRecursive(trashDir);
    const trashSize = files.reduce((sum, f) => sum + f.size, 0);

    return {
      projectId: project.id,
      projectName: project.name,
      trashDir,
      trashSize,
      fileCount: files.length,
    };
  } catch {
    return null;
  }
}

/**
 * 扫描数据目录内未被任何节点引用的孤儿文件
 */
async function scanOrphanFiles(
  project: CanvasProject,
  nodeFilePaths: Set<string>,
): Promise<OrphanFileInfo[]> {
  if (!isTauriEnv()) return [];

  const dataDir = await getProjectDataDir(project.id);
  if (!dataDir) return [];

  const files = await scanDirRecursive(dataDir);
  return files
    .filter((f) => !nodeFilePaths.has(f.path))
    .map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size,
      projectId: project.id,
      projectName: project.name,
    }));
}

/**
 * 扫描重复文件（基于 size + name 分组，>=2 即重复）
 */
async function scanDuplicateFiles(
  projects: CanvasProject[],
): Promise<DuplicateFileGroup[]> {
  if (!isTauriEnv()) return [];

  // 收集所有文件
  const allFiles: { path: string; name: string; size: number; projectId: string; projectName: string }[] = [];
  for (const p of projects) {
    const dataDir = await getProjectDataDir(p.id);
    if (!dataDir) continue;
    const files = await scanDirRecursive(dataDir);
    for (const f of files) {
      allFiles.push({
        path: f.path,
        name: f.name,
        size: f.size,
        projectId: p.id,
        projectName: p.name,
      });
    }
  }

  // 按 size+name 分组
  const groups = new Map<string, typeof allFiles>();
  for (const f of allFiles) {
    const key = `${f.size}|${f.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  return Array.from(groups.values())
    .filter((g) => g.length >= 2)
    .map((g) => ({
      key: `${g[0].size}|${g[0].name}`,
      files: g,
      // 保留一个，其余可删除
      reclaimableSize: g[0].size * (g.length - 1),
    }));
}

/**
 * 收集所有节点引用的 filePath（用于孤儿检测）
 * @param allNodeData 所有项目所有节点的 data 数组
 */
export function collectNodeFilePaths(allNodeData: Array<{ data?: Record<string, unknown> }>): Set<string> {
  const paths = new Set<string>();
  for (const node of allNodeData) {
    const fp = node.data?.filePath as string | undefined;
    if (fp && typeof fp === 'string') {
      paths.add(fp);
    }
  }
  return paths;
}

/**
 * 执行完整的存储健康扫描
 */
export async function scanStorageHealth(
  projects: CanvasProject[],
  nodeFilePaths: Set<string>,
  assetFolders: { path: string; label: string }[] = [],
): Promise<StorageHealthReport> {
  const report: StorageHealthReport = {
    projects: [],
    trashes: [],
    orphans: [],
    duplicates: [],
    offlineFolders: [],
    scannedAt: Date.now(),
    totalSize: 0,
    reclaimableSize: 0,
  };

  if (!isTauriEnv()) return report;

  // 1. 扫描各项目存储
  for (const p of projects) {
    const info = await scanProjectStorage(p, nodeFilePaths);
    if (info) {
      report.projects.push(info);
      report.totalSize += info.fileSize;
    }
  }

  // 2. 扫描 .trash 残留
  for (const p of projects) {
    const trash = await scanTrashDirs(p);
    if (trash) {
      report.trashes.push(trash);
      report.reclaimableSize += trash.trashSize;
    }
  }

  // 3. 扫描孤儿文件
  for (const p of projects) {
    const orphans = await scanOrphanFiles(p, nodeFilePaths);
    report.orphans.push(...orphans);
    report.reclaimableSize += orphans.reduce((s, o) => s + o.size, 0);
  }

  // 4. 扫描重复文件
  report.duplicates = await scanDuplicateFiles(projects);
  for (const d of report.duplicates) {
    report.reclaimableSize += d.reclaimableSize;
  }

  // 5. 检测离线外部文件夹
  for (const folder of assetFolders) {
    try {
      const folderExists = await exists(folder.path);
      if (!folderExists) {
        report.offlineFolders.push({
          path: folder.path,
          label: folder.label,
          online: false,
        });
      }
    } catch {
      report.offlineFolders.push({
        path: folder.path,
        label: folder.label,
        online: false,
      });
    }
  }

  return report;
}

// ============================================
// 清理操作
// ============================================

/**
 * 清空指定项目的 .trash 目录
 */
export async function clearTrashDir(trashDir: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    const trashExists = await exists(trashDir);
    if (!trashExists) return;

    // 递归删除 .trash 目录内的所有文件
    const entries = await readDir(trashDir);
    for (const entry of entries) {
      const entryPath = joinPath(trashDir, entry.name);
      try {
        if (entry.isFile) {
          await remove(entryPath);
        } else if (entry.isDirectory) {
          await removeDirContents(entryPath);
          await remove(entryPath);
        }
      } catch { /* 跳过无法删除的 */ }
    }
    // 删除 .trash 目录本身
    await remove(trashDir).catch(() => {});
  } catch { /* .trash 不存在或无权限 */ }
}

async function removeDirContents(dirPath: string): Promise<void> {
  try {
    const entries = await readDir(dirPath);
    for (const entry of entries) {
      const entryPath = joinPath(dirPath, entry.name);
      if (entry.isDirectory) {
        await removeDirContents(entryPath);
        await remove(entryPath).catch(() => {});
      } else {
        await remove(entryPath).catch(() => {});
      }
    }
  } catch { /* skip */ }
}

/**
 * 删除指定的孤儿文件
 */
export async function deleteOrphanFile(filePath: string): Promise<boolean> {
  if (!isTauriEnv()) return false;
  try {
    await remove(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从重复文件组中删除指定文件（保留第一个）
 */
export async function deleteDuplicateFile(filePath: string): Promise<boolean> {
  if (!isTauriEnv()) return false;
  try {
    await remove(filePath);
    return true;
  } catch {
    return false;
  }
}
