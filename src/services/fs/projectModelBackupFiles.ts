/** 固定应用恢复区的备份端口：不写项目素材目录，不接收调用方的绝对路径。 */
import { appDataDir } from '@tauri-apps/api/path';
import { exists, lstat, mkdir, open, writeFile } from '@tauri-apps/plugin-fs';
import { isTauriEnv, joinPath } from './core';
import type { ProjectModelBackupPort } from '../projectModelBackup';

const BACKUP_DIRECTORY = 'project-model-backups';
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ProjectModelBackupStorageError extends Error {
  readonly name = 'ProjectModelBackupStorageError';
  readonly code = 'PROJECT_MODEL_BACKUP_STORAGE_FAILED';
}

function fail(message: string): never { throw new ProjectModelBackupStorageError(message); }

function segments(path: string): string[] {
  if (typeof path !== 'string' || path.length > 512 || path.includes('\\')) fail('备份条目路径无效');
  const parts = path.split('/');
  if (parts.length > 8 || parts.some((part) => !PATH_SEGMENT.test(part) || part === '.' || part === '..'
    || part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('备份条目路径无效');
  }
  return parts;
}

async function checkedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory || info.isSymlink) fail('备份目录必须是普通目录');
}

async function ensureDirectory(path: string): Promise<void> {
  if (!(await exists(path))) {
    try { await mkdir(path); }
    catch { if (!(await exists(path))) fail('无法建立备份目录'); }
  }
  await checkedDirectory(path);
}

async function prepareRoot(operationId: string, create: boolean): Promise<string> {
  if (!isTauriEnv()) fail('项目模型备份文件仅在桌面版可用');
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) fail('备份操作身份无效');
  const appRoot = await appDataDir();
  await checkedDirectory(appRoot);
  const backupRoot = joinPath(appRoot, BACKUP_DIRECTORY);
  if (create) await ensureDirectory(backupRoot);
  else await checkedDirectory(backupRoot);
  const root = joinPath(backupRoot, operationId);
  // 原子占用一次操作目录；已有的中断/完成备份也不能覆盖。
  if (create) await mkdir(root);
  await checkedDirectory(root);
  return root;
}

async function checkedTarget(root: string, path: string, create: boolean): Promise<string> {
  const parts = segments(path);
  await checkedDirectory(root);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = joinPath(current, part);
    if (create) await ensureDirectory(current);
    else await checkedDirectory(current);
  }
  return joinPath(current, parts[parts.length - 1]);
}

async function readBounded(root: string, path: string, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_FILE_BYTES) fail('备份读取预算无效');
  const target = await checkedTarget(root, path, false);
  const before = await lstat(target);
  if (!before.isFile || before.isSymlink || !Number.isSafeInteger(before.size) || before.size > maxBytes) {
    fail('备份条目类型或大小无效');
  }
  const handle = await open(target, { read: true });
  try {
    const info = await handle.stat();
    if (!info.isFile || info.size !== before.size || info.size > maxBytes) fail('备份条目在读取前发生变化');
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = await handle.read(bytes.subarray(offset));
      if (count === null || count <= 0) fail('备份条目读取不完整');
      offset += count;
    }
    const extra = await handle.read(new Uint8Array(1));
    if (extra !== null && extra > 0) fail('备份条目在读取期间发生变化');
    if ((await handle.stat()).size !== info.size) fail('备份条目在读取期间发生变化');
    await checkedTarget(root, path, false);
    const location = await lstat(target);
    if (!location.isFile || location.isSymlink || location.size !== info.size) fail('备份条目位置发生变化');
    return bytes;
  } finally { await handle.close(); }
}

async function makePort(operationId: string, create: boolean): Promise<ProjectModelBackupPort> {
  try {
    const root = await prepareRoot(operationId, create);
    const write = async (path: string, bytes: Uint8Array) => {
      if (!create) fail('只读备份端口不能写入');
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES) fail('备份条目超过写入预算');
      const target = await checkedTarget(root, path, true);
      await writeFile(target, bytes, { createNew: true });
      const info = await lstat(target);
      if (!info.isFile || info.isSymlink || info.size !== bytes.byteLength) fail('备份条目写入不完整');
    };
    const guardedWrite = async (path: string, bytes: Uint8Array) => {
      try { await write(path, bytes); }
      catch (error) {
        if (error instanceof ProjectModelBackupStorageError) throw error;
        fail('备份条目写入失败，已保留本次材料');
      }
    };
    return {
      writeExclusive: guardedWrite,
      read: async (path, maxBytes) => {
        try { return await readBounded(root, path, maxBytes); }
        catch (error) {
          if (error instanceof ProjectModelBackupStorageError) throw error;
          fail('备份条目无法读取');
        }
      },
      publishComplete: async (path, bytes) => {
        if (path !== 'complete.json') fail('备份完成标记路径无效');
        await guardedWrite(path, bytes);
      },
    };
  } catch (error) {
    if (error instanceof ProjectModelBackupStorageError) throw error;
    fail(create ? '无法独占建立备份操作目录' : '无法读取既有备份操作目录');
  }
}

/** 仅显式调用时建立新备份；模块加载不访问用户文件。 */
export function createProjectModelBackupPort(operationId: string): Promise<ProjectModelBackupPort> {
  return makePort(operationId, true);
}

/** 打开既有材料；不存在时失败，不创建空目录或完成标记。 */
export function openProjectModelBackupPort(operationId: string): Promise<ProjectModelBackupPort> {
  return makePort(operationId, false);
}
