/**
 * dreaminaService — 即梦（Dreamina）模型调用
 *
 * 通过 Rust 命令驱动官方 dreamina_cli：dreamina_generate 提交任务拿 submitId，
 * dreamina_query_result 轮询直至产物就绪。产物优先用本地文件（convertFileSrc），
 * 避免线上地址过期。
 */
import { mapImageDimensions } from './aiDimensions';
import { pollTask } from './pollTask';
import { savePendingTask, updatePendingTask, removePendingTask, registerNodePolling, cleanupNodePolling, getVideoEditorTransitionAnchor } from './pollManager';
import { useAppStore } from '../store/useAppStore';
import { logAiRequest } from './ai/httpTransport';
import { getDreaminaImageModel, getDreaminaVideoCapability } from './ai/dreaminaModels';
import type { MediaReference } from '../types/aiTypes';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

const DREAMINA_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];

/** 节点比例 → CLI --ratio（不在支持集内则回退 1:1） */
function mapRatio(aspectRatio?: string): string {
  const r = (aspectRatio || '').trim();
  return DREAMINA_RATIOS.includes(r) ? r : '1:1';
}

/** imageSize + 模型版本 → CLI --resolution_type */
function mapResolution(imageSize: string | undefined, modelVersion: string): string {
  const size = (imageSize || '2K').toUpperCase();
  if (modelVersion.startsWith('3')) {
    return size === '1K' ? '1k' : '2k';
  }
  if (modelVersion.toLowerCase() === '5.0pro' && size === '1.5K') return '1.5k';
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

async function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    logAiRequest(`tauri://${cmd}`, {
      method: 'INVOKE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    }, 'Dreamina');
    const invokePromise = invoke<T>(cmd, args);
    if (!signal) return await invokePromise;
    return await new Promise<T>((resolve, reject) => {
      const handleAbort = () => {
        signal.removeEventListener('abort', handleAbort);
        reject(new DOMException('请求已取消', 'AbortError'));
      };
      signal.addEventListener('abort', handleAbort, { once: true });
      invokePromise.then(
        (result) => {
          signal.removeEventListener('abort', handleAbort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener('abort', handleAbort);
          reject(error);
        },
      );
    });
  } catch (e) {
    // Tauri 命令拒绝时抛出的是字符串，转成 Error 以便上层正确展示信息
    if (e instanceof Error) throw e;
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e), { cause: e });
  }
}

async function resolveOutputUrl(o: DreaminaOutput): Promise<string> {
  if (o.localPath) {
    return convertFileSrc(o.localPath);
  }
  return o.url;
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 60 * 60 * 1000; // 1 小时上限（视频可能较久）

async function pollResult(submitId: string, signal?: AbortSignal): Promise<DreaminaOutput> {
  return pollTask<DreaminaQuery, DreaminaOutput>({
    fetchState: () => invokeTauri<DreaminaQuery>('dreamina_query_result', { submitId }, signal),
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
}, externalSignal?: AbortSignal): Promise<{ url: string; width: number; height: number }> {
  const dims = mapImageDimensions(opts.imageSize || '2K', opts.aspectRatio || '1:1');
  const modelVersion = modelVersionOf(opts.model);
  const kind = opts.imageUrls.length > 0 ? 'image2image' : 'text2image';
  const nodeSignal = opts.nodeId ? registerNodePolling(opts.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  try {
    const imageModel = getDreaminaImageModel(opts.model);
    if (!imageModel) throw new Error(`即梦不支持图片模型版本“${modelVersion}”`);
    if (opts.imageUrls.length > 0 && !imageModel.supportsImageReference) {
      throw new Error(`${imageModel.label} 仅支持文生图，请移除参考图片或改用 4.0 及以上模型`);
    }
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

    const { submitId } = await invokeTauri<{ submitId: string }>('dreamina_generate', { params }, signal);

    // 回填 submitId，标记为已提交
    if (opts.nodeId) {
      updatePendingTask(opts.nodeId, { taskId: submitId, submitted: true });
    }

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

export interface BuildDreaminaVideoParamsOptions {
  prompt: string;
  model: string;
  references: readonly MediaReference[];
  ratio?: string;
  duration?: number;
  resolution?: string;
}

export function buildDreaminaVideoParams(
  opts: BuildDreaminaVideoParamsOptions,
): Record<string, unknown> {
  const capability = getDreaminaVideoCapability(opts.model);
  if (!capability) {
    throw new Error(`即梦不支持视频模型版本“${modelVersionOf(opts.model)}”`);
  }

  const images = opts.references.filter((item) => item.kind === 'image');
  const videos = opts.references.filter((item) => item.kind === 'video');
  const audios = opts.references.filter((item) => item.kind === 'audio');
  const totalReferences = images.length + videos.length + audios.length;
  if (images.length > capability.maxImageReferences
    || videos.length > capability.maxVideoReferences
    || audios.length > capability.maxAudioReferences
    || totalReferences > capability.maxTotalReferences) {
    throw new Error(
      `${capability.label} 参考素材超限：最多 ${capability.maxImageReferences} 张图片、`
      + `${capability.maxVideoReferences} 个视频、${capability.maxAudioReferences} 个音频，`
      + `总计 ${capability.maxTotalReferences} 个`,
    );
  }
  if (images.length === 0 && videos.length === 0 && audios.length > 0 && !capability.allowsAudioOnly) {
    throw new Error(`${capability.label} 使用参考音频时至少需要一张参考图或一个参考视频`);
  }

  const resolution = capability.resolutions.includes(opts.resolution ?? '')
    ? opts.resolution!
    : capability.defaultResolution;
  const ratio = capability.ratios.includes(opts.ratio ?? '')
    ? opts.ratio!
    : capability.defaultRatio;
  const duration = Math.min(
    capability.maxDuration,
    Math.max(capability.minDuration, Math.floor(opts.duration ?? capability.defaultDuration)),
  );
  const base: Record<string, unknown> = {
    prompt: opts.prompt,
    modelVersion: capability.version,
    duration,
    videoResolution: resolution,
  };

  const firstFrame = images.find((item) => item.role === 'first_frame');
  const lastFrame = images.find((item) => item.role === 'last_frame');
  const isFramePair = images.length === 2
    && videos.length === 0
    && audios.length === 0
    && firstFrame
    && lastFrame;
  if (isFramePair) {
    return { ...base, kind: 'frames2video', first: firstFrame.url, last: lastFrame.url };
  }
  if (firstFrame && images.length === 1 && videos.length === 0 && audios.length === 0) {
    return { ...base, kind: 'image2video', image: firstFrame.url };
  }
  if (firstFrame || lastFrame) {
    throw new Error('即梦首尾帧模式需要单独的首帧或一组首尾帧，不能仅提供尾帧或混用其他参考素材；请调整参考角色');
  }
  if (videos.length > 0 || audios.length > 0 || images.length > 0) {
    return {
      ...base,
      kind: 'multimodal2video',
      ratio,
      images: images.map((item) => item.url),
      videos: videos.map((item) => item.url),
      audios: audios.map((item) => item.url),
    };
  }
  return { ...base, kind: 'text2video', ratio };
}

/** 即梦视频生成：按素材自动选择文生、图生、首尾帧或全模态命令。 */
export async function generateDreaminaVideo(opts: {
  prompt: string;
  model: string;
  references: readonly MediaReference[];
  nodeId?: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
  beforeSubmit?: () => void | Promise<void>;
}, externalSignal?: AbortSignal): Promise<{ url: string }> {
  const nodeSignal = opts.nodeId ? registerNodePolling(opts.nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;
  try {
    const params = buildDreaminaVideoParams(opts);
    if (opts.beforeSubmit) await opts.beforeSubmit();

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

    const { submitId } = await invokeTauri<{ submitId: string }>('dreamina_generate', { params }, signal);

    // 回填 submitId，标记为已提交
    if (opts.nodeId) {
      updatePendingTask(opts.nodeId, { taskId: submitId, submitted: true });
    }

    const out = await pollResult(submitId, signal);
    const url = await resolveOutputUrl(out);
    if (!url) throw new Error('即梦未返回生成结果');
    return { url };
  } finally {
    if (opts.nodeId) {
      cleanupNodePolling(opts.nodeId);
      if (!getVideoEditorTransitionAnchor(opts.nodeId)) removePendingTask(opts.nodeId);
    }
  }
}
