/** 正式旧包只有一个素材根；无法表达的旧独立目录必须在发布或更新前拒绝。 */
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import * as files from './fileService';
import type { ProjectSaveData } from './storageService';
import type { ArchiveAssetDigest } from './projectExchangeDomain';
import { selectArchiveImportPaths } from './projectArchiveValidation';

export async function assertLegacyProjectArchiveRoots(records: readonly ProjectSaveData[], primaryDirectory: string): Promise<void> {
  const normalize = (directory: string) => {
    const path = directory.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
  };
  const primary = normalize(primaryDirectory);
  files.registerProjectFolders([...records]);
  for (const record of records.slice(1)) {
    const directory = await files.getProjectDataDir(record.id);
    if (!directory) throw new Error('无法核对旧分集素材目录');
    if (normalize(directory) === primary || !(await exists(directory))) continue;
    const extra = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: directory,
      includeImportPaths: selectArchiveImportPaths([record], null, undefined, directory) });
    if (extra.length) throw new Error('旧项目包含多个素材根目录，当前项目格式无法完整保存或更新；请保留原项目，待新版项目格式开放后再处理');
  }
}
