import { afterVideoFramePresented } from '../../../../utils/videoSeek';

const MAX_EDGE = 640;
const MAX_IDLE_BYTES = 32 * 1024 * 1024;
const MAX_IDLE_ENTRIES = 64;
const IDLE_TTL_MS = 30_000;
const LOAD_TIMEOUT_MS = 15_000;

export interface CanvasVideoPoster {
  src: string;
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  release: () => void;
}

interface Preview extends Omit<CanvasVideoPoster, 'release'> { bytes: number }
interface Client { deliver: (preview: CanvasVideoPoster | null) => void }
interface Entry {
  source: string;
  clients: Set<Client>;
  controller: AbortController;
  preview?: Preview;
  state: 'queued' | 'running' | 'ready';
  users: number;
  idleSince: number;
}

const entries = new Map<string, Entry>();
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let scheduledAt = Infinity;

export function releaseCanvasVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function waitForMedia(
  video: HTMLVideoElement,
  events: string[],
  ready: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('视频预览已取消'));
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      events.forEach((event) => video.removeEventListener(event, check));
      video.removeEventListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const check = () => { if (ready()) { cleanup(); resolve(); } };
    const fail = () => { cleanup(); reject(new Error('视频加载失败')); };
    const abort = () => { cleanup(); reject(new Error('视频预览已取消')); };
    events.forEach((event) => video.addEventListener(event, check));
    video.addEventListener('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}

/** 用户触发的截帧等待实际像素就绪，关闭播放器时立即取消。 */
export async function waitForCanvasVideoReady(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, LOAD_TIMEOUT_MS);
  try {
    await waitForMedia(video, ['loadeddata', 'canplay', 'seeked'], () => (
      video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
    ), controller.signal);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function waitForPresentedFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { cancel(); reject(new Error('视频预览已取消')); };
    const cancel = afterVideoFramePresented(video, () => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function derive(entry: Entry): Promise<Preview | undefined> {
  const { signal } = entry.controller;
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const abort = () => releaseCanvasVideo(video);
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => entry.controller.abort(), LOAD_TIMEOUT_MS);
  try {
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = entry.source;
    await waitForMedia(video, ['loadedmetadata'], () => video.readyState >= 1, signal);
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return undefined;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    const end = Math.max(0, duration - 0.05);
    const times = duration > 0
      ? [...new Set([0.08, 0.25, 0.5, 0.75].map((ratio) => Math.min(end, Math.max(0.1, duration * ratio))))]
      : [0];
    for (let index = 0; index < times.length; index++) {
      video.currentTime = times[index];
      await waitForMedia(video, ['seeked', 'loadeddata'], () => !video.seeking && video.readyState >= 2, signal);
      await waitForPresentedFrame(video, signal);
      if (signal.aborted) return undefined;
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const stride = Math.max(4, Math.floor(pixels.length / 4 / 4096) * 4);
      let visible = 0;
      for (let offset = 0; offset < pixels.length; offset += stride) {
        if (pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 36) visible++;
      }
      if (visible / Math.max(1, Math.ceil(pixels.length / stride)) >= 0.01 || index === times.length - 1) break;
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || signal.aborted) return undefined;
    return { src: URL.createObjectURL(blob), width, height, duration,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight, bytes: width * height * 4 };
  } catch {
    // 远程跨域或不支持的编码保持占位图，显式播放仍直接使用原视频。
    return undefined;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    releaseCanvasVideo(video);
    canvas.width = 1;
    canvas.height = 1;
  }
}

function discard(entry: Entry): void {
  if (entries.get(entry.source) !== entry) return;
  entries.delete(entry.source);
  entry.controller.abort();
  if (entry.preview) URL.revokeObjectURL(entry.preview.src);
}

function prune(): void {
  const idle = [...entries.values()].filter((entry) => entry.state === 'ready' && entry.users === 0)
    .sort((a, b) => a.idleSince - b.idleSince);
  let bytes = idle.reduce((total, entry) => total + (entry.preview?.bytes ?? 0), 0);
  let count = idle.length;
  for (const entry of idle) {
    if (Date.now() - entry.idleSince < IDLE_TTL_MS && bytes <= MAX_IDLE_BYTES && count <= MAX_IDLE_ENTRIES) break;
    bytes -= entry.preview?.bytes ?? 0;
    count--;
    discard(entry);
  }
}

function schedule(delay = 0): void {
  if (timer !== undefined && scheduledAt <= Date.now() + delay) return;
  if (timer !== undefined) clearTimeout(timer);
  scheduledAt = Date.now() + delay;
  timer = setTimeout(() => { timer = undefined; scheduledAt = Infinity; void pump(); }, delay);
}

function lease(entry: Entry): CanvasVideoPoster | null {
  if (!entry.preview) return null;
  entry.users++;
  let released = false;
  const { src, width, height, duration, videoWidth, videoHeight } = entry.preview;
  return { src, width, height, duration, videoWidth, videoHeight, release: () => {
    if (released) return;
    released = true;
    entry.users--;
    entry.idleSince = Date.now();
    prune();
    schedule(IDLE_TTL_MS);
  } };
}

async function pump(): Promise<void> {
  prune();
  if (running) return;
  const entry = [...entries.values()].find((candidate) => candidate.state === 'queued');
  if (!entry) {
    const idle = [...entries.values()].filter((candidate) => candidate.state === 'ready' && candidate.users === 0);
    if (idle.length > 0) schedule(Math.max(1, Math.min(...idle.map((candidate) => candidate.idleSince + IDLE_TTL_MS - Date.now()))));
    return;
  }
  if (document.documentElement.classList.contains('canvas-interacting')) { schedule(80); return; }
  running = true;
  entry.state = 'running';
  const cancelClients = () => {
    for (const client of entry.clients) client.deliver(null);
    entry.clients.clear();
    if (entries.get(entry.source) === entry) entries.delete(entry.source);
  };
  entry.controller.signal.addEventListener('abort', cancelClients, { once: true });
  const preview = await derive(entry);
  entry.controller.signal.removeEventListener('abort', cancelClients);
  running = false;
  if (entries.get(entry.source) !== entry || entry.controller.signal.aborted) {
    if (preview) URL.revokeObjectURL(preview.src);
    for (const client of entry.clients) client.deliver(null);
    entry.clients.clear();
    discard(entry);
  } else {
    entry.preview = preview;
    entry.state = 'ready';
    entry.idleSince = Date.now();
    for (const client of entry.clients) client.deliver(lease(entry));
    entry.clients.clear();
  }
  schedule();
}

/** 全画布共用一个取帧任务；在用封面由租约保护，空闲封面按数量、内存和时间回收。 */
export function acquireCanvasVideoPoster(source: string, signal: AbortSignal): Promise<CanvasVideoPoster | null> {
  if (!source || signal.aborted || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return Promise.resolve(null);
  }
  prune();
  let entry = entries.get(source);
  if (!entry) {
    entry = { source, clients: new Set(), controller: new AbortController(), state: 'queued', users: 0, idleSince: 0 };
    entries.set(source, entry);
  }
  if (entry.state === 'ready') return Promise.resolve(lease(entry));
  const target = entry;
  return new Promise((resolve) => {
    const abort = () => {
      target.clients.delete(client);
      signal.removeEventListener('abort', abort);
      resolve(null);
      if (target.clients.size === 0 && target.state !== 'ready') discard(target);
    };
    const client: Client = { deliver: (result) => {
      signal.removeEventListener('abort', abort);
      resolve(result);
    } };
    target.clients.add(client);
    signal.addEventListener('abort', abort, { once: true });
    schedule();
  });
}
