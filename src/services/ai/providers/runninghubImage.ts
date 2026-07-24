/**
 * RunningHub 标准图片模型适配器。
 *
 * 模型 API 使用 POST /openapi/v2/{model-endpoint} 提交任务，
 * 再通过 POST /openapi/v2/query 查询结果，不兼容 OpenAI 图片协议。
 */
import { useAppStore } from '../../../store/useAppStore';
import type { BatchImageResult, ImageGenerationResult } from '../../../types/aiTypes';
import {
  cleanupNodePolling,
  registerNodePolling,
  removePendingTask,
  savePendingTask,
  updatePendingTask,
} from '../../pollManager';
import { pollTask } from '../../pollTask';
import { runBatchTasks } from '../batchUtils';
import { buildAuthHeaders } from '../httpUtils';
import { corsSafeFetch } from '../httpTransport';

type RunningHubImageFamily = 'v1' | 'pro' | 'v2' | 'g2' | 'youchuan-v81' | 'youchuan-v7' | 'youchuan-v6';

interface RunningHubImageModel {
  family: RunningHubImageFamily;
  textEndpoint: string;
  editEndpoint?: string;
}

interface RunningHubTaskResult {
  taskId?: string;
  status?: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | string;
  errorCode?: string;
  errorMessage?: string;
  results?: Array<{ url?: string | null }> | null;
}

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

const MODEL_ENDPOINTS: Record<string, RunningHubImageModel> = {
  nanobanana: {
    family: 'v1',
    textEndpoint: 'rhart-image-v1-official/text-to-image',
    editEndpoint: 'rhart-image-v1-official/edit',
  },
  'rhart-image-v1': {
    family: 'v1',
    textEndpoint: 'rhart-image-v1-official/text-to-image',
    editEndpoint: 'rhart-image-v1-official/edit',
  },
  'rhart-image-v1-official': {
    family: 'v1',
    textEndpoint: 'rhart-image-v1-official/text-to-image',
    editEndpoint: 'rhart-image-v1-official/edit',
  },
  'nanobanana-pro': {
    family: 'pro',
    textEndpoint: 'rhart-image-n-pro-official/text-to-image',
    editEndpoint: 'rhart-image-n-pro-official/edit',
  },
  'rhart-image-n-pro': {
    family: 'pro',
    textEndpoint: 'rhart-image-n-pro-official/text-to-image',
    editEndpoint: 'rhart-image-n-pro-official/edit',
  },
  'rhart-image-n-pro-official': {
    family: 'pro',
    textEndpoint: 'rhart-image-n-pro-official/text-to-image',
    editEndpoint: 'rhart-image-n-pro-official/edit',
  },
  'nanobanana-2': {
    family: 'v2',
    textEndpoint: 'rhart-image-n-g31-flash-official/text-to-image',
    editEndpoint: 'rhart-image-n-g31-flash-official/image-to-image',
  },
  'rhart-image-n-g31-flash': {
    family: 'v2',
    textEndpoint: 'rhart-image-n-g31-flash-official/text-to-image',
    editEndpoint: 'rhart-image-n-g31-flash-official/image-to-image',
  },
  'rhart-image-n-g31-flash-official': {
    family: 'v2',
    textEndpoint: 'rhart-image-n-g31-flash-official/text-to-image',
    editEndpoint: 'rhart-image-n-g31-flash-official/image-to-image',
  },
  'gpt-image-2': {
    family: 'g2',
    textEndpoint: 'rhart-image-g-2-official/text-to-image',
    editEndpoint: 'rhart-image-g-2-official/image-to-image',
  },
  'rhart-image-g-2': {
    family: 'g2',
    textEndpoint: 'rhart-image-g-2-official/text-to-image',
    editEndpoint: 'rhart-image-g-2-official/image-to-image',
  },
  'rhart-image-g-2-official': {
    family: 'g2',
    textEndpoint: 'rhart-image-g-2-official/text-to-image',
    editEndpoint: 'rhart-image-g-2-official/image-to-image',
  },
  'youchuan-v81': {
    family: 'youchuan-v81',
    textEndpoint: 'youchuan/text-to-image-v81',
  },
  'youchuan-v7': {
    family: 'youchuan-v7',
    textEndpoint: 'youchuan/text-to-image-v7',
  },
  'youchuan-v6': {
    family: 'youchuan-v6',
    textEndpoint: 'youchuan/text-to-image-v6',
  },
};

function normalizeModelName(model: string): string {
  return model.replace(/^(?:runninghub-model|runninghub)\//, '');
}

function normalizeResolution(imageSize: string): '1k' | '2k' | '4k' {
  const normalized = imageSize.trim().toLowerCase();
  if (normalized === '1k') return '1k';
  if (normalized === '4k' || normalized === '3k') return '4k';
  return '2k';
}

function buildRequest(
  model: RunningHubImageModel,
  params: RunningHubImageParams,
): { endpoint: string; body: Record<string, unknown> } {
  const imageUrls = params.imageUrls ?? [];
  const editing = imageUrls.length > 0 && Boolean(model.editEndpoint);
  const endpoint = editing ? model.editEndpoint! : model.textEndpoint;
  const resolution = normalizeResolution(params.imageSize);
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    aspectRatio: params.aspectRatio,
  };

  if (model.family === 'pro' || model.family === 'v2' || model.family === 'g2') {
    body.resolution = resolution;
  }
  if (model.family === 'g2') {
    body.quality = 'medium';
  }
  if (editing) {
    body.imageUrls = imageUrls;
  } else if (model.family.startsWith('youchuan-') && imageUrls[0]) {
    body.imageUrl = imageUrls[0];
  }
  if (model.family === 'youchuan-v81') {
    body.hd = resolution !== '1k';
  }

  return { endpoint, body };
}

function unwrapTaskResult(payload: Record<string, unknown>): RunningHubTaskResult {
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as RunningHubTaskResult;
  }
  return payload as RunningHubTaskResult;
}

async function parseTaskResponse(response: Response, fallbackMessage: string): Promise<RunningHubTaskResult> {
  const text = await response.text().catch(() => '');
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    if (!response.ok) throw new Error(`${fallbackMessage} (${response.status}): ${text.slice(0, 200)}`);
  }

  const code = payload.code;
  if (!response.ok || (typeof code === 'number' && code !== 0)) {
    const message = typeof payload.msg === 'string'
      ? payload.msg
      : typeof payload.errorMessage === 'string'
        ? payload.errorMessage
        : `${fallbackMessage} (${response.status})`;
    throw new Error(message);
  }
  return unwrapTaskResult(payload);
}

async function submitTask(
  apiKey: string,
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await corsSafeFetch(`${baseUrl.replace(/\/+$/, '')}/${endpoint}`, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify(body),
    signal,
  });
  const task = await parseTaskResponse(response, 'RunningHub 任务提交失败');
  if (!task.taskId) throw new Error(task.errorMessage || 'RunningHub 任务提交失败：未返回 taskId');
  return task.taskId;
}

async function queryTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<RunningHubTaskResult> {
  const response = await corsSafeFetch(`${baseUrl.replace(/\/+$/, '')}/query`, {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify({ taskId }),
    signal,
  });
  return parseTaskResponse(response, 'RunningHub 任务查询失败');
}

async function waitForTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return pollTask<RunningHubTaskResult, string[]>({
    fetchState: () => queryTask(apiKey, baseUrl, taskId, signal),
    isComplete: (task) => {
      if (task.status?.toUpperCase() !== 'SUCCESS') return null;
      const urls = task.results?.flatMap((result) => result.url ? [result.url] : []) ?? [];
      if (urls.length === 0) throw new Error('RunningHub 任务完成但未返回图片');
      return urls;
    },
    isFailed: (task) => task.status?.toUpperCase() === 'FAILED'
      ? `RunningHub 任务失败：${task.errorMessage || task.errorCode || '未知错误'}`
      : null,
    interval: 3000,
    signal,
  });
}

export async function generateRunningHubImagesBatch(
  params: RunningHubImageParams,
  count: number,
  externalSignal?: AbortSignal,
): Promise<BatchImageResult> {
  const requestedCount = Math.max(1, Math.floor(count));
  const modelName = normalizeModelName(params.model);
  const model = MODEL_ENDPOINTS[modelName];
  if (!model) throw new Error(`RunningHub 模型 "${modelName}" 未配置官方端点`);

  const { endpoint, body } = buildRequest(model, params);
  const nodeSignal = params.nodeId ? registerNodePolling(params.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  if (params.nodeId) {
    const projectId = useAppStore.getState().currentProjectId;
    if (projectId) {
      savePendingTask({
        nodeId: params.nodeId,
        projectId,
        nodeType: 'ai-image',
        provider: 'runninghub',
        providerConfigId: 'runninghub-model',
        taskId: '',
        taskIds: [],
        taskType: 'runninghub',
        batchCount: requestedCount,
        submitted: false,
      });
    }
  }

  let firstError: unknown;
  try {
    const submitted = await runBatchTasks(requestedCount, 3, async () => {
      try {
        return await submitTask(params.apiKey, params.baseUrl, endpoint, body, signal);
      } catch (error) {
        firstError ??= error;
        throw error;
      }
    });
    const taskIds = submitted.results;
    if (taskIds.length === 0) throw firstError || new Error('RunningHub 图片任务提交失败');

    if (params.nodeId) {
      updatePendingTask(params.nodeId, {
        taskId: taskIds[0],
        taskIds,
        submitted: true,
      });
    }

    const completed = await runBatchTasks(taskIds.length, 3, async (index) => {
      try {
        return await waitForTask(params.apiKey, params.baseUrl, taskIds[index], signal);
      } catch (error) {
        firstError ??= error;
        throw error;
      }
    });
    const urls = completed.results.flat().slice(0, requestedCount);
    if (urls.length === 0) throw firstError || new Error('RunningHub 图片生成未返回可用结果');

    const results: ImageGenerationResult[] = urls.map((url) => ({ url, ...params.dimensions }));
    return {
      requestedCount,
      results,
      failedCount: Math.max(0, requestedCount - results.length),
    };
  } finally {
    if (params.nodeId) {
      cleanupNodePolling(params.nodeId);
      removePendingTask(params.nodeId);
    }
  }
}
