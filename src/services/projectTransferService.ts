/**
 * 项目整体导出 / 导入。
 *
 * 导出把「项目与分集记录 + 对话 + 项目记忆 + 本地素材目录」打包成单个 `.aicanvas`
 * 归档（tar.gz）；导入以全新的项目 ID 与数据目录还原，因此同一台机器重复导入
 * 同一个包不会互相覆盖。
 *
 * 素材在项目记录里本就是 `relativePath` 相对项目目录保存的，归档内 `assets/`
 * 与项目目录一一对应，所以还原后无需重写路径；缺失的素材按现有加载策略保留节点。
 */
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { save } from '@tauri-apps/plugin-dialog';
import { remove } from '@tauri-apps/plugin-fs';
import * as fileService from './fileService';
import {
  deleteProjectFromDb,
  getAllProjects,
  getProjectById,
  getProjectChatForExport,
  putChatConversation,
  putChatMessage,
  putProjectMemory,
  type ChatConversationRecord,
  type ChatMessageRecord,
  type ProjectMemoryRecord,
} from './indexedDbService';
import { toProjectSummaryRecord, normalizeProjectSeriesInfo } from './indexedDb/projectSummary';
import type { ProjectSaveData } from './storageService';
import { normalizeProjectSettings } from './projectSettingsService';
import { normalizeDramaAssetLibrary } from '../types/dramaAssets';
import { normalizeEpisodeAssetRoster } from '../types/episodeAssets';
import { normalizeProjectTextFileReference } from '../utils/manuscriptFileReference';
import type { CanvasProject } from '../types';
import { serializeProjectArchiveEntries, type ProjectArchiveJsonEntry } from './projectArchiveSerialization';
import { portableArchiveChat, sanitizeLegacyArchiveProject, selectArchiveAssets, selectArchiveImportPaths } from './projectArchiveValidation';
import { configValuesEqual } from './configPatch';
import { remapStoryGraphBindings, type ArchiveAssetDigest } from './projectExchangeDomain';

export const PROJECT_ARCHIVE_EXTENSION = 'aicanvas';
/** 归档格式版本；解包时拒绝更高版本，避免旧版本误读新结构。 */
export const PROJECT_ARCHIVE_FORMAT_VERSION = 3;

const MANIFEST_ENTRY = 'manifest.json';
const PROJECT_ENTRY = 'project.json';
const CHAT_ENTRY = 'chat.json';
const EPISODES_ENTRY = 'episodes.json';
/** 单个会话读取上限；超出时中止导出，避免把截断记录声明为完整材料。 */
const MAX_MESSAGES_PER_CONVERSATION = 100_000;

export interface ProjectArchiveManifest {
  formatVersion: number;
  appVersion?: string;
  exportedAt: number;
  projectId: string;
  projectName: string;
  /** v2 必须声明；与 episodes.json 的记录数量一致。 */
  episodeCount?: number;
}

export interface ProjectArchiveChatPayload {
  conversations: ChatConversationRecord[];
  messages: ChatMessageRecord[];
  memories: ProjectMemoryRecord[];
}

export interface ProjectArchiveEpisode {
  project: ProjectSaveData;
  chat: ProjectArchiveChatPayload | null;
}

interface ArchiveChatIdentityMap {
  conversations: Map<string, string>;
  messages: Map<string, string>;
}

interface PackResult {
  assetCount: number;
  assetBytes: number;
  archiveBytes: number;
}

interface UnpackResult {
  texts: Record<string, string>;
  assetPaths: string[];
  assetBytes: number;
  assets: ArchiveAssetDigest[];
}

export interface ProjectExportResult {
  filePath: string;
  assetCount: number;
  archiveBytes: number;
  episodeCount: number;
}

export interface ProjectImportResult {
  projectId: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;
  dataFolder: string;
  settings?: ProjectSaveData['settings'];
  snapshot?: string;
  series?: ProjectSaveData['series'];
  /** 已恢复的分集摘要，不把完整画布放进 Store 项目列表。 */
  episodes: CanvasProject[];
  warnings: string[];
  assetCount: number;
  /** 项目记录里引用、但归档内没有对应文件的素材数量。 */
  missingAssetCount: number;
  conversationCount: number;
  memoryCount: number;
}

/** 与项目节点、角色参考图共用的素材引用形状。 */
interface AssetReferenceLike {
  assetId?: string;
  assetSource?: 'global';
  relativePath?: string;
  imageAssetId?: string;
  imageRelativePath?: string;
  filePath?: string;
  storyboardOverrides?: (AssetReferenceLike | null)[];
  directorScene?: AssetReferenceLike;
  directorPrevisScene?: AssetReferenceLike;
  directorResultManifest?: AssetReferenceLike;
}

interface PersistedNodeLike {
  data?: AssetReferenceLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 导入时为项目、会话、消息和记忆重新分配 ID，避免与本机已有记录冲突。 */
function createRecordId(): string {
  return crypto.randomUUID();
}

function parseJson<T>(raw: string | undefined, label: string): T {
  if (!raw) throw new Error(`项目归档缺少${label}`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`项目归档中的${label}已损坏`);
  }
}

function normalizeArchiveSettings(settings: ProjectSaveData['settings']): ProjectSaveData['settings'] {
  if (!isRecord(settings)) return undefined;
  const normalized = normalizeProjectSettings(settings);
  const reference = isRecord(settings.visualStyle) ? settings.visualStyle.styleReference : undefined;
  // 通用配置归一化处理展示字段；归档还需保留持久化的相对媒体身份。
  if (isRecord(reference) && typeof reference.relativePath === 'string') {
    normalized.visualStyle = {
      ...normalized.visualStyle,
      styleReference: { ...reference, ...normalized.visualStyle?.styleReference },
    };
  }
  return normalized;
}

/** 遍历画布、分镜、导演产物、风格母图与共享创作资产的素材引用。 */
function collectAssetReferences(record: ProjectSaveData): AssetReferenceLike[] {
  const references: AssetReferenceLike[] = [];
  const pushReference = (value: unknown) => {
    if (!isRecord(value)) return;
    references.push(value);
    if (Array.isArray(value.storyboardOverrides)) {
      value.storyboardOverrides.forEach((override) => {
        if (isRecord(override)) references.push(override);
      });
    }
    if (Array.isArray(value.shotlistRows)) {
      value.shotlistRows.forEach((row) => {
        if (!isRecord(row)) return;
        if (isRecord(row.frame)) references.push(row.frame);
        if (isRecord(row.video)) references.push(row.video);
      });
    }
    if (isRecord(value.directorScene)) references.push(value.directorScene);
    if (isRecord(value.directorPrevisScene)) references.push(value.directorPrevisScene);
    if (isRecord(value.directorResultManifest)) references.push(value.directorResultManifest);
  };

  if (Array.isArray(record.nodes)) {
    (record.nodes as PersistedNodeLike[]).forEach((node) => pushReference(node?.data));
  }
  pushReference(record.settings?.visualStyle?.styleReference);
  pushReference(record.series?.originalWork);
  pushReference(record.episodeScriptFile);
  record.dramaAssets?.characters?.forEach((character) => {
    pushReference(character);
    character.referenceImages?.forEach((reference) => pushReference(reference));
    character.voiceClips?.forEach((clip) => pushReference(clip));
    character.actions?.forEach((action) => action.media?.forEach(pushReference));
  });
  [...(record.dramaAssets?.scenes ?? []), ...(record.dramaAssets?.props ?? [])].forEach((asset) => {
    pushReference(asset);
    asset.referenceImages?.forEach(pushReference);
  });
  return references;
}

/**
 * 导入时清掉源机器的 assetId：assetId 是本机资产索引的主键，沿用会把源项目的
 * 索引条目指到导入副本上。素材靠 relativePath 定位，重新识别即可拿到新身份。
 */
function detachSourceAssetIdentity(record: ProjectSaveData): void {
  collectAssetReferences(record).forEach((reference) => {
    if (reference.relativePath || reference.imageRelativePath || reference.imageAssetId || reference.assetSource === 'global') {
      delete reference.assetId;
      delete reference.assetSource;
      delete reference.imageAssetId;
      delete reference.imageRelativePath;
    }
  });
}

async function collectChatPayload(projectId: string): Promise<ProjectArchiveChatPayload> {
  return portableArchiveChat(await getProjectChatForExport(projectId, MAX_MESSAGES_PER_CONVERSATION));
}

export function readArchiveProject(value: unknown, label: string): ProjectSaveData {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.name !== 'string' || !Array.isArray(value.nodes) || !Array.isArray(value.edges)
    || (value.groups !== undefined && !Array.isArray(value.groups))) {
    throw new Error(`项目归档中的${label}画布数据不完整`);
  }
  return {
    ...value,
    ...(value.series !== undefined ? { series: normalizeProjectSeriesInfo(value.series) } : {}),
    ...(value.episodeScriptFile !== undefined ? { episodeScriptFile: normalizeProjectTextFileReference(value.episodeScriptFile) } : {}),
    ...(value.episodeAssetRoster !== undefined ? {
      episodeAssetRoster: typeof value.parentId === 'string' && value.parentId
        ? normalizeEpisodeAssetRoster(value.episodeAssetRoster) : undefined,
    } : {}),
  } as unknown as ProjectSaveData;
}

export function readArchiveChat(value: unknown): ProjectArchiveChatPayload | null {
  if (value === null) return null;
  if (!isRecord(value) || !Array.isArray(value.conversations)
    || !Array.isArray(value.messages) || !Array.isArray(value.memories)) {
    throw new Error('项目归档中的对话记录已损坏');
  }
  return portableArchiveChat(value as unknown as ProjectArchiveChatPayload);
}

/** 先分配整部剧的对话身份，项目记忆可引用稍后恢复的分集对话。 */
function createChatIdentityMap(payloads: (ProjectArchiveChatPayload | null)[]): ArchiveChatIdentityMap {
  const identities: ArchiveChatIdentityMap = { conversations: new Map(), messages: new Map() };
  for (const payload of payloads) {
    if (!payload) continue;
    const localIds = new Set<string>();
    for (const conversation of payload.conversations) {
      if (!isRecord(conversation) || typeof conversation.id !== 'string' || !conversation.id) continue;
      if (identities.conversations.has(conversation.id)) throw new Error('项目包中的会话 ID 重复');
      localIds.add(conversation.id);
      identities.conversations.set(conversation.id, createRecordId());
    }
    for (const message of payload.messages) {
      if (!isRecord(message) || typeof message.id !== 'string' || !message.id
        || !localIds.has(message.conversationId)) continue;
      if (identities.messages.has(message.id)) throw new Error('项目包中的消息 ID 重复');
      identities.messages.set(message.id, createRecordId());
    }
  }
  return identities;
}

export function readArchiveEpisodes(
  raw: string | undefined,
  manifest: ProjectArchiveManifest,
  source: ProjectSaveData,
): ProjectArchiveEpisode[] {
  const values = raw ? parseJson<unknown>(raw, '分集记录') : [];
  if (!Array.isArray(values)
    || (manifest.formatVersion >= 2 && (!Number.isSafeInteger(manifest.episodeCount)
      || manifest.episodeCount !== values.length))
    || ((manifest.formatVersion >= 2 || values.length > 0) && source.parentId)) {
    throw new Error('项目包中的分集数量或归属不完整，请从原项目重新导出');
  }
  const ids = new Set([source.id]);
  return values.map((value: unknown) => {
    if (!isRecord(value)) throw new Error('项目包中的分集记录已损坏');
    const project = readArchiveProject(value.project, '分集记录');
    if (ids.has(project.id) || project.parentId !== source.id) {
      throw new Error('项目包中的分集 ID 重复或归属错误');
    }
    ids.add(project.id);
    return { project, chat: readArchiveChat(value.chat) };
  });
}

/** 分集入口也导出所属剧集，避免生成依赖源项目的孤立分集包。 */
async function getArchiveProject(projectId: string): Promise<ProjectSaveData> {
  const source = await getProjectById(projectId);
  if (!source) throw new Error('未找到项目数据，无法导出');
  const record = source.parentId ? await getProjectById(source.parentId) : source;
  if (!record || record.parentId) throw new Error('未找到所属剧集，无法导出');
  return readArchiveProject(record, '项目记录');
}

/** 把项目记录、对话与素材目录打包到指定归档路径；调用方保证项目已落盘。 */
async function packProjectArchive(
  projectId: string,
  outputPath: string,
): Promise<PackResult & { episodeCount: number }> {
  const projectRecord = await getArchiveProject(projectId);
  const chat = await collectChatPayload(projectRecord.id);
  const summaries = (await getAllProjects())
    .filter((project) => project.parentId === projectRecord.id)
    .sort((left, right) => (left.episodeNo ?? 0) - (right.episodeNo ?? 0));
  const episodes: ProjectArchiveEpisode[] = [];
  for (const summary of summaries) {
    const project = readArchiveProject(await getProjectById(summary.id), '分集记录');
    if (project.id !== summary.id || project.parentId !== projectRecord.id) {
      throw new Error('分集归属已变化，请重新导出');
    }
    episodes.push({ project, chat: await collectChatPayload(project.id) });
  }
  const manifest: ProjectArchiveManifest = {
    formatVersion: PROJECT_ARCHIVE_FORMAT_VERSION,
    appVersion: await getVersion().catch(() => undefined),
    exportedAt: Date.now(),
    projectId: projectRecord.id,
    projectName: projectRecord.name,
    episodeCount: episodes.length,
  };

  // 用 ensure 而不是 get：老项目可能还没建过数据目录，直接打包会卡在路径校验上。
  const assetsDir = await fileService.ensureProjectDataDir(projectRecord.id);
  if (!assetsDir) throw new Error('无法读取项目素材目录，已取消导出');
  const { prepareExchangeExport, readProjectArchiveContents } = await import('./projectImportService');
  const { loadProjectExchangeState, loadProjectExchangeGraph } = await import('./indexedDb/projectExchangeRepository');
  const previous = await loadProjectExchangeState(projectRecord.id);
  const previousGraph = previous ? await loadProjectExchangeGraph(previous.lineageId) : undefined;
  const previousHead = previousGraph?.revisions.find((revision) => revision.revisionId === previous?.headRevisionId)?.snapshot;
  const includeImportPaths = selectArchiveImportPaths([projectRecord, ...episodes.map((episode) => episode.project)], previous, previousHead, assetsDir);
  const assets = await invoke<import('./projectExchangeDomain').ArchiveAssetDigest[]>('inspect_project_archive_assets', { assetsDir, includeImportPaths });
  const exchange = await prepareExchangeExport([projectRecord, ...episodes.map((episode) => episode.project)], assets, assetsDir);
  const exchangeState = await loadProjectExchangeState(projectRecord.id);
  if (exchangeState?.headRevisionId !== exchange.headRevisionId) throw new Error('协作版本在导出准备期间变化，请重试');
  const { materializeExchangeSnapshot } = await import('./projectExchangeDomain');
  const head = exchange.revisions.find((revision) => revision.revisionId === exchange.headRevisionId)!;
  const portable = materializeExchangeSnapshot(head.snapshot, structuredClone(exchangeState.identities),
    [projectRecord, ...episodes.map((episode) => episode.project)], projectRecord.dataFolder ?? projectRecord.id,
    new Map(exchangeState.identities.filter((item) => item.kind === 'file').map((item) => [item.id, item.localId])), false);
  const values: ProjectArchiveJsonEntry[] = [
    { path: MANIFEST_ENTRY, value: manifest },
    { path: PROJECT_ENTRY, value: portable[0] },
    { path: CHAT_ENTRY, value: chat },
    { path: 'exchange.json', value: exchange },
    { path: 'exchange-state.json', value: exchangeState },
  ];
  if (episodes.length > 0) values.push({ path: EPISODES_ENTRY, value: episodes.map((episode) => ({ ...episode, project: portable.find((record) => record.id === episode.project.id)! })) });
  const entries = await serializeProjectArchiveEntries(values);
  const expectedAssets = selectArchiveAssets(head.snapshot, exchangeState, assets);
  try {
    await readProjectArchiveContents({ texts: Object.fromEntries(entries.map((entry) => [entry.path, entry.content])), assets: expectedAssets });
  } catch (error) {
    const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '归档内容校验失败';
    throw new Error(`项目导出前收件校验失败：${detail}`, { cause: error });
  }
  const result = await invoke<PackResult>('pack_project_archive', {
    entries,
    assetsDir,
    outputPath,
    expectedAssets,
  });
  return { ...result, episodeCount: episodes.length };
}

/**
 * 导出项目为 `.aicanvas` 归档。用户取消保存对话框时返回 null。
 * 调用方需保证项目已落盘，导出读取的是 IndexedDB 里的持久化记录。
 */
export async function exportProjectArchive(projectId: string): Promise<ProjectExportResult | null> {
  if (!fileService.isTauriEnv()) throw new Error('项目导出仅在桌面版可用');

  // 保存对话框只需要名字与归属；用户确认后再读取最新完整画布和对话。
  const summaries = await getAllProjects();
  const source = summaries.find((project) => project.id === projectId);
  const record = source?.parentId ? summaries.find((project) => project.id === source.parentId) : source;
  if (!record || record.parentId) throw new Error('未找到项目摘要，无法导出');

  const defaultName = `${fileService.sanitizeFileName(record.name || '项目')}.${PROJECT_ARCHIVE_EXTENSION}`;
  const outputPath = await save({
    defaultPath: defaultName,
    title: '导出项目',
    filters: [{ name: 'AI Canvas 项目包', extensions: [PROJECT_ARCHIVE_EXTENSION] }],
  });
  if (!outputPath) return null;

  const result = await packProjectArchive(projectId, outputPath);
  return {
    filePath: outputPath,
    assetCount: result.assetCount,
    archiveBytes: result.archiveBytes,
    episodeCount: result.episodeCount,
  };
}

/** 把归档里的对话与项目记忆重映射到新项目下写回 IndexedDB。 */
async function restoreChatPayload(
  payload: ProjectArchiveChatPayload | null,
  projectId: string,
  identities: ArchiveChatIdentityMap,
  projectIds: ReadonlyMap<string, string>,
): Promise<{ conversationCount: number; memoryCount: number }> {
  if (!payload) return { conversationCount: 0, memoryCount: 0 };

  const conversationIdMap = new Map<string, string>();
  const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
  for (const conversation of conversations) {
    if (!isRecord(conversation) || typeof conversation.id !== 'string' || !conversation.id) continue;
    const nextId = identities.conversations.get(conversation.id)!;
    conversationIdMap.set(conversation.id, nextId);
    let workbenchTarget: ChatConversationRecord['workbenchTarget'];
    if (conversation.workbenchTarget) {
      const seriesId = projectIds.get(conversation.workbenchTarget.seriesId);
      const episodeId = projectIds.get(conversation.workbenchTarget.episodeId);
      if (!seriesId || !episodeId || seriesId !== projectId || episodeId === seriesId) {
        throw new Error('工作台历史的目标分集未包含在导入项目中，无法恢复只读绑定');
      }
      workbenchTarget = { seriesId, episodeId };
    }
    await putChatConversation({ ...conversation, id: nextId, projectId, workbenchTarget });
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || typeof message.id !== 'string' || !message.id) continue;
    const nextConversationId = conversationIdMap.get(message.conversationId);
    if (!nextConversationId) continue;
    const nextId = identities.messages.get(message.id)!;
    // agentTaskId 指向未导出的运行时任务，保留会让时间线找不到任务。
    const { agentTaskId: _agentTaskId, ...rest } = message;
    await putChatMessage({ ...rest, id: nextId, projectId, conversationId: nextConversationId });
  }

  const memories = Array.isArray(payload.memories) ? payload.memories : [];
  let memoryCount = 0;
  for (const memory of memories) {
    if (!isRecord(memory) || !memory.id) continue;
    const sourceConversationId = memory.source?.conversationId;
    const nextConversationId = sourceConversationId
      ? identities.conversations.get(sourceConversationId)
      : undefined;
    await putProjectMemory({
      ...memory,
      id: createRecordId(),
      projectId,
      source: {
        ...memory.source,
        conversationId: nextConversationId ?? '',
        messageId: memory.source?.messageId ? identities.messages.get(memory.source.messageId) : undefined,
        taskId: undefined,
        // 来源会话没能一起导入时标记不可回溯，与删除会话后的处理保持一致。
        unavailable: nextConversationId ? memory.source?.unavailable : true,
      },
    });
    memoryCount += 1;
  }

  return { conversationCount: conversationIdMap.size, memoryCount };
}

/**
 * 从归档还原出一个全新项目。素材先解到临时数据目录，读到项目名后再改名为
 * 正式的「项目名-短ID」目录；overrideName 用于复制项目时另起名字。
 */
export async function restoreProjectArchive(
  archivePath: string,
  overrideName?: string,
  historyOptions: { appendChat: boolean; appendMemories: boolean; signal?: AbortSignal } = { appendChat: true, appendMemories: true },
  preview?: { manifest: ProjectArchiveManifest; records: ProjectSaveData[]; chat: Array<ProjectArchiveChatPayload | null>; assets: ArchiveAssetDigest[] },
): Promise<ProjectImportResult> {
  const projectId = createRecordId();
  const stagingFolder = fileService.buildProjectFolderName('导入中', projectId);
  fileService.registerProjectFolder(projectId, stagingFolder);

  let stagingCreated = false;
  const createdProjectIds: string[] = [];
  try {
    historyOptions.signal?.throwIfAborted();
    const stagingDir = await fileService.ensureProjectDataDir(projectId);
    if (!stagingDir) throw new Error('无法创建项目数据目录');
    stagingCreated = true;

    const unpacked = await invoke<UnpackResult>('unpack_project_archive', {
      archivePath,
      assetsDir: stagingDir,
    });

    const manifest = parseJson<ProjectArchiveManifest>(unpacked.texts[MANIFEST_ENTRY], '清单');
    if (!isRecord(manifest) || !Number.isSafeInteger(manifest.formatVersion) || manifest.formatVersion < 1) {
      throw new Error('项目归档中的清单版本无效');
    }
    if (manifest.formatVersion > PROJECT_ARCHIVE_FORMAT_VERSION) {
      throw new Error('项目包由更新版本导出，请先升级应用');
    }
    const source = sanitizeLegacyArchiveProject(readArchiveProject(parseJson<unknown>(unpacked.texts[PROJECT_ENTRY], '项目记录'), '项目记录'));
    if (manifest.projectId !== source.id) {
      throw new Error('项目归档中的项目 ID 与清单不一致');
    }
    const sourceEpisodes = readArchiveEpisodes(unpacked.texts[EPISODES_ENTRY], manifest, source)
      .map((episode) => ({ ...episode, project: sanitizeLegacyArchiveProject(episode.project) }));
    const chat = unpacked.texts[CHAT_ENTRY]
      ? readArchiveChat(parseJson<unknown>(unpacked.texts[CHAT_ENTRY], '对话记录'))
      : null;
    historyOptions.signal?.throwIfAborted();
    if (preview && (!configValuesEqual(manifest, preview.manifest)
      || !configValuesEqual([source, ...sourceEpisodes.map((episode) => episode.project)], preview.records.map(sanitizeLegacyArchiveProject))
      || !configValuesEqual([chat, ...sourceEpisodes.map((episode) => episode.chat)], preview.chat)
      || !Array.isArray(unpacked.assets) || !configValuesEqual([...unpacked.assets].sort((a, b) => a.path.localeCompare(b.path)), [...preview.assets].sort((a, b) => a.path.localeCompare(b.path))))) {
      throw new Error('项目包在预览后发生变化，请重新选择项目包');
    }
    const payloads = [chat, ...sourceEpisodes.map((episode) => episode.chat)].map((payload) => payload ? {
      conversations: historyOptions.appendChat ? payload.conversations : [],
      messages: historyOptions.appendChat ? payload.messages : [],
      memories: historyOptions.appendMemories ? payload.memories : [],
    } : null);
    const chatIdentities = createChatIdentityMap(payloads);

    const name = (overrideName || source.name || manifest.projectName || '导入项目').trim() || '导入项目';
    const renamed = await fileService.renameProjectDataDir(
      projectId,
      stagingFolder,
      fileService.buildProjectFolderName(name, projectId),
    );
    // 改名失败时必须沿用临时目录名入库：记录里的 dataFolder 与磁盘目录不一致，
    // 重启后就会按不存在的目录去找素材。
    const dataFolder = renamed?.dataFolder ?? stagingFolder;
    if (!renamed) {
      fileService.registerProjectFolder(projectId, stagingFolder);
      console.warn('[项目导入] 数据目录改名失败，已沿用临时目录名', { stagingFolder });
    }

    const now = Date.now();
    // 归档来自外部文件，settings 与角色库都按现有归一化逻辑重建后再入库。
    const record: ProjectSaveData = {
      ...source,
      id: projectId,
      exchangeEpoch: undefined,
      name,
      dataFolder,
      createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
      updatedAt: now,
      // v1 曾能独立导出分集，源 parentId 不得挂到本机已有项目上。
      parentId: undefined,
      settings: normalizeArchiveSettings(source.settings),
      dramaAssets: normalizeDramaAssetLibrary(source.dramaAssets),
    };

    const records = [record, ...sourceEpisodes.map(({ project }) => ({
      ...project,
      id: createRecordId(),
      exchangeEpoch: undefined,
      parentId: projectId,
      dataFolder,
      updatedAt: now,
      settings: normalizeArchiveSettings(project.settings),
      // 角色库只由新剧集持有，不让分集写入副本。
      dramaAssets: undefined,
    } satisfies ProjectSaveData))];

    const projectIds = new Map<string, string>([[source.id, record.id], ...sourceEpisodes.map((episode, index): [string, string] => [episode.project.id, records[index + 1].id])]);
    if (record.series?.storyGraph) {
      record.series = { ...record.series, storyGraph: remapStoryGraphBindings(record.series.storyGraph,
        (id) => projectIds.get(id) ?? id, (asset) => asset.id, 1) };
    }

    // 同一归档 assets 根中的相对路径是文件身份；主图投影与参考图不能重复计数。
    const relativeKey = (path: string) => path.replace(/\\/g, '/').split('/').filter((part) => part !== '.').join('/');
    const extractedAssets = new Set(unpacked.assetPaths.map(relativeKey));
    const missingAssetCount = new Set(records.flatMap(collectAssetReferences)
      .flatMap((reference) => typeof reference.relativePath === 'string' && reference.relativePath
        ? [relativeKey(reference.relativePath)] : [])
      .filter((path) => !extractedAssets.has(path))).size;
    let conversationCount = 0;
    let memoryCount = 0;
    for (const [index, next] of records.entries()) {
      historyOptions.signal?.throwIfAborted();
      fileService.registerProjectFolder(next.id, dataFolder);
      detachSourceAssetIdentity(next);
      // 保存失败也可能已部分写入，回滚必须包含正在写入的 ID。
      createdProjectIds.push(next.id);
      await fileService.saveProject(next);
      const counts = await restoreChatPayload(payloads[index], next.id, chatIdentities, projectIds);
      conversationCount += counts.conversationCount;
      memoryCount += counts.memoryCount;
    }
    fileService.notifyProjectDiskChanged();

    const warnings: string[] = [];
    if (manifest.formatVersion === 1 && sourceEpisodes.length === 0) {
      if (source.parentId) {
        warnings.push('旧项目包未包含所属剧集，已作为独立项目导入；需要整部剧请从原项目重新导出');
      } else if ((source.nodes as unknown[]).length === 0) {
        warnings.push('旧项目包没有画布节点或分集数据，已保留素材和创作资产；请从原项目重新导出整部剧');
      }
    }

    return {
      projectId,
      projectName: name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      dataFolder,
      settings: record.settings,
      snapshot: record.snapshot,
      series: record.series,
      episodes: records.slice(1).map((episode) => toProjectSummaryRecord(episode)!),
      warnings,
      assetCount: unpacked.assetPaths.length,
      missingAssetCount,
      conversationCount,
      memoryCount,
    };
  } catch (error) {
    let cleanupFailed = false;
    for (const id of createdProjectIds.reverse()) {
      try {
        await deleteProjectFromDb(id);
      } catch {
        cleanupFailed = true;
        console.warn('[项目导入] 清理新建项目记录失败');
      }
    }
    // 解包已经落过盘时必须清掉半成品目录，否则数据目录会残留导入中的文件夹。
    // 数据库清理失败时保留素材，避免留下引用已被删除文件的项目。
    if (stagingCreated && !cleanupFailed) {
      await fileService.deleteProjectDataDir(projectId).catch((cleanupError) => {
        console.warn('[项目导入] 清理临时数据目录失败:', cleanupError);
      });
    }
    if (cleanupFailed) throw new Error('项目导入失败，部分记录未能清理；已保留素材，请重启后检查项目库', { cause: error });
    throw error;
  }
}

/**
 * 从 `.aicanvas` 归档导入项目。用户取消选择时返回 null。
 */
export async function importProjectArchive(): Promise<ProjectImportResult | null> {
  const { prepareProjectImport, applyProjectImport, closePreparedProjectImport } = await import('./projectImportService');
  const session = await prepareProjectImport(); if (!session) return null;
  try { return await applyProjectImport(session, null, {}, { appendChat: true, appendMemories: true }); }
  finally { await closePreparedProjectImport(session); }
}

/**
 * 复制项目：打包到临时归档再还原成新项目，素材拷贝、ID 重映射、对话与记忆还原
 * 全部复用导入链路。
 * ponytail: 多一次 gzip 往返换掉一整套目录拷贝代码；大项目嫌慢再加原生 copy_dir 命令。
 */
export async function duplicateProjectArchive(
  projectId: string,
  name: string,
): Promise<ProjectImportResult> {
  if (!fileService.isTauriEnv()) throw new Error('项目复制仅在桌面版可用');

  const baseDir = await fileService.getBaseDir();
  if (!baseDir) throw new Error('无法定位应用数据目录');
  const tempPath = fileService.joinPath(baseDir, `.duplicate-${createRecordId()}.${PROJECT_ARCHIVE_EXTENSION}`);

  try {
    await packProjectArchive(projectId, tempPath);
    return await restoreProjectArchive(tempPath, name);
  } finally {
    await remove(tempPath).catch(() => undefined);
  }
}
