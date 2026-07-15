/**
 * pollManager — 待续任务管理器
 *
 * 记录正在轮询的异步任务到 localStorage，支持：
 * - 切换项目后恢复轮询
 * - 关闭应用后重新打开继续轮询
 *
 * 存储结构按 projectId 隔离，每个节点最多一条待续记录。
 */
import { pollTask } from './pollTask';
import { useAppStore } from '../store/useAppStore';
import { downloadUrlAndSave } from './fileService';
import { applyImageBatchResults } from './imageBatchService';
import { mapImageDimensions } from './aiDimensions';
import type { BaseNodeData, NodeType } from '../types';

// ═══════════════════════════════════════════
// AbortController 注册表 — 节点删除时取消轮询
// ═══════════════════════════════════════════

const abortControllers = new Map<string, AbortController>();

function abortNodePolling(nodeId: string): void {
  const controller = abortControllers.get(nodeId);
  if (controller) {
    controller.abort();
    abortControllers.delete(nodeId);
  }
}

/** 为节点注册轮询控制器，返回 AbortSignal 传给 pollTask */
export function registerNodePolling(nodeId: string): AbortSignal {
  abortNodePolling(nodeId); // 先取消旧轮询，但保留 pending task 以支持恢复
  const controller = new AbortController();
  abortControllers.set(nodeId, controller);
  return controller.signal;
}

/** 取消节点的轮询（节点被删除时调用，同时清理 pending task） */
export function cancelNodePolling(nodeId: string): void {
  abortNodePolling(nodeId);
  // 同时清理 localStorage 中的待续任务记录
  removePendingTask(nodeId);
}

/** 轮询正常结束/失败后清理注册表（不调用 abort） */
export function cleanupNodePolling(nodeId: string): void {
  abortControllers.delete(nodeId);
}

// ═══════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════

export interface PendingTask {
  nodeId: string;
  projectId: string;
  nodeType: NodeType;
  provider: string;
  taskId: string;
  taskType: 'apimart' | 'dreamina' | 'comfyui' | 'general' | 'volcengine';
  /** 恢复轮询用：API Key */
  apiKey?: string;
  /** 恢复轮询用：服务地址 */
  baseUrl?: string;
  /** APIMart 原生批量图片任务请求数量；旧记录缺省为 1。 */
  batchCount?: number;
  /** 任务是否已向远端提交（false 表示仅预设了 status=loading 但还未拿到 taskId） */
  submitted: boolean;
}

// ═══════════════════════════════════════════
// localStorage 持久化
// ═══════════════════════════════════════════

const STORAGE_KEY = 'ai_canvas_pending_tasks';

function loadAll(): PendingTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAll(tasks: PendingTask[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

/** 保存一条待续任务（同一 nodeId 会覆盖旧记录） */
export function savePendingTask(task: PendingTask): void {
  const tasks = loadAll().filter((t) => t.nodeId !== task.nodeId);
  tasks.push(task);
  saveAll(tasks);
}

/** 更新已保存的待续任务（如回填 taskId） */
export function updatePendingTask(nodeId: string, patch: Partial<PendingTask>): void {
  const tasks = loadAll();
  const idx = tasks.findIndex((t) => t.nodeId === nodeId);
  if (idx === -1) return;
  tasks[idx] = { ...tasks[idx], ...patch };
  saveAll(tasks);
}

/** 移除一条待续任务（轮询完成/失败/取消时调用） */
export function removePendingTask(nodeId: string): void {
  const tasks = loadAll();
  const task = tasks.find((t) => t.nodeId === nodeId);
  const currentProjectId = useAppStore.getState().currentProjectId;

  // 后台请求可能在用户切换到其他项目后才结束。此时不能删除原项目的
  // pending 记录，否则切回去时 loading 节点会被当作孤立任务。
  if (task && currentProjectId && task.projectId !== currentProjectId) {
    return;
  }

  saveAll(tasks.filter((t) => t.nodeId !== nodeId));
}

/** 清理指定项目的所有待续任务 */
export function clearProjectTasks(projectId: string): void {
  const tasks = loadAll().filter((t) => t.projectId !== projectId);
  saveAll(tasks);
}

/** 获取指定项目的所有待续任务 */
export function getPendingTasksForProject(projectId: string): PendingTask[] {
  return loadAll().filter((t) => t.projectId === projectId);
}

// ═══════════════════════════════════════════
// 结果应用（镜像 AINodeDialog 的完成逻辑）
// ═══════════════════════════════════════════

async function applyNodeResult(
  nodeId: string,
  resultUrl: string,
  nodeLabel: string,
): Promise<void> {
  const store = useAppStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const data = node.data as BaseNodeData;
  const nodeType = data.type;
  const currentProjectId = store.currentProjectId;

  // 下载远程 URL 到本地
  const saved = currentProjectId
    ? await downloadUrlAndSave(resultUrl, currentProjectId, nodeType, nodeLabel).catch(() => null)
    : null;
  const mediaUrl = saved?.assetUrl || resultUrl;

  const updateData: Partial<BaseNodeData> = {
    output: resultUrl,
    sourceUrl: resultUrl,
    filePath: saved?.filePath,
    thumbnailUrl: resultUrl,
    status: 'success',
  };

  if (nodeType === 'ai-image' || nodeType === 'ai-panorama') {
    updateData.imageUrl = mediaUrl;
  } else if (nodeType === 'ai-video') {
    updateData.videoUrl = mediaUrl;
  } else if (nodeType === 'ai-audio') {
    updateData.audioUrl = mediaUrl;
  }

  store.updateNodeData(nodeId, updateData);
  store.recordOutputHistory(nodeId, {
    nodeId,
    nodeLabel,
    timestamp: Date.now(),
    prompt: (data.prompt as string) || '',
    output: resultUrl,
    nodeType,
    model: (data.model as string) || '',
    provider: (data.provider as string) || '',
    status: 'success',
    mediaUrl: resultUrl,
    filePath: saved?.filePath,
  });
  store.showToast(`${nodeLabel} 生成已完成`);
}

async function handleResumeError(
  nodeId: string,
  err: unknown,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err || '任务恢复失败');
  useAppStore.getState().updateNodeData(nodeId, { status: 'error', error: msg });
  cleanupNodePolling(nodeId);
  removePendingTask(nodeId);
}

// ═══════════════════════════════════════════
// 各供应商恢复逻辑
// ═══════════════════════════════════════════

/* ── APIMart ── */

interface ApimartTaskResult<TResult = Record<string, unknown>> {
  code: number;
  status?: string;
  progress?: number;
  result?: TResult;
}

async function fetchApimartTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
): Promise<ApimartTaskResult> {
  const resp = await fetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = (await resp.json()) as Record<string, unknown>;
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    const d = raw.data as Record<string, unknown>;
    return {
      code: raw.code as number,
      status: (d.status ?? raw.status) as string | undefined,
      progress: (d.progress ?? raw.progress) as number | undefined,
      result: d.result as Record<string, unknown> | undefined,
    };
  }
  return raw as unknown as ApimartTaskResult;
}

function extractApimartUrls(
  result: Record<string, unknown> | undefined,
  nodeType: NodeType,
): string[] {
  if (!result) return [];
  if (nodeType === 'ai-video') {
    const videos = result.videos as Array<{ url: string[] }> | undefined;
    if (videos?.[0]?.url?.[0]) return [videos[0].url[0]];
  }
  if (nodeType === 'ai-audio') {
    const audios = result.audios as Array<{ url: string[] }> | undefined;
    if (audios?.[0]?.url?.[0]) return [audios[0].url[0]];
  }
  const images = result.images as Array<{ url: string[] }> | undefined;
  return images?.flatMap((image) => image.url) ?? [];
}

async function resumeApimart(task: PendingTask): Promise<void> {
  const { nodeId, taskId, apiKey, baseUrl, nodeType } = task;
  if (!apiKey || !baseUrl) {
    useAppStore.getState().updateNodeData(nodeId, { status: 'error', error: '任务恢复失败：缺少 API 配置' });
    removePendingTask(nodeId);
    return;
  }
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const nodeData = node?.data as BaseNodeData | undefined;
  const label = nodeData?.label || '';

  const signal = registerNodePolling(nodeId);

  try {
    const { urls } = await pollTask<ApimartTaskResult, { urls: string[] }>({
      fetchState: () => fetchApimartTask(apiKey, baseUrl, taskId),
      isComplete: (t) => {
        if (t.status === 'completed') {
          const resolved = extractApimartUrls(t.result, nodeType);
          if (resolved.length > 0) return { urls: resolved };
          throw new Error('任务完成但未返回结果');
        }
        return null;
      },
      isFailed: (t) =>
        t.status === 'failed' || t.status === 'error' ? `任务失败: ${t.status}` : null,
      interval: 3000,
      onFetchError: 'continue',
      signal,
    });
    const requestedCount = Math.max(1, task.batchCount ?? 1);
    if (nodeType === 'ai-image' && requestedCount > 1 && nodeData) {
      const imageSize = (nodeData.imageSize as string) || '2K';
      const aspectRatio = (nodeData.aspectRatio as string) || '1:1';
      const dimensions = mapImageDimensions(imageSize, aspectRatio);
      const results = urls.slice(0, requestedCount).map((url) => ({ url, ...dimensions }));
      await applyImageBatchResults({
        nodeId,
        batch: {
          requestedCount,
          results,
          failedCount: Math.max(0, requestedCount - results.length),
        },
        projectId: task.projectId,
        prompt: (nodeData.prompt as string) || '',
        imageSize,
        aspectRatio,
      });
    } else {
      await applyNodeResult(nodeId, urls[0], label);
    }
    removePendingTask(nodeId);
  } catch (err) {
    await handleResumeError(nodeId, err);
  } finally {
    cleanupNodePolling(nodeId);
  }
}

/* ── 即梦 ── */

interface DreaminaOutput {
  url: string;
  localPath: string;
}
interface DreaminaQuery {
  status: 'pending' | 'success' | 'failed';
  outputs: DreaminaOutput[];
  failReason: string;
}

async function resumeDreamina(task: PendingTask): Promise<void> {
  const { nodeId, taskId } = task;
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';

  const signal = registerNodePolling(nodeId);

  try {
    const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
    const out = await pollTask<DreaminaQuery, DreaminaOutput>({
      fetchState: () => invoke<DreaminaQuery>('dreamina_query_result', { submitId: taskId }),
      isComplete: (r) =>
        r.status === 'success' && r.outputs.length > 0 ? r.outputs[0] : null,
      isFailed: (r) =>
        r.status === 'failed' ? r.failReason || '即梦生成失败' : null,
      interval: 3000,
      maxDuration: 60 * 60 * 1000,
      timeoutMsg: '即梦生成超时',
      onFetchError: 'throw',
      signal,
    });

    const url = out.localPath ? convertFileSrc(out.localPath) : out.url;
    await applyNodeResult(nodeId, url, label);
    removePendingTask(nodeId);
  } catch (err) {
    await handleResumeError(nodeId, err);
  } finally {
    cleanupNodePolling(nodeId);
  }
}

/* ── ComfyUI ── */

interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}
interface ComfyOutputNode {
  images?: ComfyOutputFile[];
  videos?: ComfyOutputFile[];
  gifs?: ComfyOutputFile[];
  audios?: ComfyOutputFile[];
}
type ComfyOutputs = Record<string, ComfyOutputNode>;

function buildComfyFileUrl(baseUrl: string, file: ComfyOutputFile): string {
  const subfolder = file.subfolder
    ? `&subfolder=${encodeURIComponent(file.subfolder)}`
    : '';
  const type = file.type
    ? `&type=${encodeURIComponent(file.type)}`
    : '&type=output';
  return `${baseUrl}/view?filename=${encodeURIComponent(file.filename)}${subfolder}${type}`;
}

async function resumeComfyUI(task: PendingTask): Promise<void> {
  const { nodeId, taskId, baseUrl, nodeType } = task;
  if (!baseUrl) {
    useAppStore.getState().updateNodeData(nodeId, {
      status: 'error',
      error: '任务恢复失败：缺少 ComfyUI 地址',
    });
    removePendingTask(nodeId);
    return;
  }
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';

  const signal = registerNodePolling(nodeId);

  const extract = (
    nodeType === 'ai-video'
      ? (outputs: ComfyOutputs) => {
          for (const o of Object.values(outputs)) {
            if (o.videos?.length) return { url: buildComfyFileUrl(baseUrl, o.videos[0]) };
            if (o.gifs?.length) return { url: buildComfyFileUrl(baseUrl, o.gifs[0]) };
            if (o.images?.length) return { url: buildComfyFileUrl(baseUrl, o.images[0]) };
          }
          return null;
        }
      : nodeType === 'ai-audio'
        ? (outputs: ComfyOutputs) => {
            for (const o of Object.values(outputs)) {
              if (o.audios?.length) return { url: buildComfyFileUrl(baseUrl, o.audios[0]) };
              if (o.videos?.length) return { url: buildComfyFileUrl(baseUrl, o.videos[0]) };
            }
            return null;
          }
        : (outputs: ComfyOutputs) => {
            for (const o of Object.values(outputs)) {
              if (o.images?.length) return { url: buildComfyFileUrl(baseUrl, o.images[0]) };
            }
            return null;
          }
  );

  try {
    const { url } = await pollTask<ComfyOutputs | undefined, { url: string }>({
      fetchState: async () => {
        const res = await fetch(`${baseUrl}/history/${taskId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const history = (await res.json()) as Record<string, unknown>;
        const entry = history[taskId] as Record<string, unknown> | undefined;
        return entry?.outputs as ComfyOutputs | undefined;
      },
      isComplete: (outputs) => (outputs ? extract(outputs) : null),
      interval: 3000,
      maxAttempts: 1200,
      onFetchError: 'continue',
      timeoutMsg: 'ComfyUI 任务恢复超时（1 小时）',
      signal,
    });
    await applyNodeResult(nodeId, url, label);
    removePendingTask(nodeId);
  } catch (err) {
    await handleResumeError(nodeId, err);
  } finally {
    cleanupNodePolling(nodeId);
  }
}

/* ── 通用异步 ── */

function parseMultiPathResponse(
  json: Record<string, unknown>,
  primaryField: string,
  fallbackFields: string[] = ['images'],
): string | undefined {
  const primary = json[primaryField] as Array<{ url?: string | string[] }> | undefined;
  if (primary?.[0]?.url) {
    const u = primary[0].url;
    return Array.isArray(u) ? u[0] : u;
  }
  for (const field of fallbackFields) {
    const arr = json[field] as Array<{ url?: string | string[] }> | undefined;
    if (arr?.[0]?.url) {
      const u = arr[0].url;
      return Array.isArray(u) ? u[0] : u;
    }
  }
  return undefined;
}

async function resumeGeneral(task: PendingTask): Promise<void> {
  const { nodeId, taskId, apiKey, baseUrl, nodeType } = task;
  if (!apiKey || !baseUrl) {
    useAppStore.getState().updateNodeData(nodeId, {
      status: 'error',
      error: '任务恢复失败：缺少 API 配置',
    });
    removePendingTask(nodeId);
    return;
  }
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';
  const resultField =
    nodeType === 'ai-video' ? 'videos' : nodeType === 'ai-audio' ? 'audios' : 'images';

  const signal = registerNodePolling(nodeId);

  try {
    const { url } = await pollTask<Record<string, unknown>, { url: string }>({
      fetchState: async () => {
        const pollResp = await fetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!pollResp.ok) throw new Error(`HTTP ${pollResp.status}`);
        return (await pollResp.json()) as Record<string, unknown>;
      },
      isComplete: (raw) => {
        const t = (raw.data ?? raw) as Record<string, unknown>;
        if (t.status === 'completed') {
          const resolved = parseMultiPathResponse(
            (t.result ?? raw) as Record<string, unknown>,
            resultField,
          );
          if (resolved) return { url: resolved };
          throw new Error('任务完成但未返回结果');
        }
        return null;
      },
      isFailed: (raw) => {
        const t = (raw.data ?? raw) as Record<string, unknown>;
        return t.status === 'failed' || t.status === 'error'
          ? `任务失败: ${t.status}`
          : null;
      },
      interval: 3000,
      onFetchError: 'continue',
      signal,
    });
    await applyNodeResult(nodeId, url, label);
    removePendingTask(nodeId);
  } catch (err) {
    await handleResumeError(nodeId, err);
  } finally {
    cleanupNodePolling(nodeId);
  }
}

/* ── 火山方舟 Seedance ── */

async function resumeVolcengine(task: PendingTask): Promise<void> {
  const { nodeId, taskId, apiKey, baseUrl } = task;
  if (!apiKey || !baseUrl) {
    useAppStore.getState().updateNodeData(nodeId, {
      status: 'error',
      error: '任务恢复失败：缺少 API 配置',
    });
    removePendingTask(nodeId);
    return;
  }
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';

  const signal = registerNodePolling(nodeId);

  try {
    const { url } = await pollTask<Record<string, unknown>, { url: string }>({
      fetchState: async () => {
        const resp = await fetch(`${baseUrl}/contents/generations/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return (await resp.json()) as Record<string, unknown>;
      },
      isComplete: (raw) => {
        const status = raw.status as string;
        if (status === 'succeeded') {
          const content = raw.content as Record<string, unknown> | undefined;
          const videoUrl = content?.video_url as string | undefined;
          if (videoUrl) return { url: videoUrl };
          throw new Error('任务完成但未返回视频地址');
        }
        return null;
      },
      isFailed: (raw) => {
        const status = raw.status as string;
        if (status === 'failed') {
          const err = raw.error as { message?: string } | undefined;
          return `任务失败: ${err?.message || status}`;
        }
        return null;
      },
      interval: 3000,
      onFetchError: 'continue',
      signal,
    });
    await applyNodeResult(nodeId, url, label);
    removePendingTask(nodeId);
  } catch (err) {
    await handleResumeError(nodeId, err);
  } finally {
    cleanupNodePolling(nodeId);
  }
}

// ═══════════════════════════════════════════
// 恢复入口
// ═══════════════════════════════════════════

const RESUME_MAP: Record<PendingTask['taskType'], (task: PendingTask) => Promise<void>> = {
  apimart: resumeApimart,
  dreamina: resumeDreamina,
  comfyui: resumeComfyUI,
  general: resumeGeneral,
  volcengine: resumeVolcengine,
};

function isCancellationErrorMessage(message?: string): boolean {
  return message === '任务已被取消';
}

/**
 * 恢复指定项目下所有待续任务。
 * 仅对 status === 'loading' 的节点重新发起轮询。
 * 调用时机：应用初始化（initFromDb）、切换项目（switchProject）。
 */
export async function resumePendingTasks(projectId: string): Promise<void> {
  const store = useAppStore.getState();
  const tasks = getPendingTasksForProject(projectId);

  // 收集有 pending task 记录的节点 ID
  const coveredNodes = new Set(tasks.map((t) => t.nodeId));

  // 补充扫描：所有 status === 'loading' 但没有 pending task 记录的节点
  // 说明任务在保存"loading"状态后、savePendingTask 之前窗口关闭了
  const orphanLoadingNodes = store.nodes.filter(
    (n) => (n.data as BaseNodeData).status === 'loading' && !coveredNodes.has(n.id),
  );
  if (orphanLoadingNodes.length > 0) {
    console.warn(
      `[pollManager] 发现 ${orphanLoadingNodes.length} 个孤立 loading 节点（未完成提交），标记为错误`,
    );
    for (const node of orphanLoadingNodes) {
      store.updateNodeData(node.id, {
        status: 'error',
        error: '任务未完成提交，请重新点击生成',
      });
    }
  }

  if (tasks.length === 0) return;

  console.log(`[pollManager] 发现 ${tasks.length} 个待续任务，开始恢复...`);

  for (const task of tasks) {
    const node = store.nodes.find((n) => n.id === task.nodeId);
    const nodeData = node?.data as BaseNodeData | undefined;
    if (!node) {
      // 节点不存在或状态不为 loading，清理过期记录
      removePendingTask(task.nodeId);
      continue;
    }

    if (nodeData?.status !== 'loading') {
      if (
        task.submitted
        && task.taskId
        && nodeData?.status === 'error'
        && isCancellationErrorMessage(nodeData.error)
      ) {
        store.updateNodeData(task.nodeId, { status: 'loading', error: undefined });
      } else {
        // 节点已成功、失败或被用户改为其他状态，清理过期记录
        removePendingTask(task.nodeId);
        continue;
      }
    }

    // 任务记录存在但未提交到远端（关闭窗口时还没来得及拿到 taskId）
    if (!task.submitted || !task.taskId) {
      console.warn(`[pollManager] 任务 ${task.nodeId} 未完成远端提交，需要重新生成`);
      store.updateNodeData(task.nodeId, {
        status: 'error',
        error: '任务未完成提交，请重新点击生成',
      });
      removePendingTask(task.nodeId);
      continue;
    }

    if (abortControllers.has(task.nodeId)) {
      continue;
    }

    const resumeFn = RESUME_MAP[task.taskType];
    if (!resumeFn) {
      console.warn(`[pollManager] 未知任务类型: ${task.taskType}`);
      removePendingTask(task.nodeId);
      continue;
    }

    // 不 await：多个任务并行恢复
    resumeFn(task).catch((err) => {
      console.error(`[pollManager] 恢复任务失败 (${task.nodeId}):`, err);
    });
  }
}
