/**
 * dramaAssetTransferService — 编排项目与全局短剧资产包的导入导出。
 */
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { t } from '../i18n';
import type { DramaAsset, DramaAssetWriteOptions } from '../types/dramaAssets';
import { assertDramaAssetWriteCurrent, normalizeDramaAssetLibrary, normalizeDramaVisualAsset } from '../types/dramaAssets';
import { getAssetIndexById, putAssetIndex, deleteImportedAssetIndexes } from './indexedDbService';
import { getAssetUrlFromPath, getGlobalFilesDir, getProjectDataDir, isTauriEnv, joinPath, sanitizeFileName, stripVerbatimPrefix } from './fileService';
import { prepareGlobalCharacter } from './characterLibraryService';
import { expandCharacterWeaponDependencies, remapCharacterWeaponIds } from './characterWeapons';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import {
  buildDramaAssetTransferDocument, parseDramaAssetTransferDocument, remapImportedAssets,
  buildDramaAssetImportPreview, getDramaAssetTransferMediaIds, selectDramaAssetTransferDocument,
  DRAMA_ASSET_TRANSFER_LIMITS, type DramaAssetTransferMedia, type ImportedDramaAssetMedia,
  type DramaAssetIdentity, type DramaAssetImportPreview, type DramaAssetTransferDocument,
} from './dramaAssetTransferFormat';
import {
  cleanupDramaAssetTransferDirectory, copyImportedDramaAssetMedia, createDramaAssetArchiveWorkspace,
  createDramaAssetImportFolder, createGlobalDramaAssetImportFolder, guardedDramaAssetTransfer, packDramaAssetArchive, readImportedDramaAssetStat,
  retainDramaAssetTransferDirectory, stageDramaAssetArchiveMedia, unpackDramaAssetArchive,
  type DramaAssetArchiveWorkspace, type DramaAssetImportFolder,
} from './fs/dramaAssetArchive';

export const DRAMA_ASSET_ARCHIVE_EXTENSION = 'aicassets';
export type { DramaAssetIdentity, DramaAssetImportPreview } from './dramaAssetTransferFormat';
export interface DramaAssetTransferOptions extends DramaAssetWriteOptions {
  onProgress?: (text: string) => void;
  chooseAssets?: (preview: DramaAssetImportPreview, signal?: AbortSignal) => Promise<readonly DramaAssetIdentity[] | null>;
}
export interface DramaAssetTransferResult { assetCount: number; mediaCount: number; assets: DramaAssetIdentity[] }
export interface ExportProjectDramaAssetsInput {
  projectId: string;
  ownerId: string;
  projectName: string;
  /** 显式单资产导出名称；批量导出即使只有一张卡也使用项目名称。 */
  assetName?: string;
  assets: readonly DramaAsset[];
  /** 所选卡片所属作用域的完整快照，用于补齐角色绑定武器。 */
  allAssets?: readonly DramaAsset[];
  nodes: readonly Node<BaseNodeData>[];
}
export interface ImportProjectDramaAssetsInput {
  projectId: string;
  ownerId: string;
  existingAssets?: readonly DramaAsset[];
  commit: (assets: DramaAsset[]) => Promise<void>;
}
export interface ExportGlobalDramaAssetsInput {
  libraryName: string;
  assetName?: string;
  assets: readonly DramaAsset[];
  allAssets?: readonly DramaAsset[];
}
export interface ImportGlobalDramaAssetsInput {
  existingAssets?: readonly DramaAsset[];
  commit: (assets: DramaAsset[]) => Promise<void>;
}
export interface CopyGlobalDramaAssetsToProjectInput {
  ownerId: string;
  assets: readonly DramaAsset[];
  allAssets?: readonly DramaAsset[];
  commit: (assets: DramaAsset[]) => Promise<void>;
}

type ExportInput = { name: string; assetName?: string; assets: readonly DramaAsset[]; allAssets?: readonly DramaAsset[] } & (
  { scope: 'project'; ownerId: string; nodes: readonly Node<BaseNodeData>[] } | { scope: 'global' }
);
type ImportInput = { existingAssets?: readonly DramaAsset[]; commit: (assets: DramaAsset[]) => Promise<void> } & (
  { scope: 'project'; ownerId: string } | { scope: 'global' }
);

type MediaKind = DramaAssetTransferMedia['kind'];
interface MediaSource {
  url?: string; filePath?: string; assetId?: string; relativePath?: string; sourceNodeId?: string;
  requireIndex?: boolean;
}
const IMAGE_NODE_TYPES = new Set(['ai-image', 'source-image', 'ai-panorama', 'ai-storyboard', 'ai-animation']);
const AUDIO_NODE_TYPES = new Set(['ai-audio', 'source-audio']);
const pathKey = (value: string) => {
  const clean = stripVerbatimPrefix(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(clean) ? clean.toLowerCase() : clean;
};

class DramaAssetMediaError extends Error {}
class DramaAssetCommitError extends Error {}
const visibleName = (value: string) => [...value].map((character) => (
  character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character
)).join('').slice(0, 120);
function referenceLabel(asset: DramaAsset, index: number): string {
  const label = asset.kind !== 'character' ? asset.referenceImages?.[index]?.label : undefined;
  return label ? t('参考图「{name}」', { name: visibleName(label) }) : t('参考图 {index}', { index: index + 1 });
}
function mediaLabel(asset: DramaAsset, mediaId: string): string {
  const token = `aicasset-media:${mediaId}`;
  const referenceIndex = asset.referenceImages?.findIndex((reference) => reference.imageUrl === token) ?? -1;
  if (referenceIndex >= 0) return referenceLabel(asset, referenceIndex);
  if (asset.kind === 'character') {
    const voiceIndex = asset.voiceClips?.findIndex((clip) => clip.audioUrl === token) ?? -1;
    if (voiceIndex >= 0) return t('声音「{name}」', { name: visibleName(asset.voiceClips![voiceIndex].label || t('声音 {index}', { index: voiceIndex + 1 })) });
    for (const action of asset.actions ?? []) {
      const media = action.media?.find((item) => item.url === token);
      if (media) return t('动作「{action}」的素材「{name}」', { action: visibleName(action.name), name: visibleName(media.name) });
    }
  }
  return t('主图');
}
function importMediaError(document: DramaAssetTransferDocument, media: DramaAssetTransferMedia): Error {
  const asset = document.assets.find((item) => getDramaAssetTransferMediaIds(item).includes(media.id))!;
  return new DramaAssetMediaError(t('资产包中「{name}」的{item}校验失败，请重新导出后重试', {
    name: visibleName(asset.name), item: mediaLabel(asset, media.id),
  }));
}

function projectRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(t('创作资产媒体相对路径无效'));
  }
  return value;
}

function extensionFor(source: { filePath?: string; url?: string }, kind: MediaKind): string {
  const url = source.url ?? '';
  const mime = /^data:([^;,]+)/i.exec(url)?.[1]?.toLowerCase();
  const mimeExtensions: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/x-ms-wma': 'wma', 'video/quicktime': 'mov',
  };
  // 仅复制字节，不执行转码；真实来源有安全后缀时必须原样保留容器身份。
  const extension = /\.([a-z0-9]{1,8})$/i.exec(source.filePath ?? '')?.[1]?.toLowerCase()
    || /\.([a-z0-9]{1,8})$/i.exec(url.split(/[?#]/, 1)[0])?.[1]?.toLowerCase()
    || (mime ? mimeExtensions[mime] || mime.split('/')[1] : undefined);
  return extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : { image: 'png', audio: 'wav', video: 'mp4' }[kind];
}

function hasMedia(source: MediaSource): boolean {
  return !!(source.url || source.filePath || source.assetId || source.relativePath || source.sourceNodeId);
}

async function resolveMediaSource(
  source: MediaSource, kind: MediaKind, rootDirectory: string, nodes: ReadonlyMap<string, Node<BaseNodeData>>,
  scope: 'project' | 'global', options: DramaAssetTransferOptions,
): Promise<{ filePath?: string; url?: string }> {
  // 明确的全局身份只能由全局索引解析，不能借用同 ID 项目节点或旧展示地址。
  if (source.requireIndex) {
    const indexed = source.assetId
      ? await guardedDramaAssetTransfer(() => getAssetIndexById(source.assetId!), options) : undefined;
    if (indexed?.status === 'online' && indexed.source === 'global') return { filePath: indexed.path };
    throw new Error(t('创作资产媒体缺失，请先修复素材引用'));
  }
  const node = source.sourceNodeId ? nodes.get(source.sourceNodeId) : undefined;
  const nodeType = node?.type || node?.data.type;
  const nodeUrl = node && (kind === 'image' && nodeType && IMAGE_NODE_TYPES.has(nodeType)
    ? node.data.imageUrl || node.data.thumbnailUrl
    : kind === 'audio' && nodeType && AUDIO_NODE_TYPES.has(nodeType) ? node.data.audioUrl : undefined);
  if (nodeUrl) {
    const filePath = node?.data.filePath || localMediaUrlToPath(nodeUrl);
    if (filePath) return { filePath };
    return { url: nodeUrl };
  }
  if (source.assetId) {
    const indexed = await guardedDramaAssetTransfer(() => getAssetIndexById(source.assetId!), options);
    if (indexed?.status === 'online' && (scope !== 'global' || indexed.source === 'global')) return { filePath: indexed.path };
    if (scope === 'global' || indexed) throw new Error(t('创作资产媒体缺失，请先修复素材引用'));
  }
  if (source.filePath) return { filePath: source.filePath };
  if (source.relativePath) return { filePath: joinPath(rootDirectory, projectRelativePath(source.relativePath)) };
  const localPath = localMediaUrlToPath(source.url);
  if (localPath) return { filePath: localPath };
  if (source.url && /^(?:data:|blob:)/i.test(source.url)) return { url: source.url };
  if (source.url) {
    try {
      const url = new URL(source.url);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return { url: source.url };
    } catch { /* 只接受明确的媒体来源，不把损坏 URL 当作路径。 */ }
  }
  throw new Error(t('创作资产媒体缺失，请先修复素材引用'));
}

async function completeExportSelection(input: ExportInput, options: DramaAssetTransferOptions): Promise<ExportInput> {
  let all = input.allAssets ?? input.assets;
  const needsSource = !input.allAssets && input.assets.some((asset) => asset.kind === 'character'
    && asset.weaponIds?.some((weaponId) => !all.some((item) => item.kind === 'prop' && item.id === weaponId)));
  if (needsSource) {
    if (input.scope === 'global') {
      const { loadGlobalDramaAssetCards } = await import('./globalDramaAssetService');
      all = await guardedDramaAssetTransfer(loadGlobalDramaAssetCards, options);
    } else {
      const { getProjectById } = await import('./indexedDbService');
      const project = await guardedDramaAssetTransfer(() => getProjectById(input.ownerId), options);
      const library = normalizeDramaAssetLibrary(project?.dramaAssets);
      all = [...library.characters, ...library.scenes, ...library.props];
    }
    // 所选内容可能比持久化快照更新；只用源库补缺，不覆盖本次明确选择。
    all = [...new Map([...all, ...input.assets].map((asset) => [`${asset.kind}:${asset.id}`, asset])).values()];
  }
  assertDramaAssetWriteCurrent(options);
  const assets = expandCharacterWeaponDependencies(input.assets, all);
  if (!assets.length || assets.length > DRAMA_ASSET_TRANSFER_LIMITS.assets) throw new Error(t('没有可导出的资产或数量超过限制'));
  return { ...input, assets };
}

async function prepareExportAssets(input: ExportInput, workspace: DramaAssetArchiveWorkspace, options: DramaAssetTransferOptions) {
  const rootDirectory = await guardedDramaAssetTransfer(() => input.scope === 'global' ? getGlobalFilesDir() : getProjectDataDir(input.ownerId), options);
  if (!rootDirectory) throw new Error(input.scope === 'global' ? t('全局素材目录不可用') : t('项目素材目录不可用'));
  // 全局库只解析已持久化的媒体身份，不能借用当前画布中的同 ID 节点。
  const nodes = new Map(input.scope === 'project' ? input.nodes.map((node) => [node.id, node] as const) : []);
  const cache = new Map<string, { kind: MediaKind; token: string }>();
  const media: DramaAssetTransferMedia[] = [];
  let totalBytes = 0;
  const collect = async (source: MediaSource, kind: MediaKind, asset: DramaAsset, item: string): Promise<string> => {
    try {
      const resolved = await resolveMediaSource(source, kind, rootDirectory, nodes, input.scope, options);
      assertDramaAssetWriteCurrent(options);
      const key = resolved.filePath ? pathKey(resolved.filePath) : resolved.url!;
      const previous = cache.get(key);
      if (previous) {
        if (previous.kind !== kind) throw new Error(t('同一媒体存在不一致的用途类型'));
        return previous.token;
      }
      if (media.length >= DRAMA_ASSET_TRANSFER_LIMITS.media) throw new Error(t('创作资产媒体数量超过限制'));
      const id = `media-${crypto.randomUUID()}`;
      const copied = await stageDramaAssetArchiveMedia(workspace, resolved, id, extensionFor(resolved, kind), kind, options);
      assertDramaAssetWriteCurrent(options);
      totalBytes += copied.totalBytes;
      if (!copied.totalBytes || totalBytes > DRAMA_ASSET_TRANSFER_LIMITS.mediaBytes) throw new Error(t('创作资产媒体为空或超过包大小限制'));
      media.push({ id, kind, path: copied.relativePath, bytes: copied.totalBytes, sha256: copied.digest });
      const token = `aicasset-media:${id}`;
      cache.set(key, { kind, token });
      options.onProgress?.(t('正在收集媒体 {count}', { count: media.length }));
      return token;
    } catch {
      assertDramaAssetWriteCurrent(options);
      throw new DramaAssetMediaError(t('资产「{name}」的{item}无法导出，请修复素材后重试', { name: visibleName(asset.name), item }));
    }
  };
  const assets: DramaAsset[] = [];
  for (const sourceAsset of input.assets) {
    assertDramaAssetWriteCurrent(options);
    const asset = sourceAsset.kind === 'character' ? sourceAsset : normalizeDramaVisualAsset(sourceAsset);
    const runtime = asset as DramaAsset & { assetId?: string; relativePath?: string; filePath?: string };
    const topSource: MediaSource = { url: asset.imageUrl, filePath: runtime.filePath,
      assetId: asset.imageAssetId || runtime.assetId,
      relativePath: asset.imageAssetId ? asset.imageRelativePath : runtime.relativePath,
      sourceNodeId: asset.imageNodeId, requireIndex: !!asset.imageAssetId };
    if (asset.kind !== 'character') {
      const referenceImages = [];
      for (const [index, reference] of (asset.referenceImages ?? []).entries()) {
        referenceImages.push({ ...reference, imageUrl: await collect({ ...reference, url: reference.imageUrl,
          requireIndex: reference.assetSource === 'global' }, 'image', asset, referenceLabel(asset, index)) });
      }
      const primary = referenceImages.find((reference) => reference.id === asset.primaryReferenceImageId) ?? referenceImages[0];
      assets.push({ ...asset, referenceImages, imageUrl: primary?.imageUrl
        ?? (hasMedia(topSource) ? await collect(topSource, 'image', asset, t('主图')) : undefined) });
      continue;
    }
    const referenceImages = [];
    for (const [index, reference] of (asset.referenceImages ?? []).entries()) {
      referenceImages.push({ ...reference, imageUrl: await collect({ ...reference, url: reference.imageUrl }, 'image', asset, referenceLabel(asset, index)) });
    }
    const voiceClips = [];
    for (const [index, clip] of (asset.voiceClips ?? []).entries()) {
      voiceClips.push({ ...clip, audioUrl: await collect({ ...clip, url: clip.audioUrl }, 'audio', asset,
        t('声音「{name}」', { name: visibleName(clip.label || t('声音 {index}', { index: index + 1 })) })) });
    }
    const actions = [];
    for (const action of asset.actions ?? []) {
      const actionMedia = [];
      for (const item of action.media ?? []) actionMedia.push({ ...item, url: await collect(item, item.kind === 'video' ? 'video' : 'image', asset,
        t('动作「{action}」的素材「{name}」', { action: visibleName(action.name), name: visibleName(item.name) })) });
      actions.push({ ...action, media: actionMedia });
    }
    const primary = referenceImages.find((reference) => reference.id === asset.primaryReferenceImageId) ?? referenceImages[0];
    assets.push({ ...asset, referenceImages, voiceClips, actions,
      imageUrl: primary?.imageUrl ?? (hasMedia(topSource) ? await collect(topSource, 'image', asset, t('主图')) : undefined) });
  }
  // 项目库按类型管理卡片 ID，包格式使用全局唯一 ID；包内重建避免合法跨类同 ID 冲突。
  const rootIds = new Map(assets.map((asset) => [`${asset.kind}:${asset.id}`, crypto.randomUUID()]));
  return buildDramaAssetTransferDocument({ exportedAt: Date.now(), name: input.name,
    assets: assets.map((asset) => ({ ...remapCharacterWeaponIds(asset, rootIds), id: rootIds.get(`${asset.kind}:${asset.id}`)! })), media });
}

function cleanupProgress(options: DramaAssetTransferOptions, text: string) {
  try { options.onProgress?.(text); } catch { /* 清理通知不能覆盖原结果或已完成的提交。 */ }
}

function prepareGlobalImportedAsset(asset: DramaAsset): DramaAsset {
  if (asset.kind === 'character') {
    const referenceImages = [...(asset.referenceImages ?? [])];
    // 旧包可以只有顶层主图；显式继承 fresh 文件身份，不能让兼容归一化只补出 URL。
    if (asset.imageUrl && asset.assetId && !referenceImages.some((reference) => reference.assetId === asset.assetId)) {
      referenceImages.push({ id: crypto.randomUUID(), kind: referenceImages.length ? 'other' : 'primary',
        assetId: asset.assetId, relativePath: asset.relativePath, imageUrl: asset.imageUrl,
        prompt: '', createdAt: asset.createdAt, updatedAt: asset.updatedAt });
    }
    return prepareGlobalCharacter({ ...asset, referenceImages });
  }
  const global = { ...asset, imageAssetId: asset.assetId, imageRelativePath: asset.relativePath } as DramaAsset & { filePath?: string };
  delete global.assetId;
  delete global.relativePath;
  delete global.filePath;
  delete global.imageNodeId;
  return global;
}

async function cleanup(directory: string | undefined, options: DramaAssetTransferOptions) {
  if (!directory) return;
  await cleanupDramaAssetTransferDirectory(directory).catch(() => cleanupProgress(options, t('临时素材清理未完成')));
}

async function exportDramaAssets(input: ExportInput, options: DramaAssetTransferOptions): Promise<DramaAssetTransferResult | null> {
  assertDramaAssetWriteCurrent(options);
  if (!isTauriEnv()) throw new Error(t('创作资产包导出仅支持桌面应用'));
  input = await completeExportSelection(input, options);
  const outputPath = await guardedDramaAssetTransfer(() => save({ title: t('导出创作资产'),
    defaultPath: `${sanitizeFileName(input.assetName || input.name || t('创作资产'))}-${t('资产')}.${DRAMA_ASSET_ARCHIVE_EXTENSION}`,
    filters: [{ name: t('AI Canvas 创作资产包'), extensions: [DRAMA_ASSET_ARCHIVE_EXTENSION] }],
  }), options);
  if (!outputPath) return null;
  let workspace: DramaAssetArchiveWorkspace | undefined;
  try {
    workspace = await createDramaAssetArchiveWorkspace(options);
    assertDramaAssetWriteCurrent(options);
    const document = await prepareExportAssets(input, workspace, options);
    assertDramaAssetWriteCurrent(options);
    options.onProgress?.(t('正在打包创作资产'));
    const result = await guardedDramaAssetTransfer(() => packDramaAssetArchive(workspace!, outputPath, JSON.stringify(document)), options);
    if (result.assetCount !== document.media.length) throw new Error(t('资产包媒体集合不完整'));
    return { assetCount: document.assets.length, mediaCount: document.media.length,
      assets: input.assets.map(({ kind, id }) => ({ kind, id })) };
  } catch (error) {
    assertDramaAssetWriteCurrent(options);
    if (error instanceof DramaAssetMediaError) throw error;
    if (error instanceof Error && error.message.startsWith('创作资产包无效')) throw new Error(t('创作资产包无效，请检查文件后重试'), { cause: error });
    throw new Error(t('创作资产导出失败，请确认全部媒体可用'), { cause: error });
  } finally { await cleanup(workspace?.directory, options); }
}

/** File import and cross-scope copies share one indexed-media and accepted-save boundary. */
async function commitImportedDocument(
  document: DramaAssetTransferDocument, workspace: DramaAssetArchiveWorkspace, input: ImportInput,
  options: DramaAssetTransferOptions, verifiedSources: ReadonlyMap<string, string> = new Map(),
): Promise<DramaAssetTransferResult> {
  let folder: DramaAssetImportFolder | undefined;
  const indexes: Array<{ assetId: string; path: string }> = [];
  let commitAttempted = false;
  try {
    folder = await (input.scope === 'global' ? createGlobalDramaAssetImportFolder(options) : createDramaAssetImportFolder(input.ownerId, options));
    assertDramaAssetWriteCurrent(options);
    const mediaById = new Map<string, ImportedDramaAssetMedia>();
    for (const [index, media] of document.media.entries()) {
      options.onProgress?.(t('正在验证并复制媒体 {current}/{total}', { current: index + 1, total: document.media.length }));
      const sourcePath = verifiedSources.get(media.id) ?? joinPath(workspace.assetsDirectory, media.path);
      const copied = await copyImportedDramaAssetMedia(sourcePath, folder.directory, options).catch(() => {
        assertDramaAssetWriteCurrent(options);
        throw importMediaError(document, media);
      });
      assertDramaAssetWriteCurrent(options);
      if (copied.totalBytes !== media.bytes || copied.digest.toLowerCase() !== media.sha256) throw importMediaError(document, media);
      const path = stripVerbatimPrefix(copied.path).replace(/\\/g, '/');
      const prefix = `${pathKey(folder.directory)}/`;
      if (!pathKey(path).startsWith(prefix)) throw new Error(t('导入媒体位置无效'));
      const info = await readImportedDramaAssetStat(path, options).catch(() => {
        assertDramaAssetWriteCurrent(options);
        throw importMediaError(document, media);
      });
      assertDramaAssetWriteCurrent(options);
      if (info.size !== media.bytes) throw importMediaError(document, media);
      const relativePath = `${folder.relativeDirectory}/${path.split('/').pop()!}`;
      const assetId = crypto.randomUUID();
      indexes.push({ assetId, path });
      await guardedDramaAssetTransfer(() => putAssetIndex({ assetId, path, relativePath,
        rootPath: folder!.rootDirectory, ...(input.scope === 'project' ? { projectId: input.ownerId } : {}), source: input.scope,
        fingerprint: `${info.size}:${info.mtimeMs}`, size: info.size, mtimeMs: info.mtimeMs,
        status: 'online', updatedAt: Date.now() }), options);
      const url = await guardedDramaAssetTransfer(() => getAssetUrlFromPath(path), options);
      if (!url) throw importMediaError(document, media);
      mediaById.set(media.id, { assetId, relativePath, url });
    }
    const remapped = remapImportedAssets(document.assets, mediaById);
    const assets = input.scope === 'global' ? remapped.map(prepareGlobalImportedAsset) : remapped;
    options.onProgress?.(t('正在保存资产'));
    assertDramaAssetWriteCurrent(options);
    // An accepted save retains its files, even if the view closes while metadata is committing.
    commitAttempted = true;
    retainDramaAssetTransferDirectory(folder.directory);
    await input.commit(assets);
    return { assetCount: assets.length, mediaCount: document.media.length,
      assets: assets.map(({ kind, id }) => ({ kind, id })) };
  } catch (error) {
    if (commitAttempted) throw new DramaAssetCommitError(input.scope === 'global'
      ? t('创作资产保存失败，导入媒体已保留，请重新打开资产库检查')
      : t('创作资产保存失败，导入媒体已保留，请重新打开项目检查'), { cause: error });
    throw error;
  } finally {
    if (!commitAttempted) {
      let indexesCleaned = true;
      await deleteImportedAssetIndexes(indexes).catch(() => {
        indexesCleaned = false;
        cleanupProgress(options, t('导入索引清理未完成，媒体已保留'));
      });
      if (indexesCleaned) await cleanup(folder?.directory, options);
      else if (folder) retainDramaAssetTransferDirectory(folder.directory);
    }
  }
}

async function importDramaAssets(input: ImportInput, options: DramaAssetTransferOptions): Promise<DramaAssetTransferResult | null> {
  assertDramaAssetWriteCurrent(options);
  if (!isTauriEnv()) throw new Error(t('创作资产包导入仅支持桌面应用'));
  const archivePath = await guardedDramaAssetTransfer(() => open({ title: t('导入创作资产'), multiple: false,
    filters: [{ name: t('AI Canvas 创作资产包'), extensions: [DRAMA_ASSET_ARCHIVE_EXTENSION] }],
  }), options);
  if (!archivePath || typeof archivePath !== 'string') return null;
  let workspace: DramaAssetArchiveWorkspace | undefined;
  try {
    options.onProgress?.(t('正在读取创作资产包'));
    workspace = await createDramaAssetArchiveWorkspace(options);
    assertDramaAssetWriteCurrent(options);
    const unpacked = await guardedDramaAssetTransfer(() => unpackDramaAssetArchive(workspace!, archivePath), options);
    if (Object.keys(unpacked.texts).length !== 1 || typeof unpacked.texts['manifest.json'] !== 'string') throw new Error(t('资产包清单集合无效'));
    let document = parseDramaAssetTransferDocument(unpacked.texts['manifest.json']);
    if (!document.assets.length) throw new Error(t('资产包没有可导入的创作资产'));
    const declared = new Set(document.media.map((entry) => entry.path));
    const actual = new Set(unpacked.assetPaths);
    if (actual.size !== unpacked.assetPaths.length || actual.size !== declared.size
      || [...actual].some((path) => !declared.has(path))
      || unpacked.assetBytes !== document.media.reduce((total, entry) => total + entry.bytes, 0)) throw new Error(t('资产包媒体集合不完整'));
    const verifiedSources = new Map<string, string>();
    if (options.chooseAssets) {
      // The whole package remains checked, including media belonging to unchecked cards.
      // Existing bounded native copies avoid loading large videos into JavaScript memory.
      for (const [index, media] of document.media.entries()) {
        options.onProgress?.(t('正在校验资产包媒体 {current}/{total}', { current: index + 1, total: document.media.length }));
        try {
          const copied = await copyImportedDramaAssetMedia(joinPath(workspace.assetsDirectory, media.path), workspace.incomingDirectory, options);
          assertDramaAssetWriteCurrent(options);
          if (copied.totalBytes !== media.bytes || copied.digest.toLowerCase() !== media.sha256) throw importMediaError(document, media);
          verifiedSources.set(media.id, copied.path);
        } catch {
          assertDramaAssetWriteCurrent(options);
          throw importMediaError(document, media);
        }
      }
      options.onProgress?.(t('请选择要导入的创作资产'));
      const selection = await options.chooseAssets(buildDramaAssetImportPreview(document, input.existingAssets), options.signal);
      assertDramaAssetWriteCurrent(options);
      if (!selection?.length) return null;
      document = selectDramaAssetTransferDocument(document, selection);
    }
    return await commitImportedDocument(document, workspace, input, options, verifiedSources);
  } catch (error) {
    if (error instanceof DramaAssetCommitError) throw error;
    assertDramaAssetWriteCurrent(options);
    if (error instanceof DramaAssetMediaError) throw error;
    if (error instanceof Error && error.message.startsWith('创作资产包无效')) throw new Error(t('创作资产包无效，请检查文件后重试'), { cause: error });
    throw new Error(t('创作资产包导入失败，媒体不完整或无法复制'), { cause: error });
  } finally {
    await cleanup(workspace?.directory, options);
  }
}

type CopyProjectDramaAssetsToGlobalInput = {
  ownerId: string; assets: readonly DramaAsset[]; allAssets?: readonly DramaAsset[]; nodes: readonly Node<BaseNodeData>[];
  commit: (assets: DramaAsset[]) => Promise<void>;
};

async function copyDramaAssetsBetweenScopes(
  request: { from: 'global'; input: CopyGlobalDramaAssetsToProjectInput }
    | { from: 'project'; input: CopyProjectDramaAssetsToGlobalInput },
  options: DramaAssetTransferOptions,
): Promise<DramaAssetTransferResult> {
  const { input } = request;
  assertDramaAssetWriteCurrent(options);
  if (!isTauriEnv()) throw new Error(t('创作资产包导入仅支持桌面应用'));
  if (!input.assets.length || input.assets.length > DRAMA_ASSET_TRANSFER_LIMITS.assets) throw new Error(t('没有可导出的资产或数量超过限制'));
  let workspace: DramaAssetArchiveWorkspace | undefined;
  try {
    workspace = await createDramaAssetArchiveWorkspace(options);
    assertDramaAssetWriteCurrent(options);
    const source: ExportInput = request.from === 'global'
      ? { scope: 'global', name: t('全局创作资产'), assets: input.assets, allAssets: input.allAssets }
      : { scope: 'project', name: t('创作资产'), ownerId: input.ownerId,
        assets: input.assets, allAssets: input.allAssets, nodes: request.input.nodes };
    const selection = await completeExportSelection(source, options);
    const document = await prepareExportAssets(selection, workspace, options);
    assertDramaAssetWriteCurrent(options);
    const target: ImportInput = request.from === 'global'
      ? { scope: 'project', ownerId: input.ownerId, commit: input.commit }
      : { scope: 'global', commit: input.commit };
    return await commitImportedDocument(document, workspace, target, options);
  } catch (error) {
    if (error instanceof DramaAssetCommitError) throw error;
    assertDramaAssetWriteCurrent(options);
    if (error instanceof DramaAssetMediaError) throw error;
    throw new Error(t('复制失败，请重试'), { cause: error });
  } finally { await cleanup(workspace?.directory, options); }
}

/** Materialize global files into the target project before accepting the new cards. */
export function copyGlobalDramaAssetsToProject(
  input: CopyGlobalDramaAssetsToProjectInput, options: DramaAssetTransferOptions = {},
): Promise<DramaAssetTransferResult> {
  return copyDramaAssetsBetweenScopes({ from: 'global', input }, options);
}

/** The inverse copy uses the same atomic global import and independent media identities. */
export function copyProjectDramaAssetsToGlobal(
  input: CopyProjectDramaAssetsToGlobalInput, options: DramaAssetTransferOptions = {},
): Promise<DramaAssetTransferResult> {
  return copyDramaAssetsBetweenScopes({ from: 'project', input }, options);
}

export function exportProjectDramaAssets(input: ExportProjectDramaAssetsInput, options: DramaAssetTransferOptions = {}): Promise<DramaAssetTransferResult | null> {
  return exportDramaAssets({ scope: 'project', name: input.projectName, assetName: input.assetName,
    assets: input.assets, allAssets: input.allAssets, ownerId: input.ownerId, nodes: input.nodes }, options);
}

export function exportGlobalDramaAssets(input: ExportGlobalDramaAssetsInput, options: DramaAssetTransferOptions = {}): Promise<DramaAssetTransferResult | null> {
  return exportDramaAssets({ scope: 'global', name: input.libraryName, assetName: input.assetName, assets: input.assets,
    allAssets: input.allAssets }, options);
}

export function importProjectDramaAssets(input: ImportProjectDramaAssetsInput, options: DramaAssetTransferOptions = {}): Promise<DramaAssetTransferResult | null> {
  return importDramaAssets({ scope: 'project', ownerId: input.ownerId, existingAssets: input.existingAssets, commit: input.commit }, options);
}

export function importGlobalDramaAssets(input: ImportGlobalDramaAssetsInput, options: DramaAssetTransferOptions = {}): Promise<DramaAssetTransferResult | null> {
  return importDramaAssets({ scope: 'global', existingAssets: input.existingAssets, commit: input.commit }, options);
}
