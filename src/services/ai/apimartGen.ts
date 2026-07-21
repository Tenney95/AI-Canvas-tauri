/**
 * ai/apimartGen — APIMart 图片/视频生成 + 通用异步任务执行器
 */
import { useAppStore } from '../../store/useAppStore';
import { pollTask } from '../pollTask';
import { savePendingTask, updatePendingTask, removePendingTask, registerNodePolling, cleanupNodePolling } from '../pollManager';
import { parseMultiPathResponse, splitCommaSeparatedUrls } from './helpers';
import type { BatchImageResult } from '../../types/aiTypes';
import {
  buildApimartSeedanceRequest,
  type ApimartSeedanceRequestParams,
} from './apimartVideoModels';

/* ── APIMart 任务轮询共享类型 ── */
export interface ApimartTaskResult<TResult = Record<string, unknown>> {
  code: number;
  data?: {
    status: string;
    progress?: number;
    result?: TResult;
    error?: ApimartTaskError;
  };
  status?: string;
  progress?: number;
  result?: TResult;
  error?: ApimartTaskError;
}

type ApimartTaskError = string | {
  code?: string;
  message?: string;
  type?: string;
};

function getApimartFailureMessage(
  task: ApimartTaskResult,
  label: string,
): string | null {
  if (task.status !== 'failed' && task.status !== 'error') return null;
  const detail = typeof task.error === 'string' ? task.error : task.error?.message;
  return detail?.trim() ? `${label}: ${detail}` : `${label}: ${task.status}`;
}
/**
 * 通用异步任务执行器 — 提交 + 轮询，兼容支持 task_id 模式的 OpenAI 兼容接口
 */
export async function executeGeneralAsyncTask(
  apiKey: string,
  baseUrl: string,
  modelName: string,
  prompt: string,
  resultField: 'videos' | 'audios' | 'images',
  nodeId?: string,
): Promise<{ url: string }> {
  // 预存待续任务（在 fetch 之前），确保关窗重启后能恢复
  if (nodeId) {
    const projectId = useAppStore.getState().currentProjectId;
    if (projectId) {
      savePendingTask({
        nodeId,
        projectId,
        nodeType: resultField === 'videos' ? 'ai-video' : resultField === 'audios' ? 'ai-audio' : 'ai-image',
        provider: 'general',
        taskId: '',
        taskType: 'general',
        apiKey,
        baseUrl,
        submitted: false,
      });
    }
  }

  const apiUrl = baseUrl.replace(/\/+$/, '') + '/images/generations';
  const submitResp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, prompt, n: 1 }),
  });

  if (!submitResp.ok) {
    const errBody = await submitResp.text().catch(() => '');
    if (nodeId) removePendingTask(nodeId);
    throw new Error(`提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
  }

  const submitResult = await submitResp.json() as Record<string, unknown>;
  const taskId = (submitResult.data as Array<{ task_id: string }>)?.[0]?.task_id
    || (submitResult.task_id as string);

  // 无 task_id 时尝试直接从响应中解析结果（同步完成，无需轮询）
  if (!taskId) {
    if (nodeId) removePendingTask(nodeId);
    const url = parseMultiPathResponse(submitResult, resultField);
    if (url) return { url };
    // 尝试标准 OpenAI 图片格式
    const dataArr = submitResult.data as Array<{ url: string }> | undefined;
    if (dataArr?.[0]?.url) return { url: dataArr[0].url };
    throw new Error('响应格式异常：未返回 task_id 或结果 URL');
  }

  // 回填 taskId，标记为已提交
  if (nodeId) {
    updatePendingTask(nodeId, { taskId, submitted: true });
  }

  // 轮询直到任务完成/失败（不设超时，仅 ComfyUI 才设超时）
  const signal = nodeId ? registerNodePolling(nodeId) : undefined;
  const pollPromise = pollTask<Record<string, unknown>, { url: string }>({
    fetchState: async () => {
      const pollResp = await fetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!pollResp.ok) throw new Error(`HTTP ${pollResp.status}`);
      return (await pollResp.json()) as Record<string, unknown>;
    },
    isComplete: (raw) => {
      const task = (raw.data ?? raw) as Record<string, unknown>;
      if (task.status === 'completed') {
        const url = parseMultiPathResponse((task.result ?? raw) as Record<string, unknown>, resultField);
        if (url) return { url };
        throw new Error('任务完成但未返回结果');
      }
      return null;
    },
    isFailed: (raw) => {
      const task = (raw.data ?? raw) as Record<string, unknown>;
      return task.status === 'failed' || task.status === 'error'
        ? `任务失败: ${task.status}` : null;
    },
    interval: 3000,
    onFetchError: 'continue',
    signal,
  });

  // 无论成功还是失败，完成后都清理待续记录和 AbortController
  pollPromise.finally(() => {
    if (nodeId) {
      cleanupNodePolling(nodeId);
      removePendingTask(nodeId);
    }
  });
  return pollPromise;
}
/** APIMart 图片生成 — 异步提交 + 轮询 */
export async function generateApimartImage(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  imageSize: string,
  aspectRatio: string,
  dimensions: { width: number; height: number },
  imageUrls: string[] = [],
  nodeId?: string,
): Promise<{ url: string; width: number; height: number }> {
  const batch = await generateApimartImagesBatch(
    apiKey, baseUrl, model, prompt, imageSize, aspectRatio,
    dimensions, imageUrls, 1, nodeId,
  );
  const result = batch.results[0];
  if (!result) throw new Error('APIMart 生成完成但未返回图片');
  return result;
}

export async function generateApimartImagesBatch(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  imageSize: string,
  aspectRatio: string,
  dimensions: { width: number; height: number },
  imageUrls: string[] = [],
  count = 1,
  nodeId?: string,
): Promise<BatchImageResult> {
  const requestedCount = Math.max(1, Math.floor(count));
  // 预存待续任务（在 fetch 之前），确保关窗重启后能恢复
  if (nodeId) {
    const projectId = useAppStore.getState().currentProjectId;
    if (projectId) {
      savePendingTask({
        nodeId,
        projectId,
        nodeType: 'ai-image',
        provider: 'apimart',
        taskId: '',
        taskType: 'apimart',
        apiKey,
        baseUrl,
        batchCount: requestedCount,
        submitted: false,
      });
    }
  }

  // 步骤 1: 提交生成任务
  const submitBody: Record<string, unknown> = {
    model,
    prompt,
    n: requestedCount,
    resolution: imageSize,
    size: aspectRatio,
  };
  if (imageUrls.length > 0) {
    submitBody.image_urls = imageUrls;
  }
  const submitResp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submitBody),
  });

  if (!submitResp.ok) {
    const errBody = await submitResp.text().catch(() => '');
    if (nodeId) removePendingTask(nodeId);
    throw new Error(`APIMart 生成提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
  }

  const submitResult = await submitResp.json() as { code: number; data: Array<{ task_id: string; status: string }> };
  const taskId = submitResult.data?.[0]?.task_id;
  if (!taskId) {
    if (nodeId) removePendingTask(nodeId);
    throw new Error('APIMart 生成提交失败: 未返回 task_id');
  }

  // 回填 taskId，标记为已提交
  if (nodeId) {
    updatePendingTask(nodeId, { taskId, submitted: true });
  }

  // 步骤 2: 轮询任务直到完成/失败（不设超时，仅 ComfyUI 才设超时）
  const signal = nodeId ? registerNodePolling(nodeId) : undefined;
  const pollPromise = pollTask<ApimartTaskResult<{ images?: Array<{ url: string[] }> }>, BatchImageResult>({
    fetchState: () => fetchApimartTask(apiKey, baseUrl, taskId),
    isComplete: (task) => {
      if (task.status === 'completed') {
        const imageUrls = task.result?.images?.flatMap((img) => splitCommaSeparatedUrls(img.url)) ?? [];
        if (imageUrls.length === 0) throw new Error('APIMart 生成完成但未返回图片');
        const results = imageUrls.slice(0, requestedCount).map((url) => ({
          url,
          width: dimensions.width,
          height: dimensions.height,
        }));
        return {
          requestedCount,
          results,
          failedCount: Math.max(0, requestedCount - results.length),
        };
      }
      return null;
    },
    isFailed: (task) => getApimartFailureMessage(task, 'APIMart 图片生成失败'),
    interval: 2000,
    signal,
  });
  return pollPromise.finally(() => {
    if (nodeId) {
      cleanupNodePolling(nodeId);
      removePendingTask(nodeId);
    }
  });
}
/** 获取单次 APIMart 轮询数据并标准化为 task 对象 */
export async function fetchApimartTask<TResult = Record<string, unknown>>(
  apiKey: string,
  baseUrl: string,
  taskId: string,
): Promise<ApimartTaskResult<TResult>> {
  const resp = await fetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`APIMart 任务查询失败 (${resp.status}): ${errBody.slice(0, 200)}`);
  }
  const raw = (await resp.json()) as Record<string, unknown>;
  // 归一化：API 返回 { code, data: { status, progress, result } }，将 data 字段提升到顶层
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    const d = raw.data as Record<string, unknown>;
    return {
      code: raw.code as number,
      status: (d.status ?? raw.status) as string | undefined,
      progress: (d.progress ?? raw.progress) as number | undefined,
      result: d.result as TResult | undefined,
      error: (d.error ?? raw.error) as ApimartTaskError | undefined,
    };
  }
  return raw as unknown as ApimartTaskResult<TResult>;
}

/** APIMart 视频生成 — 异步提交 + 轮询 */
export async function generateApimartVideo(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  nodeId?: string,
  params: ApimartSeedanceRequestParams = {},
): Promise<{ url: string }> {
  // 预存待续任务（在 fetch 之前），确保关窗重启后能恢复
  if (nodeId) {
    const projectId = useAppStore.getState().currentProjectId;
    if (projectId) {
      savePendingTask({
        nodeId,
        projectId,
        nodeType: 'ai-video',
        provider: 'apimart',
        taskId: '',
        taskType: 'apimart',
        apiKey,
        baseUrl,
        submitted: false,
      });
    }
  }

  const seedanceRequest = buildApimartSeedanceRequest(model, prompt, params);
  const submitPath = seedanceRequest ? '/videos/generations' : '/images/generations';
  const requestBody = seedanceRequest ?? { model, prompt, n: 1 };

  // 步骤 1: 提交视频生成任务
  const submitResp = await fetch(`${baseUrl}${submitPath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!submitResp.ok) {
    const errBody = await submitResp.text().catch(() => '');
    if (nodeId) removePendingTask(nodeId);
    throw new Error(`APIMart 视频提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
  }

  const submitResult = await submitResp.json() as { code: number; data: Array<{ task_id: string; status: string }> };
  const taskId = submitResult.data?.[0]?.task_id;
  if (!taskId) {
    if (nodeId) removePendingTask(nodeId);
    throw new Error('APIMart 视频提交失败: 未返回 task_id');
  }

  // 回填 taskId，标记为已提交
  if (nodeId) {
    updatePendingTask(nodeId, { taskId, submitted: true });
  }

  // 步骤 2: 轮询（不设超时，仅 ComfyUI 才设超时）
  const signal = nodeId ? registerNodePolling(nodeId) : undefined;
  const pollPromise = pollTask<
    ApimartTaskResult<{ images?: Array<{ url: string[] }>; videos?: Array<{ url: string[] }> }>,
    { url: string }
  >({
    fetchState: () => fetchApimartTask(apiKey, baseUrl, taskId),
    isComplete: (task) => {
      if (task.status === 'completed') {
        const videoUrls = task.result?.videos?.flatMap((v) => splitCommaSeparatedUrls(v.url)) ?? [];
        const imageUrls = task.result?.images?.flatMap((img) => splitCommaSeparatedUrls(img.url)) ?? [];
        const allUrls = videoUrls.length > 0 ? videoUrls : imageUrls;
        if (allUrls.length === 0) throw new Error('APIMart 视频生成完成但未返回结果');
        return { url: allUrls[0] };
      }
      return null;
    },
    interval: 3000,
    signal,
  });
  pollPromise.finally(() => {
    if (nodeId) {
      cleanupNodePolling(nodeId);
      removePendingTask(nodeId);
    }
  });
  return pollPromise;
}
