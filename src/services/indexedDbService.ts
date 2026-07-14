/**
 * indexedDbService IndexedDB 持久化服务 — 浏览器端本地存储，保存项目、工作流、应用配置等数据
 */
const DB_NAME = 'ai-canvas-db';
const DB_VERSION = 11; // v11: toolbar layouts persistence
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
const STORE_TOOLBAR_LAYOUTS = 'toolbarLayouts';

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
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
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
      // v11: toolbar layouts (single record, keyed by 'layouts')
      if (!db.objectStoreNames.contains(STORE_TOOLBAR_LAYOUTS)) {
        db.createObjectStore(STORE_TOOLBAR_LAYOUTS, { keyPath: 'id' });
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

/** 删除项目 */
export async function deleteProjectFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

/** 获取全部历史记录 */
export async function getAllHistoryEntries(): Promise<HistoryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readonly');
    const store = tx.objectStore(STORE_HISTORY);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

/** 批量删除指定节点的历史记录（先全取，过滤后全量覆写） */
export async function deleteNodeHistoryEntries(nodeId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    const getAll = store.getAll();
    getAll.onsuccess = () => {
      const toDelete = getAll.result.filter((r: HistoryRecord) => r.nodeId === nodeId);
      for (const r of toDelete) store.delete(r.id);
    };
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

/** 获取会话中下一条消息的 sequence */
export async function getNextMessageSequence(conversationId: string): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readonly');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    const index = store.index('conversationId_sequence');
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Infinity],
    );
    const countReq = index.count(range);
    countReq.onsuccess = () => resolve(countReq.result);
    countReq.onerror = () => reject(countReq.error);
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
      [STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES],
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
