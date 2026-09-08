import type { ApiProviderConfig, WorkflowDefinition } from '../types';
import type { RunningHubConnectionId } from '../types/runninghub';

export function isRunningHubWorkflow(workflow?: WorkflowDefinition): boolean {
  return workflow?.adapterType === 'runninghub';
}

export function workflowExecution(workflow: WorkflowDefinition) {
  if (workflow.adapterType && workflow.adapterType !== 'comfyui' && workflow.adapterType !== 'runninghub') {
    throw new Error('不支持的工作流执行类型');
  }
  if (isRunningHubWorkflow(workflow)) {
    if (!workflow.runninghub) throw new Error('RunningHub 工作流定义不完整，请重新导入');
    return { provider: 'runninghubwf', model: `runninghubwf/${workflow.id}`, workflowId: workflow.id };
  }
  return { provider: 'comfyui', model: 'comfyui/workflow', workflowId: workflow.id };
}

export function mediaProviderConfigId(provider: string, workflow?: WorkflowDefinition): string {
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
