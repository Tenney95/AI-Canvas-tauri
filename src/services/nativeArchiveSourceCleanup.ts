/** 逐项核对操作独占的归档输入暂存，保护活动 journal、原备份和未追踪文件。 */
import { invoke } from '@tauri-apps/api/core';
import { exists, lstat, readDir, remove } from '@tauri-apps/plugin-fs';
import { getBaseDir, joinPath } from './fileService';
import { safeExchangePath, type ArchiveAssetDigest } from './projectExchangeDomain';
import { PROJECT_EXCHANGE_LIMITS } from './projectExchangeFormat';
import type { ProjectModelTransferImportJournal } from '../types/projectModelTransfer';

const operationUuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const nativeImportSourceName = new RegExp(`^native-import-(${operationUuid})$`);
export const nativeUpdateSourceName = new RegExp(`^native-update-(${operationUuid})$`);
const nativeRecoveryPreviewName = new RegExp(`^native-recovery-preview-${operationUuid}$`);

export async function assertPlainArchiveSource(path: string, directory: boolean) {
  const info = await lstat(path);
  if (info.isSymlink || ((info.fileAttributes ?? 0) & 0x400) !== 0 || (directory ? !info.isDirectory : !info.isFile)) {
    throw new Error('归档暂存目录已变化');
  }
  return info;
}

function sameStagedFile(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.fileAttributes === after.fileAttributes
    && before.mtime?.getTime() === after.mtime?.getTime()
    && before.birthtime?.getTime() === after.birthtime?.getTime();
}

export function frozenArchiveSourceAssets(sourceFiles: NonNullable<ProjectModelTransferImportJournal['sourceFiles']>): ArchiveAssetDigest[] {
  return sourceFiles.map((file) => {
    if (!file.archivePath.startsWith('assets/')) throw new Error('归档暂存清单路径无效');
    return { path: safeExchangePath(file.archivePath.slice('assets/'.length)), bytes: file.bytes, sha256: file.sha256 };
  });
}

/** 清理仅允许命名受控的目录和确认为原操作内容的文件，中断后的子集也可补清理。 */
export async function cleanupVerifiedArchiveSource(base: string, sourceRef: string, assets: readonly ArchiveAssetDigest[]): Promise<void> {
  const prefix = sourceRef.split('/');
  if (!(prefix.length === 1 && (nativeImportSourceName.test(prefix[0]) || nativeRecoveryPreviewName.test(prefix[0]))
      || prefix.length === 2 && prefix[0] === 'imports' && nativeUpdateSourceName.test(prefix[1]))
    || assets.length > PROJECT_EXCHANGE_LIMITS.media) throw new Error('归档暂存清单无效');
  const directory = joinPath(base, ...prefix);
  if (!await exists(directory)) return;
  const files = new Map<string, ArchiveAssetDigest>(), allowedFolders = new Set<string>();
  for (const asset of assets) {
    const path = safeExchangePath(asset.path), previous = files.get(path);
    if (path !== asset.path || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !/^[0-9a-f]{64}$/.test(asset.sha256)
      || previous && (previous.bytes !== asset.bytes || previous.sha256 !== asset.sha256)) throw new Error('归档暂存清单无效');
    files.set(path, asset);
    const parts = path.split('/').slice(0, -1);
    while (parts.length) {
      allowedFolders.add(parts.join('/'));
      parts.pop();
    }
  }
  const recheckParents = async (relative: string) => {
    if (await getBaseDir() !== base) throw new Error('归档暂存根已变化');
    let parent = base;
    await assertPlainArchiveSource(parent, true);
    for (const segment of [...prefix, ...(relative ? relative.split('/') : [])]) {
      parent = joinPath(parent, segment);
      await assertPlainArchiveSource(parent, true);
    }
    return parent;
  };
  const folders: Array<{ relative: string; files: string[] }> = [{ relative: '', files: [] }];
  const beforeHash = new Map<string, Awaited<ReturnType<typeof lstat>>>();
  for (const folder of folders) {
    const parent = await recheckParents(folder.relative);
    for (const entry of await readDir(parent)) {
      const path = folder.relative ? `${folder.relative}/${entry.name}` : entry.name;
      if (entry.isSymlink) throw new Error('归档暂存包含未知条目');
      if (entry.isDirectory && allowedFolders.has(path)) folders.push({ relative: path, files: [] });
      else if (entry.isFile && files.has(path)) {
        const info = await assertPlainArchiveSource(joinPath(parent, entry.name), false);
        if (info.size !== files.get(path)?.bytes) throw new Error('归档暂存文件大小已变化');
        beforeHash.set(path, info);
        folder.files.push(path);
      }
      else throw new Error('归档暂存包含未知条目');
    }
  }
  const present = new Set(beforeHash.keys());
  if (present.size) {
    const actual = await invoke<ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir: directory, selectedPaths: [...present] });
    if (actual.length !== present.size || actual.some((file) => {
      const expected = files.get(file.path);
      return !present.delete(file.path) || !expected || expected.bytes !== file.bytes || expected.sha256 !== file.sha256;
    })) throw new Error('归档暂存文件已变化');
  }
  for (const folder of folders.reverse()) {
    for (const path of folder.files) {
      await recheckParents(folder.relative);
      const absolute = joinPath(directory, path);
      const info = await assertPlainArchiveSource(absolute, false);
      if (!sameStagedFile(beforeHash.get(path)!, info)) throw new Error('归档暂存文件已变化');
      await remove(absolute);
    }
    // 非递归删除。扫描后出现的外部文件仍保留。
    await remove(await recheckParents(folder.relative));
  }
}
