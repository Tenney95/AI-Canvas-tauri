/**
 * comfyImageSource — 读取原生 ComfyUI 图片并管理 Blob URL 租约。
 */
import { corsSafeFetch } from './ai/httpTransport';
import { shouldLoadNativeComfyMedia } from './comfyMediaSource';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;

export interface ComfyImageSourceLease {
  src: string;
  release: () => void;
}

/** 只接管默认本机或已配置服务器的取件地址，保持完整查询和原目标，不借用其他连接。 */
export function shouldLoadNativeComfyImage(source: string | undefined): boolean {
  return shouldLoadNativeComfyMedia(source);
}

/** 原生流读取覆盖响应体的取消、超时和字节预算；失败不再交回 WebView 请求。 */
export async function readNativeComfyImageBlob(source: string, signal: AbortSignal, maxBytes = MAX_IMAGE_BYTES): Promise<Blob> {
  signal.throwIfAborted();
  if (!shouldLoadNativeComfyImage(source)) throw new Error('ComfyUI 图片地址不属于可用的原生读取目标');
  const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
  const response = await corsSafeFetch(source, { signal: activeSignal });
  const discard = () => response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    await discard();
    throw new Error(`ComfyUI 图片读取失败（HTTP ${response.status}）`);
  }
  const sizeLimit = `${maxBytes / (1024 * 1024)} MiB 读取限制`;
  const sizeError = () => new RangeError(`ComfyUI 图片超过 ${sizeLimit}`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await discard();
    throw sizeError();
  }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (mime && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
    await discard();
    throw new Error('ComfyUI 返回的内容不是图片');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    activeSignal.throwIfAborted();
    if (!blob.size || blob.size > maxBytes) throw new RangeError(`ComfyUI 图片为空或超过 ${sizeLimit}`);
    return blob;
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      activeSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw sizeError();
      chunks.push(Uint8Array.from(value));
    }
    activeSignal.throwIfAborted();
    if (!total) throw new Error('ComfyUI 返回了空图片');
    return new Blob(chunks, { type: mime });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

/** Blob URL 只供本窗口展示；所有权由消费者持有，不写节点、历史或项目数据。 */
export async function acquireComfyImageSource(source: string, signal: AbortSignal): Promise<ComfyImageSourceLease> {
  signal.throwIfAborted();
  if (!shouldLoadNativeComfyImage(source)) return { src: source, release: () => {} };
  const blob = await readNativeComfyImageBlob(source, signal);
  signal.throwIfAborted();
  const src = URL.createObjectURL(blob);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(src);
  };
  if (signal.aborted) { release(); signal.throwIfAborted(); }
  return { src, release };
}
