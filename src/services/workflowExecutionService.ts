import type { ApiProviderConfig, WorkflowDefinition } from '../types';
import type { RunningHubConnectionId } from '../types/runninghub';
import type { CloudWorkflowOutput } from '../types/workflowApi';
import { resolveWorkflowApiInputValues } from './workflowApi/autodlWorkflowManifest';

/** 两个云 adapter 共用保存及新鲜度检查；具体端点、上传、查询不在这里。 */
export async function saveCloudWorkflowOutputs(
  outputs: CloudWorkflowOutput[], projectId: string | null, label: string,
  isCurrent: () => boolean, providerLabel: string,
): Promise<CloudWorkflowOutput[]> {
  const { persistMediaUrlToProjectData, isTauriEnv } = await import('./fileService');
  const saved: CloudWorkflowOutput[] = [];
  for (const output of outputs) {
    if (!isCurrent()) throw new Error('画布已变化，任务已保留，请继续查询');
    const result = projectId
      ? await persistMediaUrlToProjectData(output.url, projectId, `ai-${output.kind}`, label)
      : { mediaUrl: output.url, sourceUrl: output.url, filePath: undefined };
    if (!isCurrent()) throw new Error('画布已变化，任务已保留，请继续查询');
    if (projectId && isTauriEnv() && !result.filePath) throw new Error(`${providerLabel} 生成已完成，但产物保存失败，可继续查询重试保存`);
    saved.push({ ...output, url: result.mediaUrl, sourceUrl: result.sourceUrl, filePath: result.filePath });
  }
  return saved;
}

export function getCloudWorkflowPersistedOutput(outputs: CloudWorkflowOutput[] | undefined, url: string) {
  const output = outputs?.find((item) => item.url === url);
  if (!output) return undefined;
  return { mediaUrl: output.url, assetUrl: output.url, sourceUrl: output.sourceUrl ?? output.url,
    outputUrl: output.sourceUrl ?? output.url, filePath: output.filePath,
    persistence: output.filePath ? 'saved' as const : 'skipped' as const, persistError: undefined };
}

export function isRunningHubWorkflow(workflow?: WorkflowDefinition): boolean {
  return workflow?.adapterType === 'runninghub';
}

export function isWorkflowApi(workflow?: WorkflowDefinition): boolean {
  return workflow?.adapterType === 'workflow-api';
}

export function isCloudWorkflow(workflow?: WorkflowDefinition): boolean {
  return isRunningHubWorkflow(workflow) || isWorkflowApi(workflow);
}

export function workflowExecution(workflow: WorkflowDefinition) {
  if (workflow.adapterType && !['comfyui', 'runninghub', 'workflow-api'].includes(workflow.adapterType)) {
    throw new Error('不支持的工作流执行类型');
  }
  if (isRunningHubWorkflow(workflow)) {
    if (!workflow.runninghub) throw new Error('RunningHub 工作流定义不完整，请重新导入');
    return { provider: 'runninghubwf', model: `runninghubwf/${workflow.id}`, workflowId: workflow.id };
  }
  if (isWorkflowApi(workflow)) {
    if (!workflow.workflowApi) throw new Error('工作流 API 定义不完整，请重新选择模板');
    const values = resolveWorkflowApiInputValues(workflow.workflowApi.defaults);
    return { provider: 'workflow-api', model: `workflow-api/${workflow.id}`, workflowId: workflow.id,
      seedanceDuration: values.duration, seedanceResolution: values.resolution, seedanceRatio: values.ratio,
      videoResolution: undefined, videoFps: undefined, videoFrames: undefined, generateAudio: undefined };
  }
  return { provider: 'comfyui', model: 'comfyui/workflow', workflowId: workflow.id };
}

export function mediaProviderConfigId(provider: string, workflow?: WorkflowDefinition): string {
  if (isWorkflowApi(workflow)) return workflow!.workflowApi?.connectionId || 'autodl-workflow';
  if (isRunningHubWorkflow(workflow)) return workflow!.runninghub?.connectionId || 'runninghub';
  if (provider === 'runninghub') return 'runninghub-model';
  if (provider === 'runninghubwf') return 'runninghub';
  return provider;
}

export function runningHubConnection(
  providers: Record<string, ApiProviderConfig>,
  connectionId: RunningHubConnectionId,
) {
  const config = providers[connectionId];
  if (!config?.apiKey?.trim()) throw new Error(`请先配置 RunningHub ${connectionId === 'runninghub' ? '工作流' : '模型'} API Key`);
  const url = new URL(config.baseUrl || 'https://www.runninghub.cn');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('RunningHub 接口地址无效');
  }
  // 连接设置的模型根路径不属于工作流 API 路径。
  url.pathname = url.pathname.replace(/\/openapi\/v2\/?$/, '').replace(/\/+$/, '');
  return { apiKey: config.apiKey.trim(), baseUrl: url.toString().replace(/\/+$/, '') };
}
