import { useAppStore } from '../../store/useAppStore';
import type { WorkflowApiInputValues } from '../../types/workflowApi';
import { AUTODL_H3_WORKFLOW, createAutodlH3WorkflowManifest, resolveWorkflowApiInputValues } from './autodlWorkflowManifest';

/** 连接中编辑模板，工作流定义仍只保存到已有工作流 Store。 */
export async function saveAutodlWorkflowTemplate(connectionId: string, defaults: WorkflowApiInputValues = {}): Promise<void> {
  const manifest = { ...createAutodlH3WorkflowManifest(connectionId), defaults: resolveWorkflowApiInputValues(defaults) };
  const store = useAppStore.getState();
  const existing = store.workflows.find((workflow) => workflow.adapterType === 'workflow-api'
    && workflow.workflowApi?.connectionId === connectionId && workflow.workflowApi.workflowId === manifest.workflowId);
  if (existing) {
    await store.updateWorkflow(existing.id, { workflowApi: manifest });
  } else {
    await store.addWorkflow({ id: crypto.randomUUID(), name: AUTODL_H3_WORKFLOW.name, category: 'ai-video',
      fileName: '', fileContent: '', adapterType: 'workflow-api', workflowApi: manifest, createdAt: Date.now() });
  }
}

/** 表单文本只在边界转数值；非法值交给同一 manifest 校验，不能静默回到默认值。 */
export function parseWorkflowApiFields(fields: Record<string, string> = {}): WorkflowApiInputValues {
  const entries = Object.entries(fields).map(([name, value]) => {
    const key = name.startsWith('workflow::') ? name.slice('workflow::'.length) : name;
    return [key, key === 'seed' || key === 'duration' ? (value.trim() ? Number(value) : NaN) : value] as const;
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('工作流参数重复');
  const values = Object.fromEntries(entries);
  resolveWorkflowApiInputValues(values);
  return values;
}
