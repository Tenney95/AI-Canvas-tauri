/**
 * recentAssets — 记录并读取指定范围内最近使用的资产。
 */
import { stat } from '@tauri-apps/plugin-fs';
import { getAssetIndexById, getAssetIndexByPath, getRecentAssetUsage, recordRecentAssetUsage } from '../indexedDbService';
import { getConvertFileSrc, getFileCategory, getProjectDataDir, isTauriEnv, type AssetFileEntry } from './core';
import { getGlobalFilesDir, hasNativeAssetRootAncestor } from './assetLibrary';
import { getRelativeAssetPath } from './assetIndex';
import { isProjectAgentInternalFile } from '../../utils/agentProjectWorkspace';
import { isNativeMediaPendingFile } from '../../utils/nativeMediaPendingFile';
import { isNativeProjectBindingFile } from '../../utils/nativeProjectBindingFile';

export interface RecentAssetEntry {
  file: AssetFileEntry;
  usedAt: number;
  projectId?: string;
}

export interface RecentAssetsScope {
  folderRoots: readonly string[];
  projectIds: readonly string[];
}

/** 只登记已索引的磁盘文件，不为虚拟媒体创建身份，也不扫描目录。 */
export async function markRecentAssetUsed(file: Pick<AssetFileEntry, 'path' | 'assetId'>, usedAt = Date.now()): Promise<boolean> {
  if (!isTauriEnv() || !file.path || isNativeProjectBindingFile(file.path) || /^(?:node|virtual|data|blob|https?):/i.test(file.path)) return false;
  const normalized = file.path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const index = file.assetId ? await getAssetIndexById(file.assetId) : await getAssetIndexByPath(normalized);
  if (!index || index.path.replace(/\\/g, '/') !== normalized || index.status !== 'online') return false;
  await recordRecentAssetUsage(index.assetId, usedAt);
  return true;
}

/** 有界读取现有索引；取消关联的目录和失效文件不得被最近使用入口重新暴露。 */
export async function loadRecentAssets(scope: RecentAssetsScope, signal?: AbortSignal): Promise<RecentAssetEntry[]> {
  if (!isTauriEnv() || signal?.aborted) return [];
  const [usage, globalRoot, convert] = await Promise.all([getRecentAssetUsage(), getGlobalFilesDir(), getConvertFileSrc()]);
  const entries: RecentAssetEntry[] = [];
  for (const record of usage) {
    if (signal?.aborted) return [];
    try {
      const index = await getAssetIndexById(record.assetId);
      if (!index || isNativeMediaPendingFile(index.path) || isNativeProjectBindingFile(index.path)) continue;
      let root: string | null | undefined;
      if (index.source === 'folder') {
        root = scope.folderRoots.find((candidate) => getRelativeAssetPath(index.path, candidate) !== undefined);
      } else if (index.source === 'global') {
        root = globalRoot;
      } else if (index.projectId && scope.projectIds.includes(index.projectId)) {
        root = await getProjectDataDir(index.projectId);
      }
      const relativePath = root ? getRelativeAssetPath(index.path, root) : undefined;
      if (!root || relativePath === undefined
        || (index.source === 'project' && isProjectAgentInternalFile(relativePath))
        || index.path.replace(/\\/g, '/').split('/').some((part) => part === '.' || part === '..' || part === '.trash')) continue;
      const parent = index.path.slice(0, Math.max(index.path.lastIndexOf('/'), index.path.lastIndexOf('\\')));
      if (index.source !== 'project' && await hasNativeAssetRootAncestor(parent)) continue;
      const info = await stat(index.path);
      if (!info.isFile || info.isSymlink || signal?.aborted) continue;
      const name = index.path.replace(/\\/g, '/').split('/').pop()!;
      entries.push({
        usedAt: record.usedAt,
        projectId: index.projectId,
        file: { assetId: index.assetId, name, path: index.path, relativePath,
          assetUrl: convert?.(index.path), size: info.size, category: getFileCategory(name),
          availability: 'online', source: index.source, folderRoot: index.source === 'folder' ? root : undefined },
      });
      if (entries.length === 12) break;
    } catch { /* 文件删除、目录撤销或权限失败只跳过该项，不清空使用记录。 */ }
  }
  return signal?.aborted ? [] : entries;
}
