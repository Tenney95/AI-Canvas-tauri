/** Kling 新版图片响应与原任务查询合同；不推断生成任务已失败。 */
import type { ResolvedModelProtocolPoll } from '../../../types/aiTypes';
import { ModelProtocolHttpError } from '../modelProtocolHttp';
import { isRecord } from '../modelProtocolShared';
import { parseRasterImageDimensions } from '../../rasterImageDimensions';
import { isRemoteMediaUrl } from '../../../utils/mediaUrl';
import type { ModelProtocolVariables } from '../modelProtocolTypes';

export async function resolveKlingInlineReferences(urls: string[], signal?: AbortSignal): Promise<string[]> {
  const local = urls.filter((url) => !isRemoteMediaUrl(url));
  if (!local.length) return urls;
  const { IMAGE_GENERATION_DATA_URL_BUDGET, resolveImageDataUrlArray } = await import('../imageUtils');
  const inline = await resolveImageDataUrlArray(local, signal, {
    maxImages: 10, maxImageBytes: 30_000_000, maxTotalBytes: IMAGE_GENERATION_DATA_URL_BUDGET.maxTotalBytes,
  });
  let index = 0;
  return urls.map((url) => isRemoteMediaUrl(url) ? url : inline[index++]);
}

const isKlingRemoteReference: (url: string) => boolean = isRemoteMediaUrl;

export function klingImageReferenceValue(url: string): string {
  if (isKlingRemoteReference(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error('Kling 参考地址不能包含登录凭据');
    return url;
  }
  const match = /^data:image\/(png|jpe?g);base64,/i.exec(url);
  if (!match) throw new Error('Kling 参考图仅支持 PNG / JPEG，请转换格式后重试');
  const base64 = url.slice(match[0].length);
  // PNG 的宽高在 IHDR 固定位置，JPEG 标记则需在有限的头部范围内查找。
  const sample = base64.slice(0, match[1].toLowerCase() === 'png' ? 48 : 1_398_104);
  const decoded = atob(sample);
  const header = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) header[i] = decoded.charCodeAt(i);
  const dimensions = parseRasterImageDimensions(header);
  if (!dimensions || dimensions.width < 300 || dimensions.height < 300
    || dimensions.width / dimensions.height < 2 / 5 || dimensions.width / dimensions.height > 5 / 2) {
    throw new Error('Kling 参考图宽高均须至少 300 像素，比例须在 2:5 至 5:2 之间');
  }
  return base64;
}

/** Use the same order for prompt bindings and the transmitted contents. */
export function orderKlingFrames<T extends { role?: unknown }>(images: readonly T[]): Array<{ image: T; type: 'first_frame' | 'middle_frame' | 'last_frame' }> {
  const first = images.filter((image) => image.role === 'first_frame');
  const last = images.filter((image) => image.role === 'last_frame');
  if (first.length > 1 || last.length > 1) throw new Error('Kling 首帧和尾帧各只能指定一张图片');
  const middle = images.filter((image) => image.role !== 'first_frame' && image.role !== 'last_frame');
  const start = first[0] ?? middle.shift();
  if (!start) throw new Error('Kling 图生视频需要首帧图片');
  return [{ image: start, type: 'first_frame' }, ...middle.map((image) => ({ image, type: 'middle_frame' as const })),
    ...last.map((image) => ({ image, type: 'last_frame' as const }))];
}

export function klingKeyframeVariables(variables: ModelProtocolVariables, mode: 'single' | 'keyframes'): ModelProtocolVariables {
  const frames = variables.imageWithRoles;
  const single = mode === 'single';
  if (!Array.isArray(frames) || !frames.length || frames.length > (single ? 1 : 10)) {
    throw new Error(single ? 'Kling 4.0 Flash 图生视频需要一张首帧图片' : 'Kling 图生视频需要 1 至 10 张关键帧');
  }
  const images = frames.map((frame) => {
    if (!isRecord(frame) || typeof frame.url !== 'string') throw new Error('Kling 关键帧缺少图片');
    return { url: frame.url, role: frame.role };
  });
  // 只暴露合同实际使用的图片表示，让通用校验按转换后的值逐帧检查。
  return {
    prompt: variables.prompt,
    resolution: variables.resolution,
    duration: variables.duration,
    videoUrls: variables.videoUrls,
    audioUrls: variables.audioUrls,
    imageWithRoles: orderKlingFrames(images).map(({ image: { url }, type }, index) => ({
      type, url: klingImageReferenceValue(url), ...(single ? {} : { id: `frame_${index + 1}` }),
    })),
  };
}

export function assertKlingImageResponse(payload: unknown): void {
  if (!isRecord(payload) || !Number.isSafeInteger(payload.code)) throw new Error('Kling 响应缺少有效业务状态码');
  if (payload.code === 0) return;
  const detail = typeof payload.message === 'string' ? payload.message : '请核对原平台请求状态';
  // 非零码中也可能包含上游内部故障，保留提交状态未知，不能据此自动重发生成。
  throw new ModelProtocolHttpError(200, `Kling 请求失败（业务码 ${payload.code}）：${detail}`, undefined, false);
}

/** 把原任务的状态、错误和产物固定到同一行，兼容已保存的 data.0 查询映射。 */
export function selectKlingImageQueryTask(payload: unknown, taskId: string): unknown {
  assertKlingImageResponse(payload);
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('Kling 查询没有返回原任务状态，请继续查询原任务');
  }
  let task: Record<string, unknown> | undefined;
  for (const row of payload.data) {
    if (!isRecord(row) || row.id !== taskId) continue;
    if (task) throw new Error('Kling 查询返回重复的原任务 ID，请继续查询原任务');
    task = row;
  }
  if (!task) throw new Error('Kling 查询没有返回原任务状态，请继续查询原任务');
  if (task.status !== 'submitted' && task.status !== 'processing'
    && task.status !== 'succeeded' && task.status !== 'failed') {
    throw new Error('Kling 查询返回未知任务状态，请继续查询原任务');
  }
  return { ...payload, data: [task] };
}

/** 旧回执按原查询合同识别，不依赖连接现在的模型名称。 */
export function getKlingImageQueryTaskId(poll: ResolvedModelProtocolPoll): string | undefined {
  if (poll.method !== 'GET' || poll.auth?.type !== 'bearer'
    || Object.entries(poll.auth).some(([key, value]) => key !== 'type' && value !== undefined)
    || Object.keys(poll.headers ?? {}).length || poll.body !== undefined
    || poll.statusPath !== 'data.0.status' || poll.successValues.length !== 1 || poll.successValues[0] !== 'succeeded'
    || poll.failureValues.length !== 1 || poll.failureValues[0] !== 'failed'
    || poll.resultUrlPath !== 'data.0.outputs.*.url' || poll.errorPath !== 'data.0.message'
    || poll.progressPath !== undefined || poll.resultUrlFallbackPaths?.length
    || poll.resultTextPath !== undefined || poll.resultBase64Path !== undefined || poll.resultMimeType !== undefined
    || poll.resultBase64Transform !== undefined || poll.resultFetchUrl || poll.resultDownload) return undefined;
  const url = new URL(poll.url);
  if (url.pathname !== '/tasks') return undefined;
  if (!url.searchParams.has('task_ids') && !/^api-(?:beijing|singapore)\.klingai\.com$/.test(url.hostname)) return undefined;
  const taskId = url.searchParams.get('task_ids');
  if (!taskId || !taskId.trim() || taskId.includes(',') || url.username || url.password || url.hash
    || url.searchParams.size !== 1) {
    throw new Error('Kling 查询合同缺少唯一原任务 ID，请核对原任务回执');
  }
  return taskId;
}
