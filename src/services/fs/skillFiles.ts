/**
 * fs/skillFiles — Skill 资料文件的上传、读取与落盘。
 * 从文件或文件夹导入 Skill 文本资料（md/txt/json）到应用数据目录，
 * 校验相对路径、生成唯一目标路径并支持上传确认。
 */
import { exists, mkdir, readDir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-dialog';
import { appDataDir } from '@tauri-apps/api/path';
import {
  isTauriEnv,
  joinPath,
  resolveUniqueDestPath,
  sanitizeFileName,
  sanitizeFolderName,
} from './core';

export interface UploadedSkillFile {
  fileName: string;
  content: string;
  sourceType: 'file' | 'folder';
  storagePath?: string;
  entryFileName?: string;
}

export type SkillUploadSource = 'file' | 'folder';

interface SkillFileEntry {
  path: string;
  relativePath: string;
  name: string;
}

const SKILL_TEXT_EXTENSIONS = new Set(['md', 'txt', 'json']);
const SKILL_RESOURCE_PATH_ERROR = 'Skill 资料路径无效，只能使用 Skill 内相对路径';

function decodeUtf8Text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Skill 文件必须是 UTF-8 文本');
  }
}

function isSkillTextFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return SKILL_TEXT_EXTENSIONS.has(ext);
}

function browserOpenFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      document.body.removeChild(input);
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(null);
    });
    input.click();
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (document.body.contains(input)) {
            document.body.removeChild(input);
            resolve(null);
          }
        }, 300);
      },
      { once: true },
    );
  });
}

async function ensureSkillRootDir(): Promise<string> {
  const dir = joinPath(await appDataDir(), 'skill');
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

async function collectSkillFiles(dirPath: string, baseDir = dirPath): Promise<SkillFileEntry[]> {
  const entries = await readDir(dirPath);
  const files: SkillFileEntry[] = [];

  for (const entry of entries) {
    const entryPath = joinPath(dirPath, entry.name);
    if (entry.isDirectory) {
      files.push(...await collectSkillFiles(entryPath, baseDir));
      continue;
    }
    if (!entry.isFile || !isSkillTextFile(entry.name)) continue;
    const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedPath = entryPath.replace(/\\/g, '/');
    files.push({
      path: entryPath,
      relativePath: normalizedPath.startsWith(`${normalizedBase}/`)
        ? normalizedPath.slice(normalizedBase.length + 1)
        : entry.name,
      name: entry.name,
    });
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
}

function pickSkillEntry(files: SkillFileEntry[]): SkillFileEntry | null {
  return files.find((file) => file.name.toLowerCase() === 'skill.md')
    ?? files.find((file) => file.relativePath.toLowerCase().endsWith('/skill.md'))
    ?? files.find((file) => file.name.toLowerCase().endsWith('.md'))
    ?? files[0]
    ?? null;
}

async function uploadSkillFolder(): Promise<UploadedSkillFile | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    // 导入会读取多级附属资料；授权范围仅限用户选中的目录子树。
    recursive: true,
    title: '上传 Skill 文件夹',
  });
  if (!selected || Array.isArray(selected)) return null;

  const folderName = selected.split(/[\\/]/).filter(Boolean).pop() || 'skill';
  const files = await collectSkillFiles(selected);
  if (files.length === 0) {
    throw new Error('Skill 文件夹中没有可用的 .md / .txt / .json 文件');
  }

  const entry = pickSkillEntry(files);
  if (!entry) throw new Error('Skill 文件夹中没有可调用入口文件');

  const rootDir = await ensureSkillRootDir();
  const destDir = await resolveUniqueDestPath(rootDir, sanitizeFolderName(folderName));
  await mkdir(destDir, { recursive: true });

  let entryContent = '';
  for (const file of files) {
    const bytes = await readFile(file.path);
    const text = decodeUtf8Text(bytes);
    if (file.relativePath === entry.relativePath) entryContent = text;

    const relativeParts = file.relativePath.split(/[\\/]/).map((part) => sanitizeFileName(part));
    const destPath = joinPath(destDir, ...relativeParts);
    const parentDir = destPath.slice(0, destPath.lastIndexOf('/'));
    if (parentDir && !(await exists(parentDir))) await mkdir(parentDir, { recursive: true });
    await writeFile(destPath, bytes);
  }

  return {
    fileName: folderName,
    content: entryContent,
    sourceType: 'folder',
    storagePath: destDir,
    entryFileName: entry.relativePath,
  };
}

async function uploadSingleSkillFile(): Promise<UploadedSkillFile | null> {
  const filePath = await open({
    multiple: false,
    title: '上传 Skill 文件',
    filters: [{ name: 'Skill 文本文件', extensions: ['md', 'txt', 'json'] }],
  });
  if (!filePath || Array.isArray(filePath)) return null;

  const fileName = filePath.split(/[\\/]/).pop() || 'skill.txt';
  if (!isSkillTextFile(fileName)) {
    throw new Error('Skill 文件只支持 .md / .txt / .json');
  }

  const bytes = await readFile(filePath);
  const content = decodeUtf8Text(bytes);
  const rootDir = await ensureSkillRootDir();
  const destPath = await resolveUniqueDestPath(rootDir, fileName);
  await writeFile(destPath, bytes);

  return {
    fileName,
    content,
    sourceType: 'file',
    storagePath: destPath,
    entryFileName: fileName,
  };
}

/** 上传只读 Skill 文件或文件夹，读取为 UTF-8 文本内容。 */
export async function uploadSkillFile(source: SkillUploadSource = 'folder'): Promise<UploadedSkillFile | null> {
  try {
    if (isTauriEnv()) {
      return source === 'file'
        ? await uploadSingleSkillFile()
        : await uploadSkillFolder();
    }

    const file = await browserOpenFile('.md,.txt,.json');
    if (!file) return null;
    return { fileName: file.name, content: await file.text(), sourceType: 'file', entryFileName: file.name };
  } catch (error) {
    // Tauri 错误可能是带绝对路径的字符串，不直接写入日志或展示。
    console.error('[Skill 上传] 导入失败');
    if (error instanceof Error) throw error;
    throw new Error(source === 'folder'
      ? 'Skill 文件夹导入失败，请重新选择文件夹并检查读取权限'
      : 'Skill 文件导入失败，请重新选择文件并检查读取权限', { cause: error });
  }
}

/**
 * 校验 Skill 附属资料的相对路径，返回规范化结果。
 *
 * 拒绝绝对路径、盘符、scheme、`~`、`.`/`..` 段、空段和非文本扩展名；
 * 抛出的错误只含相对路径，不泄露任何本地绝对路径。
 */
export function assertSafeSkillRelativePath(relativePath: string): string {
  const normalized = relativePath.trim().replace(/\\/g, '/');
  if (!normalized) throw new Error(SKILL_RESOURCE_PATH_ERROR);
  if (normalized.includes(':')) throw new Error(SKILL_RESOURCE_PATH_ERROR);
  if (normalized.startsWith('/') || normalized.startsWith('~')) {
    throw new Error(SKILL_RESOURCE_PATH_ERROR);
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(SKILL_RESOURCE_PATH_ERROR);
  }
  if (!isSkillTextFile(segments[segments.length - 1])) {
    throw new Error('Skill 资料只支持 .md / .txt / .json');
  }
  return segments.join('/');
}

/** 列出某个文件夹型 Skill 自带的资料相对路径；非 Tauri、非目录或读取失败时返回空数组。 */
export async function listSkillResourceFiles(
  storagePath: string | undefined,
  limit: number,
): Promise<string[]> {
  if (!isTauriEnv() || !storagePath || limit <= 0) return [];
  try {
    if (!(await exists(storagePath))) return [];
    const files = await collectSkillFiles(storagePath);
    return files.slice(0, limit).map((file) => file.relativePath);
  } catch (error) {
    console.warn('[Skill 资料] 列出附属文件失败:', error);
    return [];
  }
}

/** 按相对路径读取某个 Skill 目录内的 UTF-8 文本资料，路径必须仍落在该 Skill 子树内。 */
export async function readSkillResourceFile(
  storagePath: string,
  relativePath: string,
): Promise<string> {
  const safePath = assertSafeSkillRelativePath(relativePath);
  if (!isTauriEnv()) throw new Error('当前环境不支持读取 Skill 附属资料');

  const root = storagePath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) throw new Error(SKILL_RESOURCE_PATH_ERROR);
  const target = `${root}/${safePath}`;
  if (!target.startsWith(`${root}/`)) throw new Error(SKILL_RESOURCE_PATH_ERROR);
  if (!(await exists(target))) throw new Error(`Skill 资料不存在: ${safePath}`);

  return decodeUtf8Text(await readFile(target));
}
