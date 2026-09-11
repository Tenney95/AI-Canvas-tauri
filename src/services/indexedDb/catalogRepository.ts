/**
 * indexedDb/catalogRepository — 配置目录仓库（配置、预设、风格、Skill、工作流、子智能体）。
 * 提供这些常驻对象的读写 CRUD，统一走 schema.ts 声明的 object store，是 catalog 类数据的单一入口。
 */
import type { PresetAdvancedConfig, SkillManifest, UserPresetMode, WorkflowDefinition } from '../../types';
import type { InstalledPlugin } from '../../types/plugin';
import {
  openDB,
  STORE_CONFIG,
  STORE_PRESETS,
  STORE_SKILLS,
  STORE_STYLES,
  STORE_SUB_AGENT_PROFILES,
  STORE_WORKFLOWS,
  STORE_PLUGINS,
} from './schema';

const CONFIG_KEY = 'app-config';

/** 只用于低频关键设置；仅在运行时明确不支持 options 时回退，真实事务错误不得降级重试。 */
export function createDurableSettingsTransaction(db: IDBDatabase, store: string): IDBTransaction {
  try { return db.transaction(store, 'readwrite', { durability: 'strict' }); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'NotSupportedError')) throw error;
    return db.transaction(store, 'readwrite');
  }
}

export interface WorkflowRecord {
  adapterType?: WorkflowDefinition['adapterType'];
  runninghub?: import('../../types/runninghub').RunningHubWorkflowManifest;
  workflowApi?: WorkflowDefinition['workflowApi'];
  id: string;
  name: string;
  category: string;
  fileName: string;
  fileContent: string;
  editableContent?: string;
  ioNodes?: { nodeId: string; title: string; type: string }[];
  defaultNodes?: Record<string, string>;
  /** 绑定的 ComfyUI 服务端 id */
  serverId?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface ConfigRecord {
  id: string;
  data: unknown;
}

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

export interface SubAgentProfileRecord {
  id: string;
  name: string;
  description: string;
  skillId?: string;
  instructions?: string;
  materials: string[];
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CustomStyleRecord {
  id: string;
  nodeType: string;
  name: string;
  prompt: string;
  thumbnail?: string;
  createdAt: number;
}

function putRecord<T>(storeName: string, record: T): Promise<void> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const transaction = storeName === STORE_CONFIG ? createDurableSettingsTransaction(db, storeName) : db.transaction(storeName, 'readwrite');
    let failure: unknown;
    let request: IDBRequest<IDBValidKey> | undefined;
    transaction.oncomplete = () => failure === undefined ? resolve() : reject(failure);
    transaction.onabort = () => reject(
      failure ?? transaction.error ?? new DOMException('数据库写入事务已中止', 'AbortError'),
    );
    // error 先于 abort 派发；等终态再结束 Promise，避免持久化队列提前放行。
    transaction.onerror = () => { failure ??= request?.error ?? transaction.error; };
    try {
      request = transaction.objectStore(storeName).put(record);
    } catch (error) {
      failure = error;
      try {
        transaction.abort();
      } catch {
        // 已结束的事务无法再 abort，此时可立即报告原始写入错误。
        reject(error);
      }
    }
  }));
}

function getAllRecords<T>(storeName: string): Promise<T[]> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  }));
}

function deleteRecord(storeName: string, id: string): Promise<void> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }));
}

export const saveWorkflowToDb = (record: WorkflowRecord): Promise<void> =>
  putRecord(STORE_WORKFLOWS, record);

export const getAllWorkflows = (): Promise<WorkflowRecord[]> =>
  getAllRecords(STORE_WORKFLOWS);

export const deleteWorkflowFromDb = (id: string): Promise<void> =>
  deleteRecord(STORE_WORKFLOWS, id);

export const saveConfigToDb = (data: unknown): Promise<void> =>
  putRecord(STORE_CONFIG, { id: CONFIG_KEY, data });

/** 比较和更新在一个事务里完成，避免两个实例之间的读后写竞态。 */
export async function patchConfigToDb(changes: import('../configPatch').ConfigChange[]): Promise<unknown> {
  const { applyConfigPatch } = await import('../configPatch');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = createDurableSettingsTransaction(db, STORE_CONFIG);
    const store = tx.objectStore(STORE_CONFIG);
    const request = store.get(CONFIG_KEY);
    let failure: unknown;
    let next: unknown;
    request.onsuccess = () => {
      try {
        const record = request.result as { data?: unknown } | undefined;
        if (record !== undefined && (!record.data || typeof record.data !== 'object' || Array.isArray(record.data))) {
          throw new Error('配置记录格式异常');
        }
        next = applyConfigPatch(record?.data ?? {}, changes);
        if (changes.length) store.put({ id: CONFIG_KEY, data: next });
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('配置事务已中止', 'AbortError'));
  });
}

export async function loadConfigFromDb(): Promise<unknown | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONFIG, 'readonly');
    let failure: unknown;
    let data: unknown = null;
    try {
      const request = tx.objectStore(STORE_CONFIG).get(CONFIG_KEY);
      request.onsuccess = () => {
        const record = request.result as { data?: unknown } | undefined;
        if (record !== undefined && (!record.data || typeof record.data !== 'object' || Array.isArray(record.data))) {
          failure = new Error('配置记录格式异常'); tx.abort(); return;
        }
        data = record?.data ?? null;
      };
    } catch (error) { failure = error; tx.abort(); }
    tx.oncomplete = () => resolve(data);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('配置读取已中止', 'AbortError'));
  });
}

export const savePresetToDb = (record: PresetRecord): Promise<void> =>
  putRecord(STORE_PRESETS, record);

export const getAllPresets = (): Promise<PresetRecord[]> =>
  getAllRecords(STORE_PRESETS);

export const deletePresetFromDb = (id: string): Promise<void> =>
  deleteRecord(STORE_PRESETS, id);

export const saveSkillToDb = (record: SkillRecord): Promise<void> =>
  putRecord(STORE_SKILLS, record);

export const getAllSkills = (): Promise<SkillRecord[]> =>
  getAllRecords(STORE_SKILLS);

export const deleteSkillFromDb = (id: string): Promise<void> =>
  deleteRecord(STORE_SKILLS, id);

export const saveSubAgentProfileToDb = (record: SubAgentProfileRecord): Promise<void> =>
  putRecord(STORE_SUB_AGENT_PROFILES, record);

export const getAllSubAgentProfiles = (): Promise<SubAgentProfileRecord[]> =>
  getAllRecords(STORE_SUB_AGENT_PROFILES);

export const deleteSubAgentProfileFromDb = (id: string): Promise<void> =>
  deleteRecord(STORE_SUB_AGENT_PROFILES, id);

export const saveStyleToDb = (record: CustomStyleRecord): Promise<void> =>
  putRecord(STORE_STYLES, record);

export const getAllStyles = (): Promise<CustomStyleRecord[]> =>
  getAllRecords(STORE_STYLES);

export const deleteStyleFromDb = (id: string): Promise<void> =>
  deleteRecord(STORE_STYLES, id);

export const savePluginToDb = (record: InstalledPlugin): Promise<void> =>
  putRecord(STORE_PLUGINS, record);

export const getAllPlugins = (): Promise<InstalledPlugin[]> =>
  getAllRecords(STORE_PLUGINS);

export const deletePluginFromDb = (id: string): Promise<void> =>
  deleteRecord(STORE_PLUGINS, id);
