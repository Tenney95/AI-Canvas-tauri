/**
 * indexedDbService IndexedDB 持久化服务 — 浏览器端本地存储，保存项目、工作流、应用配置等数据
 */
const DB_NAME = 'ai-canvas-db';
const DB_VERSION = 5; // v5: added history store
const STORE_PROJECTS = 'projects';
const STORE_WORKFLOWS = 'workflows';
const STORE_CONFIG = 'config';
const STORE_PRESETS = 'presets';
const STORE_HISTORY = 'history';

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
