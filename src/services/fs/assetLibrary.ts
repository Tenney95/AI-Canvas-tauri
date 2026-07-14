/**
 * fs/assetLibrary — 全局资产库（项目无关）+ 外部文件夹 + 永久保存
 * 全局 file 目录、递归遍历外部文件夹、添加文件/文件夹、保存到永久目录、删除永久文件。
 */
import { writeFile, readFile as tauriReadFile, mkdir, exists, stat, readDir } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-dialog';
import {
  isTauriEnv,
  joinPath,
  getBaseDir,
  getConvertFileSrc,
  resolveUniqueDestPath,
  listDirectoryFiles,
  getFileCategory,
  CATEGORY_EXTENSIONS,
  type AssetFileEntry,
} from './core';
import { moveToTrash } from './trash';
import { identifyAsset } from './assetIndex';

/** 全局文件目录：{baseDataDir}/file（手动添加的单文件落此处）*/
export async function getGlobalFilesDir(): Promise<string | null> {
  const base = await getBaseDir();
  if (!base) return null;
  return joinPath(base, 'file');
}

async function ensureGlobalFilesDir(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const dir = await getGlobalFilesDir();
  if (!dir) return null;
  try {
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    return dir;
  } catch (err) {
    console.error('Failed to create global files dir:', dir, err);
    return null;
  }
}

/** 列出全局 file 目录（顶层）*/
export async function listGlobalFiles(): Promise<AssetFileEntry[]> {
  const dir = await getGlobalFilesDir();
  if (!dir) return [];
  if (!(await exists(dir).catch(() => false))) return [];
  const files = await listDirectoryFiles(dir);
  return Promise.all(files.map(async (f) => {
    const identity = await identifyAsset(f.path, { rootPath: dir, source: 'global', size: f.size });
    return { ...f, assetId: identity.assetId, relativePath: identity.relativePath, source: 'global' as const, availability: 'online' as const };
  }));
}

/**
 * 递归遍历目录收集文件（带数量/深度上限，避免超大目录卡死）。
 * 每个目录内的 stat 并行，整体用栈迭代而非深递归。
 */
export async function walkDirectoryFiles(
  rootDir: string,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): Promise<AssetFileEntry[]> {
  if (!isTauriEnv()) return [];
  const maxFiles = opts.maxFiles ?? 3000;
  const maxDepth = opts.maxDepth ?? 8;
  const convertFileSrc = await getConvertFileSrc();
  const out: AssetFileEntry[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0 && out.length < maxFiles) {
    const { dir, depth } = stack.pop()!;
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
    } catch {
      continue;
    }
    const fileEntries = entries.filter((e) => e.isFile);
    const subDirs = entries.filter((e) => e.isDirectory);

    const statResults = await Promise.all(
      fileEntries.map(async (e) => {
        const filePath = joinPath(dir, e.name);
        try {
          const s = await stat(filePath);
          return { name: e.name, filePath, size: s.size ?? 0, mtimeMs: s.mtime?.getTime() ?? 0 };
        } catch {
          return null;
        }
      }),
    );

    for (const r of statResults) {
      if (!r) continue;
      if (out.length >= maxFiles) break;
      const ext = `.${r.name.split('.').pop()?.toLowerCase()}`;
      let assetUrl: string | undefined;
      if (CATEGORY_EXTENSIONS.image.includes(ext) && convertFileSrc) {
        assetUrl = convertFileSrc(r.filePath);
      }
      const identity = await identifyAsset(r.filePath, {
        rootPath: rootDir,
        source: 'folder',
        size: r.size,
        mtimeMs: r.mtimeMs,
      });
      out.push({
        assetId: identity.assetId,
        name: r.name,
        path: r.filePath,
        relativePath: identity.relativePath,
        assetUrl,
        size: r.size,
        category: getFileCategory(r.name),
        availability: 'online',
      });
    }

    if (depth < maxDepth) {
      for (const d of subDirs) stack.push({ dir: joinPath(dir, d.name), depth: depth + 1 });
    }
  }
  return out;
}

/** 列出登记的外部文件夹中的全部文件（递归，整体上限） */
export async function listExternalFolderFiles(
  folders: string[],
  opts: { maxFilesPerFolder?: number } = {},
): Promise<AssetFileEntry[]> {
  if (!isTauriEnv() || folders.length === 0) return [];
  const perFolder = opts.maxFilesPerFolder ?? 3000;
  const results = await Promise.all(
    folders.map(async (folder) => {
      if (!(await exists(folder).catch(() => false))) return [];
      const files = await walkDirectoryFiles(folder, { maxFiles: perFolder });
      return files.map((f) => ({ ...f, source: 'folder' as const, folderRoot: folder }));
    }),
  );
  return results.flat();
}

/** 选择本地文件（可多选）拷贝到全局 file 目录，返回拷贝数量 */
export async function addAssetFilesToGlobal(): Promise<number> {
  if (!isTauriEnv()) return 0;
  const selected = await open({ multiple: true, title: '添加文件到资产库' });
  if (!selected) return 0;
  const paths = Array.isArray(selected) ? selected : [selected];
  const destDir = await ensureGlobalFilesDir();
  if (!destDir) return 0;

  let count = 0;
  for (const src of paths) {
    try {
      const fileName = src.split(/[\\/]/).pop() || 'file';
      const destPath = await resolveUniqueDestPath(destDir, fileName);
      const data = await tauriReadFile(src);
      await writeFile(destPath, data);
      count++;
    } catch (err) {
      console.error('Failed to add file to global:', src, err);
    }
  }
  return count;
}

/** 选择一个本地文件夹，返回其路径（仅登记引用，不拷贝） */
export async function pickAssetFolder(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const selected = await open({ directory: true, title: '添加本地文件夹' });
  if (!selected || Array.isArray(selected)) return typeof selected === 'string' ? selected : null;
  return selected;
}

/** 将文件拷贝到全局永久目录 {baseDataDir}/file */
export async function saveToPermanent(filePath: string): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const destDir = await ensureGlobalFilesDir();
  if (!destDir) return null;

  try {
    const fileName = filePath.split(/[\\/]/).pop() || 'file';
    const destPath = await resolveUniqueDestPath(destDir, fileName);
    const data = await tauriReadFile(filePath);
    await writeFile(destPath, data);
    return destPath;
  } catch (err) {
    console.error('Failed to save file to permanent:', filePath, err);
    return null;
  }
}

/**
 * 将 asset entry 保存到永久目录 — 支持磁盘文件和 data URL 两种来源
 * virtual:// 路径会从 entry.assetUrl（data URL）解码写入
 */
export async function saveAssetToPermanent(
  entry: AssetFileEntry,
): Promise<string | null> {
  if (!isTauriEnv()) return null;

  // 虚拟路径：从 data URL 解码写入
  if (entry.path.startsWith('virtual://')) {
    if (!entry.assetUrl || !entry.assetUrl.startsWith('data:')) return null;
    const destDir = await ensureGlobalFilesDir();
    if (!destDir) return null;

    try {
      const destPath = await resolveUniqueDestPath(destDir, entry.name);

      const match = entry.assetUrl.match(/^data:(.+?);base64,(.+)$/);
      if (match) {
        const b64 = match[2];
        const binaryStr = atob(b64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        await writeFile(destPath, bytes);
      } else {
        const resp = await fetch(entry.assetUrl);
        const buffer = await resp.arrayBuffer();
        await writeFile(destPath, new Uint8Array(buffer));
      }
      return destPath;
    } catch (err) {
      console.error('Failed to save virtual asset to permanent:', entry.name, err);
      return null;
    }
  }

  // 真实磁盘路径
  return saveToPermanent(entry.path);
}

/** 删除永久保存的文件（移入回收站） */
export async function deletePermanentFile(filePath: string): Promise<void> {
  await moveToTrash(filePath);
}
