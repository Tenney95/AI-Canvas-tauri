/**
 * 稳定资产身份索引：assetId 是身份，path 只是最近位置。
 * 第一阶段使用 size + mtime 指纹在已扫描范围内识别移动/重命名；后续可无缝升级为分块哈希。
 */
import { exists, stat } from '@tauri-apps/plugin-fs';
import {
  getAssetIndexById,
  getAssetIndexByPath,
  getAssetIndexesByFingerprint,
  getLegacyAssetMeta,
  putAssetIndex,
  putAssetMeta,
  type AssetIndexRecord,
} from '../indexedDbService';

export type AssetSource = AssetIndexRecord['source'];

export interface IdentifyAssetOptions {
  assetId?: string;
  rootPath?: string;
  projectId?: string;
  source: AssetSource;
  size?: number;
  mtimeMs?: number;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function getRelativeAssetPath(path: string, rootPath: string): string | undefined {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(rootPath);
  const pathForCompare = /^[A-Za-z]:\//.test(normalizedPath) ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = /^[A-Za-z]:\//.test(normalizedRoot) ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return undefined;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function createAssetId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function pathExists(path: string): Promise<boolean> {
  return exists(path).catch(() => false);
}

async function migrateLegacyTags(assetId: string, path: string): Promise<void> {
  const legacy = await getLegacyAssetMeta(path).catch(() => undefined);
  if (!legacy?.tags?.length) return;
  await putAssetMeta({
    assetId,
    path,
    tags: legacy.tags,
    taggedBy: legacy.taggedBy,
    updatedAt: legacy.updatedAt,
  }).catch(() => undefined);
}

/** 注册/刷新一个磁盘资产；若指纹对应的旧位置已离线，则沿用旧 assetId。 */
export async function identifyAsset(path: string, options: IdentifyAssetOptions): Promise<AssetIndexRecord> {
  const normalizedPath = normalizePath(path);
  const fileStat = options.size == null || options.mtimeMs == null
    ? await stat(normalizedPath)
    : null;
  const size = options.size ?? fileStat?.size ?? 0;
  const mtimeMs = options.mtimeMs ?? fileStat?.mtime?.getTime() ?? 0;
  const fingerprint = `${size}:${mtimeMs}`;
  const rootPath = options.rootPath ? normalizePath(options.rootPath) : undefined;
  const relativePath = rootPath ? getRelativeAssetPath(normalizedPath, rootPath) : undefined;

  let existing = options.assetId ? await getAssetIndexById(options.assetId) : undefined;
  existing ??= await getAssetIndexByPath(normalizedPath);

  if (!existing) {
    const candidates = await getAssetIndexesByFingerprint(fingerprint);
    for (const candidate of candidates) {
      if (!(await pathExists(candidate.path))) {
        existing = candidate;
        break;
      }
    }
  }

  const record: AssetIndexRecord = {
    assetId: existing?.assetId ?? options.assetId ?? createAssetId(),
    path: normalizedPath,
    relativePath,
    rootPath,
    projectId: options.projectId,
    source: options.source,
    fingerprint,
    size,
    mtimeMs,
    status: 'online',
    updatedAt: Date.now(),
  };
  await putAssetIndex(record);
  await migrateLegacyTags(record.assetId, normalizedPath);
  return record;
}

export async function resolveIndexedAssetPath(assetId: string): Promise<string | null> {
  const record = await getAssetIndexById(assetId);
  if (!record || !(await pathExists(record.path))) return null;
  return record.path;
}
