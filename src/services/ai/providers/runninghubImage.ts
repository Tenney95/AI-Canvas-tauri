/** 旧图片入口保持兼容；模型合同、官方上传和任务恢复由标准 Adapter 统一执行。 */
import type { BatchImageResult } from '../../../types/aiTypes';
import { runningHubConnection } from '../../workflowExecutionService';
import { executeRunningHubModel } from './runninghubMedia';
export interface RunningHubImageParams {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  imageSize: string;
  aspectRatio: string;
  dimensions: { width: number; height: number };
  imageUrls?: string[];
  nodeId?: string;
}

export async function generateRunningHubImagesBatch(params: RunningHubImageParams, count: number, signal?: AbortSignal): Promise<BatchImageResult> {
  const connection = runningHubConnection({ 'runninghub-model': { name: 'RunningHub', apiKey: params.apiKey, baseUrl: params.baseUrl } }, 'runninghub-model');
  const outputs = await executeRunningHubModel({ ...params, provider: 'runninghub' }, 'image', params.prompt, { image: params.imageUrls }, count, signal, connection);
  return { requestedCount: count, failedCount: Math.max(0, count - outputs.length), results: outputs.map((output) => ({ url: output.url, ...params.dimensions, runninghubOutputs: outputs })) };
}
