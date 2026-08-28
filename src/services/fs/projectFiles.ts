import {
  exists,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from '@tauri-apps/plugin-fs';
import { normalizeDirectorProjectRelativePath } from '../directorSceneSchema';
import {
  ensureProjectDataDir,
  getProjectDataDir,
  isTauriEnv,
  joinPath,
  notifyProjectDiskChanged,
} from './core';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_FILE_REFERENCE_KEYS = new Set(['relativePath', 'sha256', 'bytes']);

export interface ProjectFileReference {
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface ImmutableWriteResult extends ProjectFileReference {
  created: boolean;
}

export class ProjectFileError extends Error {
  readonly name = 'ProjectFileError';
  readonly code = 'DIRECTOR_PROJECT_FILE_INVALID';
}

const immutableWriteLocks = new Map<string, Promise<void>>();

function fail(message: string): never {
  throw new ProjectFileError(message);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(`${label} 包含不支持的字段: ${unknown}`);
}

export function assertSafeProjectRelativePath(value: unknown): string {
  try {
    return normalizeDirectorProjectRelativePath(value);
  } catch {
    fail('项目文件路径不安全');
  }
}

export function assertProjectFileReference(value: unknown, maxBytes: number): ProjectFileReference {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('项目文件大小上限无效');
  const raw = objectValue(value, '项目文件引用');
  assertKnownKeys(raw, PROJECT_FILE_REFERENCE_KEYS, '项目文件引用');
  const relativePath = assertSafeProjectRelativePath(raw.relativePath);
  if (typeof raw.sha256 !== 'string' || !SHA256_PATTERN.test(raw.sha256)) {
    fail(`项目文件 ${relativePath} 的 SHA-256 无效`);
  }
  if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) <= 0) {
    fail(`项目文件 ${relativePath} 的字节数无效`);
  }
  if ((raw.bytes as number) > maxBytes) {
    fail(`项目文件 ${relativePath} 超过当前验证上限`);
  }
  return {
    relativePath,
    sha256: raw.sha256,
    bytes: raw.bytes as number,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  return sha256OwnedBytes(copy);
}

async function sha256OwnedBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!globalThis.crypto?.subtle) fail('当前环境不支持 SHA-256 校验');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function checkedInfo(path: string, relativePath: string, expected: 'file' | 'directory') {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    fail(`项目文件 ${relativePath} 无法读取`);
  }
  if (info.isSymlink) fail(`项目文件 ${relativePath} 不允许使用符号链接`);
  if (expected === 'file' && !info.isFile) fail(`项目文件 ${relativePath} 不是普通文件`);
  if (expected === 'directory' && !info.isDirectory) fail(`项目文件 ${relativePath} 的父路径不是目录`);
  return info;
}

async function checkedExists(path: string, relativePath: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    fail(`项目路径 ${relativePath} 无法访问`);
  }
}

async function ensureCheckedProjectRoot(projectId: string): Promise<string> {
  if (!isTauriEnv()) fail('Director 项目文件持久化仅在桌面版可用');
  let root;
  try {
    root = await ensureProjectDataDir(projectId);
  } catch {
    fail('无法定位 Director 项目目录');
  }
  if (!root) fail('无法定位 Director 项目目录');
  await checkedInfo(root, '.', 'directory');
  return root;
}

async function getCheckedProjectRoot(projectId: string): Promise<string> {
  if (!isTauriEnv()) fail('Director 项目文件持久化仅在桌面版可用');
  let root;
  try {
    root = await getProjectDataDir(projectId);
  } catch {
    fail('无法定位 Director 项目目录');
  }
  if (!root || !(await checkedExists(root, '.'))) fail('Director 项目目录不存在');
  await checkedInfo(root, '.', 'directory');
  return root;
}

async function ensureCheckedParents(root: string, relativePath: string): Promise<void> {
  const parentSegments = relativePath.split('/').slice(0, -1);
  let current = root;
  for (let index = 0; index < parentSegments.length; index += 1) {
    current = joinPath(current, parentSegments[index]);
    const displayPath = parentSegments.slice(0, index + 1).join('/');
    if (!(await checkedExists(current, displayPath))) {
      try {
        await mkdir(current, { recursive: false });
      } catch {
        if (!(await checkedExists(current, displayPath))) fail(`无法创建项目目录 ${displayPath}`);
      }
    }
    await checkedInfo(current, displayPath, 'directory');
  }
}

async function checkExistingParents(root: string, relativePath: string): Promise<void> {
  const parentSegments = relativePath.split('/').slice(0, -1);
  let current = root;
  for (let index = 0; index < parentSegments.length; index += 1) {
    current = joinPath(current, parentSegments[index]);
    const displayPath = parentSegments.slice(0, index + 1).join('/');
    if (!(await checkedExists(current, displayPath))) fail(`项目目录 ${displayPath} 不存在`);
    await checkedInfo(current, displayPath, 'directory');
  }
}

async function readVerifiedFromRoot(
  root: string,
  reference: ProjectFileReference,
): Promise<Uint8Array> {
  await checkExistingParents(root, reference.relativePath);
  const target = joinPath(root, reference.relativePath);
  if (!(await checkedExists(target, reference.relativePath))) {
    fail(`项目文件 ${reference.relativePath} 不存在`);
  }
  const info = await checkedInfo(target, reference.relativePath, 'file');
  if (!Number.isSafeInteger(info.size) || info.size !== reference.bytes) {
    fail(`项目文件 ${reference.relativePath} 的字节数不匹配`);
  }
  let bytes;
  try {
    bytes = await readFile(target);
  } catch {
    fail(`项目文件 ${reference.relativePath} 无法读取`);
  }
  if (bytes.byteLength !== reference.bytes) {
    fail(`项目文件 ${reference.relativePath} 的字节数不匹配`);
  }
  if (await sha256OwnedBytes(bytes) !== reference.sha256) {
    fail(`项目文件 ${reference.relativePath} 的 SHA-256 不匹配`);
  }
  return bytes;
}

async function withImmutableWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = immutableWriteLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  immutableWriteLocks.set(key, settled);
  try {
    return await current;
  } finally {
    if (immutableWriteLocks.get(key) === settled) immutableWriteLocks.delete(key);
  }
}

export async function writeImmutableProjectFile(input: {
  projectId: string;
  reference: ProjectFileReference;
  data: Uint8Array;
  maxBytes: number;
}): Promise<ImmutableWriteResult> {
  const reference = assertProjectFileReference(input.reference, input.maxBytes);
  const data = Uint8Array.from(input.data);
  if (data.byteLength !== reference.bytes || await sha256Hex(data) !== reference.sha256) {
    fail(`项目文件 ${reference.relativePath} 的待写入内容与引用不匹配`);
  }

  return withImmutableWriteLock(`${input.projectId}\n${reference.relativePath}`, async () => {
    const root = await ensureCheckedProjectRoot(input.projectId);
    await ensureCheckedParents(root, reference.relativePath);
    const target = joinPath(root, reference.relativePath);

    if (await checkedExists(target, reference.relativePath)) {
      const existing = await readVerifiedFromRoot(root, reference);
      if (!bytesEqual(existing, data)) fail(`项目文件 ${reference.relativePath} 存在不可变内容冲突`);
      return { ...reference, created: false };
    }

    try {
      await writeFile(target, data, { createNew: true });
    } catch {
      if (!(await checkedExists(target, reference.relativePath))) {
        fail(`项目文件 ${reference.relativePath} 写入失败`);
      }
      const existing = await readVerifiedFromRoot(root, reference);
      if (!bytesEqual(existing, data)) fail(`项目文件 ${reference.relativePath} 存在不可变内容冲突`);
      return { ...reference, created: false };
    }

    const persisted = await readVerifiedFromRoot(root, reference);
    if (!bytesEqual(persisted, data)) fail(`项目文件 ${reference.relativePath} 写后复核失败`);
    notifyProjectDiskChanged();
    return { ...reference, created: true };
  });
}

export async function readVerifiedProjectFile(input: {
  projectId: string;
  reference: ProjectFileReference;
  maxBytes: number;
}): Promise<Uint8Array> {
  const reference = assertProjectFileReference(input.reference, input.maxBytes);
  const root = await getCheckedProjectRoot(input.projectId);
  return readVerifiedFromRoot(root, reference);
}

/** Read a content-addressed predecessor when its byte count is not stored in the child Scene. */
export async function readVerifiedProjectFileByHash(input: {
  projectId: string;
  relativePath: string;
  sha256: string;
  maxBytes: number;
}): Promise<{ data: Uint8Array; reference: ProjectFileReference }> {
  const relativePath = assertSafeProjectRelativePath(input.relativePath);
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) fail('项目文件大小上限无效');
  if (!SHA256_PATTERN.test(input.sha256)) fail(`项目文件 ${relativePath} 的 SHA-256 无效`);

  const root = await getCheckedProjectRoot(input.projectId);
  await checkExistingParents(root, relativePath);
  const target = joinPath(root, relativePath);
  if (!(await checkedExists(target, relativePath))) fail(`项目文件 ${relativePath} 不存在`);
  const info = await checkedInfo(target, relativePath, 'file');
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > input.maxBytes) {
    fail(`项目文件 ${relativePath} 超过当前验证上限`);
  }
  const reference = { relativePath, sha256: input.sha256, bytes: info.size };
  return {
    data: await readVerifiedFromRoot(root, reference),
    reference,
  };
}
