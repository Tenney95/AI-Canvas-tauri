/**
 * Workflow slice — ComfyUI workflow CRUD
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { WorkflowDefinition } from '../types';
import * as fileService from '../services/fileService';

export interface WorkflowSlice {
  workflows: WorkflowDefinition[];
  workflowPanelOpen: boolean;
  setWorkflowPanelOpen: (open: boolean) => void;
  addWorkflow: (wf: WorkflowDefinition) => void;
  deleteWorkflow: (id: string) => Promise<void>;
  loadWorkflows: () => Promise<void>;
}

export const createWorkflowSlice: StateCreator<AppState, [], [], WorkflowSlice> = (set) => ({
  workflows: [],
  workflowPanelOpen: false,

  setWorkflowPanelOpen: (open) => set({ workflowPanelOpen: open }),

  addWorkflow: (wf) => {
    set((state) => ({ workflows: [...state.workflows, wf] }));
    fileService.saveWorkflow({
      id: wf.id,
      name: wf.name,
      category: wf.category,
      fileName: wf.fileName,
      fileContent: wf.fileContent,
      ioNodes: wf.ioNodes,
      createdAt: wf.createdAt,
    }).catch(() => {});
  },

  deleteWorkflow: async (id) => {
    set((state) => ({
      workflows: state.workflows.filter((w) => w.id !== id),
    }));
    await fileService.deleteWorkflow(id).catch(() => {});
  },

  loadWorkflows: async () => {
    const records = await fileService.loadWorkflows();
    if (records.length > 0) {
      const mapped: WorkflowDefinition[] = records.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category as WorkflowDefinition['category'],
        fileName: r.fileName,
        fileContent: r.fileContent,
        ioNodes: r.ioNodes as WorkflowDefinition['ioNodes'],
        createdAt: r.createdAt,
      }));
      set({ workflows: mapped });
    }
  },
});
