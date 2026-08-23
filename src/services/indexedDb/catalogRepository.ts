/**
 * indexedDb/catalogRepository — 配置目录仓库（配置、预设、风格、Skill、工作流、子智能体）。
 * 提供这些常驻对象的读写 CRUD，统一走 schema.ts 声明的 object store，是 catalog 类数据的单一入口。
 */
import type { PresetAdvancedConfig, SkillManifest, UserPresetMode } from '../../types';
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

export interface WorkflowRecord {
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
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
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

export async function loadConfigFromDb(): Promise<unknown | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_CONFIG, 'readonly').objectStore(STORE_CONFIG).get(CONFIG_KEY);
    request.onsuccess = () => resolve(request.result?.data ?? null);
    request.onerror = () => reject(request.error);
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
