/**
 * storageService — IndexedDB-backed persistence wrappers for projects,
 * workflows, app config, and user presets.
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
  type WorkflowRecord,
  type PresetRecord,
} from './indexedDbService';

export interface ProjectSaveData {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodes: unknown;
  edges: unknown;
  groups?: unknown;
  /** 本地媒体文件夹名（形如「项目名-短ID」），创建时确定后保持稳定 */
  dataFolder?: string;
}

/** 保存项目到 IndexedDB */
export async function saveProject(data: ProjectSaveData): Promise<string> {
  try {
    await saveProjectToDb(data);
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
    return [];
  }
}

/** 从 IndexedDB 加载单个项目完整数据 */
export async function loadProjectData(id: string): Promise<ProjectSaveData | null> {
  try {
    const record = await getProjectById(id);
    return record ?? null;
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

/** 保存应用配置到 IndexedDB */
export async function saveConfig(data: unknown): Promise<void> {
  try {
    await saveConfigToDb(data);
    console.log('Config saved to IndexedDB');
  } catch (error) {
    console.error('Save config failed:', error);
    throw error;
  }
}

/** 从 IndexedDB 加载应用配置 */
export async function loadConfig(): Promise<unknown | null> {
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

export type { WorkflowRecord, PresetRecord };
