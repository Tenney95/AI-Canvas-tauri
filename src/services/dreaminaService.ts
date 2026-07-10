/**
 * dreaminaService — 即梦（Dreamina）模型调用
 *
 * 通过 Rust 命令驱动官方 dreamina_cli：dreamina_generate 提交任务拿 submitId，
 * dreamina_query_result 轮询直至产物就绪。产物优先用本地文件（convertFileSrc），
 * 避免线上地址过期。
 */
import { mapImageDimensions } from './aiDimensions';
import { pollTask } from './pollTask';
import { savePendingTask, updatePendingTask, removePendingTask, registerNodePolling, cleanupNodePolling } from './pollManager';
import { useAppStore } from '../store/useAppStore';

const DREAMINA_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];

/** 节点比例 → CLI --ratio（不在支持集内则回退 1:1） */
function mapRatio(aspectRatio?: string): string {
  const r = (aspectRatio || '').trim();
  return DREAMINA_RATIOS.includes(r) ? r : '1:1';
}

/** imageSize + 模型版本 → CLI --resolution_type（3.x: 1k/2k；4.x/5.0: 2k/4k） */
function mapResolution(imageSize: string | undefined, modelVersion: string): string {
  const size = (imageSize || '2K').toUpperCase();
  if (modelVersion.startsWith('3')) {
    return size === '1K' ? '1k' : '2k';
  }
  return size === '4K' ? '4k' : '2k';
}

/** 'dreamina/4.0' → '4.0' */
function modelVersionOf(model: string): string {
  const i = model.indexOf('/');
  return i >= 0 ? model.slice(i + 1) : model;
}

interface DreaminaOutput {
  url: string;
  localPath: string;
}
interface DreaminaQuery {
  status: 'pending' | 'success' | 'failed';
  outputs: DreaminaOutput[];
  failReason: string;
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Tauri 命令拒绝时抛出的是字符串，转成 Error 以便上层正确展示信息
    if (e instanceof Error) throw e;
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e));
  }
}

async function resolveOutputUrl(o: DreaminaOutput): Promise<string> {
  if (o.localPath) {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    return convertFileSrc(o.localPath);
  }
  return o.url;
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 60 * 60 * 1000; // 1 小时上限（视频可能较久）

async function pollResult(submitId: string, signal?: AbortSignal): Promise<DreaminaOutput> {
  return pollTask<DreaminaQuery, DreaminaOutput>({
    fetchState: () => invokeTauri<DreaminaQuery>('dreamina_query_result', { submitId }),
    isComplete: (r) => r.status === 'success' && r.outputs.length > 0 ? r.outputs[0] : null,
    isFailed: (r) => r.status === 'failed' ? (r.failReason || '即梦生成失败') : null,
    interval: POLL_INTERVAL_MS,
    maxDuration: MAX_POLL_MS,
    timeoutMsg: '即梦生成超时',
    onFetchError: 'throw',
    signal,
  });
}

/** 即梦图片生成（无参考图 → text2image；有参考图 → image2image） */
export async function generateDreaminaImage(opts: {
  prompt: string;
  model: string;
  imageSize?: string;
  aspectRatio?: string;
  imageUrls: string[];
  nodeId?: string;
}): Promise<{ url: string; width: number; height: number }> {
  const dims = mapImageDimensions(opts.imageSize || '2K', opts.aspectRatio || '1:1');
  const modelVersion = modelVersionOf(opts.model);
  const kind = opts.imageUrls.length > 0 ? 'image2image' : 'text2image';
  const params: Record<string, unknown> = {
    kind,
    prompt: opts.prompt,
    ratio: mapRatio(opts.aspectRatio),
    resolutionType: mapResolution(opts.imageSize, modelVersion),
  };
  // image2image 不支持 1k；model_version 为版本号时透传
  if (modelVersion && /^\d/.test(modelVersion)) params.modelVersion = modelVersion;
  if (kind === 'image2image') params.images = opts.imageUrls;

  // 预存待续任务（在 invoke 之前），确保关窗重启后能恢复
  if (opts.nodeId) {
    const projectId = useAppStore.getState().currentProjectId;
    if (projectId) {
      savePendingTask({
        nodeId: opts.nodeId,
        projectId,
        nodeType: 'ai-image',
        provider: 'dreamina',
        taskId: '',
        taskType: 'dreamina',
        submitted: false,
      });
    }
  }

  const { submitId } = await invokeTauri<{ submitId: string }>('dreamina_generate', { params });

  // 回填 submitId，标记为已提交
  if (opts.nodeId) {
    updatePendingTask(opts.nodeId, { taskId: submitId, submitted: true });
  }

  const signal = opts.nodeId ? registerNodePolling(opts.nodeId) : undefined;
  try {
    const out = await pollResult(submitId, signal);
    const url = await resolveOutputUrl(out);
    if (!url) throw new Error('即梦未返回生成结果');
    return { url, width: dims.width, height: dims.height };
  } finally {
    if (opts.nodeId) {
      cleanupNodePolling(opts.nodeId);
      removePendingTask(opts.nodeId);
    }
  }
}

/** 即梦视频生成（无参考图 → text2video；有参考图 → image2video） */
export async function generateDreaminaVideo(opts: {
  prompt: string;
  model: string;
  imageUrls: string[];
  nodeId?: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
}): Promise<{ url: string }> {
  const modelVersion = modelVersionOf(opts.model);
  const hasImage = opts.imageUrls.length > 0;
  const params: Record<string, unknown> = {
    kind: hasImage ? 'image2video' : 'text2video',
    prompt: opts.prompt,
  };
  // 仅透传 seedance* 系列视频模型版本，其余用 CLI 默认，避免无效组合
  if (modelVersion.startsWith('seedance')) params.modelVersion = modelVersion;
  if (hasImage) params.image = opts.imageUrls[0];

  // Seedance 视频参数 — 与火山方舟共用同一套参数
  if (opts.ratio && !hasImage) {
    // image2video 时比例由参考图决定，不传 --ratio
    params.ratio = opts.ratio;
  }
  if (opts.duration != null && opts.duration >= 2 && opts.duration <= 15) {
    params.duration = opts.duration;
  }
  if (opts.resolution) {
    params.videoResolution = opts.resolution;
  }

  // 预存待续任务（在 invoke 之前），确保关窗重启后能恢复
  if (opts.nodeId) {
    const projectId = useAppStore.getState().currentProjectId;
    if (projectId) {
      savePendingTask({
        nodeId: opts.nodeId,
        projectId,
        nodeType: 'ai-video',
        provider: 'dreamina',
        taskId: '',
        taskType: 'dreamina',
        submitted: false,
      });
    }
  }

  const { submitId } = await invokeTauri<{ submitId: string }>('dreamina_generate', { params });

  // 回填 submitId，标记为已提交
  if (opts.nodeId) {
    updatePendingTask(opts.nodeId, { taskId: submitId, submitted: true });
  }

  const signal = opts.nodeId ? registerNodePolling(opts.nodeId) : undefined;
  try {
    const out = await pollResult(submitId, signal);
    const url = await resolveOutputUrl(out);
    if (!url) throw new Error('即梦未返回生成结果');
    return { url };
  } finally {
    if (opts.nodeId) {
      cleanupNodePolling(opts.nodeId);
      removePendingTask(opts.nodeId);
    }
  }
}
