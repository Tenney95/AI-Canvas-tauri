/**
 * storageService — IndexedDB-backed persistence wrappers for projects,
 * workflows, app config, user presets, and uploaded skills.
 */
import {
  saveProjectToDb,
  getAllProjects,
  getProjectById,
  deleteProjectFromDb,
  saveWorkflowToDb,
  getAllWorkflows,
  deleteWorkflowFromDb,
  saveConfigToDb,
  loadConfigFromDb,
  savePresetToDb,
  getAllPresets,
  deletePresetFromDb,
  saveSkillToDb,
  getAllSkills,
  deleteSkillFromDb,
  saveStyleToDb,
  getAllStyles,
  deleteStyleFromDb,
  saveToolbarLayoutsToDb,
  loadToolbarLayoutsFromDb,
  type WorkflowRecord,
  type PresetRecord,
  type SkillRecord,
  type CustomStyleRecord,
} from './indexedDbService';
import { exists, writeFile } from '@tauri-apps/plugin-fs';
import type { BaseNodeData, ProjectSettings, StoryboardCellOverride } from '../types';
import {
  buildNodeFileName,
  getAssetUrlFromPath,
  getProjectDataDir,
  joinPath,
  notifyProjectDiskChanged,
  resolveUniqueDestPath,
  stripVerbatimPrefix,
} from './fs/core';
import { walkDirectoryFiles } from './fs/assetLibrary';
import { identifyAsset, resolveIndexedAssetPath } from './fs/assetIndex';
import type { DramaAssetLibrary } from '../types/dramaAssets';
import { normalizeDramaAssetLibrary } from '../types/dramaAssets';
import { restoreConfigSecrets, stripConfigSecrets } from './providerSecretService';

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
] as const;

function isTransientMediaValue(value: unknown): value is string {
  return typeof value === 'string' && (/^data:(?:image|video|audio)\//i.test(value) || /^blob:/i.test(value));
}

function inlineMediaExtension(source: string, data: BaseNodeData): string {
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
  if (data.type === 'ai-video' || data.type === 'source-video') return '.mp4';
  if (data.type === 'ai-audio' || data.type === 'source-audio') return '.mp3';
  return '.png';
}

async function inlineMediaBytes(source: string): Promise<Uint8Array> {
  const match = /^data:[^,]*;base64,([\s\S]*)$/i.exec(source);
  if (match) {
    const binary = atob(match[1].replace(/\s/g, ''));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error(`读取已存储媒体失败：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** 将旧项目节点中的内嵌媒体迁移到项目目录，防止它再次写入 IndexedDB。 */
async function materializeInlineNodeMedia(
  data: BaseNodeData,
  projectDir: string,
): Promise<BaseNodeData> {
  const source = NODE_MEDIA_URL_KEYS
    .map((key) => data[key])
    .find(isTransientMediaValue);
  if (!source) return data;

  let filePath = data.filePath as string | undefined;
  if (!filePath && data.relativePath) {
    const relativeCandidate = joinPath(projectDir, data.relativePath);
    if (await exists(relativeCandidate).catch(() => false)) filePath = relativeCandidate;
  }
  if (!filePath || !filePath.replace(/\\/g, '/').toLowerCase().startsWith(`${projectDir.replace(/\\/g, '/').toLowerCase()}/`)) {
    const extension = inlineMediaExtension(source, data);
    const fallback = data.type === 'ai-video' ? 'generated-video' : 'generated-image';
    const fileName = buildNodeFileName(data.label, extension, fallback);
    filePath = await resolveUniqueDestPath(projectDir, fileName);
    await writeFile(filePath, await inlineMediaBytes(source));
    notifyProjectDiskChanged();
  }

  const assetUrl = await getAssetUrlFromPath(filePath);
  const migrated = { ...data, filePath } as BaseNodeData & Record<string, unknown>;
  for (const key of NODE_MEDIA_URL_KEYS) {
    const value = migrated[key];
    if (!isTransientMediaValue(value)) continue;
    // 同一份生成结果的重复字段统一指向本地文件；旧的独立临时缩略图无法恢复时直接清除。
    migrated[key] = value === source ? assetUrl : undefined;
  }
  return migrated;
}

async function serializeAssetReference<T extends AssetReferenceLike>(
  data: T,
  projectId: string,
  projectDir: string,
): Promise<T> {
  if (!data.filePath) return data;
  const normalizedPath = data.filePath.replace(/\\/g, '/');
  const normalizedDir = projectDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedPath.toLowerCase().startsWith(`${normalizedDir.toLowerCase()}/`)) return data;

  // ponytail: 文件仍停在记录的相对路径上时直接沿用旧身份，省掉每次自动保存对每个节点的
  // stat + 索引读写；代价是索引里的 size/mtime 不会被保存刷新（加载扫描和资产库列举会刷）。
  if (data.assetId && data.relativePath
    && normalizedPath.slice(normalizedDir.length + 1) === data.relativePath.replace(/\\/g, '/')) {
    const reused: T = { ...data };
    delete (reused as AssetReferenceLike).filePath;
    return reused;
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
  return serialized;
}

async function serializeProjectNodes(nodes: unknown, projectId: string): Promise<unknown> {
  if (!Array.isArray(nodes)) return nodes;
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return nodes;
  return Promise.all((nodes as PersistedNodeLike[]).map(async (node) => {
    if (!node.data) return node;
    let data = await materializeInlineNodeMedia(node.data, projectDir);
    data = await serializeAssetReference(data, projectId, projectDir);
    if (Array.isArray(data.storyboardOverrides)) {
      const storyboardOverrides = await Promise.all(data.storyboardOverrides.map(async (override) => (
        override ? serializeAssetReference(override as StoryboardCellOverride, projectId, projectDir) : null
      )));
      data = { ...data, storyboardOverrides };
    }
    return { ...node, data };
  }));
}

function projectNodesContainInlineMedia(nodes: unknown): boolean {
  return Array.isArray(nodes) && (nodes as PersistedNodeLike[]).some((node) => (
    node.data && NODE_MEDIA_URL_KEYS.some((key) => isTransientMediaValue(node.data?.[key]))
  ));
}

/** 从展示用的 asset URL 还原本地路径（convertFileSrc 的逆运算），非本地 URL 返回 undefined。 */
function assetUrlToPath(url: string | undefined): string | undefined {
  if (!url || !(url.includes('asset.localhost') || url.startsWith('asset://'))) return undefined;
  try {
    const { pathname } = new URL(url);
    const decoded = decodeURIComponent(pathname.replace(/^\//, ''));
    return decoded ? stripVerbatimPrefix(decoded) : undefined;
  } catch {
    return undefined;
  }
}

async function restoreAssetReference<T extends AssetReferenceLike>(
  data: T,
  projectId: string,
  projectDir: string,
): Promise<T> {
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
    if (candidate && await exists(candidate).catch(() => false)) {
      filePath = candidate;
      break;
    }
  }
  if (!filePath && data.assetId) {
    filePath = await resolveIndexedAssetPath(data.assetId).catch(() => null) ?? undefined;
  }
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
  if ('imageUrl' in restored && restored.imageUrl) restored.imageUrl = await getAssetUrlFromPath(filePath);
  if ('videoUrl' in restored && restored.videoUrl) restored.videoUrl = await getAssetUrlFromPath(filePath);
  if ('audioUrl' in restored && restored.audioUrl) restored.audioUrl = await getAssetUrlFromPath(filePath);
  if ('url' in restored) restored.url = await getAssetUrlFromPath(filePath);
  return restored;
}

async function restoreAssetReferenceSafely<T extends AssetReferenceLike>(
  data: T,
  projectId: string,
  projectDir: string,
): Promise<T> {
  try {
    return await restoreAssetReference(data, projectId, projectDir);
  } catch {
    console.warn('[项目加载] 单个资产展示信息恢复失败，已保留节点', {
      projectId,
      assetId: data.assetId,
    });
    return data;
  }
}

async function refreshProjectAssetIndex(projectId: string, projectDir: string): Promise<void> {
  let diskFiles: Awaited<ReturnType<typeof walkDirectoryFiles>>;
  try {
    diskFiles = await walkDirectoryFiles(projectDir);
  } catch {
    console.warn('[项目加载] 资产目录扫描失败，已继续加载画布', { projectId });
    return;
  }

  const results = await Promise.allSettled(diskFiles.map((file) => identifyAsset(file.path, {
    rootPath: projectDir,
    projectId,
    source: 'project',
    size: file.size,
  })));
  const failedCount = results.filter((result) => result.status === 'rejected').length;
  if (failedCount > 0) {
    console.warn('[项目加载] 部分资产索引刷新失败，已继续加载画布', {
      projectId,
      failedCount,
    });
  }
}

/** 节点记录了资产身份却没解析出磁盘文件 —— 文件多半被外部改名/移动了。 */
function hasUnresolvedAsset(node: PersistedNodeLike): boolean {
  const overrides = Array.isArray(node.data?.storyboardOverrides) ? node.data.storyboardOverrides : [];
  return [node.data as AssetReferenceLike | undefined, ...overrides].some((reference) => (
    Boolean(reference && !reference.filePath && (reference.assetId || reference.relativePath))
  ));
}

async function restoreProjectNodes(nodes: unknown, projectId: string): Promise<unknown> {
  if (!Array.isArray(nodes)) return nodes;
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return nodes;

  const restoreNode = async (node: PersistedNodeLike) => {
    if (!node.data) return node;
    let data = await restoreAssetReferenceSafely(node.data, projectId, projectDir);
    if (Array.isArray(data.storyboardOverrides)) {
      const storyboardOverrides = await Promise.all(data.storyboardOverrides.map(async (override) => (
        override ? restoreAssetReferenceSafely(override, projectId, projectDir) : null
      )));
      data = { ...data, storyboardOverrides };
    }
    return { ...node, data };
  };

  const restored = await Promise.all((nodes as PersistedNodeLike[]).map(restoreNode));
  // ponytail: 节点全都就位就不扫目录了 —— 只有解析失败（外部重命名/移动）才刷新索引再试一轮，
  // 省掉每次切画布对整个项目目录的两轮 stat + 索引写。
  if (!restored.some(hasUnresolvedAsset)) return restored;
  await refreshProjectAssetIndex(projectId, projectDir);
  return Promise.all((nodes as PersistedNodeLike[]).map(restoreNode));
}

/** 角色库参考图与角色声音与画布节点共用本地文件，落库时同样只保留 assetId + relativePath */
async function serializeProjectDramaAssets(
  library: DramaAssetLibrary | undefined,
  projectId: string,
): Promise<DramaAssetLibrary | undefined> {
  if (!library?.characters.length) return library;
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return library;
  const characters = await Promise.all(library.characters.map(async (character) => ({
    ...character,
    referenceImages: await Promise.all((character.referenceImages ?? []).map((reference) =>
      serializeAssetReference(reference, projectId, projectDir))),
    voiceClips: await Promise.all((character.voiceClips ?? []).map((clip) =>
      serializeAssetReference(clip, projectId, projectDir))),
  })));
  return { ...library, characters };
}

async function restoreProjectDramaAssets(
  library: DramaAssetLibrary,
  projectId: string,
): Promise<DramaAssetLibrary> {
  if (!library.characters.length) return library;
  const projectDir = await getProjectDataDir(projectId);
  if (!projectDir) return library;
  const characters = await Promise.all(library.characters.map(async (character) => {
    const referenceImages = await Promise.all((character.referenceImages ?? []).map((reference) =>
      restoreAssetReferenceSafely(reference, projectId, projectDir)));
    const voiceClips = await Promise.all((character.voiceClips ?? []).map((clip) =>
      restoreAssetReferenceSafely(clip, projectId, projectDir)));
    const primaryReference = referenceImages.find(
      (reference) => reference.id === character.primaryReferenceImageId,
    ) ?? referenceImages[0];
    return {
      ...character,
      referenceImages,
      voiceClips,
      imageUrl: primaryReference?.imageUrl ?? character.imageUrl,
    };
  }));
  return { ...library, characters };
}

export interface ProjectSaveData {
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
  episodeCreative?: import('../types').EpisodeCreativeInfo;
  /** 剧集级原著与剧本；仅剧集项目有 */
  series?: import('../types').ProjectSeriesInfo;
}

/** 保存项目到 IndexedDB */
export async function saveProject(data: ProjectSaveData): Promise<string> {
  try {
    const payload: ProjectSaveData = {
      ...data,
      nodes: await serializeProjectNodes(data.nodes, data.id),
      dramaAssets: await serializeProjectDramaAssets(data.dramaAssets, data.id),
    };
    await saveProjectToDb(payload);
    console.log('Project saved to IndexedDB:', data.id);
    return data.id;
  } catch (error) {
    console.error('Save project to IndexedDB failed:', error);
    throw error;
  }
}

/** 从 IndexedDB 加载所有项目元数据 */
export async function loadProjectsList(): Promise<ProjectSaveData[]> {
  try {
    return await getAllProjects();
  } catch (error) {
    console.error('Load projects list failed:', error);
    throw error;
  }
}

/** 从 IndexedDB 加载单个项目完整数据 */
export async function loadProjectData(id: string): Promise<ProjectSaveData | null> {
  try {
    const record = await getProjectById(id);
    if (!record) return null;
    let nodes = record.nodes;
    if (projectNodesContainInlineMedia(nodes)) {
      try {
        nodes = await serializeProjectNodes(nodes, id);
        await saveProjectToDb({ ...record, nodes });
        console.log('[项目加载] 已将旧的内嵌媒体迁移到项目目录:', id);
      } catch (error) {
        console.warn('[项目加载] 内嵌媒体迁移失败，未覆盖原项目数据', { projectId: id, error });
      }
    }
    try {
      nodes = await restoreProjectNodes(nodes, id);
    } catch {
      console.warn('[项目加载] 资产恢复未完成，已使用原始画布数据', { projectId: id });
    }
    let dramaAssets = normalizeDramaAssetLibrary((record as ProjectSaveData).dramaAssets);
    try {
      dramaAssets = await restoreProjectDramaAssets(dramaAssets, id);
    } catch {
      console.warn('[项目加载] 角色库本地文件恢复未完成，已使用原始角色数据', { projectId: id });
    }
    return { ...record, nodes, dramaAssets } as ProjectSaveData;
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
    return [];
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
 * @returns 未能写入凭据存储、仅本次会话有效的连接 ID
 */
export async function saveConfig(data: unknown): Promise<string[]> {
  try {
    const { config, unstored } = await stripConfigSecrets(data);
    await saveConfigToDb(config);
    console.log('Config saved to IndexedDB');
    return unstored;
  } catch (error) {
    console.error('Save config failed:', error);
    throw error;
  }
}

export interface LoadedConfig {
  config: unknown | null;
  /** 引用存在但凭据存储里读不到的连接 ID，需要用户重新输入 */
  missingSecrets: string[];
}

/**
 * 从 IndexedDB 加载应用配置，并按引用从凭据存储补回凭据。
 * 遇到旧版明文配置会迁进凭据存储并立刻回写清理后的记录。
 */
export async function loadConfigWithSecrets(): Promise<LoadedConfig> {
  try {
    const raw = await loadConfigFromDb();
    if (raw === null || raw === undefined) return { config: null, missingSecrets: [] };

    const { config, migrated, missing } = await restoreConfigSecrets(raw);
    if (migrated) {
      // 明文已进凭据存储，立刻覆盖掉数据库里的旧记录
      const { config: scrubbed } = await stripConfigSecrets(config);
      await saveConfigToDb(scrubbed);
      console.log('[storage] 已将明文 API Key 迁移到凭据存储并清理数据库记录');
    }
    return { config, missingSecrets: missing };
  } catch (error) {
    console.error('Load config failed:', error);
    return { config: null, missingSecrets: [] };
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
    return await loadConfigFromDb();
  } catch (error) {
    console.error('Load config failed:', error);
    return null;
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
    return [];
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

export async function saveToolbarLayouts(data: Record<string, unknown>): Promise<void> {
  try {
    await saveToolbarLayoutsToDb(data);
  } catch (error) {
    console.error('Save toolbar layouts failed:', error);
    throw error;
  }
}

export async function loadToolbarLayouts(): Promise<Record<string, unknown> | null> {
  try {
    return await loadToolbarLayoutsFromDb();
  } catch (error) {
    console.error('Load toolbar layouts failed:', error);
    return null;
  }
}
