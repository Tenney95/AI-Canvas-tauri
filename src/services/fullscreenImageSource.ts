/**
 * fullscreenImageSource — 为全屏查看器提供原图地址和资源租约。
 */
import { readNativeComfyImageBlob, shouldLoadNativeComfyImage } from './comfyImageSource';
import type { ComfyMediaSourceLease } from './comfyMediaSource';
import { corsSafeFetch } from './ai/httpTransport';
import { getAssetUrlFromPath } from './fs/core';
import { isRemoteMediaUrl, isTauriAssetUrl, localMediaUrlToPath } from '../utils/mediaUrl';

export const FULLSCREEN_IMAGE_ERRORS = {
  busy: '图片预览资源不足，请关闭其他大图后重试',
  unavailable: '图片读取或解码失败，请检查文件或网络后重试',
} as const;

export class FullscreenImageSourceError extends Error {
  readonly code: keyof typeof FULLSCREEN_IMAGE_ERRORS;

  constructor(code: keyof typeof FULLSCREEN_IMAGE_ERRORS) {
    super(FULLSCREEN_IMAGE_ERRORS[code]);
    this.code = code;
    this.name = 'FullscreenImageSourceError';
  }
}

interface Waiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}
const runtime: { preparing: boolean; waiters: Waiter[] } = import.meta.hot?.data.fullscreenImages
  ?? { preparing: false, waiters: [] };
if (import.meta.hot) import.meta.hot.data.fullscreenImages = runtime;

const abortError = () => new DOMException('图片预览已取消', 'AbortError');

function releasePreparation(): void {
  const next = runtime.waiters.shift();
  if (!next) { runtime.preparing = false; return; }
  next.signal.removeEventListener('abort', next.abort);
  next.resolve(releasePreparation);
}

function enterPreparation(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (!runtime.preparing) { runtime.preparing = true; return Promise.resolve(releasePreparation); }
  // 快速换图可取消等候；最多再留两个请求，排队时不读取任何图片字节。
  if (runtime.waiters.length >= 2) return Promise.reject(new FullscreenImageSourceError('busy'));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, reject, abort: () => {
      const index = runtime.waiters.indexOf(waiter);
      if (index >= 0) runtime.waiters.splice(index, 1);
      signal.removeEventListener('abort', waiter.abort);
      reject(abortError());
    } };
    runtime.waiters.push(waiter);
    signal.addEventListener('abort', waiter.abort, { once: true });
    if (signal.aborted) waiter.abort();
  });
}

/** 本地原图交给 img 直接解码，远程读取继续走现有 HTTP 通道。 */
export async function acquireFullscreenImageSource(source: string, signal: AbortSignal): Promise<ComfyMediaSourceLease> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let leave: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    // 已有 asset URL 可能带缓存刷新参数，只有文件路径才需要转换。
    const path = isTauriAssetUrl(source) ? undefined
      : localMediaUrlToPath(source) ?? (/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(source) ? source : undefined);
    const url = path ? await getAssetUrlFromPath(path) : source;
    signal.throwIfAborted();
    if (isTauriAssetUrl(url)) return { src: url, release: () => {} };
    if (path) throw new FullscreenImageSourceError('unavailable');
    if (/^(?:data|blob):/i.test(url)) return { src: url, release: () => {} };
    if (!isRemoteMediaUrl(url)) throw new FullscreenImageSourceError('unavailable');

    const timeout = new AbortController();
    timer = setTimeout(() => timeout.abort(), 15_000);
    const activeSignal = AbortSignal.any([signal, timeout.signal]);
    leave = await enterPreparation(activeSignal);
    activeSignal.throwIfAborted();
    let blob: Blob;
    if (shouldLoadNativeComfyImage(url)) {
      blob = await readNativeComfyImageBlob(url, activeSignal, Infinity);
    } else {
      const response = await corsSafeFetch(url, { signal: activeSignal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new FullscreenImageSourceError('unavailable');
      }
      blob = await response.blob();
    }
    activeSignal.throwIfAborted();
    if (!blob.size) throw new FullscreenImageSourceError('unavailable');
    const src = URL.createObjectURL(blob);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', release);
      URL.revokeObjectURL(src);
    };
    signal.addEventListener('abort', release, { once: true });
    if (signal.aborted) { release(); throw abortError(); }
    return { src, release };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof FullscreenImageSourceError) throw error;
    // 读取器或浏览器异常可能夹带地址，只把固定原因交给界面。
    throw new FullscreenImageSourceError('unavailable');
  } finally {
    clearTimeout(timer);
    // 原生读取未真正结束前不能释放准备槽，取消只让消费者停止等候。
    leave?.();
  }
}
