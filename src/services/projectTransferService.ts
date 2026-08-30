/**
 * 项目整体导出 / 导入。
 *
 * 导出把「项目记录 + 对话 + 项目记忆 + 本地素材目录」打包成单个 `.aicanvas`
 * 归档（tar.gz）；导入以全新的项目 ID 与数据目录还原，因此同一台机器重复导入
 * 同一个包不会互相覆盖。
 *
 * 素材在项目记录里本就是 `relativePath` 相对项目目录保存的，归档内 `assets/`
 * 与项目目录一一对应，所以还原后无需重写路径；缺失的素材按现有加载策略保留节点。
 */
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open, save } from '@tauri-apps/plugin-dialog';
import { remove } from '@tauri-apps/plugin-fs';
import * as fileService from './fileService';
import {
  getProjectById,
  getProjectConversations,
  getConversationMessages,
  getProjectMemories,
  putChatConversation,
  putChatMessage,
  putProjectMemory,
  saveProjectToDb,
  type ChatConversationRecord,
  type ChatMessageRecord,
  type ProjectMemoryRecord,
} from './indexedDbService';
import type { ProjectSaveData } from './storageService';
import { normalizeProjectSettings } from './projectSettingsService';
import { normalizeDramaAssetLibrary } from '../types/dramaAssets';
import type { CanvasProject } from '../types';

export const PROJECT_ARCHIVE_EXTENSION = 'aicanvas';
/** 归档格式版本；解包时拒绝更高版本，避免旧版本误读新结构。 */
export const PROJECT_ARCHIVE_FORMAT_VERSION = 1;

const MANIFEST_ENTRY = 'manifest.json';
const PROJECT_ENTRY = 'project.json';
const CHAT_ENTRY = 'chat.json';
/** 单个会话一次性读取的消息上限，超出部分不会进入归档。 */
const MAX_MESSAGES_PER_CONVERSATION = 100_000;

export interface ProjectArchiveManifest {
  formatVersion: number;
  appVersion?: string;
  exportedAt: number;
  projectId: string;
  projectName: string;
}

interface ProjectArchiveChatPayload {
  conversations: ChatConversationRecord[];
  messages: ChatMessageRecord[];
  memories: ProjectMemoryRecord[];
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
}

export interface ProjectExportResult {
  filePath: string;
  assetCount: number;
  archiveBytes: number;
}

export interface ProjectImportResult {
  projectId: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;
  dataFolder: string;
  settings?: ProjectSaveData['settings'];
  snapshot?: string;
  assetCount: number;
  /** 项目记录里引用、但归档内没有对应文件的素材数量。 */
  missingAssetCount: number;
  conversationCount: number;
  memoryCount: number;
}

/** 与项目节点、角色参考图共用的素材引用形状。 */
interface AssetReferenceLike {
  assetId?: string;
  relativePath?: string;
  filePath?: string;
  storyboardOverrides?: (AssetReferenceLike | null)[];
  directorScene?: AssetReferenceLike;
  directorResultManifest?: AssetReferenceLike;
}

interface PersistedNodeLike {
  data?: AssetReferenceLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

/** 遍历项目记录里的全部素材引用（节点、分镜覆盖、角色参考图与声音）。 */
function collectAssetReferences(record: ProjectSaveData): AssetReferenceLike[] {
  const references: AssetReferenceLike[] = [];
  const pushReference = (value: AssetReferenceLike | null | undefined) => {
    if (!isRecord(value)) return;
    references.push(value);
    if (Array.isArray(value.storyboardOverrides)) {
      value.storyboardOverrides.forEach((override) => {
        if (isRecord(override)) references.push(override);
      });
    }
    if (isRecord(value.directorScene)) references.push(value.directorScene);
    if (isRecord(value.directorResultManifest)) references.push(value.directorResultManifest);
  };

  if (Array.isArray(record.nodes)) {
    (record.nodes as PersistedNodeLike[]).forEach((node) => pushReference(node?.data));
  }
  record.dramaAssets?.characters?.forEach((character) => {
    character.referenceImages?.forEach((reference) => pushReference(reference));
    character.voiceClips?.forEach((clip) => pushReference(clip));
  });
  return references;
}

/**
 * 导入时清掉源机器的 assetId：assetId 是本机资产索引的主键，沿用会把源项目的
 * 索引条目指到导入副本上。素材靠 relativePath 定位，重新识别即可拿到新身份。
 */
function detachSourceAssetIdentity(record: ProjectSaveData): void {
  collectAssetReferences(record).forEach((reference) => {
    if (reference.relativePath) delete reference.assetId;
  });
}

async function readAllConversationMessages(conversationId: string): Promise<ChatMessageRecord[]> {
  const { messages } = await getConversationMessages(conversationId, 0, MAX_MESSAGES_PER_CONVERSATION);
  return messages.slice().sort((left, right) => left.sequence - right.sequence);
}

async function collectChatPayload(projectId: string): Promise<ProjectArchiveChatPayload> {
  const conversations = await getProjectConversations(projectId).catch(() => [] as ChatConversationRecord[]);
  const messageGroups = await Promise.all(
    conversations.map((conversation) => readAllConversationMessages(conversation.id).catch(() => [])),
  );
  const memories = await getProjectMemories(projectId).catch(() => [] as ProjectMemoryRecord[]);
  return { conversations, messages: messageGroups.flat(), memories };
}

/** 把项目记录、对话与素材目录打包到指定归档路径；调用方保证项目已落盘。 */
async function packProjectArchive(projectId: string, outputPath: string): Promise<PackResult> {
  const record = await getProjectById(projectId);
  if (!record) throw new Error('未找到项目数据，无法导出');

  const projectRecord = record as unknown as ProjectSaveData;
  const chat = await collectChatPayload(projectId);
  const manifest: ProjectArchiveManifest = {
    formatVersion: PROJECT_ARCHIVE_FORMAT_VERSION,
    appVersion: await getVersion().catch(() => undefined),
    exportedAt: Date.now(),
    projectId,
    projectName: projectRecord.name,
  };

  // 用 ensure 而不是 get：老项目可能还没建过数据目录，直接打包会卡在路径校验上。
  const assetsDir = await fileService.ensureProjectDataDir(projectId).catch(() => null);
  return invoke<PackResult>('pack_project_archive', {
    entries: [
      { path: MANIFEST_ENTRY, content: JSON.stringify(manifest) },
      { path: PROJECT_ENTRY, content: JSON.stringify(projectRecord) },
      { path: CHAT_ENTRY, content: JSON.stringify(chat) },
    ],
    assetsDir: assetsDir ?? null,
    outputPath,
  });
}

/**
 * 导出项目为 `.aicanvas` 归档。用户取消保存对话框时返回 null。
 * 调用方需保证项目已落盘，导出读取的是 IndexedDB 里的持久化记录。
 */
export async function exportProjectArchive(projectId: string): Promise<ProjectExportResult | null> {
  if (!fileService.isTauriEnv()) throw new Error('项目导出仅在桌面版可用');

  const record = await getProjectById(projectId);
  if (!record) throw new Error('未找到项目数据，无法导出');

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
  };
}

/** 把归档里的对话与项目记忆重映射到新项目下写回 IndexedDB。 */
async function restoreChatPayload(
  payload: ProjectArchiveChatPayload | null,
  projectId: string,
): Promise<{ conversationCount: number; memoryCount: number }> {
  if (!payload) return { conversationCount: 0, memoryCount: 0 };

  const conversationIdMap = new Map<string, string>();
  const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
  for (const conversation of conversations) {
    if (!isRecord(conversation) || !conversation.id) continue;
    const nextId = createRecordId();
    conversationIdMap.set(conversation.id, nextId);
    await putChatConversation({ ...conversation, id: nextId, projectId });
  }

  const messageIdMap = new Map<string, string>();
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || !message.id) continue;
    const nextConversationId = conversationIdMap.get(message.conversationId);
    if (!nextConversationId) continue;
    const nextId = createRecordId();
    messageIdMap.set(message.id, nextId);
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
      ? conversationIdMap.get(sourceConversationId)
      : undefined;
    await putProjectMemory({
      ...memory,
      id: createRecordId(),
      projectId,
      source: {
        ...memory.source,
        conversationId: nextConversationId ?? '',
        messageId: memory.source?.messageId ? messageIdMap.get(memory.source.messageId) : undefined,
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
async function restoreProjectArchive(
  archivePath: string,
  overrideName?: string,
): Promise<ProjectImportResult> {
  const projectId = createRecordId();
  const stagingFolder = fileService.buildProjectFolderName('导入中', projectId);
  fileService.registerProjectFolder(projectId, stagingFolder);

  let stagingCreated = false;
  try {
    const stagingDir = await fileService.ensureProjectDataDir(projectId);
    if (!stagingDir) throw new Error('无法创建项目数据目录');
    stagingCreated = true;

    const unpacked = await invoke<UnpackResult>('unpack_project_archive', {
      archivePath,
      assetsDir: stagingDir,
    });

    const manifest = parseJson<ProjectArchiveManifest>(unpacked.texts[MANIFEST_ENTRY], '清单');
    if (!Number.isFinite(manifest.formatVersion) || manifest.formatVersion > PROJECT_ARCHIVE_FORMAT_VERSION) {
      throw new Error('项目包由更新版本导出，请先升级应用');
    }
    const source = parseJson<ProjectSaveData>(unpacked.texts[PROJECT_ENTRY], '项目记录');
    if (!Array.isArray(source.nodes) || !Array.isArray(source.edges)) {
      throw new Error('项目包中的画布数据不完整');
    }
    const chat = unpacked.texts[CHAT_ENTRY]
      ? parseJson<ProjectArchiveChatPayload>(unpacked.texts[CHAT_ENTRY], '对话记录')
      : null;

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
      name,
      dataFolder,
      createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
      updatedAt: now,
      settings: isRecord(source.settings) ? normalizeProjectSettings(source.settings) : undefined,
      dramaAssets: normalizeDramaAssetLibrary(source.dramaAssets),
    };

    const extractedAssets = new Set(unpacked.assetPaths);
    const missingAssetCount = collectAssetReferences(record)
      .filter((reference) => reference.relativePath && !extractedAssets.has(reference.relativePath))
      .length;
    detachSourceAssetIdentity(record);
    await saveProjectToDb(record);

    const { conversationCount, memoryCount } = await restoreChatPayload(chat, projectId);
    fileService.notifyProjectDiskChanged();

    return {
      projectId,
      projectName: name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      dataFolder,
      settings: record.settings,
      snapshot: record.snapshot,
      assetCount: unpacked.assetPaths.length,
      missingAssetCount,
      conversationCount,
      memoryCount,
    };
  } catch (error) {
    // 解包已经落过盘时必须清掉半成品目录，否则数据目录会残留导入中的文件夹。
    if (stagingCreated) {
      await fileService.deleteProjectDataDir(projectId).catch((cleanupError) => {
        console.warn('[项目导入] 清理临时数据目录失败:', cleanupError);
      });
    }
    throw error;
  }
}

/**
 * 从 `.aicanvas` 归档导入项目。用户取消选择时返回 null。
 */
export async function importProjectArchive(): Promise<ProjectImportResult | null> {
  if (!fileService.isTauriEnv()) throw new Error('项目导入仅在桌面版可用');

  const archivePath = await open({
    multiple: false,
    title: '导入项目',
    filters: [{ name: 'AI Canvas 项目包', extensions: [PROJECT_ARCHIVE_EXTENSION] }],
  });
  if (!archivePath || typeof archivePath !== 'string') return null;

  return restoreProjectArchive(archivePath);
}

export interface ProjectDuplicateResult extends ProjectImportResult {
  /** 一起复制出来的分集记录，供调用方并入内存项目列表。 */
  episodes: CanvasProject[];
}

/**
 * 分集与剧集共用素材目录，归档只带走剧集本身；分集记录在副本建好后按新剧集 ID 直接克隆。
 * 单集失败不影响其余分集，与导入时缺素材不阻断的策略一致。
 */
async function duplicateEpisodes(episodeIds: string[], target: ProjectImportResult): Promise<CanvasProject[]> {
  const created: CanvasProject[] = [];
  for (const episodeId of episodeIds) {
    try {
      const source = await getProjectById(episodeId);
      if (!source) continue;
      const record = { ...(source as unknown as ProjectSaveData) };
      const nextId = createRecordId();
      detachSourceAssetIdentity(record);
      const next: ProjectSaveData = {
        ...record,
        id: nextId,
        parentId: target.projectId,
        dataFolder: target.dataFolder,
        updatedAt: Date.now(),
      };
      await saveProjectToDb(next);
      await restoreChatPayload(await collectChatPayload(episodeId), nextId);
      created.push({
        id: nextId,
        name: next.name,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
        snapshot: next.snapshot,
        dataFolder: next.dataFolder,
        settings: next.settings,
        parentId: next.parentId,
        episodeNo: next.episodeNo,
        episodeOutline: next.episodeOutline,
        episodeScript: next.episodeScript,
        episodeCreative: next.episodeCreative,
      });
    } catch (error) {
      console.warn('[项目复制] 分集复制失败:', episodeId, error);
    }
  }
  return created;
}

/**
 * 复制项目：打包到临时归档再还原成新项目，素材拷贝、ID 重映射、对话与记忆还原
 * 全部复用导入链路。
 * ponytail: 多一次 gzip 往返换掉一整套目录拷贝代码；大项目嫌慢再加原生 copy_dir 命令。
 */
export async function duplicateProjectArchive(
  projectId: string,
  name: string,
  episodeIds: string[] = [],
): Promise<ProjectDuplicateResult> {
  if (!fileService.isTauriEnv()) throw new Error('项目复制仅在桌面版可用');

  const baseDir = await fileService.getBaseDir();
  if (!baseDir) throw new Error('无法定位应用数据目录');
  const tempPath = fileService.joinPath(baseDir, `.duplicate-${createRecordId()}.${PROJECT_ARCHIVE_EXTENSION}`);

  try {
    await packProjectArchive(projectId, tempPath);
    const result = await restoreProjectArchive(tempPath, name);
    return { ...result, episodes: await duplicateEpisodes(episodeIds, result) };
  } finally {
    await remove(tempPath).catch(() => undefined);
  }
}
