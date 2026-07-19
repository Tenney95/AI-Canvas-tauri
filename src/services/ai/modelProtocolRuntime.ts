/** Model-level declarative protocol runtime with resumable async polling. */
import { useAppStore } from '../../store/useAppStore';
import type { GeneralModelCategory, GeneralModelConfig, NodeType } from '../../types';
import type { ProtocolJsonValue } from '../../types/aiTypes';
import {
  cleanupNodePolling,
  registerNodePolling,
  removePendingTask,
  savePendingTask,
} from '../pollManager';
import {
  pollResolvedModelProtocol,
  resolveModelExecutionProfile,
  submitModelProtocol,
  type ModelProtocolVariables,
} from './modelProtocol';

interface RunConfiguredModelProtocolOptions {
  model: GeneralModelConfig;
  variables: ModelProtocolVariables;
  nodeId?: string;
  category: Exclude<GeneralModelCategory, 'text'>;
}

const NODE_TYPE_BY_CATEGORY: Record<Exclude<GeneralModelCategory, 'text'>, NodeType> = {
  image: 'ai-image',
  video: 'ai-video',
  audio: 'ai-audio',
};

function readBatchCount(value: ProtocolJsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 1;
}

export async function runConfiguredModelProtocol(
  options: RunConfiguredModelProtocolOptions,
): Promise<string[]> {
  const protocol = resolveModelExecutionProfile(options.model.executionProfile);
  if (!protocol) throw new Error(`模型“${options.model.name}”未配置调用协议`);

  const submitted = await submitModelProtocol({
    apiKey: options.model.apiKey || '',
    baseUrl: options.model.openaiUrl,
    protocol,
    variables: options.variables,
  });
  if (submitted.urls) return submitted.urls;
  if (!submitted.poll || !submitted.taskId) throw new Error('异步调用协议未返回轮询配置');

  const projectId = useAppStore.getState().currentProjectId;
  const canPersist = !!options.nodeId && !!projectId && !!options.model.providerConfigId;
  if (canPersist) {
    savePendingTask({
      nodeId: options.nodeId!,
      projectId,
      nodeType: NODE_TYPE_BY_CATEGORY[options.category],
      provider: 'general',
      providerConfigId: options.model.providerConfigId,
      taskId: submitted.taskId,
      taskType: 'custom-protocol',
      protocolPoll: submitted.poll,
      batchCount: readBatchCount(options.variables.n),
      submitted: true,
    });
  }

  const signal = options.nodeId ? registerNodePolling(options.nodeId) : undefined;
  try {
    const result = await pollResolvedModelProtocol(
      submitted.poll,
      options.model.apiKey || '',
      signal,
      options.model.openaiUrl,
    );
    if (!result.urls) throw new Error('媒体模型任务完成但未返回结果 URL');
    return result.urls;
  } finally {
    if (options.nodeId) {
      cleanupNodePolling(options.nodeId);
      removePendingTask(options.nodeId);
    }
  }
}
