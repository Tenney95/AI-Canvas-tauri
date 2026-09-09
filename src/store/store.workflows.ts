/**
 * Workflow slice — ComfyUI workflow CRUD
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { WorkflowDefinition } from '../types';
import * as fileService from '../services/fileService';
import { validateRunningHubManifest } from '../services/runninghubWorkflowService';
import { validateWorkflowApiManifest } from '../services/workflowApi/autodlWorkflowManifest';
import {
  pendingBuiltInWorkflows,
  resetBuiltInWorkflows,
  withBuiltInEditableContent,
} from '../services/builtinWorkflows';

export interface WorkflowSlice {
  workflows: WorkflowDefinition[];
  workflowPanelOpen: boolean;
  workflowPanelSource: 'comfyui' | 'workflow' | 'app';
  setWorkflowPanelSource: (source: WorkflowSlice['workflowPanelSource']) => void;
  setWorkflowPanelOpen: (open: boolean, source?: WorkflowSlice['workflowPanelSource']) => void;
  addWorkflow: (wf: WorkflowDefinition) => Promise<void>;
  updateWorkflow: (id: string, updates: Partial<Omit<WorkflowDefinition, 'id' | 'createdAt'>>) => Promise<void>;
  deleteWorkflow: (id: string) => Promise<void>;
  /** 内置工作流恢复成随包发布的版本（删掉的补回、改过的覆盖），返回恢复条数。 */
  resetBuiltInWorkflows: () => Promise<number>;
  loadWorkflows: () => Promise<void>;
}

function validateWorkflow(workflow: WorkflowDefinition) {
  if (workflow.adapterType && !['comfyui', 'runninghub', 'workflow-api'].includes(workflow.adapterType)) throw new Error('不支持的工作流来源');
  if (workflow.adapterType === 'workflow-api') {
    if (workflow.category !== 'ai-video') throw new Error('此工作流只支持视频输出');
    validateWorkflowApiManifest(workflow.workflowApi);
    if (workflow.runninghub || workflow.fileContent || workflow.editableContent || workflow.ioNodes?.length || workflow.defaultNodes || workflow.serverId) throw new Error('工作流 API 不保存原始调用示例或本地工作流正文');
  } else if (workflow.workflowApi) throw new Error('工作流 API 定义与来源不一致');
  if (workflow.adapterType === 'runninghub') {
    if (!workflow.runninghub || !['ai-image', 'ai-video', 'ai-audio'].includes(workflow.category)) throw new Error('请选择云工作流的图像、视频或音频输出类型');
    validateRunningHubManifest(workflow.runninghub);
    if (workflow.fileContent || workflow.editableContent || workflow.ioNodes?.length || workflow.serverId) throw new Error('云工作流只保存参数定义，不保存调用示例或本地工作流正文');
  } else if (workflow.runninghub) throw new Error('云工作流定义与来源不一致');
}

export const createWorkflowSlice: StateCreator<AppState, [], [], WorkflowSlice> = (set, get) => ({
  workflows: [],
  workflowPanelOpen: false,
  workflowPanelSource: 'comfyui',
  setWorkflowPanelSource: (source) => set({ workflowPanelSource: source }),

  setWorkflowPanelOpen: (open, source) => set({ workflowPanelOpen: open, ...(source ? { workflowPanelSource: source } : {}) }),

  addWorkflow: async (wf) => {
    validateWorkflow(wf);
    await fileService.saveWorkflow({
      id: wf.id,
      name: wf.name,
      category: wf.category,
      fileName: wf.fileName,
      fileContent: wf.fileContent,
      editableContent: wf.editableContent,
      ioNodes: wf.ioNodes,
      defaultNodes: wf.defaultNodes,
      serverId: wf.serverId,
      adapterType: wf.adapterType,
      runninghub: wf.runninghub,
      workflowApi: wf.workflowApi,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
    });
    set((state) => ({ workflows: [...state.workflows, wf] }));
  },

  updateWorkflow: async (id, updates) => {
    const existing = get().workflows.find((workflow) => workflow.id === id);
    if (!existing) throw new Error('要更新的工作流不存在');
    const updatedWorkflow: WorkflowDefinition = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    validateWorkflow(updatedWorkflow);
    await fileService.saveWorkflow(updatedWorkflow);
    set((state) => ({
      workflows: state.workflows.map((workflow) => (
        workflow.id === id ? updatedWorkflow : workflow
      )),
    }));
  },

  deleteWorkflow: async (id) => {
    set((state) => ({
      workflows: state.workflows.filter((w) => w.id !== id),
    }));
    await fileService.deleteWorkflow(id).catch((e) => console.warn('[删除工作流] 清理失败:', e));
  },

  resetBuiltInWorkflows: async () => {
    const builtIns = resetBuiltInWorkflows();
    await Promise.all(builtIns.map((workflow) => fileService.saveWorkflow(workflow)));
    const builtInIds = new Set(builtIns.map((workflow) => workflow.id));
    set((state) => ({
      workflows: [
        ...builtIns,
        ...state.workflows.filter((workflow) => !builtInIds.has(workflow.id)),
      ],
    }));
    return builtIns.length;
  },

  loadWorkflows: async () => {
    const records = await fileService.loadWorkflows();
    const mapped: WorkflowDefinition[] = records.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category as WorkflowDefinition['category'],
      fileName: r.fileName,
      fileContent: r.fileContent,
      editableContent: r.editableContent,
      ioNodes: r.ioNodes as WorkflowDefinition['ioNodes'],
      defaultNodes: r.defaultNodes as WorkflowDefinition['defaultNodes'],
      serverId: r.serverId,
      adapterType: r.adapterType,
      runninghub: r.runninghub,
      workflowApi: r.workflowApi,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    // 早先播种的内置工作流缺可编辑图，补上后 ComfyUI 才能正常打开
    const patched = mapped.map((workflow) => {
      const upgraded = withBuiltInEditableContent(workflow);
      if (upgraded) {
        fileService.saveWorkflow(upgraded).catch((e) => console.warn('[内置工作流] 补可编辑图失败:', e));
      }
      return upgraded ?? workflow;
    });
    // 首次启动把内置工作流落盘，之后它们和用户导入的工作流没有区别
    const seeded = pendingBuiltInWorkflows(patched);
    for (const workflow of seeded) {
      fileService.saveWorkflow(workflow).catch((e) => console.warn('[内置工作流] 持久化失败:', e));
    }
    if (patched.length > 0 || seeded.length > 0) set({ workflows: [...seeded, ...patched] });
  },
});
