/**
 * canvasImagePreviewCache — 管理画布图片预览缓存与资源租约。
 */
import { readRasterImageDimensions } from '../../../../services/rasterImageDimensions';
import { prepareProjectThumbnail } from '../../../../services/fs/thumbnailCache';
import { assertEditorSourceBudget } from './imageResourceBudget';
import { getPerformanceModeBudget, subscribePerformanceMode } from '../../../../services/performanceModeRuntime';
import { isTauriAssetUrl } from '../../../../utils/mediaUrl';
import { readNativeComfyImageBlob, shouldLoadNativeComfyImage } from '../../../../services/comfyImageSource';

const MAX_ENCODED_BYTES = 32 * 1024 * 1024;
const INTERACTION_POLL_MS = 80;
const DERIVATION_TIMEOUT_MS = 10_000;
const PREVIEW_WAIT_TIMEOUT_MS = 15_000;
const entries = new Map<string, Entry>();
let running = false;
let pumpTimer: ReturnType<typeof setTimeout> | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribePerformanceMode: (() => void) | undefined;

export interface CanvasImagePreviewLease {
  src: string;
  release: () => void;
}

interface Client {
  resolve?: (value: CanvasImagePreviewLease | null) => void;
  release: () => void;
  waitTimer?: ReturnType<typeof setTimeout>;
}

interface Preview {
  src: string;
  rgbaBytes: number;
}

function previewFromBlob(blob: Blob, width: number, height: number): Preview {
  return { src: URL.createObjectURL(blob), rgbaBytes: width * height * 4 };
}

interface Entry {
  key: string;
  source: string;
  projectId?: string | null;
  maxEdge: number;
  state: 'queued' | 'running' | 'ready';
  clients: Set<Client>;
  controller: AbortController;
  preview?: Preview;
  idleSince: number;
}

function resolveClient(client: Client, lease: CanvasImagePreviewLease | null): void {
  if (client.waitTimer !== undefined) clearTimeout(client.waitTimer);
  client.waitTimer = undefined;
  client.resolve?.(lease);
  client.resolve = undefined;
}

function addClient(current: Entry, signal: AbortSignal, resolve?: Client['resolve']): Client {
  let released = false;
  const client: Client = {
    resolve,
    release: () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', client.release);
      current.clients.delete(client);
      resolveClient(client, null);
      if (current.clients.size !== 0) return;
      if (current.state === 'ready') {
        current.idleSince = Date.now();
        pruneIdle();
      } else discard(current);
    },
  };
  current.clients.add(client);
  signal.addEventListener('abort', client.release, { once: true });
  // 包含排队时间；超时仅释放消费者，不能提前腾出不可取消的解码/编码槽。
  if (resolve) client.waitTimer = setTimeout(client.release, PREVIEW_WAIT_TIMEOUT_MS);
  return client;
}

function discard(entry: Entry): void {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  if (entries.size === 0) {
    unsubscribePerformanceMode?.();
    unsubscribePerformanceMode = undefined;
  }
  entry.controller.abort();
  if (entry.preview && entry.preview.src !== entry.source) URL.revokeObjectURL(entry.preview.src);
  entry.preview = undefined;
}

function pruneIdle(): void {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  const now = Date.now();
  const budget = getPerformanceModeBudget();
  const idle = [...entries.values()]
    .filter((entry) => entry.state === 'ready' && entry.clients.size === 0)
    .sort((a, b) => a.idleSince - b.idleSince);
  let bytes = idle.reduce((total, entry) => total + (entry.preview?.rgbaBytes ?? 0), 0);
  let count = idle.length;
  for (const entry of idle) {
    if (now - entry.idleSince >= budget.previewIdleMs || bytes > budget.imageIdleBytes || count > budget.imageIdleEntries) {
      bytes -= entry.preview?.rgbaBytes ?? 0;
      count--;
      discard(entry);
    } else {
      expiryTimer = setTimeout(pruneIdle, Math.max(1, budget.previewIdleMs - (now - entry.idleSince)));
      break;
    }
  }
}

function schedulePump(delay = 0): void {
  if (running || pumpTimer !== undefined) return;
  if (![...entries.values()].some((entry) => entry.state === 'queued')) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = undefined;
    void pump();
  }, delay);
}

function ascii(bytes: Uint8Array, start: number, count: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + count));
}

/** Reject animated/unknown formats before decode; PNG animation metadata precedes IDAT. */
async function isStaticRaster(blob: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const kind = ascii(bytes, 12, 4);
    return kind === 'VP8 ' || kind === 'VP8L'
      || (kind === 'VP8X' && bytes.length >= 30 && (bytes[20] & 0x02) === 0);
  }
  if (bytes.length < 24 || bytes[0] !== 0x89 || ascii(bytes, 1, 7) !== 'PNG\r\n\x1a\n') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset);
    const kind = ascii(bytes, offset + 4, 4);
    if (kind === 'acTL') return false;
    if (kind === 'IDAT') return true;
    if (length > bytes.length - offset - 12) return false;
    offset += length + 12;
  }
  return false;
}

async function readBoundedBlob(source: string, signal: AbortSignal): Promise<Blob> {
  if (shouldLoadNativeComfyImage(source)) return readNativeComfyImageBlob(source, signal);
  if (isTauriAssetUrl(source)) {
    // asset 的非 Range GET 会在原生侧整文件读取，先用 HEAD 挡住明显超限的本地文件。
    const head = await fetch(source, { method: 'HEAD', signal });
    if (!head.ok) throw new Error('Preview source unavailable');
    if (Number(head.headers.get('content-length')) > MAX_ENCODED_BYTES) {
      throw new RangeError('Preview source exceeds byte budget');
    }
  }
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error('Preview source unavailable');
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_ENCODED_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeError('Preview source exceeds byte budget');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > MAX_ENCODED_BYTES) throw new RangeError('Preview source exceeds byte budget');
    signal.throwIfAborted();
    return blob;
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ENCODED_BYTES) throw new RangeError('Preview source exceeds byte budget');
      chunks.push(Uint8Array.from(value));
    }
    signal.throwIfAborted();
    return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function derive(entry: Entry): Promise<Preview | null> {
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let stage = 'cache';
  const signal = entry.controller.signal;
  const warn = (errorType: string) => console.warn('[CanvasImagePreviewCache] 图片预览生成失败', {
    stage, errorType, maxEdge: entry.maxEdge,
  });
  const timeout = setTimeout(() => {
    if (signal.aborted) return;
    warn('TimeoutError');
    entry.controller.abort();
    // 解码/编码无法中止：先结束等待，串行槽仍等 finally 回收资源，不能另开原图解码。
    for (const client of [...entry.clients]) client.release();
  }, DERIVATION_TIMEOUT_MS);
  try {
    const disk = await prepareProjectThumbnail(entry.projectId, entry.source, entry.maxEdge, signal);
    signal.throwIfAborted();
    if (disk?.cached) {
      const { blob, width, height } = disk.cached;
      return previewFromBlob(blob, width, height);
    }
    stage = 'read-source';
    const nativeComfyImage = shouldLoadNativeComfyImage(entry.source);
    const blob = await readBoundedBlob(entry.source, signal);
    stage = 'dimensions';
    const dimensions = await readRasterImageDimensions(blob);
    if (!dimensions) throw new Error('Preview dimensions unavailable');
    const estimate = assertEditorSourceBudget(dimensions.width, dimensions.height, '画布预览');
    const edge = Math.max(dimensions.width, dimensions.height);
    // 小图和动图也先检查编码大小及像素预算；只有确认安全后才允许直接显示。
    if (edge <= entry.maxEdge || !await isStaticRaster(blob)) {
      // Comfy 原图 Blob 由缓存持有，编码字节也必须占用闲置内存预算。
      return { src: nativeComfyImage ? URL.createObjectURL(blob) : entry.source,
        rgbaBytes: estimate.bytes + (nativeComfyImage ? blob.size : 0) };
    }
    const width = Math.max(1, Math.round(dimensions.width * entry.maxEdge / edge));
    const height = Math.max(1, Math.round(dimensions.height * entry.maxEdge / edge));
    signal.throwIfAborted();
    stage = 'decode';
    // 方向沿用浏览器默认值，兼容不接受 from-image 选项的 WebKit。
    bitmap = await createImageBitmap(blob, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    signal.throwIfAborted();
    stage = 'draw';
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Preview drawing context unavailable');
    context.drawImage(bitmap, 0, 0, width, height);
    stage = 'encode';
    const previewBlob = await new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, 'image/webp', 0.85));
    signal.throwIfAborted();
    if (!previewBlob) throw new Error('Preview encoding failed');
    // 先展示内存预览，写盘由文件服务的有界串行队列处理。
    void disk?.persist(previewBlob);
    return previewFromBlob(previewBlob, width, height);
  } catch (error) {
    if (!signal.aborted && entry.projectId && isTauriAssetUrl(entry.source) && error instanceof RangeError
      && (stage === 'read-source' || stage === 'dimensions')) {
      const native = await prepareProjectThumbnail(entry.projectId, entry.source, entry.maxEdge, signal, true).catch(() => null);
      if (!signal.aborted && native?.cached) {
        const { blob, width, height } = native.cached;
        return previewFromBlob(blob, width, height);
      }
    }
    if (!signal.aborted) {
      // 只记录固定阶段和错误分类，避免异常属性带出图片地址或本地路径。
      warn(error instanceof TypeError ? 'TypeError'
        : error instanceof RangeError ? 'RangeError'
          : error instanceof Error ? 'Error' : 'UnknownError');
    }
    return null;
  } finally {
    clearTimeout(timeout);
    bitmap?.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

async function pump(): Promise<void> {
  if (running) return;
  if (document.documentElement.classList.contains('canvas-interacting')) {
    schedulePump(INTERACTION_POLL_MS);
    return;
  }
  const entry = [...entries.values()].find((item) => item.state === 'queued' && item.clients.size > 0);
  if (!entry) return;
  running = true;
  entry.state = 'running';
  const preview = await derive(entry);
  entry.preview = preview ?? undefined;
  if (preview && entry.clients.size > 0 && !entry.controller.signal.aborted) {
    entry.state = 'ready';
    for (const client of entry.clients) {
      resolveClient(client, { src: preview.src, release: client.release });
    }
  } else {
    for (const client of [...entry.clients]) client.release();
    discard(entry);
  }
  running = false;
  schedulePump();
}

/** 仅领取当前项目、完整来源的已就绪小图；不读取磁盘、不启动派生。 */
export function acquireCachedCanvasImagePreview(
  source: string,
  maxEdge: number,
  signal: AbortSignal,
  projectId?: string | null,
): (CanvasImagePreviewLease & { maxEdge: number }) | null {
  if (signal.aborted || !Number.isFinite(maxEdge) || maxEdge <= 0) return null;
  pruneIdle();
  // 画布只有三档，不在每个入场节点上扫描整份缓存。
  const current = [1024, 512, 256]
    .filter((edge) => edge <= maxEdge)
    .map((edge) => entries.get(JSON.stringify([projectId ?? null, source, edge])))
    .find((entry) => entry?.state === 'ready' && entry.preview && !entry.controller.signal.aborted);
  if (!current?.preview) return null;
  const client = addClient(current, signal);
  return { src: current.preview.src, maxEdge: current.maxEdge, release: client.release };
}

/** Shared bounded memory previews, backed by project disk cache when available. */
export function acquireCanvasImagePreview(
  source: string,
  maxEdge: number,
  signal: AbortSignal,
  projectId?: string | null,
): Promise<CanvasImagePreviewLease | null> {
  if (signal.aborted || !/^(?:https?:|asset:|blob:|data:)/i.test(source)
    || !Number.isFinite(maxEdge) || maxEdge <= 0
    || typeof document === 'undefined' || typeof createImageBitmap !== 'function') return Promise.resolve(null);
  const edge = Math.min(1024, Math.max(1, Math.ceil(maxEdge)));
  const key = JSON.stringify([projectId ?? null, source, edge]);
  pruneIdle();
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key, source, projectId, maxEdge: edge, state: 'queued', clients: new Set(),
      controller: new AbortController(), idleSince: 0,
    };
    entries.set(key, entry);
    unsubscribePerformanceMode ??= subscribePerformanceMode(pruneIdle);
  }
  const current = entry;
  return new Promise((resolve) => {
    const client = addClient(current, signal, resolve);
    if (current.preview) {
      resolveClient(client, { src: current.preview.src, release: client.release });
    } else {
      schedulePump();
    }
  });
}
