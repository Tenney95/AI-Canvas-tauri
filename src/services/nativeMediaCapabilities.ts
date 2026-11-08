/** 新项目媒体入口与统一 Provider／workflow 分发保持同一能力边界；实际合同由提交端再次核验。 */
import type { WorkflowDefinition } from '../types';
import type { MediaKind } from '../types/media';

export function supportsNativeMediaProtocol(kind: MediaKind, provider: string, workflowId?: string, workflows: readonly WorkflowDefinition[] = []): boolean {
  if (workflowId) {
    const workflow = workflows.find((item) => item.id === workflowId);
    return !!workflow && (!workflow.adapterType || ['comfyui', 'runninghub', 'workflow-api'].includes(workflow.adapterType));
  }
  if (kind === 'image') return !['localllm', 'runninghubwf', 'workflow-api', 'comfyui'].includes(provider);
  if (kind === 'audio') return ['general', 'apimart', 'runninghub'].includes(provider);
  return ['general', 'volcengine', 'apimart', 'grsai', 'runninghub', 'dreamina'].includes(provider);
}
