/**
 * storageService — IndexedDB-backed persistence wrappers for projects,
 * workflows, app config, user presets, and uploaded skills.
 */
import { isTauriAssetUrl, localMediaUrlToPath } from '../utils/mediaUrl';
import type { Node } from '@xyflow/react';
import {
  saveProjectToDb,
  getAllProjects,
  getProjectById,
  getAssetIndexById,
  deleteProjectFromDb,
  saveWorkflowToDb,
  getAllWorkflows,
  deleteWorkflowFromDb,
  saveConfigToDb,
  patchConfigToDb,
  loadConfigFromDb,
  savePresetToDb,
  getAllPresets,
  deletePresetFromDb,
  savePresetFolderToDb,
  loadPresetFoldersFromDb,
  deletePresetFolderFromDb,
  saveSkillToDb,
  getAllSkills,
  deleteSkillFromDb,
  saveStyleToDb,
  getAllStyles,
  deleteStyleFromDb,
  saveToolbarLayoutToDb,
  loadToolbarLayoutsFromDb,
  type WorkflowRecord,
  type PresetRecord,
  type SkillRecord,
  type CustomStyleRecord,
} from './indexedDbService';
import { exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { BaseNodeData, ProjectSettings, ProjectTextFileReference } from '../types';
import { normalizeProjectTextFileReference } from '../utils/manuscriptFileReference';
import {
  getAssetUrlFromPath,
  getProjectDataDir,
  getNativeProjectOwner,
  getMimeType,
  isTauriEnv,
  joinPath,
  notifyProjectDiskChanged,
  stripVerbatimPrefix,
} from './fs/core';
import { scanDirectoryFiles } from './fs/assetLibrary';
import { getRelativeAssetPath, identifyAsset, resolveIndexedAssetPath } from './fs/assetIndex';
import { createNativeMediaDisplayResolver, isNativeMediaResultArtifact, nativeMediaContentDigest, type NativeMediaDisplayResolver } from './nativeMediaDisplay';
import type { DramaAssetLibrary, DramaProp, DramaScene, DramaAssetReferenceImage } from '../types/dramaAssets';
import { normalizeDramaAssetLibrary, normalizeDramaVisualAsset, syncDramaVisualAssetPrimary } from '../types/dramaAssets';
import { normalizeEpisodeAssetRoster, type EpisodeAssetRoster } from '../types/episodeAssets';
import { deleteProviderSecretIfUnchanged, hasPlaintextSecret, readProviderSecretFingerprint, restoreConfigSecrets, stripConfigSecrets } from './providerSecretService';
import { enqueueConfigPersistence } from './configPersistenceQueue';
import { applyConfigPatch, ConfigConflictError, configValuesEqual, configWithoutSecrets, createConfigPatch, type ConfigChange } from './configPatch';
import { classifyStorageError, readStorageWithRetry, storageError } from './storageDiagnostics';
import { normalizeProjectSeriesInfo } from './indexedDb/projectSummary';
import {
  decodeDataUrlBytesAsync,
  MEDIA_DATA_URL_BYTE_LIMITS,
  sha256BytesHex,
} from './mediaDataUrl';

interface PersistedNodeLike {
  data?: BaseNodeData;
  [key: string]: unknown;
}

/**
 * 画布节点、宫格覆盖图、角色库参考图与角色声音共用同一套本地文件关联：
 * 运行期持有 filePath，落库时收敛为 assetId + relativePath，加载时再重建。
 */
interface AssetReferenceLike {
  filePath?: string;
  assetId?: string;
  relativePath?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  url?: string;
  label?: string;
  fileName?: string;
}

const NODE_MEDIA_URL_KEYS = [
  'imageUrl',
  'videoUrl',
  'audioUrl',
  'thumbnailUrl',
  'sourceUrl',
  'output',
  'mattingMask',
  'annotation',
] as const;

const ASSET_REFERENCE_URL_KEYS = ['imageUrl', 'videoUrl', 'audioUrl', 'url'] as const;
type AssetReferenceUrlKey = typeof ASSET_REFERENCE_URL_KEYS[number];
const NODE_PRIMARY_MEDIA_KEYS = new Set<string>(['imageUrl', 'videoUrl', 'audioUrl', 'output']);

interface MaterializedInlineMedia {
  filePath: string;
  assetUrl: string;
}

interface ProjectFileLookup {
  existsByPath: Map<string, Promise<boolean>>;
  nativeMediaDisplay?: Promise<{ defaultRootRef: string; resolve: NativeMediaDisplayResolver }>;
}

function nativeMediaDisplayContext(projectId: string, lookup: ProjectFileLookup): NonNullable<ProjectFileLookup['nativeMediaDisplay']> {
  lookup.nativeMediaDisplay ??= (async () => {
    const owner = getNativeProjectOwner(projectId);
    if (!owner) throw new Error('原媒体作品归属不可用');
    const { readNativeProjectSelection } = await import('./indexedDb/nativeProjectRepository');
    const selection = await readNativeProjectSelection(owner, projectId);
    if (!selection?.canvas || selection.canvas.id !== projectId || selection.project.id !== owner) throw new Error('原媒体画布归属不可用');
    return { defaultRootRef: selection.canvas.storageRootRef, resolve: createNativeMediaDisplayResolver(selection.project) };
  })();
  return lookup.nativeMediaDisplay;
}

interface MediaSerializationContext extends ProjectFileLookup {
  projectId: string;
  projectDir: string;
  cache: Map<string, Promise<MaterializedInlineMedia>>;
  directoryReady?: Promise<void>;
}

/** 只在当前项目的一次保存/加载内复用；不缓存授权，也不跨操作保留文件状态。 */
function projectFileLookupKey(path: string): string {
  const normalized = stripVerbatimPrefix(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** 新模型只保存平台无关的项目根内相对路径。 */
function nativePortablePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !/[\\:]/.test(path)
    && path.split('/').every((part) => !!part && part !== '.' && part !== '..'
      && !/[<>"|?*]/.test(part) && !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      && [...part].every((character) => character.charCodeAt(0) >= 32));
}

function projectFileExists(path: string, lookup: ProjectFileLookup): Promise<boolean> {
  const key = projectFileLookupKey(path);
  const existing = lookup.existsByPath.get(key);
  if (existing) return existing;
  const pending = exists(path);
  lookup.existsByPath.set(key, pending);
  return pending;
}

type InlineMediaKind = keyof typeof MEDIA_DATA_URL_BYTE_LIMITS;

function isTransientMediaValue(value: unknown): value is string {
  return typeof value === 'string' && (/^data:(?:image|video|audio)\//i.test(value) || /^blob:/i.test(value));
}

function inferInlineMediaKind(
  source: string,
  key: string,
  data: Record<string, unknown>,
): InlineMediaKind {
  if (/^data:image\//i.test(source)) return 'image';
  if (/^data:video\//i.test(source)) return 'video';
  if (/^data:audio\//i.test(source)) return 'audio';
  const hint = `${key} ${String(data.type ?? '')} ${String(data.kind ?? '')}`.toLowerCase();
  if (hint.includes('video')) return 'video';
  if (hint.includes('audio') || hint.includes('voice')) return 'audio';
  return 'image';
}

function inlineMediaExtension(source: string, kind: InlineMediaKind): string {
  const mime = /^data:([^;,]+)/i.exec(source)?.[1]?.toLowerCase();
  const byMime: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
  };
  if (mime && byMime[mime]) return byMime[mime];
  if (kind === 'video') return '.mp4';
  if (kind === 'audio') return '.mp3';
  return '.png';
}

async function inlineMediaBytes(source: string, kind: InlineMediaKind): Promise<Uint8Array> {
  if (/^data:/i.test(source)) {
    return decodeDataUrlBytesAsync(source, {
      maxBytes: MEDIA_DATA_URL_BYTE_LIMITS[kind],
      label: '项目内嵌媒体',
    });
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error(`读取已存储媒体失败：HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MEDIA_DATA_URL_BYTE_LIMITS[kind]) {
    throw new Error('项目内嵌媒体超过允许的内存迁移上限');
  }
  return bytes;
}

function inlineMediaPrefix(kind: InlineMediaKind): string {
  if (kind === 'video') return 'embedded-video';
  if (kind === 'audio') return 'embedded-audio';
  return 'embedded-image';
}

async function persistTransientMedia(
  source: string,
  context: MediaSerializationContext,
  kind: InlineMediaKind,
): Promise<MaterializedInlineMedia> {
  const cached = context.cache.get(source);
  if (cached) return cached;
  const pending = (async () => {
    const bytes = await inlineMediaBytes(source, kind);
    const digest = await sha256BytesHex(bytes);
    const owner = getNativeProjectOwner(context.projectId);
    if (owner) {
      const mimeType = getMimeType(inlineMediaExtension(source, kind).slice(1));
      const reference = await invoke<{ relativePath: string; sha256: string; bytes: number; mimeType: string }>(
        'write_native_project_media', { projectId: owner, mimeType, data: Array.from(bytes) },
      );
      if (reference.sha256 !== digest || reference.bytes !== bytes.byteLength || reference.mimeType !== mimeType
        || reference.relativePath !== `media/${digest}${inlineMediaExtension(source, kind)}`) {
        throw new Error('新项目素材写入回执不匹配');
      }
      const filePath = joinPath(context.projectDir, reference.relativePath);
      notifyProjectDiskChanged();
      return { filePath, assetUrl: await getAssetUrlFromPath(filePath) };
    }
    const fileName = `${inlineMediaPrefix(kind)}-${digest.slice(0, 20)}${inlineMediaExtension(source, kind)}`;
    const filePath = joinPath(context.projectDir, fileName);
    // 使用本次保存捕获的目录，等待初始化完成后再访问媒体文件。
    // 加载旧项目时的媒体迁移也经过这里，不能依赖 Store 后台创建目录。
    context.directoryReady ??= mkdir(context.projectDir, { recursive: true });
    await context.directoryReady;
    if (!await projectFileExists(filePath, context)) {
      await writeFile(filePath, bytes);
      context.existsByPath.set(projectFileLookupKey(filePath), Promise.resolve(true));
      notifyProjectDiskChanged();
    }
    return { filePath, assetUrl: await getAssetUrlFromPath(filePath) };
  })();
  context.cache.set(source, pending);
  try {
    return await pending;
  } catch (error) {
    context.cache.delete(source);
    throw error;
  }
}

async function materializeMediaFields<T extends Record<string, unknown>>(
  data: T,
  keys: readonly string[],
  context: MediaSerializationContext,
  primaryKeys: ReadonlySet<string> = new Set(),
): Promise<T> {
  let migrated: Record<string, unknown> | null = null;
  let primaryFilePath: string | undefined;
  for (const key of keys) {
    const value = (migrated ?? data)[key];
    if (!isTransientMediaValue(value)) continue;
    const persisted = await persistTransientMedia(
      value,
      context,
      inferInlineMediaKind(value, key, data),
    );
    if (!migrated) migrated = { ...data };
    migrated[key] = persisted.assetUrl;
    if (!primaryFilePath && primaryKeys.has(key)) primaryFilePath = persisted.filePath;
  }
  if (migrated && primaryFilePath) migrated.filePath = primaryFilePath;
  return (migrated ?? data) as T;
}

async function materializeAssetReference<T extends AssetReferenceLike>(
  data: T,
  context: MediaSerializationContext,
): Promise<T> {
  return materializeMediaFields(
    data as T & Record<string, unknown>,
    ASSET_REFERENCE_URL_KEYS,
    context,
    new Set(ASSET_REFERENCE_URL_KEYS),
  );
}

async function serializeAssetReference<T extends AssetReferenceLike>(
  data: T,
  context: MediaSerializationContext,
): Promise<T> {
  const { projectId, projectDir } = context;
  // 参考角色/参考帧的旧记录只有 URL；同样收敛为本地身份，避免目录变化后仍读取旧地址。
  let filePath = data.filePath ?? assetUrlToPath(data.imageUrl || data.videoUrl || data.audioUrl || data.url);
  if (!filePath) return data;
  let normalizedPath = stripVerbatimPrefix(filePath).replace(/\\/g, '/');
  const normalizedDir = stripVerbatimPrefix(projectDir).replace(/\\/g, '/').replace(/\/+$/, '');
  let projectRelativePath = getRelativeAssetPath(normalizedPath, normalizedDir);
  // POSIX 路径保留大小写；和资产索引共用归属判断，避免把另一个目录当成本项目。
  if (getNativeProjectOwner(projectId) && projectRelativePath && !nativePortablePath(projectRelativePath)) {
    throw new Error('项目素材路径无效');
  }
  if (!projectRelativePath) {
    if (!getNativeProjectOwner(projectId)) return data;
    // 外部选中的文件先复制入作品根，不能把原路径写进新模型或改变原资产索引。
    const copied = await (await import('./fileService')).copyFileToProjectData(filePath, projectId, { throwOnError: true, redactErrors: true });
    if (!copied) throw new Error('无法将外部素材复制到新项目');
    const updated = { ...data, filePath: copied.filePath, assetId: undefined, relativePath: undefined };
    for (const key of ASSET_REFERENCE_URL_KEYS) {
      const path = assetUrlToPath(updated[key]);
      if (path && projectFileLookupKey(path) === projectFileLookupKey(filePath)) (updated as AssetReferenceLike)[key] = copied.assetUrl;
    }
    const mediaFields = updated as unknown as Record<string, unknown>;
    for (const key of NODE_MEDIA_URL_KEYS) {
      const value = mediaFields[key];
      const path = typeof value === 'string' ? assetUrlToPath(value) : undefined;
      if (path && projectFileLookupKey(path) === projectFileLookupKey(filePath)) mediaFields[key] = copied.assetUrl;
    }
    data = updated;
    filePath = copied.filePath;
    normalizedPath = stripVerbatimPrefix(filePath).replace(/\\/g, '/');
    projectRelativePath = getRelativeAssetPath(normalizedPath, normalizedDir);
    if (!projectRelativePath || !nativePortablePath(projectRelativePath)) throw new Error('复制的素材不属于新项目');
  }
  if (!await projectFileExists(normalizedPath, context).catch(() => false)) return data;
  const stripNativeUrls = (value: T): T => {
    if (!getNativeProjectOwner(projectId)) return value;
    const result = { ...value };
    for (const key of ASSET_REFERENCE_URL_KEYS) {
      const url = result[key];
      const path = assetUrlToPath(url);
      if (path && projectFileLookupKey(path) === projectFileLookupKey(normalizedPath) && result.relativePath) {
        (result as AssetReferenceLike)[key] = result.relativePath;
      }
    }
    return result;
  };

  // ponytail: 文件仍停在记录的相对路径上时直接沿用旧身份，省掉每次自动保存对每个节点的
  // stat + 索引读写；代价是索引里的 size/mtime 不会被保存刷新（加载扫描和资产库列举会刷）。
  if (data.assetId && data.relativePath
    && projectRelativePath === data.relativePath.replace(/\\/g, '/')) {
    const reused: T = { ...data };
    delete (reused as AssetReferenceLike).filePath;
    return stripNativeUrls(reused);
  }

  // 文件可能已被外部删除/移动：identifyAsset 会 stat 失败抛错，
  // 不拦住的话整个项目保存都会失败（下次加载再按 assetId 重新识别）
  const identity = await identifyAsset(normalizedPath, {
    assetId: data.assetId,
    rootPath: normalizedDir,
    projectId,
    source: 'project',
  }).catch(() => null);
  if (!identity) return data;
  const serialized: T = { ...data, assetId: identity.assetId, relativePath: identity.relativePath };
  delete (serialized as AssetReferenceLike).filePath;
  return stripNativeUrls(serialized);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function assetReferenceContainsInlineMedia(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return ASSET_REFERENCE_URL_KEYS.some((key) => isTransientMediaValue(record[key]));
}

function nodeDataContainsInlineMedia(data: BaseNodeData | undefined): boolean {
  if (!data) return false;
  if (NODE_MEDIA_URL_KEYS.some((key) => isTransientMediaValue(data[key]))) return true;
  if ((data.storyboardOverrides ?? []).some(assetReferenceContainsInlineMedia)) return true;
  if ((data.shotlistRows ?? []).some((row) => assetReferenceContainsInlineMedia(row.frame)
    || assetReferenceContainsInlineMedia(row.video))) return true;
  if ((data.videoReferences ?? []).some(assetReferenceContainsInlineMedia)) return true;
  return Array.isArray(data.directorCaptureUrls) && data.directorCaptureUrls.some(isTransientMediaValue);
}

async function serializeProjectNodes(
  nodes: unknown,
  context: MediaSerializationContext,
): Promise<unknown> {
  if (!Array.isArray(nodes)) return nodes;
  const concurrency = projectNodesContainInlineMedia(nodes) ? 1 : 4;
  return mapWithConcurrency(nodes as PersistedNodeLike[], concurrency, async (node) => {
    if (!node.data) return node;
    let nodeData = node.data;
    const missingFields = nodeData.__nativeUnavailableMediaFields;
    if (getNativeProjectOwner(context.projectId) && typeof nodeData.relativePath === 'string'
      && Array.isArray(missingFields)) {
      nodeData = { ...nodeData };
      for (const key of NODE_MEDIA_URL_KEYS) {
        if (missingFields.includes(key) && !nodeData[key]) nodeData = { ...nodeData, [key]: nodeData.relativePath };
      }
      delete nodeData.__nativeUnavailableMediaFields;
    }
    let data = await materializeMediaFields(
      nodeData as BaseNodeData & Record<string, unknown>,
      NODE_MEDIA_URL_KEYS,
      context,
      NODE_PRIMARY_MEDIA_KEYS,
    );
    let nativeResultDirectory: string | undefined;
    if (getNativeProjectOwner(context.projectId) && isNativeMediaResultArtifact(data.artifactId) && nativeMediaContentDigest(data.relativePath)) {
      const display = await nativeMediaDisplayContext(context.projectId, context);
      if (data.storageRootRef !== undefined && typeof data.storageRootRef !== 'string') throw new Error('原媒体根身份无效');
      const directory = await display.resolve.directory(data.storageRootRef ?? display.defaultRootRef);
      const expected = joinPath(directory, data.relativePath!);
      const actual = data.filePath ?? assetUrlToPath(data.imageUrl || data.videoUrl || data.audioUrl);
      if (!actual || projectFileLookupKey(actual) === projectFileLookupKey(expected)) {
        // 精确根内原文件只收敛展示地址，不能按作品主根重算子根relativePath。
        nativeResultDirectory = directory; data = { ...data }; delete data.filePath;
      }
    }
    if (!nativeResultDirectory) data = await serializeAssetReference(data, context);
    if (getNativeProjectOwner(context.projectId) && data.relativePath) {
      const expectedPath = joinPath(nativeResultDirectory ?? context.projectDir, data.relativePath);
      for (const key of NODE_MEDIA_URL_KEYS) {
        const value = data[key];
        const path = typeof value === 'string' ? assetUrlToPath(value) : undefined;
        if (path && projectFileLookupKey(path) === projectFileLookupKey(expectedPath)) data = { ...data, [key]: data.relativePath };
      }
    }
    if (Array.isArray(data.storyboardOverrides)) {
      const storyboardOverrides = await mapWithConcurrency(data.storyboardOverrides, 4, async (override) => {
        if (!override) return null;
        const materialized = await materializeAssetReference(override, context);
        return serializeAssetReference(materialized, context);
      });
      data = { ...data, storyboardOverrides };
    }
    if (Array.isArray(data.shotlistRows)) {
      const shotlistRows = await mapWithConcurrency(data.shotlistRows, 4, async (row) => {
        if (!row.frame && !row.video) return row;
        const frame = row.frame
          ? await serializeAssetReference(await materializeAssetReference(row.frame, context), context)
          : row.frame;
        const video = row.video
          ? await serializeAssetReference(await materializeAssetReference(row.video, context), context)
          : row.video;
        return { ...row, frame, video };
      });
      data = { ...data, shotlistRows };
    }
    if (Array.isArray(data.videoReferences)) {
      const videoReferences = await mapWithConcurrency(data.videoReferences, 4, async (reference) => {
        const materialized = await materializeAssetReference(reference, context);
        return serializeAssetReference(materialized, context);
      });
      data = { ...data, videoReferences };
    }
    for (const field of ['runninghubOutputs', 'workflowApiOutputs'] as const) {
      const outputs = data[field];
      if (Array.isArray(outputs)) {
        data = { ...data, [field]: await mapWithConcurrency(outputs, 4, async (output) => (
          serializeAssetReference(await materializeAssetReference(output, context), context)
        )) };
      }
    }
    if (Array.isArray(data.directorCaptureUrls)) {
      const existingPaths = Array.isArray(data.directorCaptureFilePaths)
        ? data.directorCaptureFilePaths as string[]
        : [];
      const captures = await mapWithConcurrency(data.directorCaptureUrls, 2, async (url, index) => {
        if (!isTransientMediaValue(url)) return { url, filePath: existingPaths[index] };
        const persisted = await persistTransientMedia(url, context, 'image');
        return { url: persisted.assetUrl, filePath: persisted.filePath };
      });
      data = {
        ...data,
        directorCaptureUrls: captures.map((capture) => capture.url),
        directorCaptureFilePaths: captures.map((capture) => capture.filePath),
      };
      if (getNativeProjectOwner(context.projectId) && captures.some((capture) => capture.filePath)) {
        const relativePaths = await Promise.all(captures.map(async (capture) => {
          const relative = capture.filePath && getRelativeAssetPath(capture.filePath, context.projectDir);
          if (!relative || !await projectFileExists(capture.filePath!, context)) throw new Error('导演台素材不属于当前项目');
          return relative;
        }));
        data = { ...data, directorCaptureRelativePaths: relativePaths, directorCaptureFilePaths: undefined,
          directorCaptureUrls: relativePaths };
      }
    }
    return { ...node, data };
  });
}

function projectNodesContainInlineMedia(nodes: unknown): boolean {
  return Array.isArray(nodes)
    && (nodes as PersistedNodeLike[]).some((node) => nodeDataContainsInlineMedia(node.data));
}

function projectSettingsContainInlineMedia(settings: ProjectSettings | undefined): boolean {
  return assetReferenceContainsInlineMedia(settings?.visualStyle?.styleReference);
}

async function serializeProjectSettings(
  settings: ProjectSettings | undefined,
  context: MediaSerializationContext,
): Promise<ProjectSettings | undefined> {
  const reference = settings?.visualStyle?.styleReference;
  if (!settings?.visualStyle || !reference) return settings;
  const native = Boolean(getNativeProjectOwner(context.projectId));
  const missingPath = (reference as typeof reference & { __nativeMissingStylePath?: string }).__nativeMissingStylePath;
  if (native && missingPath && !reference.filePath && !reference.imageUrl) {
    if (!nativePortablePath(missingPath)) throw new Error('风格参考图路径无效');
    return { ...settings, visualStyle: { ...settings.visualStyle, styleReference: {
      filePath: missingPath, fileName: reference.fileName, enabled: reference.enabled,
    } } };
  }
  const relativePath = native && reference.filePath && !/^(?:[a-z]:[\\/]|[\\/])/i.test(reference.filePath)
    ? reference.filePath : undefined;
  if (relativePath && !nativePortablePath(relativePath)) throw new Error('风格参考图路径无效');
  const materialized = await materializeAssetReference(relativePath
    ? { ...reference, filePath: joinPath(context.projectDir, relativePath) } : reference, context);
  const styleReference = await serializeAssetReference(
    materialized,
    context,
  );
  if (native) {
    const serialized = styleReference as typeof styleReference & { relativePath?: string };
    const portable = serialized.relativePath ?? relativePath;
    if (reference.filePath && !portable) throw new Error('风格参考图未能保存到新项目');
    return { ...settings, visualStyle: { ...settings.visualStyle, styleReference: {
      ...(portable ? { filePath: portable, imageUrl: portable } : { imageUrl: serialized.imageUrl }),
      fileName: serialized.fileName, enabled: serialized.enabled,
    } } };
  }
  return {
    ...settings,
    visualStyle: { ...settings.visualStyle, styleReference },
  };
}

function dramaAssetsContainInlineMedia(library: DramaAssetLibrary | undefined): boolean {
  if (!library) return false;
  return library.characters.some((character) => (
    isTransientMediaValue(character.imageUrl)
    || (character.referenceImages ?? []).some(assetReferenceContainsInlineMedia)
    || (character.voiceClips ?? []).some(assetReferenceContainsInlineMedia)
    || (character.actions ?? []).some((action) => (
      (action.media ?? []).some(assetReferenceContainsInlineMedia)
    ))
  )) || [...library.scenes, ...library.props].some((asset) => isTransientMediaValue(asset.imageUrl)
    || (asset.referenceImages ?? []).some(assetReferenceContainsInlineMedia));
}

function projectRecordContainsInlineMedia(record: ProjectSaveData): boolean {
  return projectNodesContainInlineMedia(record.nodes)
    || projectSettingsContainInlineMedia(record.settings)
    || dramaAssetsContainInlineMedia(record.dramaAssets);
}

/** 从展示用的 asset URL 还原本地路径（convertFileSrc 的逆运算），非本地 URL 返回 undefined。 */
function assetUrlToPath(url: string | undefined): string | undefined {
  if (!isTauriAssetUrl(url)) return undefined;
  const path = localMediaUrlToPath(url);
  return path ? stripVerbatimPrefix(path) : undefined;
}

async function restoreAssetReference<T extends AssetReferenceLike>(
  data: T,
  projectId: string,
  projectDir: string,
  lookup: ProjectFileLookup,
  projection?: AssetReferenceUrlKey,
): Promise<T> {
  if (getNativeProjectOwner(projectId) && data.relativePath && !nativePortablePath(data.relativePath)) {
    throw new Error('项目素材路径无效');
  }
  const storedPath = data.filePath ? stripVerbatimPrefix(data.filePath) : undefined;
  const relativeCandidate = data.relativePath ? joinPath(projectDir, data.relativePath) : undefined;
  // 展示用的 URL 存的就是关掉项目那一刻正在显示的文件。0.8.13 之前重新生成不作废旧身份，
  // 那些记录里 relativePath 还停在上一张图上，只有它能把节点拉回最后一次的生成结果。
  const displayedPath = assetUrlToPath(data.imageUrl || data.videoUrl || data.audioUrl || data.url);
  // 保存成功的记录不会留 filePath；还留着说明上次保存没能收敛身份，此时 filePath 指的才是最后
  // 一次生成的文件，relativePath 还停在上一张图上。项目目录被移动/复制时 storedPath 不在本项目
  // 目录内，仍旧让 relativePath 先来。
  const asKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const insideProject = (path: string | undefined) => (
    Boolean(path && asKey(path).startsWith(`${asKey(projectDir)}/`))
  );
  const storedInsideProject = insideProject(storedPath);
  // 目录被移动/复制时，storedPath 与 displayedPath 指的都是原目录，只能让 relativePath 先来
  const candidates = storedInsideProject
    ? [storedPath, relativeCandidate]
    : insideProject(displayedPath)
      ? [displayedPath, relativeCandidate]
      : [relativeCandidate, storedPath];
  let filePath: string | undefined;
  for (const candidate of candidates) {
    if (candidate && await projectFileExists(candidate, lookup).catch(() => false)) {
      filePath = candidate;
      break;
    }
  }
  if (!filePath && data.assetId) {
    filePath = await resolveIndexedAssetPath(data.assetId).catch(() => null) ?? undefined;
  }
  // 新作品只能从已绑定作品根恢复普通素材；跨项目/全局身份由专门的来源逻辑处理。
  if (filePath && getNativeProjectOwner(projectId) && !insideProject(filePath)) return data;
  if (!filePath) return data;

  // ponytail: 文件就在记录的相对路径上 → 身份没变，跳过 stat 与索引读写（同 serializeAssetReference）
  const identity = data.assetId && data.relativePath && filePath === joinPath(projectDir, data.relativePath)
    ? { assetId: data.assetId, relativePath: data.relativePath }
    : await identifyAsset(filePath, {
      assetId: data.assetId,
      rootPath: projectDir,
      projectId,
      source: 'project',
    }).catch(() => null);
  if (!identity) {
    console.warn('[项目加载] 单个资产索引恢复失败，已保留节点', {
      projectId,
      assetId: data.assetId,
    });
  }
  const restored = {
    ...data,
    ...(identity ? { assetId: identity.assetId, relativePath: identity.relativePath } : {}),
    filePath,
  } as T;
  const previousDiskName = (data.relativePath ?? data.filePath)?.split(/[/\\]/).pop();
  const currentDiskName = filePath.split(/[/\\]/).pop();
  const previousLabel = restored.label;
  // 解析回的就是关项目时显示的那张 → 只是修好了记录，磁盘上没人改名，节点名不该跟着变
  const repairedToDisplayed = currentDiskName === displayedPath?.split(/[/\\]/).pop();
  if (
    previousLabel !== undefined && !repairedToDisplayed
    && previousDiskName && currentDiskName && previousDiskName !== currentDiskName
  ) {
    const previousFileName = restored.fileName;
    const stem = (name: string) => name.replace(/\.[^.]+$/, '');
    restored.fileName = currentDiskName;
    if (
      previousLabel === previousFileName
      || previousLabel === previousDiskName
      || stem(previousLabel) === stem(previousDiskName)
    ) {
      restored.label = currentDiskName;
    }
  }
  // 便携归档会去掉机器相关 URL；由调用方的明确媒体角色重建，不能依赖原字段仍存在。
  const urlKeys = ASSET_REFERENCE_URL_KEYS.filter((key) => key === projection
    || (key === 'url' ? key in restored : Boolean(restored[key])));
  if (urlKeys.length) {
    const url = await getAssetUrlFromPath(filePath);
    for (const key of urlKeys) (restored as AssetReferenceLike)[key] = url;
  }
  return restored;
}

async function restoreAssetReferenceSafely<T extends AssetReferenceLike>(
  data: T,
  projectId: string,
  projectDir: string,
  lookup: ProjectFileLookup,
  projection?: AssetReferenceUrlKey,
): Promise<T> {
  try {
    const restored = await restoreAssetReference(data, projectId, projectDir, lookup, projection);
    if (getNativeProjectOwner(projectId) && restored.relativePath && !restored.filePath) {
      // 仅隐藏无法解析的相对展示地址；保留素材身份，文件回来后可重新加载。
      const missing = { ...restored };
      for (const key of ASSET_REFERENCE_URL_KEYS) if (missing[key] === missing.relativePath) (missing as AssetReferenceLike)[key] = undefined;
      console.warn('[项目加载] 新项目素材不可用，已保留素材身份', { projectId, assetId: restored.assetId });
      return missing;
    }
    return restored;
  } catch {
    console.warn('[项目加载] 单个资产展示信息恢复失败，已保留节点', {
      projectId,
      assetId: data.assetId,
    });
    if (getNativeProjectOwner(projectId) && data.relativePath) {
      const missing = { ...data };
      for (const key of ASSET_REFERENCE_URL_KEYS) if (missing[key] === missing.relativePath) (missing as AssetReferenceLike)[key] = undefined;
      return missing;
    }
    return data;
  }
}

async function refreshProjectAssetIndex(projectId: string, projectDir: string): Promise<void> {
  let scan: Awaited<ReturnType<typeof scanDirectoryFiles>>;
  try {
    // 扫描器已用同一次 stat 的大小与修改时间登记身份，不再对整库逐个识别第二遍。
    scan = await scanDirectoryFiles(projectDir, { source: 'project', projectId, excludedRootDirectories: ['.thumbnail'] });
  } catch {
    console.warn('[项目加载] 资产目录扫描失败，已继续加载画布', { projectId });
    return;
  }

  if (!scan.complete) {
    console.warn('[项目加载] 资产索引扫描未完成，已继续加载画布', {
      projectId,
      failedFiles: scan.failedFiles,
      failedDirectories: scan.failedDirectories,
      truncated: scan.truncated,
    });
  }
}

/** 节点记录了资产身份却没解析出磁盘文件 —— 文件多半被外部改名/移动了。 */
function nodeAssetReferences(node: PersistedNodeLike): AssetReferenceLike[] {
  if (!node.data) return [];
  const overrides = Array.isArray(node.data.storyboardOverrides) ? node.data.storyboardOverrides : [];
  const shotBindings = Array.isArray(node.data.shotlistRows)
    ? node.data.shotlistRows.flatMap((row) => [row.frame, row.video]).filter(Boolean)
    : [];
  const videoReferences = Array.isArray(node.data.videoReferences) ? node.data.videoReferences : [];
  return [node.data, ...overrides, ...shotBindings, ...videoReferences] as AssetReferenceLike[];
}

/** 旧视频引用按同一素材 URL 补齐身份，不按角色当前主图或文件名替换已选素材。 */
async function recoverVideoReferenceIdentities(
  nodes: unknown,
  library?: DramaAssetLibrary,
  ownerId?: string,
): Promise<unknown> {
  if (!Array.isArray(nodes)) return nodes;
  const typedNodes = nodes as PersistedNodeLike[];
  const hasLegacyReference = typedNodes.some((node) => Array.isArray(node.data?.videoReferences)
    && node.data.videoReferences.some((reference) => {
      const existing = reference as typeof reference & AssetReferenceLike;
      return existing && !existing.assetId && !existing.relativePath
        && typeof existing.url === 'string' && isTauriAssetUrl(existing.url);
    }));
  if (!hasLegacyReference) return nodes;
  if (!library && ownerId) {
    try {
      const owner = await getProjectById(ownerId) as ProjectSaveData | undefined;
      library = owner?.dramaAssets;
    } catch {
      console.warn('[项目加载] 共享角色引用身份恢复失败，已保留原引用', { projectId: ownerId });
    }
  }
  const sources = typedNodes.flatMap(nodeAssetReferences);
  for (const character of library?.characters ?? []) {
    sources.push(character, ...(character.referenceImages ?? []), ...(character.voiceClips ?? []));
  }
  for (const asset of [...(library?.scenes ?? []), ...(library?.props ?? [])]) sources.push(asset, ...(asset.referenceImages ?? []));
  const identities = new Map<string, AssetReferenceLike>();
  for (const source of sources) {
    if (!source || (!source.assetId && !source.relativePath)) continue;
    for (const key of ASSET_REFERENCE_URL_KEYS) {
      const url = source[key];
      if (typeof url === 'string' && isTauriAssetUrl(url) && !identities.has(url.trim())) identities.set(url.trim(), source);
    }
  }
  return typedNodes.map((node) => {
    const originalReferences = node.data?.videoReferences;
    if (!Array.isArray(originalReferences) || !originalReferences.length) return node;
    const videoReferences = originalReferences.map((reference) => {
      const existing = reference as typeof reference & AssetReferenceLike;
      if (!existing || existing.assetId || existing.relativePath || typeof reference.url !== 'string') return reference;
      const source = identities.get(reference.url.trim());
      if (!source) return reference;
      return {
        ...reference,
        assetId: source.assetId,
        relativePath: source.relativePath,
        ...(source.filePath && !existing.filePath ? { filePath: source.filePath } : {}),
      };
    });
    return videoReferences.some((reference, index) => reference !== originalReferences[index])
      ? { ...node, data: { ...node.data, videoReferences } } : node;
  });
}

function hasUnresolvedAsset(node: PersistedNodeLike): boolean {
  return nodeAssetReferences(node).some((reference) => (
    Boolean(reference && !reference.filePath && (reference.assetId || reference.relativePath))
  ));
}

async function restoreProjectNodes(nodes: unknown, projectId: string, lookup: ProjectFileLookup, refreshIndex = true): Promise<unknown> {
  if (!Array.isArray(nodes)) return nodes;
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return nodes;

  const restoreNode = async (node: PersistedNodeLike) => {
    if (!node.data) return node;
    const type = node.type ?? node.data.type;
    const projection = ['ai-image', 'source-image', 'ai-animation', 'ai-panorama', 'ai-storyboard'].includes(String(type))
      ? 'imageUrl' : ['ai-video', 'source-video'].includes(String(type)) ? 'videoUrl'
        : ['ai-audio', 'source-audio'].includes(String(type)) ? 'audioUrl' : undefined;
    const owner = getNativeProjectOwner(projectId), digest = nativeMediaContentDigest(node.data.relativePath);
    let data: BaseNodeData;
    if (owner && digest && isNativeMediaResultArtifact(node.data.artifactId) && projection) {
      try {
        const display = await nativeMediaDisplayContext(projectId, lookup);
        if (node.data.storageRootRef !== undefined && typeof node.data.storageRootRef !== 'string') throw new Error('原媒体根身份无效');
        const rootRef = node.data.storageRootRef ?? display.defaultRootRef;
        const resolved = await display.resolve(rootRef, { relativePath: node.data.relativePath!, sha256: digest });
        data = { ...node.data, [projection]: resolved.url, output: resolved.url, sourceUrl: resolved.url,
          ...(projection !== 'audioUrl' ? { thumbnailUrl: resolved.url } : {}), filePath: resolved.filePath };
        delete data.__nativeUnavailableMediaFields;
      } catch {
        // 摘要文件缺失/根归属不符时只保留原身份；不能借索引或另一根的同名文件冒充。
        data = { ...node.data, [projection]: undefined, output: undefined, sourceUrl: undefined, thumbnailUrl: undefined,
          filePath: undefined, __nativeUnavailableMediaFields: [projection, 'output', 'sourceUrl', 'thumbnailUrl'] };
      }
    } else data = await restoreAssetReferenceSafely(node.data, projectId, projectDir, lookup, projection);
    if (getNativeProjectOwner(projectId) && data.relativePath && !data.filePath) {
      const missing = NODE_MEDIA_URL_KEYS.filter((key) => data[key] === data.relativePath);
      if (missing.length) {
        data = { ...data, __nativeUnavailableMediaFields: missing };
        for (const key of missing) data = { ...data, [key]: undefined };
      }
    }
    if (getNativeProjectOwner(projectId) && data.filePath && data.relativePath) {
      const url = await getAssetUrlFromPath(data.filePath);
      for (const key of NODE_MEDIA_URL_KEYS) {
        if (data[key] === data.relativePath) data = { ...data, [key]: url };
      }
    }
    if (Array.isArray(data.storyboardOverrides)) {
      const storyboardOverrides = await mapWithConcurrency(data.storyboardOverrides, 4, async (override) => (
        override ? restoreAssetReferenceSafely(override, projectId, projectDir, lookup, 'url') : null
      ));
      data = { ...data, storyboardOverrides };
    }
    if (Array.isArray(data.shotlistRows)) {
      const shotlistRows = await mapWithConcurrency(data.shotlistRows, 4, async (row) => ({
        ...row,
        frame: row.frame
          ? await restoreAssetReferenceSafely(row.frame, projectId, projectDir, lookup, 'url')
          : row.frame,
        video: row.video
          ? await restoreAssetReferenceSafely(row.video, projectId, projectDir, lookup, 'url')
          : row.video,
      }));
      data = { ...data, shotlistRows };
    }
    if (Array.isArray(data.videoReferences)) {
      const videoReferences = await mapWithConcurrency(data.videoReferences, 4, (reference) => (
        restoreAssetReferenceSafely(reference, projectId, projectDir, lookup, 'url')
      ));
      data = { ...data, videoReferences };
    }
    for (const field of ['runninghubOutputs', 'workflowApiOutputs'] as const) {
      const outputs = data[field];
      if (Array.isArray(outputs)) {
        data = { ...data, [field]: await mapWithConcurrency(outputs, 4, (output) => (
          restoreAssetReferenceSafely(output, projectId, projectDir, lookup, 'url')
        )) };
      }
    }
    if (Array.isArray(data.directorCaptureRelativePaths)) {
      const captures = await mapWithConcurrency(data.directorCaptureRelativePaths, 2, async (relativePath) => {
        const restored = await restoreAssetReferenceSafely({ relativePath } as AssetReferenceLike, projectId, projectDir, lookup);
        return { filePath: restored.filePath ?? '', url: restored.filePath ? await getAssetUrlFromPath(restored.filePath) : '' };
      });
      if (getNativeProjectOwner(projectId) && captures.some((capture) => !capture.filePath)) {
        console.warn('[项目加载] 部分导演台截图不可用，已保留素材身份', { projectId });
      }
      data = { ...data, directorCaptureFilePaths: captures.map((capture) => capture.filePath), directorCaptureUrls: captures.map((capture) => capture.url) };
    } else if (Array.isArray(data.directorCaptureUrls) && Array.isArray(data.directorCaptureFilePaths)) {
      const directorCaptureUrls = await mapWithConcurrency(
        data.directorCaptureUrls,
        2,
        async (url, index) => {
          const filePath = data.directorCaptureFilePaths?.[index];
          return filePath && await projectFileExists(filePath, lookup).catch(() => false)
            ? getAssetUrlFromPath(filePath)
            : url;
        },
      );
      data = { ...data, directorCaptureUrls };
    }
    return { ...node, data };
  };

  const restored = await mapWithConcurrency(nodes as PersistedNodeLike[], 4, restoreNode);
  // ponytail: 节点全都就位就不扫目录了 —— 只有解析失败（外部重命名/移动）才刷新索引再试一轮，
  // 省掉每次切画布对整个项目目录的两轮 stat + 索引写。
  if (!refreshIndex || !restored.some(hasUnresolvedAsset)) return restored;
  await refreshProjectAssetIndex(projectId, projectDir);
  // 恢复阶段可能重新找到文件，重试不能复用第一轮的缺失或权限失败结果。
  lookup.existsByPath.clear();
  return mapWithConcurrency(nodes as PersistedNodeLike[], 4, restoreNode);
}

/** 生成前只收敛本轮节点的媒体身份；不保存画布、不扫描整库，也不替换调用方的运行状态。 */
export async function normalizeProjectMediaNodes(projectId: string, nodes: Node<BaseNodeData>[]): Promise<Node<BaseNodeData>[]> {
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir || !getNativeProjectOwner(projectId)) throw new Error('当前项目的媒体目录不可用');
  const context: MediaSerializationContext = {
    projectId, projectDir, cache: new Map(), existsByPath: new Map(),
  };
  const serialized = await serializeProjectNodes(nodes, context);
  return await restoreProjectNodes(serialized, projectId, context, false) as Node<BaseNodeData>[];
}

async function restoreProjectSettings(
  settings: ProjectSettings | undefined,
  projectId: string,
  projectDir: string,
  lookup: ProjectFileLookup,
): Promise<ProjectSettings | undefined> {
  const reference = settings?.visualStyle?.styleReference;
  if (!settings?.visualStyle || !reference) return settings;
  if (getNativeProjectOwner(projectId) && reference.filePath
    && !/^(?:[a-z]:[\\/]|[\\/])/i.test(reference.filePath)) {
    const relativePath = reference.filePath;
    if (!nativePortablePath(relativePath)) throw new Error('风格参考图路径无效');
    const restored = await restoreAssetReferenceSafely<AssetReferenceLike>({ relativePath, imageUrl: reference.imageUrl }, projectId, projectDir, lookup, 'imageUrl');
    const styleReference = restored.filePath
      ? { filePath: restored.filePath, imageUrl: restored.imageUrl, fileName: reference.fileName, enabled: reference.enabled }
      : { __nativeMissingStylePath: relativePath, fileName: reference.fileName, enabled: reference.enabled };
    return { ...settings, visualStyle: { ...settings.visualStyle, styleReference } };
  }
  const styleReference = await restoreAssetReferenceSafely(reference, projectId, projectDir, lookup, 'imageUrl');
  return {
    ...settings,
    visualStyle: { ...settings.visualStyle, styleReference },
  };
}

/** 项目内复制的全局场景/道具只引用全局身份，不按项目目录重建索引或复制文件。 */
async function resolveVisualAssetReference(
  reference: DramaAssetReferenceImage, lookup: ProjectFileLookup,
  resolveProject: (reference: DramaAssetReferenceImage) => Promise<DramaAssetReferenceImage>,
  portable = false,
): Promise<DramaAssetReferenceImage> {
  const indexed = reference.assetId ? await getAssetIndexById(reference.assetId).catch(() => undefined) : undefined;
  if (reference.assetSource !== 'global' && indexed?.source !== 'global') return resolveProject(reference);
  const detached = { ...reference, assetSource: 'global' as const, sourceNodeId: undefined, filePath: undefined };
  if (portable) {
    if (reference.assetId) return { ...detached, imageUrl: undefined };
    if (!reference.filePath && !assetUrlToPath(reference.imageUrl)) throw new Error('全局素材缺少可恢复的身份');
    return resolveProject({ ...reference, assetSource: undefined });
  }
  return indexed?.source !== 'global' || indexed.status !== 'online'
    || !await projectFileExists(indexed.path, lookup).catch(() => false)
    ? { ...detached, imageUrl: undefined }
    : { ...detached, relativePath: indexed.relativePath, imageUrl: await getAssetUrlFromPath(indexed.path) };
}

/** 角色库参考图与角色声音与画布节点共用本地文件，落库时同样只保留 assetId + relativePath */
async function serializeProjectDramaAssets(
  library: DramaAssetLibrary | undefined,
  context: MediaSerializationContext,
): Promise<DramaAssetLibrary | undefined> {
  if (!library) return library;
  const serializeReference = async <T extends AssetReferenceLike>(reference: T): Promise<T> => {
    const materialized = await materializeAssetReference(reference, context);
    return serializeAssetReference(materialized, context);
  };
  const characters = await mapWithConcurrency(library.characters, 2, async (character) => {
    const topLevel = await serializeReference(character);
    const referenceImages = await mapWithConcurrency(
      character.referenceImages ?? [],
      2,
      serializeReference,
    );
    const voiceClips = await mapWithConcurrency(character.voiceClips ?? [], 2, serializeReference);
    const actions = await mapWithConcurrency(character.actions ?? [], 2, async (action) => ({
      ...action,
      media: await mapWithConcurrency(action.media ?? [], 2, serializeReference),
    }));
    const primaryReference = referenceImages.find(
      (reference) => reference.id === character.primaryReferenceImageId,
    ) ?? referenceImages[0];
    return {
      ...topLevel,
      referenceImages,
      voiceClips,
      actions,
      imageUrl: primaryReference?.imageUrl ?? topLevel.imageUrl,
    };
  });
  const serializeVisual = async <T extends DramaScene | DramaProp>(asset: T): Promise<T> => {
    const normalized = normalizeDramaVisualAsset(asset);
    const referenceImages = await mapWithConcurrency(normalized.referenceImages ?? [], 2,
      (reference) => resolveVisualAssetReference(reference, context, serializeReference, Boolean(getNativeProjectOwner(context.projectId))));
    return syncDramaVisualAssetPrimary({ ...normalized, referenceImages });
  };
  const scenes = await mapWithConcurrency(library.scenes, 2, (asset) => serializeVisual(asset));
  const props = await mapWithConcurrency(library.props, 2, (asset) => serializeVisual(asset));
  return { ...library, characters, scenes, props };
}

export async function serializeProjectRecord(data: ProjectSaveData): Promise<ProjectSaveData> {
  if (data.episodeScriptFile !== undefined) data = { ...data, episodeScriptFile: normalizeProjectTextFileReference(data.episodeScriptFile) };
  if (data.series !== undefined) {
    const series = normalizeProjectSeriesInfo(data.series);
    if (data.parentId && series?.storyGraph) throw new Error('故事关系图只能由所属剧集保存');
    data = { ...data, series };
  }
  if (data.episodeAssetRoster !== undefined) {
    data = { ...data, episodeAssetRoster: data.parentId ? normalizeEpisodeAssetRoster(data.episodeAssetRoster) : undefined };
  }
  const projectDir = await getProjectDataDir(data.id);
  if (!projectDir) {
    if (projectRecordContainsInlineMedia(data)) {
      throw new Error('当前环境没有项目目录，无法将内嵌媒体写入 IndexedDB');
    }
    return data;
  }
  const context: MediaSerializationContext = {
    projectId: data.id,
    projectDir,
    cache: new Map(),
    existsByPath: new Map(),
  };
  const referencedNodes = await recoverVideoReferenceIdentities(data.nodes, data.dramaAssets, data.parentId);
  const nodes = await serializeProjectNodes(referencedNodes, context);
  const settings = await serializeProjectSettings(data.settings, context);
  const dramaAssets = await serializeProjectDramaAssets(data.dramaAssets, context);
  return { ...data, nodes, settings, dramaAssets };
}

async function restoreProjectDramaAssets(
  library: DramaAssetLibrary,
  projectId: string,
  lookup: ProjectFileLookup,
): Promise<DramaAssetLibrary> {
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return library;
  const restoreReference = <T extends AssetReferenceLike>(reference: T, projection: AssetReferenceUrlKey): Promise<T> => (
    restoreAssetReferenceSafely(reference, projectId, projectDir, lookup, projection)
  );
  const characters = await mapWithConcurrency(library.characters, 2, async (character) => {
    const topLevel = await restoreReference(character, 'imageUrl');
    const referenceImages = await mapWithConcurrency(
      character.referenceImages ?? [],
      2,
      (reference) => restoreReference(reference, 'imageUrl'),
    );
    const voiceClips = await mapWithConcurrency(character.voiceClips ?? [], 2, (clip) => restoreReference(clip, 'audioUrl'));
    const actions = await mapWithConcurrency(character.actions ?? [], 2, async (action) => ({
      ...action,
      media: await mapWithConcurrency(action.media ?? [], 2, (media) => restoreReference(media, 'url')),
    }));
    const primaryReference = referenceImages.find(
      (reference) => reference.id === character.primaryReferenceImageId,
    ) ?? referenceImages[0];
    return {
      ...topLevel,
      referenceImages,
      voiceClips,
      actions,
      imageUrl: primaryReference?.imageUrl ?? topLevel.imageUrl,
    };
  });
  const restoreVisual = async <T extends DramaScene | DramaProp>(asset: T): Promise<T> => {
    const normalized = normalizeDramaVisualAsset(asset);
    const referenceImages = await mapWithConcurrency(normalized.referenceImages ?? [], 2,
      (reference) => resolveVisualAssetReference(reference, lookup, (image) => restoreReference(image, 'imageUrl')));
    return syncDramaVisualAssetPrimary({ ...normalized, referenceImages });
  };
  const scenes = await mapWithConcurrency(library.scenes, 2, (asset) => restoreVisual(asset));
  const props = await mapWithConcurrency(library.props, 2, (asset) => restoreVisual(asset));
  return { ...library, characters, scenes, props };
}

export interface ProjectSaveData {
  exchangeEpoch?: number;
  revisionScope?: 'project' | 'global';
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  snapshot?: string;
  nodes: unknown;
  edges: unknown;
  groups?: unknown;
  /** 本地媒体文件夹名（形如「项目名-短ID」），创建时确定后保持稳定 */
  dataFolder?: string;
  settings?: ProjectSettings;
  /** 短剧资产库（人物/场景/道具简介）；分集记录不存，统一挂在剧集项目上 */
  dramaAssets?: import('../types/dramaAssets').DramaAssetLibrary;
  /** 所属剧集项目 id；有值表示这条记录是一集 */
  parentId?: string;
  episodeNo?: number;
  episodeOutline?: string;
  episodeScript?: string;
  episodeScriptFile?: ProjectTextFileReference;
  episodeCreative?: import('../types').EpisodeCreativeInfo;
  episodeAssetRoster?: EpisodeAssetRoster;
  creationProfile?: import('../types/creationProfile').CreationProfileSelection;
  teamProfileOverride?: import('../types/agentTeam').AgentTeamProfile;
  /** 剧集级原著与剧本；仅剧集项目有 */
  series?: import('../types').ProjectSeriesInfo;
}

export type ProjectSummaryData = Omit<ProjectSaveData, 'nodes' | 'edges' | 'groups' | 'dramaAssets'>;

/** 保存项目到 IndexedDB */
export async function saveProject(data: ProjectSaveData): Promise<string> {
  try {
    const payload = await serializeProjectRecord(data);
    await saveProjectToDb(payload);
    console.log('Project saved to IndexedDB:', data.id);
    return data.id;
  } catch (error) {
    console.error('Save project to IndexedDB failed:', error);
    throw error;
  }
}

/** 从 IndexedDB 加载所有项目元数据 */
export async function loadProjectsList(): Promise<ProjectSummaryData[]> {
  try {
    return await getAllProjects();
  } catch (error) {
    console.error('Load projects list failed:', error);
    throw error;
  }
}

/** 将已读取的项目记录还原为运行时媒体引用；不读取或修改任何项目数据库。 */
export async function restoreProjectRecord(persistedRecord: ProjectSaveData): Promise<ProjectSaveData> {
    const id = persistedRecord.id;
    const lookup: ProjectFileLookup = { existsByPath: new Map() };
    let nodes = persistedRecord.nodes;
    try {
      nodes = await recoverVideoReferenceIdentities(nodes, persistedRecord.dramaAssets, persistedRecord.parentId);
      nodes = await restoreProjectNodes(nodes, id, lookup);
    } catch {
      console.warn('[项目加载] 资产恢复未完成，已使用原始画布数据', { projectId: id });
    }
    const projectDir = await getProjectDataDir(id);
    let settings = persistedRecord.settings;
    if (projectDir) {
      try {
        settings = await restoreProjectSettings(settings, id, projectDir, lookup);
      } catch {
        console.warn('[项目加载] 项目风格参考图恢复失败，已保留原始设置', { projectId: id });
      }
    }
    let dramaAssets = normalizeDramaAssetLibrary(persistedRecord.dramaAssets);
    try {
      dramaAssets = await restoreProjectDramaAssets(dramaAssets, id, lookup);
    } catch {
      console.warn('[项目加载] 角色库本地文件恢复未完成，已使用原始角色数据', { projectId: id });
    }
    return { ...persistedRecord, nodes, settings, dramaAssets, series: normalizeProjectSeriesInfo(persistedRecord.series),
      ...(persistedRecord.episodeScriptFile !== undefined ? { episodeScriptFile: normalizeProjectTextFileReference(persistedRecord.episodeScriptFile) } : {}),
      ...(persistedRecord.episodeAssetRoster !== undefined ? {
        episodeAssetRoster: persistedRecord.parentId ? normalizeEpisodeAssetRoster(persistedRecord.episodeAssetRoster) : undefined,
      } : {}),
    };
}

/** 从 IndexedDB 加载单个旧项目完整数据 */
export async function loadProjectData(id: string): Promise<ProjectSaveData | null> {
  try {
    const record = await getProjectById(id);
    if (!record) return null;
    let persistedRecord = record as ProjectSaveData;
    if (projectRecordContainsInlineMedia(persistedRecord)) {
      try {
        persistedRecord = await serializeProjectRecord(persistedRecord);
        await saveProjectToDb(persistedRecord);
        console.log('[项目加载] 已将旧的内嵌媒体迁移到项目目录:', id);
      } catch (error) {
        console.warn('[项目加载] 内嵌媒体迁移失败，未覆盖原项目数据', { projectId: id, error });
      }
    }
    return await restoreProjectRecord(persistedRecord);
  } catch (error) {
    console.error('Load project data failed:', error);
    return null;
  }
}

/** 从 IndexedDB 删除项目 */
export async function deleteProjectData(id: string): Promise<void> {
  try {
    await deleteProjectFromDb(id);
    console.log('Project deleted from IndexedDB:', id);
  } catch (error) {
    console.error('Delete project from IndexedDB failed:', error);
    throw error;
  }
}

export async function saveWorkflow(record: WorkflowRecord): Promise<void> {
  try {
    await saveWorkflowToDb(record);
    console.log('Workflow saved to IndexedDB:', record.id);
  } catch (error) {
    console.error('Save workflow failed:', error);
    throw error;
  }
}

export async function loadWorkflows(): Promise<WorkflowRecord[]> {
  try {
    return await getAllWorkflows();
  } catch (error) {
    console.error('Load workflows failed:', error);
    throw error;
  }
}

export async function deleteWorkflow(id: string): Promise<void> {
  try {
    await deleteWorkflowFromDb(id);
    console.log('Workflow deleted from IndexedDB:', id);
  } catch (error) {
    console.error('Delete workflow failed:', error);
    throw error;
  }
}

/**
 * 保存应用配置到 IndexedDB。
 * 凭据先摘进 Rust 侧凭据存储，数据库里只留引用；存储失败也不落明文。
 * 桌面凭据保存失败时拒绝整份配置回写，保留原数据库记录。
 * @returns 未能写入凭据存储、仅本次会话有效的连接 ID
 */
export interface ConfigSaveOptions {
  baseline: unknown;
  changes: ConfigChange[];
  /** 连接 ID → 本次凭据变更的随机版本，只在明确编辑凭据时提供。 */
  secretChanges?: Record<string, string>;
  onCommitted?: (config: unknown) => void;
}

export class ConfigCleanupError extends Error {
  constructor() { super('设置已保存，但旧渠道凭据清理失败，请重试'); this.name = 'ConfigCleanupError'; }
}

/**
 * 删除整条连接时，凭据版本可能刚被同一应用的另一保存任务推进。
 * 版本只用于防止旧 Key 回写，不属于用户可编辑配置；普通字段一致时以最新版本为删除基线。
 */
function rebaseDeletedProviderRevisions(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const baselineProviders = baseline.providers;
  const currentProviders = current.providers;
  const nextProviders = next.providers;
  if (!baselineProviders || typeof baselineProviders !== 'object' || Array.isArray(baselineProviders)
    || !currentProviders || typeof currentProviders !== 'object' || Array.isArray(currentProviders)
    || !nextProviders || typeof nextProviders !== 'object' || Array.isArray(nextProviders)) return baseline;

  let rebased: Record<string, unknown> | undefined;
  const providers = baselineProviders as Record<string, unknown>;
  for (const [id, originalProvider] of Object.entries(providers)) {
    if (id in nextProviders) continue;
    const currentProvider = (currentProviders as Record<string, unknown>)[id];
    if (!originalProvider || typeof originalProvider !== 'object' || Array.isArray(originalProvider)
      || !currentProvider || typeof currentProvider !== 'object' || Array.isArray(currentProvider)) continue;
    const { apiKeyRevision: _originalRevision, ...originalOrdinary } = originalProvider as Record<string, unknown>;
    const { apiKeyRevision: _currentRevision, ...currentOrdinary } = currentProvider as Record<string, unknown>;
    if (!configValuesEqual(originalOrdinary, currentOrdinary)) continue;
    rebased ??= structuredClone(baseline);
    (rebased.providers as Record<string, unknown>)[id] = structuredClone(currentProvider);
  }
  return rebased ?? baseline;
}

function configItemIdentity(item: unknown): string | null {
  if (typeof item === 'string') return `string:${item}`;
  if (typeof item === 'number' && Number.isFinite(item)) return `number:${item}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = Reflect.get(item, 'id');
  return typeof id === 'string' && id ? `id:${id}` : null;
}

function identifiedItems(value: unknown): Map<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const items = new Map<string, unknown>();
  for (const item of value) {
    const identity = configItemIdentity(item);
    if (identity === null || items.has(identity)) return null;
    items.set(identity, item);
  }
  return items;
}

function configValueAtPath(root: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = root;
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}

/**
 * 带稳定身份的配置列表允许合并纯删除：删除目标以调用时基线为准，
 * 同时发生的其他条目编辑和新增从最新持久化值保留。
 */
function rebaseIdentifiedArrayRemovals(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  changes: ConfigChange[],
): { baseline: Record<string, unknown>; next: Record<string, unknown> } {
  let rebasedBaseline = baseline;
  let rebasedNext = next;
  for (const change of changes) {
    const beforeItems = identifiedItems(change.before);
    const afterItems = identifiedItems(change.after);
    if (!beforeItems || !afterItems || beforeItems.size <= afterItems.size) continue;
    const beforeOrder = [...beforeItems.keys()];
    let previousIndex = -1;
    const pureRemoval = [...afterItems].every(([id, item]) => {
      const index = beforeOrder.indexOf(id);
      if (index <= previousIndex || !configValuesEqual(beforeItems.get(id), item)) return false;
      previousIndex = index;
      return true;
    });
    if (!pureRemoval) continue;
    const currentValue = configValueAtPath(current, change.path);
    const currentItems = identifiedItems(currentValue);
    if (!currentItems) continue;
    const removedIds = new Set([...beforeItems.keys()].filter((id) => !afterItems.has(id)));
    const merged = (currentValue as unknown[]).filter((item) => {
      const identity = configItemIdentity(item);
      return identity !== null && !removedIds.has(identity);
    });
    rebasedBaseline = applyConfigPatch(rebasedBaseline, [{
      path: change.path,
      before: configValueAtPath(rebasedBaseline, change.path),
      after: currentValue,
    }], false);
    rebasedNext = applyConfigPatch(rebasedNext, [{
      path: change.path,
      before: configValueAtPath(rebasedNext, change.path),
      after: merged,
    }], false);
  }
  return { baseline: rebasedBaseline, next: rebasedNext };
}

/** 与连接删除同事务持久化；仅含指纹，重启后仍可完成清理。必须在配置队列内调用。 */
async function completeSecretCleanup(raw: unknown): Promise<unknown> {
  const config = raw as { providers?: Record<string, unknown>; _pendingSecretCleanup?: Record<string, string> } | null;
  const pending = config?._pendingSecretCleanup;
  if (pending === undefined) return raw;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new ConfigCleanupError();
  let committed = raw;
  for (const [id, fingerprint] of Object.entries(pending)) {
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new ConfigCleanupError();
    try {
      // 已重新出现的连接不能作为旧删除任务清理；条件删除也不能删掉已换值的条目。
      if (!config?.providers?.[id]) await deleteProviderSecretIfUnchanged(id, fingerprint);
      committed = await patchConfigToDb([{ path: ['_pendingSecretCleanup', id], before: fingerprint, after: undefined }]);
    } catch (error) {
      if (classifyStorageError(error) === 'conflict') {
        // 原生值已变化，旧清理意图作废，保留新凭据。
        committed = await patchConfigToDb([{ path: ['_pendingSecretCleanup', id], before: fingerprint, after: undefined }]);
      } else { throw new ConfigCleanupError(); }
    }
  }
  return committed;
}

export async function saveConfig(data: unknown, options?: ConfigSaveOptions): Promise<string[]> {
  try {
    // 入队前捕获快照，异步凭据操作期间调用方修改对象不能改变本次保存内容。
    const snapshot: unknown = structuredClone(data);
    const intent = options ? structuredClone({ baseline: options.baseline, changes: options.changes, secretChanges: options.secretChanges }) : undefined;
    return await enqueueConfigPersistence(async () => {
      // 先读已保存记录，确认既有引用；读取失败时不触碰任何凭据。
      const previous = await completeSecretCleanup(await readStorageWithRetry('config-read', loadConfigFromDb));
      if (intent) {
        let baseline = configWithoutSecrets(intent.baseline);
        let next = applyConfigPatch(baseline, intent.changes, false);
        const sourceProviders = (snapshot as { providers?: Record<string, Record<string, unknown>> })?.providers ?? {};
        const providers = (next.providers ?? {}) as Record<string, Record<string, unknown>>;
        const changedProviders: Record<string, Record<string, unknown>> = {};
        for (const [id, revision] of Object.entries(intent.secretChanges ?? {})) {
          const provider = sourceProviders[id];
          if (!provider || typeof provider.apiKey !== 'string' || !provider.apiKey) continue;
          providers[id] = { ...providers[id], apiKeyRevision: revision };
          changedProviders[id] = provider;
        }
        if (next.providers || Object.keys(changedProviders).length) next.providers = providers;
        const current = configWithoutSecrets(previous);
        ({ baseline, next } = rebaseIdentifiedArrayRemovals(
          baseline,
          current,
          next,
          intent.changes,
        ));
        baseline = rebaseDeletedProviderRevisions(baseline, current, next);
        // 先检查普通字段与凭据版本冲突，拒绝后不触碰原生凭据。
        applyConfigPatch(current, createConfigPatch(baseline, next));
        const deleted = Object.keys((baseline.providers ?? {}) as Record<string, unknown>).filter((id) => !providers[id]);
        const cleanup: Record<string, string> = {};
        for (const id of deleted) {
          const fingerprint = await readProviderSecretFingerprint(id);
          if (fingerprint) cleanup[id] = fingerprint;
        }
        if (Object.keys(cleanup).length) next._pendingSecretCleanup = cleanup;
        let unstored: string[] = [];
        if (Object.keys(changedProviders).length) {
          const result = await stripConfigSecrets({ providers: changedProviders }, previous);
          unstored = result.unstored;
          if (result.failedExistingSecrets.length || (isTauriEnv() && unstored.length)) throw new Error('渠道凭据保存未完成');
          const storedProviders = (result.config as { providers: Record<string, Record<string, unknown>> }).providers;
          for (const [id, provider] of Object.entries(storedProviders)) {
            if (provider.apiKeyRef) providers[id].apiKeyRef = provider.apiKeyRef;
          }
          next = configWithoutSecrets(next);
        }
        const committed = await patchConfigToDb(createConfigPatch(baseline, next));
        options?.onCommitted?.(committed);
        const cleaned = await completeSecretCleanup(committed);
        options?.onCommitted?.(cleaned);
        return unstored;
      }
      const { config, unstored, failedExistingSecrets } = await stripConfigSecrets(snapshot, previous);
      if (failedExistingSecrets.length > 0) throw new Error('既有配置凭据保存未完成');
      // 桌面新渠道也必须确认 Key 已持久化，不能降级为重启后丢 Key 的会话配置。
      if (isTauriEnv() && unstored.length > 0) throw new Error('渠道凭据保存未完成');
      await saveConfigToDb(config);
      console.log('Config saved to IndexedDB');
      return unstored;
    });
  } catch (error) {
    if (error instanceof ConfigCleanupError) throw error;
    if (error instanceof ConfigConflictError || classifyStorageError(error) === 'conflict') throw new ConfigConflictError();
    console.error('[storage] 配置保存失败，未确认配置持久化');
    // eslint-disable-next-line preserve-caught-error -- 原始存储错误可能包含凭据或路径。
    throw new Error('保存应用配置失败，请重试或检查存储状态');
  }
}

export interface LoadedConfig {
  config: unknown | null;
  /** 引用存在但凭据存储里读不到的连接 ID，需要用户重新输入 */
  missingSecrets: string[];
  /** 只有凭据读取失败；普通配置已经读到，允许无关设置继续保存。 */
  unreadSecrets?: string[];
  persistedConfig?: unknown;
  cleanupPending?: boolean;
}

/** 保留版本不兼容分类供启动层提示，不传播存储路径或原始错误正文。 */
function configLoadError(error: unknown): Error {
  const failure = new Error('读取应用配置失败，请重试或检查存储状态');
  if (classifyStorageError(error) === 'version') failure.name = 'VersionError';
  console.error('[storage] 配置加载失败:', failure.name);
  return failure;
}

/**
 * 从 IndexedDB 加载应用配置，并按引用从凭据存储补回凭据。
 * 遇到旧版明文或丢失的凭据引用会恢复并立刻回写不含明文的记录。
 * 只有配置记录不存在才返回 null；读取或迁移失败必须阻止上层保存默认配置。
 */
export async function loadConfigWithSecrets(options?: {
  allowSecretReadFailure?: boolean;
  /** 旧模型到渠道的纯转换必须在凭据迁移和数据库清理之前执行。 */
  normalize?: (config: unknown) => unknown;
}): Promise<LoadedConfig> {
  try {
    return await enqueueConfigPersistence(async () => {
      const stored = await readStorageWithRetry('config-read', loadConfigFromDb);
      let raw = stored;
      let cleanupPending = false;
      try { raw = await completeSecretCleanup(stored); }
      catch (error) {
        if (!options?.allowSecretReadFailure || !(error instanceof ConfigCleanupError)) throw error;
        // 删除已提交但后续清理失败，不影响已有普通设置的读取；由 Store 提供重试状态。
        cleanupPending = true;
      }
      if (raw === null || raw === undefined) return { config: null, missingSecrets: [] };
      const normalized = options?.normalize ? options.normalize(structuredClone(raw)) : raw;
      const normalizationChanged = createConfigPatch(raw, normalized).length > 0;
      const legacyModels = (raw as { generalModels?: Array<{ apiKey?: unknown }> }).generalModels;
      const hasLegacyKey = Array.isArray(legacyModels) && legacyModels.some((model) => !!model?.apiKey);

      if (options?.allowSecretReadFailure && !hasPlaintextSecret(normalized)
        && !hasPlaintextSecret(raw) && !hasLegacyKey) {
        const config = structuredClone(normalized) as { providers?: Record<string, unknown> };
        const providers = config.providers ?? {};
        const unreadSecrets: string[] = [];
        const missingSecrets: string[] = [];
        for (const [id, provider] of Object.entries(providers)) {
          try {
            const restored = await restoreConfigSecrets({ providers: { [id]: provider } });
            providers[id] = (restored.config as { providers: Record<string, unknown> }).providers[id];
            missingSecrets.push(...restored.missing);
          } catch { unreadSecrets.push(id); }
        }
        let persistedConfig: unknown = raw;
        // 空 Key 等旧字段也必须从实际记录中移除，否则整条连接删除时，
        // 数据库对象与不含凭据的比较基线不同，会被误判为并发修改。
        const migrationChanges = createConfigPatch(raw, configWithoutSecrets(config));
        if (migrationChanges.length) {
          persistedConfig = await patchConfigToDb(migrationChanges);
        }
        return { config, persistedConfig, missingSecrets, unreadSecrets, ...(cleanupPending ? { cleanupPending } : {}) };
      }

      const { config, migrated, missing } = await restoreConfigSecrets(normalized);
      // 旧凭据全部迁移失败时不能开放保存，否则后续保存可能清掉尚未迁出的唯一副本。
      if (hasPlaintextSecret(normalized) && !migrated) throw new Error('配置凭据迁移未完成');
      if (migrated || normalizationChanged) {
        // 在同一持久化锁内确认凭据可用，再清理数据库中的旧明文。
        const { config: scrubbed, unstored } = await stripConfigSecrets(config, raw);
        if (unstored.length > 0) throw new Error('配置凭据迁移未完成');
        await saveConfigToDb(scrubbed);
        console.log('[storage] 已更新配置中的凭据引用并清理明文字段');
      }
      return { config, missingSecrets: missing,
        ...(cleanupPending ? { cleanupPending } : {}),
        ...(options?.allowSecretReadFailure ? { persistedConfig: configWithoutSecrets(config) } : {}) };
    });
  } catch (error) {
    throw configLoadError(error);
  }
}

/** 从 IndexedDB 加载应用配置（凭据已补回）。 */
export async function loadConfig(): Promise<unknown | null> {
  return (await loadConfigWithSecrets()).config;
}

/**
 * 只读取配置本体，不触碰凭据存储。
 * 供只关心主题、窗口尺寸这类非凭据字段的早期启动路径使用，省掉无谓的凭据读取。
 */
export async function loadConfigWithoutSecrets(): Promise<unknown | null> {
  try {
    const raw = await readStorageWithRetry('config-read', loadConfigFromDb);
    return raw == null ? null : configWithoutSecrets(raw);
  } catch (error) {
    throw configLoadError(error);
  }
}

export async function savePreset(record: PresetRecord): Promise<void> {
  try {
    await savePresetToDb(record);
    console.log('Preset saved to IndexedDB:', record.id);
  } catch (error) {
    console.error('Save preset failed:', error);
    throw error;
  }
}

export async function loadPresets(): Promise<PresetRecord[]> {
  try {
    return await getAllPresets();
  } catch (error) {
    console.error('Load presets failed:', error);
    throw error;
  }
}

export async function deletePreset(id: string): Promise<void> {
  try {
    await deletePresetFromDb(id);
    console.log('Preset deleted from IndexedDB:', id);
  } catch (error) {
    console.error('Delete preset failed:', error);
    throw error;
  }
}

export const savePresetFolder = savePresetFolderToDb;
export const loadPresetFolders = loadPresetFoldersFromDb;
export const deletePresetFolder = deletePresetFolderFromDb;

// ── Uploaded Skills ──

export async function saveSkill(record: SkillRecord): Promise<void> {
  try {
    await saveSkillToDb(record);
    console.log('Skill saved to IndexedDB:', record.id);
  } catch (error) {
    console.error('Save skill failed:', error);
    throw error;
  }
}

export async function loadSkills(): Promise<SkillRecord[]> {
  try {
    return await getAllSkills();
  } catch (error) {
    console.error('Load skills failed:', error);
    return [];
  }
}

export async function deleteSkill(id: string): Promise<void> {
  try {
    await deleteSkillFromDb(id);
    console.log('Skill deleted from IndexedDB:', id);
  } catch (error) {
    console.error('Delete skill failed:', error);
    throw error;
  }
}

// ── Custom Styles ──

export async function saveStyle(record: CustomStyleRecord): Promise<void> {
  try {
    await saveStyleToDb(record);
  } catch (error) {
    console.error('Save style failed:', error);
    throw error;
  }
}

export async function loadStyles(): Promise<CustomStyleRecord[]> {
  try {
    return await getAllStyles();
  } catch (error) {
    console.error('Load styles failed:', error);
    return [];
  }
}

export async function deleteStyle(id: string): Promise<void> {
  try {
    await deleteStyleFromDb(id);
  } catch (error) {
    console.error('Delete style failed:', error);
    throw error;
  }
}

export type { WorkflowRecord, PresetRecord, SkillRecord, CustomStyleRecord };

// ── Toolbar Layouts ──

export async function saveToolbarLayout(nodeType: string, layout: unknown | null, expected?: { baseline: unknown }): Promise<void> {
  try {
    await enqueueConfigPersistence(() => saveToolbarLayoutToDb(nodeType, layout, expected));
  } catch (error) {
    throw storageError('toolbar-write', error);
  }
}

export async function loadToolbarLayouts(): Promise<Record<string, unknown> | null> {
  return enqueueConfigPersistence(() => readStorageWithRetry('toolbar-read', loadToolbarLayoutsFromDb));
}
