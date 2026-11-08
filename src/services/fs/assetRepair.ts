/**
 * assetRepair — 扫描不可用资产并生成修复与清理候选。
 */
import { lstat, mkdir, stat } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-dialog';
import { t } from '../../i18n';
import { assertDramaAssetWriteCurrent, type DramaAssetWriteOptions } from '../../types/dramaAssets';
import { forgetMissingAssetRecords, getAllAssetIndexes, getAssetIndexById, getAssetImageRecords, type AssetIndexRecord } from '../indexedDbService';
import { persistAssetRepairBatch, retiredMediaPaths, type MediaRelocation } from '../indexedDb/mediaRelocations';
import { copyAssetFileToFolder } from '../fileService';
import { fingerprintAssetImage } from './assetImageMetadata';
import { getGlobalFilesDir } from './assetLibrary';
import { getRelativeAssetPath } from './assetIndex';
import { getAssetUrlFromPath, getFileCategory, getProjectDataDir, isTauriEnv, joinPath, notifyProjectDiskChanged, stripVerbatimPrefix } from './core';

export type AssetRepairTarget = { kind: 'file'; assetId?: string; path: string; name: string } | { kind: 'folder'; path: string; name: string } | { kind: 'all' };
export interface AssetRepairCandidate {
  index: AssetIndexRecord;
  targetPath?: string;
  targetRoot?: string;
  status: 'ready' | 'missing' | 'error' | 'conflict' | 'online';
  match?: 'hash' | 'metadata';
  digest?: string;
  message?: string;
}
export interface AssetRepairPreview { target: AssetRepairTarget; candidates: AssetRepairCandidate[]; selectedRoot?: string; truncated?: boolean }
export interface AssetRepairScan { candidates: AssetRepairCandidate[]; truncated: boolean }
const normalize = (value: string) => stripVerbatimPrefix(value).replace(/\\/g, '/').replace(/\/+$/, '');
const key = (value: string) => /^[a-z]:\//i.test(normalize(value)) || normalize(value).startsWith('//') ? normalize(value).toLowerCase() : normalize(value);
const missing = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // 原生错误可能附带路径；文件名中的“not found”不能把权限拒绝变成缺失。
  if (/forbidden path|permission denied|access (?:is )?denied|not allowed|scope (?:check failed|denied|mismatch)|EACCES|EPERM|\(os error (?:5|13)\)|拒绝访问|权限不足|无权/i.test(message)) return false;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT' || code === 'NotFound') return true;
  return /\(os error [23]\)\s*$/i.test(message)
    || /^(?:ENOENT|NotFound|not found|no such file or directory|path not found|系统找不到指定的文件。?|系统找不到指定的路径。?)$/i.test(message.trim());
};
const guarded = async <T>(work: () => Promise<T>, options: DramaAssetWriteOptions) => {
  assertDramaAssetWriteCurrent(options); const result = await work(); assertDramaAssetWriteCurrent(options); return result;
};
async function inspect(path: string, options: DramaAssetWriteOptions) {
  try { return await guarded(() => lstat(path), options); }
  catch (error) { assertDramaAssetWriteCurrent(options); if (missing(error)) return null; throw error; }
}

export async function listUnavailableAssetIndexes(target: AssetRepairTarget, options: DramaAssetWriteOptions = {}): Promise<AssetRepairScan> {
  const indexes = await guarded(getAllAssetIndexes, options);
  const selected = indexes.filter((entry) => {
    if (target.kind === 'all') return true;
    if (target.kind === 'file') return target.assetId ? entry.assetId === target.assetId : key(entry.path) === key(target.path);
    return getRelativeAssetPath(entry.path, target.path) !== undefined;
  });
  const result: AssetRepairCandidate[] = [];
  let issues = 0;
  let examined = 0;
  for (const index of selected) {
    if (issues >= 500 || examined >= 10000) break;
    examined++;
    try {
      const info = await inspect(index.path, options);
      result.push({ index, status: info?.isFile && !info.isSymlink ? 'online' : info ? 'error' : 'missing',
        ...(info && (!info.isFile || info.isSymlink) ? { message: t('原位置不是普通文件，未执行修复') } : {}) });
    } catch {
      assertDramaAssetWriteCurrent(options);
      result.push({ index, status: 'error', message: t('原文件读取失败，请检查权限；未将其视为丢失') });
    }
    if (result[result.length - 1].status !== 'online') issues++;
  }
  return { candidates: result, truncated: examined < selected.length };
}

/** 只忘记明确缺失的素材及其专属信息；不操作磁盘原件或项目正文。 */
export async function cleanupUnavailableAssets(
  preview: AssetRepairPreview, assetIds: readonly string[],
  onCommitted: (result: Awaited<ReturnType<typeof forgetMissingAssetRecords>>) => void,
  options: DramaAssetWriteOptions = {},
): Promise<number> {
  if (!isTauriEnv()) throw new Error(t('失效素材清理仅支持桌面应用'));
  const ids = new Set(assetIds);
  const selected = preview.candidates.filter((candidate) => ids.has(candidate.index.assetId));
  if (!ids.size || ids.size > 500 || selected.length !== ids.size || selected.some((candidate) => candidate.status !== 'missing')) {
    throw new Error(t('请选择本批已确认缺失的素材'));
  }
  for (const { index } of selected) {
    const current = await guarded(() => getAssetIndexById(index.assetId), options);
    if (!current || key(current.path) !== key(index.path) || current.fingerprint !== index.fingerprint
      || current.size !== index.size || current.mtimeMs !== index.mtimeMs || current.contentDigest !== index.contentDigest) {
      throw new Error(t('素材身份或位置已变化，请重新预览'));
    }
    if (await inspect(index.path, options)) throw new Error(t('原文件已恢复或位置已变化，请重新预览'));
  }
  assertDramaAssetWriteCurrent(options);
  const result = await forgetMissingAssetRecords(selected.map(({ index }) => index), options);
  // 已提交的结果必须刷新内存，即便提交后用户取消或离开视图。
  onCommitted(result);
  notifyProjectDiskChanged();
  return result.assetIds.length;
}

/** 用户先明确选择目录，再按原相对路径预览；不按文件名全盘猜测。 */
export async function previewAssetRepair(target: AssetRepairTarget, options: DramaAssetWriteOptions = {}): Promise<AssetRepairPreview | null> {
  if (!isTauriEnv()) throw new Error(t('素材修复仅支持桌面应用'));
  const { candidates, truncated } = await listUnavailableAssetIndexes(target, options);
  if (target.kind === 'all') return { target, candidates, truncated };
  const selected = await guarded(() => open({ title: target.kind === 'folder' ? t('选择移动后的素材文件夹') : t('选择原素材文件'),
    directory: target.kind === 'folder', multiple: false }), options);
  if (!selected || typeof selected !== 'string') return null;
  const selectedRoot = target.kind === 'folder' ? normalize(selected) : undefined;
  if (selectedRoot) {
    const info = await inspect(selectedRoot, options);
    if (!info?.isDirectory || info.isSymlink) throw new Error(t('请选择普通文件夹'));
  }
  const [images, indexes, retired] = await guarded(() => Promise.all([getAssetImageRecords(options.signal), getAllAssetIndexes(), retiredMediaPaths()]), options);
  const planned = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.status !== 'missing') continue;
    const relative = target.kind === 'folder' ? getRelativeAssetPath(candidate.index.path, target.path) : undefined;
    candidate.targetPath = target.kind === 'folder' ? relative ? joinPath(selectedRoot!, relative) : undefined : normalize(selected);
    candidate.targetRoot = selectedRoot;
    if (candidate.targetPath) planned.set(key(candidate.targetPath), (planned.get(key(candidate.targetPath)) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if (candidate.status !== 'missing' || !candidate.targetPath) continue;
    const path = candidate.targetPath;
    if (planned.get(key(path)) !== 1 || indexes.some((entry) => entry.assetId !== candidate.index.assetId && key(entry.path) === key(path))
      || [...retired].some((entry) => key(entry) === key(path))) {
      candidate.status = 'conflict'; candidate.message = t('目标存在身份冲突或属于旧路径保护范围，未自动重连'); continue;
    }
    try {
      const info = await inspect(path, options);
      if (!info?.isFile || info.isSymlink) { candidate.message = t('目标文件未找到或不是普通文件'); continue; }
      const oldCategory = getFileCategory(candidate.index.path);
      const newCategory = getFileCategory(path);
      if (oldCategory !== newCategory || oldCategory === 'other' && candidate.index.path.split('.').pop()?.toLowerCase() !== path.split('.').pop()?.toLowerCase()
        || info.size !== candidate.index.size) throw new Error(t('类型或文件大小不一致，未执行修复'));
      const digests = new Set(images.filter((image) => image.assetId === candidate.index.assetId).map((image) => image.contentDigest));
      const expected = candidate.index.contentDigest ?? (digests.size === 1 ? [...digests][0] : undefined);
      const content = await guarded(() => fingerprintAssetImage(path, options.signal), options);
      if (expected ? expected !== content.digest : info.mtime?.getTime() !== candidate.index.mtimeMs) throw new Error(t('内容摘要或修改时间不一致，未执行修复'));
      candidate.digest = content.digest; candidate.match = expected ? 'hash' : 'metadata'; candidate.status = 'ready';
      candidate.message = expected ? t('内容摘要一致') : t('仅元数据匹配，需逐项确认');
    } catch (error) {
      assertDramaAssetWriteCurrent(options);
      candidate.status = 'error'; candidate.message = error instanceof Error ? error.message : t('目标读取失败，未执行修复');
    }
  }
  return { target, candidates, selectedRoot, truncated };
}

/** 所有选择复核通过才提交；复制失败保留已完成副本，不回收用户选择的原件。 */
export async function applyAssetRepairs(
  preview: AssetRepairPreview, assetIds: readonly string[], roots: readonly string[],
  onCommitted: (moves: readonly MediaRelocation[]) => void, options: DramaAssetWriteOptions = {},
): Promise<number> {
  const selected = preview.candidates.filter((candidate) => assetIds.includes(candidate.index.assetId));
  if (selected.some((candidate) => candidate.index.assetId.startsWith('na2-'))) throw new Error(t('新项目恢复素材请通过项目恢复点重建，不能沿用旧素材修复入口'));
  if (!selected.length || selected.length !== new Set(assetIds).size || selected.some((candidate) => candidate.status !== 'ready' || !candidate.digest || !candidate.targetPath)) throw new Error(t('请选择已核对的可修复项'));
  if (new Set(selected.map((candidate) => key(candidate.targetPath!))).size !== selected.length) throw new Error(t('多个素材选择了同一个目标，请分别选择文件'));
  const globalRoot = await guarded(getGlobalFilesDir, options);
  const images = await guarded(() => getAssetImageRecords(options.signal), options);
  const moves: MediaRelocation[] = [];
  for (const candidate of selected) {
    const current = await guarded(() => getAssetIndexById(candidate.index.assetId), options);
    if (!current || key(current.path) !== key(candidate.index.path) || current.fingerprint !== candidate.index.fingerprint
      || current.size !== candidate.index.size || current.mtimeMs !== candidate.index.mtimeMs) throw new Error(t('素材身份或位置已变化，请重新预览'));
    const original = await inspect(candidate.index.path, options);
    if (original) throw new Error(t('原文件已恢复或位置已变化，请重新预览'));
    const content = await guarded(() => fingerprintAssetImage(candidate.targetPath!, options.signal), options);
    if (content.digest !== candidate.digest || content.bytes !== candidate.index.size) throw new Error(t('目标文件在预览后发生变化，请重新选择'));
    const candidateInfo = await guarded(() => stat(candidate.targetPath!), options);
    const previousDigests = new Set(images.filter((image) => image.assetId === current.assetId).map((image) => image.contentDigest));
    const expectedDigest = current.contentDigest ?? (previousDigests.size === 1 ? [...previousDigests][0] : undefined);
    if (getFileCategory(current.path) !== getFileCategory(candidate.targetPath!)
      || (expectedDigest ? content.digest !== expectedDigest : candidateInfo.mtime?.getTime() !== current.mtimeMs)) throw new Error(t('内容摘要或修改时间不一致，未执行修复'));
    let destination = candidate.targetPath!;
    let root = candidate.targetRoot ?? roots.find((entry) => getRelativeAssetPath(destination, entry) !== undefined);
    let source: AssetIndexRecord['source'] = 'folder';
    let projectId: string | undefined;
    if (current.source === 'project') {
      projectId = current.projectId;
      root = projectId ? await guarded(() => getProjectDataDir(projectId!), options) ?? undefined : undefined;
      source = 'project';
    } else if (current.source === 'global' || !root) { root = globalRoot ?? undefined; source = 'global'; }
    if (!root) throw new Error(t('素材目标目录不可用'));
    if (getRelativeAssetPath(destination, root) === undefined) {
      const directory = joinPath(root, `repair-${crypto.randomUUID()}`);
      await guarded(() => mkdir(directory, { recursive: true }), options);
      const copy = await guarded(() => copyAssetFileToFolder(destination, directory, { signal: options.signal }), options);
      destination = normalize(copy.path);
      const copied = await guarded(() => fingerprintAssetImage(destination, options.signal), options);
      if (copied.digest !== candidate.digest) throw new Error(t('复制后的内容不一致，未更新引用'));
    }
    const relativePath = getRelativeAssetPath(destination, root);
    if (!relativePath) throw new Error(t('素材目标位置无效'));
    const info = await guarded(() => stat(destination), options);
    const assetUrl = await guarded(() => getAssetUrlFromPath(destination), options);
    if (!assetUrl) throw new Error(t('素材目标位置无效'));
    moves.push({ oldPath: normalize(candidate.index.path), newPath: destination, assetUrl, relativePath, projectId: 'asset-repairs',
      assetMove: { assetId: candidate.index.assetId, rootPath: root, source, projectId, digest: candidate.digest!, totalBytes: info.size,
        mtimeMs: info.mtime?.getTime() ?? 0, repair: true } });
  }
  assertDramaAssetWriteCurrent(options);
  await persistAssetRepairBatch(moves, selected.map(({ index }) => index), options);
  // 事务成功后不因视图取消遗漏已持久化的修复。
  onCommitted(moves);
  notifyProjectDiskChanged();
  return moves.length;
}
