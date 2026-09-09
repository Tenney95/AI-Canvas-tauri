import { useAppStore } from '../../store/useAppStore';
import type { WorkflowApiDraft, WorkflowApiInputValues, WorkflowApiManifest } from '../../types/workflowApi';
import { AUTODL_H3_WORKFLOW, createAutodlH3WorkflowManifest, resolveWorkflowApiInputValues } from './autodlWorkflowManifest';
import { resolveDeclaredWorkflowInputs, validateDeclarativeWorkflowManifest } from './workflowApiDefinition';

export async function saveWorkflowApiDrafts(connectionId: string, drafts: WorkflowApiDraft[]): Promise<void> {
  if (!drafts.length || drafts.length > 50 || new Set(drafts.map((draft) => draft.id)).size !== drafts.length) throw new Error('请配置 1–50 个不同的工作流');
  const store = useAppStore.getState();
  const definitions = drafts.map((draft) => {
    if (!draft.name.trim() || draft.name.length > 120) throw new Error('请填写工作流名称');
    const manifest = { ...draft.manifest, connectionId };
    validateDeclarativeWorkflowManifest(manifest);
    const existing = store.workflows.find((workflow) => workflow.id === draft.id);
    if (existing && (existing.adapterType !== 'workflow-api' || existing.workflowApi?.connectionId !== connectionId)) throw new Error('工作流不属于当前连接');
    return { draft, manifest, existing };
  });
  for (const { draft, manifest, existing } of definitions) {
    const category = `ai-${manifest.outputKind}` as 'ai-image' | 'ai-video' | 'ai-audio';
    if (existing) await store.updateWorkflow(existing.id, { name: draft.name.trim(), category, workflowApi: manifest });
    else await store.addWorkflow({ id: draft.id, name: draft.name.trim(), category, fileName: '', fileContent: '', adapterType: 'workflow-api', workflowApi: manifest, createdAt: Date.now() });
  }
}

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
export function parseWorkflowApiFields(fields: Record<string, string> = {}, manifest?: WorkflowApiManifest): WorkflowApiInputValues {
  const entries = Object.entries(fields).map(([name, value]) => {
    const key = name.startsWith('workflow::') ? name.slice('workflow::'.length) : name;
    const type = manifest?.version === 2 ? manifest.parameters[key]?.type : key === 'seed' || key === 'duration' ? 'number' : 'string';
    return [key, type === 'number' || type === 'integer' ? (value.trim() ? Number(value) : NaN)
      : type === 'boolean' ? value === 'true' ? true : value === 'false' ? false : value : value] as const;
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('工作流参数重复');
  const values = Object.fromEntries(entries);
  if (manifest?.version === 2) return resolveDeclaredWorkflowInputs(manifest, values);
  resolveWorkflowApiInputValues(values);
  return values;
}
