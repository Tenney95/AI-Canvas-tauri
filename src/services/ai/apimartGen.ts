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
import { buildImageCapabilityRequest, getImageCapability } from './mediaModelCapabilities';
import { corsSafeFetch } from './httpTransport';
import { mapImageParameters } from './imageParameterMappings';
import { runBatchTasks } from './batchUtils';

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

type ApimartMediaResult = { images?: Array<{ url?: string | string[] }> };

function extractApimartImageUrls(result?: ApimartMediaResult): string[] {
  return result?.images?.flatMap((image) => {
    if (Array.isArray(image.url)) return splitCommaSeparatedUrls(image.url);
    return typeof image.url === 'string' ? splitCommaSeparatedUrls([image.url]) : [];
  }) ?? [];
}

function getApimartFailureMessage(
  task: ApimartTaskResult,
  label: string,
): string | null {
  if (task.status !== 'failed' && task.status !== 'error' && task.status !== 'cancelled') return null;
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
  providerConfigId: string,
  nodeId?: string,
  externalSignal?: AbortSignal,
  requestBody?: Record<string, unknown>,
): Promise<{ url: string }> {
  const nodeSignal = nodeId ? registerNodePolling(nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  try {
    // 预存待续任务（在 fetch 之前），确保关窗重启后能恢复
    if (nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        savePendingTask({
          nodeId,
          projectId,
          nodeType: resultField === 'videos' ? 'ai-video' : resultField === 'audios' ? 'ai-audio' : 'ai-image',
          provider: 'general',
          providerConfigId,
          taskId: '',
          taskType: 'general',
          submitted: false,
        });
      }
    }

    const resource = resultField === 'audios' ? 'audio' : resultField;
    const apiUrl = `${baseUrl.replace(/\/+$/, '')}/${resource}/generations`;
    const submitResp = await corsSafeFetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody ?? { model: modelName, prompt, n: 1 }),
      signal,
    });

    if (!submitResp.ok) {
      const errBody = await submitResp.text().catch(() => '');
      throw new Error(`提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
    }

    const submitResult = await submitResp.json() as Record<string, unknown>;
    const taskId = (submitResult.data as Array<{ task_id: string }>)?.[0]?.task_id
      || (submitResult.task_id as string);

    // 无 task_id 时尝试直接从响应中解析结果（同步完成，无需轮询）
    if (!taskId) {
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
    return await pollTask<Record<string, unknown>, { url: string }>({
      fetchState: async () => {
        const pollResp = await corsSafeFetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
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
        return task.status === 'failed' || task.status === 'error' || task.status === 'cancelled'
          ? `任务失败: ${task.status}` : null;
      },
      interval: 3000,
      signal,
    });
  } finally {
    if (nodeId) {
      cleanupNodePolling(nodeId);
      removePendingTask(nodeId);
    }
  }
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
  externalSignal?: AbortSignal,
): Promise<BatchImageResult> {
  // 能力表驱动：命中 APIMart 生图能力表时，按模型约束分辨率 / 批量数量 / 参考图，
  // 并复用能力表换算出的结果回填尺寸；未命中则回退通用提交逻辑（兼容旧模型）。
  const requestedBatchCount = Math.max(1, Math.floor(count));
  const capability = getImageCapability(model);
  const capabilityRequest = buildImageCapabilityRequest(model, prompt, {
    resolution: imageSize,
    ratio: aspectRatio,
    count: requestedBatchCount,
    imageUrls,
  });
  const supportsNativeBatch = capability?.supportsBatch !== false;
  const requestedCount = capability && !supportsNativeBatch
    ? requestedBatchCount
    : (capabilityRequest?.requestedCount ?? requestedBatchCount);
  const effectiveDimensions = capabilityRequest?.dimensions ?? dimensions;
  const nodeSignal = nodeId ? registerNodePolling(nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  try {
    // 预存待续任务（在 fetch 之前），确保关窗重启后能恢复
    if (nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        savePendingTask({
          nodeId,
          projectId,
          nodeType: 'ai-image',
          provider: 'apimart',
          providerConfigId: 'apimart',
          taskId: '',
          taskType: 'apimart',
          batchCount: requestedCount,
          submitted: false,
        });
      }
    }

    // 原生批量模型一次提交 n 张；不支持 n 的模型拆成多次 n=1 提交。
    const nativeSubmitBody: Record<string, unknown> = capabilityRequest?.body ?? mapImageParameters(
      'apimart',
      model,
      {
        model,
        prompt,
        imageSize,
        aspectRatio,
        batchCount: requestedCount,
        referenceImageUrls: imageUrls,
      },
    );
    const submitBodies = supportsNativeBatch
      ? [nativeSubmitBody]
      : Array.from({ length: requestedCount }, () => ({ ...nativeSubmitBody, n: 1 }));
    const taskIdsBySubmission: string[][] = [];
    let firstError: unknown;
    const submitted = await runBatchTasks(submitBodies.length, 3, async (index) => {
      try {
        const submitResp = await corsSafeFetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(submitBodies[index]),
          signal,
        });
        if (!submitResp.ok) {
          const errBody = await submitResp.text().catch(() => '');
          throw new Error(`APIMart 生成提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
        }
        const submitResult = await submitResp.json() as {
          task_id?: string;
          data?: Array<{ task_id?: string }> | { task_id?: string };
        };
        const dataTaskIds = Array.isArray(submitResult.data)
          ? submitResult.data.flatMap((item) => item.task_id ? [item.task_id] : [])
          : submitResult.data?.task_id ? [submitResult.data.task_id] : [];
        const taskIds = [...dataTaskIds, ...(submitResult.task_id ? [submitResult.task_id] : [])];
        if (taskIds.length === 0) throw new Error('APIMart 生成提交失败: 未返回 task_id');
        taskIdsBySubmission[index] = taskIds;
        if (nodeId) {
          const persistedTaskIds = taskIdsBySubmission.flatMap((ids) => ids ?? []);
          updatePendingTask(nodeId, {
            taskId: persistedTaskIds[0],
            taskIds: persistedTaskIds,
            submitted: true,
          });
        }
        return taskIds;
      } catch (error) {
        firstError ??= error;
        throw error;
      }
    });
    const taskIds = submitted.results.flat();
    if (taskIds.length === 0) throw firstError || new Error('APIMart 生成提交失败');

    // 单个任务可返回多张图，也可能一次提交返回多个任务；两种形态统一汇总。
    const completed = await runBatchTasks(taskIds.length, 3, async (index) => {
      try {
        return await pollTask<ApimartTaskResult<ApimartMediaResult>, string[]>({
          fetchState: () => fetchApimartTask(apiKey, baseUrl, taskIds[index], signal),
          isComplete: (task) => {
            if (task.status !== 'completed') return null;
            const urls = extractApimartImageUrls(task.result);
            if (urls.length === 0) throw new Error('APIMart 生成完成但未返回图片');
            return urls;
          },
          isFailed: (task) => getApimartFailureMessage(task, 'APIMart 图片生成失败'),
          interval: 2000,
          signal,
        });
      } catch (error) {
        firstError ??= error;
        throw error;
      }
    });
    const urls = completed.results.flat().slice(0, requestedCount);
    if (urls.length === 0) throw firstError || new Error('APIMart 生成完成但未返回图片');
    const results = urls.map((url) => ({
      url,
      width: effectiveDimensions.width,
      height: effectiveDimensions.height,
    }));
    return {
      requestedCount,
      results,
      failedCount: Math.max(0, requestedCount - results.length),
    };
  } finally {
    if (nodeId) {
      cleanupNodePolling(nodeId);
      removePendingTask(nodeId);
    }
  }
}
/** 获取单次 APIMart 轮询数据并标准化为 task 对象 */
export async function fetchApimartTask<TResult = Record<string, unknown>>(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<ApimartTaskResult<TResult>> {
  const resp = await corsSafeFetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
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
  externalSignal?: AbortSignal,
): Promise<{ url: string }> {
  const nodeSignal = nodeId ? registerNodePolling(nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  try {
    // 预存待续任务（在 fetch 之前），确保关窗重启后能恢复
    if (nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        savePendingTask({
          nodeId,
          projectId,
          nodeType: 'ai-video',
          provider: 'apimart',
          providerConfigId: 'apimart',
          taskId: '',
          taskType: 'apimart',
          submitted: false,
        });
      }
    }

    const seedanceRequest = buildApimartSeedanceRequest(model, prompt, params);
    const submitPath = seedanceRequest ? '/videos/generations' : '/images/generations';
    const requestBody = seedanceRequest ?? mapImageParameters('apimart', model, {
      model,
      prompt,
      batchCount: 1,
    });

    // 步骤 1: 提交视频生成任务
    const submitResp = await corsSafeFetch(`${baseUrl}${submitPath}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!submitResp.ok) {
      const errBody = await submitResp.text().catch(() => '');
      throw new Error(`APIMart 视频提交失败 (${submitResp.status}): ${errBody.slice(0, 200)}`);
    }

    const submitResult = await submitResp.json() as { code: number; data: Array<{ task_id: string; status: string }> };
    const taskId = submitResult.data?.[0]?.task_id;
    if (!taskId) {
      throw new Error('APIMart 视频提交失败: 未返回 task_id');
    }

    // 回填 taskId，标记为已提交
    if (nodeId) {
      updatePendingTask(nodeId, { taskId, submitted: true });
    }

    // 步骤 2: 轮询（不设超时，仅 ComfyUI 才设超时）
    return await pollTask<
      ApimartTaskResult<{ images?: Array<{ url: string[] }>; videos?: Array<{ url: string[] }> }>,
      { url: string }
    >({
      fetchState: () => fetchApimartTask(apiKey, baseUrl, taskId, signal),
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
      isFailed: (task) => getApimartFailureMessage(task, 'APIMart 视频生成失败'),
      interval: 3000,
      signal,
    });
  } finally {
    if (nodeId) {
      cleanupNodePolling(nodeId);
      removePendingTask(nodeId);
    }
  }
}
