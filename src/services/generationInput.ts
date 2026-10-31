/** 单节点与批量调度共用模型、工作流及空提示词准入规则。 */
import type { BaseNodeData } from '../types';
import type { AppState } from '../store/useAppStore';
import { getProjectModelKind, parseProjectModelRef } from './projectSettingsService';
import { isCloudWorkflow } from './workflowExecutionService';

export function resolveGenerationSelection(
  data: BaseNodeData,
  state: Pick<AppState, 'currentProjectId' | 'projects' | 'workflows'>,
  prompt = data.prompt ?? '',
) {
  const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
  const kind = getProjectModelKind(data.type);
  const defaults = parseProjectModelRef(kind ? settings?.defaultModels?.[kind] : undefined);
  const selected = parseProjectModelRef(data.model);
  const model = data.model || defaults?.model;
  const provider = data.model ? data.provider || selected?.provider : defaults?.provider || data.provider;
  const workflowId = data.workflowId || (!data.model ? defaults?.workflowId : undefined);
  const cloudWorkflow = isCloudWorkflow(state.workflows.find((item) => item.id === workflowId));
  const error = (data.model === '' && !data.workflowId) || !model || !provider ? '未选择模型'
    : !prompt.trim() && !cloudWorkflow && provider !== 'runninghub' ? '提示词为空' : undefined;
  return { model, provider, workflowId, cloudWorkflow, settings, error };
}
