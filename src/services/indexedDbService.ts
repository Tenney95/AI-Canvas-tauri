/**
 * indexedDbService IndexedDB 持久化服务 — 浏览器端本地存储，保存项目、工作流、应用配置等数据
 */
import type { AgentMode, AgentTask } from '../types/agent';
import type { ConversationContextSummary } from '../types/chat';
import type { ProjectMemory } from '../types/memory';
import type { PresetAdvancedConfig, SkillManifest, UserPresetMode } from '../types';

const DB_NAME = 'ai-canvas-db';
const DB_VERSION = 14; // v14: paged output history and migration metadata
const STORE_PROJECTS = 'projects';
const STORE_WORKFLOWS = 'workflows';
const STORE_CONFIG = 'config';
const STORE_PRESETS = 'presets';
const STORE_HISTORY = 'history';
const STORE_ASSET_META = 'assetMeta';
const STORE_ASSET_META_V2 = 'assetMetaV2';
const STORE_ASSET_INDEX = 'assetIndex';
const STORE_STYLES = 'styles';
const STORE_SKILLS = 'skills';
const STORE_CHAT_CONVERSATIONS = 'chatConversations';
const STORE_CHAT_MESSAGES = 'chatMessages';
const STORE_AGENT_TASKS = 'agentTasks';
const STORE_PROJECT_MEMORIES = 'projectMemories';
const STORE_TOOLBAR_LAYOUTS = 'toolbarLayouts';
const STORE_METADATA = 'metadata';

const CONFIG_KEY = 'app-config';

interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodes: unknown;
  edges: unknown;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  category: string;
  fileName: string;
  fileContent: string;
  ioNodes?: { nodeId: string; title: string; type: string }[];
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_WORKFLOWS)) {
        db.createObjectStore(STORE_WORKFLOWS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PRESETS)) {
        db.createObjectStore(STORE_PRESETS, { keyPath: 'id' });
      }
      const historyStore = db.objectStoreNames.contains(STORE_HISTORY)
        ? request.transaction!.objectStore(STORE_HISTORY)
        : db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
      if (!historyStore.indexNames.contains('timestamp_id')) {
        historyStore.createIndex('timestamp_id', ['timestamp', 'id'], { unique: false });
      }
      if (!historyStore.indexNames.contains('nodeId')) {
        historyStore.createIndex('nodeId', 'nodeId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ASSET_META)) {
        db.createObjectStore(STORE_ASSET_META, { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains(STORE_ASSET_META_V2)) {
        db.createObjectStore(STORE_ASSET_META_V2, { keyPath: 'assetId' });
      }
      if (!db.objectStoreNames.contains(STORE_ASSET_INDEX)) {
        const assetStore = db.createObjectStore(STORE_ASSET_INDEX, { keyPath: 'assetId' });
        assetStore.createIndex('path', 'path', { unique: true });
        assetStore.createIndex('fingerprint', 'fingerprint', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_STYLES)) {
        db.createObjectStore(STORE_STYLES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SKILLS)) {
        db.createObjectStore(STORE_SKILLS, { keyPath: 'id' });
      }
      // v9: chat assistant stores
      if (!db.objectStoreNames.contains(STORE_CHAT_CONVERSATIONS)) {
        const convStore = db.createObjectStore(STORE_CHAT_CONVERSATIONS, { keyPath: 'id' });
        convStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
        convStore.createIndex('deletedAt', 'deletedAt', { unique: false });
        convStore.createIndex('pinned', 'pinned', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CHAT_MESSAGES)) {
        const msgStore = db.createObjectStore(STORE_CHAT_MESSAGES, { keyPath: 'id' });
        msgStore.createIndex('conversationId_sequence', ['conversationId', 'sequence'], { unique: false });
        msgStore.createIndex('requestId', 'requestId', { unique: false });
      }
      // v12: Agent tasks. Steps are embedded to keep each task update atomic.
      if (!db.objectStoreNames.contains(STORE_AGENT_TASKS)) {
        const taskStore = db.createObjectStore(STORE_AGENT_TASKS, { keyPath: 'id' });
        taskStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
        taskStore.createIndex('conversationId_updatedAt', ['conversationId', 'updatedAt'], { unique: false });
        taskStore.createIndex('status', 'status', { unique: false });
      }
      // v11: toolbar layouts (single record, keyed by 'layouts')
      if (!db.objectStoreNames.contains(STORE_TOOLBAR_LAYOUTS)) {
        db.createObjectStore(STORE_TOOLBAR_LAYOUTS, { keyPath: 'id' });
      }
      // v13: user-confirmed project memory
      if (!db.objectStoreNames.contains(STORE_PROJECT_MEMORIES)) {
        const memStore = db.createObjectStore(STORE_PROJECT_MEMORIES, { keyPath: 'id' });
        memStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
        memStore.createIndex('conversationId', 'source.conversationId', { unique: false });
      }
      // v14: lightweight one-time migration markers.
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** 保存整个项目（含 nodes/edges）到 IndexedDB */
export async function saveProjectToDb(record: ProjectRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 原子删除项目及其项目域持久化数据。 */
export async function deleteProjectFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([
      STORE_PROJECTS,
      STORE_CHAT_CONVERSATIONS,
      STORE_CHAT_MESSAGES,
      STORE_AGENT_TASKS,
      STORE_PROJECT_MEMORIES,
    ], 'readwrite');

    tx.objectStore(STORE_PROJECTS).delete(id);

    const conversationStore = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const conversationRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const conversationCursor = conversationStore
      .index('projectId_updatedAt')
      .openCursor(conversationRange);
    conversationCursor.onsuccess = () => {
      const cursor = conversationCursor.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    // chatMessages 没有 projectId 索引；项目删除是低频操作，事务内全表扫描
    // 可以清理会话记录已损坏时留下的孤儿消息，同时避免为此升级 schema。
    const messageCursor = tx.objectStore(STORE_CHAT_MESSAGES).openCursor();
    messageCursor.onsuccess = () => {
      const cursor = messageCursor.result;
      if (!cursor) return;
      if ((cursor.value as ChatMessageRecord).projectId === id) cursor.delete();
      cursor.continue();
    };

    const taskRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const taskCursor = tx.objectStore(STORE_AGENT_TASKS)
      .index('projectId_updatedAt')
      .openCursor(taskRange);
    taskCursor.onsuccess = () => {
      const cursor = taskCursor.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    const memoryRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const memoryCursor = tx.objectStore(STORE_PROJECT_MEMORIES)
      .index('projectId_updatedAt')
      .openCursor(memoryRange);
    memoryCursor.onsuccess = () => {
      const cursor = memoryCursor.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error(`删除项目 ${id} 的持久化数据失败`));
  });
}

/** 获取全部项目列表（只含元数据，不含 nodes/edges） */
export async function getAllProjects(): Promise<ProjectRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 获取单个项目（含 nodes/edges） */
export async function getProjectById(id: string): Promise<ProjectRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ============================================
// Workflow CRUD
// ============================================

/** 保存单个工作流 */
export async function saveWorkflowToDb(record: WorkflowRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WORKFLOWS, 'readwrite');
    const store = tx.objectStore(STORE_WORKFLOWS);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 获取全部工作流 */
export async function getAllWorkflows(): Promise<WorkflowRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WORKFLOWS, 'readonly');
    const store = tx.objectStore(STORE_WORKFLOWS);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 删除单个工作流 */
export async function deleteWorkflowFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WORKFLOWS, 'readwrite');
    const store = tx.objectStore(STORE_WORKFLOWS);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Config persistence
// ============================================

export interface ConfigRecord {
  id: string; // always CONFIG_KEY
  data: unknown;
}

/** 保存应用配置到 IndexedDB */
export async function saveConfigToDb(data: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONFIG, 'readwrite');
    const store = tx.objectStore(STORE_CONFIG);
    store.put({ id: CONFIG_KEY, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 从 IndexedDB 读取应用配置 */
export async function loadConfigFromDb(): Promise<unknown | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONFIG, 'readonly');
    const store = tx.objectStore(STORE_CONFIG);
    const request = store.get(CONFIG_KEY);
    request.onsuccess = () => resolve(request.result?.data ?? null);
    request.onerror = () => reject(request.error);
  });
}

// ============================================
// Presets CRUD
// ============================================

export interface PresetRecord {
  id: string;
  nodeType: string;
  name: string;
  description: string;
  promptTemplate: string;
  thumbnail?: string;
  triggerMode: string;
  icon?: string;
  model?: string;
  provider?: string;
  imageSize?: string;
  aspectRatio?: string;
  mode?: UserPresetMode;
  advanced?: PresetAdvancedConfig;
}

export async function savePresetToDb(record: PresetRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PRESETS, 'readwrite');
    const store = tx.objectStore(STORE_PRESETS);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllPresets(): Promise<PresetRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PRESETS, 'readonly');
    const store = tx.objectStore(STORE_PRESETS);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deletePresetFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PRESETS, 'readwrite');
    const store = tx.objectStore(STORE_PRESETS);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Skills CRUD
// ============================================

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  fileName: string;
  content: string;
  sourceType: string;
  storagePath?: string;
  entryFileName?: string;
  manifest?: SkillManifest;
  createdAt: number;
}

export async function saveSkillToDb(record: SkillRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SKILLS, 'readwrite');
    const store = tx.objectStore(STORE_SKILLS);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllSkills(): Promise<SkillRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SKILLS, 'readonly');
    const store = tx.objectStore(STORE_SKILLS);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteSkillFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SKILLS, 'readwrite');
    const store = tx.objectStore(STORE_SKILLS);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Custom Styles CRUD
// ============================================

export interface CustomStyleRecord {
  id: string;
  nodeType: string;
  name: string;
  prompt: string;
  thumbnail?: string;
  createdAt: number;
}

export async function saveStyleToDb(record: CustomStyleRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STYLES, 'readwrite');
    const store = tx.objectStore(STORE_STYLES);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllStyles(): Promise<CustomStyleRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STYLES, 'readonly');
    const store = tx.objectStore(STORE_STYLES);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteStyleFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STYLES, 'readwrite');
    const store = tx.objectStore(STORE_STYLES);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// History CRUD — AI 输出历史记录
// ============================================

export interface HistoryRecord {
  id: string;
  nodeId: string;
  nodeLabel: string;
  timestamp: number;
  prompt: string;
  output: string;
  nodeType: string;
  model: string;
  provider: string;
  status: string;
  error?: string;
  mediaUrl?: string;
  filePath?: string;
  params?: Record<string, unknown>;
}

export interface HistoryPageCursor {
  timestamp: number;
  id: string;
}

export interface HistoryQuery {
  nodeType?: string;
  search?: string;
}

export interface HistoryPage {
  records: HistoryRecord[];
  nextCursor: HistoryPageCursor | null;
  hasMore: boolean;
}

const HISTORY_MIGRATION_PREFIX = 'output-history-v1:';

function matchesHistoryQuery(record: HistoryRecord, query: HistoryQuery): boolean {
  if (query.nodeType && record.nodeType !== query.nodeType) return false;
  const search = query.search?.trim().toLowerCase();
  if (!search) return true;
  return [record.prompt, record.output, record.model, record.nodeLabel]
    .some((value) => value.toLowerCase().includes(search));
}

/** 保存单条历史记录 */
export async function putHistoryEntry(record: HistoryRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 在同一事务内写入旧节点中的历史记录。 */
export async function putHistoryEntries(records: HistoryRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 删除单条历史记录 */
export async function deleteHistoryEntryFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 按时间倒序读取一页历史；筛选在游标扫描期间完成，不保留未命中记录。 */
export async function getHistoryEntriesPage(
  limit: number,
  cursor: HistoryPageCursor | null = null,
  query: HistoryQuery = {},
): Promise<HistoryPage> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readonly');
    const index = tx.objectStore(STORE_HISTORY).index('timestamp_id');
    const range = cursor
      ? IDBKeyRange.upperBound([cursor.timestamp, cursor.id], true)
      : undefined;
    const request = index.openCursor(range, 'prev');
    const records: HistoryRecord[] = [];
    let nextCursor: HistoryPageCursor | null = null;

    request.onsuccess = () => {
      const current = request.result;
      if (!current) {
        resolve({ records, nextCursor: null, hasMore: false });
        return;
      }
      if (records.length >= limit) {
        resolve({ records, nextCursor, hasMore: true });
        return;
      }

      const record = current.value as HistoryRecord;
      if (matchesHistoryQuery(record, query)) {
        records.push(record);
        nextCursor = { timestamp: record.timestamp, id: record.id };
      }
      current.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/** 仅在用户显式导出时扫描并返回全部匹配记录。 */
export async function getHistoryEntriesForExport(query: HistoryQuery = {}): Promise<HistoryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readonly');
    const request = tx.objectStore(STORE_HISTORY).index('timestamp_id').openCursor(null, 'prev');
    const records: HistoryRecord[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(records);
        return;
      }
      const record = cursor.value as HistoryRecord;
      if (matchesHistoryQuery(record, query)) records.push(record);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/** 使用 nodeId 索引读取指定节点的全部历史记录，按生成时间倒序返回。 */
export async function getNodeHistoryEntries(nodeId: string): Promise<HistoryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_HISTORY, 'readonly')
      .objectStore(STORE_HISTORY)
      .index('nodeId')
      .getAll(IDBKeyRange.only(nodeId));
    request.onsuccess = () => {
      const records = (request.result as HistoryRecord[]).sort((left, right) => (
        right.timestamp - left.timestamp || right.id.localeCompare(left.id)
      ));
      resolve(records);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getHistoryEntryCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_HISTORY, 'readonly').objectStore(STORE_HISTORY).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function hasCompletedHistoryMigration(projectId: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly')
      .objectStore(STORE_METADATA)
      .get(`${HISTORY_MIGRATION_PREFIX}${projectId}`);
    request.onsuccess = () => resolve(Boolean(request.result));
    request.onerror = () => reject(request.error);
  });
}

export async function markHistoryMigrationCompleted(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    tx.objectStore(STORE_METADATA).put({
      id: `${HISTORY_MIGRATION_PREFIX}${projectId}`,
      completedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 清空所有历史记录 */
export async function clearAllHistoryEntries(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 使用 nodeId 索引批量删除指定节点的历史记录。 */
export async function deleteNodeHistoryEntries(nodeId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const request = tx.objectStore(STORE_HISTORY).index('nodeId').openCursor(IDBKeyRange.only(nodeId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Asset Meta CRUD — 稳定资产标签（v2 以 assetId 为键；v1 path 仅用于迁移）
// ============================================

export interface AssetMetaRecord {
  assetId: string;
  path?: string;         // 最近路径，仅用于诊断和旧数据迁移
  tags: string[];        // 标签
  taggedBy?: 'manual' | 'comfyui' | 'vision'; // 标签来源
  updatedAt: number;
}

/** 获取全部资产元数据（一次性读入，组件侧建 Map 合并） */
export async function getAllAssetMeta(): Promise<AssetMetaRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META_V2, 'readonly');
    const store = tx.objectStore(STORE_ASSET_META_V2);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as AssetMetaRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/** 写入/更新单个文件的标签元数据 */
export async function putAssetMeta(record: AssetMetaRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META_V2, 'readwrite');
    tx.objectStore(STORE_ASSET_META_V2).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 删除单个文件的标签元数据 */
export async function deleteAssetMeta(assetId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META_V2, 'readwrite');
    tx.objectStore(STORE_ASSET_META_V2).delete(assetId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Chat Conversations CRUD
// ============================================

export interface ChatConversationRecord {
  id: string;
  projectId: string;
  title: string;
  titleSource: 'auto' | 'user';
  pinned: boolean;
  archived: boolean;
  agentMode: AgentMode;
  contextSummary?: ConversationContextSummary;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  messageCount: number;
  deletedAt?: number;
}

/** 保存 / 更新会话 */
export async function putChatConversation(record: ChatConversationRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readwrite');
    tx.objectStore(STORE_CHAT_CONVERSATIONS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 获取指定项目的全部会话（不含已删除） */
export async function getProjectConversations(projectId: string): Promise<ChatConversationRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const index = store.index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => {
      const all = request.result as ChatConversationRecord[];
      // 过滤掉已删除的
      resolve(all.filter((c) => !c.deletedAt));
    };
    request.onerror = () => reject(request.error);
  });
}

/** 获取回收站中的会话 */
export async function getTrashConversations(projectId: string): Promise<ChatConversationRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const index = store.index('deletedAt');
    const range = IDBKeyRange.lowerBound(1);
    const request = index.getAll(range);
    request.onsuccess = () => {
      const all = request.result as ChatConversationRecord[];
      resolve(all.filter((c) => c.projectId === projectId));
    };
    request.onerror = () => reject(request.error);
  });
}

/** 删除单个会话 */
export async function deleteChatConversation(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readwrite');
    tx.objectStore(STORE_CHAT_CONVERSATIONS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Chat Messages CRUD
// ============================================

export interface ChatMessageRecord {
  id: string;
  projectId: string;
  conversationId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: string;
  requestId?: string;
  agentTaskId?: string;
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  finishReason?: string;
  commands?: unknown;
  executionResults?: unknown;
  mediaStatus?: string;
  mediaError?: string;
  mediaResult?: unknown;
  canvasStatus?: string;
  canvasNodeId?: string;
  canvasError?: string;
  sources?: unknown;
}

export interface LegacyAssetMetaRecord {
  path: string;
  tags: string[];
  taggedBy?: 'manual' | 'comfyui' | 'vision';
  updatedAt: number;
}

export async function getLegacyAssetMeta(path: string): Promise<LegacyAssetMetaRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META, 'readonly');
    const request = tx.objectStore(STORE_ASSET_META).get(path);
    request.onsuccess = () => resolve(request.result as LegacyAssetMetaRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

export interface AssetIndexRecord {
  assetId: string;
  path: string;
  relativePath?: string;
  rootPath?: string;
  projectId?: string;
  source: 'project' | 'global' | 'folder';
  fingerprint: string;
  size: number;
  mtimeMs: number;
  status: 'online' | 'offline';
  updatedAt: number;
}

export async function getAssetIndexById(assetId: string): Promise<AssetIndexRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).get(assetId);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function getAssetIndexByPath(path: string): Promise<AssetIndexRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).index('path').get(path);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function getAssetIndexesByFingerprint(fingerprint: string): Promise<AssetIndexRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).index('fingerprint').getAll(fingerprint);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function putAssetIndex(record: AssetIndexRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readwrite');
    tx.objectStore(STORE_ASSET_INDEX).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 保存 / 更新单条消息 */
export async function putChatMessage(record: ChatMessageRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readwrite');
    tx.objectStore(STORE_CHAT_MESSAGES).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 获取指定会话的消息（分页，按 sequence 倒序） */
export async function getConversationMessages(
  conversationId: string,
  offset: number = 0,
  limit: number = 50,
): Promise<{ messages: ChatMessageRecord[]; total: number }> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readonly');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    const index = store.index('conversationId_sequence');
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Infinity],
    );
    // 先获取总数
    const countReq = index.count(range);
    countReq.onsuccess = () => {
      const total = countReq.result;
      // 再获取分页数据（cursor 倒序）
      const cursorReq = index.openCursor(range, 'prev');
      const messages: ChatMessageRecord[] = [];
      let skipped = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve({ messages, total });
          return;
        }
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }
        if (messages.length < limit) {
          messages.push(cursor.value as ChatMessageRecord);
          cursor.continue();
        } else {
          resolve({ messages, total });
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
  });
}

/**
 * 保存单条消息，并在同一读写事务内分配 sequence：
 * - 已存在的消息（同 id）保留原 sequence，避免更新时被重排到末尾；
 * - 新消息取当前会话最大 sequence + 1。
 *
 * 事务内读改写让 IndexedDB 串行化并发调用（如用户消息与助手占位同时落盘），
 * 从而不会分配到重复 sequence。返回最终写入的 sequence。
 */
export async function putChatMessageWithSequence(
  record: ChatMessageRecord,
): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readwrite');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    let sequence = record.sequence;
    const existingReq = store.get(record.id);
    existingReq.onsuccess = () => {
      const existing = existingReq.result as ChatMessageRecord | undefined;
      if (existing) {
        sequence = existing.sequence;
        store.put({ ...record, sequence });
        return;
      }
      const index = store.index('conversationId_sequence');
      const range = IDBKeyRange.bound(
        [record.conversationId, 0],
        [record.conversationId, Infinity],
      );
      const cursorReq = index.openCursor(range, 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        sequence = cursor ? (cursor.value as ChatMessageRecord).sequence + 1 : 0;
        store.put({ ...record, sequence });
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    existingReq.onerror = () => reject(existingReq.error);
    tx.oncomplete = () => resolve(sequence);
    tx.onerror = () => reject(tx.error);
  });
}

/** 删除指定会话的全部消息 */
export async function deleteConversationMessages(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readwrite');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    const index = store.index('conversationId_sequence');
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Infinity],
    );
    const cursorReq = index.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 在事务中同时删除会话和全部消息 */
export async function permanentlyDeleteConversation(convId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_AGENT_TASKS],
      'readwrite',
    );
    // 删除会话
    tx.objectStore(STORE_CHAT_CONVERSATIONS).delete(convId);
    // 删除消息
    const msgStore = tx.objectStore(STORE_CHAT_MESSAGES);
    const msgIndex = msgStore.index('conversationId_sequence');
    const range = IDBKeyRange.bound([convId, 0], [convId, Infinity]);
    const cursorReq = msgIndex.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    // 删除该会话的 Agent 任务。
    const taskStore = tx.objectStore(STORE_AGENT_TASKS);
    const taskIndex = taskStore.index('conversationId_updatedAt');
    const taskRange = IDBKeyRange.bound([convId, 0], [convId, Infinity]);
    const taskCursorReq = taskIndex.openCursor(taskRange);
    taskCursorReq.onsuccess = () => {
      const cursor = taskCursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Agent Tasks CRUD
// ============================================

export type AgentTaskRecord = AgentTask;

export async function putAgentTask(record: AgentTaskRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readwrite');
    tx.objectStore(STORE_AGENT_TASKS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAgentTask(id: string): Promise<AgentTaskRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const request = tx.objectStore(STORE_AGENT_TASKS).get(id);
    request.onsuccess = () => resolve((request.result as AgentTaskRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function getProjectAgentTasks(projectId: string): Promise<AgentTaskRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as AgentTaskRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function getConversationAgentTasks(
  conversationId: string,
): Promise<AgentTaskRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readonly');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('conversationId_updatedAt');
    const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as AgentTaskRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteAgentTask(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readwrite');
    tx.objectStore(STORE_AGENT_TASKS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteConversationAgentTasks(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readwrite');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('conversationId_updatedAt');
    const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Infinity]);
    const cursorRequest = index.openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProjectAgentTasks(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AGENT_TASKS, 'readwrite');
    const index = tx.objectStore(STORE_AGENT_TASKS).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const cursorRequest = index.openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Project Memory CRUD
// ============================================

export type ProjectMemoryRecord = ProjectMemory;

export async function putProjectMemory(record: ProjectMemoryRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    tx.objectStore(STORE_PROJECT_MEMORIES).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProjectMemories(projectId: string): Promise<ProjectMemoryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readonly');
    const index = tx.objectStore(STORE_PROJECT_MEMORIES).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as ProjectMemoryRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteProjectMemory(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    tx.objectStore(STORE_PROJECT_MEMORIES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProjectMemories(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    const index = tx.objectStore(STORE_PROJECT_MEMORIES).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const cursorRequest = index.openCursor(range);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 把某会话来源的记忆标记为来源不可用，不删除记忆本身。 */
export async function markConversationMemoriesUnavailable(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    const index = tx.objectStore(STORE_PROJECT_MEMORIES).index('conversationId');
    const cursorRequest = index.openCursor(IDBKeyRange.only(conversationId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        const record = cursor.value as ProjectMemoryRecord;
        if (!record.source.unavailable) {
          cursor.update({ ...record, source: { ...record.source, unavailable: true } });
        }
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Toolbar Layouts persistence (single record)
// ============================================

const TOOLBAR_LAYOUTS_KEY = 'layouts';

export async function saveToolbarLayoutsToDb(data: Record<string, unknown>): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TOOLBAR_LAYOUTS, 'readwrite');
    tx.objectStore(STORE_TOOLBAR_LAYOUTS).put({ id: TOOLBAR_LAYOUTS_KEY, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadToolbarLayoutsFromDb(): Promise<Record<string, unknown> | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TOOLBAR_LAYOUTS, 'readonly');
    const request = tx.objectStore(STORE_TOOLBAR_LAYOUTS).get(TOOLBAR_LAYOUTS_KEY);
    request.onsuccess = () => resolve(request.result?.data ?? null);
    request.onerror = () => reject(request.error);
  });
}
